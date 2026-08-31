"""Shared helpers for classifying tool result payloads."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any


FILE_MUTATING_TOOL_NAMES = frozenset({"write_file", "patch"})


# Tools whose interrupted/dangling execution is safe to discard because they
# cannot mutate either external state or Hermes session state. Unknown/plugin/
# MCP tools stay effect-capable by default.
NO_EFFECT_TOOL_NAMES = frozenset({
    "read_file", "search_files", "session_search", "skill_view", "skills_list",
    "web_extract", "web_search", "vision_analyze", "browser_snapshot",
    "browser_get_images", "browser_console", "read_terminal",
})


_SUCCESS_STATUSES = frozenset({
    "accepted",
    "complete",
    "completed",
    "created",
    "delivered",
    "deleted",
    "dispatched",
    "in_progress",
    "ok",
    "pending",
    "queued",
    "running",
    "succeeded",
    "success",
    "successful",
    "updated",
})

_FAILURE_STATUSES = frozenset({
    "blocked",
    "canceled",
    "cancelled",
    "error",
    "failed",
    "failure",
    "rejected",
    "timed_out",
    "timeout",
    "unavailable",
})


def tool_may_have_side_effect(tool_name: str) -> bool:
    return tool_name not in NO_EFFECT_TOOL_NAMES


def file_mutation_result_landed(tool_name: str, result: Any) -> bool:
    """Return True when a file mutation result proves the write landed."""
    if tool_name not in FILE_MUTATING_TOOL_NAMES or not isinstance(result, str):
        return False
    try:
        data = json.loads(result.strip())
    except Exception:
        return False
    if not isinstance(data, dict) or data.get("error"):
        return False
    if tool_name == "write_file":
        return "bytes_written" in data
    if tool_name == "patch":
        return data.get("success") is True
    return False


def _failure_detail(payload: Mapping[str, Any], fallback: str = "error") -> str:
    """Return a compact human-readable detail from a structured failure."""
    for key in ("error", "message", "reason"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, Mapping):
            for nested_key in ("message", "error", "reason", "code"):
                nested = value.get(nested_key)
                if isinstance(nested, str) and nested.strip():
                    return nested.strip()
    return fallback


def classify_structured_tool_result(
    value: Any,
    *,
    _depth: int = 0,
) -> tuple[bool | None, str]:
    """Classify explicit success/failure signals in a serialized tool result.

    ``None`` means the payload has no structured signal and the caller may use
    a narrow plain-text fallback. ``False`` is an explicit success and must not
    be overridden by words such as ``failed`` inside successful result data.

    Wrapper payloads emitted by MCP/Executor are followed only through their
    known envelope fields; arbitrary domain data is not recursively scanned
    for scary words. Any explicit failure wins over a nested success signal.
    """
    if _depth > 4:
        return None, ""

    if isinstance(value, str):
        try:
            value = json.loads(value.strip())
        except (TypeError, ValueError):
            return None, ""

    if not isinstance(value, Mapping):
        return None, ""

    is_error = value.get("isError", value.get("is_error"))
    if is_error is True:
        return True, _failure_detail(value, "MCP tool returned an error")

    error = value.get("error")
    if error:
        return True, _failure_detail(value)

    if value.get("success") is False or value.get("ok") is False:
        return True, _failure_detail(value)

    status = value.get("status")
    normalized_status = status.strip().lower() if isinstance(status, str) else ""
    if normalized_status in _FAILURE_STATUSES:
        return True, _failure_detail(value, normalized_status)

    failed = value.get("failed")
    if failed:
        if isinstance(failed, (list, tuple, set, Mapping)):
            return True, f"{len(failed)} failed"
        return True, str(failed) if isinstance(failed, str) else "failed"

    # MCP machine-oriented metadata, Hermes' model-oriented ``result``, and
    # Executor's ``data`` wrapper may each carry a useful signal. Inspect all
    # known envelope locations and let any nested failure win over success.
    nested_keys = ["structuredContent", "structured_content", "result"]
    if "ok" in value:
        nested_keys.append("data")
    nested_success = False
    for key in nested_keys:
        nested = value.get(key)
        if nested is None:
            continue
        decision = classify_structured_tool_result(nested, _depth=_depth + 1)
        if decision[0] is True:
            return decision
        if decision[0] is False:
            nested_success = True

    if is_error is False:
        return False, ""
    if normalized_status in _SUCCESS_STATUSES:
        return False, ""
    if value.get("success") is True or value.get("ok") is True:
        return False, ""
    if "failed" in value and not failed:
        return False, ""
    if "error" in value and not error:
        return False, ""
    if nested_success:
        return False, ""

    return None, ""
