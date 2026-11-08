import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  type CheckInput,
  DEFAULT_THRESHOLDS,
  evaluateProblems,
  formatAge,
  formatStartup,
  type FreshnessPayload,
  initialState,
  type MonitorThresholds,
  postSlack,
  step,
  thresholdsFromEnv,
} from "./monitor.ts";

const T0 = Date.parse("2026-10-31T12:00:00Z");
const MIN = 60_000;
const ctx = { envLabel: "test", dashboardUrl: "https://bios.example" };
// Grace period off so transitions are observable from the first check.
const thresholds: MonitorThresholds = { ...DEFAULT_THRESHOLDS, startupGraceMs: 0 };

function healthy(now: number, overrides: Partial<FreshnessPayload> = {}): FreshnessPayload {
  return {
    ok: true,
    lifecycle: "ready",
    running: false,
    processStartedAt: new Date(now - 6 * 60 * MIN).toISOString(),
    intervalMinutes: 10,
    cycleHealth: { ok: true, reason: null, cycleRunningMinutes: null, deadlineMinutes: 30 },
    lastCycle: { status: "ready", finishedAt: new Date(now - 4 * MIN).toISOString(), okTargets: 23, totalTargets: 23 },
    db: { ok: true, latencyMs: 2 },
    sources: [
      { source: "OS2BIOS", solar: false, latestTs: new Date(now - 7 * MIN).toISOString(), ageMinutes: 7 },
      { source: "SOLAXBIOS", solar: true, latestTs: new Date(now - 180 * MIN).toISOString(), ageMinutes: 180 },
    ],
    ...overrides,
  };
}

function input(now: number, body: FreshnessPayload | null, blockchainOk = true): CheckInput {
  return {
    now,
    prediction: body ? { ok: true, body } : { ok: false, error: "prediction /freshness: connection refused" },
    blockchain: blockchainOk ? { ok: true, body: {} } : { ok: false, error: "blockchain /health: timeout" },
  };
}

Deno.test("healthy platform produces no problems", () => {
  const { problems } = evaluateProblems(input(T0, healthy(T0)), initialState(T0), thresholds);
  assertEquals(problems, []);
});

Deno.test("the Oct 24 failure mode is detected: wedged cycle, stale cycle, stale data", () => {
  const sevenDays = 7 * 24 * 60;
  const body = healthy(T0, {
    running: true,
    cycleStartedAt: new Date(T0 - sevenDays * MIN).toISOString(),
    cycleHealth: { ok: false, reason: "cycle_deadline_exceeded", cycleRunningMinutes: sevenDays, deadlineMinutes: 30 },
    lastCycle: { status: "ready", finishedAt: new Date(T0 - sevenDays * MIN).toISOString(), okTargets: 23, totalTargets: 23 },
    sources: [
      { source: "OS2BIOS", solar: false, latestTs: new Date(T0 - sevenDays * MIN).toISOString(), ageMinutes: sevenDays },
      { source: "SOLAXBIOS", solar: true, latestTs: new Date(T0 - sevenDays * MIN).toISOString(), ageMinutes: sevenDays },
    ],
  });
  const { problems } = evaluateProblems(input(T0, body), initialState(T0), thresholds);
  assertEquals(
    problems.map((p) => p.key).sort(),
    ["data.stale:OS2BIOS", "data.stale:SOLAXBIOS", "prediction.cycle.stale", "prediction.cycle.wedged"],
  );
  assertStringIncludes(problems.find((p) => p.key === "prediction.cycle.stale")!.text, "7d 0h");
});

Deno.test("solar sources use the longer staleness limit", () => {
  const body = healthy(T0, {
    sources: [
      { source: "OS2BIOS", solar: false, latestTs: new Date(T0 - 300 * MIN).toISOString(), ageMinutes: 300 },
      { source: "SOLAXBIOS", solar: true, latestTs: new Date(T0 - 600 * MIN).toISOString(), ageMinutes: 600 },
    ],
  });
  const { problems } = evaluateProblems(input(T0, body), initialState(T0), thresholds);
  assertEquals(problems.map((p) => p.key), ["data.stale:OS2BIOS"]);
});

Deno.test("normal Mars2 lag for the meteo station is not an alert", () => {
  // Production: OS2BIOS samples at :00/:20 and Mars2 serves them 1-2 h late,
  // so a 2.5 h old newest row is routine.
  const body = healthy(T0, {
    sources: [{ source: "OS2BIOS", solar: false, latestTs: new Date(T0 - 150 * MIN).toISOString(), ageMinutes: 150 }],
  });
  assertEquals(evaluateProblems(input(T0, body), initialState(T0), thresholds).problems, []);
});

Deno.test("a station with no rows at all is a problem", () => {
  const body = healthy(T0, { sources: [{ source: "OS1BIOS", solar: false, latestTs: null, ageMinutes: null }] });
  const { problems } = evaluateProblems(input(T0, body), initialState(T0), thresholds);
  assertEquals(problems.map((p) => p.key), ["data.stale:OS1BIOS"]);
  assertStringIncludes(problems[0].text, "no measurements stored");
});

Deno.test("a failed cycle is reported on its own; with PostgreSQL down it folds into the database problem", () => {
  const failed = {
    lastCycle: { status: "degraded", finishedAt: new Date(T0 - 2 * MIN).toISOString(), okTargets: 0, totalTargets: 23 },
  };
  const alone = evaluateProblems(input(T0, healthy(T0, failed)), initialState(T0), thresholds).problems;
  assertEquals(alone.map((p) => p.key), ["prediction.cycle.failed"]);
  assertStringIncludes(alone[0].text, "0/23 targets ok");

  const withDb = healthy(T0, { ...failed, db: { ok: false, error: "Query read timeout" } });
  const collapsed = evaluateProblems(input(T0, withDb), initialState(T0), thresholds).problems;
  assertEquals(collapsed.map((p) => p.key), ["prediction.db"]);
  assertStringIncludes(collapsed[0].text, "Query read timeout");
});

Deno.test("a freshly started prediction service is not stale until the limit passes", () => {
  const justStarted = healthy(T0, { lastCycle: null, processStartedAt: new Date(T0 - 5 * MIN).toISOString() });
  assertEquals(evaluateProblems(input(T0, justStarted), initialState(T0), thresholds).problems, []);
  const longAgo = healthy(T0, { lastCycle: null, processStartedAt: new Date(T0 - 60 * MIN).toISOString() });
  assertEquals(
    evaluateProblems(input(T0, longAgo), initialState(T0), thresholds).problems.map((p) => p.key),
    ["prediction.cycle.stale"],
  );
});

Deno.test("upstream outages need consecutive failures and clear on success", () => {
  let state = initialState(T0);
  for (let i = 1; i <= thresholds.upstreamFailures; i += 1) {
    const result = step(state, input(T0 + i * MIN, null, false), thresholds, ctx);
    state = result.state;
    if (i < thresholds.upstreamFailures) {
      assertEquals(result.action.kind, "none", `check ${i} must not alert yet`);
    } else {
      assertEquals(result.action.kind, "alert");
      assertEquals(state.active.map((p) => p.key).sort(), ["blockchain.unreachable", "prediction.unreachable"]);
      assertStringIncludes((result.action as { text: string }).text, "2 problems detected");
    }
  }
  const back = step(state, input(T0 + 10 * MIN, healthy(T0 + 10 * MIN)), thresholds, ctx);
  assertEquals(back.action.kind, "recovered");
  assertEquals(back.state.active, []);
  assertEquals(back.state.predictionFailures, 0);
  assertStringIncludes((back.action as { text: string }).text, "recovered after");
  assertStringIncludes((back.action as { text: string }).text, "OS2BIOS 7 min ago");
});

Deno.test("alerts fire on change, remind on the repeat interval, and stay quiet otherwise", () => {
  const stale = (now: number) =>
    healthy(now, {
      sources: [{ source: "OS2BIOS", solar: false, latestTs: new Date(now - 300 * MIN).toISOString(), ageMinutes: 300 }],
    });
  let state = initialState(T0);
  let result = step(state, input(T0, stale(T0)), thresholds, ctx);
  assertEquals(result.action.kind, "alert");
  assertStringIncludes((result.action as { text: string }).text, "*new* OS2BIOS");
  state = result.state;

  // Same problem, text changed (age grew) -> no new alert.
  result = step(state, input(T0 + 5 * MIN, stale(T0 + 5 * MIN)), thresholds, ctx);
  assertEquals(result.action.kind, "none");
  state = result.state;

  // Still failing past the repeat interval -> reminder with the duration.
  const later = T0 + (thresholds.repeatMinutes + 1) * MIN;
  result = step(state, input(later, stale(later)), thresholds, ctx);
  assertEquals(result.action.kind, "reminder");
  assertStringIncludes((result.action as { text: string }).text, "still failing for 4h 1m");
  state = result.state;

  // A second, different problem appears -> alert again, marking what is new.
  const withWedge = healthy(later + MIN, {
    cycleHealth: { ok: false, reason: "cycle_deadline_exceeded", cycleRunningMinutes: 45, deadlineMinutes: 30 },
    sources: stale(later + MIN).sources,
  });
  result = step(state, input(later + MIN, withWedge), thresholds, ctx);
  assertEquals(result.action.kind, "alert");
  assertStringIncludes((result.action as { text: string }).text, "update: 2 problems");
  assertStringIncludes((result.action as { text: string }).text, "*new* Prediction cycle has been running for 45 min");
  state = result.state;

  // Partial recovery (cycle restarted, data still stale) -> update listing what resolved.
  result = step(state, input(later + 2 * MIN, stale(later + 2 * MIN)), thresholds, ctx);
  assertEquals(result.action.kind, "alert");
  assertStringIncludes((result.action as { text: string }).text, "Resolved since last alert: prediction.cycle.wedged");
  assertEquals(result.state.notifications, 4);
});

Deno.test("nothing is posted during the startup grace period, but it fires right after", () => {
  const graced: MonitorThresholds = { ...thresholds, startupGraceMs: 2 * MIN };
  let state = initialState(T0);
  let result = step(state, input(T0 + MIN, null, false), graced, ctx);
  assertEquals(result.action.kind, "none");
  state = result.state;
  result = step(state, input(T0 + 1.5 * MIN, null, false), graced, ctx);
  assertEquals(result.action.kind, "none");
  state = result.state;
  // Third consecutive failure lands after the grace period -> alert immediately.
  result = step(state, input(T0 + 3 * MIN, null, false), graced, ctx);
  assertEquals(result.action.kind, "alert");
});

Deno.test("the Nov 7 flapping is gone: a sub-threshold prediction blip keeps the active problems", () => {
  // Production: prediction OOM-restarted every 20-40 min; each restart made
  // /freshness unreachable for 1-2 checks, which emptied the problem set and
  // produced a recovered + re-detected pair in Slack (100+ messages/night).
  const noRows = (now: number) =>
    healthy(now, { sources: [{ source: "OS2BIOS", solar: false, latestTs: null, ageMinutes: null }] });
  let state = initialState(T0);
  let result = step(state, input(T0, noRows(T0)), thresholds, ctx);
  assertEquals(result.action.kind, "alert");
  state = result.state;

  // Two failed checks (below upstreamFailures = 3): nothing changes, nothing is posted.
  result = step(state, input(T0 + MIN, null), thresholds, ctx);
  assertEquals(result.action.kind, "none");
  assertEquals(result.state.active.map((p) => p.key), ["data.stale:OS2BIOS"]);
  state = result.state;
  result = step(state, input(T0 + 2 * MIN, null), thresholds, ctx);
  assertEquals(result.action.kind, "none");
  state = result.state;

  // Service back with the same problem: still nothing to say.
  result = step(state, input(T0 + 3 * MIN, noRows(T0 + 3 * MIN)), thresholds, ctx);
  assertEquals(result.action.kind, "none");
  assertEquals(result.state.notifications, 1);
  state = result.state;

  // A real outage (third consecutive failure) replaces the carried problems.
  for (let i = 4; i <= 6; i += 1) {
    result = step(state, input(T0 + i * MIN, null), thresholds, ctx);
    state = result.state;
  }
  assertEquals(result.action.kind, "alert");
  assertEquals(state.active.map((p) => p.key), ["prediction.unreachable"]);
});

Deno.test("when prediction reports PostgreSQL down, dependent symptoms collapse into that one cause", () => {
  const body = healthy(T0, {
    db: { ok: false, store: "postgres", initialized: false, error: "connect ECONNREFUSED 10.233.57.249:5432" },
    lifecycle: "initializing",
    lastCycle: null,
    processStartedAt: new Date(T0 - 3 * 60 * MIN).toISOString(),
    sources: [],
    sourcesError: "store not initialized — PostgreSQL unavailable",
  });
  const { problems } = evaluateProblems(input(T0, body), initialState(T0), thresholds);
  assertEquals(problems.map((p) => p.key), ["prediction.db"]);
  assertStringIncludes(problems[0].text, "ECONNREFUSED");
});

Deno.test("running on the JSON store in production is a problem in itself", () => {
  const body = healthy(T0, { db: { ok: true, store: "json" } });
  const { problems } = evaluateProblems(input(T0, body), initialState(T0), thresholds);
  assertEquals(problems.map((p) => p.key), ["prediction.store"]);
  assertStringIncludes(problems[0].text, "not persisted");
});

Deno.test("the direct database probe names a dead PostgreSQL even while prediction is unreachable", () => {
  const down = { ok: false, status: "refused", detail: "connection refused", latencyMs: 1 };
  let state = initialState(T0);
  let result = { state, action: { kind: "none" } as { kind: string; text?: string } };
  for (let i = 1; i <= thresholds.upstreamFailures; i += 1) {
    result = step(state, { ...input(T0 + i * MIN, null), database: down }, thresholds, ctx);
    state = result.state;
  }
  // Prediction and database both crossed the threshold on the same check.
  assertEquals(result.action.kind, "alert");
  assertEquals(state.active.map((p) => p.key).sort(), ["database.down", "prediction.unreachable"]);
  assertStringIncludes(result.action.text!, "PostgreSQL is not accepting connections (3 consecutive checks): connection refused");
  assertEquals(state.databaseFailures, 3);

  // Database back (crash recovery finished) but prediction still restarting -> partial update.
  const up = { ok: true, status: "accepting", detail: "accepting connections", latencyMs: 2 };
  result = step(state, { ...input(T0 + 4 * MIN, null), database: up }, thresholds, ctx);
  assertEquals(result.action.kind, "alert");
  assertStringIncludes(result.action.text!, "Resolved since last alert: database.down");
  assertEquals(result.state.databaseFailures, 0);
  state = result.state;

  // Everything back -> recovery.
  result = step(state, { ...input(T0 + 5 * MIN, healthy(T0 + 5 * MIN)), database: up }, thresholds, ctx);
  assertEquals(result.action.kind, "recovered");
});

Deno.test("a single failed database probe is carried, not alerted", () => {
  const up = { ok: true, status: "accepting", latencyMs: 2 };
  const down = { ok: false, status: "timeout", detail: "no reply within 5000 ms", latencyMs: 5000 };
  let state = initialState(T0);
  state = step(state, { ...input(T0, healthy(T0)), database: up }, thresholds, ctx).state;
  const blip = step(state, { ...input(T0 + MIN, healthy(T0 + MIN)), database: down }, thresholds, ctx);
  assertEquals(blip.action.kind, "none");
  assertEquals(blip.state.active, []);
  assertEquals(blip.state.databaseFailures, 1);
  const back = step(blip.state, { ...input(T0 + 2 * MIN, healthy(T0 + 2 * MIN)), database: up }, thresholds, ctx);
  assertEquals(back.state.databaseFailures, 0);
  assertEquals(back.action.kind, "none");
});

Deno.test("Mars2 feed polling: off by default, silence and wrong credentials once enabled", () => {
  const feedOn: MonitorThresholds = { ...thresholds, feedSilentMinutes: 15 };
  const feed = (overrides: Record<string, unknown>) =>
    healthy(T0, { feed: { configured: true, plants: ["SOKO46BIOS", "VETINSTBIOS"], requestsTotal: 10, authFailures: 0, lastAuthFailureAt: null, ...overrides } });

  // Disabled: nothing, even when nobody ever polled.
  assertEquals(evaluateProblems(input(T0, feed({ lastRequestAt: null })), initialState(T0), thresholds).problems, []);

  // Enabled, recent poll: fine.
  assertEquals(evaluateProblems(input(T0, feed({ lastRequestAt: new Date(T0 - 4 * MIN).toISOString() })), initialState(T0), feedOn).problems, []);

  // Enabled, last poll too old.
  const silent = evaluateProblems(input(T0, feed({ lastRequestAt: new Date(T0 - 40 * MIN).toISOString() })), initialState(T0), feedOn).problems;
  assertEquals(silent.map((p) => p.key), ["mars2.poll.silent"]);
  assertStringIncludes(silent[0].text, "40 min");
  assertStringIncludes(silent[0].text, "SOKO46BIOS, VETINSTBIOS");

  // Enabled, never polled since a start long ago.
  const never = evaluateProblems(input(T0, feed({ lastRequestAt: null })), initialState(T0), feedOn).problems;
  assertEquals(never.map((p) => p.key), ["mars2.poll.silent"]);
  assertStringIncludes(never[0].text, "never polled");

  // Fresh start, never polled yet: not stale until the limit passes.
  const young = healthy(T0, { processStartedAt: new Date(T0 - 5 * MIN).toISOString(), feed: { configured: true, plants: ["SOKO46BIOS"], lastRequestAt: null } });
  assertEquals(evaluateProblems(input(T0, young), initialState(T0), feedOn).problems, []);

  // Rejected calls with no accepted ones: credentials problem on the Mars2 side.
  const wrongCreds = evaluateProblems(
    input(T0, feed({ lastRequestAt: new Date(T0 - 40 * MIN).toISOString(), authFailures: 7, lastAuthFailureAt: new Date(T0 - 2 * MIN).toISOString() })),
    initialState(T0), feedOn,
  ).problems;
  assertEquals(wrongCreds.map((p) => p.key).sort(), ["mars2.feed.auth", "mars2.poll.silent"]);

  // Not configured on our side: no polling expectation.
  assertEquals(evaluateProblems(input(T0, healthy(T0, { feed: { configured: false, plants: [] } })), initialState(T0), feedOn).problems, []);

  // Misconfiguration is reported regardless of the opt-in.
  const bad = evaluateProblems(input(T0, healthy(T0, { feed: { configured: false, plants: [], configError: 'FEED_PLANTS entry "x" must be CODE=SOURCE' } })), initialState(T0), thresholds).problems;
  assertEquals(bad.map((p) => p.key), ["mars2.feed.misconfigured"]);
});

Deno.test("startup message says whether PostgreSQL is probed directly", () => {
  assertStringIncludes(formatStartup(ctx, thresholds, 60, true), "PostgreSQL or an upstream down 3 checks");
  assertStringIncludes(formatStartup(ctx, thresholds, 60, false), "No DATABASE_URL");
});

Deno.test("formatAge is human readable", () => {
  assertEquals(formatAge(30_000), "<1 min");
  assertEquals(formatAge(7 * MIN), "7 min");
  assertEquals(formatAge(125 * MIN), "2h 5m");
  assertEquals(formatAge(50 * 60 * MIN), "2d 2h");
});

Deno.test("thresholds come from env with sane floors and defaults", () => {
  const env: Record<string, string> = {
    ALERT_UPSTREAM_FAILURES: "2",
    ALERT_CYCLE_STALE_MINUTES: "1", // below floor -> default
    ALERT_DATA_STALE_MINUTES: "120",
    ALERT_REPEAT_MINUTES: "60",
    ALERT_STARTUP_GRACE_SECONDS: "0",
  };
  const t = thresholdsFromEnv((k) => env[k]);
  assertEquals(t.upstreamFailures, 2);
  assertEquals(t.cycleStaleMinutes, DEFAULT_THRESHOLDS.cycleStaleMinutes);
  assertEquals(t.dataStaleMinutes, 120);
  assertEquals(t.dataStaleMinutesSolar, DEFAULT_THRESHOLDS.dataStaleMinutesSolar);
  assertEquals(t.repeatMinutes, 60);
  assertEquals(t.startupGraceMs, 0);
});

Deno.test("postSlack sends the webhook payload and never throws", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as typeof fetch;
  const ok = await postSlack("https://hooks.slack.com/services/T/B/x", "hello *there*", fakeFetch);
  assert(ok.ok);
  assertEquals(calls.length, 1);
  assertEquals(JSON.parse(calls[0].body), { text: "hello *there*" });

  const failing = (() => Promise.resolve(new Response("no_service", { status: 404 }))) as typeof fetch;
  const bad = await postSlack("https://hooks.slack.com/services/T/B/y", "x", failing);
  assertEquals(bad.ok, false);
  assertStringIncludes(bad.error!, "404");

  const throwing = (() => Promise.reject(new Error("dns failure"))) as typeof fetch;
  const err = await postSlack("https://hooks.slack.com/services/T/B/z", "x", throwing);
  assertEquals(err, { ok: false, error: "dns failure" });
});
