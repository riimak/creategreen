const fs = require('fs');
const path = require('path');

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function createStore(file) {
  const storeFile = file || path.resolve(process.cwd(), 'bios-multilevel-platform-services', 'data', 'prediction-store.json');

  function read() {
    if (!fs.existsSync(storeFile)) return { forecasts: [], anomalies: [], runs: [] };
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
    data[kind] = data[kind].slice(-200);
    write(data);
    return artifact;
  }

  function latest(kind, predicate) {
    const data = read();
    const rows = Array.isArray(data[kind]) ? data[kind] : [];
    return rows.slice().reverse().find(predicate);
  }

  return { read, write, append, latest, file: storeFile };
}

module.exports = { createStore };
