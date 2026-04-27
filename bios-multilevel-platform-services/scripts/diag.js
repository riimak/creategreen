/* eslint-disable no-console */
/**
 * In-cluster diagnostic for the bios-multilevel platform.
 *
 * Designed to be run inside either the prediction or blockchain pod (Node 22 images),
 * or from any pod that has Node and network access to the platform Services.
 *
 *   kubectl -n bios-multilevel-production exec deploy/bios-prediction-production-barrage-autodeploy -- \
 *     node /app/scripts/diag.js
 *
 *   kubectl -n bios-multilevel-production exec deploy/bios-blockchain-production-barrage-autodeploy -- \
 *     node /app/scripts/diag.js
 *
 * Override service URLs by setting any of these env vars when invoking:
 *   PREDICTION_SELF_URL, BLOCKCHAIN_SELF_URL, DASHBOARD_URL,
 *   PREDICTION_SERVICE_URL, BLOCKCHAIN_SERVICE_URL.
 *
 * Exits 0 if no FAILs, 1 otherwise.
 */

'use strict';

const LOCAL_PRED = process.env.PREDICTION_SELF_URL || `http://localhost:${process.env.PREDICTION_PORT || 8091}`;
const LOCAL_BC = process.env.BLOCKCHAIN_SELF_URL || `http://localhost:${process.env.BLOCKCHAIN_PORT || 8092}`;

const PRED_URL = process.env.PREDICTION_SERVICE_URL
  || 'http://bios-prediction-production-barrage-autodeploy:8091';
const BC_URL = process.env.BLOCKCHAIN_SERVICE_URL
  || 'http://bios-blockchain-production-barrage-autodeploy:8092';
const DASH_URL = process.env.DASHBOARD_URL
  || 'http://bios-dashboard-production-barrage-autodeploy:8000';

/** Resolved at startup: which pod we're in and which Service URL to use for the OTHER service. */
let SELF_PRED = PRED_URL;
let SELF_BC = BC_URL;

const STATIONS = (process.env.PREDICTION_STATIONS || 'OS1BIOS,OS2BIOS,SOLAXBIOS')
  .split(',').map(s => s.trim()).filter(Boolean);

let pass = 0;
let warn = 0;
let fail = 0;
const failures = [];

function ok(label, detail = '') {
  console.log(`PASS  ${label}${detail ? '  — ' + detail : ''}`);
  pass += 1;
}
function notice(label, detail = '') {
  console.log(`WARN  ${label}${detail ? '  — ' + detail : ''}`);
  warn += 1;
}
function bad(label, detail = '') {
  console.error(`FAIL  ${label}${detail ? '  — ' + detail : ''}`);
  fail += 1;
  failures.push(`${label}${detail ? ': ' + detail : ''}`);
}
function section(name) {
  console.log(`\n── ${name} ──`);
}

async function timedFetch(url, opts = {}) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 20000);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return { res, ms: Date.now() - started };
  } catch (err) {
    return { error: err.message || String(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, opts) {
  const r = await timedFetch(url, opts);
  if (r.error) return r;
  let body = null;
  try { body = await r.res.json(); } catch { /* not JSON */ }
  return { res: r.res, body, ms: r.ms };
}

function host(u) {
  try { return new URL(u).host; } catch { return u; }
}

// ─── checks ──────────────────────────────────────────────────────────────────

async function detectPod() {
  // Probe localhost:8091 and localhost:8092 — whichever responds tells us which pod we're in.
  // If neither responds, both checks fall back to cluster-DNS Service URLs.
  section('Pod detection');
  const probes = await Promise.all([
    timedFetch(`${LOCAL_PRED}/health`, { timeoutMs: 1500 }),
    timedFetch(`${LOCAL_BC}/health`, { timeoutMs: 1500 }),
  ]);
  const isPred = !probes[0].error && probes[0].res.ok;
  const isBc = !probes[1].error && probes[1].res.ok;
  if (isPred) { SELF_PRED = LOCAL_PRED; SELF_BC = BC_URL; ok('Detected pod', `prediction (localhost:8091 healthy) → blockchain via ${SELF_BC}`); }
  else if (isBc) { SELF_BC = LOCAL_BC; SELF_PRED = PRED_URL; ok('Detected pod', `blockchain (localhost:8092 healthy) → prediction via ${SELF_PRED}`); }
  else {
    SELF_PRED = PRED_URL; SELF_BC = BC_URL;
    notice('Detected pod', 'neither localhost:8091 nor :8092 responded — using Service URLs for both');
  }
}

async function checkEnvSummary() {
  section('Environment summary (this pod)');
  const e = process.env;
  const lines = [
    ['BIOS_API_BASE',       e.BIOS_API_BASE       ? host(e.BIOS_API_BASE) : 'unset'],
    ['BIOS_USERNAME',       e.BIOS_USERNAME       ? `set (${e.BIOS_USERNAME.length} chars)` : 'unset'],
    ['BIOS_PASSWORD',       e.BIOS_PASSWORD       ? `set (${e.BIOS_PASSWORD.length} chars)` : 'unset'],
    ['DATABASE_URL',        e.DATABASE_URL        ? 'set' : 'unset'],
    ['PREDICTION_SERVICE_URL', e.PREDICTION_SERVICE_URL || '(default)'],
    ['BLOCKCHAIN_SERVICE_URL', e.BLOCKCHAIN_SERVICE_URL || '(default)'],
    ['STEALTH_RPC_URL',     e.STEALTH_RPC_URL     ? host(e.STEALTH_RPC_URL) : 'unset'],
    ['STEALTH_RELAY_MODE',  e.STEALTH_RELAY_MODE  || '(default)'],
  ];
  for (const [k, v] of lines) console.log(`  ${k.padEnd(24)} ${v}`);
}

async function checkMars2() {
  section('Mars2 ingest (BIOS_API_BASE)');
  const base = process.env.BIOS_API_BASE;
  const u = process.env.BIOS_USERNAME;
  const p = process.env.BIOS_PASSWORD;
  if (!base || !u || !p) {
    bad('Mars2 not configured', 'BIOS_API_BASE / BIOS_USERNAME / BIOS_PASSWORD missing in this pod');
    return;
  }
  // Auth
  const body = new URLSearchParams({ userName: u, password: p, grant_type: 'password' }).toString();
  const auth = await timedFetch(`${base}/Token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    timeoutMs: 15000,
  });
  if (auth.error) { bad('Mars2 auth (network)', `${auth.error} (${auth.ms}ms)`); return; }
  if (!auth.res.ok) { bad('Mars2 auth', `HTTP ${auth.res.status} (${auth.ms}ms)`); return; }
  let token;
  try { token = (await auth.res.json()).access_token; } catch { bad('Mars2 auth body', 'not JSON'); return; }
  if (!token) { bad('Mars2 auth body', 'no access_token in response'); return; }
  ok('Mars2 auth', `token len=${token.length} (${auth.ms}ms)`);

  // CustomDataExport for each station, just a quick 2h window to keep it cheap.
  const now = new Date();
  const from = new Date(now.getTime() - 2 * 3600000);
  const fmt = d => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  for (const station of STATIONS) {
    const url = `${base}/api/public/CustomDataExport/BIOS/${encodeURIComponent(station)}`
      + `?fromUTC=${encodeURIComponent(fmt(from))}&toUTC=${encodeURIComponent(fmt(now))}`;
    const r = await timedFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 30000,
    });
    if (r.error) { bad(`Mars2 ${station}`, `${r.error} (${r.ms}ms)`); continue; }
    if (!r.res.ok) { bad(`Mars2 ${station}`, `HTTP ${r.res.status} (${r.ms}ms)`); continue; }
    const text = await r.res.text();
    const trimmed = text.replace(/^"|"$/g, '');
    const parts = trimmed.split('!', 2);
    const rows = parts.length >= 2
      ? parts[1].split(/0xa|\n/).filter(s => s.trim()).length
      : 0;
    if (rows === 0) notice(`Mars2 ${station}`, `200 OK but 0 rows in 2h window (${r.ms}ms, body=${trimmed.length} chars)`);
    else ok(`Mars2 ${station}`, `${rows} rows in 2h window (${r.ms}ms)`);
  }
}

async function checkPrediction() {
  section('Prediction service');
  const base = SELF_PRED;
  const probes = [
    ['/health', 200],
    ['/status', 200],
    ['/sla?window=24h', 200],
    ['/data-quality/latest', 200],
    ['/forecasts/latest', 200],
    ['/anomalies?limit=5', 200],
    ['/models', 200],
  ];
  for (const [path] of probes) {
    const r = await getJson(`${base}${path}`);
    if (r.error) { bad(`prediction ${path}`, `${r.error} (${r.ms}ms)`); continue; }
    if (!r.res.ok) { bad(`prediction ${path}`, `HTTP ${r.res.status} (${r.ms}ms)`); continue; }
    ok(`prediction ${path}`, `${r.res.status} (${r.ms}ms)`);
  }

  // Deeper check: does /status report any targets? (the symptom of the dashboard going blank)
  const status = await getJson(`${base}/status`);
  if (status.body) {
    const targets = Array.isArray(status.body.targets) ? status.body.targets : [];
    if (targets.length === 0) {
      bad('prediction targets', '/status returns 0 targets — Mars2 ingest probably failing or no series found');
    } else {
      ok('prediction targets', `${targets.length} target(s) tracked`);
    }
    const lifecycle = status.body.lifecycle || 'unknown';
    if (lifecycle === 'ready') ok('prediction lifecycle', lifecycle);
    else notice('prediction lifecycle', lifecycle);
  }

  const sla = await getJson(`${base}/sla?window=24h`);
  if (sla.body?.aggregate) {
    const a = sla.body.aggregate;
    if ((a.totalCycles || 0) === 0) notice('prediction sla', '0 cycles recorded yet');
    else ok('prediction sla', `cycles=${a.totalCycles} availability=${a.availabilityPercent}%`);
  }
}

async function checkBlockchain() {
  section('Blockchain service');
  const base = SELF_BC;
  const probes = [
    ['/health', 200],
    ['/status', 200],
    ['/events?limit=5', 200],
    ['/events/latest', 200],
    ['/chain/transactions?limit=10', 200],
    ['/feeless/status', 200],
  ];
  for (const [path] of probes) {
    const r = await getJson(`${base}${path}`);
    if (r.error) { bad(`blockchain ${path}`, `${r.error} (${r.ms}ms)`); continue; }
    if (!r.res.ok) { bad(`blockchain ${path}`, `HTTP ${r.res.status} (${r.ms}ms)`); continue; }
    ok(`blockchain ${path}`, `${r.res.status} (${r.ms}ms)`);
  }

  // Slow ones get more time and live in their own line so timeouts are visible.
  for (const path of ['/chain/status', '/chain/blocks?limit=2']) {
    const r = await getJson(`${base}${path}`, { timeoutMs: 60000 });
    if (r.error) { bad(`blockchain ${path}`, `${r.error} (${r.ms}ms)`); continue; }
    if (!r.res.ok) { bad(`blockchain ${path}`, `HTTP ${r.res.status} (${r.ms}ms)`); continue; }
    if (r.body && r.body.ok === false) {
      notice(`blockchain ${path}`, `200 but ok=false ${r.body.error || r.body.status || ''}`);
    } else {
      ok(`blockchain ${path}`, `200 (${r.ms}ms)`);
    }
  }
}

async function checkCrossService() {
  section('Cross-service connectivity');
  const probes = [
    ['prediction (cluster DNS)', `${PRED_URL}/health`],
    ['blockchain (cluster DNS)', `${BC_URL}/health`],
    ['dashboard (cluster DNS)', `${DASH_URL}/health`],
    ['dashboard → /prediction/status proxy', `${DASH_URL}/prediction/status`],
    ['dashboard → /blockchain/status proxy', `${DASH_URL}/blockchain/status`],
  ];
  for (const [label, url] of probes) {
    const r = await timedFetch(url);
    if (r.error) bad(label, `${r.error} (${r.ms}ms) [${url}]`);
    else if (!r.res.ok) bad(label, `HTTP ${r.res.status} (${r.ms}ms) [${url}]`);
    else ok(label, `${r.res.status} (${r.ms}ms)`);
  }
}

async function checkDatabase() {
  section('Database (DATABASE_URL)');
  if (!process.env.DATABASE_URL) {
    notice('Database', 'DATABASE_URL not set — store is JSON-on-disk');
    return;
  }
  // pg lives at /app/database/node_modules/pg in both prediction and blockchain images.
  // Resolve it explicitly so the script works no matter where it's invoked from.
  let Pool;
  const candidates = [
    'pg',
    '/app/database/node_modules/pg',
    require('path').resolve(__dirname, '..', 'database', 'node_modules', 'pg'),
  ];
  for (const c of candidates) {
    try { ({ Pool } = require(c)); break; } catch { /* try next */ }
  }
  if (!Pool) {
    notice('Database', `pg module not resolvable from any of: ${candidates.join(', ')}`);
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const t0 = Date.now();
    const { rows } = await pool.query('SELECT now() AS now, current_database() AS db');
    ok('Database SELECT now()', `db=${rows[0].db} ts=${rows[0].now.toISOString()} (${Date.now() - t0}ms)`);
    // Per-table counts (tables exist? are they populated?)
    const tables = ['forecasts', 'anomalies', 'data_quality', 'prediction_runs', 'blockchain_events'];
    for (const t of tables) {
      try {
        const c = await pool.query(`SELECT count(*)::int AS n FROM ${t}`);
        if (c.rows[0].n > 0) ok(`Database table ${t}`, `${c.rows[0].n} rows`);
        else notice(`Database table ${t}`, '0 rows');
      } catch (err) {
        bad(`Database table ${t}`, err.message);
      }
    }
  } catch (err) {
    bad('Database connect', err.message);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function checkStealthRpc() {
  section('Stealth RPC (blockchain anchor target)');
  const url = process.env.STEALTH_RPC_URL;
  if (!url) { notice('Stealth RPC', 'STEALTH_RPC_URL unset'); return; }
  const method = process.env.STEALTH_RPC_STATUS_METHOD || 'getinfo';
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.STEALTH_RPC_USERNAME && process.env.STEALTH_RPC_PASSWORD) {
    const auth = Buffer.from(`${process.env.STEALTH_RPC_USERNAME}:${process.env.STEALTH_RPC_PASSWORD}`).toString('base64');
    headers.Authorization = `Basic ${auth}`;
  } else if (process.env.STEALTH_API_KEY) {
    headers.Authorization = `Bearer ${process.env.STEALTH_API_KEY}`;
  }
  const r = await timedFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '1.0', id: 'diag', method, params: [] }),
    timeoutMs: 30000,
  });
  if (r.error) { bad(`Stealth ${method}`, `${r.error} (${r.ms}ms)`); return; }
  if (!r.res.ok) { bad(`Stealth ${method}`, `HTTP ${r.res.status} (${r.ms}ms)`); return; }
  let body;
  try { body = await r.res.json(); } catch { bad(`Stealth ${method}`, 'response not JSON'); return; }
  if (body.error) bad(`Stealth ${method}`, JSON.stringify(body.error));
  else ok(`Stealth ${method}`, `(${r.ms}ms)`);
}

(async () => {
  console.log('=== bios-multilevel diag ===');
  console.log(`when : ${new Date().toISOString()}`);
  console.log(`pod  : ${process.env.HOSTNAME || 'unknown'}`);

  await detectPod();
  await checkEnvSummary();
  await checkMars2();
  await checkPrediction();
  await checkBlockchain();
  await checkCrossService();
  await checkDatabase();
  await checkStealthRpc();

  console.log(`\nSummary: PASS=${pass}  WARN=${warn}  FAIL=${fail}`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('diag aborted:', err);
  process.exit(2);
});
