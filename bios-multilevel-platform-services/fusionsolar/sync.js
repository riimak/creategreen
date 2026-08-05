const {
  normalizePlant,
  normalizeDevice,
} = require('./metric-registry');

const PLANT_LIST_PATH = '/thirdData/stations';
const DEVICE_LIST_PATH = '/thirdData/getDevList';
const INVENTORY_CHECKPOINT = 'inventory';
const DEVICE_PLANT_BATCH_SIZE = 100;
const DEFAULT_INVENTORY_PAGE_CAP = 1000;

function createSynchronizer({
  client,
  store,
  config = {},
  now = () => new Date(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  validateDependencies(client, store, now, sleep);
  const pageCap = inventoryPageCap(config.inventoryPageCap);

  async function refreshInventory() {
    const previous = await store.getCheckpoint(INVENTORY_CHECKPOINT);
    const plantInventory = await fetchAllPlants();
    const currentPlants = plantInventory.records;
    const currentByCode = new Map(currentPlants.map((plant) => [plant.plantCode, plant]));
    const deviceInventory = await fetchAllDevices(currentPlants.map((plant) => plant.plantCode));
    const devices = deviceInventory.records;
    const diagnostics = [...plantInventory.diagnostics, ...deviceInventory.diagnostics];
    const missingPlants = checkpointPlants(previous)
      .filter((plant) => !currentByCode.has(plant.plantCode))
      .map((plant) => ({ ...plant, visible: false }));

    await store.upsertPlants([...currentPlants, ...missingPlants]);
    await store.upsertDevices(devices);
    const refreshedAt = currentTime().toISOString();
    await store.setCheckpoint(
      INVENTORY_CHECKPOINT,
      { plants: currentPlants, refreshedAt },
      { lastSuccessAt: refreshedAt, lastError: null },
    );
    const result = { plants: currentPlants.length, devices: devices.length };
    if (diagnostics.length > 0) result.diagnostics = diagnostics;
    return result;
  }

  async function fetchAllPlants() {
    const plants = [];
    const diagnostics = [];
    const pageSignatures = new Set();
    for (let requestedPage = 1; requestedPage <= pageCap; requestedPage += 1) {
      const payload = await postJson(PLANT_LIST_PATH, { pageNo: requestedPage }, 'plant inventory');
      const data = payload.data;
      if (!data || typeof data !== 'object' || !Array.isArray(data.list)) {
        throw new Error('Huawei plant inventory returned an invalid response');
      }
      const pageNo = positivePageNumber(data.pageNo, 'pageNo');
      const pageCount = nonNegativePageNumber(data.pageCount, 'pageCount');

      const signature = JSON.stringify(data.list);
      if (pageSignatures.has(signature)) {
        throw new Error('Huawei plant inventory returned a repeated page');
      }
      if (pageNo !== requestedPage) {
        throw new Error('Huawei plant inventory returned an unexpected page');
      }
      pageSignatures.add(signature);
      for (let index = 0; index < data.list.length; index += 1) {
        try {
          plants.push(normalizePlant(data.list[index]));
        } catch {
          diagnostics.push(invalidRecordDiagnostic('plant', { page: pageNo, index }));
        }
      }

      if (pageCount === 0 || pageNo >= pageCount) {
        return { records: deduplicatePlants(plants), diagnostics };
      }
    }
    throw new Error('Huawei plant inventory exceeded the page safety cap');
  }

  async function fetchAllDevices(plantCodes) {
    const devices = new Map();
    const diagnostics = [];
    for (let offset = 0; offset < plantCodes.length; offset += DEVICE_PLANT_BATCH_SIZE) {
      const batch = plantCodes.slice(offset, offset + DEVICE_PLANT_BATCH_SIZE);
      const batchNumber = Math.floor(offset / DEVICE_PLANT_BATCH_SIZE) + 1;
      const allowedPlants = new Set(batch);
      const payload = await postJson(
        DEVICE_LIST_PATH,
        { stationCodes: batch.join(',') },
        'device inventory',
      );
      if (!Array.isArray(payload.data)) {
        throw new Error('Huawei device inventory returned an invalid response');
      }
      for (let index = 0; index < payload.data.length; index += 1) {
        try {
          const rawDevice = payload.data[index];
          const plantCode = typeof rawDevice?.stationCode === 'string'
            ? rawDevice.stationCode.trim()
            : '';
          if (!allowedPlants.has(plantCode)) {
            throw new Error('unexpected plant');
          }
          const device = normalizeDevice(rawDevice, plantCode);
          const existing = devices.get(device.deviceId);
          if (existing && existing.plantCode !== device.plantCode) {
            throw new Error('conflicting device');
          }
          devices.set(device.deviceId, device);
        } catch {
          diagnostics.push(invalidRecordDiagnostic('device', {
            batch: batchNumber,
            index,
          }));
        }
      }
    }
    return { records: [...devices.values()], diagnostics };
  }

  async function postJson(path, body, operation) {
    const response = await client.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Huawei ${operation} returned invalid JSON`);
    }
    if (
      !payload
      || payload.success !== true
      || Number(payload.failCode) !== 0
    ) {
      const failCode = Number.isInteger(Number(payload?.failCode))
        ? ` (code ${Number(payload.failCode)})`
        : '';
      throw new Error(`Huawei ${operation} request failed${failCode}`);
    }
    return payload;
  }

  function currentTime() {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error('FusionSolar synchronizer clock returned an invalid date');
    }
    return value;
  }

  async function runLiveCycle() {
    throw new Error('FusionSolar live synchronization is not implemented');
  }

  async function runBackfillStep() {
    throw new Error('FusionSolar backfill is not implemented');
  }

  async function status() {
    return store.status();
  }

  return {
    refreshInventory,
    runLiveCycle,
    runBackfillStep,
    status,
  };
}

function checkpointPlants(checkpoint) {
  if (!checkpoint || !Array.isArray(checkpoint.plants)) return [];
  return checkpoint.plants.filter((plant) => (
    plant
    && typeof plant.plantCode === 'string'
    && typeof plant.sourceKey === 'string'
  ));
}

function deduplicatePlants(plants) {
  const unique = new Map();
  for (const plant of plants) unique.set(plant.plantCode, plant);
  return [...unique.values()];
}

function invalidRecordDiagnostic(scope, location) {
  return {
    scope,
    ...location,
    reason: 'invalid_record',
  };
}

function inventoryPageCap(value) {
  if (value === undefined) return DEFAULT_INVENTORY_PAGE_CAP;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('inventoryPageCap must be a positive integer');
  }
  return value;
}

function positivePageNumber(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Huawei plant inventory returned an invalid ${field}`);
  }
  return value;
}

function nonNegativePageNumber(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Huawei plant inventory returned an invalid ${field}`);
  }
  return value;
}

function validateDependencies(client, store, now, sleep) {
  if (!client || typeof client.request !== 'function') {
    throw new Error('FusionSolar synchronizer requires a Huawei client');
  }
  if (
    !store
    || typeof store.upsertPlants !== 'function'
    || typeof store.upsertDevices !== 'function'
    || typeof store.getCheckpoint !== 'function'
    || typeof store.setCheckpoint !== 'function'
    || typeof store.status !== 'function'
  ) {
    throw new Error('FusionSolar synchronizer requires a store');
  }
  if (typeof now !== 'function' || typeof sleep !== 'function') {
    throw new Error('FusionSolar synchronizer dependencies are invalid');
  }
}

module.exports = {
  PLANT_LIST_PATH,
  DEVICE_LIST_PATH,
  createSynchronizer,
};
