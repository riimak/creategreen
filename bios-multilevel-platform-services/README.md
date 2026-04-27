# BIOS Multi-level Platform Services

This directory contains two small standalone services that complement the
BIOS multi-level platform for tracking of meteo data and electricity production:

- `prediction/` -- Predictive Analysis Service for short-term forecasts and
  anomaly detection.
- `blockchain/` -- Blockchain Integration Service for compact Stealth event
  anchoring.
- `dashboard/` -- Deno/Deno Deploy dashboard for demonstrating the two
  services without changing the existing Mars2 production-data dashboard.

Both services run continuously by default and treat Mars2/BIOS as the source of
truth. They do not duplicate raw measurement rows. Prediction stores derived
forecast/anomaly/data-quality/SLA artifacts; blockchain stores only local
transaction status and compact payload metadata.

## Run

Recommended local demo with Docker Compose:

```sh
cd bios-multilevel-platform-services
docker compose up --build
```

Open:

```text
http://localhost:8000
```

The dashboard is read-only and updates in real time through Server-Sent Events.

The dashboard proxies to the two services over the Docker network:

- `http://prediction:8091`
- `http://blockchain:8092`

### Production (Barrage GitLab)

The repo uses the **monorepo** variables from `devops/ci-template` (`MONOREPO_TARGET_DIR`, `TARGET_APP`, `DOCKERFILE_PATH`, `APPLICATION_IMAGE_NAME_TAG`, `HELM_RELEASE_PREFIX`). Each app has its own Helm values under `dashboard/.gitlab/`, `prediction/.gitlab/`, and `blockchain/.gitlab/` (see GitLab Flow README in that template). After the first deploy, confirm in-cluster URLs in those files match `kubectl get svc` in the target namespace (this cluster uses the `…-barrage-autodeploy` service names).

CI **`DOCKERFILE_PATH`** must be **repo-root-relative**, e.g. `bios-multilevel-platform-services/dashboard/Dockerfile`, not `dashboard/Dockerfile` alone. If the image build fails at `COPY` with “file not found”, the Docker build context is wrong — ask devops how `build-docker-image-v3.sh` sets context for monorepo paths (it should match this directory so `COPY prediction`, `COPY database`, etc. resolve).

For direct API checks from your host:

```sh
curl http://localhost:8091/health
curl http://localhost:8091/status
curl http://localhost:8091/sla
curl "http://localhost:8091/forecast?source=OS1BIOS&metric=PM2_5&horizon=24"
curl http://localhost:8092/health
curl http://localhost:8092/status
curl http://localhost:8092/events
curl http://localhost:8092/chain/status
curl http://localhost:8092/chain/transactions
curl http://localhost:8092/chain/blocks
curl -X POST http://localhost:8092/events \
  -H "Content-Type: application/json" \
  -d '{"device_id":"0x0A1C","timestamp":1717699200,"event_code":"ok","value":250}'
```

Manual local run without Docker:

```sh
node bios-multilevel-platform-services/prediction/server.js
node bios-multilevel-platform-services/blockchain/server.js
```

Run the services dashboard locally with Deno:

```sh
cd bios-multilevel-platform-services/dashboard
PREDICTION_SERVICE_URL=http://localhost:8091 \
BLOCKCHAIN_SERVICE_URL=http://localhost:8092 \
deno task dev
```

For Deno Deploy, deploy `bios-multilevel-platform-services/dashboard/main.ts` and configure:

```sh
PREDICTION_SERVICE_URL=https://your-server.example/prediction
BLOCKCHAIN_SERVICE_URL=https://your-server.example/blockchain
```

The existing `docs/index.html` dashboard remains the Mars2 production-data
demonstration. The Deno dashboard is the delivery/demo surface for prediction
and blockchain.

The blockchain service defaults to `STEALTH_RELAY_MODE=mock`, so it can be
tested without Stealth tooling. Use `STEALTH_RELAY_MODE=stealth-lib` when the
real `stealth-lib` package and credentials are available.

## Mapping To Delivered Technical Solution

- Predictive Analysis Service: short-term forecasting up to 48 hours,
  anomaly/deviation detection, periodic refresh, data-quality/SLA overview, and
  weather input adapter.
- Blockchain Integration Service: continuously streams configured events,
  encodes compact binary payloads, submits them to Stealth, deduplicates source
  artifacts, and retries transient failures.
