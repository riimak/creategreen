const {
  REGISTRY,
  normalizePlant,
  normalizeDevice,
  normalizeKpis,
} = require('./metric-registry');

const PLANT_LIST_PATH = '/thirdData/stations';
const DEVICE_LIST_PATH = '/thirdData/getDevList';
const PLANT_REALTIME_PATH = '/thirdData/getStationRealKpi';
const DEVICE_REALTIME_PATH = '/thirdData/getDevRealKpi';
const HISTORICAL_DEVICE_PATH = '/rest/openapi/pvms/nbi/v1/device/history';
const INVENTORY_CHECKPOINT = 'inventory';
const LIVE_CHECKPOINT = 'live';
const DEVICE_PLANT_BATCH_SIZE = 100;
const REALTIME_BATCH_SIZE = 100;
const DEFAULT_INVENTORY_PAGE_CAP = 1000;
const DEFAULT_INVENTORY_INTERVAL_MS = 60 * 60_000;
const DEFAULT_BACKFILL_WINDOW_MS = 24 * 60 * 60_000;
const MIN_BACKFILL_WINDOW_MS = 5 * 60_000;
const DEFAULT_TRANSIENT_BACKOFF_MS = 1000;
const DEFAULT_THROTTLE_BACKOFF_MS = 60_000;

function createSynchronizer({
  client,
  store,
  config = {},
  now = () => new Date(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  validateDependencies(client, store, now, sleep);
  const pageCap = inventoryPageCap(config.inventoryPageCap);
  const inventoryIntervalMs = positiveDuration(
    config.inventoryIntervalMs,
    DEFAULT_INVENTORY_INTERVAL_MS,
    'inventoryIntervalMs',
  );
  const initialBackfillWindowMs = positiveDuration(
    config.backfillWindowMs,
    DEFAULT_BACKFILL_WINDOW_MS,
    'backfillWindowMs',
  );
  let liveRun = null;
  let backfillRun = null;
  let backfillAbort = null;

  async function refreshInventory() {
    const previous = await store.getCheckpoint(INVENTORY_CHECKPOINT);
    const previousPlants = checkpointPlants(previous);
    const plantInventory = await fetchAllPlants();
    const currentPlants = plantInventory.records;
    const currentByCode = new Map(currentPlants.map((plant) => [plant.plantCode, plant]));
    const deviceInventory = await fetchAllDevices(currentPlants.map((plant) => plant.plantCode));
    const devices = deviceInventory.records;
    const diagnostics = [...plantInventory.diagnostics, ...deviceInventory.diagnostics];
    const plantSnapshotIncomplete = plantInventory.diagnostics.length > 0;
    const missingPlants = plantSnapshotIncomplete
      ? []
      : previousPlants
        .filter((plant) => !currentByCode.has(plant.plantCode))
        .map((plant) => ({ ...plant, visible: false }));
    const checkpointPlantRecords = plantSnapshotIncomplete
      ? mergePlants(previousPlants, currentPlants)
      : currentPlants;

    await store.upsertPlants([...currentPlants, ...missingPlants]);
    await store.upsertDevices(devices);
    const refreshedAt = currentTime().toISOString();
    await store.setCheckpoint(
      INVENTORY_CHECKPOINT,
      { plants: checkpointPlantRecords, refreshedAt },
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

  async function requestJson(path, body, operation, signal, oneCall = false) {
    let response;
    try {
      response = await client.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        retryTransient: !oneCall,
        retryUnauthorized: !oneCall,
      });
    } catch (error) {
      throw new SyncApiError(`Huawei ${operation} request failed`, {
        status: error?.status,
        retryAfterMs: error?.retryAfterMs,
        transient: error?.transient === true || error?.permanent === false,
      });
    }
    const retryAfterMs = parseRetryAfter(response, currentTime());
    if (response.ok === false) {
      throw new SyncApiError(`Huawei ${operation} request failed`, {
        status: response.status,
        retryAfterMs,
        transient: isTransientStatus(response.status),
      });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new SyncApiError(`Huawei ${operation} returned invalid JSON`);
    }
    const failCode = safeFailCode(payload);
    if (!payload || payload.success !== true || failCode !== 0) {
      throw new SyncApiError(`Huawei ${operation} request failed`, {
        failCode,
        retryAfterMs,
        transient: failCode === 407 || failCode === 429,
      });
    }
    return { payload, response };
  }

  function currentTime() {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error('FusionSolar synchronizer clock returned an invalid date');
    }
    return value;
  }

  function runLiveCycle() {
    if (liveRun) return liveRun;
    if (backfillAbort) backfillAbort.abort();
    liveRun = doLiveCycle().finally(() => {
      liveRun = null;
    });
    return liveRun;
  }

  async function doLiveCycle() {
    requireIngestionStore(store);
    if (await inventoryIsStale()) await refreshInventory();

    const plants = await store.listPlants();
    const visiblePlants = plants.filter((plant) => plant.visible !== false);
    const visibleByCode = new Map(visiblePlants.map((plant) => [plant.plantCode, plant]));
    const devices = (await store.listDevices()).filter((device) => (
      visibleByCode.has(device.plantCode) && REGISTRY[String(device.deviceType)]
    ));
    const measurements = [];
    const failures = [];
    let skipped = 0;
    let backoffUntil = null;

    for (let offset = 0; offset < visiblePlants.length; offset += REALTIME_BATCH_SIZE) {
      const batch = visiblePlants.slice(offset, offset + REALTIME_BATCH_SIZE);
      const batchNumber = Math.floor(offset / REALTIME_BATCH_SIZE) + 1;
      try {
        const { payload } = await requestJson(
          PLANT_REALTIME_PATH,
          { stationCodes: batch.map((plant) => plant.plantCode).join(',') },
          'real-time plant data',
        );
        const timestamp = responseTimestamp(payload, 'real-time plant data');
        if (!Array.isArray(payload.data)) {
          throw new SyncApiError('Huawei real-time plant data returned an invalid response');
        }
        const expected = new Map(batch.map((plant) => [plant.plantCode, plant]));
        const seen = new Set();
        for (const record of payload.data) {
          const plant = expected.get(record?.stationCode);
          if (!plant || seen.has(plant.plantCode)) {
            failures.push({
              scope: `plant:batch:${batchNumber}`,
              reason: 'invalid_response',
            });
            continue;
          }
          seen.add(plant.plantCode);
          try {
            const normalized = normalizeKpis({
              source: plant.sourceKey,
              deviceType: 'plant',
              timestamp,
              payload: record.dataItemMap,
            });
            measurements.push(...normalized.measurements);
            skipped += normalized.skipped.length;
          } catch {
            failures.push({
              scope: `plant:${plant.plantCode}`,
              reason: 'invalid_response',
            });
          }
        }
        for (const plant of batch) {
          if (!seen.has(plant.plantCode)) {
            failures.push({
              scope: `plant:${plant.plantCode}`,
              reason: 'missing_response',
            });
          }
        }
      } catch (error) {
        const failure = liveFailure(error, `plant:batch:${batchNumber}`, currentTime());
        failures.push(failure.diagnostic);
        backoffUntil = laterBackoff(backoffUntil, failure.backoffUntil);
      }
    }

    const devicesByType = groupBy(devices, (device) => String(device.deviceType));
    for (const [deviceType, typedDevices] of devicesByType) {
      for (let offset = 0; offset < typedDevices.length; offset += REALTIME_BATCH_SIZE) {
        const batch = typedDevices.slice(offset, offset + REALTIME_BATCH_SIZE);
        const batchNumber = Math.floor(offset / REALTIME_BATCH_SIZE) + 1;
        try {
          const { payload } = await requestJson(
            DEVICE_REALTIME_PATH,
            {
              devIds: batch.map((device) => device.deviceId).join(','),
              devTypeId: Number(deviceType),
            },
            'real-time device data',
          );
          const timestamp = responseTimestamp(payload, 'real-time device data');
          if (!Array.isArray(payload.data)) {
            throw new SyncApiError('Huawei real-time device data returned an invalid response');
          }
          const expected = new Map(batch.map((device) => [String(device.deviceId), device]));
          const seen = new Set();
          for (const record of payload.data) {
            const device = expected.get(String(record?.devId));
            if (!device || seen.has(device.deviceId)) {
              failures.push({
                scope: `device:${deviceType}:batch:${batchNumber}`,
                reason: 'invalid_response',
              });
              continue;
            }
            seen.add(device.deviceId);
            try {
              const normalized = normalizeKpis({
                source: deviceSource(visibleByCode.get(device.plantCode), device),
                deviceType,
                timestamp,
                payload: record.dataItemMap,
              });
              measurements.push(...normalized.measurements);
              skipped += normalized.skipped.length;
            } catch {
              failures.push({
                scope: `device:${device.deviceId}`,
                reason: 'invalid_response',
              });
            }
          }
          for (const device of batch) {
            if (!seen.has(device.deviceId)) {
              failures.push({
                scope: `device:${device.deviceId}`,
                reason: 'missing_response',
              });
            }
          }
        } catch (error) {
          const failure = liveFailure(
            error,
            `device:${deviceType}:batch:${batchNumber}`,
            currentTime(),
          );
          failures.push(failure.diagnostic);
          backoffUntil = laterBackoff(backoffUntil, failure.backoffUntil);
        }
      }
    }

    const completedAt = currentTime();
    const checkpoint = {
      completedAt: completedAt.toISOString(),
      backoffUntil: backoffUntil?.toISOString() || null,
    };
    await store.saveMeasurementsAndCheckpoint(
      measurements,
      LIVE_CHECKPOINT,
      checkpoint,
      {
        backoffUntil,
        lastSuccessAt: completedAt,
        lastError: failures.length > 0 ? 'live cycle completed with failures' : null,
      },
    );
    return {
      plants: visiblePlants.length,
      devices: devices.length,
      measurements: measurements.length,
      skipped,
      failures,
    };
  }

  function runBackfillStep() {
    if (backfillRun) return backfillRun;
    const controller = new AbortController();
    backfillAbort = controller;
    backfillRun = doBackfillStep(controller).finally(() => {
      if (backfillAbort === controller) backfillAbort = null;
      backfillRun = null;
    });
    return backfillRun;
  }

  async function doBackfillStep(controller) {
    requireIngestionStore(store);
    const devices = await eligibleBackfillDevices(store);
    if (controller.signal.aborted) {
      return backfillResult('live_pending', null, 0, false);
    }
    const selection = await nextBackfillCandidate(devices);
    if (controller.signal.aborted) {
      return backfillResult('live_pending', null, 0, false);
    }
    const { candidate } = selection;
    if (!candidate) {
      if (selection.retryAt) {
        return backfillResult('backoff', null, 0, false, {
          retryAt: selection.retryAt,
        });
      }
      return backfillResult('complete', null, 0, true);
    }
    const { device, plant, key, checkpoint } = candidate;
    const before = finiteTimestamp(checkpoint.before, currentTime().getTime());

    if (liveRun) return backfillResult('live_pending', before, 0, false);
    const liveCheckpoint = await store.getCheckpoint(LIVE_CHECKPOINT);
    if (isBackoffActive(liveCheckpoint?.backoffUntil, currentTime())) {
      return backfillResult('backoff', null, 0, false);
    }
    if (isBackoffActive(checkpoint.backoffUntil, currentTime())) {
      return backfillResult('backoff', before, 0, false);
    }

    const windowMs = positiveDuration(
      checkpoint.windowMs,
      initialBackfillWindowMs,
      'backfill checkpoint windowMs',
    );
    const startTime = before - windowMs;
    let response;
    try {
      response = await requestJson(
        HISTORICAL_DEVICE_PATH,
        {
          devDn: device.metadata.devDn,
          devTypeId: Number(device.deviceType),
          startTime,
          endTime: before,
        },
        'historical device data',
        controller.signal,
        true,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        return backfillResult('live_pending', before, 0, false);
      }
      if (error.failCode === 40001 && windowMs > MIN_BACKFILL_WINDOW_MS) {
        const reduced = Math.max(MIN_BACKFILL_WINDOW_MS, Math.floor(windowMs / 2));
        const resized = {
          ...checkpoint,
          before,
          windowMs: reduced,
          reachedBoundary: false,
          backoffUntil: null,
        };
        await store.setCheckpoint(key, resized, { lastError: null });
        return backfillResult('range_reduced', before, 0, false);
      }
      if (isFlowOrTransient(error)) {
        const backoffUntil = new Date(
          currentTime().getTime() + retryDelayMs(error),
        );
        const deferred = {
          ...checkpoint,
          before,
          windowMs,
          reachedBoundary: false,
          backoffUntil: backoffUntil.toISOString(),
        };
        await store.setCheckpoint(key, deferred, {
          backoffUntil,
          lastError: 'historical request deferred',
        });
        return backfillResult('backoff', before, 0, false);
      }
      await store.setCheckpoint(key, {
        ...checkpoint,
        before,
        windowMs,
        reachedBoundary: false,
      }, { lastError: 'historical request failed' });
      return backfillResult('error', before, 0, false);
    }

    const { payload } = response;
    if (!Array.isArray(payload.data)) {
      await store.setCheckpoint(key, {
        ...checkpoint,
        before,
        windowMs,
        reachedBoundary: false,
      }, { lastError: 'historical response invalid' });
      return backfillResult('error', before, 0, false);
    }

    const measurements = [];
    const skipped = [];
    for (let index = 0; index < payload.data.length; index += 1) {
      const record = payload.data[index];
      if (
        record?.devDn !== device.metadata.devDn
        || !Number.isFinite(Number(record.collectTime))
        || !record.dataItems
        || typeof record.dataItems !== 'object'
        || Array.isArray(record.dataItems)
      ) {
        skipped.push(invalidRecordDiagnostic(`device:${device.deviceId}`, { index }));
        continue;
      }
      try {
        measurements.push(...normalizeKpis({
          source: deviceSource(plant, device),
          deviceType: device.deviceType,
          timestamp: Number(record.collectTime),
          payload: record.dataItems,
        }).measurements);
      } catch {
        skipped.push(invalidRecordDiagnostic(`device:${device.deviceId}`, { index }));
      }
    }
    const reachedBoundary = payload.data.length === 0;
    const nextCheckpoint = {
      before: startTime,
      windowMs,
      reachedBoundary,
      backoffUntil: null,
    };
    const savedAt = currentTime();
    await store.saveMeasurementsAndCheckpoint(
      measurements,
      key,
      nextCheckpoint,
      {
        backoffUntil: null,
        lastSuccessAt: savedAt,
        lastError: null,
      },
    );
    return backfillResult(
      reachedBoundary ? 'complete' : 'progress',
      startTime,
      measurements.length,
      reachedBoundary,
      skipped.length > 0 ? { skipped } : undefined,
    );
  }

  async function inventoryIsStale() {
    const checkpoint = await store.getCheckpoint(INVENTORY_CHECKPOINT);
    const refreshedAt = Date.parse(checkpoint?.refreshedAt);
    return !Number.isFinite(refreshedAt)
      || currentTime().getTime() - refreshedAt >= inventoryIntervalMs;
  }

  async function nextBackfillCandidate(devices) {
    let retryAt = null;
    let retryAtMs = Infinity;
    for (const { device, plant } of devices) {
      const key = `backfill:device:${device.deviceId}`;
      const state = typeof store.getSyncState === 'function'
        ? await store.getSyncState(key)
        : null;
      const checkpoint = state?.checkpoint || await store.getCheckpoint(key) || {};
      if (!checkpoint.reachedBoundary) {
        const candidateCheckpoint = {
          ...checkpoint,
          backoffUntil: checkpoint.backoffUntil
            || timestampString(state?.backoffUntil),
        };
        if (isBackoffActive(candidateCheckpoint.backoffUntil, currentTime())) {
          const candidateRetryAt = timestampString(candidateCheckpoint.backoffUntil);
          const candidateRetryAtMs = Date.parse(candidateRetryAt);
          if (candidateRetryAtMs < retryAtMs) {
            retryAt = candidateRetryAt;
            retryAtMs = candidateRetryAtMs;
          }
          continue;
        }
        return { candidate: {
          device,
          plant,
          key,
          checkpoint: candidateCheckpoint,
        }, retryAt: null };
      }
    }
    return { candidate: null, retryAt };
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

function mergePlants(previousPlants, currentPlants) {
  return deduplicatePlants([...previousPlants, ...currentPlants]);
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

class SyncApiError extends Error {
  constructor(message, {
    failCode,
    status,
    retryAfterMs,
    transient = false,
  } = {}) {
    super(message);
    this.name = 'SyncApiError';
    this.failCode = failCode;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.transient = transient;
  }
}

function positiveDuration(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function responseTimestamp(payload, operation) {
  const timestamp = Number(payload?.params?.currentTime);
  if (!Number.isFinite(timestamp)) {
    throw new SyncApiError(`Huawei ${operation} returned an invalid collection timestamp`);
  }
  return timestamp;
}

function groupBy(rows, keyFor) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function deviceSource(plant, device) {
  if (!plant?.sourceKey) throw new Error('device plant source is missing');
  return `${plant.sourceKey}:device:${device.deviceId}`;
}

function parseRetryAfter(response, now) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now.getTime()) : null;
}

function safeFailCode(payload) {
  const value = Number(payload?.failCode);
  return Number.isInteger(value) ? value : undefined;
}

function isTransientStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isFlowOrTransient(error) {
  return error?.failCode === 407
    || error?.failCode === 429
    || error?.failCode === 20004
    || error?.status === 429
    || error?.transient === true
    || isTransientStatus(error?.status);
}

function retryDelayMs(error) {
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) {
    return error.retryAfterMs;
  }
  if (error?.failCode === 407) return 5 * 60_000;
  if (error?.failCode === 429 || error?.status === 429) {
    return DEFAULT_THROTTLE_BACKOFF_MS;
  }
  return DEFAULT_TRANSIENT_BACKOFF_MS;
}

function liveFailure(error, scope, now) {
  const flowControlled = isFlowOrTransient(error);
  return {
    diagnostic: {
      scope,
      reason: flowControlled ? 'flow_controlled' : 'request_failed',
    },
    backoffUntil: flowControlled
      ? new Date(now.getTime() + retryDelayMs(error))
      : null,
  };
}

function laterBackoff(current, candidate) {
  if (!candidate) return current;
  if (!current || candidate.getTime() > current.getTime()) return candidate;
  return current;
}

function finiteTimestamp(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function timestampString(value) {
  if (value == null) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function isBackoffActive(value, now) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function backfillResult(state, nextBefore, rows, reachedBoundary, details) {
  return {
    state,
    nextBefore,
    rows,
    reachedBoundary,
    ...(details || {}),
  };
}

async function eligibleBackfillDevices(store) {
  const plants = (await store.listPlants()).filter((plant) => plant.visible !== false);
  const plantsByCode = new Map(plants.map((plant) => [plant.plantCode, plant]));
  return (await store.listDevices())
    .filter((device) => (
      plantsByCode.has(device.plantCode)
      && REGISTRY[String(device.deviceType)]
      && typeof device.metadata?.devDn === 'string'
      && device.metadata.devDn.trim() !== ''
    ))
    .map((device) => ({ device, plant: plantsByCode.get(device.plantCode) }));
}

function requireIngestionStore(store) {
  for (const method of [
    'listPlants',
    'listDevices',
    'saveMeasurementsAndCheckpoint',
  ]) {
    if (typeof store[method] !== 'function') {
      throw new Error(`FusionSolar synchronizer store requires ${method}`);
    }
  }
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
  PLANT_REALTIME_PATH,
  DEVICE_REALTIME_PATH,
  HISTORICAL_DEVICE_PATH,
  createSynchronizer,
};
