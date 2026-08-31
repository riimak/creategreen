const test = require('node:test');
const assert = require('node:assert');
const { createSynchronizer } = require('../sync');

const TS = 1788167536272;

function memoryStore() {
  const plants = new Map();
  const devices = new Map();
  const checkpoints = new Map();
  const measurements = [];
  return {
    plants,
    devices,
    checkpoints,
    measurements,
    async upsertPlants(rows) {
      for (const row of rows) plants.set(row.stationId, { ...plants.get(row.stationId), ...row });
    },
    async upsertDevices(rows) {
      for (const row of rows) devices.set(row.deviceSn, { ...devices.get(row.deviceSn), ...row });
    },
    async listPlants() {
      return [...plants.values()].filter((plant) => plant.visible !== false);
    },
    async listDevices() {
      return [...devices.values()].filter((device) => device.visible !== false);
    },
    async getCheckpoint(key) {
      return checkpoints.get(key) ?? null;
    },
    async setCheckpoint(key, checkpoint) {
      checkpoints.set(key, checkpoint);
    },
    async saveMeasurementsAndCheckpoint(rows, key, checkpoint) {
      measurements.push(...rows);
      checkpoints.set(key, checkpoint);
      return { upserted: rows.length };
    },
    async status() {
      return {};
    },
  };
}

function stubClient(handlers) {
  const calls = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      const handler = handlers[path];
      if (!handler) throw new Error(`unexpected path ${path}`);
      return typeof handler === 'function' ? handler(body) : handler;
    },
  };
}

function page(records) {
  return { success: true, code: '0', data: { page: { records, pages: 1 } } };
}

const STATION = {
  id: '42',
  stationName: 'Test Station',
  capacity: 10,
  capacityStr: 'kWp',
  timeZone: 1,
  dataTimestamp: String(TS),
  power: 5,
  powerStr: 'kW',
  dayEnergy: 21.5,
  dayEnergyStr: 'kWh',
};

const INVERTER = {
  id: '9001',
  sn: 'SN-A',
  stationId: '42',
  productModel: 'S6',
  dataTimestamp: String(TS),
  pac: 5,
  pacStr: 'kW',
  etoday: 21.5,
  etodayStr: 'kWh',
};

test('live cycle ingests stations, inverters, and their measurements', async () => {
  const store = memoryStore();
  const client = stubClient({
    '/v1/api/userStationList': page([STATION]),
    '/v1/api/inverterList': page([INVERTER]),
  });
  const sync = createSynchronizer({ client, store, now: () => new Date(TS) });
  const result = await sync.runLiveCycle();
  assert.strictEqual(result.state, 'ok');
  assert.strictEqual(result.plants, 1);
  assert.strictEqual(result.devices, 1);
  assert.ok(store.plants.has('42'));
  assert.ok(store.devices.has('SN-A'));
  const sources = new Set(store.measurements.map((m) => m.source));
  assert.ok(sources.has('SOLIS:42'));
  assert.ok(sources.has('SOLIS:42:device:SN-A'));
  const live = store.checkpoints.get('live');
  assert.strictEqual(live.failureAttempts, 0);
});

test('a station allowlist ingests only the listed stations and their inverters', async () => {
  const store = memoryStore();
  const otherStation = { ...STATION, id: '99', stationName: 'Out of scope' };
  const otherInverter = { ...INVERTER, id: '9002', sn: 'SN-OTHER', stationId: '99' };
  const client = stubClient({
    '/v1/api/userStationList': page([STATION, otherStation]),
    '/v1/api/inverterList': page([INVERTER, otherInverter]),
  });
  const sync = createSynchronizer({
    client,
    store,
    config: { stationIds: ['42'] },
    now: () => new Date(TS),
  });
  const result = await sync.runLiveCycle();
  assert.strictEqual(result.state, 'ok');
  assert.strictEqual(result.plants, 1);
  assert.strictEqual(result.devices, 1);
  // Out-of-scope assets are neither stored nor counted as data errors.
  assert.strictEqual(result.skipped, 0);
  assert.ok(!store.plants.has('99'));
  assert.ok(!store.devices.has('SN-OTHER'));
  assert.ok(store.measurements.every((m) => m.source.startsWith('SOLIS:42')));
});

test('assets missing from a snapshot are hidden, not deleted', async () => {
  const store = memoryStore();
  store.plants.set('42', { stationId: '42', sourceKey: 'SOLIS:42', visible: true });
  store.plants.set('былое', { stationId: 'былое', sourceKey: 'SOLIS:былое', visible: true });
  store.devices.set('SN-A', { deviceSn: 'SN-A', stationId: '42', visible: true });
  store.devices.set('SN-GONE', { deviceSn: 'SN-GONE', stationId: '42', visible: true });
  const client = stubClient({
    '/v1/api/userStationList': page([STATION]),
    '/v1/api/inverterList': page([INVERTER]),
  });
  const sync = createSynchronizer({ client, store, now: () => new Date(TS) });
  await sync.runLiveCycle();
  assert.strictEqual(store.plants.get('былое').visible, false);
  assert.strictEqual(store.devices.get('SN-GONE').visible, false);
  assert.strictEqual(store.plants.get('42').visible, true);
});

test('live failure sets exponential backoff and reports a failure delta', async () => {
  const store = memoryStore();
  const client = stubClient({
    '/v1/api/userStationList': () => {
      throw new Error('boom');
    },
  });
  const sync = createSynchronizer({
    client,
    store,
    now: () => new Date(TS),
    random: () => 0.5,
  });
  const result = await sync.runLiveCycle();
  assert.strictEqual(result.state, 'backoff');
  assert.strictEqual(result.solisFailureDelta, 1);
  const checkpoint = store.checkpoints.get('live');
  assert.strictEqual(checkpoint.failureAttempts, 1);
  assert.ok(Date.parse(checkpoint.backoffUntil) > TS);

  // While backoff is active the cycle refuses to call the vendor again.
  const second = await sync.runLiveCycle();
  assert.strictEqual(second.state, 'backoff');
  assert.strictEqual(client.calls.length, 1);
});

test('backfill walks backwards day by day until the boundary', async () => {
  const store = memoryStore();
  store.plants.set('42', {
    stationId: '42',
    sourceKey: 'SOLIS:42',
    timezone: 0,
    visible: true,
    metadata: {},
  });
  store.devices.set('SN-A', { deviceSn: 'SN-A', stationId: '42', visible: true });
  const dayCalls = [];
  const client = stubClient({
    '/v1/api/inverterDay': (body) => {
      dayCalls.push(body.time);
      return {
        success: true,
        code: '0',
        data: [
          { dataTimestamp: String(TS), pac: 3, pacStr: 'kW', eToday: 8 },
        ],
      };
    },
  });
  const sync = createSynchronizer({
    client,
    store,
    config: { backfillDays: 3, backfillStepsPerCycle: 10 },
    now: () => new Date('2026-08-31T10:00:00Z'),
  });
  const result = await sync.runBackfillBatch();
  assert.strictEqual(result.state, 'complete');
  // 2026-08-31 back to 2026-08-28 (boundary = today - 3 days).
  assert.deepStrictEqual(dayCalls, ['2026-08-31', '2026-08-30', '2026-08-29', '2026-08-28']);
  const checkpoint = store.checkpoints.get('backfill:device:SN-A');
  assert.strictEqual(checkpoint.reachedBoundary, true);
  assert.ok(store.measurements.length >= 4);
});

test('backfill failures back off per device without aborting the batch state', async () => {
  const store = memoryStore();
  store.plants.set('42', {
    stationId: '42',
    sourceKey: 'SOLIS:42',
    timezone: 0,
    visible: true,
    metadata: {},
  });
  store.devices.set('SN-A', { deviceSn: 'SN-A', stationId: '42', visible: true });
  const client = stubClient({
    '/v1/api/inverterDay': () => {
      throw new Error('boom');
    },
  });
  const sync = createSynchronizer({
    client,
    store,
    config: { backfillDays: 3 },
    now: () => new Date('2026-08-31T10:00:00Z'),
    random: () => 0.5,
  });
  const result = await sync.runBackfillBatch();
  assert.strictEqual(result.state, 'backoff');
  assert.strictEqual(result.solisFailureDelta, 1);
  const checkpoint = store.checkpoints.get('backfill:device:SN-A');
  assert.strictEqual(checkpoint.failureAttempts, 1);
  assert.ok(Date.parse(checkpoint.backoffUntil) > Date.parse('2026-08-31T10:00:00Z'));
});

test('commissioning date limits the backfill boundary', async () => {
  const store = memoryStore();
  store.plants.set('42', {
    stationId: '42',
    sourceKey: 'SOLIS:42',
    timezone: 0,
    visible: true,
    metadata: { fisPowerTime: Date.parse('2026-08-30T06:00:00Z') },
  });
  store.devices.set('SN-A', { deviceSn: 'SN-A', stationId: '42', visible: true });
  const dayCalls = [];
  const client = stubClient({
    '/v1/api/inverterDay': (body) => {
      dayCalls.push(body.time);
      return { success: true, code: '0', data: [] };
    },
  });
  const sync = createSynchronizer({
    client,
    store,
    config: { backfillDays: 90, backfillStepsPerCycle: 10 },
    now: () => new Date('2026-08-31T10:00:00Z'),
  });
  const result = await sync.runBackfillBatch();
  assert.strictEqual(result.state, 'complete');
  assert.deepStrictEqual(dayCalls, ['2026-08-31', '2026-08-30']);
});
