const test = require('node:test');
const assert = require('node:assert/strict');
const { createSynchronizer } = require('../sync');

const PLANT_PATH = '/thirdData/stations';
const DEVICE_PATH = '/thirdData/getDevList';

function plant(plantCode, plantName) {
  return {
    plantCode,
    plantName,
    plantAddress: null,
    longitude: null,
    latitude: null,
    capacity: 25.5,
    contactPerson: '',
    contactMethod: '',
    gridConnectionDate: '2022-11-21T16:23:00+08:00',
  };
}

function response(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createStore() {
  let checkpoint = null;
  const plantWrites = [];
  const deviceWrites = [];
  const checkpointWrites = [];
  const checkpointOptions = [];
  return {
    plantWrites,
    deviceWrites,
    checkpointWrites,
    checkpointOptions,
    async upsertPlants(plants) {
      plantWrites.push(structuredClone(plants));
      return { upserted: plants.length };
    },
    async upsertDevices(devices) {
      deviceWrites.push(structuredClone(devices));
      return { upserted: devices.length };
    },
    async getCheckpoint(key) {
      assert.equal(key, 'inventory');
      return checkpoint;
    },
    async setCheckpoint(key, value, options) {
      assert.equal(key, 'inventory');
      checkpoint = structuredClone(value);
      checkpointWrites.push(structuredClone(value));
      checkpointOptions.push(structuredClone(options));
    },
    async status() {
      return { state: 'authorized', plantCount: 2, deviceCount: 2 };
    },
  };
}

test('consumes every plant page, attaches devices, and marks missing plants invisible', async () => {
  const store = createStore();
  const requests = [];
  let refresh = 1;
  const client = {
    async request(path, options) {
      const body = JSON.parse(options.body);
      requests.push({ refresh, path, body });
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');

      if (path === PLANT_PATH) {
        if (refresh === 1 && body.pageNo === 1) {
          return response({
            success: true,
            data: {
              list: [plant('NE=PLANT-1', 'Plant one')],
              pageCount: 2,
              pageNo: 1,
              pageSize: 1,
              total: 2,
            },
            failCode: 0,
            message: 'get plant list success',
          });
        }
        if (refresh === 1 && body.pageNo === 2) {
          return response({
            success: true,
            data: {
              list: [plant('NE=PLANT-2', 'Plant two')],
              pageCount: 2,
              pageNo: 2,
              pageSize: 1,
              total: 2,
            },
            failCode: 0,
            message: 'get plant list success',
          });
        }
        return response({
          success: true,
          data: {
            list: [plant('NE=PLANT-1', 'Plant one')],
            pageCount: 1,
            pageNo: 1,
            pageSize: 100,
            total: 1,
          },
          failCode: 0,
          message: 'get plant list success',
        });
      }

      assert.equal(path, DEVICE_PATH);
      const stationCodes = body.stationCodes.split(',');
      return response({
        success: true,
        data: stationCodes.map((stationCode, index) => ({
          id: refresh * 100 + index,
          devDn: `NE=DEVICE-${refresh}-${index}`,
          devName: `Device ${index}`,
          stationCode,
          esnCode: `SANITIZED-${refresh}-${index}`,
          devTypeId: 1,
          model: 'SUN2000-17KTL',
        })),
        failCode: 0,
        params: { stationCodes: body.stationCodes, currentTime: 1785924000000 },
        message: null,
      });
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: {},
    now: () => new Date('2026-08-05T10:00:00Z'),
    sleep: async () => {},
  });

  assert.deepEqual(await synchronizer.refreshInventory(), { plants: 2, devices: 2 });
  assert.deepEqual(
    requests.filter((request) => request.path === PLANT_PATH).map((request) => request.body.pageNo),
    [1, 2],
  );
  assert.deepEqual(
    store.deviceWrites[0].map((device) => [device.deviceId, device.plantCode]),
    [['100', 'NE=PLANT-1'], ['101', 'NE=PLANT-2']],
  );

  refresh = 2;
  assert.deepEqual(await synchronizer.refreshInventory(), { plants: 1, devices: 1 });
  assert.deepEqual(
    store.plantWrites[1].map((item) => [item.plantCode, item.visible]),
    [['NE=PLANT-1', true], ['NE=PLANT-2', false]],
  );
  assert.deepEqual(
    store.deviceWrites[1].map((item) => [item.deviceId, item.visible]),
    [['200', true], ['100', false], ['101', false]],
  );
  assert.deepEqual(await synchronizer.status(), {
    state: 'authorized',
    plantCount: 2,
    deviceCount: 2,
  });
});

test('rejects a repeated Huawei plant page with a sanitized error', async () => {
  const store = createStore();
  const client = {
    async request(path) {
      assert.equal(path, PLANT_PATH);
      return response({
        success: true,
        data: {
          list: [plant('NE=REPEATED', 'Repeated')],
          pageCount: 3,
          pageNo: 1,
          pageSize: 1,
          total: 3,
        },
        failCode: 0,
        message: 'raw provider detail must not be copied',
      });
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: {},
    now: () => new Date('2026-08-05T10:00:00Z'),
    sleep: async () => {},
  });

  await assert.rejects(
    synchronizer.refreshInventory(),
    (error) => {
      assert.equal(error.message, 'Huawei plant inventory returned a repeated page');
      assert.doesNotMatch(error.message, /raw provider detail/);
      return true;
    },
  );
  assert.equal(store.plantWrites.length, 0);
});

test('enforces the configured plant page safety cap', async () => {
  const store = createStore();
  const client = {
    async request(path, options) {
      assert.equal(path, PLANT_PATH);
      const pageNo = JSON.parse(options.body).pageNo;
      return response({
        success: true,
        data: {
          list: [plant(`NE=PAGE-${pageNo}`, `Page ${pageNo}`)],
          pageCount: 3,
          pageNo,
          pageSize: 1,
          total: 3,
        },
        failCode: 0,
        message: null,
      });
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: { inventoryPageCap: 2 },
    now: () => new Date('2026-08-05T10:00:00Z'),
    sleep: async () => {},
  });

  await assert.rejects(
    synchronizer.refreshInventory(),
    /Huawei plant inventory exceeded the page safety cap/,
  );
  assert.equal(store.plantWrites.length, 0);
});

test('queries devices in documented batches of at most 100 plants', async () => {
  const store = createStore();
  const allPlants = Array.from(
    { length: 101 },
    (_, index) => plant(`NE=BATCH-${index + 1}`, `Batch plant ${index + 1}`),
  );
  const deviceBatchSizes = [];
  const client = {
    async request(path, options) {
      const body = JSON.parse(options.body);
      if (path === PLANT_PATH) {
        const firstPage = body.pageNo === 1;
        return response({
          success: true,
          data: {
            list: firstPage ? allPlants.slice(0, 100) : allPlants.slice(100),
            pageCount: 2,
            pageNo: body.pageNo,
            pageSize: firstPage ? 100 : 1,
            total: 101,
          },
          failCode: 0,
          message: null,
        });
      }
      assert.equal(path, DEVICE_PATH);
      const stationCodes = body.stationCodes.split(',');
      deviceBatchSizes.push(stationCodes.length);
      return response({
        success: true,
        data: [],
        failCode: 0,
        params: { stationCodes: body.stationCodes, currentTime: 1785924000000 },
        message: null,
      });
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: {},
    now: () => new Date('2026-08-05T10:00:00Z'),
    sleep: async () => {},
  });

  assert.deepEqual(await synchronizer.refreshInventory(), { plants: 101, devices: 0 });
  assert.deepEqual(deviceBatchSizes, [100, 1]);
});

test('skips malformed records while completing valid plant and device discovery', async () => {
  const store = createStore();
  const client = {
    async request(path, options) {
      const body = JSON.parse(options.body);
      if (path === PLANT_PATH) {
        const firstPage = body.pageNo === 1;
        return response({
          success: true,
          data: {
            list: firstPage
              ? [
                plant('NE=VALID-1', 'Valid one'),
                {
                  plantCode: ' ',
                  plantName: 'Malformed plant',
                  clientSecret: 'PLANT-SECRET-MUST-NOT-LEAK',
                },
              ]
              : [plant('NE=VALID-2', 'Valid two')],
            pageCount: 2,
            pageNo: body.pageNo,
            pageSize: firstPage ? 2 : 1,
            total: 3,
          },
          failCode: 0,
          message: null,
        });
      }

      assert.equal(path, DEVICE_PATH);
      return response({
        success: true,
        data: [
          {
            id: 200,
            stationCode: 'NE=VALID-1',
            esnCode: 'SANITIZED-200',
            devTypeId: 1,
            model: 'SUN2000-17KTL',
          },
          {
            id: null,
            stationCode: 'NE=VALID-1',
            devTypeId: 1,
            accessToken: 'DEVICE-TOKEN-MUST-NOT-LEAK',
          },
          {
            id: 999,
            stationCode: 'NE=UNRELATED',
            devTypeId: 1,
            rawError: 'RAW-ERROR-MUST-NOT-LEAK',
          },
          {
            id: 201,
            stationCode: 'NE=VALID-2',
            esnCode: 'SANITIZED-201',
            devTypeId: 38,
            model: 'SUN2000-10KTL',
          },
        ],
        failCode: 0,
        params: { stationCodes: body.stationCodes, currentTime: 1785924000000 },
        message: null,
      });
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: {},
    now: () => new Date('2026-08-05T10:00:00Z'),
    sleep: async () => {},
  });

  const result = await synchronizer.refreshInventory();

  assert.deepEqual(result, {
    plants: 2,
    devices: 2,
    diagnostics: [
      { scope: 'plant', page: 1, index: 1, reason: 'invalid_record' },
      { scope: 'device', batch: 1, index: 1, reason: 'invalid_record' },
      { scope: 'device', batch: 1, index: 2, reason: 'invalid_record' },
    ],
  });
  assert.deepEqual(
    store.plantWrites[0].map((item) => item.plantCode),
    ['NE=VALID-1', 'NE=VALID-2'],
  );
  assert.deepEqual(
    store.deviceWrites[0].map((item) => [item.deviceId, item.plantCode]),
    [['200', 'NE=VALID-1'], ['201', 'NE=VALID-2']],
  );
  const diagnostics = JSON.stringify(result.diagnostics);
  assert.doesNotMatch(diagnostics, /PLANT-SECRET|DEVICE-TOKEN|RAW-ERROR/);
  assert.doesNotMatch(diagnostics, /plantCode|stationCode|accessToken|rawError/);
});

test('incomplete plant snapshots preserve visibility until a later clean omission', async () => {
  const store = createStore();
  let refresh = 1;
  const knownPlant = plant('NE=KNOWN', 'Known plant');
  const currentPlant = plant('NE=CURRENT', 'Current plant');
  const client = {
    async request(path, options) {
      if (path === DEVICE_PATH) {
        return response({
          success: true,
          data: [],
          failCode: 0,
          params: {
            stationCodes: JSON.parse(options.body).stationCodes,
            currentTime: 1785924000000,
          },
          message: null,
        });
      }

      assert.equal(path, PLANT_PATH);
      let list;
      if (refresh === 1) {
        list = [knownPlant];
      } else if (refresh === 2) {
        list = [
          { ...knownPlant, capacity: 'malformed-double', accessToken: 'MUST-NOT-LEAK' },
          currentPlant,
        ];
      } else {
        list = [currentPlant];
      }
      return response({
        success: true,
        data: {
          list,
          pageCount: 1,
          pageNo: 1,
          pageSize: list.length,
          total: list.length,
        },
        failCode: 0,
        message: null,
      });
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: {},
    now: () => new Date(`2026-08-05T10:0${refresh - 1}:00Z`),
    sleep: async () => {},
  });

  assert.deepEqual(await synchronizer.refreshInventory(), { plants: 1, devices: 0 });
  assert.deepEqual(
    store.checkpointWrites[0].plants.map((item) => item.plantCode),
    ['NE=KNOWN'],
  );

  refresh = 2;
  const incomplete = await synchronizer.refreshInventory();
  assert.deepEqual(incomplete, {
    plants: 1,
    devices: 0,
    diagnostics: [
      { scope: 'plant', page: 1, index: 0, reason: 'invalid_record' },
    ],
  });
  assert.deepEqual(
    store.plantWrites[1].map((item) => [item.plantCode, item.visible]),
    [['NE=CURRENT', true]],
  );
  assert.deepEqual(
    store.checkpointWrites[1].plants.map((item) => [item.plantCode, item.visible]),
    [['NE=KNOWN', true], ['NE=CURRENT', true]],
  );
  assert.doesNotMatch(JSON.stringify(incomplete.diagnostics), /MUST-NOT-LEAK|accessToken/);

  refresh = 3;
  assert.deepEqual(await synchronizer.refreshInventory(), { plants: 1, devices: 0 });
  assert.deepEqual(
    store.plantWrites[2].map((item) => [item.plantCode, item.visible]),
    [['NE=CURRENT', true], ['NE=KNOWN', false]],
  );
  assert.deepEqual(
    store.checkpointWrites[2].plants.map((item) => item.plantCode),
    ['NE=CURRENT'],
  );
});

test('malformed device snapshots preserve prior visibility until a clean omission', async () => {
  const store = createStore();
  let refresh = 1;
  const client = {
    async request(path, options) {
      if (path === PLANT_PATH) {
        return response({
          success: true,
          data: {
            list: [plant('NE=KNOWN', 'Known plant')],
            pageCount: 1,
            pageNo: 1,
          },
          failCode: 0,
        });
      }
      assert.equal(path, DEVICE_PATH);
      const records = refresh === 1
        ? [{
          id: 1,
          devDn: 'NE=DEVICE-1',
          stationCode: 'NE=KNOWN',
          devTypeId: 1,
        }]
        : refresh === 2
          ? [{
            id: null,
            stationCode: 'NE=KNOWN',
            devTypeId: 1,
            rawToken: 'MUST-NOT-LEAK',
          }]
          : [];
      return response({
        success: true,
        data: records,
        failCode: 0,
        params: { stationCodes: JSON.parse(options.body).stationCodes },
      });
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    now: () => new Date(`2026-08-05T10:0${refresh - 1}:00Z`),
  });

  await synchronizer.refreshInventory();
  refresh = 2;
  const incomplete = await synchronizer.refreshInventory();
  assert.deepEqual(store.deviceWrites[1], []);
  assert.equal(store.checkpointWrites[1].devices[0].visible, true);
  assert.doesNotMatch(JSON.stringify(incomplete), /MUST-NOT-LEAK|rawToken/);

  refresh = 3;
  await synchronizer.refreshInventory();
  assert.deepEqual(
    store.deviceWrites[2].map((item) => [item.deviceId, item.visible]),
    [['1', false]],
  );
});

test('inventory failures persist exponential backoff and block calls after restart', async () => {
  const store = createStore();
  let current = Date.parse('2026-08-05T10:00:00Z');
  let calls = 0;
  const client = {
    async request() {
      calls += 1;
      const error = new Error('raw provider failure');
      error.status = 503;
      error.retryAfterMs = 90_000;
      error.transient = true;
      throw error;
    },
  };
  const first = createSynchronizer({
    client,
    store,
    now: () => new Date(current),
    random: () => 0.5,
  });

  assert.deepEqual(await first.refreshInventory(), {
    state: 'backoff',
    retryAt: '2026-08-05T10:01:30.000Z',
  });
  assert.equal(store.checkpointWrites[0].failureAttempts, 1);
  assert.equal(store.checkpointOptions[0].lastError, 'inventory request deferred');

  current += 60_000;
  const restarted = createSynchronizer({
    client,
    store,
    now: () => new Date(current),
    random: () => 0.5,
  });
  assert.deepEqual(await restarted.refreshInventory(), {
    state: 'backoff',
    retryAt: '2026-08-05T10:01:30.000Z',
  });
  assert.equal(calls, 1);
});
