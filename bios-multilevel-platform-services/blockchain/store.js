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

  return { read, write, put, get, list, latest, markSeen, checkpoint, setMeta, file: storeFile };
}

module.exports = { createStore };
