const fs = require('fs');
const path = require('path');

function createStore(file) {
  const storeFile = file || path.resolve(process.cwd(), 'bios-multilevel-platform-services', 'data', 'blockchain-store.json');

  function read() {
    if (!fs.existsSync(storeFile)) return { events: [] };
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
    data.events = data.events.slice(-500);
    write(data);
    return record;
  }

  function get(id) {
    return read().events.find(row => row.id === id || row.txId === id);
  }

  return { read, write, put, get, file: storeFile };
}

module.exports = { createStore };
