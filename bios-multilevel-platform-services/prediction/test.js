const assert = require('assert');
const { parseExportText, seriesFor } = require('./bios-data');
const { forecast, anomalies } = require('./model');
const { dataQuality } = require('./server');

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
const { measurementsMeta } = require('./server');

(async () => {
  const [first, second] = await Promise.all([measurementsMeta(), measurementsMeta()]);
  const third = await measurementsMeta();
  assert.strictEqual(second, first, 'concurrent meta requests must coalesce to one computation');
  assert.strictEqual(third, first, 'meta must be served from cache within the TTL');
  console.log('prediction tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
