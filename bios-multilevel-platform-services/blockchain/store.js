const fs = require('fs');
const path = require('path');

function createStore(file) {
  const storeFile = file || path.resolve(process.cwd(), 'bios-multilevel-platform-services', 'data', 'blockchain-store.json');
  const retention = Number(process.env.BLOCKCHAIN_RETENTION_COUNT || 500);

  function read() {
    if (!fs.existsSync(storeFile)) return { events: [], meta: {}, checkpoints: {}, seen: {} };
    return JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  }

  function write(data) {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify(data, null, 2));
  }

  function put(record) {
    const data = read();
    const index = data.events.findIndex(row => row.id === record.id);
    if (index >= 0) data.events[index] = record;
    else data.events.push(record);
    data.events = data.events.slice(-retention);
    write(data);
    return record;
  }

  function get(id) {
    return read().events.find(row => row.id === id || row.txId === id);
  }

  function list(predicate = () => true, limit = 100) {
    return read().events.slice().reverse().filter(predicate).slice(0, limit);
  }

  function latest(predicate = () => true) {
    return list(predicate, 1)[0] || null;
  }

  function listPaginated(filters = {}, options = {}) {
    let rows = read().events.slice().reverse();
    if (filters.status) rows = rows.filter(r => r.status === filters.status);
    if (filters.sourceKind) rows = rows.filter(r => r.sourceKind === filters.sourceKind);
    if (filters.eventName) rows = rows.filter(r => r.eventName === filters.eventName);
    if (filters.search) {
      const q = String(filters.search).toLowerCase();
      rows = rows.filter(r => `${r.eventName || ''} ${r.sourceKind || ''} ${r.txId || ''} ${r.dedupeKey || ''}`.toLowerCase().includes(q));
    }
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 1000);
    const offset = Math.max(0, Number(options.offset) || 0);
    return { data: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
  }

  function markSeen(key, value) {
    const data = read();
    data.seen = data.seen || {};
    if (value !== undefined) {
      data.seen[key] = value;
      write(data);
    }
    return data.seen[key] || null;
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

  function setMeta(key, value) {
    const data = read();
    data.meta = data.meta || {};
    data.meta[key] = value;
    write(data);
    return value;
  }

  return { read, write, put, get, list, latest, listPaginated, markSeen, checkpoint, setMeta, file: storeFile };
}

module.exports = { createStore };
