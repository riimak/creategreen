#!/usr/bin/env python3
"""Offline tests for longhorn-watch/check.py — run: python3 check_test.py"""
from __future__ import annotations

import check


def test_healthy():
    probs = check.evaluate(
        {"spec": {"numberOfReplicas": 3}, "status": {"state": "attached", "robustness": "healthy"}}
    )
    assert probs == [], probs


def test_degraded():
    probs = check.evaluate(
        {"spec": {"numberOfReplicas": 2}, "status": {"state": "attached", "robustness": "degraded"}}
    )
    assert probs == ["longhorn.degraded"], probs


def test_faulted_detached():
    probs = check.evaluate(
        {"spec": {"numberOfReplicas": 2}, "status": {"state": "detached", "robustness": "faulted"}}
    )
    assert "longhorn.faulted" in probs


def test_under_replicated():
    probs = check.evaluate(
        {"spec": {"numberOfReplicas": 1}, "status": {"state": "attached", "robustness": "healthy"}},
        min_replicas=2,
    )
    assert probs == ["longhorn.under_replicated"], probs


def test_slack_transition():
    msg = check.format_slack(
        ["longhorn.degraded"],
        volume_name="pvc-x",
        state="attached",
        robustness="degraded",
        replicas=2,
        previous=[],
    )
    assert msg and "longhorn.degraded" in msg
    assert (
        check.format_slack(
            ["longhorn.degraded"],
            volume_name="pvc-x",
            state="attached",
            robustness="degraded",
            replicas=2,
            previous=["longhorn.degraded"],
        )
        is None
    )
    recovery = check.format_slack(
        [],
        volume_name="pvc-x",
        state="attached",
        robustness="healthy",
        replicas=3,
        previous=["longhorn.degraded"],
    )
    assert recovery and "recovered" in recovery


if __name__ == "__main__":
    test_healthy()
    test_degraded()
    test_faulted_detached()
    test_under_replicated()
    test_slack_transition()
    print("ok")
