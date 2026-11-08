const fs = require('fs');
const path = require('path');

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function createStore(file) {
  const storeFile = file || path.resolve(process.cwd(), 'bios-multilevel-platform-services', 'data', 'prediction-store.json');
  const retention = Number(process.env.PREDICTION_RETENTION_COUNT || 500);

  function read() {
    if (!fs.existsSync(storeFile)) {
      return { forecasts: [], anomalies: [], dataQuality: [], runs: [], meta: {}, checkpoints: {} };
    }
    return JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  }

  function write(data) {
    ensureDir(storeFile);
    fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));
  }

  function append(kind, artifact) {
    const data = read();
    if (!Array.isArray(data[kind])) data[kind] = [];
    data[kind].push(artifact);
    data[kind] = data[kind].slice(-retention);
    write(data);
    return artifact;
  }

  function list(kind, predicate = () => true, limit = 100) {
    const data = read();
    const rows = Array.isArray(data[kind]) ? data[kind] : [];
    return rows.slice().reverse().filter(predicate).slice(0, limit);
  }

  function latest(kind, predicate = () => true) {
    return list(kind, predicate, 1)[0] || null;
  }

  // Mirrors the Postgres store: newest-first data-quality rows computed at or
  // after `sinceIso`, with only the fields the SLA summary reads.
  function listDataQualityWindow(sinceIso, limit = 10000) {
    const since = Date.parse(sinceIso);
    return list('dataQuality', row => Date.parse(row.computedAt) >= since, Number.MAX_SAFE_INTEGER)
      .sort((a, b) => Date.parse(b.computedAt) - Date.parse(a.computedAt))
      .slice(0, limit)
      .map(row => ({
        source: row.source,
        metric: row.metric,
        status: row.status,
        computedAt: row.computedAt,
        input: { missingRatio: row.input?.missingRatio },
      }));
  }

  function listPaginated(kind, filters = {}, options = {}) {
    const data = read();
    let rows = Array.isArray(data[kind]) ? data[kind].slice().reverse() : [];
    if (filters.source) rows = rows.filter(r => r.source === filters.source);
    if (filters.metric) rows = rows.filter(r => r.metric === filters.metric);
    if (filters.status) rows = rows.filter(r => r.status === filters.status);
    if (filters.search) {
      const q = String(filters.search).toLowerCase();
      rows = rows.filter(r => `${r.source || ''} ${r.metric || ''} ${r.model || ''} ${r.status || ''}`.toLowerCase().includes(q));
    }
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 1000);
    const offset = Math.max(0, Number(options.offset) || 0);
    return { data: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
  }

  function setMeta(key, value) {
    const data = read();
    data.meta = data.meta || {};
    data.meta[key] = value;
    write(data);
    return value;
  }

  function checkpoint(key, value) {
    const data = read();
    data.checkpoints = data.checkpoints || {};
    if (value !== undefined) {
      data.checkpoints[key] = value;
      write(data);
    }
    return data.checkpoints[key] || null;
  }

  // Raw-measurements API: no-ops in JSON mode. The dashboard's /measurements
  // endpoint will simply return an empty result set without DATABASE_URL.
  async function persistRawRecords() { return { inserted: 0, skipped: 'json store does not persist raw measurements' }; }
  async function listRawMeasurements() { return { data: [], total: null, limit: 0, offset: 0 }; }
  async function listKnownSources() { return []; }
  async function rawMeasurementsStats() {
    return { totalRows: 0, uniqueSources: 0, uniqueMetrics: 0, missingRows: 0, rows24h: 0, rows7d: 0, earliest: null, latest: null, perStation: [], perMetric: [] };
  }
  async function pruneRawMeasurements() { return { deleted: 0, skipped: 'json store has no retention' }; }
  async function ping() { return { ok: true }; }
  async function latestMeasurementTimestamps(sources) {
    return (sources || []).map(source => ({ source, latestTs: null }));
  }
  // Feed API: no vendor inventory and no raw rows without PostgreSQL.
  async function listFeedInventory() { return []; }
  async function distinctMetricsForSource() { return []; }
  async function latestSamples() { return []; }
  async function bucketedSeries() { return []; }

  // Single-process coordination: this process is always the leader, leases
  // live in memory, monitor checks are kept for the summary only.
  const leases = new Map();
  const monitorChecks = [];
  async function tryAcquireLeadership() { return true; }
  async function leadershipHeartbeat() { return true; }
  async function releaseLeadership() {}
  async function renewLease(name, holder, ttlSeconds) {
    const now = Date.now();
    const ttl = Math.min(3600, Math.max(5, Number(ttlSeconds) || 180)) * 1000;
    const current = leases.get(name);
    if (!current || current.holder === holder || current.expiresAt <= now) {
      leases.set(name, { holder, expiresAt: now + ttl });
      return { name, holder, held: true, expiresAt: new Date(now + ttl).toISOString() };
    }
    return { name, holder: current.holder, held: false, expiresAt: new Date(current.expiresAt).toISOString() };
  }
  async function appendMonitorCheck(check) {
    monitorChecks.push({ ...check, checkedAt: check.checkedAt || new Date().toISOString() });
    if (monitorChecks.length > 50_000) monitorChecks.splice(0, monitorChecks.length - 50_000);
  }
  async function monitorSummary(days = 30) {
    const since = Date.now() - Math.min(365, Math.max(1, Number(days) || 30)) * 86400_000;
    const rows = monitorChecks.filter(c => Date.parse(c.checkedAt) > since);
    const count = (f) => rows.filter(f).length;
    const comp = (okKey, msKey) => {
      const withValue = rows.filter(c => c[okKey] !== null && c[okKey] !== undefined);
      const ms = withValue.map(c => c[msKey]).filter(Number.isFinite).sort((a, b) => a - b);
      return { ok: withValue.filter(c => c[okKey]).length, total: withValue.length, p95Ms: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : null };
    };
    const problemCounts = new Map();
    for (const c of rows) for (const key of c.problems || []) problemCounts.set(key, (problemCounts.get(key) || 0) + 1);
    return {
      days: Number(days) || 30,
      checks: rows.length,
      firstCheckAt: rows[0]?.checkedAt || null,
      lastCheckAt: rows[rows.length - 1]?.checkedAt || null,
      healthy: count(c => c.healthy),
      dataFresh: count(c => !(c.problems || []).some(k => String(k).startsWith('data.stale:'))),
      components: { prediction: comp('predictionOk', 'predictionMs'), blockchain: comp('blockchainOk', 'blockchainMs'), database: comp('databaseOk', 'databaseMs') },
      problems: [...problemCounts.entries()].map(([key, checks]) => ({ key, checks })).sort((a, b) => b.checks - a.checks).slice(0, 20),
    };
  }
  async function pruneMonitorChecks() { return { deleted: 0 }; }

  return {
    read, write, append, list, latest, listPaginated, listDataQualityWindow, setMeta, checkpoint,
    persistRawRecords, listRawMeasurements, rawMeasurementsStats, pruneRawMeasurements, listKnownSources,
    ping, latestMeasurementTimestamps,
    listFeedInventory, distinctMetricsForSource, latestSamples, bucketedSeries,
    tryAcquireLeadership, leadershipHeartbeat, releaseLeadership,
    renewLease, appendMonitorCheck, monitorSummary, pruneMonitorChecks,
    file: storeFile,
  };
}

module.exports = { createStore };
