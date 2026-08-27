#!/bin/sh
# Hermes/Umbrel shim for agent-browser.
#
# agent-browser's managed-Chromium launch path wedges inside this Umbrel
# container even though the same Chromium is healthy over a fixed local CDP
# endpoint. Start that endpoint lazily, keep task socket/session isolation,
# and attach every browser command to it. The supervisor tears Chromium down
# after a short idle window so the RAM-constrained host does not pay for an
# always-on browser.

set -eu

real_browser="/opt/hermes/bin/agent-browser-real"
supervisor="/opt/hermes/tools/local_cdp_browser.py"
python="/opt/hermes/.venv/bin/python3"
cdp_url="${HERMES_LOCAL_CDP_URL:-http://127.0.0.1:9223}"

if [ ! -x "$real_browser" ]; then
    echo "Hermes browser runtime is missing: $real_browser" >&2
    exit 127
fi

# Respect explicit external-CDP calls and keep metadata/maintenance commands
# side-effect free. In particular, Hermes probes `--version` during tool
# discovery; that must not launch Chromium.
for arg in "$@"; do
    case "$arg" in
        --cdp|--cdp=*|--version|-V|--help|-h|help|doctor|install|upgrade|mcp|skills|read)
            exec "$real_browser" "$@"
            ;;
    esac
done

if [ "${HERMES_LOCAL_CDP_DISABLED:-0}" = "1" ]; then
    exec "$real_browser" "$@"
fi

# Cleanup must never resurrect a browser that has already idled out.
for arg in "$@"; do
    if [ "$arg" = "close" ]; then
        if ! "$python" "$supervisor" ready >/dev/null 2>&1; then
            exit 0
        fi
        exec "$real_browser" --cdp "$cdp_url" --pin-tab "$@"
    fi
done

"$python" "$supervisor" ensure
exec "$real_browser" --cdp "$cdp_url" --pin-tab "$@"
