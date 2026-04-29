const dashboardHtml = await Deno.readTextFile(new URL("./index.html", import.meta.url));
const encoder = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const latest = new Map<string, unknown>();
const stableSignatures = new Map<string, string>();

/** Set `DASHBOARD_ACCESS_LOG=false` to disable per-request lines in container logs. */
const accessLogEnabled = Deno.env.get("DASHBOARD_ACCESS_LOG") !== "false";

function logLine(level: "info" | "warn" | "error", msg: string): void {
  const line = `${new Date().toISOString()} dashboard — ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function isFetchErrorPayload(value: unknown): value is { error: string } {
  return Boolean(
    value && typeof value === "object" && "error" in value && typeof (value as { error: string }).error === "string",
  );
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function serviceUrl(kind: "prediction" | "blockchain"): string | undefined {
  const key = kind === "prediction" ? "PREDICTION_SERVICE_URL" : "BLOCKCHAIN_SERVICE_URL";
  return Deno.env.get(key);
}

function sseMessage(type: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function send(controller: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown): void {
  controller.enqueue(sseMessage(type, data));
}

function broadcast(type: string, data: unknown): void {
  latest.set(type, data);
  for (const client of clients) {
    try {
      send(client, type, data);
    } catch {
      clients.delete(client);
    }
  }
}

// Used only for the slow safety re-sync path (missed events / process restart).
const VOLATILE_KEYS = new Set([
  "checkedAt",
  "lastPollAt",
  "receivedAt",
  "lastReadAt",
]);

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(key)) continue;
      out[key] = stableClone(val);
    }
    return out;
  }
  return value;
}

function stableSignature(payload: unknown): string {
  return JSON.stringify(stableClone(payload));
}

function broadcastIfChanged(type: string, data: { payload?: unknown }): void {
  const sig = stableSignature(data?.payload);
  if (stableSignatures.get(type) === sig) {
    latest.set(type, data);
    return;
  }
  stableSignatures.set(type, sig);
  broadcast(type, data);
}

function upstreamTimeoutMs(kind: "prediction" | "blockchain", path: string): number {
  if (kind === "blockchain" && /^\/(?:chain\/|feeless\/)/.test(path)) {
    return Number(Deno.env.get("DASHBOARD_UPSTREAM_BLOCKCHAIN_MS") || "120000");
  }
  return Number(Deno.env.get("DASHBOARD_UPSTREAM_MS") || "20000");
}

async function fetchService(kind: "prediction" | "blockchain", path: string): Promise<unknown> {
  const base = serviceUrl(kind);
  if (!base) return { error: `${kind} service is not configured` };
  const url = `${base.replace(/\/$/, "")}${path}`;
  const ms = upstreamTimeoutMs(kind, path);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return { error: `${kind} ${path}: HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `${kind} ${path}: ${msg}` };
  }
}

let pollInFlight = false;

/** One-shot full snapshot for recovery / 60s safety. Uses dedup. */
async function safetySync(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const tasks: Array<[string, Promise<unknown>]> = [
      ["prediction.status", fetchService("prediction", "/status")],
      ["prediction.sla", fetchService("prediction", "/sla?window=24h")],
      ["prediction.forecast", fetchService("prediction", "/forecasts/latest")],
      ["prediction.data_quality", fetchService("prediction", "/data-quality/latest")],
      ["prediction.anomaly", fetchService("prediction", "/anomalies?limit=5")],
      ["blockchain.status", fetchService("blockchain", "/status")],
      ["blockchain.event", fetchService("blockchain", "/events?status=confirmed&limit=100")],
      ["blockchain.tx", fetchService("blockchain", "/chain/transactions?limit=100")],
      ["blockchain.block", fetchService("blockchain", "/chain/blocks?limit=10")],
      ["blockchain.chain_status", fetchService("blockchain", "/chain/status")],
      ["blockchain.feeless", fetchService("blockchain", "/feeless/status")],
      ["blockchain.decode", fetchService("blockchain", "/events/latest")],
    ];
    const settled = await Promise.allSettled(tasks.map(([, task]) => task));
    const issues: string[] = [];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      const type = tasks[index][0];
      if (result.status === "rejected") {
        issues.push(`${type}: ${(result.reason as Error)?.message || String(result.reason)}`);
        continue;
      }
      let payload: unknown = result.value;
      if (isFetchErrorPayload(payload)) {
        issues.push(`${type}: ${payload.error}`);
        continue;
      }
      if (type === "blockchain.decode" && payload && typeof payload === "object" && "payloadHex" in payload) {
        payload = await fetchService(
          "blockchain",
          `/decode?payload=${encodeURIComponent(String((payload as { payloadHex?: string }).payloadHex || ""))}`,
        );
        if (isFetchErrorPayload(payload)) {
          issues.push(`${type}: ${payload.error}`);
          continue;
        }
      }
      const data: { type: string; receivedAt: string; payload: unknown } = {
        type,
        receivedAt: new Date().toISOString(),
        payload: type === "blockchain.decode" ? payload : result.value,
      };
      broadcastIfChanged(type, data);
    }
    if (issues.length) {
      logLine("warn", `safetySync: ${issues.slice(0, 6).join("; ")}${issues.length > 6 ? "…" : ""}`);
    } else {
      logLine("info", "safetySync: ok");
    }
  } catch (e) {
    logLine("error", `safetySync: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    pollInFlight = false;
  }
}

function startDashboardTick(): void {
  setInterval(() => {
    broadcast("dashboard.tick", {
      type: "dashboard.tick",
      receivedAt: new Date().toISOString(),
    });
  }, 1000);
}

function startSafetySync(): void {
  const sec = Math.max(30, Number(Deno.env.get("DASHBOARD_SAFETY_SYNC_SECONDS") || 60));
  safetySync().catch((e) => logLine("error", `initial safetySync: ${e?.message || e}`));
  setInterval(() => {
    void safetySync();
  }, sec * 1000);
}

/** Parse a single HTTP SSE `event:` + `data:` block (one message). */
function parseSseDataBlock(text: string): { event: string; data: string } | null {
  let ev = "message";
  const dataLines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("event:")) ev = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event: ev, data: dataLines.join("\n") };
}

async function forwardPredictionStream(): Promise<void> {
  const base = serviceUrl("prediction");
  if (!base) {
    logLine("warn", "PREDICTION_SERVICE_URL not set; prediction upstream SSE disabled");
    return;
  }
  const url = `${base.replace(/\/$/, "")}/stream`;
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      attempt = 0;
      const body = res.body;
      if (!body) throw new Error("no response body");
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed");
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() || "";
        for (const c of chunks) {
          if (!c || c.startsWith(":")) continue;
          const parsed = parseSseDataBlock(c);
          if (!parsed) continue;
          if (parsed.event === "connected") continue;
          let jsonBody: unknown;
          try {
            jsonBody = JSON.parse(parsed.data);
          } catch {
            continue;
          }
          const receivedAt = new Date().toISOString();
          if (parsed.event === "raw_measurements") {
            broadcast("tab.refresh", { type: "tab.refresh", view: "measurements", reason: "raw", receivedAt, payload: jsonBody });
            continue;
          }
          if (parsed.event === "forecast" && jsonBody && typeof jsonBody === "object" && "artifact" in jsonBody) {
            const art = (jsonBody as { artifact: unknown }).artifact;
            broadcast("prediction.forecast", { type: "prediction.forecast", receivedAt, payload: art });
            continue;
          }
          if (parsed.event === "data_quality" && jsonBody && typeof jsonBody === "object" && "artifact" in jsonBody) {
            broadcast("prediction.data_quality", { type: "prediction.data_quality", receivedAt, payload: (jsonBody as { artifact: unknown }).artifact });
            continue;
          }
          if (parsed.event === "anomaly_list" && jsonBody) {
            broadcast("prediction.anomaly", { type: "prediction.anomaly", receivedAt, payload: jsonBody });
            continue;
          }
          if (parsed.event === "status" && jsonBody) {
            broadcast("prediction.status", { type: "prediction.status", receivedAt, payload: jsonBody });
            continue;
          }
          if (parsed.event === "sla" && jsonBody) {
            broadcast("prediction.sla", { type: "prediction.sla", receivedAt, payload: jsonBody });
            continue;
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5));
      logLine("warn", `prediction /stream: ${msg}; reconnect in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function forwardBlockchainStream(): Promise<void> {
  const base = serviceUrl("blockchain");
  if (!base) {
    logLine("warn", "BLOCKCHAIN_SERVICE_URL not set; blockchain upstream SSE disabled");
    return;
  }
  const url = `${base.replace(/\/$/, "")}/stream`;
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      attempt = 0;
      const body = res.body;
      if (!body) throw new Error("no response body");
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed");
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() || "";
        for (const c of chunks) {
          if (!c || c.startsWith(":")) continue;
          const parsed = parseSseDataBlock(c);
          if (!parsed) continue;
          if (parsed.event === "connected") continue;
          let jsonBody: unknown;
          try {
            jsonBody = JSON.parse(parsed.data);
          } catch {
            continue;
          }
          const receivedAt = new Date().toISOString();
          if (parsed.event === "event" && jsonBody) {
            broadcast("blockchain.event", { type: "blockchain.event", receivedAt, payload: jsonBody });
            continue;
          }
          if (parsed.event === "tx" && jsonBody) {
            broadcast("blockchain.tx", { type: "blockchain.tx", receivedAt, payload: jsonBody });
            continue;
          }
          if (parsed.event === "block" && jsonBody) {
            broadcast("blockchain.block", { type: "blockchain.block", receivedAt, payload: jsonBody });
            continue;
          }
          if (parsed.event === "chain_status" && jsonBody) {
            broadcast("blockchain.chain_status", { type: "blockchain.chain_status", receivedAt, payload: jsonBody });
            continue;
          }
          if (parsed.event === "status" && jsonBody) {
            broadcast("blockchain.status", { type: "blockchain.status", receivedAt, payload: jsonBody });
            continue;
          }
          if (parsed.event === "feeless" && jsonBody) {
            broadcast("blockchain.feeless", { type: "blockchain.feeless", receivedAt, payload: jsonBody });
            continue;
          }
          if (parsed.event === "events_latest" && jsonBody) {
            broadcast("blockchain.event", { type: "blockchain.event", receivedAt, payload: { data: [jsonBody] } });
            if (typeof jsonBody === "object" && jsonBody && "payloadHex" in jsonBody) {
              const hex = String((jsonBody as { payloadHex?: string }).payloadHex || "");
              if (hex) {
                const dec = await fetchService("blockchain", `/decode?payload=${encodeURIComponent(hex)}`);
                if (dec && !isFetchErrorPayload(dec)) {
                  broadcast("blockchain.decode", { type: "blockchain.decode", receivedAt, payload: dec });
                }
              }
            }
            continue;
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5));
      logLine("warn", `blockchain /stream: ${msg}; reconnect in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function sseResponse(): Response {
  let currentController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      currentController = controller;
      clients.add(controller);
      send(controller, "dashboard.connected", {
        connectedAt: new Date().toISOString(),
        cachedEvents: latest.size,
      });
      for (const [type, data] of latest.entries()) send(controller, type, data);
    },
    cancel() {
      if (currentController) clients.delete(currentController);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders,
    },
  });
}

async function proxy(req: Request, kind: "prediction" | "blockchain", prefix: string): Promise<Response> {
  const base = serviceUrl(kind);
  if (!base) {
    return json({
      error: `${kind} service is not configured`,
      expectedEnv: kind === "prediction" ? "PREDICTION_SERVICE_URL" : "BLOCKCHAIN_SERVICE_URL",
    }, 502);
  }

  const url = new URL(req.url);
  const upstream = new URL(url.pathname.slice(prefix.length) || "/", base);
  upstream.search = url.search;

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  try {
    const res = await fetch(upstream, {
      method: req.method,
      headers: req.headers,
      body,
    });

    const headers = new Headers(res.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine("error", `proxy ${kind} ${upstream.origin}${upstream.pathname}${upstream.search}: ${msg}`);
    return json({ error: "upstream unreachable", upstream: `${upstream.origin}${upstream.pathname}`, detail: msg }, 502);
  }
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(dashboardHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (url.pathname === "/events") {
    return sseResponse();
  }

  if (url.pathname.startsWith("/prediction")) {
    return proxy(req, "prediction", "/prediction");
  }

  if (url.pathname.startsWith("/blockchain")) {
    return proxy(req, "blockchain", "/blockchain");
  }

  if (url.pathname === "/health") {
    return json({
      ok: true,
      service: "bios-multilevel-platform-services-dashboard",
      predictionConfigured: Boolean(serviceUrl("prediction")),
      blockchainConfigured: Boolean(serviceUrl("blockchain")),
    });
  }

  return json({ error: "not found" }, 404);
}

Deno.serve(async (req: Request) => {
  const start = performance.now();
  const path = new URL(req.url).pathname;
  try {
    const res = await handleRequest(req);
    if (accessLogEnabled) {
      logLine("info", `${req.method} ${path} -> ${res.status} ${Math.round(performance.now() - start)}ms`);
    }
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine("error", `${req.method} ${path} -> unhandled: ${msg}`);
    throw err;
  }
});

{
  const pred = Boolean(serviceUrl("prediction"));
  const bc = Boolean(serviceUrl("blockchain"));
  const tGeneral = upstreamTimeoutMs("prediction", "/status");
  const tBc = upstreamTimeoutMs("blockchain", "/chain/status");
  logLine(
    "info",
    `ready: prediction=${pred ? "set" : "missing"} blockchain=${bc ? "set" : "missing"} accessLog=${accessLogEnabled} fetchTimeout=${tGeneral}ms blockchainRpc=${tBc}ms upstreamSse=enabled`,
  );
}
startDashboardTick();
startSafetySync();
void forwardPredictionStream();
void forwardBlockchainStream();
