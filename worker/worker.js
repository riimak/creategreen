const API_BASE = 'http://web.mars2.barrage.net:81';

const METEO_FIELDS = [
  'Temperatura', 'Relativna vlaznost', 'Brzina vjetra', 'Smjer vjetra',
  'Suncevo zracenje', 'UV indeks', 'Tlak zraka', 'Kisa',
  'CO', 'CO2', 'NO', 'NO2', 'O3', 'SO2',
  'Lebdece cestice PM1', 'Lebdece cestice PM2.5', 'Lebdece cestice PM10',
  'eaqi-traffic', 'CAQI', 'Buka', 'cumulative'
];

const SOLAX_FIELDS = [
  'Grid.power.total', 'Grid.energy.toGrid.total', 'Grid.energy.fromGrid.total',
  'BMS.energy.SOC', 'Inverter.Meter2.AC.power.total',
  'Inverter.AC.EPS.power.R', 'Inverter.AC.EPS.power.S', 'Inverter.AC.EPS.power.T',
  'Inverter.DC.Battery.power.total',
  'Inverter.DC.PV.power.MPPT1', 'Inverter.DC.PV.power.MPPT2',
  'Inverter.DC.PV.power.MPPT3', 'Inverter.DC.PV.power.MPPT4',
  'Inverter.AC.power.total', 'Inverter.AC.energy.out.daily'
];

const VALID_STATIONS = { OS1BIOS: METEO_FIELDS, OS2BIOS: METEO_FIELDS, SOLAXBIOS: SOLAX_FIELDS };

let cachedToken = null;
let tokenExpiry = 0;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

async function getToken(env) {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const body = new URLSearchParams({
    userName: env.BIOS_USERNAME,
    password: env.BIOS_PASSWORD,
    grant_type: 'password',
  });

  const res = await fetch(`${API_BASE}/Token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function parseVal(s) {
  if (!s || s.trim() === '') return null;
  const n = parseFloat(s.replace(',', '.'));
  return isNaN(n) ? null : n;
}

function parseResponse(raw, fields) {
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  const parts = raw.split('!', 2);
  if (parts.length < 2) return [];

  const stationId = parts[0];
  const records = parts[1].split(/0xa|\n/).filter(r => r.trim());

  return records.map(rec => {
    const cols = rec.split(';');
    const ts = parseInt(cols[0], 10);
    if (isNaN(ts)) return null;

    const row = { station: stationId, timestamp: ts };
    for (let i = 0; i < fields.length; i++) {
      row[fields[i]] = parseVal(cols[i + 1]);
    }
    return row;
  }).filter(Boolean);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (url.pathname !== '/api') {
    return new Response(JSON.stringify({ error: 'Not found. Use /api?station=OS1BIOS&hours=24' }),
      { status: 404, headers: corsHeaders(origin) });
  }

  const station = url.searchParams.get('station');
  const hours = parseInt(url.searchParams.get('hours') || '24', 10);

  if (!station || !VALID_STATIONS[station]) {
    return new Response(JSON.stringify({
      error: `Invalid station. Valid: ${Object.keys(VALID_STATIONS).join(', ')}`,
    }), { status: 400, headers: corsHeaders(origin) });
  }

  if (hours < 1 || hours > 168) {
    return new Response(JSON.stringify({ error: 'hours must be 1-168' }),
      { status: 400, headers: corsHeaders(origin) });
  }

  const now = new Date();
  const from = new Date(now.getTime() - hours * 3600000);
  const fmt = d => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

  const token = await getToken(env);
  const apiUrl = `${API_BASE}/api/public/CustomDataExport/BIOS/${station}`
    + `?fromUTC=${encodeURIComponent(fmt(from))}&toUTC=${encodeURIComponent(fmt(now))}`;

  const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    if (res.status === 401) { cachedToken = null; tokenExpiry = 0; }
    return new Response(JSON.stringify({ error: `API error: ${res.status}` }),
      { status: 502, headers: corsHeaders(origin) });
  }

  const raw = await res.text();
  const fields = VALID_STATIONS[station];
  const data = parseResponse(raw, fields);

  return new Response(JSON.stringify({
    station,
    fields,
    count: data.length,
    from: fmt(from),
    to: fmt(now),
    data,
  }), { headers: corsHeaders(origin) });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      const origin = request.headers.get('Origin');
      return new Response(JSON.stringify({ error: e.message }),
        { status: 500, headers: corsHeaders(origin) });
    }
  },
};
