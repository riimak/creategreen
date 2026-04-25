const http = require('http');
const { loadRecords, seriesFor, fieldsFor } = require('./bios-data');
const { forecast, anomalies } = require('./model');
const { createStore } = require('./store');

const PORT = Number(process.env.PREDICTION_PORT || 8091);
const MAX_HORIZON_HOURS = 48;
const store = createStore(process.env.PREDICTION_DB_PATH);

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
  };
}

async function runForecast(params) {
  const source = params.get('source') || params.get('station') || 'OS1BIOS';
  const metric = params.get('metric') || 'PM2_5';
  const horizon = Math.min(Number(params.get('horizon') || 24), MAX_HORIZON_HOURS);
  const hours = Number(params.get('hours') || 72);
  const records = await loadRecords({ source, hours, ...config() });
  const series = seriesFor(records, metric);
  const result = forecast(series, horizon);
  const artifact = {
    id: `forecast-${Date.now()}`,
    source,
    metric,
    input: {
      hours,
      count: series.length,
      from: series[0]?.timestamp || null,
      to: series[series.length - 1]?.timestamp || null,
    },
    computedAt: new Date().toISOString(),
    ...result,
  };
  store.append('forecasts', artifact);
  return artifact;
}

async function runAnomalies(params) {
  const source = params.get('source') || params.get('station') || 'OS1BIOS';
  const metric = params.get('metric') || 'PM2_5';
  const hours = Number(params.get('hours') || 24);
  const records = await loadRecords({ source, hours, ...config() });
  const series = seriesFor(records, metric);
  const artifact = {
    id: `anomalies-${Date.now()}`,
    source,
    metric,
    input: {
      hours,
      count: series.length,
      from: series[0]?.timestamp || null,
      to: series[series.length - 1]?.timestamp || null,
    },
    computedAt: new Date().toISOString(),
    anomalies: anomalies(series),
  };
  store.append('anomalies', artifact);
  return artifact;
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'prediction', store: store.file });
    }
    if (req.method === 'GET' && url.pathname === '/models') {
      return json(res, 200, {
        maxHorizonHours: MAX_HORIZON_HOURS,
        models: ['linear-regression', 'seasonal-hourly-baseline'],
        fields: {
          OS1BIOS: fieldsFor('OS1BIOS'),
          SOLAXBIOS: fieldsFor('SOLAXBIOS'),
        },
      });
    }
    if (req.method === 'GET' && url.pathname === '/forecast') {
      return json(res, 200, await runForecast(url.searchParams));
    }
    if (req.method === 'GET' && url.pathname === '/anomalies') {
      return json(res, 200, await runAnomalies(url.searchParams));
    }
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
}

function startScheduler() {
  const interval = Number(process.env.PREDICTION_INTERVAL_MINUTES || 0);
  const targets = (process.env.PREDICTION_TARGETS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!interval || targets.length === 0) return;

  setInterval(() => {
    for (const target of targets) {
      const [source, metric] = target.split(':');
      const params = new URLSearchParams({ source, metric: metric || 'PM2_5' });
      runForecast(params).catch(error => {
        store.append('runs', { id: `run-${Date.now()}`, target, status: 'failed', error: error.message });
      });
    }
  }, interval * 60 * 1000);
}

if (require.main === module) {
  startScheduler();
  http.createServer(handle).listen(PORT, () => {
    console.log(`Prediction service listening on http://localhost:${PORT}`);
  });
}

module.exports = { handle, runForecast, runAnomalies };
