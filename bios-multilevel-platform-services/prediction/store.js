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
  async function listRawMeasurements() { return { data: [], total: 0, limit: 0, offset: 0 }; }
  async function rawMeasurementsStats() {
    return { totalRows: 0, uniqueSources: 0, uniqueMetrics: 0, missingRows: 0, rows24h: 0, rows7d: 0, earliest: null, latest: null, perStation: [], perMetric: [] };
  }
  async function pruneRawMeasurements() { return { deleted: 0, skipped: 'json store has no retention' }; }

  return {
    read, write, append, list, latest, listPaginated, setMeta, checkpoint,
    persistRawRecords, listRawMeasurements, rawMeasurementsStats, pruneRawMeasurements,
    file: storeFile,
  };
}

module.exports = { createStore };
