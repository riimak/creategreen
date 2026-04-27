const fs = require('fs');
const path = require('path');

const METEO_FIELDS = [
  'Temperatura', 'Relativna_vlaznost', 'Brzina_vjetra', 'Smjer_vjetra',
  'Suncevo_zracenje', 'UV_indeks', 'Tlak_zraka', 'Kisa', 'CO', 'CO2',
  'NO', 'NO2', 'O3', 'SO2', 'PM1', 'PM2_5', 'PM10', 'eaqi_traffic',
  'CAQI', 'Buka', 'cumulative',
];

const SOLAX_FIELDS = [
  'Grid_power_total', 'Grid_energy_toGrid_total', 'Grid_energy_fromGrid_total',
  'BMS_energy_SOC', 'Inverter_Meter2_AC_power_total', 'Inverter_AC_EPS_power_R',
  'Inverter_AC_EPS_power_S', 'Inverter_AC_EPS_power_T',
  'Inverter_DC_Battery_power_total', 'Inverter_DC_PV_power_MPPT1',
  'Inverter_DC_PV_power_MPPT2', 'Inverter_DC_PV_power_MPPT3',
  'Inverter_DC_PV_power_MPPT4', 'Inverter_AC_power_total',
  'Inverter_AC_energy_out_daily',
];

function fieldsFor(source) {
  return String(source || '').toUpperCase().startsWith('SOLAX') ? SOLAX_FIELDS : METEO_FIELDS;
}

function parseNumber(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = Number.parseFloat(String(raw).replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function parseExportText(text, source) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  const fields = fieldsFor(source);
  const records = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(';');
    const station = cols.shift();
    const timestamp = Number.parseInt(cols.shift(), 10);
    if (!Number.isFinite(timestamp)) continue;

    const row = { source: station, timestamp };
    fields.forEach((field, index) => {
      row[field] = parseNumber(cols[index]);
    });
    records.push(row);
  }

  return records.sort((a, b) => a.timestamp - b.timestamp);
}

function fileForSource(dir, source) {
  return path.join(dir, `${String(source).toLowerCase()}-measurements.txt`);
}

function ingestLogEnabled() {
  return process.env.PREDICTION_INGEST_LOG !== 'false';
}

/** Host only — never log credentials or full URLs with tokens. */
function mars2Host(apiBase) {
  try {
    return new URL(apiBase).host || 'unknown';
  } catch {
    return 'invalid-url';
  }
}

async function loadFromWorker(baseUrl, source, hours) {
  const url = new URL('/api/data', baseUrl);
  url.searchParams.set('station', source);
  url.searchParams.set('hours', String(hours));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`prediction data API failed: ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.data) ? body.data : [];
}

let mars2Token = null;
let mars2TokenExpiry = 0;

async function getMars2Token(apiBase, username, password) {
  if (mars2Token && Date.now() < mars2TokenExpiry) return mars2Token;
  const body = new URLSearchParams({
    userName: username, password, grant_type: 'password',
  });
  const res = await fetch(`${apiBase}/Token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    if (ingestLogEnabled()) {
      console.error(`${new Date().toISOString()} prediction mars2: auth FAILED status=${res.status} host=${mars2Host(apiBase)}`);
    }
    throw new Error(`Mars2 auth failed: ${res.status}`);
  }
  const d = await res.json();
  mars2Token = d.access_token;
  mars2TokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  if (ingestLogEnabled()) {
    console.log(
      `${new Date().toISOString()} prediction mars2: auth OK host=${mars2Host(apiBase)} tokenTTL=${Number(d.expires_in) || '?'}s`,
    );
  }
  return mars2Token;
}

async function loadFromMars2(apiBase, username, password, source, hours) {
  const token = await getMars2Token(apiBase, username, password);
  const now = new Date();
  const from = new Date(now.getTime() - hours * 3600000);
  const fmt = d => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const url = `${apiBase}/api/public/CustomDataExport/BIOS/${encodeURIComponent(source)}`
    + `?fromUTC=${encodeURIComponent(fmt(from))}&toUTC=${encodeURIComponent(fmt(now))}`;
  if (ingestLogEnabled()) {
    console.log(
      `${new Date().toISOString()} prediction mars2: GET CustomDataExport station=${source} windowHours=${hours} fromUTC=${fmt(from)} host=${mars2Host(apiBase)}`,
    );
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    mars2Token = null;
    mars2TokenExpiry = 0;
    if (ingestLogEnabled()) {
      console.warn(`${new Date().toISOString()} prediction mars2: HTTP 401 for station=${source}, token cleared — retry will re-auth`);
    }
  }
  if (!res.ok) {
    if (ingestLogEnabled()) {
      console.error(`${new Date().toISOString()} prediction mars2: export FAILED station=${source} status=${res.status} host=${mars2Host(apiBase)}`);
    }
    throw new Error(`Mars2 API failed for ${source}: ${res.status}`);
  }
  const raw = await res.text();
  if (!raw || raw === '""') {
    if (ingestLogEnabled()) {
      console.warn(`${new Date().toISOString()} prediction mars2: empty body station=${source} host=${mars2Host(apiBase)}`);
    }
    return [];
  }
  const fields = fieldsFor(source);
  let text = raw;
  if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  const parts = text.split('!', 2);
  if (parts.length < 2) {
    if (ingestLogEnabled()) {
      console.warn(`${new Date().toISOString()} prediction mars2: no payload delimiter station=${source} host=${mars2Host(apiBase)} bodyChars=${text.length}`);
    }
    return [];
  }
  const rows = parts[1].split(/0xa|\n/).filter(r => r.trim()).map(rec => {
    const cols = rec.split(';');
    const ts = parseInt(cols[0], 10);
    if (isNaN(ts)) return null;
    const row = { source, timestamp: ts };
    for (let i = 0; i < fields.length; i++) row[fields[i]] = parseNumber(cols[i + 1]);
    return row;
  }).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);

  if (ingestLogEnabled()) {
    const tMin = rows[0]?.timestamp;
    const tMax = rows[rows.length - 1]?.timestamp;
    const range =
      tMin && tMax
        ? `${new Date(tMin * 1000).toISOString()} .. ${new Date(tMax * 1000).toISOString()}`
        : 'none';
    console.log(
      `${new Date().toISOString()} prediction mars2: parsed station=${source} rows=${rows.length} sampleRange=${range}`,
    );
  }
  return rows;
}

async function loadRecords({ source, hours = 72, dataDir, apiBase, mars2ApiBase, mars2Username, mars2Password }) {
  let records;
  let mode;
  if (mars2ApiBase && mars2Username && mars2Password) {
    mode = 'mars2-api';
    try {
      records = await loadFromMars2(mars2ApiBase, mars2Username, mars2Password, source, hours);
    } catch (err) {
      if (ingestLogEnabled()) {
        console.error(`${new Date().toISOString()} prediction ingest: mars2-api FAILED source=${source} ${err.message}`);
      }
      throw err;
    }
  } else if (apiBase) {
    mode = 'prediction-data-api';
    records = await loadFromWorker(apiBase, source, hours);
  } else {
    mode = 'export-files';
    const dir = dataDir || path.resolve(process.cwd(), 'output');
    const file = fileForSource(dir, source);
    if (!fs.existsSync(file)) {
      // Without BIOS_API_BASE/USERNAME/PASSWORD this is the silent failure mode:
      // expandTargets() catches and drops the station, leaving runCycle with 0 targets.
      if (ingestLogEnabled()) {
        console.error(
          `${new Date().toISOString()} prediction ingest: export-files MISSING source=${source} file=${file} — set BIOS_API_BASE/BIOS_USERNAME/BIOS_PASSWORD or PREDICTION_DATA_API_BASE`,
        );
      }
      throw new Error(`export file missing for ${source}: ${file}`);
    }
    const text = fs.readFileSync(file, 'utf8');
    const cutoff = Math.floor(Date.now() / 1000) - Number(hours) * 3600;
    records = parseExportText(text, source).filter(row => row.timestamp >= cutoff || row.timestamp < 2000000000);
  }
  if (ingestLogEnabled()) {
    console.log(`${new Date().toISOString()} prediction ingest: summary source=${source} rows=${records.length} mode=${mode}`);
  }
  return records;
}

function seriesFor(records, metric) {
  return records
    .map(row => ({ timestamp: row.timestamp, value: row[metric] }))
    .filter(point => Number.isFinite(point.value))
    .sort((a, b) => a.timestamp - b.timestamp);
}

module.exports = {
  METEO_FIELDS,
  SOLAX_FIELDS,
  fieldsFor,
  parseExportText,
  loadRecords,
  seriesFor,
};
