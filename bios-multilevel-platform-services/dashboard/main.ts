const dashboardHtml = await Deno.readTextFile(new URL("./index.html", import.meta.url));
const encoder = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const latest = new Map<string, unknown>();
const stableSignatures = new Map<string, string>();

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

// Volatile fields the upstream services stamp every poll. Stripping them
// before dedup means we only re-broadcast when something substantive
// changes, instead of pulsing the whole UI every two seconds.
const VOLATILE_KEYS = new Set([
  "computedAt",
  "checkedAt",
  "lastPollAt",
  "receivedAt",
  "nextRunAt",
  "startedAt",
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
    // Update cached snapshot so freshly-connecting clients see the
    // current timestamps, but do not re-broadcast to existing ones.
    latest.set(type, data);
    return;
  }
  stableSignatures.set(type, sig);
  broadcast(type, data);
}

async function fetchService(kind: "prediction" | "blockchain", path: string): Promise<unknown> {
  const base = serviceUrl(kind);
  if (!base) return { error: `${kind} service is not configured` };
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`);
  if (!res.ok) return { error: `${kind} ${path}: HTTP ${res.status}` };
  return res.json();
}

let lastHeartbeatAt = 0;

async function pollServices(): Promise<void> {
  // Send a heartbeat at most every 15s. The previous code beat on every
  // poll cycle (2s), which made the live-stream label flicker constantly.
  const now = Date.now();
  if (now - lastHeartbeatAt >= 15_000) {
    lastHeartbeatAt = now;
    broadcast("dashboard.heartbeat", {
      type: "dashboard.heartbeat",
      receivedAt: new Date().toISOString(),
      clients: clients.size,
    });
  }

  const tasks: Array<[string, Promise<unknown>]> = [
    ["prediction.status", fetchService("prediction", "/status")],
    ["prediction.sla", fetchService("prediction", "/sla?window=24h")],
    ["prediction.forecast", fetchService("prediction", "/forecasts/latest")],
    ["prediction.data_quality", fetchService("prediction", "/data-quality/latest")],
    ["prediction.anomaly", fetchService("prediction", "/anomalies?limit=5")],
    ["blockchain.status", fetchService("blockchain", "/status")],
    ["blockchain.event", fetchService("blockchain", "/events?status=confirmed&limit=100")],
    // Pull a wider page so the ledger reflects real activity instead of
    // capping at 10. The dashboard surfaces total + recent slice itself.
    ["blockchain.tx", fetchService("blockchain", "/chain/transactions?limit=100")],
    ["blockchain.block", fetchService("blockchain", "/chain/blocks?limit=10")],
    ["blockchain.chain_status", fetchService("blockchain", "/chain/status")],
    ["blockchain.feeless", fetchService("blockchain", "/feeless/status")],
    ["blockchain.decode", fetchService("blockchain", "/events/latest")],
  ];

  const settled = await Promise.allSettled(tasks.map(([, task]) => task));
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    const type = tasks[index][0];
    let payload = result.status === "fulfilled" ? result.value : null;
    if (type === "blockchain.decode" && payload && typeof payload === "object" && "payloadHex" in payload) {
      payload = await fetchService("blockchain", `/decode?payload=${encodeURIComponent(String((payload as { payloadHex?: string }).payloadHex || ""))}`);
    }
    const data = result.status === "fulfilled"
      ? { type, receivedAt: new Date().toISOString(), payload: result.value }
      : { type, receivedAt: new Date().toISOString(), error: result.reason?.message || String(result.reason) };
    if (type === "blockchain.decode" && result.status === "fulfilled") (data as { payload?: unknown }).payload = payload;
    broadcastIfChanged(type, data);
  }
}

function startPolling(): void {
  const seconds = Number(Deno.env.get("DASHBOARD_EVENT_POLL_SECONDS") || 3);
  pollServices().catch((error) => broadcast("dashboard.error", { error: error.message }));
  setInterval(() => {
    pollServices().catch((error) => broadcast("dashboard.error", { error: error.message }));
  }, Math.max(1, seconds) * 1000);
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
  const res = await fetch(upstream, {
    method: req.method,
    headers: req.headers,
    body,
  });

  const headers = new Headers(res.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
  return new Response(res.body, { status: res.status, headers });
}

Deno.serve(async (req: Request) => {
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
});

startPolling();
