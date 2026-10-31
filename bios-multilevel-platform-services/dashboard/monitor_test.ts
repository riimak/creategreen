import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  type CheckInput,
  DEFAULT_THRESHOLDS,
  evaluateProblems,
  formatAge,
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

Deno.test("database and failed-cycle conditions are reported", () => {
  const body = healthy(T0, {
    db: { ok: false, error: "Query read timeout" },
    lastCycle: { status: "degraded", finishedAt: new Date(T0 - 2 * MIN).toISOString(), okTargets: 0, totalTargets: 23 },
  });
  const { problems } = evaluateProblems(input(T0, body), initialState(T0), thresholds);
  assertEquals(problems.map((p) => p.key).sort(), ["prediction.cycle.failed", "prediction.db"]);
  assertStringIncludes(problems.find((p) => p.key === "prediction.cycle.failed")!.text, "0/23 targets ok");
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
  const withDb = healthy(later + MIN, { db: { ok: false, error: "down" }, sources: stale(later + MIN).sources });
  result = step(state, input(later + MIN, withDb), thresholds, ctx);
  assertEquals(result.action.kind, "alert");
  assertStringIncludes((result.action as { text: string }).text, "update: 2 problems");
  assertStringIncludes((result.action as { text: string }).text, "*new* Prediction service cannot reach PostgreSQL");
  state = result.state;

  // Partial recovery (db back, data still stale) -> update listing what resolved.
  result = step(state, input(later + 2 * MIN, stale(later + 2 * MIN)), thresholds, ctx);
  assertEquals(result.action.kind, "alert");
  assertStringIncludes((result.action as { text: string }).text, "Resolved since last alert: prediction.db");
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
