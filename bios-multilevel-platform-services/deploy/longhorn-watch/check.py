#!/usr/bin/env python3
"""Decide Longhorn volume alert keys from status JSON (pure; unit-tested)."""
from __future__ import annotations

from typing import Any


def evaluate(volume: dict[str, Any], *, min_replicas: int = 2) -> list[str]:
    """Return problem keys for a Longhorn volume object (or kubectl get -o json)."""
    status = volume.get("status") or {}
    spec = volume.get("spec") or {}
    state = (status.get("state") or "").lower()
    robust = (status.get("robustness") or "").lower()
    problems: list[str] = []

    if state in ("", "detached") or robust == "faulted":
        problems.append("longhorn.faulted")
    elif robust == "degraded":
        problems.append("longhorn.degraded")
    elif state != "attached" or robust not in ("healthy", "unknown"):
        # unknown can appear briefly during attach; still flag non-attached
        if state != "attached":
            problems.append("longhorn.faulted")
        elif robust not in ("healthy",):
            problems.append("longhorn.degraded")

    n = int(spec.get("numberOfReplicas") or 0)
    if n and n < min_replicas:
        problems.append("longhorn.under_replicated")

    return problems


def format_slack(
    problems: list[str],
    *,
    volume_name: str,
    state: str,
    robustness: str,
    replicas: int,
    previous: list[str] | None = None,
) -> str | None:
    """Message text on transition; None if nothing to post."""
    prev = previous or []
    if problems == prev:
        return None
    if not problems and prev:
        return (
            f":white_check_mark: Longhorn volume `{volume_name}` recovered "
            f"(state={state} robustness={robustness} replicas={replicas})."
        )
    if problems:
        keys = ", ".join(problems)
        return (
            f":warning: Longhorn `{volume_name}` — {keys} "
            f"(state={state} robustness={robustness} numberOfReplicas={replicas}). "
            f"Postgres PVC may lose HA or go down; check longhorn-system."
        )
    return None
