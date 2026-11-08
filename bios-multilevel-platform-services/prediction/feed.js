'use strict';
/* ── Feed API: Mars2 pulls the vendor plants from us ──────────────────────────
 *
 * The Huawei (FusionSolar) and Solis (SolisCloud) plants are ingested by our
 * own services into raw_measurements. The partner (PMF NS) pulls everything
 * from Mars2 `CustomDataExport/BIOS/<code>`, so each plant becomes a Mars2
 * device whose template polls this API, and Mars2 exports it like SOLAXBIOS.
 *
 * Every plant is published in the SOLAXBIOS 15-column layout (see LAYOUT) so
 * the partner's parser and the monthly report work unchanged; vendor metrics
 * the layout cannot express are carried in `raw` for completeness.
 *
 * Endpoints (mounted by server.js under /feed, reachable through the
 * dashboard proxy at https://bios-multilevel.barrage.net/prediction/feed/...):
 *
 *   POST /feed/token                        userName, password, grant_type=password  (same form as Mars2 /Token)
 *   GET  /feed/plants                       plant list with devices
 *   GET  /feed/plants/{code}/current        latest value per layout key, flat `values` for one-JSON-path-per-counter templates
 *   GET  /feed/plants/{code}/history?from&to&step=300
 *   GET  /feed/plants/{code}/export?fromUTC&toUTC   CustomDataExport wire format ("CODE!ts;v1;...;v15<0xa>..."), comma decimals
 *
 * Auth: `Authorization: Bearer <token>` from /feed/token (HMAC-signed, 24 h) or
 * a static `X-Feed-Key` header. Without FEED_USERNAME/FEED_PASSWORD (or
 * FEED_API_KEY) configured every endpoint answers 503 — the feed is never open.
 */

const crypto = require('node:crypto');

const TOKEN_TTL_SECONDS = 24 * 3600;
const DEFAULT_STALE_MINUTES = { gauge: 30, daily: 26 * 60, cumulative: 26 * 60 };

/* ── Layout: SOLAXBIOS columns 1..15 and how each vendor fills them ──────────
 * scope 'plant'   -> metric lives on the plant source (HUAWEI:<code>, SOLIS:<id>)
 * scope 'devices' -> metric lives on device sources; `agg` combines devices
 * kind  gauge (avg per bucket) | daily (resets at midnight; max per bucket) | cumulative (last per bucket)
 * verified:false  -> mapping provisional until checked against vendor documentation (plan item A2) */
const LAYOUT = Object.freeze([
  { position: 1, key: 'Grid.power.total', unit: 'kW', kind: 'gauge',
    huawei: { scope: 'devices', agg: 'sum', metrics: ['huawei.grid_meter.active_power_kw', 'huawei.power_sensor.active_power_kw'] },
    solis: null },
  { position: 2, key: 'Grid.energy.toGrid.total', unit: 'kWh', kind: 'cumulative',
    huawei: { scope: 'devices', agg: 'sum', verified: false, metrics: ['huawei.grid_meter.positive_active_energy_kwh', 'huawei.power_sensor.positive_active_energy_kwh'] },
    solis: { scope: 'plant', metrics: ['solis.plant.total_grid_sell_kwh'] } },
  { position: 3, key: 'Grid.energy.fromGrid.total', unit: 'kWh', kind: 'cumulative',
    huawei: { scope: 'devices', agg: 'sum', verified: false, metrics: ['huawei.grid_meter.negative_active_energy_kwh', 'huawei.power_sensor.negative_active_energy_kwh'] },
    solis: { scope: 'plant', metrics: ['solis.plant.total_grid_purchased_kwh'] } },
  { position: 4, key: 'BMS.energy.SOC', unit: '%', kind: 'gauge',
    huawei: { scope: 'devices', agg: 'avg', metrics: ['huawei.battery.state_of_charge_percent', 'huawei.ess.state_of_charge_percent'] },
    solis: { scope: 'devices', agg: 'avg', metrics: ['solis.inverter.battery_soc_percent'] } },
  { position: 5, key: 'Inverter.Meter2.AC.power.total', unit: 'kW', kind: 'gauge', huawei: null, solis: null },
  { position: 6, key: 'Inverter.AC.EPS.power.R', unit: 'kW', kind: 'gauge', huawei: null, solis: null },
  { position: 7, key: 'Inverter.AC.EPS.power.S', unit: 'kW', kind: 'gauge', huawei: null, solis: null },
  { position: 8, key: 'Inverter.AC.EPS.power.T', unit: 'kW', kind: 'gauge', huawei: null, solis: null },
  { position: 9, key: 'Inverter.DC.Battery.power.total', unit: 'kW', kind: 'gauge',
    huawei: { scope: 'devices', agg: 'sum', metrics: ['huawei.battery.charge_discharge_power_kw', 'huawei.ess.charge_discharge_power_kw'] },
    solis: { scope: 'devices', agg: 'sum', metrics: ['solis.inverter.battery_power_kw'] } },
  { position: 10, key: 'Inverter.DC.PV.power.MPPT1', unit: 'kW', kind: 'gauge', huawei: null, solis: null },
  { position: 11, key: 'Inverter.DC.PV.power.MPPT2', unit: 'kW', kind: 'gauge', huawei: null, solis: null },
  { position: 12, key: 'Inverter.DC.PV.power.MPPT3', unit: 'kW', kind: 'gauge', huawei: null, solis: null },
  { position: 13, key: 'Inverter.DC.PV.power.MPPT4', unit: 'kW', kind: 'gauge', huawei: null, solis: null },
  { position: 14, key: 'Inverter.AC.power.total', unit: 'kW', kind: 'gauge',
    huawei: { scope: 'devices', agg: 'sum', metrics: ['huawei.string_inverter.active_power_kw', 'huawei.residential_inverter.active_power_kw'] },
    solis: { scope: 'plant', metrics: ['solis.plant.current_power_kw'] } },
  { position: 15, key: 'Inverter.AC.energy.out.daily', unit: 'kWh', kind: 'daily',
    huawei: { scope: 'plant', metrics: ['huawei.plant.daily_yield_kwh'] },
    solis: { scope: 'plant', metrics: ['solis.plant.daily_yield_kwh'] } },
]);

/* ── Configuration ────────────────────────────────────────────────────────── */

/** "SOKO46BIOS=HUAWEI:NE=201410062,VETINSTBIOS=SOLIS:1298491919450654168" -> [{ code, source, vendor }] */
function parseFeedPlants(raw) {
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) throw new Error(`FEED_PLANTS entry "${entry}" must be CODE=SOURCE`);
    const code = entry.slice(0, eq).trim();
    const source = entry.slice(eq + 1).trim();
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new Error(`FEED_PLANTS code "${code}" must be 3-32 chars of A-Z 0-9 _ -`);
    const vendor = vendorOf(source);
    if (!vendor) throw new Error(`FEED_PLANTS source "${source}" must start with HUAWEI: or SOLIS:`);
    if (out.some(p => p.code === code)) throw new Error(`FEED_PLANTS code "${code}" is listed twice`);
    out.push({ code, source, vendor });
  }
  return out;
}

function vendorOf(source) {
  if (typeof source !== 'string') return null;
  if (source.startsWith('HUAWEI:')) return 'huawei';
  if (source.startsWith('SOLIS:')) return 'solis';
  return null;
}

function feedConfig(env = process.env) {
  const username = (env.FEED_USERNAME || '').trim();
  const password = env.FEED_PASSWORD || '';
  const apiKey = (env.FEED_API_KEY || '').trim();
  const secret = env.FEED_TOKEN_SECRET || (password ? crypto.createHash('sha256').update(`feed-token:${password}`).digest('hex') : '');
  const staleMinutes = {
    gauge: positiveNumber(env.FEED_STALE_MINUTES, DEFAULT_STALE_MINUTES.gauge),
    daily: positiveNumber(env.FEED_STALE_MINUTES_COUNTERS, DEFAULT_STALE_MINUTES.daily),
    cumulative: positiveNumber(env.FEED_STALE_MINUTES_COUNTERS, DEFAULT_STALE_MINUTES.cumulative),
  };
  return {
    plants: parseFeedPlants(env.FEED_PLANTS),
    username, password, apiKey, secret,
    configured: Boolean((username && password) || apiKey),
    staleMinutes,
  };
}

function positiveNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/* ── Tokens ───────────────────────────────────────────────────────────────── */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sign(secret, payload) {
  return b64url(crypto.createHmac('sha256', secret).update(payload).digest());
}

function issueToken(config, now = Date.now()) {
  const payload = b64url(JSON.stringify({ sub: config.username, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + TOKEN_TTL_SECONDS }));
  return { access_token: `${payload}.${sign(config.secret, payload)}`, token_type: 'bearer', expires_in: TOKEN_TTL_SECONDS };
}

function verifyToken(config, token, now = Date.now()) {
  if (typeof token !== 'string' || !config.secret) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const expected = sign(config.secret, payload);
  const given = token.slice(dot + 1);
  if (expected.length !== given.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number.isFinite(claims.exp) && claims.exp * 1000 > now && claims.sub === config.username;
  } catch {
    return false;
  }
}

function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** true when the request carries a valid bearer token or the static key. */
function isAuthorized(config, headers, now = Date.now()) {
  if (!config.configured) return false;
  const auth = String(headers.authorization || '');
  if (/^bearer\s+/i.test(auth) && verifyToken(config, auth.replace(/^bearer\s+/i, '').trim(), now)) return true;
  const key = headers['x-feed-key'];
  if (config.apiKey && key && constantTimeEqual(key, config.apiKey)) return true;
  return false;
}

/* ── Value computation ────────────────────────────────────────────────────── */

/** (source, metric) pairs to read for one plant, per layout key. */
function pairsForPlant(plant, inventory) {
  const devices = inventory?.devices || [];
  const out = [];
  for (const column of LAYOUT) {
    const rule = column[plant.vendor];
    if (!rule) continue;
    const sources = rule.scope === 'plant' ? [plant.source] : devices.map(d => d.source);
    for (const source of sources) {
      for (const metric of rule.metrics) out.push({ source, metric, key: column.key });
    }
  }
  return out;
}

function aggregate(agg, values) {
  if (values.length === 0) return null;
  if (agg === 'avg') return values.reduce((a, b) => a + b, 0) / values.length;
  if (agg === 'sum') return values.reduce((a, b) => a + b, 0);
  return values[0];
}

function round(v, digits = 3) {
  return v === null || !Number.isFinite(v) ? null : Number(v.toFixed(digits));
}

/**
 * Latest value per layout key from `samples` (newest usable sample per source
 * and metric, as returned by store.latestSamples). Samples older than the
 * staleness window are excluded so one dead device does not drag a plant sum;
 * the key then reports the newest excluded timestamp with `stale: true`.
 */
function computeCurrent(plant, inventory, samples, options = {}) {
  const now = options.now ?? Date.now();
  const staleMinutes = { ...DEFAULT_STALE_MINUTES, ...(options.staleMinutes || {}) };
  const byPair = new Map(samples.map(s => [`${s.source}\u001f${s.metric}`, s]));
  const pairs = pairsForPlant(plant, inventory);
  const values = {};
  const details = {};
  let newest = null;
  for (const column of LAYOUT) {
    const rule = column[plant.vendor];
    if (!rule) {
      values[column.key] = null;
      details[column.key] = { position: column.position, unit: column.unit, kind: column.kind, value: null, timestamp: null, samples: 0, stale: false, mapped: false };
      continue;
    }
    const limitMs = staleMinutes[column.kind] * 60_000;
    const fresh = [];
    let newestStale = null;
    for (const pair of pairs.filter(p => p.key === column.key)) {
      const s = byPair.get(`${pair.source}\u001f${pair.metric}`);
      if (!s || !Number.isFinite(s.value)) continue;
      const ts = Date.parse(s.timestamp);
      if (!Number.isFinite(ts)) continue;
      if (now - ts <= limitMs) fresh.push({ ...s, ts });
      else if (newestStale === null || ts > newestStale) newestStale = ts;
    }
    // One series per source per key: a device reporting the same quantity under
    // two metric names (string vs residential inverter) must not be counted twice.
    const perSource = new Map();
    for (const s of fresh) {
      const prev = perSource.get(s.source);
      if (!prev || s.ts > prev.ts) perSource.set(s.source, s);
    }
    const used = [...perSource.values()];
    const value = round(aggregate(rule.agg || 'first', used.map(s => s.value)));
    const timestamp = used.length ? new Date(Math.min(...used.map(s => s.ts))).toISOString() : (newestStale ? new Date(newestStale).toISOString() : null);
    if (used.length) {
      const maxTs = Math.max(...used.map(s => s.ts));
      if (newest === null || maxTs > newest) newest = maxTs;
    }
    values[column.key] = value;
    details[column.key] = {
      position: column.position, unit: column.unit, kind: column.kind,
      value, timestamp, samples: used.length,
      stale: used.length === 0 && newestStale !== null,
      mapped: true, verified: rule.verified !== false,
    };
  }
  return { values, details, timestamp: newest === null ? null : new Date(newest).toISOString() };
}

/** Per-bucket plant values from store.bucketedSeries rows; returns { stepSeconds, buckets: [{ bucket, values }] }. */
function computeHistory(plant, inventory, rows, stepSeconds) {
  const pairs = pairsForPlant(plant, inventory);
  const keyOf = new Map(pairs.map(p => [`${p.source}\u001f${p.metric}`, p.key]));
  const byBucket = new Map();
  for (const row of rows) {
    const key = keyOf.get(`${row.source}\u001f${row.metric}`);
    if (!key) continue;
    const column = LAYOUT.find(c => c.key === key);
    const perSource = row.source;
    const value = column.kind === 'gauge' ? row.avg : column.kind === 'daily' ? row.max : row.last;
    if (!Number.isFinite(value)) continue;
    if (!byBucket.has(row.bucket)) byBucket.set(row.bucket, new Map());
    const perKey = byBucket.get(row.bucket);
    if (!perKey.has(key)) perKey.set(key, new Map());
    const prev = perKey.get(key).get(perSource);
    // Two metric names for the same device quantity: keep one value per source.
    if (prev === undefined) perKey.get(key).set(perSource, value);
  }
  const buckets = [...byBucket.keys()].sort((a, b) => a - b).map((bucket) => {
    const values = {};
    for (const column of LAYOUT) {
      const rule = column[plant.vendor];
      const perSource = byBucket.get(bucket).get(column.key);
      values[column.key] = rule && perSource ? round(aggregate(rule.agg || 'first', [...perSource.values()])) : null;
    }
    return { bucket, timestamp: new Date(bucket * 1000).toISOString(), values };
  });
  return { stepSeconds, buckets };
}

/* ── Mars2 CustomDataExport wire format ───────────────────────────────────── */

/** 1.234 -> "1,234" (comma decimal like Mars2), null -> "" */
function formatExportValue(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  return String(v).replace('.', ',');
}

/** "CODE!ts;v1;...;v15<0xa>ts;..." exactly as Mars2 CustomDataExport/BIOS serves it (records end with the literal "0xa"). */
function formatExport(code, buckets) {
  const records = buckets.map(b => [b.bucket, ...LAYOUT.map(c => formatExportValue(b.values[c.key]))].join(';') + '0xa');
  return `${code}!${records.join('')}`;
}

/* ── HTTP ─────────────────────────────────────────────────────────────────── */

/** Mars2-style "yyyy-MM-dd HH:mm:ss" (UTC) or ISO 8601 -> Date */
function parseUtc(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseStep(raw, fallback = 300) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(86400, Math.max(60, Math.round(n)));
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCredentials(contentType, body) {
  if (/application\/json/i.test(contentType || '')) {
    try {
      const o = JSON.parse(body || '{}');
      return { userName: o.userName ?? o.username, password: o.password, grantType: o.grant_type ?? 'password' };
    } catch {
      return {};
    }
  }
  const p = new URLSearchParams(body || '');
  return { userName: p.get('userName') ?? p.get('username'), password: p.get('password'), grantType: p.get('grant_type') ?? 'password' };
}

/**
 * Handler factory. `store` provides listFeedInventory, latestSamples,
 * bucketedSeries; `state` is a shared object the server exposes on /freshness.
 * Returns an async (req, res, url, json, jsonText) => boolean handler; false
 * when the path is not a feed route.
 */
function createFeedHandler({ store, config, state, storeReady = () => true, log = () => {}, now = () => Date.now() }) {
  const inventoryCache = { at: 0, plants: null };
  const INVENTORY_TTL_MS = 5 * 60_000;

  async function inventory() {
    if (inventoryCache.plants && now() - inventoryCache.at < INVENTORY_TTL_MS) return inventoryCache.plants;
    const plants = await store.listFeedInventory();
    inventoryCache.plants = plants;
    inventoryCache.at = now();
    return plants;
  }

  function touch(path, ok) {
    state.requestsTotal = (state.requestsTotal || 0) + 1;
    if (ok) {
      state.lastRequestAt = new Date(now()).toISOString();
      state.lastRequestPath = path;
    } else {
      state.lastAuthFailureAt = new Date(now()).toISOString();
      state.authFailures = (state.authFailures || 0) + 1;
    }
  }

  function plantByCode(code) {
    return config.plants.find(p => p.code === code) || null;
  }

  function withInventory(plant, plants) {
    const inv = plants.find(p => p.source === plant.source) || null;
    return {
      code: plant.code, source: plant.source, vendor: plant.vendor,
      name: inv?.name || plant.code,
      capacityKwp: inv?.capacityKwp ?? null,
      visible: inv ? inv.visible : null,
      devices: inv?.devices || [],
      inventoryKnown: Boolean(inv),
    };
  }

  return async function handleFeed(req, res, url, json, jsonText) {
    if (!url.pathname.startsWith('/feed/') && url.pathname !== '/feed') return false;
    res.setHeader('Cache-Control', 'no-store');

    if (!config.configured) {
      json(res, 503, { error: 'feed not configured', detail: 'set FEED_USERNAME/FEED_PASSWORD or FEED_API_KEY' });
      return true;
    }

    if (url.pathname === '/feed/token') {
      if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return true; }
      let creds;
      try {
        creds = parseCredentials(req.headers['content-type'], await readBody(req));
      } catch (error) {
        json(res, 400, { error: error.message });
        return true;
      }
      const ok = config.username && creds.grantType === 'password'
        && constantTimeEqual(creds.userName, config.username) && constantTimeEqual(creds.password, config.password);
      if (!ok) {
        touch(url.pathname, false);
        json(res, 400, { error: 'invalid_grant', error_description: 'The user name or password is incorrect.' });
        return true;
      }
      state.lastTokenAt = new Date(now()).toISOString();
      json(res, 200, issueToken(config, now()));
      return true;
    }

    if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return true; }
    if (!isAuthorized(config, req.headers, now())) {
      touch(url.pathname, false);
      res.setHeader('WWW-Authenticate', 'Bearer realm="bios-feed"');
      json(res, 401, { error: 'unauthorized' });
      return true;
    }
    touch(url.pathname, true);

    if (!storeReady()) {
      res.setHeader('Retry-After', '30');
      json(res, 503, { error: 'database unavailable' });
      return true;
    }

    if (url.pathname === '/feed/plants') {
      const plants = await inventory();
      json(res, 200, {
        generatedAt: new Date(now()).toISOString(),
        layout: LAYOUT.map(c => ({ position: c.position, key: c.key, unit: c.unit, kind: c.kind })),
        plants: config.plants.map(p => withInventory(p, plants)),
      });
      return true;
    }

    const m = url.pathname.match(/^\/feed\/plants\/([A-Z0-9_-]+)\/(current|history|export)$/);
    if (!m) { json(res, 404, { error: 'not found' }); return true; }
    const plant = plantByCode(m[1]);
    if (!plant) { json(res, 404, { error: 'unknown plant code', codes: config.plants.map(p => p.code) }); return true; }
    const plants = await inventory();
    const full = withInventory(plant, plants);

    if (m[2] === 'current') {
      const pairs = pairsForPlant(plant, full);
      const samples = await store.latestSamples(pairs.map(p => ({ source: p.source, metric: p.metric })));
      const current = computeCurrent(plant, full, samples, { now: now(), staleMinutes: config.staleMinutes });
      json(res, 200, {
        code: full.code, name: full.name, vendor: full.vendor, source: full.source, capacityKwp: full.capacityKwp,
        generatedAt: new Date(now()).toISOString(),
        timestamp: current.timestamp,
        values: current.values,
        details: current.details,
        raw: samples,
      });
      return true;
    }

    // history / export share the bucketed read
    const isExport = m[2] === 'export';
    const from = parseUtc(url.searchParams.get(isExport ? 'fromUTC' : 'from'));
    const to = parseUtc(url.searchParams.get(isExport ? 'toUTC' : 'to')) || new Date(now());
    if (!from) { json(res, 400, { error: `${isExport ? 'fromUTC' : 'from'} is required (yyyy-MM-dd HH:mm:ss UTC or ISO 8601)` }); return true; }
    if (to <= from) { json(res, 400, { error: 'to must be after from' }); return true; }
    if (to - from > 31 * 86400_000) { json(res, 400, { error: 'window must be 31 days or less' }); return true; }
    const step = isExport ? parseStep(url.searchParams.get('step'), 300) : parseStep(url.searchParams.get('step'), 300);
    const pairs = pairsForPlant(plant, full);
    const rows = await store.bucketedSeries({ pairs: pairs.map(p => ({ source: p.source, metric: p.metric })), from: from.toISOString(), to: to.toISOString(), bucketSeconds: step });
    const history = computeHistory(plant, full, rows, step);
    if (isExport) {
      // Mars2 serves CustomDataExport as a JSON string literal; mirror that exactly.
      jsonText(res, 200, JSON.stringify(formatExport(plant.code, history.buckets)));
      return true;
    }
    json(res, 200, {
      code: full.code, name: full.name, vendor: full.vendor,
      from: from.toISOString(), to: to.toISOString(), stepSeconds: step,
      series: Object.fromEntries(LAYOUT.map(c => [c.key, history.buckets.map(b => ({ timestamp: b.timestamp, value: b.values[c.key] }))])),
    });
    return true;
  };
}

module.exports = {
  LAYOUT, TOKEN_TTL_SECONDS,
  parseFeedPlants, feedConfig, vendorOf,
  issueToken, verifyToken, isAuthorized,
  pairsForPlant, computeCurrent, computeHistory,
  formatExportValue, formatExport, parseUtc, parseStep, parseCredentials,
  createFeedHandler,
};
