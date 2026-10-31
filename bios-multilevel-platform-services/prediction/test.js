const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// server.js builds its store at require time; point the JSON store at a scratch
// file so the SLA checks below can seed data without touching the repo.
const scratchStore = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bios-prediction-test-')), 'prediction-store.json');
process.env.PREDICTION_DB_PATH = scratchStore;
delete process.env.DATABASE_URL;
// No live data source: the export-files fallback must point at an empty dir so
// the "live fetch required" assertions below are deterministic.
process.env.BIOS_OUTPUT_DIR = path.join(path.dirname(scratchStore), 'no-output');
delete process.env.BIOS_API_BASE;
delete process.env.BIOS_USERNAME;
delete process.env.BIOS_PASSWORD;
delete process.env.PREDICTION_DATA_API_BASE;
process.env.PREDICTION_INGEST_LOG = 'false';

const { parseExportText, seriesFor } = require('./bios-data');
const { forecast, anomalies } = require('./model');
const { dataQuality } = require('./server');
const { createStore } = require('./store');

const sample = [
  'OS1BIOS;TIMESTAMP;Temperatura;Relativna vlaznost;Brzina vjetra;Smjer vjetra;Suncevo zracenje;UV indeks;Tlak zraka;Kisa;CO;CO2;NO;NO2;O3;SO2;Lebdece cestice PM1;Lebdece cestice PM2.5;Lebdece cestice PM10;eaqi-traffic;CAQI;Buka;cumulative',
  'OS1BIOS;1717699200;20,1;55;;;;;;;200;;5;8;31;1;4;8;12;;20;50;',
  'OS1BIOS;1717702800;21,1;55;;;;;;;200;;5;8;31;1;4;9;13;;22;50;',
  'OS1BIOS;1717706400;22,1;55;;;;;;;200;;5;8;31;1;4;10;14;;24;50;',
  'OS1BIOS;1717710000;23,1;55;;;;;;;200;;5;8;31;1;4;30;35;;80;50;',
  'OS1BIOS;1717713600;24,1;55;;;;;;;200;;5;8;31;1;4;12;16;;26;50;',
  'OS1BIOS;1717717200;25,1;55;;;;;;;200;;5;8;31;1;4;13;17;;28;50;',
].join('\n');

const records = parseExportText(sample, 'OS1BIOS');
assert.strictEqual(records.length, 6);
assert.strictEqual(records[0].Temperatura, 20.1);

const series = seriesFor(records, 'PM2_5');
assert.strictEqual(series.length, 6);

const result = forecast(series, 2);
assert.ok(result.points.length >= 2);
assert.ok(result.horizonHours <= 48);
assert.ok(['linear-regression', 'seasonal-hourly-baseline'].includes(result.model));

const detected = anomalies(series);
assert.ok(Array.isArray(detected));

const quality = dataQuality({
  source: 'OS1BIOS',
  metric: 'PM2_5',
  hours: 24,
  records,
  series: series.slice(0, 2),
});
assert.strictEqual(quality.status, 'insufficient_data');
assert.ok(quality.input.missingRatio > 0);

const denseQuality = dataQuality({
  source: 'OS1BIOS',
  metric: 'PM2_5',
  hours: 24,
  records,
  series: [
    { timestamp: 1717699200, value: 4 },
    { timestamp: 1717699260, value: 9 },
  ],
});
assert.strictEqual(denseQuality.input.rawSamplePoints, 2);
assert.strictEqual(denseQuality.input.observedSamples, 1);

// /measurements/meta must expose every source that actually has rows in the
// database (e.g. dynamically discovered HUAWEI:* sources), not only the
// statically configured stations.
const { mergeStationLists, observedMetricList } = require('./server');

assert.deepStrictEqual(
  mergeStationLists(
    ['OS1BIOS', 'OS2BIOS', 'SOLAXBIOS'],
    [
      { source: 'SOLAXBIOS', rows: 10 },
      { source: 'HUAWEI:NE=2', rows: 5 },
      { source: 'HUAWEI:NE=1', rows: 5 },
      { source: 'HUAWEI:NE=1:device:42', rows: 5 },
    ],
  ),
  ['OS1BIOS', 'OS2BIOS', 'SOLAXBIOS', 'HUAWEI:NE=1', 'HUAWEI:NE=1:device:42', 'HUAWEI:NE=2'],
);
assert.deepStrictEqual(mergeStationLists(['A'], []), ['A']);
assert.deepStrictEqual(mergeStationLists(['A'], [{ source: '' }, { source: null }, {}]), ['A']);

assert.deepStrictEqual(
  observedMetricList([
    { metric: 'huawei.plant.daily_yield_kwh' },
    { metric: 'Temperatura' },
    { metric: 'huawei.plant.daily_yield_kwh' },
    { metric: '' },
  ]),
  ['Temperatura', 'huawei.plant.daily_yield_kwh'],
);
assert.deepStrictEqual(observedMetricList(undefined), []);

// /measurements/meta is expensive to compute (full-table stats scans), so the
// server must serve repeat requests within the TTL from cache.
const { measurementsMeta, slaSummary, cycleHealth, freshnessBody, runForecast, runAnomalies } = require('./server');

// Liveness: a cycle that outlives its deadline must make /health fail so the
// kubelet restarts the pod (this is the failure that went unnoticed for a week).
{
  const now = Date.parse('2026-10-31T12:00:00Z');
  const idle = cycleHealth({ running: false, cycleStartedAt: null, lastCycle: { finishedAt: '2026-10-31T11:55:00Z' } }, now);
  assert.strictEqual(idle.ok, true);
  assert.strictEqual(idle.cycleRunningMinutes, null);
  assert.strictEqual(idle.lastCycleFinishedAt, '2026-10-31T11:55:00Z');
  assert.strictEqual(idle.deadlineMinutes, 30, 'default deadline is max(30, 3 x interval)');

  const fresh = cycleHealth({ running: true, cycleStartedAt: '2026-10-31T11:50:00Z', lastCycle: null }, now);
  assert.strictEqual(fresh.ok, true);
  assert.strictEqual(fresh.cycleRunningMinutes, 10);

  const wedged = cycleHealth({ running: true, cycleStartedAt: '2026-10-24T07:30:00Z', lastCycle: null }, now);
  assert.strictEqual(wedged.ok, false);
  assert.strictEqual(wedged.reason, 'cycle_deadline_exceeded');
  assert.ok(wedged.cycleRunningMinutes > 7 * 24 * 60);

  process.env.PREDICTION_CYCLE_DEADLINE_MINUTES = '5';
  assert.strictEqual(cycleHealth({ running: true, cycleStartedAt: '2026-10-31T11:50:00Z', lastCycle: null }, now).ok, false);
  delete process.env.PREDICTION_CYCLE_DEADLINE_MINUTES;
}

// The cycle must be able to forecast and detect anomalies from rows already
// pulled for the station (no second Mars2 round-trip, no export files).
async function checkPreloadedRecords() {
  const params = new URLSearchParams({ source: 'OS1BIOS', metric: 'PM2_5', hours: '24', horizon: '2' });
  const artifact = await runForecast(params, { records });
  assert.strictEqual(artifact.source, 'OS1BIOS');
  assert.strictEqual(artifact.metric, 'PM2_5');
  assert.ok(['ok', 'insufficient_data'].includes(artifact.status));
  const anomaly = await runAnomalies(params, { records });
  assert.ok(Array.isArray(anomaly.anomalies));
  assert.strictEqual(anomaly.input.count, 6, 'anomalies must be computed from the preloaded rows');
  // Without preloaded rows and without any data source configured, the live path must fail loudly.
  await assert.rejects(runForecast(params), /export file missing|Mars2|prediction data API/);
}

async function checkFreshness() {
  const body = await freshnessBody();
  assert.strictEqual(body.service, 'prediction');
  assert.strictEqual(typeof body.ok, 'boolean');
  assert.strictEqual(body.db.ok, true);
  assert.deepStrictEqual(Object.keys(body.cycleHealth).sort(), ['cycleRunningMinutes', 'deadlineMinutes', 'lastCycleFinishedAt', 'ok', 'reason']);
  assert.deepStrictEqual(body.sources.map(s => s.source), ['OS1BIOS', 'OS2BIOS', 'SOLAXBIOS']);
  const solax = body.sources.find(s => s.source === 'SOLAXBIOS');
  assert.strictEqual(solax.solar, true);
  assert.strictEqual(solax.latestTs, null, 'json store has no raw measurements');
  assert.strictEqual(solax.ageMinutes, null);
  assert.strictEqual(solax.staleAfterMinutes, 720);
  assert.strictEqual(body.sources.find(s => s.source === 'OS1BIOS').staleAfterMinutes, 30);
}

// /sla must only consider data-quality rows inside the requested window and
// must work from the reduced projection returned by listDataQualityWindow
// (source, metric, status, computedAt, input.missingRatio) — the Postgres
// store selects just those columns instead of 10k full JSONB rows.
async function checkSlaWindow() {
  const seed = createStore(scratchStore);
  const now = Date.now();
  const at = (hoursAgo) => new Date(now - hoursAgo * 3600 * 1000).toISOString();
  const row = (source, metric, status, hoursAgo, missingRatio) => ({
    id: `quality-${source}-${metric}-${hoursAgo}`,
    source,
    metric,
    status,
    reasons: [],
    input: { missingRatio, hours: 72, expectedSamples: 10, observedSamples: 9 },
    metricInfo: { unit: 'x' },
    computedAt: at(hoursAgo),
  });
  seed.append('dataQuality', row('OS1BIOS', 'PM2_5', 'ok', 48, 0.1));      // outside 24h window
  seed.append('dataQuality', row('OS1BIOS', 'PM2_5', 'ok', 20, 0.2));
  seed.append('dataQuality', row('OS1BIOS', 'PM2_5', 'stale', 1, 0.5));
  seed.append('dataQuality', row('SOLAXBIOS', 'Grid_power_total', 'ok', 2, 0));

  const windowed = seed.listDataQualityWindow(at(24));
  assert.strictEqual(windowed.length, 3, 'window filter must drop the 48h-old row');
  assert.deepStrictEqual(Object.keys(windowed[0]).sort(), ['computedAt', 'input', 'metric', 'source', 'status']);
  assert.strictEqual(windowed[0].status, 'stale', 'newest first');

  const sla = await slaSummary(new URLSearchParams({ window: '24h' }));
  assert.strictEqual(sla.aggregate.totalCycles, 3);
  assert.strictEqual(sla.aggregate.stale, 1);
  assert.strictEqual(sla.aggregate.ok, 2);
  const os1 = sla.targets.find((t) => t.target === 'OS1BIOS:PM2_5');
  assert.ok(os1, 'per-target summary present');
  assert.strictEqual(os1.totalCycles, 2);
  assert.strictEqual(os1.lastStatus, 'stale');
  assert.strictEqual(os1.currentStaleStreak, 1);
  assert.strictEqual(os1.averageMissingRatio, 0.35);
  const solax = sla.sources.find((s) => s.source === 'SOLAXBIOS');
  assert.ok(solax && solax.status === 'ok');

  const weekly = await slaSummary(new URLSearchParams({ window: '7d' }));
  assert.strictEqual(weekly.aggregate.totalCycles, 4, '7d window includes the 48h-old row');
}

(async () => {
  const [first, second] = await Promise.all([measurementsMeta(), measurementsMeta()]);
  const third = await measurementsMeta();
  assert.strictEqual(second, first, 'concurrent meta requests must coalesce to one computation');
  assert.strictEqual(third, first, 'meta must be served from cache within the TTL');
  await checkSlaWindow();
  await checkPreloadedRecords();
  await checkFreshness();
  console.log('prediction tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(() => {
  fs.rmSync(path.dirname(scratchStore), { recursive: true, force: true });
});
