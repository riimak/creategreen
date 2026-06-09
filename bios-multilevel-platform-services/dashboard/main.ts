const dashboardHtml = await Deno.readTextFile(new URL("./index.html", import.meta.url));
const euVisibilityHtml = await safeReadHtml(new URL("./eu-visibility.html", import.meta.url));
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

async function safeReadHtml(url: URL): Promise<string | null> {
  try {
    return await Deno.readTextFile(url);
  } catch {
    return null;
  }
}

function isFetchErrorPayload(value: unknown): value is { error: string } {
  return Boolean(
    value && typeof value === "object" && "error" in value && typeof (value as { error: string }).error === "string",
  );
}

// ── Security headers ────────────────────────────────────────────────────────
//
// The dashboard, its API proxy and SSE endpoint are all served from one origin
// (https://bios-multilevel.barrage.net), so cross-origin access is intentionally
// not allowed. We do NOT emit Access-Control-Allow-Origin on API responses —
// browser same-origin policy is sufficient. OPTIONS preflights for unknown
// origins return 204 without permissive CORS headers, so a hostile page in a
// different origin cannot script the proxy from a victim's browser.

async function sha256Base64(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  let binary = "";
  const bytes = new Uint8Array(digest);
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function inlineScriptHashes(html: string): Promise<string[]> {
  const hashes: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    if (/\bsrc\s*=/.test(match[1])) continue;
    const hash = await sha256Base64(match[2]);
    hashes.push(`'sha256-${hash}'`);
  }
  return hashes;
}

const cspScriptHashes = [
  ...(await inlineScriptHashes(dashboardHtml)),
  ...(euVisibilityHtml ? await inlineScriptHashes(euVisibilityHtml) : []),
];

const cspImgSources = [
  "'self'",
  "data:",
  "blob:",
  // Partner logos in the header are hosted off-origin.
  "https://inkubator.hr",
  "https://*.inkubator.hr",
  "https://www.osijek.hr",
  "https://*.osijek.hr",
].join(" ");

const csp = [
  "default-src 'none'",
  // chart.js + chart-adapter come from jsdelivr; inline scripts are pinned by SHA-256 hash.
  `script-src 'self' https://cdn.jsdelivr.net ${cspScriptHashes.join(" ")}`,
  // Inline <style> blocks and many inline style="" attributes throughout the HTML
  // make 'unsafe-inline' for style-src practically required. Script-src remains strict.
  "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src ${cspImgSources}`,
  // Same-origin APIs + jsdelivr source maps (devtools/debug convenience).
  "connect-src 'self' https://cdn.jsdelivr.net",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

const securityHeaders: Record<string, string> = {
  "Content-Security-Policy": csp,
  // The barrage-prod ClusterIssuer terminates TLS at the ingress. HSTS is safe.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
};

function withSecurity(extra: Record<string, string> = {}): Record<string, string> {
  return { ...securityHeaders, ...extra };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: withSecurity({ "Content-Type": "application/json", ...extra }),
  });
}

function contentTypeForAsset(pathname: string): string {
  const lower = pathname.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

async function serveDashboardAsset(req: Request, pathname: string): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json({ error: "method not allowed" }, 405, { Allow: "GET, HEAD" });
  }

  const rel = pathname.slice("/assets/".length);
  if (!rel || rel.includes("..") || rel.includes("\\") || rel.startsWith("/")) {
    return json({ error: "not found" }, 404);
  }

  try {
    const file = await Deno.readFile(new URL(`./assets/${rel}`, import.meta.url));
    return new Response(req.method === "HEAD" ? null : file, {
      headers: withSecurity({
        "Content-Type": contentTypeForAsset(pathname),
        "Cache-Control": "public, max-age=86400",
      }),
    });
  } catch {
    return json({ error: "not found" }, 404);
  }
}

function serviceUrl(kind: "prediction" | "blockchain"): string | undefined {
  const key = kind === "prediction" ? "PREDICTION_SERVICE_URL" : "BLOCKCHAIN_SERVICE_URL";
  return Deno.env.get(key);
}

// ── Per-IP rate limiting (token bucket) ────────────────────────────────────
//
// Defaults: 240 req/min sustained with a 240-token burst per client IP. /health
// is exempt (kubelet liveness/readiness probes vary in source IP). SSE
// connection caps below limit long-lived /events sockets separately.
const RATE_LIMIT_BURST = Number(Deno.env.get("DASHBOARD_RATE_LIMIT_BURST") || 240);
const RATE_LIMIT_PER_MIN = Number(Deno.env.get("DASHBOARD_RATE_LIMIT_PER_MIN") || 240);
const RATE_LIMIT_REFILL_PER_MS = RATE_LIMIT_PER_MIN / 60_000;

interface Bucket {
  tokens: number;
  lastRefill: number;
}
const rateBuckets = new Map<string, Bucket>();

interface ConnInfoLike {
  remoteAddr?: { transport?: string; hostname?: string; port?: number };
}

function clientIp(req: Request, info?: ConnInfoLike): string {
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return info?.remoteAddr?.hostname || "unknown";
}

function consumeRateLimit(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_BURST, lastRefill: now };
    rateBuckets.set(ip, bucket);
  }
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(RATE_LIMIT_BURST, bucket.tokens + elapsed * RATE_LIMIT_REFILL_PER_MS);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) {
    const deficit = 1 - bucket.tokens;
    const retryAfterSec = Math.max(1, Math.ceil(deficit / RATE_LIMIT_REFILL_PER_MS / 1000));
    return { ok: false, retryAfterSec };
  }
  bucket.tokens -= 1;
  return { ok: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.lastRefill > 5 * 60_000) rateBuckets.delete(ip);
  }
}, 60_000);

// ── SSE concurrent-connection caps ─────────────────────────────────────────
const SSE_MAX_PER_IP = Number(Deno.env.get("DASHBOARD_SSE_MAX_PER_IP") || 5);
const SSE_MAX_GLOBAL = Number(Deno.env.get("DASHBOARD_SSE_MAX_GLOBAL") || 500);
const sseConnectionsByIp = new Map<string, number>();

function sseAcquire(ip: string): boolean {
  if (clients.size >= SSE_MAX_GLOBAL) return false;
  const cur = sseConnectionsByIp.get(ip) || 0;
  if (cur >= SSE_MAX_PER_IP) return false;
  sseConnectionsByIp.set(ip, cur + 1);
  return true;
}

function sseRelease(ip: string): void {
  const cur = sseConnectionsByIp.get(ip) || 0;
  if (cur <= 1) sseConnectionsByIp.delete(ip);
  else sseConnectionsByIp.set(ip, cur - 1);
}

// ── Proxy allowlists ───────────────────────────────────────────────────────
//
// The dashboard fronts internal-only services (prediction + blockchain) that
// have no ingress of their own. We expose ONLY the read endpoints the UI
// actually calls. POST /events on blockchain in particular is intentionally
// not reachable through the public proxy: the dashboard never writes to it,
// the blockchain worker pulls events from prediction internally, and a public
// write path here would let any caller broadcast Stealth transactions.
const PREDICTION_ALLOW_EXACT = new Set<string>([
  "/prediction",
  "/prediction/health",
  "/prediction/stats",
  "/prediction/status",
  "/prediction/models",
  "/prediction/forecast",
  "/prediction/forecasts",
  "/prediction/forecasts/latest",
  "/prediction/forecasts/page",
  "/prediction/anomalies",
  "/prediction/anomalies/page",
  "/prediction/data-quality",
  "/prediction/data-quality/latest",
  "/prediction/data-quality/page",
  "/prediction/sla",
  "/prediction/measurements",
  "/prediction/measurements/meta",
]);

const BLOCKCHAIN_ALLOW_EXACT = new Set<string>([
  "/blockchain",
  "/blockchain/health",
  "/blockchain/stats",
  "/blockchain/status",
  "/blockchain/events",
  "/blockchain/events/page",
  "/blockchain/events/latest",
  "/blockchain/decode",
  "/blockchain/chain/status",
  "/blockchain/chain/transactions",
  "/blockchain/chain/blocks",
  "/blockchain/feeless/status",
]);

function isProxyPathAllowed(kind: "prediction" | "blockchain", pathname: string): boolean {
  if (kind === "prediction") return PREDICTION_ALLOW_EXACT.has(pathname);
  if (BLOCKCHAIN_ALLOW_EXACT.has(pathname)) return true;
  // /blockchain/events/<id> and /blockchain/verify/<id> — exactly one path segment, no slashes.
  if (/^\/blockchain\/events\/[A-Za-z0-9_.:-]+$/.test(pathname)) return true;
  if (/^\/blockchain\/verify\/[A-Za-z0-9_.:-]+$/.test(pathname)) return true;
  return false;
}

// Headers we will NOT forward upstream. Hop-by-hop per RFC 7230 plus client
// auth, cookies and forwarded-for chains we don't want the upstream to trust.
const FORWARD_HEADER_BLOCKLIST = new Set<string>([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "authorization",
  "cookie",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
]);

function filteredUpstreamHeaders(req: Request): Headers {
  const out = new Headers();
  for (const [key, value] of req.headers) {
    if (FORWARD_HEADER_BLOCKLIST.has(key.toLowerCase())) continue;
    out.set(key, value);
  }
  return out;
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

function sseResponse(ip: string): Response {
  if (!sseAcquire(ip)) {
    return json({ error: "too many concurrent stream connections" }, 429, {
      "Retry-After": "30",
    });
  }
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
      sseRelease(ip);
    },
  });

  return new Response(stream, {
    headers: withSecurity({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    }),
  });
}

async function proxy(req: Request, kind: "prediction" | "blockchain", prefix: string): Promise<Response> {
  // Read-only proxy. Anything else is rejected before it reaches the upstream
  // so a public caller can never write to the cluster-internal services.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json({ error: "method not allowed" }, 405, { Allow: "GET, HEAD" });
  }

  const base = serviceUrl(kind);
  if (!base) {
    return json({ error: `${kind} service is not configured` }, 502);
  }

  const url = new URL(req.url);
  if (!isProxyPathAllowed(kind, url.pathname)) {
    return json({ error: "endpoint not available" }, 404);
  }

  const upstream = new URL(url.pathname.slice(prefix.length) || "/", base);
  upstream.search = url.search;

  try {
    const res = await fetch(upstream, {
      method: req.method,
      headers: filteredUpstreamHeaders(req),
    });

    // Copy upstream response headers but drop any CORS leakage from the
    // upstream and replace with our locked-down security headers. The
    // upstream's hostname/port must never be reflected to the client.
    const headers = new Headers();
    for (const [key, value] of res.headers) {
      const lower = key.toLowerCase();
      if (lower.startsWith("access-control-")) continue;
      if (lower === "server" || lower === "x-powered-by") continue;
      headers.set(key, value);
    }
    for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine("error", `proxy ${kind} ${upstream.origin}${upstream.pathname}${upstream.search}: ${msg}`);
    // Intentionally do NOT echo the internal upstream URL or raw error in the
    // response body — that leaked the cluster service hostname before.
    return json({ error: "upstream unreachable" }, 502);
  }
}

async function handleRequest(req: Request, ip: string): Promise<Response> {
  const url = new URL(req.url);

  // No permissive CORS. Same-origin requests don't need preflight; cross-origin
  // requests get a clean 204 with no Allow-* headers and the browser blocks them.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: withSecurity({ Allow: "GET, HEAD, OPTIONS" }) });
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(dashboardHtml, {
      headers: withSecurity({ "Content-Type": "text/html; charset=utf-8" }),
    });
  }

  if (url.pathname === "/eu-visibility.html") {
    if (!euVisibilityHtml) return new Response("EU visibility page not found", { status: 404 });
    return new Response(euVisibilityHtml, {
      headers: withSecurity({ "Content-Type": "text/html; charset=utf-8" }),
    });
  }

  if (url.pathname === "/eu-creategreen-sticker.png") {
    // Backward-compatible alias in case older HTML points to root-level file.
    return serveDashboardAsset(req, "/assets/eu-creategreen-sticker.png");
  }

  if (url.pathname.startsWith("/assets/")) {
    return serveDashboardAsset(req, url.pathname);
  }

  if (url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: withSecurity({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  }

  if (url.pathname === "/events") {
    if (req.method !== "GET") {
      return json({ error: "method not allowed" }, 405, { Allow: "GET" });
    }
    return sseResponse(ip);
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

function shouldRateLimit(pathname: string): boolean {
  // /health is hit by kubelet probes from a varying source IP; never throttle it.
  if (pathname === "/health") return false;
  return true;
}

Deno.serve(async (req: Request, info: ConnInfoLike) => {
  const start = performance.now();
  const path = new URL(req.url).pathname;
  const ip = clientIp(req, info);
  try {
    if (shouldRateLimit(path)) {
      const limit = consumeRateLimit(ip);
      if (!limit.ok) {
        if (accessLogEnabled) {
          logLine("warn", `rate-limit ${ip} ${req.method} ${path} -> 429 retry=${limit.retryAfterSec}s`);
        }
        return json({ error: "rate limit exceeded" }, 429, {
          "Retry-After": String(limit.retryAfterSec),
        });
      }
    }

    const res = await handleRequest(req, ip);
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
    `ready: prediction=${pred ? "set" : "missing"} blockchain=${bc ? "set" : "missing"} accessLog=${accessLogEnabled} fetchTimeout=${tGeneral}ms blockchainRpc=${tBc}ms upstreamSse=enabled rateLimit=${RATE_LIMIT_PER_MIN}/min sseMaxPerIp=${SSE_MAX_PER_IP} sseMaxGlobal=${SSE_MAX_GLOBAL} cspScriptHashes=${cspScriptHashes.length}`,
  );
}
startDashboardTick();
startSafetySync();
void forwardPredictionStream();
void forwardBlockchainStream();
