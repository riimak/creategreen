# Task 9 Report

## Status

Implemented and verified:

- deterministic local fake Huawei OAuth/API server with redacted call records;
- PostgreSQL end-to-end coverage for schema initialization, owner OAuth,
  encrypted credential storage, two-plant inventory/live ingestion, forced
  refresh, backwards restart/resume, flow control, empty retention, and the
  absence of Mars2 writes;
- an operational FusionSolar runbook aligned with the approved design; and
- serialized PostgreSQL schema initialization after the full parallel suite
  exposed a real `CREATE EXTENSION IF NOT EXISTS` race.

No real Huawei credentials, real Huawei requests, or external writes were used.

## End-to-end evidence

The end-to-end test uses an isolated PostgreSQL schema and drops it after the
test. The fake service binds only to an ephemeral loopback port. Its fixtures
are explicitly fake, form fields and authorization queries are recorded only
as `[REDACTED]`, authorization headers are not recorded, and test output does
not print fixture credentials.

The PostgreSQL test proves:

1. `store.init()` initializes the schema;
2. `/oauth/fusionsolar/start` redirects through the fake authorize endpoint;
3. the fake owner callback exchanges the code and returns generic success HTML;
4. PostgreSQL JSON envelopes contain ciphertext and do not contain plaintext
   token markers;
5. paginated inventory stores `SOMBOR-A` and `SOMBOR-B`;
6. live rows include `HUAWEI:SOMBOR-A` and `HUAWEI:SOMBOR-B`;
7. a controlled API `401` refreshes and retries;
8. an expired database credential forces another refresh;
9. history advances backwards, persists the checkpoint, and resumes from that
   exact `before` value after the first FusionSolar runtime is stopped and a
   second runtime starts;
10. fake `429` plus `Retry-After: 0` produces persisted backoff without sleep;
11. successful empty history windows complete both device retention boundaries;
12. no recorded path contains `postRawDataInput`.

The first full parallel PostgreSQL run failed because two test files raced
while creating `pgcrypto`. `store.init()` now holds a session advisory lock
around schema execution, with a focused regression test. A new blank
PostgreSQL container then passed the complete suite.

Final command:

```text
wsl.exe -- bash -lc 'docker start task9-suite-pg >/dev/null && until docker exec task9-suite-pg pg_isready -U bios -d bios >/dev/null 2>&1; do sleep 1; done && docker run --rm --network task9-suite-net -e NODE_PATH=/app/database/node_modules -e TEST_DATABASE_URL=postgresql://bios@task9-suite-pg:5432/bios bios-fusionsolar-task9 node --test fusionsolar/test/*.test.js'
```

Result: exit 0; 94 tests passed, 0 failed, 0 skipped. This includes all three
PostgreSQL tests and the two Task 9 end-to-end/fake-server tests.

## Regression evidence

Dashboard OAuth proxy:

```text
wsl.exe -- docker run --rm -v /mnt/c/Users/ivan/Workspace/worktrees/bios-creategreen-fusionsolar:/workspace:ro -w /workspace denoland/deno:alpine deno test bios-multilevel-platform-services/dashboard/oauth-proxy_test.ts
```

Result: exit 0; 8 passed, 0 failed.

Dashboard type check:

```text
wsl.exe -- docker run --rm -v /mnt/c/Users/ivan/Workspace/worktrees/bios-creategreen-fusionsolar:/workspace:ro -w /workspace denoland/deno:alpine deno check bios-multilevel-platform-services/dashboard/main.ts
```

Result: exit 0.

Prediction regression:

```text
wsl.exe -- docker run --rm -v /mnt/c/Users/ivan/Workspace/worktrees/bios-creategreen-fusionsolar:/workspace:ro -w /tmp node:22-alpine node /workspace/bios-multilevel-platform-services/prediction/test.js
```

Result: exit 0; `prediction tests passed`. The read-only repository mount and
`/tmp` working directory prevented generated repository state.

Blockchain regression:

```text
wsl.exe -- docker run --rm -w /tmp bios-blockchain-task9 sh -c 'mkdir -p bios-multilevel-platform-services/data && node /app/blockchain/test.js'
```

Result: exit 0; `blockchain tests passed`. The hard-coded relative test data
path resolved under the disposable container's `/tmp`; no tracked or workspace
blockchain fixture was mutated.

Compose render:

```text
wsl.exe -- bash -lc 'cd /mnt/c/Users/ivan/Workspace/worktrees/bios-creategreen-fusionsolar && cp .env.example .env && docker compose -f bios-multilevel-platform-services/docker-compose.yml config >/tmp/task9-compose-final.yaml && rm .env'
```

Result: exit 0; the complete configuration rendered and the temporary `.env`
was removed.

CI forwarding regression:

```text
wsl.exe -- bash -lc 'cd /mnt/c/Users/ivan/Workspace/worktrees/bios-creategreen-fusionsolar && docker run --rm -v "$PWD:/workspace:ro" -w /workspace node:22-bookworm-slim bash bios-multilevel-platform-services/fusionsolar/test/ci-env-injection.test.sh'
```

Result: exit 0; `CI_ENV_ROUND_TRIP_OK`.

`git diff --check` also exited 0.

## Security review

- FusionSolar and dashboard JavaScript/TypeScript contain no console call that
  logs OAuth codes, states, setup tokens, client secrets, or token values.
- The only broad logging-pattern match was the pre-existing prediction warning
  that says a token was cleared; it does not print the token.
- OAuth start, callback, and fake OAuth responses use
  `Cache-Control: no-store`.
- The dashboard proxy allowlist is exactly `/oauth/fusionsolar/start` and
  `/oauth/fusionsolar/callback`; its 8 tests reject every other path/method.
- `pvms.openapi.control` appears only in a negative unit-test fixture that
  verifies rejection. Runtime requests use only `pvms.openapi.basic`.
- The end-to-end test injects one recording fetch into every Huawei token/API
  request, rejects any destination outside the fake Huawei origin, and asserts
  zero Mars2 host or `postRawDataInput` destinations.
- No configured production value or real credential was added.

## Runbook coverage

The runbook documents protected/masked CI variables, the exact registered
callback, WSL Docker generation for independent encryption/setup secrets,
safe one-time link handling, sanitized status states, reauthorization,
client-secret and encryption-key rotation caveats, token-free plant/device SQL,
Huawei `401`/`429`/retention behavior, both-Sombor acceptance, and deferred
Mars2 write permission/counter/`counterNodeId` prerequisites.

## Concerns

- Production acceptance remains pending Huawei credentials and must confirm
  the real regional API origin, both expected Sombor plant codes, and their
  inverter inventory.
- Encryption-key rotation has no dual-key or rewrap support. It requires a
  maintenance window and immediate reauthorization under a fresh setup token.
  Old-key rollback works directly only before reauthorization overwrites the
  ciphertext; afterwards rollback requires retaining the new key or restoring
  the protected pre-rotation database snapshot with its matching old key.
- The blockchain image build reports two existing dependency advisories
  (one low, one high). Task 9 did not change blockchain dependencies.

## Review follow-up

Task 9 review findings were fixed in a second local commit:

- core configuration and scheduling no longer depend on
  `FUSIONSOLAR_SETUP_TOKEN`;
- `/start` explicitly rejects absent setup configuration with the same 404 as
  a wrong token;
- sanitized status now exposes `setupAvailable`;
- config, route, scheduler, and PostgreSQL end-to-end tests prove an authorized
  redeploy with an empty setup token remains configured and operational;
- `.env.example`, design, and runbook now direct operators to remove the setup
  token after authorization;
- the Huawei 26.1 contract was rechecked against the authoritative PDF:
  Plant List is paginated, while Device List accepts `stationCodes` for at
  most 100 plants per request and has no pagination contract;
- the implementation plan now says paginated plants and station-batched
  devices, and the fake rejects a 101-plant batch with fail code `20015`;
- PostgreSQL assertions verify both expected device IDs are attached to their
  correct Sombor plants; and
- encryption rotation instructions preserve matched snapshot/key rollback
  pairs and explicitly describe the post-overwrite boundary.

### Red/green bootstrap evidence

RED command:

```text
wsl.exe -- bash -lc 'cd /mnt/c/Users/ivan/Workspace/worktrees/bios-creategreen-fusionsolar && docker build -f bios-multilevel-platform-services/fusionsolar/Dockerfile -t bios-fusionsolar-task9-review-red . >/tmp/task9-review-red-build.log && docker run --rm bios-fusionsolar-task9-review-red node --test fusionsolar/test/config.test.js fusionsolar/test/oauth-routes.test.js fusionsolar/test/scheduler.test.js'
```

Result before the runtime fix: exit 1; the new config test reported
`not_configured`, the authorized scheduler made zero calls, and status omitted
`setupAvailable`.

GREEN command used the same three test files in
`bios-fusionsolar-task9-review`.

Result: exit 0; 21 passed, 0 failed.

The fake's 101-plant Device List test also failed before enforcement because
the fake returned both devices, then passed after batch validation was added.

### Final review verification

Focused PostgreSQL end-to-end command:

```text
wsl.exe -- bash -lc 'docker network create task9-review-net >/dev/null && docker run -d --name task9-review-pg --network task9-review-net -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=bios -e POSTGRES_DB=bios postgres:16-alpine >/dev/null && until docker exec task9-review-pg pg_isready -U bios -d bios >/dev/null 2>&1; do sleep 1; done && docker run --rm --network task9-review-net -v /mnt/c/Users/ivan/Workspace/worktrees/bios-creategreen-fusionsolar/bios-multilevel-platform-services/fusionsolar:/app/fusionsolar:ro -e NODE_PATH=/app/database/node_modules -e TEST_DATABASE_URL=postgresql://bios@task9-review-pg:5432/bios bios-fusionsolar-task9-review node --test fusionsolar/test/end-to-end.test.js'
```

Result: exit 0; 2 passed, 0 failed, 0 skipped.

Final full PostgreSQL-backed command:

```text
wsl.exe -- bash -lc 'docker start task9-review-pg >/dev/null && until docker exec task9-review-pg pg_isready -U bios -d bios >/dev/null 2>&1; do sleep 1; done && docker run --rm --network task9-review-net -e NODE_PATH=/app/database/node_modules -e TEST_DATABASE_URL=postgresql://bios@task9-review-pg:5432/bios bios-fusionsolar-task9-review-final node --test fusionsolar/test/*.test.js'
```

Result: exit 0; 97 passed, 0 failed, 0 skipped. An earlier attempt started
after the temporary PostgreSQL container had been externally stopped and
reported only `EAI_AGAIN`; the quoted final command explicitly restarted and
readiness-checked PostgreSQL.

Regression results:

- dashboard OAuth proxy: 8 passed, 0 failed;
- dashboard `deno check`: exit 0;
- prediction regression in a read-only mount with `/tmp` working directory:
  `prediction tests passed`;
- blockchain regression with its hard-coded data path under disposable
  container `/tmp`: `blockchain tests passed`;
- Compose config render: exit 0;
- CI variable forwarding: exit 0, `CI_ENV_ROUND_TRIP_OK`;
- `git diff --check`: exit 0.
