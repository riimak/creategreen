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
