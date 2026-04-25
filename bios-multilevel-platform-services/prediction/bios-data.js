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

async function loadFromWorker(baseUrl, source, hours) {
  const url = new URL('/api/data', baseUrl);
  url.searchParams.set('station', source);
  url.searchParams.set('hours', String(hours));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`prediction data API failed: ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.data) ? body.data : [];
}

async function loadRecords({ source, hours = 72, dataDir, apiBase }) {
  if (apiBase) return loadFromWorker(apiBase, source, hours);

  const dir = dataDir || path.resolve(process.cwd(), 'output');
  const file = fileForSource(dir, source);
  const text = fs.readFileSync(file, 'utf8');
  const cutoff = Math.floor(Date.now() / 1000) - Number(hours) * 3600;
  return parseExportText(text, source).filter(row => row.timestamp >= cutoff || row.timestamp < 2000000000);
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
