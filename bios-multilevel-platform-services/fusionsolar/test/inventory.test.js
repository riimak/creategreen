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
  return {
    plantWrites,
    deviceWrites,
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
      assert.equal(options.lastError, null);
      checkpoint = structuredClone(value);
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
