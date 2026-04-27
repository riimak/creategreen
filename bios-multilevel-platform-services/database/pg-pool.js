// Shared PostgreSQL pool factory with TLS support.
// Reads DATABASE_URL for connection string and optionally:
//   - DATABASE_CA_CERT or DATABASE_CA_FILE for CA certificate (verify-ca)
//   - DATABASE_SSL=true/false to force SSL on/off
//   - ?sslmode=require in the URL (standard libpq)
//
// If TLS is auto-generated (Bitnami), use sslmode=require (no CA needed)
// or mount the CA cert and set DATABASE_CA_FILE=/path/to/ca.crt for verify-ca.

const { Pool } = require('pg');
const fs = require('fs');

function createPool(databaseUrl, opts = {}) {
  const poolConfig = {
    connectionString: databaseUrl,
    max: opts.max || 5,
  };

  // Determine SSL config
  const caFile = process.env.DATABASE_CA_FILE;
  const caCert = process.env.DATABASE_CA_CERT; // inline PEM
  const sslEnv = process.env.DATABASE_SSL;

  if (caFile && fs.existsSync(caFile)) {
    poolConfig.ssl = {
      rejectUnauthorized: true,
      ca: fs.readFileSync(caFile, 'utf8'),
    };
  } else if (caCert) {
    poolConfig.ssl = {
      rejectUnauthorized: true,
      ca: caCert,
    };
  } else if (databaseUrl.includes('sslmode=require') || databaseUrl.includes('sslmode=prefer')) {
    poolConfig.ssl = { rejectUnauthorized: false };
  } else if (sslEnv === 'true' || sslEnv === '1') {
    poolConfig.ssl = { rejectUnauthorized: false };
  }

  return new Pool(poolConfig);
}

module.exports = { createPool };
