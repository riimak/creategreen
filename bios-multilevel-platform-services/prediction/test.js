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
const { dataQuality, parseBucketSeconds } = require('./server');
const { createStore } = require('./store');
const feed = require('./feed');

/* ── Feed API (Mars2 pulls the vendor plants from us) ────────────────────── */
{
  const plants = feed.parseFeedPlants('SOKO46=HUAWEI:NE=201410062, VETINST=SOLIS:1298491919450654168');
  assert.deepStrictEqual(plants, [
    { code: 'SOKO46', source: 'HUAWEI:NE=201410062', vendor: 'huawei' },
    { code: 'VETINST', source: 'SOLIS:1298491919450654168', vendor: 'solis' },
  ]);
  assert.deepStrictEqual(feed.parseFeedPlants(''), []);
  assert.throws(() => feed.parseFeedPlants('bad'), /CODE=SOURCE/);
  assert.throws(() => feed.parseFeedPlants('X=HUAWEI:1'), /3-32 chars/);
  assert.throws(() => feed.parseFeedPlants('ABC=SOLAX:1'), /HUAWEI: or SOLIS:/);
  assert.throws(() => feed.parseFeedPlants('ABC=HUAWEI:1,ABC=HUAWEI:2'), /listed twice/);

  assert.strictEqual(feed.LAYOUT.length, 15, 'SOLAXBIOS layout has 15 columns');
  assert.deepStrictEqual(feed.LAYOUT.map(c => c.position), Array.from({ length: 15 }, (_, i) => i + 1));
  assert.strictEqual(feed.LAYOUT[13].key, 'Inverter.AC.power.total');
  assert.strictEqual(feed.LAYOUT[14].key, 'Inverter.AC.energy.out.daily');

  // Tokens: issued for the configured user, rejected when tampered or expired.
  const cfg = feed.feedConfig({ FEED_USERNAME: 'mars2', FEED_PASSWORD: 'pw-secret', FEED_PLANTS: '' });
  assert.strictEqual(cfg.configured, true);
  const t0 = Date.parse('2026-11-08T12:00:00Z');
  const issued = feed.issueToken(cfg, t0);
  assert.strictEqual(issued.token_type, 'bearer');
  assert.strictEqual(issued.expires_in, feed.TOKEN_TTL_SECONDS);
  assert.ok(feed.verifyToken(cfg, issued.access_token, t0 + 3600_000));
  assert.ok(!feed.verifyToken(cfg, issued.access_token, t0 + (feed.TOKEN_TTL_SECONDS + 1) * 1000), 'expired');
  assert.ok(!feed.verifyToken(cfg, issued.access_token.slice(0, -2) + 'xx', t0), 'tampered signature');
  const other = feed.feedConfig({ FEED_USERNAME: 'mars2', FEED_PASSWORD: 'different', FEED_PLANTS: '' });
  assert.ok(!feed.verifyToken(other, issued.access_token, t0), 'different secret');
  assert.ok(feed.isAuthorized(cfg, { authorization: `Bearer ${issued.access_token}` }, t0));
  assert.ok(!feed.isAuthorized(cfg, { authorization: 'Bearer nope' }, t0));
  assert.ok(!feed.isAuthorized(cfg, { 'x-feed-key': 'anything' }, t0), 'no api key configured');
  const keyed = feed.feedConfig({ FEED_API_KEY: 'k-1234567890', FEED_PLANTS: '' });
  assert.ok(keyed.configured);
  assert.ok(feed.isAuthorized(keyed, { 'x-feed-key': 'k-1234567890' }, t0));
  assert.ok(!feed.isAuthorized(keyed, { 'x-feed-key': 'k-123456789X' }, t0));
  assert.strictEqual(feed.feedConfig({ FEED_PLANTS: '' }).configured, false, 'no credentials -> disabled');

  // Current values: plant-level metrics, device sums, staleness, unmapped columns.
  const huawei = { code: 'SOKO46', source: 'HUAWEI:NE=1', vendor: 'huawei' };
  const inventory = { devices: [{ source: 'HUAWEI:NE=1:device:A' }, { source: 'HUAWEI:NE=1:device:B' }, { source: 'HUAWEI:NE=1:device:M' }] };
  const now = Date.parse('2026-11-08T12:00:00Z');
  const at = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
  const samples = [
    { source: 'HUAWEI:NE=1', metric: 'huawei.plant.daily_yield_kwh', value: 123.4, timestamp: at(10) },
    { source: 'HUAWEI:NE=1:device:A', metric: 'huawei.string_inverter.active_power_kw', value: 10.5, timestamp: at(5) },
    { source: 'HUAWEI:NE=1:device:B', metric: 'huawei.string_inverter.active_power_kw', value: 7.25, timestamp: at(6) },
    { source: 'HUAWEI:NE=1:device:B', metric: 'huawei.residential_inverter.active_power_kw', value: 99, timestamp: at(6) }, // same device twice -> counted once
    { source: 'HUAWEI:NE=1:device:M', metric: 'huawei.grid_meter.active_power_kw', value: -3.1, timestamp: at(200) },     // stale gauge
    { source: 'HUAWEI:NE=1:device:M', metric: 'huawei.grid_meter.positive_active_energy_kwh', value: 5000, timestamp: at(200) }, // counters tolerate 26 h
  ];
  const current = feed.computeCurrent(huawei, inventory, samples, { now });
  assert.strictEqual(current.values['Inverter.AC.energy.out.daily'], 123.4);
  assert.strictEqual(current.values['Inverter.AC.power.total'], 17.75, 'sum across devices, one value per device');
  assert.strictEqual(current.values['Grid.power.total'], null, 'stale gauge excluded');
  assert.strictEqual(current.details['Grid.power.total'].stale, true);
  assert.strictEqual(current.details['Grid.power.total'].timestamp, at(200));
  assert.strictEqual(current.values['Grid.energy.toGrid.total'], 5000, 'cumulative counter within 26 h window');
  assert.strictEqual(current.details['Grid.energy.toGrid.total'].verified, true, 'feed-in direction verified against SOLAXBIOS night data');
  assert.strictEqual(current.details['Inverter.DC.Battery.power.total'].verified, false, 'battery sign convention still unverified');
  assert.strictEqual(current.values['Inverter.DC.PV.power.MPPT1'], null);
  assert.strictEqual(current.details['Inverter.DC.PV.power.MPPT1'].mapped, false);
  assert.strictEqual(current.details['Inverter.AC.power.total'].timestamp, at(6), 'oldest used sample is the honest timestamp');
  assert.strictEqual(current.timestamp, at(5));
  assert.strictEqual(Object.keys(current.values).length, 15);

  const solis = { code: 'VETINST', source: 'SOLIS:9', vendor: 'solis' };
  const solisInv = { devices: [{ source: 'SOLIS:9:device:S1' }, { source: 'SOLIS:9:device:S2' }] };
  const solisCurrent = feed.computeCurrent(solis, solisInv, [
    { source: 'SOLIS:9', metric: 'solis.plant.current_power_kw', value: 4.2, timestamp: at(3) },
    { source: 'SOLIS:9', metric: 'solis.plant.total_grid_sell_kwh', value: 777, timestamp: at(3) },
    { source: 'SOLIS:9:device:S1', metric: 'solis.inverter.battery_soc_percent', value: 40, timestamp: at(3) },
    { source: 'SOLIS:9:device:S2', metric: 'solis.inverter.battery_soc_percent', value: 60, timestamp: at(4) },
  ], { now });
  assert.strictEqual(solisCurrent.values['Inverter.AC.power.total'], 4.2, 'solis uses the plant-level power');
  assert.strictEqual(solisCurrent.values['Grid.energy.toGrid.total'], 777);
  assert.strictEqual(solisCurrent.values['BMS.energy.SOC'], 50, 'SOC averaged across devices');
  assert.strictEqual(solisCurrent.values['Grid.power.total'], null, 'solis has no plant grid power');

  // History: gauge avg summed across devices, daily counter max, cumulative last.
  const rows = [
    { source: 'HUAWEI:NE=1:device:A', metric: 'huawei.string_inverter.active_power_kw', bucket: 1000, avg: 1, max: 2, last: 1.5, count: 3 },
    { source: 'HUAWEI:NE=1:device:B', metric: 'huawei.string_inverter.active_power_kw', bucket: 1000, avg: 2, max: 3, last: 2.5, count: 3 },
    { source: 'HUAWEI:NE=1', metric: 'huawei.plant.daily_yield_kwh', bucket: 1000, avg: 10, max: 12, last: 11, count: 3 },
    { source: 'HUAWEI:NE=1:device:M', metric: 'huawei.grid_meter.positive_active_energy_kwh', bucket: 1000, avg: 100, max: 101, last: 101, count: 3 },
    { source: 'HUAWEI:NE=1', metric: 'huawei.plant.daily_yield_kwh', bucket: 1300, avg: 20, max: 25, last: 24, count: 3 },
  ];
  const history = feed.computeHistory(huawei, inventory, rows, 300);
  assert.strictEqual(history.buckets.length, 2);
  assert.strictEqual(history.buckets[0].values['Inverter.AC.power.total'], 3);
  assert.strictEqual(history.buckets[0].values['Inverter.AC.energy.out.daily'], 12);
  assert.strictEqual(history.buckets[0].values['Grid.energy.toGrid.total'], 101);
  assert.strictEqual(history.buckets[1].values['Inverter.AC.power.total'], null);
  assert.strictEqual(history.buckets[1].values['Inverter.AC.energy.out.daily'], 25);

  // Mars2 CustomDataExport wire format: comma decimals, empty for null, "0xa" record terminator.
  const wire = feed.formatExport('SOKO46', history.buckets);
  // 15 positions: toGrid at 2, AC power at 14, daily energy at 15; everything else empty.
  const record0 = ['1000', '', '101', ...Array(11).fill(''), '3', '12'].join(';') + '0xa';
  assert.ok(wire.startsWith(`SOKO46!${record0}1300;`), wire);
  assert.ok(wire.endsWith(';250xa'), wire);
  assert.strictEqual(feed.formatExportValue(-4.252), '-4,252');
  assert.strictEqual(feed.formatExportValue(null), '');
  assert.strictEqual(wire.split('0xa').length - 1, 2, 'one terminator per record');

  assert.strictEqual(feed.parseUtc('2026-11-08 10:00:00').toISOString(), '2026-11-08T10:00:00.000Z', 'Mars2 fromUTC format is UTC');
  assert.strictEqual(feed.parseUtc('2026-11-08T10:00:00Z').toISOString(), '2026-11-08T10:00:00.000Z');
  assert.strictEqual(feed.parseUtc('nonsense'), null);
  assert.strictEqual(feed.parseStep('10'), 60, 'step floor 60 s');
  assert.strictEqual(feed.parseStep(undefined), 300);
  assert.deepStrictEqual(feed.parseCredentials('application/x-www-form-urlencoded', 'userName=a&password=b&grant_type=password'), { userName: 'a', password: 'b', grantType: 'password' });
  assert.deepStrictEqual(feed.parseCredentials('application/json', '{"userName":"a","password":"b"}'), { userName: 'a', password: 'b', grantType: 'password' });

  // ── Vendor dialects: Solax Cloud getRealtimeInfo and Solarman currentData ──
  // Every export column has a Solax field, in the genuine Solax spelling, plus yieldtotal.
  assert.deepStrictEqual(
    feed.LAYOUT.map(c => c.key).filter(k => !feed.SOLAX_FIELDS.some(f => f.key === k)), [],
    'every layout column maps to a Solax field');
  assert.strictEqual(feed.SOLAX_FIELDS.length, 16);
  assert.ok(feed.SOLAX_FIELDS.some(f => f.field === 'yieldtotal' && f.key === 'Inverter.AC.energy.out.total'));
  const columns = [...feed.LAYOUT, ...feed.EXTRAS];
  const withTotal = feed.computeCurrent(huawei, inventory, [...samples,
    { source: 'HUAWEI:NE=1', metric: 'huawei.plant.total_yield_kwh', value: 98765.4, timestamp: at(10) }], { now, columns });
  assert.strictEqual(withTotal.values['Inverter.AC.energy.out.total'], 98765.4, 'extras are read when asked for');
  assert.strictEqual(feed.computeCurrent(huawei, inventory, samples, { now }).values['Inverter.AC.energy.out.total'], undefined, '/current stays 15 columns');

  const solax = feed.formatSolaxRealtime(huawei, withTotal, { powerUnit: 'W', empty: 'null', timeZone: 'UTC' });
  assert.strictEqual(solax.success, true);
  assert.strictEqual(solax.exception, 'Query success!');
  assert.strictEqual(solax.result.sn, 'SOKO46');
  assert.strictEqual(solax.result.inverterSN, 'HUAWEI:NE=1');
  assert.strictEqual(solax.result.acpower, 17750, 'kW -> W like Solax Cloud');
  assert.strictEqual(solax.result.yieldtoday, 123.4, 'energy stays kWh');
  assert.strictEqual(solax.result.yieldtotal, 98765.4);
  assert.strictEqual(solax.result.feedinenergy, 5000);
  assert.strictEqual(solax.result.feedinpower, null, 'stale gauge is null, never 0');
  assert.strictEqual(solax.result.powerdc3, null);
  assert.strictEqual(solax.result.uploadTime, '2026-11-08 11:55:00', 'newest used sample, naive wall clock');
  assert.strictEqual(solax.result.inverterStatus, '102');
  assert.strictEqual(typeof solax.result.inverterType, 'string');
  assert.strictEqual(feed.formatSolaxRealtime(huawei, withTotal, { powerUnit: 'kW', empty: 'null', timeZone: 'UTC' }).result.acpower, 17.75);
  assert.strictEqual(feed.formatSolaxRealtime(huawei, withTotal, { empty: 'zero', timeZone: 'UTC' }).result.feedinpower, 0);
  assert.ok(!('feedinpower' in feed.formatSolaxRealtime(huawei, withTotal, { empty: 'omit', timeZone: 'UTC' }).result), 'omit drops the field');
  assert.strictEqual(feed.formatNaiveTime(new Date('2026-07-01T10:00:00Z'), 'Europe/Zagreb'), '2026-07-01 12:00:00', 'CEST');
  assert.strictEqual(feed.formatNaiveTime(new Date('2026-11-08T19:45:03Z'), 'Europe/Zagreb'), '2026-11-08 20:45:03', 'CET');
  const noData = feed.formatSolaxRealtime(huawei, feed.computeCurrent(huawei, inventory, [], { now, columns }), {});
  assert.deepStrictEqual(noData, { success: false, exception: 'no data', result: null }, 'Solax-style query failure when nothing is fresh');

  const t1 = feed.feedConfig({ FEED_USERNAME: 'mars2', FEED_PASSWORD: 'pw-secret', FEED_API_KEY: 'k-1234567890', FEED_PLANTS: '' });
  assert.ok(feed.tokenIdAuthorized(t1, 'k-1234567890', t0), 'tokenId = static key');
  assert.ok(feed.tokenIdAuthorized(t1, feed.issueToken(t1, t0).access_token, t0), 'tokenId = issued token');
  assert.ok(!feed.tokenIdAuthorized(t1, 'k-123456789X', t0));
  assert.ok(!feed.tokenIdAuthorized(t1, '', t0));
  assert.ok(feed.solarmanLoginOk(t1, { email: 'mars2', password: 'pw-secret' }), 'plain password');
  const digest = require('node:crypto').createHash('sha256').update('pw-secret').digest('hex');
  assert.ok(feed.solarmanLoginOk(t1, { email: 'mars2', password: digest.toUpperCase() }), 'Solarman clients send the SHA-256 of the password');
  assert.ok(feed.solarmanLoginOk(t1, { appSecret: 'k-1234567890' }), 'appSecret = static key');
  assert.ok(!feed.solarmanLoginOk(t1, { email: 'mars2', password: 'wrong', appSecret: 'nope' }));
  assert.ok(!feed.solarmanLoginOk(t1, { email: 'other', password: 'pw-secret' }));
  assert.ok(!feed.solarmanLoginOk(feed.feedConfig({ FEED_PLANTS: '' }), { email: '', password: '' }), 'unconfigured feed never logs in');

  const sm = feed.formatSolarmanCurrent(huawei, withTotal, { deviceId: 77, capacityKwp: 46, now });
  assert.strictEqual(sm.success, true);
  assert.strictEqual(sm.deviceSn, 'SOKO46');
  assert.strictEqual(sm.deviceId, 77);
  assert.strictEqual(sm.deviceState, 1);
  assert.strictEqual(sm.collectionTime, Math.floor(Date.parse(at(5)) / 1000));
  const byKey = Object.fromEntries(sm.dataList.map(d => [d.key, d]));
  assert.deepStrictEqual(byKey.APo_t1, { key: 'APo_t1', value: '17.75', unit: 'kW', name: 'Total AC Output Power (Active)' }, 'values are strings like Solarman');
  assert.strictEqual(byKey.Etdy_ge1.value, '123.4');
  assert.strictEqual(byKey.Et_ge0.value, '98765.4');
  assert.strictEqual(byKey.t_gc1.value, '5000');
  assert.strictEqual(byKey.Pr1.value, '46', 'rated power from the inventory');
  assert.ok(!('PG_Pt1' in byKey), 'absent quantities are not listed');
  assert.strictEqual(feed.formatSolarmanCurrent(huawei, feed.computeCurrent(huawei, inventory, [], { now }), { now }).deviceState, 3, 'offline without data');
  const smTok = feed.formatSolarmanToken(feed.issueToken(t1, t0));
  assert.strictEqual(smTok.success, true);
  assert.strictEqual(smTok.expires_in, String(feed.TOKEN_TTL_SECONDS), 'Solarman sends expires_in as a string');
  assert.ok(feed.verifyToken(t1, smTok.access_token, t0));
  assert.deepStrictEqual(feed.parseJsonOrForm('application/json', '{"deviceSn":"X","deviceId":5}'), { deviceSn: 'X', deviceId: 5 });
  assert.deepStrictEqual(feed.parseJsonOrForm('application/x-www-form-urlencoded', 'deviceSn=X'), { deviceSn: 'X' });
  assert.throws(() => feed.parseJsonOrForm('application/json', '[1]'), /JSON object/);
  assert.strictEqual(feed.feedConfig({ FEED_PLANTS: '', FEED_SOLAX_POWER_UNIT: 'MW', FEED_SOLAX_EMPTY: 'x', FEED_SOLAX_TIMEZONE: 'Mars/Olympus' }).solax.powerUnit, 'W', 'bad knobs fall back');
  assert.deepStrictEqual(feed.feedConfig({ FEED_PLANTS: '' }).solax, { powerUnit: 'W', empty: 'null', timeZone: 'Europe/Zagreb' });
}

/* ── Feed request log: every poll is written to the store once the response
 * is out, with the real status, the plant code and the caller's address, so
 * both replicas agree on "Mars2 last polled at". ──────────────────────────── */
(async () => {
  const { EventEmitter } = require('events');
  const cfg = feed.feedConfig({ FEED_API_KEY: 'k-1234567890', FEED_PLANTS: 'SOKO46=HUAWEI:NE=1' });
  const rows = [];
  const store = {
    listFeedInventory: async () => [{ source: 'HUAWEI:NE=1', name: 'Soko', capacityKwp: 46, visible: true, devices: [] }],
    latestSamples: async () => [],
    bucketedSeries: async () => [],
    appendFeedRequest: async (row) => { rows.push(row); },
  };
  const state = { replica: 'prediction-a' };
  const handler = feed.createFeedHandler({ store, config: cfg, state, now: () => Date.parse('2026-11-12T18:00:00Z') });
  const call = async (method, target, headers = {}) => {
    const url = new URL(target, 'http://feed.test');
    const req = { method, headers: { 'user-agent': 'Mars2 Http driver', 'cf-connecting-ip': '185.253.189.12', ...headers }, socket: { remoteAddress: '10.0.0.9' } };
    const res = new EventEmitter();
    res.setHeader = () => {};
    const json = (r, status, body) => { r.statusCode = status; r.body = body; setImmediate(() => r.emit('finish')); };
    const handled = await handler(req, res, url, json, json);
    assert.strictEqual(handled, true);
    await new Promise(r => setImmediate(r));
    return res;
  };
  const ok = await call('GET', `${feed.SOLAX_PATH}?tokenId=k-1234567890&sn=SOKO46`);
  assert.strictEqual(ok.statusCode, 200);
  const unknown = await call('GET', `${feed.SOLAX_PATH}?tokenId=k-1234567890&sn=NOPE`);
  assert.strictEqual(unknown.statusCode, 404);
  const denied = await call('GET', `${feed.SOLAX_PATH}?tokenId=wrong&sn=SOKO46`);
  assert.strictEqual(denied.statusCode, 401);
  const rest = await call('GET', '/feed/plants/SOKO46/current', { 'x-feed-key': 'k-1234567890' });
  assert.strictEqual(rest.statusCode, 200);
  assert.strictEqual(rows.length, 4, 'one row per feed call');
  assert.deepStrictEqual(rows.map(r => [r.ok, r.status, r.sn]), [[true, 200, 'SOKO46'], [true, 404, 'NOPE'], [false, 401, 'SOKO46'], [true, 200, 'SOKO46']],
    'status is the one actually sent, sn is the plant asked for');
  assert.strictEqual(rows[0].path, feed.SOLAX_PATH);
  assert.strictEqual(rows[0].clientIp, '185.253.189.12', 'Cloudflare connecting IP wins over the socket peer');
  assert.strictEqual(rows[0].userAgent, 'Mars2 Http driver');
  assert.strictEqual(rows[0].replica, 'prediction-a');
  assert.strictEqual(rows[0].requestedAt, '2026-11-12T18:00:00.000Z');
  assert.strictEqual(state.requestsTotal, 4, 'process counters keep working beside the log');
  assert.strictEqual(state.authFailures, 1);
  // A failing log never fails the feed call.
  store.appendFeedRequest = async () => { throw new Error('db gone'); };
  const stillOk = await call('GET', `${feed.SOLAX_PATH}?tokenId=k-1234567890&sn=SOKO46`);
  assert.strictEqual(stillOk.statusCode, 200);
  // Without a store method (JSON store) nothing is written and nothing breaks.
  delete store.appendFeedRequest;
  const plain = await call('GET', `${feed.SOLAX_PATH}?tokenId=k-1234567890&sn=SOKO46`);
  assert.strictEqual(plain.statusCode, 200);
  assert.strictEqual(state.requestsTotal, 6);
})().catch((err) => { console.error(err); process.exit(1); });

// /measurements?bucket=… server-side downsampling parameter.
assert.strictEqual(parseBucketSeconds('1h'), 3600);
assert.strictEqual(parseBucketSeconds('15m'), 900);
assert.strictEqual(parseBucketSeconds('1d'), 86400);
assert.strictEqual(parseBucketSeconds('900'), 900);
assert.strictEqual(parseBucketSeconds('0.5h'), 1800);
assert.strictEqual(parseBucketSeconds('30s'), undefined, 'below the 60 s floor');
assert.strictEqual(parseBucketSeconds('90d'), 31 * 86400, 'capped at 31 days');
assert.strictEqual(parseBucketSeconds(''), undefined);
assert.strictEqual(parseBucketSeconds(null), undefined);
assert.strictEqual(parseBucketSeconds('1 hour'), undefined);
assert.strictEqual(parseBucketSeconds('abc'), undefined);

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

// With DATABASE_URL set and PostgreSQL unreachable the service must keep
// waiting for the database — not fall back to the JSON store. (In production
// the fallback hid a 29 h database outage behind db.ok=true and OOM-looped the
// pod.) Exercised in a child process because server.js picks its store at
// require time.
async function checkNoJsonFallback() {
  const { spawn } = require('child_process');
  const net = require('net');
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const closedPort = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PREDICTION_PORT: String(port),
      DATABASE_URL: `postgres://u:p@127.0.0.1:${closedPort}/db?sslmode=disable`,
      PG_INIT_RETRY_SECONDS: '1',
      PREDICTION_ACCESS_LOG: 'false',
      PREDICTION_INTERVAL_MINUTES: '10',
      FEED_USERNAME: 'mars2',
      FEED_PASSWORD: 'feed-test-password',
      FEED_PLANTS: 'SOKO46=HUAWEI:NE=201410062',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const get = async (p) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    return { status: res.status, body: await res.json() };
  };
  try {
    const deadline = Date.now() + 10_000;
    let health;
    for (;;) {
      try { health = await get('/health'); break; } catch (e) {
        if (Date.now() > deadline) throw new Error(`server did not start: ${e.message}\n${output}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.strictEqual(health.status, 200, 'a missing database is not a liveness failure');
    assert.strictEqual(health.body.store, 'postgres');
    assert.strictEqual(health.body.storeReady, false);

    const fresh = await get('/freshness');
    assert.strictEqual(fresh.status, 200);
    assert.strictEqual(fresh.body.ok, false);
    assert.strictEqual(fresh.body.db.ok, false);
    assert.strictEqual(fresh.body.db.store, 'postgres', 'must not fall back to json');
    assert.strictEqual(fresh.body.db.initialized, false);
    assert.match(fresh.body.db.error, /ECONNREFUSED/);
    assert.deepStrictEqual(fresh.body.sources, []);
    assert.match(fresh.body.sourcesError, /PostgreSQL unavailable/);
    assert.strictEqual(fresh.body.lifecycle, 'initializing', 'no cycle may run without the store');

    const status = await get('/status');
    assert.strictEqual(status.status, 503, 'store-backed routes answer 503 while disconnected');
    assert.strictEqual(status.body.error, 'database unavailable');
    const models = await get('/models');
    assert.strictEqual(models.status, 200, 'static routes keep working');

    // Feed API over HTTP: token exchange works without the store, data routes
    // demand a token and then hit the database guard.
    assert.deepStrictEqual(fresh.body.feed.plants, ['SOKO46']);
    assert.strictEqual(fresh.body.feed.configured, true);
    const post = async (p, body, contentType) => {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
      return { status: res.status, body: await res.json() };
    };
    const bad = await post('/feed/token', 'userName=mars2&password=wrong&grant_type=password', 'application/x-www-form-urlencoded');
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.error, 'invalid_grant');
    const tok = await post('/feed/token', 'userName=mars2&password=feed-test-password&grant_type=password', 'application/x-www-form-urlencoded');
    assert.strictEqual(tok.status, 200, JSON.stringify(tok.body));
    assert.strictEqual(tok.body.token_type, 'bearer');
    const anon = await get('/feed/plants');
    assert.strictEqual(anon.status, 401, 'feed data requires a token');
    const authed = await fetch(`http://127.0.0.1:${port}/feed/plants`, { headers: { Authorization: `Bearer ${tok.body.access_token}` } });
    assert.strictEqual(authed.status, 503, 'authenticated, but the store is unavailable');
    assert.strictEqual((await authed.json()).error, 'database unavailable');
    const unknown = await fetch(`http://127.0.0.1:${port}/feed/plants/NOPE/current`, { headers: { Authorization: `Bearer ${tok.body.access_token}` } });
    assert.strictEqual(unknown.status, 503, 'guard applies before plant lookup');
    const freshAfter = await get('/freshness');
    assert.strictEqual(freshAfter.body.feed.authFailures, 2, 'bad password and anonymous call are counted');
    assert.ok(freshAfter.body.feed.lastTokenAt, 'token issuance is recorded');
    assert.deepStrictEqual(freshAfter.body.feed.dialects, { solax: { powerUnit: 'W', empty: 'null', timeZone: 'Europe/Zagreb' }, solarman: true });

    // Solax dialect: credential in the query string, Solax-shaped errors.
    const solaxPath = '/feed/solax/proxyApp/proxy/api/getRealtimeInfo.do';
    const solaxAnon = await get(`${solaxPath}?tokenId=wrong&sn=SOKO46`);
    assert.strictEqual(solaxAnon.status, 401);
    assert.deepStrictEqual(solaxAnon.body, { success: false, exception: 'invalid tokenId', result: null });
    const solaxOk = await get(`${solaxPath}?tokenId=${encodeURIComponent(tok.body.access_token)}&sn=SOKO46`);
    assert.strictEqual(solaxOk.status, 503, 'authenticated by tokenId, then the store guard');
    assert.strictEqual(solaxOk.body.exception, 'database unavailable');
    const solaxPost = await post(solaxPath, '', 'text/plain');
    assert.strictEqual(solaxPost.status, 405);

    // Solarman dialect: its own token route (plain or SHA-256 password), then a bearer POST.
    const smBad = await post('/feed/solarman/account/v1.0/token?appId=x', JSON.stringify({ appSecret: 'x', email: 'mars2', password: 'wrong' }), 'application/json');
    assert.strictEqual(smBad.status, 401);
    assert.strictEqual(smBad.body.success, false);
    const sha = require('node:crypto').createHash('sha256').update('feed-test-password').digest('hex');
    const smTok = await post('/feed/solarman/account/v1.0/token?appId=x', JSON.stringify({ appSecret: 'x', email: 'mars2', password: sha }), 'application/json');
    assert.strictEqual(smTok.status, 200, JSON.stringify(smTok.body));
    assert.strictEqual(smTok.body.success, true);
    assert.strictEqual(typeof smTok.body.expires_in, 'string');
    const smData = await fetch(`http://127.0.0.1:${port}/feed/solarman/device/v1.0/currentData?language=en`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `bearer ${smTok.body.access_token}` }, body: JSON.stringify({ deviceSn: 'SOKO46', deviceId: 1 }),
    });
    assert.strictEqual(smData.status, 503, 'authenticated, then the store guard');
    const smAnon = await post('/feed/solarman/device/v1.0/currentData?language=en', JSON.stringify({ deviceSn: 'SOKO46' }), 'application/json');
    assert.strictEqual(smAnon.status, 401);
    assert.strictEqual(smAnon.body.msg, 'auth invalid token');
    const smGet = await get('/feed/solarman/device/v1.0/currentData');
    assert.strictEqual(smGet.status, 405);
    const smUnknown = await post('/feed/solarman/nothing', '{}', 'application/json');
    assert.strictEqual(smUnknown.status, 404);
    const after = await get('/freshness');
    assert.strictEqual(after.body.feed.authFailures, 5, 'solax wrong tokenId, solarman bad login and anonymous read are counted');
    assert.strictEqual(after.body.feed.lastRequestPath, '/feed/solarman/device/v1.0/currentData');
    assert.strictEqual(after.body.feed.shared, false, 'no database: the counters are this process\'s own');
    assert.strictEqual(after.body.feed.local.authFailures, 5);
    assert.ok(after.body.feed.local.replica, 'replica id is reported');

    // Retries keep going (attempt counter grows) instead of giving up.
    await new Promise((r) => setTimeout(r, 2_500));
    const again = await get('/freshness');
    assert.ok(again.body.db.attempts >= 2, `expected repeated init attempts, got ${again.body.db.attempts}`);
    assert.match(output, /not falling back to JSON/);
    assert.doesNotMatch(output, /falling back to JSON:/);
  } finally {
    child.kill('SIGKILL');
  }
}

(async () => {
  const [first, second] = await Promise.all([measurementsMeta(), measurementsMeta()]);
  const third = await measurementsMeta();
  assert.strictEqual(second, first, 'concurrent meta requests must coalesce to one computation');
  assert.strictEqual(third, first, 'meta must be served from cache within the TTL');
  await checkSlaWindow();
  await checkPreloadedRecords();
  await checkFreshness();
  await checkNoJsonFallback();
  console.log('prediction tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
}).finally(() => {
  fs.rmSync(path.dirname(scratchStore), { recursive: true, force: true });
});
