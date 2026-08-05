# FusionSolar final-review fix report

Date: 2026-08-05
Branch: `feature/fusionsolar-oauth-ingest`
Reviewed base before this wave: `a0f1217`

## Implemented fixes

- OAuth nonce rows persist the issuing setup-token SHA-256 digest. State
  verification atomically consumes the nonce and returns that historical
  digest; callback credential persistence atomically claims that exact setup
  generation. Rotation, removal, replay, and concurrent outstanding-state
  cases are covered.
- Device visibility is reconciled only after a complete, clean device
  snapshot. Malformed plant/device records or failed inventory requests
  preserve prior visibility and checkpoints. Live and backfill selection
  exclude invisible devices.
- Persisted inventory/live/backfill gates are checked before Huawei calls.
  The scheduler honors the returned retry timestamp and does not perform
  lower-priority backfill while live work is backed off.
- Historical empty windows advance backwards across gaps. A documented
  grid-connection timestamp is used as the authoritative lower bound when
  present; without one, an empty window does not infer a global boundary or a
  fixed retention duration.
- Backfill disables automatic transient/429/5xx data retries while retaining
  the single controlled 401 refresh-and-retry.
- The single-replica Helm strategy is `Recreate`.
- Failure attempt counts persist in checkpoints. Backoff is capped
  exponential with injected jitter, honors a longer `Retry-After`, and resets
  after success.
- PostgreSQL-backed structured counters record cycles, Huawei failures, token
  refreshes, rows ingested, skipped fields, and backfill steps. `/status`
  exposes only sanitized numeric totals and existing sanitized state.
- No Mars2 write/control-scope/UI behavior was added.

## TDD evidence

Initial focused RED command:

```text
wsl.exe -- bash -lc 'docker run --rm -v /mnt/c/Users/ivan/Workspace/worktrees/bios-creategreen-fusionsolar:/workspace -w /workspace/bios-multilevel-platform-services/fusionsolar node:22-alpine node --test test/oauth-state.test.js test/oauth-routes.test.js test/store.test.js test/inventory.test.js test/live-sync.test.js test/backfill.test.js'
```

Result: exit 1; 57 tests, 40 passed, 15 failed, 2 skipped. Failures
reproduced premature history completion, disabled backfill 401 retry,
undefined device-checkpoint handling, invisible-device polling, and ignored
persisted live backoff.

Additional RED runs:

- Scheduler/counter regression: exit 1; 8 tests, 5 passed, 3 failed.
- Persistent diagnostic store/refresh regression: exit 1; 37 tests,
  33 passed, 2 failed, 2 skipped.
- Inventory backoff regression: exit 1; 8 tests, 7 passed, 1 failed.

The first PostgreSQL run then exposed two real batching/test-contract defects:
an unused PostgreSQL bind index in multi-plant upserts and old integration
tests that issued nonces without the newly required setup digest. After those
were fixed, the end-to-end test correctly failed its obsolete assumption that
one empty window always means completion. The fake provider was updated with
documented grid-connection dates so completion is now authoritative.

## Final verification evidence

All commands ran through WSL Docker.

### FusionSolar with PostgreSQL 16

```text
docker build -q -f bios-multilevel-platform-services/fusionsolar/Dockerfile -t bios-multilevel-platform-services-fusionsolar:latest .
docker run ... postgres:16-alpine
docker run --rm --network fusionsolar-final-test \
  -e NODE_PATH=/app/database/node_modules \
  -e TEST_DATABASE_URL=postgresql://bios:bios@fusionsolar-final-pg:5432/bios \
  bios-multilevel-platform-services-fusionsolar:latest \
  node --test fusionsolar/test/*.test.js
```

Result: exit 0; 105 tests passed, 0 failed, 0 skipped. This includes the
PostgreSQL OAuth concurrency, nonce/idempotency, and full fake-Huawei
end-to-end tests.

### Dashboard

```text
docker run --rm -v <workspace>:/workspace:ro -w /workspace \
  denoland/deno:alpine deno test \
  bios-multilevel-platform-services/dashboard/oauth-proxy_test.ts
docker run --rm -v <workspace>:/workspace:ro -w /workspace \
  denoland/deno:alpine deno check \
  bios-multilevel-platform-services/dashboard/main.ts
```

Result: both commands exited 0; 8 tests passed, 0 failed; type check passed.

### Compose and CI/deployment checks

```text
docker compose -f bios-multilevel-platform-services/docker-compose.yml config --quiet
```

Result: exit 0. A temporary empty, non-secret `.env` was used only because
the Compose file requires that path; it was deleted immediately afterward.

```text
docker run --rm -v <workspace>:/workspace:ro -w /workspace \
  node:22-bookworm-slim bash \
  bios-multilevel-platform-services/fusionsolar/test/ci-env-injection.test.sh
```

Result: exit 0; `CI_ENV_ROUND_TRIP_OK`.

`bash -n` passed for `forward-env.sh` and
`ci-env-injection.test.sh`. Ruby/Psych parsed `.gitlab-ci.yml`, FusionSolar
and dashboard Helm values, and network policies successfully. `git diff
--check` exited 0.

### Existing-service regressions

```text
docker run --rm -v <workspace>:/workspace:ro -w /tmp node:22-alpine \
  node /workspace/bios-multilevel-platform-services/prediction/test.js
```

Result: exit 0; `prediction tests passed`.

```text
docker build -q -f bios-multilevel-platform-services/blockchain/Dockerfile \
  -t bios-blockchain-final .
docker run --rm -w /tmp bios-blockchain-final sh -c \
  'mkdir -p bios-multilevel-platform-services/data && node /app/blockchain/test.js'
```

Result: exit 0; `blockchain tests passed`.

## Security/scope checks

- Runtime scope remains only `pvms.openapi.basic`; the control scope appears
  only in a negative test fixture.
- `postRawDataInput` appears only in end-to-end negative assertions.
- FusionSolar Helm values contain `strategyType: "Recreate"`.
- Structured status contains numeric counters only; no provider payload,
  token, secret, raw error, identifier, or query URL is exposed.
- No production credential or secret was added.

## Remaining concerns

- Production acceptance still requires real Huawei credentials and must
  confirm the regional API origin, both expected Sombor plants, device
  inventory, real grid-connection metadata, and provider flow-control
  behavior.
- If Huawei omits an authoritative lower bound, backfill intentionally keeps
  advancing across empty gaps; operators must not reinterpret one gap as a
  retention boundary.
- Encryption-key rotation still requires the documented maintenance-window,
  snapshot/key pairing, and immediate reauthorization procedure.
- The blockchain image build continues to report its pre-existing dependency
  advisories; this fix wave did not change blockchain dependencies.
