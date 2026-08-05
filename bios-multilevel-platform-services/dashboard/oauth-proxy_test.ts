import { proxyFusionSolarOAuth } from "./oauth-proxy.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      message ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const PUBLIC_URL = "https://bios-multilevel.barrage.net";
const SERVICE_BASE = "http://fusionsolar:8093";

Deno.test("forwards an allowlisted path with its complete query and manual redirects", async () => {
  let fetchedUrl = "";
  let fetchedInit: RequestInit | undefined;
  const response = await proxyFusionSolarOAuth(
    new Request(
      `${PUBLIC_URL}/oauth/fusionsolar/start?setup_token=a%2Bb&setup_token=second&empty=`,
    ),
    SERVICE_BASE,
    (input, init) => {
      fetchedUrl = String(input);
      fetchedInit = init;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://oauth2.fusionsolar.huawei.com/authorize",
            "cache-control": "no-store",
          },
        }),
      );
    },
  );

  assertEquals(
    fetchedUrl,
    `${SERVICE_BASE}/oauth/fusionsolar/start?setup_token=a%2Bb&setup_token=second&empty=`,
  );
  assertEquals(fetchedInit?.method, "GET");
  assertEquals(fetchedInit?.redirect, "manual");
  assertEquals(response.status, 302);
  assertEquals(
    response.headers.get("location"),
    "https://oauth2.fusionsolar.huawei.com/authorize",
  );
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("rejects every non-GET request before fetch", async () => {
  let fetched = false;
  const response = await proxyFusionSolarOAuth(
    new Request(`${PUBLIC_URL}/oauth/fusionsolar/start`, { method: "POST" }),
    SERVICE_BASE,
    () => {
      fetched = true;
      return Promise.resolve(new Response());
    },
  );

  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "GET");
  assertEquals(fetched, false);
});

Deno.test("rejects paths outside the exact two-route allowlist before fetch", async () => {
  for (
    const path of [
      "/oauth/fusionsolar",
      "/oauth/fusionsolar/start/",
      "/oauth/fusionsolar/callback/extra",
      "/oauth/fusionsolar/start%2Fextra",
    ]
  ) {
    let fetched = false;
    const response = await proxyFusionSolarOAuth(
      new Request(`${PUBLIC_URL}${path}`),
      SERVICE_BASE,
      () => {
        fetched = true;
        return Promise.resolve(new Response());
      },
    );

    assertEquals(response.status, 404, path);
    assertEquals(fetched, false, path);
  }
});

Deno.test("forwards only the three explicitly allowed request headers", async () => {
  let forwarded = new Headers();
  await proxyFusionSolarOAuth(
    new Request(`${PUBLIC_URL}/oauth/fusionsolar/callback?code=secret`, {
      headers: {
        accept: "text/html",
        "user-agent": "browser",
        "x-request-id": "request-7",
        authorization: "Bearer secret",
        cookie: "session=secret",
        forwarded: "for=attacker",
        "x-forwarded-host": "attacker.example",
        host: "attacker.example",
        referer: "https://attacker.example/",
        "x-extra": "not-allowed",
      },
    }),
    SERVICE_BASE,
    (_input, init) => {
      forwarded = new Headers(init?.headers);
      return Promise.resolve(new Response());
    },
  );

  assertEquals(forwarded.get("accept"), "text/html");
  assertEquals(forwarded.get("user-agent"), "browser");
  assertEquals(forwarded.get("x-request-id"), "request-7");
  assertEquals(
    [...forwarded.keys()].sort().join(","),
    "accept,user-agent,x-request-id",
  );
});

Deno.test("copies only safe response headers and applies dashboard security headers", async () => {
  const response = await proxyFusionSolarOAuth(
    new Request(`${PUBLIC_URL}/oauth/fusionsolar/callback`),
    SERVICE_BASE,
    () =>
      Promise.resolve(
        new Response("ok", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "cache-control": "private, no-store",
            server: "internal-server",
            "x-powered-by": "secret-runtime",
            "access-control-allow-origin": "*",
            "x-internal-host": "fusionsolar:8093",
            "set-cookie": "upstream=secret",
          },
        }),
      ),
  );

  assertEquals(await response.text(), "ok");
  assertEquals(response.headers.get("content-type"), "text/plain");
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(response.headers.get("server"), null);
  assertEquals(response.headers.get("x-powered-by"), null);
  assertEquals(response.headers.get("access-control-allow-origin"), null);
  assertEquals(response.headers.get("x-internal-host"), null);
  assertEquals(response.headers.get("set-cookie"), null);
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(response.headers.get("x-frame-options"), "DENY");
  assert(response.headers.has("content-security-policy"));
});

Deno.test("drops a Location that exposes the internal service", async () => {
  const response = await proxyFusionSolarOAuth(
    new Request(`${PUBLIC_URL}/oauth/fusionsolar/start`),
    SERVICE_BASE,
    () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `${SERVICE_BASE}/internal?token=secret` },
        }),
      ),
  );

  assertEquals(response.status, 302);
  assertEquals(response.headers.get("location"), null);
});

Deno.test("preserves a safe root-relative Location on the public origin", async () => {
  const response = await proxyFusionSolarOAuth(
    new Request(`${PUBLIC_URL}/oauth/fusionsolar/callback`),
    SERVICE_BASE,
    () =>
      Promise.resolve(
        new Response(null, {
          status: 303,
          headers: { location: "/?fusionsolar=connected" },
        }),
      ),
  );

  assertEquals(response.status, 303);
  assertEquals(response.headers.get("location"), "/?fusionsolar=connected");
});

Deno.test("returns a generic secured 502 when fetch fails", async () => {
  const response = await proxyFusionSolarOAuth(
    new Request(`${PUBLIC_URL}/oauth/fusionsolar/callback?code=secret`),
    SERVICE_BASE,
    () =>
      Promise.reject(
        new Error(
          `failed ${SERVICE_BASE}/oauth/fusionsolar/callback?code=secret`,
        ),
      ),
  );

  assertEquals(response.status, 502);
  assertEquals(response.headers.get("content-type"), "application/json");
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(
    await response.text(),
    JSON.stringify({ error: "upstream unreachable" }),
  );
});
