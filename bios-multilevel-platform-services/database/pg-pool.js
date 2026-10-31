// Shared PostgreSQL pool factory with TLS support.
// Reads DATABASE_URL and optionally:
//   - DATABASE_CA_CERT or DATABASE_CA_FILE (PEM) for server verification
//   - DATABASE_SSL=true to force TLS without CA (rejectUnauthorized: false)
//
// node-pg / pg-connection-string (v8+) can treat sslmode=require like verify-full, which
// breaks clusters that use a private CA or self-signed server cert (unless the exact
// chain is in DATABASE_CA_FILE). We strip sslmode from the URL and set ssl.* ourselves
// so "require" matches libpq: encrypted transport, no peer verification, unless a CA
// is provided (then verify the chain).

const { Pool } = require('pg');
const fs = require('fs');

function stripParam(dsn, name) {
  let s = dsn.replace(new RegExp(`[?&]${name}=[^&]*`, 'gi'), '');
  s = s.replace(/\?&/g, '?');
  s = s.replace(/\?$/, '');
  return s;
}

function sslmodeFromUrl(dsn) {
  const m = dsn.match(/[?&]sslmode=([^&]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

function createPool(databaseUrl, opts = {}) {
  if (!databaseUrl) {
    throw new Error('createPool: databaseUrl is required');
  }

  const caFile = process.env.DATABASE_CA_FILE;
  const caCert = process.env.DATABASE_CA_CERT;
  const sslEnv = process.env.DATABASE_SSL;
  const fromUrl = sslmodeFromUrl(databaseUrl);
  const hasCaFile = caFile && fs.existsSync(caFile);
  const wantsTls =
    sslEnv === 'true'
    || sslEnv === '1'
    || (fromUrl && fromUrl !== 'disable');

  let cleanUrl = databaseUrl;
  let ssl = undefined;

  if (fromUrl && ['verify-full', 'verify-ca'].includes(fromUrl) && !hasCaFile && !caCert) {
    throw new Error(
      'DATABASE_URL uses sslmode=verify-full|verify-ca but DATABASE_CA_FILE is missing or the path is wrong. Add the server CA (bios-pg-ca secret) or use sslmode=require for TLS without verifying the cert.',
    );
  }

  if (hasCaFile) {
    const ca = fs.readFileSync(caFile, 'utf8');
    ssl = { rejectUnauthorized: true, ca };
    cleanUrl = stripParam(cleanUrl, 'sslmode');
  } else if (caCert) {
    ssl = { rejectUnauthorized: true, ca: caCert };
    cleanUrl = stripParam(cleanUrl, 'sslmode');
  } else if (wantsTls) {
    // Encrypted connection without CA pinning (libpq "require"/"prefer" behaviour for
    // self-signed or unknown CAs in dev/internal clusters).
    ssl = { rejectUnauthorized: false };
    cleanUrl = stripParam(cleanUrl, 'sslmode');
  }

  const poolConfig = {
    connectionString: cleanUrl,
    max: opts.max || 5,
    // TCP keepalive so a connection whose peer vanished (DB crash recovery,
    // node failover, conntrack drop) is torn down by the kernel instead of
    // staying ESTABLISHED forever with a query parked on it.
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
  };
  // statement_timeout is a server-side cancel: a runaway scan releases the
  // connection instead of pinning a pool slot until the client gives up.
  // connectionTimeoutMillis fails fast when every slot is already busy,
  // instead of queueing the HTTP request forever.
  if (Number.isFinite(opts.statementTimeoutMs) && opts.statementTimeoutMs > 0) {
    poolConfig.statement_timeout = opts.statementTimeoutMs;
  }
  // query_timeout is the client-side counterpart: it rejects the promise and
  // destroys the client even when the server can no longer answer at all.
  // In production a backend that died mid-query left the prediction service
  // awaiting pool.query() indefinitely (stuck cycle, stuck meta cache) — a
  // server-side statement_timeout cannot fire on a backend that is gone.
  if (Number.isFinite(opts.queryTimeoutMs) && opts.queryTimeoutMs > 0) {
    poolConfig.query_timeout = opts.queryTimeoutMs;
  }
  if (Number.isFinite(opts.connectionTimeoutMs) && opts.connectionTimeoutMs > 0) {
    poolConfig.connectionTimeoutMillis = opts.connectionTimeoutMs;
  }
  if (ssl) poolConfig.ssl = ssl;

  const pool = new Pool(poolConfig);
  // The server can terminate idle clients (failover, restart, admin action).
  // Without a listener that surfaces as an unhandled 'error' event and kills
  // the whole process; log it and let the pool replace the connection.
  pool.on('error', (error) => {
    console.error('pg pool idle client error:', error?.message || error);
  });
  return pool;
}

module.exports = { createPool };
