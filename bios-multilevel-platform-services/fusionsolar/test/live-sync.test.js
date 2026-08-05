const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSynchronizer,
  PLANT_REALTIME_PATH,
  DEVICE_REALTIME_PATH,
} = require('../sync');

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function createStore({
  refreshedAt = '2026-08-05T09:30:00.000Z',
  plants = [{
    plantCode: 'NE=PLANT-1',
    sourceKey: 'HUAWEI:NE=PLANT-1',
    visible: true,
  }],
  devices = [{
    deviceId: '101',
    plantCode: 'NE=PLANT-1',
    deviceType: '1',
    metadata: { devDn: 'NE=DEVICE-101' },
  }],
} = {}) {
  const checkpoints = new Map([[
    'inventory',
    { refreshedAt, plants: structuredClone(plants) },
  ]]);
  const transactions = [];
  return {
    checkpoints,
    transactions,
    async upsertPlants() {},
    async upsertDevices() {},
    async listPlants() {
      return structuredClone(plants.filter((plant) => plant.visible !== false));
    },
    async listDevices() {
      return structuredClone(devices);
    },
    async getCheckpoint(key) {
      return structuredClone(checkpoints.get(key) || null);
    },
    async getSyncState(key) {
      const checkpoint = checkpoints.get(key);
      return checkpoint
        ? {
          checkpoint: structuredClone(checkpoint),
          backoffUntil: checkpoint.backoffUntil || null,
        }
        : null;
    },
    async setCheckpoint(key, value) {
      checkpoints.set(key, structuredClone(value));
    },
    async saveMeasurementsAndCheckpoint(measurements, key, checkpoint, options) {
      transactions.push({
        measurements: structuredClone(measurements),
        key,
        checkpoint: structuredClone(checkpoint),
        options: structuredClone(options),
      });
      checkpoints.set(key, structuredClone(checkpoint));
      return { upserted: measurements.length };
    },
    async status() {
      return { state: 'authorized' };
    },
  };
}

test('live polling uses documented batches, collection timestamps, and one atomic write', async () => {
  const plants = Array.from({ length: 101 }, (_, index) => ({
    plantCode: `NE=PLANT-${index + 1}`,
    sourceKey: `HUAWEI:NE=PLANT-${index + 1}`,
    visible: true,
  }));
  const devices = [
    {
      deviceId: '101',
      plantCode: 'NE=PLANT-1',
      deviceType: '1',
      metadata: { devDn: 'NE=DEVICE-101' },
    },
    {
      deviceId: '202',
      plantCode: 'NE=PLANT-2',
      deviceType: '17',
      metadata: { devDn: 'NE=DEVICE-202' },
    },
    {
      deviceId: 'hidden',
      plantCode: 'NE=PLANT-1',
      deviceType: '1',
      visible: false,
      metadata: { devDn: 'NE=DEVICE-HIDDEN' },
    },
  ];
  const store = createStore({ plants, devices });
  const calls = [];
  let releaseFirstPlantRequest;
  let markFirstPlantStarted;
  const firstPlantRequest = new Promise((resolve) => {
    releaseFirstPlantRequest = resolve;
  });
  const firstPlantStarted = new Promise((resolve) => {
    markFirstPlantStarted = resolve;
  });
  let plantCall = 0;
  const client = {
    async request(path, options) {
      const body = JSON.parse(options.body);
      calls.push({ path, body });
      if (path === PLANT_REALTIME_PATH) {
        plantCall += 1;
        if (plantCall === 1) {
          markFirstPlantStarted();
          await firstPlantRequest;
        }
        return jsonResponse({
          success: true,
          failCode: 0,
          params: { currentTime: 1785924000000 },
          data: body.stationCodes.split(',').map((stationCode) => ({
            stationCode,
            dataItemMap: { day_power: '12.5', unsupported: 'ignored' },
          })),
        });
      }
      assert.equal(path, DEVICE_REALTIME_PATH);
      return jsonResponse({
        success: true,
        failCode: 0,
        params: { currentTime: 1785924300000 },
        data: body.devIds.split(',').map((devId) => ({
          devId: Number(devId),
          dataItemMap: body.devTypeId === 17
            ? { active_power: 2500 }
            : { active_power: 4.25 },
        })),
      });
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: { inventoryIntervalMs: 60 * 60_000 },
    now: () => new Date('2026-08-05T10:00:00Z'),
    random: () => 0.5,
  });

  const first = synchronizer.runLiveCycle();
  const overlapping = synchronizer.runLiveCycle();
  await firstPlantStarted;
  assert.equal(calls.length, 1);
  releaseFirstPlantRequest();
  const [result, overlappingResult] = await Promise.all([first, overlapping]);

  assert.deepEqual(overlappingResult, result);
  assert.deepEqual(
    calls.filter(({ path }) => path === PLANT_REALTIME_PATH)
      .map(({ body }) => body.stationCodes.split(',').length),
    [100, 1],
  );
  assert.deepEqual(
    calls.filter(({ path }) => path === DEVICE_REALTIME_PATH)
      .map(({ body }) => body),
    [
      { devIds: '101', devTypeId: 1 },
      { devIds: '202', devTypeId: 17 },
    ],
  );
  assert.deepEqual(result, {
    plants: 101,
    devices: 2,
    measurements: 103,
    skipped: 101,
    failures: [],
  });
  assert.equal(store.transactions.length, 1);
  assert.equal(store.transactions[0].key, 'live');
  assert.equal(store.transactions[0].measurements[0].ts, '2026-08-05T10:00:00.000Z');
  assert.equal(
    store.transactions[0].measurements.find(
      ({ source, metric }) => source === 'HUAWEI:NE=PLANT-2:device:202'
        && metric === 'huawei.grid_meter.active_power_kw',
    ).value,
    2.5,
  );
});

test('stale inventory is refreshed before polling', async () => {
  const store = createStore({ refreshedAt: '2026-08-05T08:00:00.000Z', devices: [] });
  const paths = [];
  const client = {
    async request(path, options) {
      paths.push(path);
      if (path === '/thirdData/stations') {
        return jsonResponse({
          success: true,
          failCode: 0,
          data: {
            list: [{
              plantCode: 'NE=PLANT-1',
              plantName: 'Plant one',
              capacity: 1,
            }],
            pageNo: 1,
            pageCount: 1,
          },
        });
      }
      if (path === '/thirdData/getDevList') {
        return jsonResponse({
          success: true,
          failCode: 0,
          params: { currentTime: 1785924000000 },
          data: [],
        });
      }
      assert.equal(path, PLANT_REALTIME_PATH);
      return jsonResponse({
        success: true,
        failCode: 0,
        params: { currentTime: 1785924000000 },
        data: [{
          stationCode: JSON.parse(options.body).stationCodes,
          dataItemMap: { day_power: 1 },
        }],
      });
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: { inventoryIntervalMs: 60 * 60_000 },
    now: () => new Date('2026-08-05T10:00:00Z'),
  });

  await synchronizer.runLiveCycle();

  assert.deepEqual(paths.slice(0, 2), ['/thirdData/stations', '/thirdData/getDevList']);
  assert.equal(paths[2], PLANT_REALTIME_PATH);
});

test('one malformed device does not abort unrelated devices', async () => {
  const store = createStore({
    devices: [
      {
        deviceId: 'bad',
        plantCode: 'NE=PLANT-1',
        deviceType: '1',
        metadata: { devDn: 'NE=BAD' },
      },
      {
        deviceId: '202',
        plantCode: 'NE=PLANT-1',
        deviceType: '17',
        metadata: { devDn: 'NE=GOOD' },
      },
    ],
  });
  const client = {
    async request(path, options) {
      if (path === PLANT_REALTIME_PATH) {
        return jsonResponse({
          success: true,
          failCode: 0,
          params: { currentTime: 1785924000000 },
          data: [{
            stationCode: 'NE=PLANT-1',
            dataItemMap: { day_power: 1 },
          }],
        });
      }
      const { devTypeId } = JSON.parse(options.body);
      return jsonResponse({
        success: true,
        failCode: 0,
        params: { currentTime: 1785924000000 },
        data: devTypeId === 1
          ? [{ devId: 'bad', dataItemMap: null }]
          : [{ devId: 202, dataItemMap: { active_power: 1000 } }],
      });
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: { inventoryIntervalMs: 60 * 60_000 },
    now: () => new Date('2026-08-05T10:00:00Z'),
  });

  const result = await synchronizer.runLiveCycle();

  assert.equal(result.measurements, 2);
  assert.deepEqual(result.failures, [{
    scope: 'device:bad',
    reason: 'invalid_response',
  }]);
  assert.equal(store.transactions[0].measurements.length, 2);
});

test('a requested asset omitted from a successful response is reported as failed', async () => {
  const store = createStore({
    devices: [
      {
        deviceId: '101',
        plantCode: 'NE=PLANT-1',
        deviceType: '1',
        metadata: { devDn: 'NE=DEVICE-101' },
      },
      {
        deviceId: '102',
        plantCode: 'NE=PLANT-1',
        deviceType: '1',
        metadata: { devDn: 'NE=DEVICE-102' },
      },
    ],
  });
  const client = {
    async request(path) {
      if (path === PLANT_REALTIME_PATH) {
        return jsonResponse({
          success: true,
          failCode: 0,
          params: { currentTime: 1785924000000 },
          data: [{
            stationCode: 'NE=PLANT-1',
            dataItemMap: { day_power: 1 },
          }],
        });
      }
      return jsonResponse({
        success: true,
        failCode: 0,
        params: { currentTime: 1785924000000 },
        data: [{ devId: 101, dataItemMap: { active_power: 2 } }],
      });
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: { inventoryIntervalMs: 60 * 60_000 },
    now: () => new Date('2026-08-05T10:00:00Z'),
  });

  const result = await synchronizer.runLiveCycle();

  assert.deepEqual(result.failures, [{
    scope: 'device:102',
    reason: 'missing_response',
  }]);
});

test('flow control persists backoff and prevents lower-priority backfill', async () => {
  const store = createStore();
  let historyCalls = 0;
  const client = {
    async request(path) {
      if (path === PLANT_REALTIME_PATH) {
        return jsonResponse({
          success: false,
          failCode: 429,
          data: null,
          message: 'provider detail must not leak',
        }, { headers: { 'retry-after': '120' } });
      }
      if (path === DEVICE_REALTIME_PATH) {
        return jsonResponse({
          success: true,
          failCode: 0,
          params: { currentTime: 1785924000000 },
          data: [],
        });
      }
      historyCalls += 1;
      throw new Error('history must not run');
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: { inventoryIntervalMs: 60 * 60_000 },
    now: () => new Date('2026-08-05T10:00:00Z'),
    random: () => 0.5,
  });

  const live = await synchronizer.runLiveCycle();
  const backfill = await synchronizer.runBackfillStep();

  assert.deepEqual(live.failures, [
    {
      scope: 'plant:batch:1',
      reason: 'flow_controlled',
    },
    {
      scope: 'device:101',
      reason: 'missing_response',
    },
  ]);
  assert.equal(store.checkpoints.get('live').backoffUntil, '2026-08-05T10:02:00.000Z');
  assert.deepEqual(backfill, {
    state: 'backoff',
    nextBefore: null,
    rows: 0,
    reachedBoundary: false,
  });
  assert.equal(historyCalls, 0);
  assert.doesNotMatch(JSON.stringify(live), /provider detail/);
});

test('persisted live backoff prevents every Huawei call after restart', async () => {
  const store = createStore();
  store.checkpoints.set('live', {
    backoffUntil: '2026-08-05T10:02:00.000Z',
    failureAttempts: 2,
  });
  let calls = 0;
  const synchronizer = createSynchronizer({
    store,
    now: () => new Date('2026-08-05T10:01:00Z'),
    client: {
      async request() {
        calls += 1;
        throw new Error('must not call Huawei');
      },
    },
  });

  assert.deepEqual(await synchronizer.runLiveCycle(), {
    state: 'backoff',
    retryAt: '2026-08-05T10:02:00.000Z',
    huaweiFailureDelta: 0,
  });
  assert.equal(calls, 0);
});
