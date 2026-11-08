import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  classifyReply,
  parseDatabaseUrl,
  parseFirstMessage,
  probePostgres,
  redactAddresses,
  startupMessage,
} from "./db-probe.ts";

const enc = new TextEncoder();

function backendMessage(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, 4 + body.length);
  out.set(body, 5);
  return out;
}

function errorResponse(code: string, message: string): Uint8Array {
  return backendMessage("E", enc.encode(`SFATAL\0C${code}\0M${message}\0\0`));
}

/** AuthenticationSASL: int32 10 + mechanism list. */
function authSasl(): Uint8Array {
  const mech = enc.encode("SCRAM-SHA-256\0\0");
  const body = new Uint8Array(4 + mech.length);
  new DataView(body.buffer).setInt32(0, 10);
  body.set(mech, 4);
  return backendMessage("R", body);
}

/**
 * Minimal fake postmaster: reads the StartupMessage, hands it to `respond`,
 * writes whatever comes back and closes. `respond` returning null closes
 * without replying; returning "hang" leaves the socket open.
 */
async function withFakeServer(
  respond: (startup: Uint8Array) => Uint8Array | null | "hang",
  run: (url: string) => Promise<void>,
): Promise<void> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const hanging: Deno.Conn[] = [];
  const serving = (async () => {
    for await (const conn of listener) {
      const buf = new Uint8Array(1024);
      const n = await conn.read(buf);
      const reply = respond(buf.subarray(0, n ?? 0));
      if (reply === "hang") {
        hanging.push(conn);
        continue;
      }
      if (reply) await conn.write(reply);
      conn.close();
    }
  })().catch(() => {});
  try {
    await run(`postgres://monitor:secret@127.0.0.1:${port}/postgres?sslmode=require`);
  } finally {
    listener.close();
    for (const c of hanging) {
      try {
        c.close();
      } catch { /* closed by peer */ }
    }
    await serving;
  }
}

Deno.test("parseDatabaseUrl reads host, port, user and database and ignores sslmode", () => {
  const t = parseDatabaseUrl("postgresql://app%40prod:p%40ss@db.internal:6432/measurements?sslmode=require");
  assertEquals(t, { hostname: "db.internal", port: 6432, user: "app@prod", database: "measurements" });
  assertEquals(parseDatabaseUrl("postgres://u@h/").database, "u", "database defaults to the user, like libpq");
  assertEquals(parseDatabaseUrl("postgres://u@h/db").port, 5432);
});

Deno.test("startupMessage is a protocol-3 packet with user and database", () => {
  const m = startupMessage("alice", "db1");
  const view = new DataView(m.buffer);
  assertEquals(view.getInt32(0), m.length);
  assertEquals(view.getInt32(4), 196608);
  assertEquals(new TextDecoder().decode(m.subarray(8)), "user\0alice\0database\0db1\0\0");
});

Deno.test("parseFirstMessage handles partial, auth and error messages", () => {
  const err = errorResponse("57P03", "the database system is starting up");
  assertEquals(parseFirstMessage(err.subarray(0, 3)), null, "header incomplete");
  assertEquals(parseFirstMessage(err.subarray(0, err.length - 1)), null, "body incomplete");
  assertEquals(parseFirstMessage(err), { type: "E", code: "57P03", message: "the database system is starting up" });
  assertEquals(parseFirstMessage(authSasl()), { type: "R" });
});

Deno.test("classifyReply follows pg_isready semantics", () => {
  assertEquals(classifyReply({ type: "R" }).status, "accepting");
  assertEquals(classifyReply({ type: "E", code: "57P03", message: "shutting down" }), {
    ok: false,
    status: "not_accepting",
    detail: "shutting down",
  });
  assertEquals(classifyReply({ type: "E", code: "53300", message: "too many connections" }).status, "too_many_connections");
  const hba = classifyReply({ type: "E", code: "28000", message: 'no pg_hba.conf entry for host "10.1.2.3", SSL off' });
  assertEquals(hba.ok, true, "a pg_hba rejection still proves the server is up");
  assertEquals(classifyReply({ type: "Z" }).status, "protocol");
});

Deno.test("redactAddresses strips IPs, cluster hostnames and os error codes", () => {
  assertEquals(
    redactAddresses('no pg_hba.conf entry for host "10.233.57.249", user "x"'),
    'no pg_hba.conf entry for host "<ip>", user "x"',
  );
  assertEquals(redactAddresses("Connection refused (os error 111)"), "Connection refused");
  assertEquals(redactAddresses("dns error for bios-pg.bios-multilevel-databases.svc"), "dns error for <host>");
});

Deno.test("probe: an authentication request means PostgreSQL is accepting connections", async () => {
  const seen: { startup: Uint8Array | null } = { startup: null };
  await withFakeServer((startup) => {
    seen.startup = startup.slice();
    return authSasl();
  }, async (url) => {
    const r = await probePostgres(url, 2_000);
    assertEquals(r.ok, true);
    assertEquals(r.status, "accepting");
    assert(r.latencyMs >= 0);
  });
  assert(seen.startup, "server received a startup packet");
  assertEquals(new DataView(seen.startup.buffer, seen.startup.byteOffset).getInt32(4), 196608);
  assertStringIncludes(new TextDecoder().decode(seen.startup), "user\0monitor\0database\0postgres\0");
});

Deno.test("probe: 57P03 (starting up / recovery) is not accepting", async () => {
  await withFakeServer(() => errorResponse("57P03", "the database system is in recovery mode"), async (url) => {
    const r = await probePostgres(url, 2_000);
    assertEquals(r.ok, false);
    assertEquals(r.status, "not_accepting");
    assertEquals(r.detail, "the database system is in recovery mode");
  });
});

Deno.test("probe: a pg_hba rejection of the plaintext session still counts as up", async () => {
  await withFakeServer(
    () => errorResponse("28000", 'no pg_hba.conf entry for host "10.233.1.2", user "monitor", database "postgres", no encryption'),
    async (url) => {
      const r = await probePostgres(url, 2_000);
      assertEquals(r.ok, true);
      assertEquals(r.status, "accepting");
    },
  );
});

Deno.test("probe: a server that closes without replying is a protocol failure", async () => {
  await withFakeServer(() => null, async (url) => {
    const r = await probePostgres(url, 2_000);
    assertEquals(r.ok, false);
    assertEquals(r.status, "protocol");
    assertStringIncludes(r.detail, "closed before any reply");
  });
});

Deno.test("probe: silence times out", async () => {
  await withFakeServer(() => "hang", async (url) => {
    const r = await probePostgres(url, 300);
    assertEquals(r.ok, false);
    assertEquals(r.status, "timeout");
    assertStringIncludes(r.detail, "300 ms");
  });
});

Deno.test("probe: a closed port is refused (the crash-loop case)", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const r = await probePostgres(`postgres://u:p@127.0.0.1:${port}/db`, 2_000);
  assertEquals(r.ok, false);
  assertEquals(r.status, "refused");
  assertEquals(r.detail, "connection refused");
});

Deno.test("probe: an invalid URL never throws", async () => {
  const r = await probePostgres("mysql://nope", 500);
  assertEquals(r.ok, false);
  assertEquals(r.status, "protocol");
  assertStringIncludes(r.detail, "invalid DATABASE_URL");
});
