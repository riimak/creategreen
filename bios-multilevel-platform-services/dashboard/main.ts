const dashboardHtml = await Deno.readTextFile(new URL("./index.html", import.meta.url));

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
