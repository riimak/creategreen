// Direct PostgreSQL reachability probe for the health monitor: the equivalent
// of `pg_isready`, without a driver and without credentials.
//
// It opens a TCP connection, sends a protocol-3 StartupMessage and reads the
// server's first reply. An authentication request — or any error other than
// "cannot connect now" (e.g. a pg_hba rejection of this plaintext session) —
// proves the postmaster is up and accepting sessions. SQLSTATE 57P03 means it
// is starting up, shutting down or in crash recovery. A refused connection or
// silence means it is down. No password is ever sent and the socket is closed
// after the first reply.
//
// Exists because the production database crash-looped for 29 hours while every
// service in front of it could only report "no measurements".

export type DbProbeStatus =
  | "accepting"
  | "refused"
  | "timeout"
  | "not_accepting"
  | "too_many_connections"
  | "protocol";

export interface DbProbeResult {
  ok: boolean;
  status: DbProbeStatus;
  latencyMs: number;
  /** Human-readable; IPs and hostnames are redacted so it can go to Slack. */
  detail: string;
}

export interface DbTarget {
  hostname: string;
  port: number;
  user: string;
  database: string;
}

export function parseDatabaseUrl(url: string): DbTarget {
  const parsed = new URL(url);
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) throw new Error("DATABASE_URL must be a postgres:// URL");
  if (!parsed.hostname) throw new Error("DATABASE_URL has no host");
  const user = decodeURIComponent(parsed.username || "postgres");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "")) || user;
  return { hostname: parsed.hostname, port: Number(parsed.port) || 5432, user, database };
}

/** Protocol 3.0 StartupMessage: int32 length, int32 196608, key\0value\0 pairs, \0. */
export function startupMessage(user: string, database: string): Uint8Array {
  const params = new TextEncoder().encode(`user\0${user}\0database\0${database}\0\0`);
  const message = new Uint8Array(8 + params.length);
  const view = new DataView(message.buffer);
  view.setInt32(0, message.length);
  view.setInt32(4, 196608);
  message.set(params, 8);
  return message;
}

export interface ServerReply {
  /** Message type byte: "R" authentication request, "E" error, "N" notice, ... */
  type: string;
  /** SQLSTATE for "E"/"N" messages. */
  code?: string;
  message?: string;
}

/** Parse the first backend message (type byte + int32 length + body); null while incomplete. */
export function parseFirstMessage(bytes: Uint8Array): ServerReply | null {
  if (bytes.length < 5) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = String.fromCharCode(bytes[0]);
  const length = view.getInt32(1);
  if (length < 4) return { type, message: "malformed message length" };
  if (bytes.length < 1 + length) return null;
  if (type !== "E" && type !== "N") return { type };
  const fields: Record<string, string> = {};
  const decoder = new TextDecoder();
  const end = 1 + length;
  let i = 5;
  while (i < end) {
    const fieldType = bytes[i];
    if (fieldType === 0) break;
    let j = i + 1;
    while (j < end && bytes[j] !== 0) j++;
    fields[String.fromCharCode(fieldType)] = decoder.decode(bytes.subarray(i + 1, j));
    i = j + 1;
  }
  return { type, code: fields["C"], message: fields["M"] };
}

export function classifyReply(reply: ServerReply): Pick<DbProbeResult, "ok" | "status" | "detail"> {
  if (reply.type === "R") return { ok: true, status: "accepting", detail: "accepting connections" };
  if (reply.type === "E") {
    if (reply.code === "57P03") {
      return { ok: false, status: "not_accepting", detail: reply.message || "the database system is not accepting connections" };
    }
    if (reply.code === "53300") {
      return { ok: false, status: "too_many_connections", detail: reply.message || "too many connections" };
    }
    // pg_hba / authentication rejections prove the server is up (pg_isready semantics).
    return { ok: true, status: "accepting", detail: `accepting connections (${reply.code || "error"} before authentication)` };
  }
  return { ok: false, status: "protocol", detail: `unexpected reply type ${JSON.stringify(reply.type)}` };
}

export function redactAddresses(text: string): string {
  return text
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:net|com|local|svc|cluster)\b/gi, "<host>")
    .replace(/\(os error \d+\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

class ProbeTimeout extends Error {}

type Connect = (options: Deno.ConnectOptions) => Promise<Deno.Conn>;

/** Never throws: every failure mode is a result the monitor can count. */
export async function probePostgres(
  url: string,
  timeoutMs = 5_000,
  connect: Connect = (options) => Deno.connect(options),
): Promise<DbProbeResult> {
  const started = Date.now();
  const finish = (r: Pick<DbProbeResult, "ok" | "status" | "detail">): DbProbeResult => ({
    ...r,
    detail: redactAddresses(r.detail),
    latencyMs: Date.now() - started,
  });

  let target: DbTarget;
  try {
    target = parseDatabaseUrl(url);
  } catch (e) {
    return finish({ ok: false, status: "protocol", detail: `invalid DATABASE_URL: ${errorMessage(e)}` });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeout()), timeoutMs);
  });
  timeout.catch(() => {});
  // Every awaited operation is raced against the timeout; the losing promise
  // keeps running until the socket is closed below, so swallow its rejection.
  const race = <T>(p: Promise<T>): Promise<T> => {
    p.catch(() => {});
    return Promise.race([p, timeout]);
  };

  let conn: Deno.Conn | null = null;
  try {
    conn = await race(connect({ hostname: target.hostname, port: target.port, transport: "tcp" }));
    const payload = startupMessage(target.user, target.database);
    for (let offset = 0; offset < payload.length;) {
      offset += await race(conn.write(payload.subarray(offset)));
    }
    const buffer = new Uint8Array(8192);
    let received = new Uint8Array(0);
    for (;;) {
      const n = await race(conn.read(buffer));
      if (n === null) return finish({ ok: false, status: "protocol", detail: "connection closed before any reply" });
      const next = new Uint8Array(received.length + n);
      next.set(received);
      next.set(buffer.subarray(0, n), received.length);
      received = next;
      const reply = parseFirstMessage(received);
      if (reply) return finish(classifyReply(reply));
      if (received.length > 65_536) return finish({ ok: false, status: "protocol", detail: "oversized reply" });
    }
  } catch (e) {
    if (e instanceof ProbeTimeout) return finish({ ok: false, status: "timeout", detail: `no reply within ${timeoutMs} ms` });
    return finish({ ok: false, status: "refused", detail: describeConnectError(e) });
  } finally {
    clearTimeout(timer);
    try {
      conn?.close();
    } catch {
      // already closed
    }
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeConnectError(e: unknown): string {
  if (e instanceof Deno.errors.ConnectionRefused) return "connection refused";
  if (e instanceof Deno.errors.ConnectionReset) return "connection reset";
  if (e instanceof Deno.errors.NotFound) return "host not found";
  if (e instanceof Deno.errors.TimedOut) return "connection timed out";
  return errorMessage(e);
}
