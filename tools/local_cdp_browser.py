#!/usr/bin/env python3
"""Lazy, cross-process Chromium CDP supervisor for the Umbrel image.

Hermes gateways run in separate processes, so this helper coordinates through
an advisory lock and a shared activity timestamp under /tmp.  One Chromium is
started on loopback when needed and is stopped after a bounded idle period.
"""

from __future__ import annotations

import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


RUNTIME_DIR = Path("/tmp/hermes-local-cdp")
PROFILE_DIR = RUNTIME_DIR / "profile"
ACTIVITY_FILE = RUNTIME_DIR / "activity"
PID_FILE = RUNTIME_DIR / "supervisor.pid"
LOCK_FILE = RUNTIME_DIR / "start.lock"
SERVE_LOCK_FILE = RUNTIME_DIR / "serve.lock"
LOG_FILE = RUNTIME_DIR / "supervisor.log"
DEFAULT_CHROME = Path(
    "/opt/data/browser-binaries/chromium-1234/chrome-linux64/chrome"
)
HOST = "127.0.0.1"
PORT = int(os.environ.get("HERMES_LOCAL_CDP_PORT", "9223"))
DISCOVERY_URL = f"http://{HOST}:{PORT}/json/version"
IDLE_SECONDS = max(
    60, int(os.environ.get("HERMES_LOCAL_CDP_IDLE_SECONDS", "180"))
)


def _prepare_runtime() -> None:
    RUNTIME_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        RUNTIME_DIR.chmod(0o700)
    except OSError:
        pass


def _touch_activity() -> None:
    ACTIVITY_FILE.touch(mode=0o600, exist_ok=True)


def _discovery_payload(timeout: float = 1.0) -> dict | None:
    try:
        with urllib.request.urlopen(DISCOVERY_URL, timeout=timeout) as response:
            payload = json.load(response)
    except (OSError, ValueError, urllib.error.URLError):
        return None
    if not isinstance(payload, dict) or not payload.get("webSocketDebuggerUrl"):
        return None
    return payload


def _ready() -> bool:
    return _discovery_payload() is not None


def _pid_matches_supervisor(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ")
    except OSError:
        return False
    return b"local_cdp_browser.py serve" in cmdline


def _read_supervisor_pid() -> int | None:
    try:
        pid = int(PID_FILE.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    return pid if _pid_matches_supervisor(pid) else None


def _wait_ready(seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if _ready():
            return True
        time.sleep(0.25)
    return False


def _tail_log(limit: int = 1200) -> str:
    try:
        text = LOG_FILE.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return text[-limit:].strip()


def ensure() -> int:
    _prepare_runtime()
    with LOCK_FILE.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if _ready():
            _touch_activity()
            return 0

        existing_pid = _read_supervisor_pid()
        if existing_pid is not None:
            if _wait_ready(15):
                _touch_activity()
                return 0
            try:
                os.kill(existing_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and _pid_matches_supervisor(existing_pid):
                time.sleep(0.1)
            if _pid_matches_supervisor(existing_pid):
                try:
                    os.kill(existing_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                deadline = time.monotonic() + 2
                while (
                    time.monotonic() < deadline
                    and _pid_matches_supervisor(existing_pid)
                ):
                    time.sleep(0.05)

        LOG_FILE.touch(mode=0o600, exist_ok=True)
        log_fd = os.open(LOG_FILE, os.O_WRONLY | os.O_APPEND)
        try:
            process = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "serve"],
                stdin=subprocess.DEVNULL,
                stdout=log_fd,
                stderr=log_fd,
                close_fds=True,
                start_new_session=True,
                env=os.environ.copy(),
            )
        finally:
            os.close(log_fd)

        if not _wait_ready(25):
            if _pid_matches_supervisor(process.pid):
                try:
                    os.kill(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            detail = _tail_log()
            message = "Local Chromium CDP endpoint did not become ready"
            if detail:
                message = f"{message}: {detail}"
            print(message, file=sys.stderr)
            return 1

        _touch_activity()
        return 0


def _terminate_process_group(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass


def serve() -> int:
    _prepare_runtime()
    with SERVE_LOCK_FILE.open("a+", encoding="utf-8") as serve_lock:
        try:
            fcntl.flock(serve_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0

        PID_FILE.write_text(f"{os.getpid()}\n", encoding="utf-8")
        PID_FILE.chmod(0o600)

        chrome = Path(os.environ.get("AGENT_BROWSER_EXECUTABLE_PATH", DEFAULT_CHROME))
        if not chrome.is_file() or not os.access(chrome, os.X_OK):
            print(f"Chromium executable is unavailable: {chrome}", file=sys.stderr)
            return 1

        # This path is private, disposable, and controlled exclusively by this
        # supervisor. A stale profile can retain Chromium singleton locks.
        shutil.rmtree(PROFILE_DIR, ignore_errors=True)
        PROFILE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        _touch_activity()

        chrome_args = [
            str(chrome),
            f"--remote-debugging-address={HOST}",
            f"--remote-debugging-port={PORT}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-backgrounding-occluded-windows",
            "--disable-component-update",
            "--disable-default-apps",
            "--disable-hang-monitor",
            "--disable-popup-blocking",
            "--disable-prompt-on-repost",
            "--disable-sync",
            "--disable-features=Translate",
            "--metrics-recording-only",
            "--password-store=basic",
            "--use-mock-keychain",
            "--headless=new",
            "--hide-scrollbars",
            "--window-size=1280,720",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-breakpad",
            "--disable-crash-reporter",
            "--noerrdialogs",
            f"--user-data-dir={PROFILE_DIR}",
            "about:blank",
        ]

        chrome_process = subprocess.Popen(
            chrome_args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
        stopping = False

        def request_stop(_signum: int, _frame: object) -> None:
            nonlocal stopping
            stopping = True

        signal.signal(signal.SIGTERM, request_stop)
        signal.signal(signal.SIGINT, request_stop)

        try:
            while not stopping:
                if chrome_process.poll() is not None:
                    return chrome_process.returncode or 1
                try:
                    idle_for = time.time() - ACTIVITY_FILE.stat().st_mtime
                except OSError:
                    idle_for = IDLE_SECONDS + 1
                if idle_for >= IDLE_SECONDS:
                    return 0
                time.sleep(2)
        finally:
            _terminate_process_group(chrome_process)
            try:
                PID_FILE.unlink()
            except OSError:
                pass
            shutil.rmtree(PROFILE_DIR, ignore_errors=True)


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "ensure":
        return ensure()
    if command == "ready":
        return 0 if _ready() else 1
    if command == "serve":
        return serve()
    print("usage: local_cdp_browser.py {ensure|ready|serve}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
