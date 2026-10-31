// Data-flow health monitor with Slack notifications.
//
// The dashboard is the component that observes the whole platform, so it is
// where "the app is not working / not showing data" is decided. Every check it
// reads the prediction service's /freshness (cycle alive? PostgreSQL answers?
// how old is the newest measurement per station?) and the blockchain /health,
// derives a set of problems, and notifies Slack only on transitions:
//
//   * a problem set appears or changes  -> alert digest
//   * every problem clears              -> recovery message
//   * problems persist                  -> reminder every `repeatMinutes`
//
// Evaluation (`evaluateProblems`) and the transition (`step`) are pure so they
// can be unit tested; `main.ts` wires them to fetch, a timer and the webhook.

export interface MonitorThresholds {
  /** Consecutive failed checks before an upstream counts as unreachable. */
  upstreamFailures: number;
  /** Minutes without a completed prediction cycle before alerting. */
  cycleStaleMinutes: number;
  /** Minutes without a new measurement (meteo stations) before alerting. */
  dataStaleMinutes: number;
  /** Same for solar sources, whose loggers legitimately pause overnight. */
  dataStaleMinutesSolar: number;
  /** Minutes between reminders while the same problems persist. */
  repeatMinutes: number;
  /** Suppress notifications this long after the dashboard starts. */
  startupGraceMs: number;
}

export const DEFAULT_THRESHOLDS: Readonly<MonitorThresholds> = {
  upstreamFailures: 3,
  cycleStaleMinutes: 45,
  dataStaleMinutes: 90,
  dataStaleMinutesSolar: 720,
  repeatMinutes: 240,
  startupGraceMs: 120_000,
};

export function thresholdsFromEnv(get: (name: string) => string | undefined): MonitorThresholds {
  const num = (name: string, fallback: number, min: number): number => {
    const value = Number(get(name));
    return Number.isFinite(value) && value >= min ? value : fallback;
  };
  return {
    upstreamFailures: num("ALERT_UPSTREAM_FAILURES", DEFAULT_THRESHOLDS.upstreamFailures, 1),
    cycleStaleMinutes: num("ALERT_CYCLE_STALE_MINUTES", DEFAULT_THRESHOLDS.cycleStaleMinutes, 5),
    dataStaleMinutes: num("ALERT_DATA_STALE_MINUTES", DEFAULT_THRESHOLDS.dataStaleMinutes, 5),
    dataStaleMinutesSolar: num("ALERT_DATA_STALE_MINUTES_SOLAR", DEFAULT_THRESHOLDS.dataStaleMinutesSolar, 5),
    repeatMinutes: num("ALERT_REPEAT_MINUTES", DEFAULT_THRESHOLDS.repeatMinutes, 15),
    startupGraceMs: num("ALERT_STARTUP_GRACE_SECONDS", DEFAULT_THRESHOLDS.startupGraceMs / 1000, 0) * 1000,
  };
}

/** Shape of GET /freshness on the prediction service (fields we read). */
export interface FreshnessSource {
  source: string;
  solar?: boolean;
  latestTs?: string | null;
  ageMinutes?: number | null;
}

export interface FreshnessPayload {
  ok?: boolean;
  lifecycle?: string;
  running?: boolean;
  cycleStartedAt?: string | null;
  processStartedAt?: string | null;
  intervalMinutes?: number;
  cycleHealth?: { ok: boolean; reason?: string | null; cycleRunningMinutes?: number | null; deadlineMinutes?: number };
  lastCycle?: {
    status?: string;
    finishedAt?: string | null;
    okTargets?: number;
    totalTargets?: number;
    error?: string | null;
  } | null;
  db?: { ok: boolean; error?: string; latencyMs?: number };
  sources?: FreshnessSource[];
  sourcesError?: string | null;
}

export type UpstreamResult<T> = { ok: true; body: T } | { ok: false; error: string };

export interface CheckInput {
  now: number;
  prediction: UpstreamResult<FreshnessPayload>;
  blockchain: UpstreamResult<unknown>;
}

export interface Problem {
  /** Stable identity used for change detection (text may vary per check). */
  key: string;
  text: string;
}

export interface MonitorState {
  startedAt: number;
  predictionFailures: number;
  blockchainFailures: number;
  active: Problem[];
  problemsSince: number | null;
  lastNotifiedAt: number | null;
  lastCheckAt: number | null;
  notifications: number;
}

export function initialState(now: number): MonitorState {
  return {
    startedAt: now,
    predictionFailures: 0,
    blockchainFailures: 0,
    active: [],
    problemsSince: null,
    lastNotifiedAt: null,
    lastCheckAt: null,
    notifications: 0,
  };
}

export interface MessageContext {
  envLabel: string;
  dashboardUrl?: string;
}

export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function iso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(".000Z", "Z") : "unknown";
}

export interface Evaluation {
  problems: Problem[];
  predictionFailures: number;
  blockchainFailures: number;
}

export function evaluateProblems(input: CheckInput, state: MonitorState, t: MonitorThresholds): Evaluation {
  const problems: Problem[] = [];
  const now = input.now;
  let predictionFailures = state.predictionFailures;
  let blockchainFailures = state.blockchainFailures;

  if (!input.prediction.ok) {
    predictionFailures += 1;
    if (predictionFailures >= t.upstreamFailures) {
      problems.push({
        key: "prediction.unreachable",
        text: `Prediction service unreachable (${predictionFailures} consecutive checks): ${input.prediction.error}`,
      });
    }
  } else {
    predictionFailures = 0;
    const body = input.prediction.body;

    if (body.db && body.db.ok === false) {
      problems.push({
        key: "prediction.db",
        text: `Prediction service cannot reach PostgreSQL${body.db.error ? `: ${body.db.error}` : ""}`,
      });
    }

    if (body.cycleHealth && body.cycleHealth.ok === false) {
      problems.push({
        key: "prediction.cycle.wedged",
        text: `Prediction cycle has been running for ${body.cycleHealth.cycleRunningMinutes ?? "?"} min (deadline ${body.cycleHealth.deadlineMinutes ?? "?"} min) — the pod's liveness probe will restart it`,
      });
    }

    const finished = body.lastCycle?.finishedAt ? Date.parse(body.lastCycle.finishedAt) : NaN;
    const staleMs = t.cycleStaleMinutes * 60_000;
    if (!Number.isFinite(finished)) {
      const started = body.processStartedAt ? Date.parse(body.processStartedAt) : NaN;
      const sinceStart = Number.isFinite(started) ? now - started : Number.POSITIVE_INFINITY;
      if (sinceStart > staleMs) {
        problems.push({
          key: "prediction.cycle.stale",
          text: `No prediction cycle has completed since the service started ${Number.isFinite(sinceStart) ? `${formatAge(sinceStart)} ago` : "(start time unknown)"}`,
        });
      }
    } else if (now - finished > staleMs) {
      problems.push({
        key: "prediction.cycle.stale",
        text: `No completed prediction cycle for ${formatAge(now - finished)} (last finished ${iso(finished)}; interval ${body.intervalMinutes ?? "?"} min)`,
      });
    }

    const status = body.lastCycle?.status;
    if (status && status !== "ready") {
      const ok = body.lastCycle?.okTargets ?? 0;
      const total = body.lastCycle?.totalTargets ?? 0;
      problems.push({
        key: "prediction.cycle.failed",
        text: `Last prediction cycle (${iso(finished)}) ended "${status}": ${ok}/${total} targets ok${body.lastCycle?.error ? ` — ${body.lastCycle.error}` : ""}`,
      });
    }

    if (body.sourcesError) {
      problems.push({ key: "prediction.sources", text: `Could not read measurement freshness: ${body.sourcesError}` });
    }

    for (const source of body.sources || []) {
      if (!source?.source) continue;
      const limit = source.solar ? t.dataStaleMinutesSolar : t.dataStaleMinutes;
      if (source.latestTs == null || source.ageMinutes == null) {
        problems.push({ key: `data.stale:${source.source}`, text: `${source.source}: no measurements stored at all` });
      } else if (source.ageMinutes > limit) {
        problems.push({
          key: `data.stale:${source.source}`,
          text: `${source.source}: no new measurements for ${formatAge(source.ageMinutes * 60_000)} (latest ${source.latestTs}; limit ${limit} min)`,
        });
      }
    }
  }

  if (!input.blockchain.ok) {
    blockchainFailures += 1;
    if (blockchainFailures >= t.upstreamFailures) {
      problems.push({
        key: "blockchain.unreachable",
        text: `Blockchain service unreachable (${blockchainFailures} consecutive checks): ${input.blockchain.error}`,
      });
    }
  } else {
    blockchainFailures = 0;
  }

  return { problems, predictionFailures, blockchainFailures };
}

export type Action =
  | { kind: "none" }
  | { kind: "alert"; text: string }
  | { kind: "reminder"; text: string }
  | { kind: "recovered"; text: string };

function keysOf(problems: Problem[]): string {
  return problems.map((p) => p.key).sort().join("|");
}

function footer(ctx: MessageContext): string {
  return ctx.dashboardUrl ? `\nDashboard: ${ctx.dashboardUrl}` : "";
}

export function formatProblems(
  problems: Problem[],
  previous: Problem[],
  ctx: MessageContext,
  kind: "alert" | "reminder",
  now: number,
  problemsSince: number | null,
): string {
  const previousKeys = new Set(previous.map((p) => p.key));
  const currentKeys = new Set(problems.map((p) => p.key));
  const resolved = previous.filter((p) => !currentKeys.has(p.key));
  const count = problems.length;
  const noun = count === 1 ? "problem" : "problems";
  const header = kind === "reminder"
    ? `:warning: *BIOS Multi-level — still failing for ${formatAge(now - (problemsSince ?? now))}* (${ctx.envLabel})`
    : previous.length > 0
    ? `:red_circle: *BIOS Multi-level — update: ${count} ${noun}* (${ctx.envLabel})`
    : `:red_circle: *BIOS Multi-level — ${count} ${noun} detected* (${ctx.envLabel})`;
  const lines = problems.map((p) => `• ${previousKeys.has(p.key) || kind === "reminder" ? "" : "*new* "}${p.text}`);
  const resolvedLine = resolved.length ? `\n_Resolved since last alert: ${resolved.map((p) => p.key).join(", ")}_` : "";
  return `${header}\n${lines.join("\n")}${resolvedLine}${footer(ctx)}`;
}

export function formatRecovery(previous: Problem[], ctx: MessageContext, now: number, problemsSince: number | null, input: CheckInput): string {
  const duration = problemsSince ? ` after ${formatAge(now - problemsSince)}` : "";
  const was = previous.length ? `\nWas: ${previous.map((p) => p.key).join(", ")}` : "";
  let latest = "";
  if (input.prediction.ok && Array.isArray(input.prediction.body.sources) && input.prediction.body.sources.length) {
    const parts = input.prediction.body.sources
      .filter((s) => s?.source)
      .map((s) => `${s.source} ${s.ageMinutes == null ? "no data" : `${formatAge(s.ageMinutes * 60_000)} ago`}`);
    latest = `\nLatest data: ${parts.join(" · ")}`;
  }
  return `:large_green_circle: *BIOS Multi-level — recovered${duration}* (${ctx.envLabel})\nAll checks passing again.${was}${latest}${footer(ctx)}`;
}

export function formatStartup(ctx: MessageContext, t: MonitorThresholds, checkSeconds: number): string {
  return `:information_source: *BIOS Multi-level dashboard started* (${ctx.envLabel}) — Slack alerting active. ` +
    `Checks every ${checkSeconds}s; alert when: upstream down ${t.upstreamFailures} checks in a row, ` +
    `no prediction cycle for ${t.cycleStaleMinutes} min, no new data for ${t.dataStaleMinutes} min (solar ${t.dataStaleMinutesSolar} min); ` +
    `reminders every ${Math.round(t.repeatMinutes / 60)}h while unresolved.${footer(ctx)}`;
}

export function step(
  state: MonitorState,
  input: CheckInput,
  t: MonitorThresholds,
  ctx: MessageContext,
): { state: MonitorState; action: Action } {
  const { problems, predictionFailures, blockchainFailures } = evaluateProblems(input, state, t);
  const now = input.now;
  const inGrace = now - state.startedAt < t.startupGraceMs;

  if (inGrace) {
    // Count failures so a dead upstream trips immediately after the grace
    // period, but do not treat anything seen now as "already known".
    return {
      state: { ...state, predictionFailures, blockchainFailures, lastCheckAt: now },
      action: { kind: "none" },
    };
  }

  let action: Action = { kind: "none" };
  let lastNotifiedAt = state.lastNotifiedAt;
  let notifications = state.notifications;
  let problemsSince = state.problemsSince;

  if (problems.length > 0 && problemsSince === null) problemsSince = now;

  if (problems.length > 0 && keysOf(problems) !== keysOf(state.active)) {
    action = { kind: "alert", text: formatProblems(problems, state.active, ctx, "alert", now, problemsSince) };
  } else if (problems.length === 0 && state.active.length > 0) {
    action = { kind: "recovered", text: formatRecovery(state.active, ctx, now, problemsSince, input) };
  } else if (problems.length > 0 && lastNotifiedAt !== null && now - lastNotifiedAt >= t.repeatMinutes * 60_000) {
    action = { kind: "reminder", text: formatProblems(problems, state.active, ctx, "reminder", now, problemsSince) };
  }

  if (action.kind !== "none") {
    lastNotifiedAt = now;
    notifications += 1;
  }
  if (problems.length === 0) problemsSince = null;

  return {
    state: {
      ...state,
      predictionFailures,
      blockchainFailures,
      active: problems,
      problemsSince,
      lastNotifiedAt,
      lastCheckAt: now,
      notifications,
    },
    action,
  };
}

/** Post a plain-text (mrkdwn) message to a Slack incoming webhook. Never throws. */
export async function postSlack(
  webhookUrl: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 120);
      return { ok: false, error: `HTTP ${res.status}${detail ? ` ${detail}` : ""}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
