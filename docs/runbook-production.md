# Production runbook — BIOS Multi-level

Cluster `production.zag` (kubectl context `production.zag`), namespaces
`bios-multilevel-production` (services) and `bios-multilevel-databases`
(PostgreSQL). Public host `https://bios-multilevel.barrage.net`. Deploys go
through GitLab (`git.barrage.net/bios-multilevel/bios-multilevel-dashboard`):
a push to branch `production` builds and deploys all five services.

## Components

| Service | Replicas | Role | Health |
| --- | --- | --- | --- |
| dashboard (Deno) | 2, anti-affinity, PDB | public UI + read-only proxy; Slack monitor (lease holder only); stale-while-error | `GET /health`, `GET /monitor`, `GET /monitor/slo` |
| prediction (Node) | 2, anti-affinity, PDB | Mars2 ingest + cycles (leader only), raw measurements API, Mars2 feed API | `GET /freshness` (`db`, `leader`, `feed`), `/health` 503 only when a cycle is wedged |
| blockchain (Node) | 1 | Stealth anchoring | `/blockchain/health` |
| fusionsolar, soliscloud (Node) | 1 each | vendor ingest into `raw_measurements` | internal `/status` |
| PostgreSQL 17 (bitnami, Longhorn PVC 30 Gi) | 1 | everything | `pg_isready`; dashboard probes it directly |

Alerts: Slack via `SLACK_WEBHOOK_URL`; rules in
`bios-multilevel-platform-services/dashboard/README.md`. External probe:
GitLab scheduled job `uptime-probe` (below).

## Routine operations

### Deploying

Push to `production`. Deploy jobs retry twice (etcd leader churn makes single
`kubectl`/`helm` calls fail); if a pipeline still stalls after one service,
retry the failed job in GitLab or push an empty commit. The dashboard job is
last and only runs when the other four succeed.

If a deploy job dies in the middle of `helm upgrade` (runner or API failure)
the release is left `pending-upgrade` and every later upgrade — including the
GitLab retry — fails with "another operation (install/upgrade/rollback) is in
progress". Check with
`kubectl -n bios-multilevel-production get secrets -l owner=helm,name=<release> --show-labels`.
If the Deployment has already rolled out to the new image, delete the pending
record `sh.helm.release.v1.<release>.v<N>` (back it up first with `get secret
-o yaml`) and re-run the job: the next upgrade records v<N+1> as `deployed`
without restarting pods. If the rollout did not finish, `helm rollback
<release> <N-1>` first. Happened 2026-11-26 (prediction v90).

`production` is a true merge of the working branch since `9e3ee3b`
(2026-11-26): fast-forward it (`git push barrage <branch>:production`) rather
than cherry-picking onto a `deploy-*` branch.

### One-time setup still open

1. **Registry deploy token** (pods cannot pull images between pipelines because
   the CI pull secret is a job token). In GitLab: Settings > Repository >
   Deploy tokens, scope `read_registry`, then:

   ```sh
   kubectl -n bios-multilevel-production create secret docker-registry bios-registry-deploy-token \
     --docker-server=registry.barrage.net:443 --docker-username=<token username> --docker-password=<token>
   ```

   Every service already lists `bios-registry-deploy-token` in `image.secrets`;
   until the secret exists kubelet logs a harmless `FailedToRetrieveImagePullSecret`.
2. **Uptime probe schedule**: CI/CD > Schedules > New: cron `*/5 * * * *`,
   timezone UTC, target branch `production`, variable `UPTIME_PROBE=true`.
   `SLACK_WEBHOOK_URL` must be available to scheduled pipelines (it is a
   project variable, so it is). The job fails while the site is down and posts
   to Slack on down/up transitions; `.uptime/history.csv` is the availability
   record (artifact, 14 days).
3. **Mars2 feed credentials**: CI variables `FEED_USERNAME`, `FEED_PASSWORD`
   (masked) or `FEED_API_KEY`; optional `FEED_TOKEN_SECRET`. Until set the
   feed answers 503. For the Solax-dialect devices in Mars2 the `TokenId`
   device parameter is `FEED_API_KEY`, so set that one (masked, 32+ random
   characters). `ALERT_FEED_SILENT_MINUTES` is `15` in the committed
   dashboard values (Mars2 polls every 5 minutes; a CI variable of the same
   name overrides it, `0` disables the rule).
   `uploadTime` is sent in fixed UTC+2 (`FEED_SOLAX_TIMEZONE=Etc/GMT-2`),
   the same convention Solax Cloud uses for `SOLAXBIOS`. **Policy (Ivan,
   2026-11-13): the BIOS data must be exactly what Mars2 holds, Mars2's time
   handling included** — so the feed plants come out of Mars2 like every
   other station (right in winter, two hours early in summer while Mars2
   converts local→UTC twice, `docs/mars2/admin-recon.md` §8). Do not
   compensate for that on our side; the fix belongs in Mars2. Only change
   `FEED_SOLAX_TIMEZONE` if Solax Cloud's convention changes, and verify by
   comparing a `CustomDataExport` row of SOLAXBIOS and of a feed plant with
   their true sample times on the same day.
   `FEED_SOLAX_POWER_UNIT=kW` if values are 1000× too large,
   `FEED_SOLAX_EMPTY=zero|omit` if nothing is read at all.
   Contract: `docs/mars2/feed-contract.md`; admin model:
   `docs/mars2/admin-recon.md`.
   **The dashboard shows Mars2 and only Mars2**: `PREDICTION_STATIONS`
   lists `OS2BIOS,SOLAXBIOS,SOKO46,SOKOBAZEN,VETINST` and the prediction
   service ingests all of them from `CustomDataExport`; the FusionSolar and
   SolisCloud collectors keep running because the feed Mars2 polls is built
   from their rows, but their `HUAWEI:…`/`SOLIS:…` sources are not listed to
   the dashboard (`DASHBOARD_VENDOR_SOURCES=true` on the prediction service
   lists them again).
4. **Zabbix** (DevOps): web scenario on `https://bios-multilevel.barrage.net/health`
   expecting HTTP 200 and the string `"healthy": true`, and on
   `/prediction/freshness` expecting `"ok": true`; 1-minute interval, alert
   after 3 failures. This is the second, independent availability measurement.

### Reading state quickly

```sh
kubectl --context=production.zag -n bios-multilevel-production get pods -o wide
kubectl --context=production.zag -n bios-multilevel-databases get pods -o wide
curl -s https://bios-multilevel.barrage.net/monitor | jq '.healthy, .problems, .lease, .database'
curl -s https://bios-multilevel.barrage.net/prediction/freshness | jq '.lastCycle, .db, .leader, .sources'
curl -s 'https://bios-multilevel.barrage.net/monitor/slo?days=30' | jq '.overall, .components'
```

PostgreSQL from inside the pod (no local psql user mapping; TLS required):

```sh
kubectl --context=production.zag -n bios-multilevel-databases exec bios-multilevel-postgres-prod-postgresql-0 -c postgresql -- \
  bash -c 'export PGPASSWORD=$(cat "$POSTGRES_PASSWORD_FILE"); /opt/bitnami/postgresql/bin/psql "host=127.0.0.1 user=postgres dbname=postgres sslmode=require" -c "select now()"'
```

Never background `psql` inside that container: an orphaned client is
reparented to postmaster (PID 1) and killing it with SIGTERM is treated as a
backend crash (crash recovery, ~30 s outage — happened 2026-10-31).

## Incident procedures (all used in Nov 2026)

### PostgreSQL CrashLoopBackOff with `Read-only file system`

Symptom: pod restarts every minute, log shows `rm: cannot remove
'/bitnami/postgresql/data/postmaster.pid': Read-only file system`. Cause: a
Longhorn replica failed and the kernel remounted the ext4 volume read-only
inside the pod; container restarts cannot fix a mount.

1. Check the volume: `kubectl -n longhorn-system get volumes.longhorn.io <pvc-...> -o yaml`
   (`state: attached`, `robustness: healthy`, replicas `running`).
2. Snapshot first:
   `kubectl apply -f` a `longhorn.io/v1beta2 Snapshot` with `spec.volume: <pvc-...>`, `createSnapshot: true`.
3. `kubectl -n bios-multilevel-databases delete pod bios-multilevel-postgres-prod-postgresql-0`
   — the StatefulSet recreates it, Longhorn reattaches read-write, Postgres
   replays WAL (seconds). Nothing else to do.
4. Prediction and the other services reconnect on their own. Mars2 data
   refills itself (72 h re-pull); Huawei/Solis live readings for the outage
   window are lost.

### PostgreSQL CrashLoop with Longhorn volume `faulted` / `detached`

Symptom: Postgres logs `Input/output error` / CrashLoop; Slack
`database.down`; Longhorn volume
`pvc-d9743216-49aa-4042-a43e-259238f3e18f` shows `state: detached`,
`robustness: faulted`, replicas `stopped` with `failedAt` set. Pod delete
alone will not help — the volume will not attach until a replica is salvaged.

1. Confirm: `kubectl --context=production.zag -n longhorn-system get volumes.longhorn.io pvc-d9743216-49aa-4042-a43e-259238f3e18f`
   and `… get replicas.longhorn.io -l longhornvolume=pvc-d9743216-…`.
2. Scale the StatefulSet to 0 so the volume can detach fully:
   `kubectl --context=production.zag -n bios-multilevel-databases scale sts bios-multilevel-postgres-prod-postgresql --replicas=0`.
3. Clear `failedAt` on the best replica and request salvage (helper:
   `partner-export/_pg_do_salvage.sh`), or in the Longhorn UI: Salvage the
   replica that still has data on disk.
4. Scale STS back to 1; wait until volume is `attached` and Postgres
   `pg_isready`. Expect `robustness: degraded` until a second replica rebuilds.
5. If a rebuild replica stays `stopped` with `rebuildRetryCount` climbing,
   check whether the cluster is jammed: Longhorn manager logs
   `reaches or exceeds the concurrent limit value 2`. Raise
   `concurrent-replica-rebuild-per-node-limit` temporarily (e.g. to 10),
   delete our non-running replica, wait for healthy, then restore the limit
   (`partner-export/_pg_longhorn_clear_rebuild_jam.sh`). Soft anti-affinity
   helpers: `_pg_longhorn_ha.sh delete-stopped`,
   `_pg_longhorn_rebuild_other_node.sh`.
6. Target: `numberOfReplicas: 3` and `robustness: healthy` with three
   `running` replicas on distinct nodes.
7. Early warning: CronJob `longhorn-watch` in `bios-multilevel-databases`
   (`deploy/longhorn-watch/`) posts Slack on `longhorn.degraded` /
   `longhorn.faulted` before the dashboard’s `database.down`.

### Prediction on the JSON store / OOM loop

No longer possible: with `DATABASE_URL` set the service waits for PostgreSQL
(`/freshness` shows `db.ok=false`, `store: "postgres"`, `initialized: false`)
instead of falling back. If `/freshness` ever shows `store: "json"` in
production, `DATABASE_URL` is missing from the deployment.

### Kyverno blocks deploys (`mutate.kyverno.svc-fail ... connection refused`)

The admission controller loses its leader lease whenever etcd stalls and
exits; with `failurePolicy: Fail` every Deployment update then fails. Current
state: both resource webhooks are `Ignore` and the admission controller runs
with `--forceFailurePolicyIgnore=true` (set 2026-11-01 by patching the
deployment arg index 16). A Kyverno Helm upgrade will revert this unless the
chart sets `features.forceFailurePolicyIgnore.enabled=true`. Check:

```sh
kubectl get mutatingwebhookconfiguration kyverno-resource-mutating-webhook-cfg -o jsonpath='{.webhooks[0].failurePolicy}'
```

### Registry pull failures (`401`, `ImagePullBackOff`) outside a pipeline

Until the deploy token exists (above), a rescheduled pod cannot pull. Do not
delete running pods while this is the case; old ReplicaSets keep serving.
Restart a Node service *in place* instead (same node, cached image):

```sh
# Node is PID 1 without signal handlers (prediction now handles SIGTERM, the
# others do not). Use the inspector hook: SIGUSR1 starts it, then evaluate exit.
kubectl -n bios-multilevel-production exec <pod> -- sh -c 'kill -USR1 1; sleep 2; node -e "
(async()=>{const l=await (await fetch(\"http://127.0.0.1:9229/json\")).json();const ws=new WebSocket(l[0].webSocketDebuggerUrl);
ws.onopen=()=>ws.send(JSON.stringify({id:1,method:\"Runtime.evaluate\",params:{expression:\"setTimeout(()=>process.exit(0),300);1\"}}));
setTimeout(()=>process.exit(0),4000);})()"'
```

### Slow queries on `raw_measurements`

Every series read must be an index-only scan on the covering primary key
`(source, metric, ts) INCLUDE (value, is_missing)`. If
`EXPLAIN (ANALYZE, BUFFERS)` shows a Bitmap Heap Scan with thousands of heap
blocks, the key is not covering any more (check
`pg_index.indnatts > indnkeyatts` for `raw_measurements_pkey`). Rebuild online:

```sql
CREATE UNIQUE INDEX CONCURRENTLY raw_measurements_pkey_covering
  ON raw_measurements (source, metric, ts) INCLUDE (value, is_missing);
SET lock_timeout = '5s';
ALTER TABLE raw_measurements DROP CONSTRAINT raw_measurements_pkey,
  ADD CONSTRAINT raw_measurements_pkey PRIMARY KEY USING INDEX raw_measurements_pkey_covering;
ANALYZE raw_measurements; VACUUM raw_measurements;
```

Run it from a pod labelled `bios-multilevel-postgres-prod-postgresql-client=true`
in the database namespace (the NetworkPolicy admits nothing else), on a node
other than n09.

### Mars2 admin UI from a workstation

`web.mars2.barrage.net:81` is reachable only from the cluster network. Bridge:

```sh
kubectl -n bios-multilevel-production apply -f <forwarder pod: node:22-alpine running an HTTP forwarder to web.mars2.barrage.net:81 with Host/Location rewriting>
kubectl -n bios-multilevel-production port-forward pod/mars2-jump 8081:8089
# browser: http://localhost:8081/Account/Login
```

Delete the forwarder pod when done.

## Asks for DevOps (cluster-level, outside this repository)

1. **Longhorn (still open after 2026-11-17)**: Postgres volume
   `pvc-d9743216-49aa-4042-a43e-259238f3e18f` must stay at **3 replicas**
   and `robustness: healthy`. Recurring backups still fail with
   MinIO timeouts (`dial tcp … minio.production.barrage.net:443: i/o timeout`)
   and earlier `failed to acquire lock backupstore/.../lock-*.lck` (last good
   backup ~2026-11-10; RPO is days). Fix reachability to the backup bucket and
   clear stale locks so nightly jobs complete; retain ≥2 usable backups. Watch
   free space on n04 Longhorn disk (~99 Gi free of ~393 Gi as of the 11-17
   incident).
   Default StorageClass / volume template should default to ≥3 replicas for
   database PVCs. n03 rebuilds for this volume have been flaky (replica
   `desireState=running` but never gets an instance-manager process).
2. **etcd**: `etcdserver: leader changed` several times an hour; kube-apiserver
   pods have ~1000 restarts each; Kyverno admission controller restarted 1775
   times in one week; 4 of 5 deploy pipelines on 2026-11-08 failed mid-way.
3. **n09**: containerd hangs (`CreateContainerError`, sandbox name reserved,
   `context deadline exceeded`) and flaky pod networking to other nodes.
4. **Zabbix web scenario** on the public host (see "One-time setup").
5. **PostgreSQL tuning** (chart values, needs a restart): `shared_buffers`
   128 MB and `effective_cache_size` 4 GB on a 2 Gi container; 512 MB and
   1 GB respectively would fit the 1 GB table on network storage better.

## History

- 2026-10-24 → 10-31: prediction cycle wedged for a week; dashboard served
  week-old data; root cause missing indexes on artifact tables and unbounded
  queries. Fixed; Slack monitor added.
- 2026-11-01: Kyverno webhooks set to Ignore; dashboard deployed with Slack.
- 2026-11-07 → 11-08: Longhorn replica failure → read-only volume → 29 h
  PostgreSQL outage; prediction JSON fallback OOM loop; fixed as above.
- 2026-11-08: covering primary key on `raw_measurements` (44 s → 8 ms reads),
  stats without table scans, feed API for Mars2, two replicas per public
  service, SLO evidence, external probe.
- 2026-11-17: same SPOF — sole usable Longhorn replica on n04 failed
  (`failedAt` 21:44 UTC) → volume faulted/detached → Postgres I/O CrashLoop.
  Salvaged replica, STS restart; volume returned `attached/degraded`. Hardening:
  rebuild + `numberOfReplicas: 3`, `deploy/longhorn-watch` CronJob, runbook
  salvage section. DevOps backup-lock ask still open from 11-07.
