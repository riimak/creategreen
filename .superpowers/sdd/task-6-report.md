# Task 6 Report: OAuth Routes, Scheduler, Status, and Shutdown

## Status

Implemented and verified.

## Delivered

- Added import-safe FusionSolar integration composition and process entrypoint.
- Added constant-time setup-token validation with uniform `404` rejection.
- Persisted SHA-256 setup-token consumption and made credential persistence
  conditional on winning the bootstrap claim in one PostgreSQL statement.
- Added safe OAuth start/callback routes with no-store, no-referrer, and
  restrictive CSP headers; callback output never reflects Huawei parameters.
- Added sanitized status output containing only configuration/authorization,
  granted scopes, last live sync, aggregate backfill progress, and categorical
  errors.
- Added deterministic, serialized scheduling: authorized integrations run live
  immediately and at cadence, followed by at most one backfill step after a
  successful live cycle.
- Added idempotent shutdown that stops timers and closes both HTTP server and
  PostgreSQL store for `SIGTERM` and `SIGINT`.

## TDD Evidence

- OAuth route RED: `node --test test/oauth-routes.test.js` failed with
  `Cannot find module '../integration'`.
- Setup persistence RED: focused store test failed with
  `store.isSetupTokenConsumed is not a function`.
- Scheduler RED: four scheduler assertions failed before `startScheduler`
  returned the active deterministic cycle.
- Atomic credential/bootstrap RED: Huawei client and store contract assertions
  failed before setup digest propagation and the data-modifying CTE existed.
- Shutdown RED: scheduler test failed with `createShutdown is not a function`.
- PostgreSQL regression caught a real SQL defect:
  `could not determine data type of parameter $6`; adding the explicit
  `$6::text` cast fixed it.

## Final Verification

Executed from WSL using Docker only:

```text
docker run --rm --network fusionsolar-task6-net \
  -e TEST_DATABASE_URL=postgresql://bios@fusionsolar-task6-pg/bios \
  -e NODE_PATH=/deps/node_modules \
  -v "$PWD:/workspace:ro" -v fusionsolar-task6-deps:/deps:ro \
  -w /workspace/bios-multilevel-platform-services/fusionsolar \
  node:22-alpine npm test
```

Result: exit `0`; `86` tests passed, `0` failed, `0` skipped. The
PostgreSQL-backed test exercised schema initialization, setup-token
single-use, atomic authorization persistence, encrypted credential round-trip,
nonce replay prevention, and measurement/checkpoint persistence.

`git diff --check` also exited `0`.

## Concerns

None blocking. Production authorization still requires Huawei-issued
credentials and an operator-driven acceptance test; no real Huawei request was
made by this task.

## Blocking Race Correction

The original callback flow exchanged the Huawei code through a client method
that persisted credentials, then separately attempted setup-token consumption.
Two callbacks holding valid pre-issued states could therefore both report
success and the second could overwrite the first credential set.

The corrected flow:

1. verifies and consumes OAuth state;
2. exchanges the Huawei code with persistence deferred;
3. calls `saveCredentialsIfSetupUnused(setupTokenHash, tokens)`;
4. uses one data-modifying PostgreSQL CTE to claim the setup-token hash and
   insert/update credentials only from the successful claim; and
5. returns the same generic callback failure when the claim returns `false`.

A failed Huawei exchange occurs before any setup-token claim, so a fresh state
can retry a transient exchange failure.

### Race-fix TDD evidence

- Store contract RED:
  `store.saveCredentialsIfSetupUnused is not a function`.
- PostgreSQL callback-concurrency RED: two valid pre-issued states completed
  concurrently and failed with `2 !== 1` successful callbacks.
- Deferred-exchange RED: `exchangeCode(..., { persist: false })` still populated
  the credential store before the client change.
- Generic loser callback and transient-exchange retry are covered by route
  tests without reflecting code or state.

### Race-fix verification

Executed through WSL Docker with PostgreSQL 16:

```text
node --test test/oauth-routes.test.js test/scheduler.test.js test/store.test.js
```

Result: exit `0`; `31` tests passed, `0` failed, `0` skipped. This includes the
real PostgreSQL test `PostgreSQL allows only one completion from two valid
pre-issued OAuth states`.

```text
npm test
```

Result: exit `0`; `91` tests passed, `0` failed, `0` skipped, with
`TEST_DATABASE_URL` set to the isolated PostgreSQL 16 container.
