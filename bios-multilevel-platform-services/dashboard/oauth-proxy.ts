import { applyDashboardSecurityHeaders } from "./security-headers.ts";

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const ALLOWED_PATHS = new Set([
  "/oauth/fusionsolar/start",
  "/oauth/fusionsolar/callback",
]);

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "user-agent",
  "x-request-id",
] as const;

const COPIED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
] as const;

function jsonError(
  error: string,
  status: number,
  extra?: Record<string, string>,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
    ...extra,
  });
  applyDashboardSecurityHeaders(headers);
  return new Response(JSON.stringify({ error }), { status, headers });
}

function safeLocation(value: string | null, serviceBase: URL): string | null {
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;

  try {
    const parsed = new URL(value, serviceBase);
    if (parsed.origin === serviceBase.origin) return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function proxyFusionSolarOAuth(
  req: Request,
  serviceBase: string,
  fetchImpl: FetchImplementation = fetch,
): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError("method not allowed", 405, { Allow: "GET" });
  }

  const requestUrl = new URL(req.url);
  if (!ALLOWED_PATHS.has(requestUrl.pathname)) {
    return jsonError("endpoint not available", 404);
  }

  const base = new URL(serviceBase);
  const upstream = new URL(
    requestUrl.pathname,
    `${base.href.replace(/\/+$/, "")}/`,
  );
  upstream.search = requestUrl.search;

  const requestHeaders = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) requestHeaders.set(name, value);
  }

  try {
    const response = await fetchImpl(upstream, {
      method: "GET",
      headers: requestHeaders,
      redirect: "manual",
    });

    const responseHeaders = new Headers();
    for (const name of COPIED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    const location = safeLocation(response.headers.get("location"), base);
    if (location !== null) responseHeaders.set("Location", location);
    applyDashboardSecurityHeaders(responseHeaders);

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch {
    return jsonError("upstream unreachable", 502);
  }
}
