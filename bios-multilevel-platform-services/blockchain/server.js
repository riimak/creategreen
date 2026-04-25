const http = require('http');
const { encodeEventV1 } = require('./encoder');
const { deriveAccount } = require('./wallet');
const { createRelay } = require('./relay');
const { createStore } = require('./store');

const PORT = Number(process.env.BLOCKCHAIN_PORT || 8092);
const store = createStore(process.env.BLOCKCHAIN_DB_PATH);
const relay = createRelay();

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function allowed(event) {
  const filters = (process.env.BLOCKCHAIN_EVENT_FILTERS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (filters.length === 0) return true;
  const type = String(event.event_code || event.eventType || event.type || '').toLowerCase();
  return filters.includes(type);
}

async function processEvent(event) {
  if (!allowed(event)) {
    return { accepted: false, reason: 'filtered' };
  }

  const encoded = encodeEventV1(event);
  const account = deriveAccount(encoded.deviceId);
  const id = `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const record = {
    id,
    schema: encoded.schema,
    deviceId: encoded.deviceId,
    eventCode: encoded.eventCode,
    timestamp: encoded.timestamp,
    value: encoded.value,
    payloadHex: encoded.hex,
    payloadHash: encoded.payloadHash,
    bytes: encoded.bytes,
    account,
    status: 'queued',
    retryCounter: 0,
    createdAt: new Date().toISOString(),
  };
  store.put(record);

  const maxRetries = Number(process.env.BLOCKCHAIN_MAX_RETRIES || 3);
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const receipt = await relay.submit({ payloadHex: encoded.hex, account });
      record.status = receipt.confirmed === false ? 'sent' : 'confirmed';
      record.txId = receipt.txId || receipt.transactionId || null;
      record.relayMode = receipt.mode || relay.mode;
      record.retryCounter = attempt;
      record.updatedAt = new Date().toISOString();
      store.put(record);
      return { accepted: true, ...record };
    } catch (error) {
      record.status = 'retrying';
      record.retryCounter = attempt + 1;
      record.lastError = error.message;
      store.put(record);
    }
  }

  record.status = 'failed';
  record.updatedAt = new Date().toISOString();
  store.put(record);
  return { accepted: true, ...record };
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'blockchain', relayMode: relay.mode, store: store.file });
    }
    if (req.method === 'POST' && url.pathname === '/events') {
      return json(res, 202, await processEvent(await readBody(req)));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/events/')) {
      const id = decodeURIComponent(url.pathname.slice('/events/'.length));
      const record = store.get(id);
      return record ? json(res, 200, record) : json(res, 404, { error: 'event not found' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/verify/')) {
      const txId = decodeURIComponent(url.pathname.slice('/verify/'.length));
      const record = store.get(txId);
      const chain = await relay.verify(txId);
      return json(res, 200, { txId, localRecordFound: Boolean(record), record, chain });
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
}

if (require.main === module) {
  http.createServer(handle).listen(PORT, () => {
    console.log(`Blockchain service listening on http://localhost:${PORT}`);
  });
}

module.exports = { handle, processEvent, allowed };
