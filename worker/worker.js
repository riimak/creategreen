const API_BASE = 'http://web.mars2.barrage.net:81';

let cachedToken = null;
let tokenExpiry = 0;
let cachedPlaces = null;
let placesExpiry = 0;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

function json(data, origin, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors(origin) });
}

async function getToken(env) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const body = new URLSearchParams({
    userName: env.BIOS_USERNAME, password: env.BIOS_PASSWORD, grant_type: 'password',
  });
  const res = await fetch(`${API_BASE}/Token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token failed: ${res.status}`);
  const d = await res.json();
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return cachedToken;
}

async function apiGet(path, token) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) { cachedToken = null; tokenExpiry = 0; }
  return res;
}

function parseVal(s) {
  if (!s || s.trim() === '') return null;
  const n = parseFloat(s.replace(',', '.'));
  return isNaN(n) ? null : n;
}

function parseExport(raw, fields) {
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  const parts = raw.split('!', 2);
  if (parts.length < 2) return [];
  const sid = parts[0];
  return parts[1].split(/0xa|\n/).filter(r => r.trim()).map(rec => {
    const cols = rec.split(';');
    const ts = parseInt(cols[0], 10);
    if (isNaN(ts)) return null;
    const row = { station: sid, timestamp: ts };
    for (let i = 0; i < fields.length; i++) row[fields[i]] = parseVal(cols[i + 1]);
    return row;
  }).filter(Boolean);
}

// ── /api/places — station tree with variables ───────────────────────
async function handlePlaces(token, origin) {
  if (cachedPlaces && Date.now() < placesExpiry) return json(cachedPlaces, origin);

  const res = await apiGet(
    '/api/public/MeasurementPlaces?includeMetadata=false&includeChildren=true&includeDevice=true',
    token
  );
  if (!res.ok) return json({ error: `API ${res.status}` }, origin, 502);
  const raw = await res.json();

  const places = raw.map(p => ({
    nodeId: p.nodeId,
    name: p.nodeName,
    code: p.code,
    description: p.description,
    points: (p.measurementPoints || []).map(mp => ({
      nodeId: mp.nodeId,
      name: mp.nodeName,
      device: mp.device ? {
        nodeId: mp.device.nodeId,
        name: mp.device.nodeName,
        model: mp.device.model,
        serial: mp.device.serialNumber,
        type: mp.device.type?.name,
      } : null,
      variables: (mp.variables || []).map(v => ({
        nodeId: v.nodeId,
        name: v.nodeName,
        unit: v.measurementUnit,
        type: v.type,
        dataType: v.dataType,
      })),
    })),
  }));

  cachedPlaces = places;
  placesExpiry = Date.now() + 300000;
  return json(places, origin);
}

// ── /api/last — latest value for a variable ─────────────────────────
async function handleLast(params, token, origin) {
  const ids = params.get('ids');
  if (!ids) return json({ error: 'ids parameter required (comma-separated variable nodeIds)' }, origin, 400);

  const nodeIds = ids.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  if (nodeIds.length === 0) return json({ error: 'no valid ids' }, origin, 400);
  if (nodeIds.length > 50) return json({ error: 'max 50 ids per request' }, origin, 400);

  const results = await Promise.all(nodeIds.map(async (id) => {
    try {
      const res = await apiGet(`/api/public/Variables/${id}/data/last`, token);
      if (!res.ok) return { nodeId: id, error: res.status };
      const d = await res.json();
      if (!d || d.timestamp === undefined) return { nodeId: id, value: null };
      return { nodeId: id, timestamp: d.timestamp, value: d.value };
    } catch { return { nodeId: id, error: 'failed' }; }
  }));

  return json(results, origin);
}

// ── /api/alarms — alarms in time range ──────────────────────────────
async function handleAlarms(params, token, origin) {
  const hours = parseInt(params.get('hours') || '24', 10);
  const now = new Date();
  const from = new Date(now.getTime() - hours * 3600000);
  const fmt = d => d.toISOString();
  const status = params.get('status') || '';

  let url = `/api/public/Alarms?from=${encodeURIComponent(fmt(from))}&to=${encodeURIComponent(fmt(now))}`;
  if (status) url += `&status=${encodeURIComponent(status)}`;

  const res = await apiGet(url, token);
  if (!res.ok) return json({ error: `API ${res.status}` }, origin, 502);
  return json(await res.json(), origin);
}

// ── /api/devices — device inventory ─────────────────────────────────
async function handleDevices(token, origin) {
  const res = await apiGet(
    '/api/public/Devices?includeParameters=true&includeMetadata=false&includeCounters=true',
    token
  );
  if (!res.ok) return json({ error: `API ${res.status}` }, origin, 502);
  const raw = await res.json();

  const devices = raw.map(d => ({
    nodeId: d.nodeId,
    name: d.nodeName,
    model: d.model,
    serial: d.serialNumber,
    active: d.isActive,
    type: d.type?.name,
    counters: (d.counters || []).map(c => ({
      nodeId: c.nodeId,
      name: c.nodeName,
      unit: c.measurementUnitName,
      lastValue: c.lastReadValue,
      lastRead: c.lastRead,
    })),
  }));

  return json(devices, origin);
}

// ── /api/data — time-series via CustomDataExport ────────────────────
async function handleData(params, token, origin) {
  const station = params.get('station');
  if (!station) return json({ error: 'station parameter required' }, origin, 400);

  const hours = parseInt(params.get('hours') || '24', 10);
  if (hours < 1 || hours > 744) return json({ error: 'hours must be 1-744' }, origin, 400);

  const now = new Date();
  const from = new Date(now.getTime() - hours * 3600000);
  const fmt = d => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

  const res = await apiGet(
    `/api/public/CustomDataExport/BIOS/${encodeURIComponent(station)}`
    + `?fromUTC=${encodeURIComponent(fmt(from))}&toUTC=${encodeURIComponent(fmt(now))}`,
    token
  );
  if (!res.ok) return json({ error: `API ${res.status} for station ${station}` }, origin, 502);

  const raw = await res.text();
  if (!raw || raw === '""') return json({ station, fields: [], count: 0, data: [] }, origin);

  // Discover fields from the places cache or parse raw
  let fields = [];
  if (cachedPlaces) {
    const place = cachedPlaces.find(p => p.code === station);
    if (place?.points?.[0]?.variables) {
      fields = place.points[0].variables.map(v => v.name);
    }
  }

  const data = parseExport(raw, fields);

  return json({ station, fields, count: data.length, from: fmt(from), to: fmt(now), data }, origin);
}

// ── router ──────────────────────────────────────────────────────────
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(origin) });
  }

  const token = await getToken(env);
  const params = url.searchParams;

  switch (url.pathname) {
    case '/api/places':  return handlePlaces(token, origin);
    case '/api/last':    return handleLast(params, token, origin);
    case '/api/alarms':  return handleAlarms(params, token, origin);
    case '/api/devices': return handleDevices(token, origin);
    case '/api/data':    return handleData(params, token, origin);
    case '/api':         return handleData(params, token, origin);
    default:
      return json({
        endpoints: {
          '/api/places': 'GET — station tree (cached 5 min)',
          '/api/data?station=OS1BIOS&hours=24': 'GET — time-series measurements',
          '/api/last?ids=307,308,309': 'GET — latest value per variable',
          '/api/alarms?hours=24&status=Open': 'GET — alarms',
          '/api/devices': 'GET — device inventory with counters',
        }
      }, origin, 404);
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      const origin = request.headers.get('Origin');
      return json({ error: e.message }, origin, 500);
    }
  },
};
