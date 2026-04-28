const http = require('http');
const { loadRecords, seriesFor, fieldsFor, METEO_FIELDS, SOLAX_FIELDS } = require('./bios-data');
const { forecast, anomalies } = require('./model');
const { createStore: createJsonStore } = require('./store');
const { METRICS, metricInfo, targetInfo } = require('./metrics');

const PORT = Number(process.env.PREDICTION_PORT || 8091);
const MAX_HORIZON_HOURS = 48;
const accessLogEnabled = process.env.PREDICTION_ACCESS_LOG !== 'false';
/** JSON store (sync) vs pg store (async) — always await. */
const S = (p) => Promise.resolve(p);
function log(level, msg) {
  const line = `${new Date().toISOString()} prediction — ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

// Use PostgreSQL if DATABASE_URL is set, otherwise JSON file.
let store;
if (process.env.DATABASE_URL) {
  const { createPgPredictionStore } = require('../database/pg-prediction-store');
  store = createPgPredictionStore(process.env.DATABASE_URL);
  store.init().then(() => console.log('Prediction store: PostgreSQL')).catch(e => {
    console.error('PostgreSQL init failed, falling back to JSON:', e.message);
    store = createJsonStore(process.env.PREDICTION_DB_PATH);
  });
} else {
  store = createJsonStore(process.env.PREDICTION_DB_PATH);
}
const state = {
  lifecycle: 'initializing',
  running: false,
  startedAt: new Date().toISOString(),
  lastCycle: null,
  nextRunAt: null,
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

function config() {
  return {
    dataDir: process.env.BIOS_OUTPUT_DIR,
    apiBase: process.env.PREDICTION_DATA_API_BASE,
    mars2ApiBase: process.env.BIOS_API_BASE,
    mars2Username: process.env.BIOS_USERNAME,
    mars2Password: process.env.BIOS_PASSWORD,
  };
}

function inputSourceInfo() {
  const cfg = config();
  if (cfg.mars2ApiBase && cfg.mars2Username && cfg.mars2Password) {
    return {
      type: 'mars2-rest-api',
      label: 'Mars2 REST API (direct)',
      description: 'Measurements fetched directly from the Mars2 API.',
      location: cfg.mars2ApiBase,
    };
  }
  return cfg.apiBase
    ? {
      type: 'mars2-rest-api',
      label: 'Mars2 REST API',
      description: 'Measurements fetched from the production Mars2 API through the configured data API base.',
      location: cfg.apiBase,
    }
    : {
      type: 'partner-export-files',
      label: 'BIOS export files',
      description: 'Measurements read from the local partner export folder generated from Mars2.',
      location: cfg.dataDir || 'output',
    };
}

function targetKey(source, metric) {
  return `${source}:${metric}`;
}

function parseTargets() {
  return (process.env.PREDICTION_TARGETS || 'auto')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(target => {
      if (target === 'auto') return { source: 'auto', metric: 'auto' };
      const [source, metric] = target.split(':');
      return { source, metric: metric || 'PM2_5' };
    });
}

function stationIds() {
  return (process.env.PREDICTION_STATIONS || 'OS1BIOS,OS2BIOS,SOLAXBIOS')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

async function expandTargets(targets, hours) {
  const expanded = [];
  const stationOutcome = [];
  for (const target of targets) {
    if (target.source !== 'auto') {
      expanded.push(target);
      continue;
    }
    for (const source of stationIds()) {
      try {
        const records = await loadRecords({ source, hours, ...config() });
        const fields = fieldsFor(source);
        const before = expanded.length;
        for (const metric of fields) {
          if (seriesFor(records, metric).length > 0) expanded.push({ source, metric });
        }
        // Persist the raw pull. Idempotent (PRIMARY KEY + ON CONFLICT DO UPDATE),
        // so re-running a cycle with overlapping data simply refreshes values.
        try {
          const persistResult = await S(store.persistRawRecords(source, fields, records));
          stationOutcome.push(`${source}=ok(rows=${records.length},metrics=${expanded.length - before},persisted=${persistResult.inserted ?? 0})`);
        } catch (persistErr) {
          log('warn', `persist raw_measurements failed for ${source}: ${persistErr.message}`);
          stationOutcome.push(`${source}=ok(rows=${records.length},metrics=${expanded.length - before},persist=failed)`);
        }
      } catch (err) {
        // Surface the reason instead of dropping silently — this was the symptom of
        // "no Mars2 logs" in production: every station threw, expand returned [].
        stationOutcome.push(`${source}=failed(${err.message})`);
      }
    }
  }
  if (stationOutcome.length) log('info', `expand: targets=auto outcome ${stationOutcome.join(' · ')}`);
  const seen = new Set();
  return expanded.filter(target => {
    const key = targetKey(target.source, target.metric);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function numberParam(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function dataQuality({ source, metric, hours, records, series }) {
  const expectedSampleMinutes = numberParam('PREDICTION_EXPECTED_SAMPLE_MINUTES', 10);
  const staleAfterMinutes = numberParam('PREDICTION_STALE_AFTER_MINUTES', 30);
  const missingWarn = numberParam('PREDICTION_MISSING_RATIO_WARN', 0.3);
  const minSamples = numberParam('PREDICTION_MIN_SAMPLES', 6);
  const expectedSamples = Math.max(1, Math.floor((Number(hours) * 60) / expectedSampleMinutes));
  const observedSamples = series.length;
  const missingSamples = Math.max(0, expectedSamples - observedSamples);
  const missingRatio = Number((missingSamples / expectedSamples).toFixed(4));
  const latestTimestamp = records.reduce((max, row) => Math.max(max, row.timestamp || 0), 0) || null;
  const now = Math.floor(Date.now() / 1000);
  const dataAgeMinutes = latestTimestamp ? Math.max(0, Math.round((now - latestTimestamp) / 60)) : null;
  let status = 'ok';
  const reasons = [];

  if (observedSamples < minSamples) {
    status = 'insufficient_data';
    reasons.push('not_enough_numeric_samples');
  } else if (dataAgeMinutes !== null && dataAgeMinutes > staleAfterMinutes) {
    status = 'stale';
    reasons.push('latest_sample_too_old');
  } else if (missingRatio > missingWarn) {
    status = 'partial';
    reasons.push('missing_ratio_above_threshold');
  }

  return {
    id: `quality-${Date.now()}-${source}-${metric}`,
    source,
    metric,
    metricInfo: metricInfo(metric),
    inputSource: inputSourceInfo(),
    input: {
      hours,
      expectedSampleMinutes,
      expectedSamples,
      observedSamples,
      missingSamples,
      missingRatio,
      latestTimestamp,
      dataAgeMinutes,
      minSamples,
      staleAfterMinutes,
      missingWarn,
    },
    status,
    reasons,
    computedAt: new Date().toISOString(),
  };
}

function insufficientForecast(source, metric, hours, quality) {
  return {
    id: `forecast-${Date.now()}-${source}-${metric}`,
    source,
    metric,
    metricInfo: metricInfo(metric),
    inputSource: inputSourceInfo(),
    status: 'insufficient_data',
    reason: quality.reasons.join(',') || 'insufficient_data',
    input: {
      hours,
      count: quality.input.observedSamples,
      from: null,
      to: quality.input.latestTimestamp,
    },
    computedAt: new Date().toISOString(),
    model: null,
    residualError: null,
    horizonHours: Math.min(numberParam('PREDICTION_HORIZON_HOURS', 24), MAX_HORIZON_HOURS),
    points: [],
  };
}

async function maybeNotifyDataQuality(quality) {
  if (String(process.env.NOTIFICATIONS_ENABLED || 'false').toLowerCase() !== 'true') return null;
  const webhook = process.env.NOTIFICATION_WEBHOOK_URL;
  if (!webhook) return null;
  if (!['stale', 'insufficient_data'].includes(quality.status)) return null;

  const staleMinutes = quality.input.dataAgeMinutes || 0;
  const threshold = numberParam('NOTIFICATION_STALE_AFTER_MINUTES', 60);
  const repeatMinutes = numberParam('NOTIFICATION_REPEAT_AFTER_MINUTES', 240);
  if (staleMinutes < threshold && quality.status !== 'insufficient_data') return null;

  const key = `notification:${quality.source}:${quality.metric}:${quality.status}`;
  const previous = await S(store.checkpoint(key));
  if (previous?.sentAt && Date.now() - Date.parse(previous.sentAt) < repeatMinutes * 60 * 1000) return null;

  const payload = {
    type: quality.status === 'stale' ? 'stale_data' : 'insufficient_data',
    severity: 'warning',
    source: quality.source,
    metric: quality.metric,
    staleMinutes,
    missingRatio: quality.input.missingRatio,
    status: quality.status,
    message: `${quality.source} ${quality.metric} status is ${quality.status}`,
    computedAt: quality.computedAt,
  };

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  await S(store.checkpoint(key, { sentAt: new Date().toISOString(), status: res.status, payload }));
  return payload;
}

async function runForecast(params) {
  const source = params.get('source') || params.get('station') || 'OS1BIOS';
  const metric = params.get('metric') || 'PM2_5';
  const horizon = Math.min(Number(params.get('horizon') || 24), MAX_HORIZON_HOURS);
  const hours = Number(params.get('hours') || 72);
  const records = await loadRecords({ source, hours, ...config() });
  const series = seriesFor(records, metric);
  const quality = dataQuality({ source, metric, hours, records, series });
  await S(store.append('dataQuality', quality));
  if (quality.status === 'insufficient_data') {
    const artifact = insufficientForecast(source, metric, hours, quality);
    await S(store.append('forecasts', artifact));
    return artifact;
  }
  const result = forecast(series, horizon);
  const artifact = {
    id: `forecast-${Date.now()}`,
    source,
    metric,
    metricInfo: metricInfo(metric),
    inputSource: inputSourceInfo(),
    status: 'ok',
    input: {
      hours,
      count: series.length,
      from: series[0]?.timestamp || null,
      to: series[series.length - 1]?.timestamp || null,
    },
    computedAt: new Date().toISOString(),
    ...result,
  };
  await S(store.append('forecasts', artifact));
  return artifact;
}

async function runAnomalies(params) {
  const source = params.get('source') || params.get('station') || 'OS1BIOS';
  const metric = params.get('metric') || 'PM2_5';
  const hours = Number(params.get('hours') || 24);
  const records = await loadRecords({ source, hours, ...config() });
  const series = seriesFor(records, metric);
  const latestQuality = (await S(store.latest('dataQuality', row => row.source === source && row.metric === metric)))
    || dataQuality({ source, metric, hours, records, series });
  const qualityAnomalies = [];
  if (['stale', 'insufficient_data', 'partial'].includes(latestQuality.status)) {
    qualityAnomalies.push({
      timestamp: latestQuality.input.latestTimestamp || Math.floor(Date.now() / 1000),
      type: 'data_quality',
      severity: latestQuality.status === 'partial' ? 'medium' : 'high',
      status: latestQuality.status,
      missingRatio: latestQuality.input.missingRatio,
      dataAgeMinutes: latestQuality.input.dataAgeMinutes,
      reasons: latestQuality.reasons,
    });
  }
  const artifact = {
    id: `anomalies-${Date.now()}`,
    source,
    metric,
    metricInfo: metricInfo(metric),
    inputSource: inputSourceInfo(),
    input: {
      hours,
      count: series.length,
      from: series[0]?.timestamp || null,
      to: series[series.length - 1]?.timestamp || null,
    },
    computedAt: new Date().toISOString(),
    anomalies: [...qualityAnomalies, ...anomalies(series)],
  };
  await S(store.append('anomalies', artifact));
  return artifact;
}

async function processTarget(target, reason = 'scheduled') {
  const hours = numberParam('PREDICTION_BACKFILL_HOURS', 72);
  const horizon = numberParam('PREDICTION_HORIZON_HOURS', 24);
  const params = new URLSearchParams({ source: target.source, metric: target.metric, hours: String(hours), horizon: String(horizon) });
  const forecastArtifact = await runForecast(params);
  const quality = await S(store.latest('dataQuality', row => row.source === target.source && row.metric === target.metric));
  if (quality) {
    await maybeNotifyDataQuality(quality).catch(error => {
      void S(store.append('runs', { id: `notification-${Date.now()}`, target: targetKey(target.source, target.metric), status: 'notification_failed', error: error.message }));
    });
  }
  const anomalyArtifact = await runAnomalies(params);
  const checkpoint = {
    target: targetKey(target.source, target.metric),
    lastProcessedAt: new Date().toISOString(),
    lastForecastId: forecastArtifact.id,
    lastAnomalyId: anomalyArtifact.id,
    reason,
  };
  await S(store.checkpoint(checkpoint.target, checkpoint));
  return checkpoint;
}

async function runCycle(reason = 'scheduled') {
  if (state.running) return { skipped: true, reason: 'cycle_already_running' };
  state.running = true;
  const startedAt = new Date();
  const results = [];
  try {
    const hours = numberParam('PREDICTION_BACKFILL_HOURS', 72);
    const targets = await expandTargets(parseTargets(), hours);
    for (const target of targets) {
      try {
        results.push({ target: targetKey(target.source, target.metric), status: 'ok', ...(await processTarget(target, reason)) });
      } catch (error) {
        results.push({ target: targetKey(target.source, target.metric), status: 'failed', error: error.message });
      }
    }
    state.lifecycle = results.some(r => r.status === 'ok') ? 'ready' : 'degraded';
    state.lastCycle = {
      id: `run-${Date.now()}`,
      reason,
      status: state.lifecycle,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      results,
    };
    await S(store.append('runs', state.lastCycle));
    await S(store.setMeta('status', state));
    const okN = results.filter(r => r.status === 'ok').length;
    const brief = results.map((r) => `${r.target}:${r.status === 'ok' ? 'ok' : (r.error || 'fail')}`).join(' · ');
    log('info', `cycle: ${reason}: ${okN}/${results.length} targets ok — ${brief}`);
    return state.lastCycle;
  } finally {
    state.running = false;
  }
}

/* ── Raw measurements view (Mars2 data browser, DB-backed) ──────────────────
 * Stored in `raw_measurements` (tall layout) by `runCycle` after each Mars2
 * pull, and seedable historically via `scripts/backfill-mars2.js`. The
 * dashboard reads from this table — no live Mars2 hit on the critical path. */
async function listMeasurements(params) {
  const fromRaw = params.get('from');
  const toRaw = params.get('to');
  const hoursRaw = params.get('hours');
  let from = null;
  let to = null;
  if (fromRaw) from = new Date(fromRaw);
  if (toRaw) to = new Date(toRaw);
  if (!from && !to && hoursRaw) {
    const hours = Math.min(Math.max(Number(hoursRaw) || 24, 1), 24 * 365 * 10);
    from = new Date(Date.now() - hours * 3600 * 1000);
  }

  const filters = {
    source: params.get('source') || undefined,
    metric: params.get('metric') || undefined,
    from: from && !Number.isNaN(from.getTime()) ? from.toISOString() : undefined,
    to:   to   && !Number.isNaN(to.getTime())   ? to.toISOString()   : undefined,
    valueMin: params.get('valueMin') === null || params.get('valueMin') === '' ? null : Number(params.get('valueMin')),
    valueMax: params.get('valueMax') === null || params.get('valueMax') === '' ? null : Number(params.get('valueMax')),
    search: (params.get('search') || '').trim() || undefined,
    missingOnly: params.get('missingOnly') === 'true',
    sort: params.get('sort') || 'timestamp',
    sortDir: params.get('sortDir') === 'asc' ? 'asc' : 'desc',
    limit: Math.min(Math.max(Number(params.get('limit')) || 500, 1), 5000),
    offset: Math.max(0, Number(params.get('offset')) || 0),
  };

  const result = await S(store.listRawMeasurements(filters));
  return { ...result, filters: { ...filters, valueMin: filters.valueMin, valueMax: filters.valueMax } };
}

async function measurementsMeta() {
  const stats = await S(store.rawMeasurementsStats());
  return {
    stations: stationIds(),
    metrics: { meteo: METEO_FIELDS, solax: SOLAX_FIELDS },
    inputSource: inputSourceInfo(),
    intervalMinutes: numberParam('PREDICTION_INTERVAL_MINUTES', 10),
    expectedSampleMinutes: numberParam('PREDICTION_EXPECTED_SAMPLE_MINUTES', 10),
    storage: store.file === 'postgres' ? 'postgres' : 'json',
    stats,
    retentionDays: Number(process.env.RAW_MEASUREMENTS_RETENTION_DAYS) || null,
  };
}

async function listFromStore(kind, params) {
  const source = params.get('source');
  const metric = params.get('metric');
  const limit = Math.min(Number(params.get('limit') || 100), 500);
  // IMPORTANT: For Postgres, filter in SQL before LIMIT. Filtering after a
  // global LIMIT can hide valid rows for a specific source/metric.
  if (typeof store.listPaginated === 'function') {
    const paged = await S(store.listPaginated(
      kind,
      { source: source || undefined, metric: metric || undefined },
      { limit, offset: 0, sort: kind === 'runs' ? 'created_at' : 'computed_at', sortDir: 'desc' },
    ));
    if (paged && Array.isArray(paged.data)) return paged.data;
  }
  return await S(store.list(kind, row => (!source || row.source === source) && (!metric || row.metric === metric), limit));
}

async function latestFromStore(kind, params) {
  const source = params.get('source');
  const metric = params.get('metric');
  if (typeof store.listPaginated === 'function') {
    const paged = await S(store.listPaginated(
      kind,
      { source: source || undefined, metric: metric || undefined },
      { limit: 1, offset: 0, sort: kind === 'runs' ? 'created_at' : 'computed_at', sortDir: 'desc' },
    ));
    if (paged && Array.isArray(paged.data) && paged.data[0]) return paged.data[0];
  }
  return await S(store.latest(kind, row => (!source || row.source === source) && (!metric || row.metric === metric)));
}

async function slaSummary(params) {
  const window = params.get('window') || '24h';
  const windowHours = window === '1h' ? 1 : window === '7d' ? 168 : 24;
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const targetPercent = numberParam('SLA_TARGET_PERCENT', 95);
  const listed = await S(store.list('dataQuality', row => Date.parse(row.computedAt) >= cutoff, 10000));
  const rows = listed.slice().reverse();
  const byTarget = new Map();
  for (const row of rows) {
    const key = targetKey(row.source, row.metric);
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(row);
  }

  const summarize = (key, items) => {
    const total = items.length;
    const ok = items.filter(row => row.status === 'ok').length;
    const partial = items.filter(row => row.status === 'partial').length;
    const stale = items.filter(row => row.status === 'stale').length;
    const insufficient = items.filter(row => row.status === 'insufficient_data').length;
    const available = items.filter(row => row.status !== 'insufficient_data').length;
    const fresh = items.filter(row => row.status !== 'stale').length;
    const avgMissing = total
      ? items.reduce((sum, row) => sum + (row.input && typeof row.input.missingRatio === 'number' ? row.input.missingRatio : 0), 0) / total
      : 0;
    let currentStale = 0;
    for (let i = items.length - 1; i >= 0 && ['stale', 'insufficient_data'].includes(items[i].status); i -= 1) currentStale += 1;
    const availabilityPercent = total ? (available / total) * 100 : 0;
    const freshnessPercent = total ? (fresh / total) * 100 : 0;
    const withinSla = availabilityPercent >= targetPercent && freshnessPercent >= targetPercent;
    return {
      target: key,
      totalCycles: total,
      ok,
      partial,
      stale,
      insufficientData: insufficient,
      availabilityPercent: Number(availabilityPercent.toFixed(2)),
      freshnessPercent: Number(freshnessPercent.toFixed(2)),
      averageMissingRatio: Number(avgMissing.toFixed(4)),
      currentStaleStreak: currentStale,
      lastStatus: items[items.length - 1]?.status || 'unknown',
      lastComputedAt: items[items.length - 1]?.computedAt || null,
      withinSla,
    };
  };

  const targets = [...byTarget.entries()].map(([key, items]) => summarize(key, items));
  const aggregate = summarize('global', rows);
  const sources = {};
  for (const target of targets) {
    const source = target.target.split(':')[0] || 'unknown';
    if (!sources[source]) sources[source] = [];
    sources[source].push(target);
  }
  const sourceSummaries = Object.entries(sources).map(([source, items]) => {
    const total = items.length;
    const stale = items.filter(item => ['stale', 'insufficient_data'].includes(item.lastStatus)).length;
    const partial = items.filter(item => item.lastStatus === 'partial').length;
    const ok = items.filter(item => item.lastStatus === 'ok').length;
    const freshnessPercent = total ? (items.reduce((sum, item) => sum + item.freshnessPercent, 0) / total) : 0;
    const availabilityPercent = total ? (items.reduce((sum, item) => sum + item.availabilityPercent, 0) / total) : 0;
    return {
      source,
      totalMetrics: total,
      ok,
      partial,
      stale,
      status: stale > 0 ? 'stale' : partial > 0 ? 'partial' : 'ok',
      freshnessPercent: Number(freshnessPercent.toFixed(2)),
      availabilityPercent: Number(availabilityPercent.toFixed(2)),
      withinSla: stale === 0 && availabilityPercent >= targetPercent && freshnessPercent >= targetPercent,
    };
  });
  return { window, targetPercent, aggregate, sources: sourceSummaries, targets, computedAt: new Date().toISOString() };
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'prediction', store: store.file });
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      const stats = typeof store.stats === 'function' ? await store.stats() : {};
      return json(res, 200, stats);
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      const lastRun = await S(store.latest('runs'));
      return json(res, 200, {
        ...state,
        intervalMinutes: numberParam('PREDICTION_INTERVAL_MINUTES', 10),
        targets: lastRun?.results?.map(result => {
          const [source, metric] = String(result.target || '').split(':');
          return targetInfo(source, metric);
        }) || parseTargets().map(target => targetInfo(target.source, target.metric)),
        inputSource: inputSourceInfo(),
        checkpoints: store.read().checkpoints || {},
      });
    }
    if (req.method === 'GET' && url.pathname === '/models') {
      return json(res, 200, {
        maxHorizonHours: MAX_HORIZON_HOURS,
        models: ['linear-regression', 'seasonal-hourly-baseline'],
        metrics: METRICS,
        fields: {
          OS1BIOS: fieldsFor('OS1BIOS'),
          SOLAXBIOS: fieldsFor('SOLAXBIOS'),
        },
      });
    }
    if (req.method === 'GET' && url.pathname === '/forecast') {
      return json(res, 200, await runForecast(url.searchParams));
    }
    if (req.method === 'GET' && url.pathname === '/forecasts') {
      return json(res, 200, { data: await listFromStore('forecasts', url.searchParams) });
    }
    if (req.method === 'GET' && url.pathname === '/forecasts/latest') {
      return json(res, 200, await latestFromStore('forecasts', url.searchParams) || {});
    }
    if (req.method === 'GET' && url.pathname === '/anomalies') {
      if (url.searchParams.get('recompute') === 'true') {
        return json(res, 200, await runAnomalies(url.searchParams));
      }
      return json(res, 200, { data: await listFromStore('anomalies', url.searchParams) });
    }
    if (req.method === 'GET' && url.pathname === '/data-quality') {
      return json(res, 200, { data: await listFromStore('dataQuality', url.searchParams) });
    }
    if (req.method === 'GET' && url.pathname === '/data-quality/latest') {
      return json(res, 200, await latestFromStore('dataQuality', url.searchParams) || {});
    }
    if (req.method === 'GET' && url.pathname === '/sla') {
      return json(res, 200, await slaSummary(url.searchParams));
    }
    if (req.method === 'GET' && url.pathname === '/measurements') {
      return json(res, 200, await listMeasurements(url.searchParams));
    }
    if (req.method === 'GET' && url.pathname === '/measurements/meta') {
      return json(res, 200, await measurementsMeta());
    }
    // Paginated artifact browsers (used by the dashboard's Predikcije tab).
    // Supports: ?source=&metric=&status=&search=&limit=&offset=&sort=&sortDir=
    if (req.method === 'GET' && (url.pathname === '/forecasts/page' || url.pathname === '/anomalies/page' || url.pathname === '/data-quality/page')) {
      const kind = url.pathname === '/forecasts/page' ? 'forecasts'
        : url.pathname === '/anomalies/page' ? 'anomalies'
        : 'dataQuality';
      const filters = {
        source: url.searchParams.get('source') || undefined,
        metric: url.searchParams.get('metric') || undefined,
        status: url.searchParams.get('status') || undefined,
        search: url.searchParams.get('search') || undefined,
      };
      const options = {
        limit: Number(url.searchParams.get('limit')) || 100,
        offset: Number(url.searchParams.get('offset')) || 0,
        sort: url.searchParams.get('sort') || 'computed_at',
        sortDir: url.searchParams.get('sortDir') || 'desc',
      };
      return json(res, 200, await S(store.listPaginated(kind, filters, options)));
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    log('error', `${url.pathname}: ${error.message}`);
    return json(res, 500, { error: error.message });
  }
}

function startScheduler() {
  const interval = numberParam('PREDICTION_INTERVAL_MINUTES', 10);
  const targets = parseTargets();
  if (!interval || targets.length === 0) return;

  state.lifecycle = 'initializing';
  runCycle(process.env.PREDICTION_INIT_MODE || 'resume').catch(error => {
    state.lifecycle = 'degraded';
    state.lastCycle = { id: `run-${Date.now()}`, status: 'failed', error: error.message, finishedAt: new Date().toISOString() };
    log('error', `cycle: init failed: ${error.message}`);
    void S(store.append('runs', state.lastCycle));
  });

  setInterval(() => {
    state.nextRunAt = new Date(Date.now() + interval * 60 * 1000).toISOString();
    runCycle('scheduled').catch(error => {
      state.lifecycle = 'degraded';
      log('error', `cycle: scheduled failed: ${error.message}`);
      void S(store.append('runs', { id: `run-${Date.now()}`, status: 'failed', error: error.message, finishedAt: new Date().toISOString() }));
    });
  }, interval * 60 * 1000);

  // Optional pruning of raw_measurements (off by default to preserve backfill).
  // Set RAW_MEASUREMENTS_RETENTION_DAYS=730 to keep ~2 years.
  const retention = Number(process.env.RAW_MEASUREMENTS_RETENTION_DAYS) || 0;
  if (retention > 0 && typeof store.pruneRawMeasurements === 'function') {
    const runPrune = () => {
      S(store.pruneRawMeasurements(retention))
        .then(r => log('info', `raw_measurements prune: deleted=${r.deleted ?? 0} retentionDays=${retention}`))
        .catch(err => log('warn', `raw_measurements prune failed: ${err.message}`));
    };
    setTimeout(runPrune, 60 * 1000);
    setInterval(runPrune, 6 * 3600 * 1000);
  }
}

if (require.main === module) {
  startScheduler();
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
    const hasDb = Boolean(process.env.DATABASE_URL);
    const cfg = config();
    let mode;
    if (cfg.mars2ApiBase && cfg.mars2Username && cfg.mars2Password) mode = `mars2-api(${cfg.mars2ApiBase})`;
    else if (cfg.apiBase) mode = `prediction-data-api(${cfg.apiBase})`;
    else mode = `export-files(${cfg.dataDir || 'output'})`;
    log('info', `listening on http://0.0.0.0:${PORT} store=${hasDb ? 'postgres' : 'json'} ingest=${mode} ACCESS_LOG=${accessLogEnabled}`);
    if (mode.startsWith('export-files')) {
      log('warn', `ingest fallback: no BIOS_API_BASE/BIOS_USERNAME/BIOS_PASSWORD nor PREDICTION_DATA_API_BASE — Mars2 ingest is OFF and runCycle will see 0 targets`);
    } else if (mode.startsWith('mars2-api') && (!cfg.mars2Username || !cfg.mars2Password)) {
      log('warn', `ingest config: BIOS_API_BASE set but BIOS_USERNAME/PASSWORD missing — Mars2 auth will fail`);
    }
  });
}

module.exports = { handle, runForecast, runAnomalies, runCycle, dataQuality, slaSummary };
