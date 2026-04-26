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

  return { read, write, append, list, latest, setMeta, checkpoint, file: storeFile };
}

module.exports = { createStore };
