const http = require('http');
const { encodeEvent, decodeEvent, EVENT_CODES } = require('./encoder');
const { deriveAccount } = require('./wallet');
const { createRelay } = require('./relay');
const { createStore: createJsonStore } = require('./store');
const { feelessStatus } = require('./feeless');
const { buildFeelessTransaction } = require('./feeless-builder');

const PORT = Number(process.env.BLOCKCHAIN_PORT || 8092);
const accessLogEnabled = process.env.BLOCKCHAIN_ACCESS_LOG !== 'false';
/** JSON store (sync) vs pg store (async) — always await. */
const S = (p) => Promise.resolve(p);
function log(level, msg) {
  const line = `${new Date().toISOString()} [blockchain] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

// Use PostgreSQL if DATABASE_URL is set, otherwise JSON file.
let store;
if (process.env.DATABASE_URL) {
  const { createPgBlockchainStore } = require('../database/pg-blockchain-store');
  store = createPgBlockchainStore(process.env.DATABASE_URL);
  store.init().then(() => console.log('Blockchain store: PostgreSQL')).catch(e => {
    console.error('PostgreSQL init failed, falling back to JSON:', e.message);
    store = createJsonStore(process.env.BLOCKCHAIN_DB_PATH);
  });
} else {
  store = createJsonStore(process.env.BLOCKCHAIN_DB_PATH);
}
const relay = createRelay();
const state = {
  lifecycle: 'initializing',
  running: false,
  startedAt: new Date().toISOString(),
  lastCycle: null,
  nextRunAt: null,
  progress: null,
};

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

function numberParam(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function boolParam(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function eventSources() {
  return (process.env.BLOCKCHAIN_EVENT_SOURCE || 'prediction')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function normalizedEventSources() {
  return eventSources().map(source => source === 'demo' ? 'bios-data-window' : source);
}

function dedupeKey(event) {
  return event.dedupeKey || `${event.type || event.event_code}:${event.source || event.device_id}:${event.timestamp}:${event.value || 0}`;
}

async function processEvent(event) {
  if (!allowed(event)) {
    return { accepted: false, reason: 'filtered' };
  }

  const key = dedupeKey(event);
  const priorSeen = await S(store.markSeen(key));
  if (priorSeen) return { accepted: false, reason: 'duplicate', dedupeKey: key };

  const encoded = encodeEvent(event);
  const account = deriveAccount(encoded.deviceId || encoded.sourceId);
  const id = `evt-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const record = {
    id,
    schema: encoded.schema,
    deviceId: encoded.deviceId,
    sourceId: encoded.sourceId,
    eventCode: encoded.eventCode,
    metricCode: encoded.metricCode,
    statusCode: encoded.statusCode,
    timestamp: encoded.timestamp,
    value: encoded.value,
    payloadHex: encoded.hex,
    payloadHash: encoded.payloadHash,
    bytes: encoded.bytes,
    account,
    status: 'queued',
    retryCounter: 0,
    createdAt: new Date().toISOString(),
    encodedAt: new Date().toISOString(),
    sourceKind: event.sourceKind || 'manual',
    sourceRef: event.sourceRef || null,
    dedupeKey: key,
  };
  await S(store.put(record));

  const maxRetries = Number(process.env.BLOCKCHAIN_MAX_RETRIES || 3);
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // If the relay is in cool-down (Stealth gateway throttled us), skip
    // the attempt loop entirely. The cycle will naturally retry after
    // the cool-down lifts and the dedupe key keeps us safe.
    const cs = relay.cacheStats?.();
    if (cs?.cooldownSecondsRemaining > 0) {
      record.status = 'deferred';
      record.lastError = `relay cooling down for ${cs.cooldownSecondsRemaining}s`;
      record.updatedAt = new Date().toISOString();
      await S(store.put(record));
      return { accepted: false, deferred: true, ...record };
    }

    try {
      record.status = 'submitting';
      record.submittedAt = new Date().toISOString();
      await S(store.put(record));
      let submitPayloadHex = encoded.hex;
      if (relay.mode === 'json-rpc' && String(process.env.STEALTH_ENABLE_REAL_BROADCAST || 'false').toLowerCase() === 'true') {
        const built = await buildFeelessTransaction({ payloadHex: encoded.hex, relay });
        record.transactionBuild = {
          sourceAddress: built.sourceAddress,
          inputCount: built.inputCount,
          outputCount: built.outputCount,
          selectedUtxo: built.selectedUtxo,
          payloadBytes: built.payloadBytes,
        };
        submitPayloadHex = `rawtx:${built.rawTransactionHex}`;
      }
      const receipt = await relay.submit({ payloadHex: submitPayloadHex, account });
      if (process.env.BLOCKCHAIN_RELAY_LOG !== 'false') {
        const tx = receipt.txId || receipt.transactionId;
        log('info', `[relay] Stealth submit mode=${receipt.mode || relay.mode} relayStatus=${receipt.relayStatus || 'ok'} txId=${tx ?? 'none'}`);
      }
      record.status = receipt.relayStatus === 'not_submitted'
        ? 'encoded'
        : receipt.confirmed === false ? 'sent' : 'confirmed';
      record.txId = receipt.txId || receipt.transactionId || null;
      record.relayMode = receipt.mode || relay.mode;
      record.relayStatus = receipt.relayStatus || record.status;
      record.relayReason = receipt.reason || null;
      record.retryCounter = attempt;
      record.updatedAt = new Date().toISOString();
      if (record.status === 'confirmed') record.confirmedAt = record.updatedAt;
      await S(store.put(record));
      await S(store.markSeen(key, { id, txId: record.txId, status: record.status, seenAt: record.updatedAt }));
      return { accepted: true, ...record };
    } catch (error) {
      record.status = 'retrying';
      record.retryCounter = attempt + 1;
      record.lastError = error.message;
      await S(store.put(record));
      // small backoff between attempts to avoid a tight retry-storm
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  record.status = 'failed';
  record.updatedAt = new Date().toISOString();
  await S(store.put(record));
  await S(store.markSeen(key, { id, status: record.status, seenAt: record.updatedAt }));
  return { accepted: true, ...record };
}

async function chainStatus() {
  const cacheStats = relay.cacheStats?.() || null;
  try {
    const status = await relay.status();
    return {
      ok: true,
      relayMode: relay.mode,
      lastPollAt: new Date().toISOString(),
      rpcCache: cacheStats,
      ...status,
    };
  } catch (error) {
    return {
      ok: false,
      relayMode: relay.mode,
      rpcConfigured: Boolean(process.env.STEALTH_RPC_URL),
      status: cacheStats?.cooldownSecondsRemaining > 0 ? 'rpc_cooldown' : 'rpc_unavailable',
      error: error.message,
      lastPollAt: new Date().toISOString(),
      rpcCache: cacheStats,
    };
  }
}

const EVENT_NAME_BY_CODE = Object.fromEntries(
  Object.entries(EVENT_CODES).map(([name, code]) => [code, name]),
);

function eventNameFor(event) {
  if (typeof event.eventCode === 'number' && EVENT_NAME_BY_CODE[event.eventCode]) {
    return EVENT_NAME_BY_CODE[event.eventCode];
  }
  return `0x${Number(event.eventCode || 0).toString(16).padStart(2, '0')}`;
}

async function chainTransactions(limit = 10) {
  const isProof = row => ['sent', 'confirmed'].includes(row.status) && Boolean(row.txId);
  const all = await S(store.list(isProof, 10000));
  const events = all.slice(0, limit);
  const byEvent = {};
  const bySource = {};
  for (const row of all) {
    const eventName = eventNameFor(row);
    byEvent[eventName] = (byEvent[eventName] || 0) + 1;
    const source = row.sourceKind || 'unknown';
    bySource[source] = (bySource[source] || 0) + 1;
  }
  const counts = {
    total: all.length,
    confirmed: all.filter(row => row.status === 'confirmed').length,
    sent: all.filter(row => row.status === 'sent').length,
    byEvent,
    bySource,
  };
  const data = [];
  for (const event of events) {
    let chain = null;
    try {
      chain = event.txId ? await relay.transaction(event.txId) : null;
    } catch (error) {
      chain = { found: false, error: error.message };
    }
    data.push({
      id: event.id,
      txId: event.txId,
      status: event.status,
      sourceKind: event.sourceKind,
      eventCode: event.eventCode,
      eventName: eventNameFor(event),
      payloadHex: event.payloadHex,
      payloadHash: event.payloadHash,
      createdAt: event.createdAt,
      submittedAt: event.submittedAt,
      confirmedAt: event.confirmedAt,
      confirmations: event.confirmations ?? chainConfirmations(chain) ?? null,
      blockHash: event.blockHash || chainBlockHash(chain) || null,
      chain,
    });
  }
  return { data, counts, relayMode: relay.mode, checkedAt: new Date().toISOString() };
}

async function chainBlocks(limit = 10) {
  if (relay.mode === 'mock') {
    const events = await S(store.list(() => true, limit * 5));
    const groups = new Map();
    for (const event of events) {
      const minute = Math.floor((Date.parse(event.createdAt) || Date.now()) / 60000);
      if (!groups.has(minute)) {
        groups.set(minute, {
          height: minute,
          hash: `mock-${minute.toString(16)}`,
          time: Math.floor((Date.parse(event.createdAt) || Date.now()) / 1000),
          transactions: [],
        });
      }
      if (event.txId) groups.get(minute).transactions.push(event.txId);
    }
    return { data: [...groups.values()].slice(0, limit), relayMode: relay.mode, checkedAt: new Date().toISOString() };
  }
  try {
    const best = await relay.bestBlock();
    const blocks = [];
    if (best) {
      blocks.push(best);
      const hash = typeof best === 'string' ? best : best.hash || best.blockhash;
      if (hash) {
        try {
          const detail = await relay.block(hash);
          blocks[0] = detail;
        } catch {}
      }
    }
    return { data: blocks.slice(0, limit), relayMode: relay.mode, checkedAt: new Date().toISOString() };
  } catch (error) {
    return { data: [], relayMode: relay.mode, error: error.message, checkedAt: new Date().toISOString() };
  }
}

async function fetchJson(base, path) {
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`);
  if (!res.ok) throw new Error(`prediction API ${path} failed: ${res.status}`);
  return res.json();
}

function demoEvents() {
  const devices = (process.env.BLOCKCHAIN_DEMO_DEVICES || '0x0A1C')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const bucket = Math.floor(Date.now() / (numberParam('BLOCKCHAIN_INTERVAL_SECONDS', 60) * 1000));
  return devices.map(device => ({
    source: 'OS1BIOS',
    metric: 'PM2_5',
    timestamp: Math.floor(Date.now() / 1000),
    event_code: 'data_batch_seen',
    status: 'ok',
    value: 1,
    sourceKind: 'bios-data-window',
    sourceRef: `bios-data-window-${device}-${bucket}`,
    dedupeKey: `bios-data-window:${device}:${bucket}`,
    metadata: { source: 'BIOS data window', metric: 'PM2_5', bucket },
  }));
}

function timestampFromIso(value) {
  return Math.floor((Date.parse(value) || Date.now()) / 1000);
}

async function predictionEvents() {
  const base = process.env.PREDICTION_SERVICE_URL;
  if (!base) return [];
  const events = [];
  const status = await fetchJson(base, '/status');
  const quality = await fetchJson(base, '/data-quality?limit=50');
  const forecasts = await fetchJson(base, '/forecasts?limit=20');
  const sla = await fetchJson(base, '/sla?window=24h');

  for (const target of status.targets || []) {
    const latest = (quality.data || []).find(row => row.source === target.source && row.metric === target.metric);
    if (!latest) continue;
    events.push({
      source: target.source,
      metric: target.metric,
      timestamp: latest.input.latestTimestamp || timestampFromIso(latest.computedAt),
      event_code: 'data_batch_seen',
      status: latest.status,
      value: latest.input.observedSamples || 0,
      sourceKind: 'mars2-data-window',
      sourceRef: latest.id,
      dedupeKey: `data-window:${target.source}:${target.metric}:${latest.input.latestTimestamp || 'none'}:${latest.input.observedSamples || 0}`,
      metadata: {
        inputSource: latest.inputSource,
        expected: latest.input.expectedSamples,
        observed: latest.input.observedSamples,
        unit: target.unit,
      },
    });
  }

  for (const row of quality.data || []) {
    if (!['stale', 'insufficient_data', 'partial'].includes(row.status)) continue;
    const value = row.status === 'stale'
      ? Math.min(65535, row.input.dataAgeMinutes || 0)
      : Math.round((row.input.missingRatio || 0) * 1000);
    events.push({
      source: row.source,
      metric: row.metric,
      timestamp: timestampFromIso(row.computedAt),
      event_code: 'data_quality_changed',
      status: row.status,
      value,
      sourceKind: 'prediction-data-quality',
      sourceRef: row.id,
      dedupeKey: `quality:${row.source}:${row.metric}:${row.status}:${row.input.latestTimestamp || 'none'}`,
      metadata: { source: row.source, metric: row.metric, status: row.status },
    });
  }

  const anomalies = await fetchJson(base, '/anomalies?limit=50');
  for (const artifact of anomalies.data || []) {
    for (const anomaly of artifact.anomalies || []) {
      events.push({
        source: artifact.source,
        metric: artifact.metric,
        timestamp: anomaly.timestamp || Math.floor(Date.now() / 1000),
        event_code: 'anomaly_detected',
        status: anomaly.status || 'detected',
        value: Math.min(65535, Math.round((anomaly.deviation || anomaly.missingRatio || 1) * 100)),
        sourceKind: 'prediction-anomaly',
        sourceRef: `${artifact.id}:${anomaly.timestamp}:${anomaly.type || 'value'}`,
        dedupeKey: `anomaly:${artifact.source}:${artifact.metric}:${anomaly.timestamp}:${anomaly.type || 'value'}:${anomaly.status || anomaly.severity || 'value'}`,
        metadata: { source: artifact.source, metric: artifact.metric, severity: anomaly.severity },
      });
    }
  }

  for (const row of sla.targets || []) {
    const [source, metric] = String(row.target || '').split(':');
    if (!source || !metric) continue;
    if (row.withinSla === false) {
      events.push({
        source,
        metric,
        timestamp: timestampFromIso(row.lastComputedAt),
        event_code: 'sla_breached',
        status: 'breached',
        value: Math.max(0, Math.min(65535, Math.round(10000 - (row.freshnessPercent || 0) * 100))),
        sourceKind: 'sla-breach',
        sourceRef: `${row.target}:${row.lastComputedAt}`,
        dedupeKey: `sla-breach:${row.target}:${row.lastStatus}:${row.lastComputedAt}`,
        metadata: row,
      });
    }
  }

  if (boolParam('BLOCKCHAIN_ANCHOR_PREDICTIONS', false)) {
    for (const forecast of forecasts.data || []) {
      events.push({
        source: forecast.source,
        metric: forecast.metric,
        timestamp: timestampFromIso(forecast.computedAt),
        event_code: 'prediction_generated',
        status: forecast.status || 'generated',
        value: forecast.points?.length || 0,
        sourceKind: 'prediction-generated',
        sourceRef: forecast.id,
        dedupeKey: `prediction:${forecast.id}`,
        metadata: {
          model: forecast.model,
          horizonHours: forecast.horizonHours,
          unit: forecast.metricInfo?.unit,
        },
      });
    }
  }
  if (process.env.BLOCKCHAIN_INGEST_LOG !== 'false') {
    const tgt = (status.targets || []).length;
    console.log(`${new Date().toISOString()} [blockchain-ingest] pulled prediction HTTP APIs (${tgt} targets in status) → built ${events.length} candidate event(s) for anchoring`);
  }
  return events;
}

async function runCycle(reason = 'scheduled') {
  if (state.running) return { skipped: true, reason: 'cycle_already_running' };
  state.running = true;
  state.progress = { phase: 'collecting-events', processed: 0, total: 0, accepted: 0, deferred: 0 };
  const startedAt = new Date();
  const results = [];
  try {
    const maxBroadcasts = numberParam('BLOCKCHAIN_MAX_BROADCASTS_PER_CYCLE', 3);
    for (const source of normalizedEventSources()) {
      try {
        const events = source === 'bios-data-window' ? demoEvents() : source === 'prediction' ? await predictionEvents() : [];
        state.progress = { phase: 'processing-events', source, processed: 0, total: events.length, accepted: 0, deferred: 0 };
        let accepted = 0;
        let duplicates = 0;
        let filtered = 0;
        let deferred = 0;
        for (const event of events) {
          state.progress.processed += 1;
          if (accepted >= maxBroadcasts) {
            deferred += 1;
            state.progress.deferred = deferred;
            continue;
          }
          const result = await processEvent(event);
          if (result.accepted) accepted += 1;
          if (result.reason === 'duplicate') duplicates += 1;
          if (result.reason === 'filtered') filtered += 1;
          state.progress.accepted = accepted;
        }
        results.push({ source, status: 'ok', events: events.length, accepted, duplicates, filtered, deferred, maxBroadcasts });
      } catch (error) {
        results.push({ source, status: 'failed', error: error.message });
      }
    }
    state.lifecycle = results.some(r => r.status === 'ok') ? 'ready' : 'degraded';
    state.lastCycle = {
      id: `cycle-${Date.now()}`,
      reason,
      status: state.lifecycle,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      results,
    };
    state.progress = { phase: 'idle', processed: 0, total: 0, accepted: 0, deferred: 0 };
    await S(store.checkpoint('lastCycle', state.lastCycle));
    await S(store.setMeta('status', state));
    const okN = results.filter(r => r.status === 'ok').length;
    const detail = results.map((r) =>
      `${r.source}:${r.status}${r.events !== undefined ? `:evt=${r.events}` : ''}${r.accepted !== undefined ? `:accepted=${r.accepted}` : ''}`,
    ).join(' · ');
    log('info', `[cycle] ${reason}: ${okN}/${results.length} sources ok — ${detail}`);
    return state.lastCycle;
  } finally {
    state.running = false;
  }
}

function chainConfirmations(chain) {
  if (!chain || chain.found === false) return 0;
  const tx = chain.transaction || chain;
  if (typeof tx?.confirmations === 'number') return tx.confirmations;
  if (typeof tx?.blockhash === 'string' && tx.blockhash.length > 0) return 1;
  if (typeof tx?.blockHash === 'string' && tx.blockHash.length > 0) return 1;
  if (typeof tx?.blockHeight === 'number') return 1;
  return 0;
}

function chainBlockHash(chain) {
  const tx = chain?.transaction || chain || {};
  return tx.blockhash || tx.blockHash || null;
}

async function reconfirmSentTransactions() {
  // Stealth has ~5s blocks. Anything we marked 'sent' should normally be
  // visible in a block within seconds. Walk recent sent records and
  // promote them to 'confirmed' once the relay can see them on chain.
  // Cap the per-cycle batch size so we don't hammer the gateway. The
  // RPC layer caches confirmed results, so subsequent passes are cheap.
  const batchCap = numberParam('BLOCKCHAIN_RECONFIRM_BATCH', 20);
  const sent = await S(store.list(row => row.status === 'sent' && Boolean(row.txId), batchCap));
  if (sent.length === 0) return { checked: 0, promoted: 0 };

  // If the relay is in cool-down, skip this pass entirely; the cached
  // confirmations will be served on the next cycle.
  const stats = relay.cacheStats?.();
  if (stats?.cooldownSecondsRemaining > 0) {
    return { checked: 0, promoted: 0, skipped: 'rpc-cooldown', cooldownSecondsRemaining: stats.cooldownSecondsRemaining };
  }

  let promoted = 0, errors = 0;
  for (const event of sent) {
    let chain = null;
    try { chain = await relay.transaction(event.txId); } catch (error) {
      chain = { found: false, error: error.message };
      errors += 1;
      // bail early on a sustained outage; the next cycle will retry
      if (errors >= 3) break;
    }
    const confirmations = chainConfirmations(chain);
    if (confirmations >= 1) {
      const blockHash = chainBlockHash(chain);
      const updated = {
        ...event,
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        confirmations,
        blockHash: blockHash || event.blockHash || null,
      };
      await S(store.put(updated));
      await S(store.markSeen(event.dedupeKey, { id: event.id, txId: event.txId, status: 'confirmed', seenAt: updated.confirmedAt }));
      promoted += 1;
    }
  }
  return { checked: sent.length, promoted, errors };
}

function startWorker() {
  const interval = numberParam('BLOCKCHAIN_INTERVAL_SECONDS', 60);
  state.lifecycle = 'initializing';
  runCycle(process.env.BLOCKCHAIN_INIT_MODE || 'resume').catch(error => {
    state.lifecycle = 'degraded';
    state.lastCycle = { id: `cycle-${Date.now()}`, status: 'failed', error: error.message, finishedAt: new Date().toISOString() };
  });
  if (!interval) return;
  setInterval(() => {
    state.nextRunAt = new Date(Date.now() + interval * 1000).toISOString();
    runCycle('scheduled').catch(error => {
      state.lifecycle = 'degraded';
      state.lastCycle = { id: `cycle-${Date.now()}`, status: 'failed', error: error.message, finishedAt: new Date().toISOString() };
    });
  }, interval * 1000);

  const reconfirmInterval = numberParam('BLOCKCHAIN_RECONFIRM_SECONDS', 20);
  if (reconfirmInterval > 0) {
    setInterval(() => {
      reconfirmSentTransactions().catch(() => {});
    }, reconfirmInterval * 1000);
  }
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'blockchain', relayMode: relay.mode, store: store.file });
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      const stats = typeof store.stats === 'function' ? await store.stats() : {};
      return json(res, 200, stats);
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, {
        ...state,
        intervalSeconds: numberParam('BLOCKCHAIN_INTERVAL_SECONDS', 60),
        sources: eventSources(),
        normalizedSources: normalizedEventSources(),
        relayMode: relay.mode,
        checkpoints: store.read().checkpoints || {},
      });
    }
    if (req.method === 'POST' && url.pathname === '/events') {
      return json(res, 202, await processEvent(await readBody(req)));
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      const status = url.searchParams.get('status');
      const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
      const data = await S(store.list(row => !status || row.status === status, limit));
      return json(res, 200, { data });
    }
    if (req.method === 'GET' && url.pathname === '/events/latest') {
      const latest = await S(store.latest());
      return json(res, 200, latest || {});
    }
    if (req.method === 'GET' && url.pathname === '/decode') {
      return json(res, 200, decodeEvent(url.searchParams.get('payload') || ''));
    }
    if (req.method === 'GET' && url.pathname === '/chain/status') {
      return json(res, 200, { ...(await chainStatus()), feeless: await feelessStatus(relay) });
    }
    if (req.method === 'GET' && url.pathname === '/feeless/status') {
      return json(res, 200, await feelessStatus(relay));
    }
    if (req.method === 'GET' && url.pathname === '/chain/transactions') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 10), 100);
      return json(res, 200, await chainTransactions(limit));
    }
    if (req.method === 'GET' && url.pathname === '/chain/blocks') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 10), 100);
      return json(res, 200, await chainBlocks(limit));
    }
    if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/chain/reconfirm') {
      return json(res, 200, await reconfirmSentTransactions());
    }
    if (req.method === 'GET' && url.pathname.startsWith('/events/')) {
      const id = decodeURIComponent(url.pathname.slice('/events/'.length));
      const record = await S(store.get(id));
      return record ? json(res, 200, record) : json(res, 404, { error: 'event not found' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/verify/')) {
      const txId = decodeURIComponent(url.pathname.slice('/verify/'.length));
      const record = await S(store.get(txId));
      const chain = await relay.verify(txId);
      return json(res, 200, { txId, localRecordFound: Boolean(record), record, chain });
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    log('error', `${url.pathname}: ${error.message}`);
    return json(res, 500, { error: error.message });
  }
}

if (require.main === module) {
  startWorker();
  http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host}`);
    res.on('finish', () => {
      if (accessLogEnabled) log('info', `${req.method} ${url.pathname} -> ${res.statusCode} ${Date.now() - started}ms`);
    });
    handle(req, res).catch((err) => {
      log('error', `unhandled ${req.method} ${url.pathname}: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: err.message });
    });
  }).listen(PORT, () => {
    log('info', `listening on http://0.0.0.0:${PORT} relay=${relay.mode} DATABASE_URL=${process.env.DATABASE_URL ? 'set' : 'unset'} ACCESS_LOG=${accessLogEnabled}`);
  });
}

module.exports = { handle, processEvent, allowed, runCycle, demoEvents, predictionEvents, chainStatus, chainTransactions, chainBlocks };
