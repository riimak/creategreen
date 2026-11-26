#!/usr/bin/env python3
"""Fetch Longhorn volume status in-cluster and Slack on problem transitions."""
from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.request

import check

VOLUME_NAME = os.environ.get("VOLUME_NAME", "pvc-d9743216-49aa-4042-a43e-259238f3e18f")
MIN_REPLICAS = int(os.environ.get("MIN_REPLICAS") or "2")
STATE_CONFIGMAP = os.environ.get("STATE_CONFIGMAP", "longhorn-watch-state")
STATE_NAMESPACE = os.environ.get("STATE_NAMESPACE", "bios-multilevel-databases")
WEBHOOK = (os.environ.get("SLACK_WEBHOOK_URL") or "").strip()

TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
NS_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"


def api_base() -> str:
    host = os.environ["KUBERNETES_SERVICE_HOST"]
    port = os.environ.get("KUBERNETES_SERVICE_PORT_HTTPS") or os.environ["KUBERNETES_SERVICE_PORT"]
    return f"https://{host}:{port}"


def ssl_ctx() -> ssl.SSLContext:
    return ssl.create_default_context(cafile=CA_PATH)


def request(method: str, path: str, body: dict | None = None) -> dict:
    token = open(TOKEN_PATH).read()
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        api_base() + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    with urllib.request.urlopen(req, context=ssl_ctx(), timeout=30) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def load_previous() -> list[str]:
    try:
        cm = request("GET", f"/api/v1/namespaces/{STATE_NAMESPACE}/configmaps/{STATE_CONFIGMAP}")
        return json.loads(cm.get("data", {}).get("previous.json") or "{}").get("problems") or []
    except Exception as e:
        print("load previous failed:", e)
        return []


def save_previous(problems: list[str]) -> None:
    payload = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": STATE_CONFIGMAP, "namespace": STATE_NAMESPACE},
        "data": {"previous.json": json.dumps({"problems": problems})},
    }
    path = f"/api/v1/namespaces/{STATE_NAMESPACE}/configmaps/{STATE_CONFIGMAP}"
    try:
        request("PUT", path, payload)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        request("POST", f"/api/v1/namespaces/{STATE_NAMESPACE}/configmaps", payload)


def post_slack(text: str) -> None:
    if not WEBHOOK:
        print("SLACK_WEBHOOK_URL unset; not posting")
        return
    req = urllib.request.Request(
        WEBHOOK,
        data=json.dumps({"text": text}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            print("slack status", resp.status)
    except Exception as e:
        print("slack post failed:", e)


def main() -> None:
    vol = request(
        "GET",
        f"/apis/longhorn.io/v1beta2/namespaces/longhorn-system/volumes/{VOLUME_NAME}",
    )
    problems = check.evaluate(vol, min_replicas=MIN_REPLICAS)
    status = vol.get("status") or {}
    spec = vol.get("spec") or {}
    name = (vol.get("metadata") or {}).get("name") or VOLUME_NAME
    state = status.get("state") or ""
    robust = status.get("robustness") or ""
    replicas = int(spec.get("numberOfReplicas") or 0)
    previous = load_previous()
    print(f"problems={problems} previous={previous} state={state} robust={robust}")
    msg = check.format_slack(
        problems,
        volume_name=name,
        state=state,
        robustness=robust,
        replicas=replicas,
        previous=previous,
    )
    if msg:
        print("slack:", msg)
        post_slack(msg)
    save_previous(problems)


if __name__ == "__main__":
    main()
