# FusionSolar OAuth and data ingestion design

## Goal

Add Huawei FusionSolar as a read-only data source alongside the existing
Mars2/SOLAX source. The first release must:

- complete Huawei OAuth 2.0 Authorization Code authorization;
- securely persist and refresh OAuth tokens;
- discover every plant authorized by the owner;
- continuously ingest plant and device measurements into PostgreSQL;
- progressively backfill the maximum history exposed by Huawei;
- leave the existing dashboard and Mars2 ingest working unchanged; and
- expose a clean boundary for a later Mars2 publisher.

Publishing FusionSolar measurements to Mars2 is explicitly outside this
release. Mars2 documents `POST /api/public/postRawDataInput`, but production
write permissions, provisioned counters, and the `counterNodeId` mapping must
be confirmed before enabling writes.

## External contract

The registered callback is:

`https://bios-multilevel.barrage.net/oauth/fusionsolar/callback`

The application uses Huawei's Authorization Code flow and requests only
`pvms.openapi.basic`. The control scope is not required because the platform
does not issue commands to inverters or batteries.

The basic scope is expected to cover the read APIs needed by the platform:
plant and device lists, real-time plant and device data, historical device
data, reports, and active alarms. The production acceptance test must confirm
that both Sombor plants and their expected devices are visible to the
authorized owner.

## Architecture

Add a fourth Node.js service named `fusionsolar`.

The service has no public ingress. The existing dashboard proxies only the
`/oauth/fusionsolar/*` path to the internal service, preserving the registered
public callback URL. All other FusionSolar routes remain cluster-internal.

The FusionSolar service owns:

- Huawei client credentials and token encryption key;
- OAuth start, callback, code exchange, and refresh logic;
- authorized plant and device discovery;
- live polling and historical backfill;
- Huawei-to-platform metric normalization;
- PostgreSQL persistence and sync checkpoints; and
- health and sanitized status reporting.

The existing Mars2/SOLAX ingest remains independent. A Huawei failure must not
stop prediction, blockchain, dashboard, or Mars2 collection.

## OAuth flow

### Start

`GET /oauth/fusionsolar/start` requires a high-entropy setup token supplied
through deployment secrets. It creates a random, expiring, single-use nonce
and redirects the operator to Huawei's authorization endpoint with:

- `response_type=code`;
- the configured `client_id`;
- the exact registered `redirect_uri`;
- `scope=pvms.openapi.basic`; and
- a signed `state` containing the nonce and issuance time.

The setup token is a bootstrap credential, not a user session. After a
successful authorization it is marked consumed. A new authorization requires
an explicit token rotation.

### Callback

`GET /oauth/fusionsolar/callback`:

1. validates the signature, age, and one-time nonce in `state`;
2. rejects Huawei error responses with a safe operator-facing message;
3. exchanges the authorization code before its short expiry;
4. validates the returned token type and required basic scope;
5. encrypts tokens before persistence; and
6. marks the authorization and setup token as completed.

Authorization codes, access tokens, refresh tokens, client secrets, encryption
keys, and setup tokens must never appear in logs or HTTP responses.

### Token lifecycle

The service refreshes the access token before expiry. Refresh operations are
single-flight so concurrent jobs cannot invalidate each other's tokens. A
Huawei `401` permits one controlled refresh and retry. An invalid or revoked
refresh token changes the integration state to `reauthorization_required` and
stops Huawei polling until a new authorization is completed.

Tokens are encrypted with AES-256-GCM using an application key delivered as a
Kubernetes/GitLab secret. A unique nonce is used for each encrypted value.

## Data model

Add dedicated tables:

### `fusionsolar_oauth_credentials`

Stores one active authorization record, encrypted access and refresh tokens,
expiry, granted scopes, token type, authorization state, and timestamps.

### `fusionsolar_oauth_nonces`

Stores hashed setup-token/nonce identifiers, expiry, and consumption time.
Plain setup tokens and OAuth state secrets are not stored.

### `fusionsolar_plants`

Stores the stable internal source key, Huawei plant code, display name,
timezone when available, authorization visibility, source metadata JSON, and
last-seen timestamps.

### `fusionsolar_devices`

Stores Huawei device identifiers, owning plant, device type/model, serial
number where returned, source metadata JSON, and last-seen timestamps.

### `fusionsolar_sync_state`

Stores per-plant, per-device, and per-endpoint live/backfill checkpoints,
backoff state, last success, and sanitized last error.

Numeric time-series values continue to use the existing
`raw_measurements(source, metric, ts, value, is_missing)` table and its
idempotent primary key.

## Source and metric normalization

Every authorized plant is ingested. Each receives a stable source key derived
from its immutable Huawei plant code, not its mutable display name.

Huawei fields are mapped through an explicit, versioned metric registry that
records:

- Huawei endpoint and field;
- applicable device type;
- platform metric name;
- source and destination units;
- conversion function; and
- whether the mapping has been semantically verified.

Huawei fields must not be renamed to existing SOLAX metrics solely because
their names appear similar. Confirmed semantic matches may use a shared
canonical metric; unmatched fields use a stable Huawei-prefixed metric name.
Unknown, non-numeric, or unsupported fields are reported in sanitized
diagnostics and are not silently coerced.

This normalized representation is the future boundary for publishing to
Mars2. A later mapping table will associate a plant/device/metric with a
provisioned Mars2 `counterNodeId`.

## Synchronization

### Live polling

Live plant and device data are polled at the minimum useful cadence allowed by
Huawei's update frequency and flow-control policy. Live work always has
priority over historical backfill.

Each cycle:

1. refreshes the token if needed;
2. refreshes the authorized plant/device inventory when due;
3. fetches current data for each visible plant/device;
4. normalizes supported values;
5. performs idempotent batch upserts; and
6. advances checkpoints only after a successful transaction.

One malformed plant, device, or metric does not abort unrelated work.

### Historical backfill

After authorization, the service progressively requests the maximum history
Huawei makes available. It walks backwards in endpoint-supported windows and
persists checkpoints after every successful batch.

Backfill:

- resumes after process restarts;
- remains lower priority than live collection;
- respects per-endpoint and per-device flow-control limits;
- uses exponential backoff with jitter for `429` and transient `5xx` errors;
- reduces request windows when Huawei rejects an oversized range; and
- stops cleanly when the API indicates the retention boundary or no earlier
  data exists.

The implementation must not claim a fixed retention period that Huawei does
not guarantee.

## HTTP surface

Public through the dashboard proxy:

- `GET /oauth/fusionsolar/start`
- `GET /oauth/fusionsolar/callback`

Internal only:

- `GET /health` — process/liveness status;
- `GET /status` — configured/authorized state, granted scope, last successful
  sync, backfill progress, and sanitized last error.

The dashboard proxy uses a fixed route allowlist, forwards only required
headers and query parameters, preserves Huawei redirects, and never exposes
the internal hostname. It does not become a general write proxy.

## Configuration and secrets

Required production configuration:

- `FUSIONSOLAR_CLIENT_ID`
- `FUSIONSOLAR_CLIENT_SECRET`
- `FUSIONSOLAR_REDIRECT_URI`
- `FUSIONSOLAR_SETUP_TOKEN` (bootstrap only; remove after successful authorization)
- `FUSIONSOLAR_TOKEN_ENCRYPTION_KEY`
- `FUSIONSOLAR_OAUTH_BASE_URL`
- `FUSIONSOLAR_API_BASE_URL`
- `DATABASE_URL`

Optional scheduler, timeout, and backfill settings receive conservative
defaults. Secrets are provided through protected deployment variables or
Kubernetes Secrets and are never committed to the repository.

The service remains healthy but reports `not_configured` when required core
Huawei configuration is absent. This permits deployment before Huawei returns
client credentials. The setup token is not core runtime configuration:
removing it after authorization disables `/start` without stopping polling.

## Failure handling and observability

- Reject expired, unknown, malformed, or replayed OAuth state.
- Use bounded request timeouts and abort signals for every external call.
- Retry only transient failures and honor `Retry-After` where supplied.
- Do not retry permanent authentication, authorization, or payload errors in a
  tight loop.
- Report `reauthorization_required` for revoked authorization.
- Record structured counters for cycles, API failures, rows ingested, skipped
  fields, refreshes, and backfill progress.
- Log host, endpoint class, status, plant/device identifier, and timing where
  safe; never log credentials, complete URLs containing secrets, or raw token
  responses.

## Testing

Unit tests cover:

- authorization URL construction;
- setup-token validation and single use;
- state signing, expiry, and replay prevention;
- callback errors and code exchange;
- AES-256-GCM token encryption/decryption and tamper rejection;
- single-flight refresh and one-time `401` retry;
- `429`, `Retry-After`, transient `5xx`, and revoked authorization;
- plant/device discovery;
- metric mapping, units, unknown fields, and timestamps;
- idempotent measurement persistence; and
- resumable backwards backfill.

Integration tests use a fake Huawei HTTP server and a test PostgreSQL database
to exercise authorization, refresh, live sync, restart/resume, and failure
recovery without real credentials.

Dashboard tests confirm the strict OAuth proxy allowlist, redirect
preservation, hidden internal host, and rejection of unrelated methods/paths.

Docker Compose smoke tests verify that the complete stack starts without
Huawei credentials and that existing Mars2, prediction, blockchain, and
dashboard behavior remains intact.

The production acceptance test occurs only after Huawei supplies credentials.
It confirms:

- successful owner authorization through the registered callback;
- granted `pvms.openapi.basic` scope;
- visibility of both Sombor plants and expected devices;
- successful live measurement storage;
- token refresh; and
- observable backfill progress without breaching Huawei flow limits.

No production Mars2 write is attempted in this release.
