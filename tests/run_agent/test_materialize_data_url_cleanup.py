"""Regression test: temp file cleanup when materializing data URLs for vision.

`_materialize_data_url_for_vision` creates a `NamedTemporaryFile(delete=False)`
inside Hermes's approved media cache so the path can be handed to vision
backends even when terminal tools run in a sandbox.  If `base64.b64decode`
raises on a corrupt/unsupported data URL the temp file would otherwise persist
forever on disk, leaking once per failed call.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

import pytest

from run_agent import AIAgent
from tools.image_source import ResolveContext, _permitted_host_read_target


def _list_anthropic_tmpfiles(tmpdir: Path) -> list[str]:
    if not tmpdir.exists():
        return []
    return [
        name for name in os.listdir(tmpdir)
        if name.startswith("anthropic_image_")
    ]


def test_b64decode_failure_does_not_leak_tempfile(monkeypatch, tmp_path):
    hermes_home = tmp_path / "hermes-home"
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    inbound_dir = hermes_home / "cache" / "vision" / "inbound"

    bad_url = "data:image/png;base64,!!!not-valid-base64!!!"
    with pytest.raises(Exception):
        AIAgent._materialize_data_url_for_vision(bad_url)

    leftovers = _list_anthropic_tmpfiles(inbound_dir)
    assert leftovers == [], f"leaked temp files after decode failure: {leftovers}"


def test_successful_decode_returns_path_to_existing_file(monkeypatch, tmp_path):
    hermes_home = tmp_path / "hermes-home"
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    payload = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16  # a few bytes is enough
    encoded = base64.b64encode(payload).decode("ascii")
    good_url = f"data:image/png;base64,{encoded}"

    path_str, path_obj = AIAgent._materialize_data_url_for_vision(good_url)

    assert isinstance(path_obj, Path)
    assert path_obj.exists()
    assert path_obj.read_bytes() == payload
    assert path_str == str(path_obj)
    assert path_obj.is_relative_to(hermes_home / "cache" / "vision" / "inbound")

    # A sandboxed agent may only read host files inside an approved media
    # root.  Assert the actual resolver accepts this materialized path.
    monkeypatch.setenv("TERMINAL_ENV", "docker")
    assert _permitted_host_read_target(path_obj, ResolveContext()) == path_obj.resolve()

    # Caller is responsible for cleanup; mimic that here so the test leaves
    # no artifacts behind.
    path_obj.unlink()
