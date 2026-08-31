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
  };
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
