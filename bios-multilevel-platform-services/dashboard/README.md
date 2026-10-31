# BIOS Multi-level Platform Services Dashboard

Deno/Deno Deploy dashboard for the BIOS multi-level platform modules:

- Prediction Analysis Service
- Blockchain Integration Service

The existing GitHub Pages dashboard in `docs/index.html` remains focused on
Mars2 production data through the Cloudflare Worker. This dashboard is for the
server-deployed prediction and blockchain services.

## Local Run

Recommended:

```sh
cd bios-multilevel-platform-services
docker compose up --build
```

Open `http://localhost:8000`.

The dashboard is read-only. Backend services run continuously; the UI shows
live updates through `GET /events` Server-Sent Events and falls back to REST
status endpoints if the stream disconnects. A heartbeat is emitted every poll
cycle so the dashboard visibly updates even when the underlying data is stable.

## Manual Local Run

Start the two services:

```sh
node bios-multilevel-platform-services/prediction/server.js
node bios-multilevel-platform-services/blockchain/server.js
```

Then start the Deno dashboard:

```sh
cd bios-multilevel-platform-services/dashboard
PREDICTION_SERVICE_URL=http://localhost:8091 \
BLOCKCHAIN_SERVICE_URL=http://localhost:8092 \
deno task dev
```

Open the URL printed by Deno, usually `http://localhost:8000`.

## Deno Deploy

Deploy `main.ts` from this folder and configure environment variables:

```sh
PREDICTION_SERVICE_URL=https://your-server.example/prediction
BLOCKCHAIN_SERVICE_URL=https://your-server.example/blockchain
```

The dashboard proxies:

- `/prediction/*` to `PREDICTION_SERVICE_URL`
- `/blockchain/*` to `BLOCKCHAIN_SERVICE_URL`
- `/events` streams live platform-service snapshots to the browser

This keeps the browser pointed at one Deno Deploy URL while the actual services
can run on a VM, VPS, or other real server.

## Health Monitor And Slack Alerts

`monitor.ts` checks the platform's data flow every `ALERT_CHECK_SECONDS`
(default 60) by reading the prediction service's `GET /freshness` and the
blockchain `GET /health`, and posts to a Slack incoming webhook when the
situation changes:

| Condition | Default |
| --- | --- |
| Prediction or blockchain service unreachable | 3 consecutive checks (`ALERT_UPSTREAM_FAILURES`) |
| No completed prediction cycle | 45 min (`ALERT_CYCLE_STALE_MINUTES`) |
| Prediction cycle past its deadline (pod restart pending) | from `/freshness` |
| Prediction service cannot reach PostgreSQL | from `/freshness` |
| Last cycle ended `degraded`/`failed` | from `/freshness` |
| No new measurements for a configured station | 240 min (`ALERT_DATA_STALE_MINUTES`), solar 720 min (`ALERT_DATA_STALE_MINUTES_SOLAR`) — the meteo station samples at :00/:20 and Mars2 serves them 1–2 h late, so its newest row is routinely 2–3 h old |

One digest is sent when problems appear or change, a reminder every
`ALERT_REPEAT_MINUTES` (default 240) while they persist, and a recovery message
when everything clears. Nothing is sent during the first
`ALERT_STARTUP_GRACE_SECONDS` (default 120) after boot. With
`ALERT_SEND_STARTUP_MESSAGE` unset, a short "dashboard started" message is
posted at boot, which doubles as a webhook self-test and a restart signal.

Setup:

1. In Slack create an incoming webhook (Apps → *Incoming WebHooks*, or a Slack
   app with the *Incoming Webhooks* feature) and pick the channel or DM that
   should receive alerts. Copy the `https://hooks.slack.com/services/...` URL.
2. Add it as a masked CI/CD variable `SLACK_WEBHOOK_URL` in the GitLab project;
   the `production-dashboard` job forwards it (and any `ALERT_*` overrides) into
   the Helm values. Re-run the deploy.
3. `GET /monitor` on the dashboard shows the monitor's current verdict, last
   check time, active problems and the last `/freshness` payload;
   `GET /health` includes a one-line summary.

The monitor cannot report that the dashboard itself is down; point an external
uptime check at `https://<host>/health` for that.
