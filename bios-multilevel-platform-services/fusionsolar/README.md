# FusionSolar operations runbook

This service is a read-only Huawei FusionSolar source. It authorizes an owner,
discovers every visible plant and supported device, and stores live and
historical measurements in PostgreSQL. It does not publish to Mars2.

## Production configuration

Register this exact Huawei callback URI:

```text
https://bios-multilevel.barrage.net/oauth/fusionsolar/callback
```

Configure these GitLab CI/CD variables for the protected production
environment. Keep every variable protected. Mask the four secret values where
GitLab's masking rules permit it, and never put values in job scripts or logs.

| Variable | Secret | Required value or constraint |
| --- | --- | --- |
| `FUSIONSOLAR_CLIENT_ID` | yes | Huawei-issued application client ID |
| `FUSIONSOLAR_CLIENT_SECRET` | yes | Huawei-issued client secret |
| `FUSIONSOLAR_SETUP_TOKEN` | yes | New high-entropy bootstrap token |
| `FUSIONSOLAR_TOKEN_ENCRYPTION_KEY` | yes | Canonical base64 for exactly 32 random bytes |
| `FUSIONSOLAR_API_BASE_URL` | no | Huawei regional API origin assigned to this account |
| `FUSIONSOLAR_OAUTH_BASE_URL` | no | `https://oauth2.fusionsolar.huawei.com` unless Huawei assigns another origin |
| `FUSIONSOLAR_REDIRECT_URI` | no | Exact callback URI above |
| `FUSIONSOLAR_LIVE_INTERVAL_SECONDS` | no | Default `300`; do not lower without checking Huawei flow control |
| `FUSIONSOLAR_INVENTORY_INTERVAL_SECONDS` | no | Default `3600` |
| `FUSIONSOLAR_REQUEST_TIMEOUT_SECONDS` | no | Default `20` |
| `FUSIONSOLAR_BACKFILL_ENABLED` | no | `true` or `false`; default `true` |

`DATABASE_URL` is also required at runtime. The deployment platform supplies
the shared protected PostgreSQL connection secret; it is deliberately not
forwarded by the FusionSolar CI variable loop. The optional mounted CA is
selected with `DATABASE_CA_FILE=/etc/ssl/pg/ca.crt`.

Generate the encryption key and setup token from WSL using disposable Docker
containers. Run each command once and copy its output directly into the
protected variable form; do not paste it into chat, tickets, shell scripts, or
repository files.

```powershell
wsl.exe -- bash -lc 'docker run --rm node:22-alpine node -e "console.log(require(\"node:crypto\").randomBytes(32).toString(\"base64\"))"'
wsl.exe -- bash -lc 'docker run --rm node:22-alpine node -e "console.log(require(\"node:crypto\").randomBytes(48).toString(\"base64url\"))"'
```

The first output is `FUSIONSOLAR_TOKEN_ENCRYPTION_KEY`; the second is
`FUSIONSOLAR_SETUP_TOKEN`. Generate independent values. Do not reuse either
value across environments.

## First authorization

1. Deploy with all required variables and confirm `/health` returns HTTP 200.
2. Confirm `/status` reports `not_authorized`, not `not_configured`.
3. On the operator workstation, build this URL locally:

   ```text
   https://bios-multilevel.barrage.net/oauth/fusionsolar/start?setup_token=<URL-encoded setup token>
   ```

4. Open it directly in a private browser window. Do not send the URL through
   email, chat, a ticket, a URL shortener, or a shared password manager note:
   the query string is the bootstrap credential. The service sets
   `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, but local
   browser history and endpoint monitoring remain operator concerns.
5. Sign in as the FusionSolar owner that can see both Sombor plants. Verify
   Huawei requests only `pvms.openapi.basic`.
6. The callback must show `FusionSolar authorization completed`. Close the
   private window. The setup token digest is now consumed and the same link
   cannot authorize again.
7. Leave the now-consumed setup-token value configured. Its digest is
   single-use, and the current service also needs a non-empty setup token to
   remain in the `configured` state. Do not remove it after authorization.
   Explicitly replacing it with a new value is what enables reauthorization.

Never use `curl -v`, browser developer-tools exports, proxy capture, or CI job
output for the setup or callback URLs. They contain setup token, state, or
short-lived authorization code material.

## Health and sanitized status

The dashboard exposes only the two OAuth paths. Query `/health` and `/status`
from an authorized internal diagnostic context; the FusionSolar service has no
public ingress.

`/health` reports process liveness even when credentials are absent. `/status`
contains no token envelope or client secret and has these states:

- `not_configured`: at least one required setting is missing or the callback is
  not the exact registered URI. No Huawei polling is scheduled.
- `not_authorized`: configuration is complete, but no successful owner
  authorization is stored. No Huawei polling occurs.
- `authorized`: encrypted credentials exist and polling may run. Confirm
  `grantedScopes` contains `pvms.openapi.basic`.
- `reauthorization_required`: Huawei permanently rejected refresh credentials.
  Polling remains stopped until a fresh owner authorization succeeds.

Other safe fields are `configured`, `authorized`, `lastSyncAt`,
`backfill.completed`, `backfill.total`, `backfill.lastSuccessAt`, and a
sanitized `lastError`. Do not infer plant visibility from `/status`; inspect
the inventory tables.

## Reauthorization and rotation

To reauthorize after revocation, a client-secret change, or owner-account
change:

1. Generate a new setup token.
2. Update `FUSIONSOLAR_SETUP_TOKEN` as a protected/masked variable.
3. If Huawei rotated the application secret, update
   `FUSIONSOLAR_CLIENT_SECRET` in the same deployment.
4. Deploy, open the new one-time setup URL as described above, and complete
   owner authorization.
5. Confirm `authorized`, the basic scope, both plants, live writes, and a later
   successful refresh.
6. Retain the newly consumed setup-token value. Replace it again only when
   another explicit reauthorization is required.

Changing the client secret does not re-encrypt stored tokens. Existing access
tokens may work until refresh, but refresh can fail after Huawei invalidates
the old client secret; plan immediate reauthorization.

The token encryption key has no key identifier, dual-key read path, or online
rewrap operation. Replacing it makes all existing encrypted tokens unreadable.
Do not rotate it as an ordinary rolling configuration change. Schedule a
maintenance window, retain the old key for rollback, scale the single replica
down, update the encryption key and a fresh setup token together, deploy, and
immediately reauthorize so the credential row is overwritten under the new
key. Confirm refresh before destroying the old key. Never copy plaintext
tokens out of PostgreSQL to assist rotation.

## Plant, device, and measurement checks

Use an approved read-only PostgreSQL session. These queries expose inventory
and progress only; they do not select OAuth credential columns.

```sql
SELECT plant_code, source_key, display_name, visible, last_seen_at
FROM fusionsolar_plants
ORDER BY plant_code;

SELECT plant_code, device_id, device_type, model, serial_number, last_seen_at
FROM fusionsolar_devices
ORDER BY plant_code, device_id;

SELECT source, metric, max(ts) AS latest_measurement, count(*) AS rows
FROM raw_measurements
WHERE source LIKE 'HUAWEI:%'
GROUP BY source, metric
ORDER BY source, metric;

SELECT sync_key, checkpoint->>'before' AS next_before,
       checkpoint->>'reachedBoundary' AS reached_boundary,
       backoff_until, last_success_at, last_error
FROM fusionsolar_sync_state
ORDER BY sync_key;
```

Do not query, export, or log `encrypted_access_token` or
`encrypted_refresh_token`. Although encrypted, those envelopes remain
sensitive credential material.

## Huawei flow control and retention

Live polling has priority over backfill. The client refreshes before token
expiry, performs one controlled refresh-and-retry after a `401`, retries one
transient request, and honors `Retry-After` for `429`. The synchronizer records
backoff state so restarts do not create a tight request loop. Historical work
performs one bounded request per scheduler step, persists its backwards
checkpoint transactionally with measurements, and reduces an oversized range.

Do not bypass backoff, run parallel manual collectors, or lower polling
intervals to accelerate acceptance. If `429` persists, leave the recorded
backoff in place and verify the account's Huawei flow-control allocation.
Backfill stops only after Huawei returns an empty successful window. Huawei
does not guarantee a fixed retention period, so do not configure or report one.

## Sombor production acceptance

Complete this checklist only after Huawei supplies production credentials:

- [ ] Protected variables are configured without exposing values in logs or
      collaboration channels.
- [ ] `/health` is HTTP 200 and sanitized `/status` is `authorized`.
- [ ] `grantedScopes` includes `pvms.openapi.basic` and no control scope.
- [ ] The owner inventory contains exactly the two expected Sombor plant codes,
      both with `visible = true`.
- [ ] Expected inverter devices for each Sombor plant appear under the correct
      `plant_code`; resolve missing devices with the Huawei owner permissions
      before changing code.
- [ ] `raw_measurements` contains current `HUAWEI:<plantCode>` plant rows and
      corresponding device rows for both plants.
- [ ] A forced or naturally due access-token refresh succeeds without exposing
      token material.
- [ ] Backfill `before` checkpoints move backwards across scheduler cycles and
      process restart; flow-control backoff does not loop.
- [ ] An empty successful Huawei history response marks the device retention
      boundary without assuming a fixed age.
- [ ] The original setup-token digest is consumed. The configured value is
      retained because removing it currently stops polling; no replacement
      token is generated unless reauthorization is intentionally required.
- [ ] Prediction, blockchain, dashboard, and existing Mars2 ingestion remain
      healthy.

## Deferred Mars2 publishing

`POST /api/public/postRawDataInput` is outside this release and must remain
disabled. Before a later publisher is designed, Mars2 must separately provide:

1. provisioned destination counters for every accepted plant/device/metric;
2. confirmed production write permission; and
3. an approved mapping from normalized FusionSolar measurements to each Mars2
   `counterNodeId`.

Do not treat successful FusionSolar ingestion as evidence that any of these
Mars2 prerequisites exists.
