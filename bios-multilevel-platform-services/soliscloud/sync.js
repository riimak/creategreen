const {
  normalizeStation,
  normalizeInverter,
  stationMeasurements,
  inverterMeasurements,
  inverterDayMeasurements,
} = require('./metric-registry');

const STATION_LIST_PATH = '/v1/api/userStationList';
const INVERTER_LIST_PATH = '/v1/api/inverterList';
const INVERTER_DAY_PATH = '/v1/api/inverterDay';
const LIVE_CHECKPOINT = 'live';
const PAGE_SIZE = 100;
const DEFAULT_PAGE_CAP = 50;
const DEFAULT_TRANSIENT_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

function createSynchronizer({
  client,
  store,
  config = {},
  now = () => new Date(),
  random = Math.random,
} = {}) {
  if (!client || typeof client.post !== 'function') {
    throw new Error('SolisCloud synchronizer requires a client');
  }
  if (!store || typeof store.upsertPlants !== 'function' || typeof store.saveMeasurementsAndCheckpoint !== 'function') {
    throw new Error('SolisCloud synchronizer requires a store');
  }
  const backfillDays = config.backfillDays || 90;
  const backfillStepsPerCycle = config.backfillStepsPerCycle || 10;
  const allowedStationIds = Array.isArray(config.stationIds) && config.stationIds.length > 0
    ? new Set(config.stationIds.map(String))
    : null;
  let liveRun = null;

  function runLiveCycle() {
    if (liveRun) return liveRun;
    liveRun = doLiveCycle().finally(() => {
      liveRun = null;
    });
    return liveRun;
  }

  async function doLiveCycle() {
    const checkpoint = await store.getCheckpoint(LIVE_CHECKPOINT) || {};
    if (isBackoffActive(checkpoint.backoffUntil, now())) {
      return { state: 'backoff', retryAt: checkpoint.backoffUntil, solisFailureDelta: 0 };
    }
    try {
      return await performLiveCycle(checkpoint);
    } catch (error) {
      const failureAttempts = nonNegativeInteger(checkpoint.failureAttempts) + 1;
      const backoffUntil = new Date(now().getTime() + backoffDelayMs(failureAttempts, random));
      await store.setCheckpoint(
        LIVE_CHECKPOINT,
        { ...checkpoint, failureAttempts, backoffUntil: backoffUntil.toISOString() },
        { backoffUntil, lastError: 'live cycle failed' },
      );
      return {
        state: 'backoff',
        retryAt: backoffUntil.toISOString(),
        solisFailureDelta: 1,
        error: error.message,
      };
    }
  }

  async function performLiveCycle(checkpoint) {
    const stationPages = await fetchPaged(STATION_LIST_PATH, 'station list');
    const stations = [];
    const measurements = [];
    const skipped = [];
    const stationRawById = new Map();
    const excludedStationIds = new Set();
    for (const record of stationPages) {
      let station;
      try {
        station = normalizeStation(record);
      } catch {
        skipped.push('station');
        continue;
      }
      if (allowedStationIds && !allowedStationIds.has(station.stationId)) {
        // Visible to the account but deliberately out of scope.
        excludedStationIds.add(station.stationId);
        continue;
      }
      stations.push(station);
      stationRawById.set(station.stationId, record);
    }

    const inverterPages = await fetchPaged(INVERTER_LIST_PATH, 'inverter list');
    const stationIds = new Set(stations.map((station) => station.stationId));
    const devices = [];
    for (const record of inverterPages) {
      let device;
      try {
        device = normalizeInverter(record);
      } catch {
        skipped.push('inverter');
        continue;
      }
      if (excludedStationIds.has(device.stationId)) continue;
      if (!stationIds.has(device.stationId)) {
        // An inverter bound to a station this account cannot see; skip rather
        // than violate the plants foreign key.
        skipped.push('inverter');
        continue;
      }
      devices.push(device);
      const normalized = inverterMeasurements(record, device);
      measurements.push(...normalized.measurements);
      skipped.push(...normalized.skipped);
    }

    for (const station of stations) {
      const normalized = stationMeasurements(stationRawById.get(station.stationId), station);
      measurements.push(...normalized.measurements);
      skipped.push(...normalized.skipped);
    }

    // Hide previously known assets that disappeared from a complete snapshot.
    const previousPlants = await store.listPlants();
    const previousDevices = await store.listDevices();
    const currentSns = new Set(devices.map((device) => device.deviceSn));
    const missingPlants = previousPlants
      .filter((plant) => !stationIds.has(plant.stationId))
      .map((plant) => ({ ...plant, visible: false }));
    const missingDevices = previousDevices
      .filter((device) => !currentSns.has(device.deviceSn))
      .map((device) => ({ ...device, visible: false }));

    await store.upsertPlants([...stations, ...missingPlants]);
    await store.upsertDevices([...devices, ...missingDevices]);

    const completedAt = now();
    await store.saveMeasurementsAndCheckpoint(
      measurements,
      LIVE_CHECKPOINT,
      {
        ...checkpoint,
        completedAt: completedAt.toISOString(),
        failureAttempts: 0,
        backoffUntil: null,
      },
      { backoffUntil: null, lastSuccessAt: completedAt, lastError: null },
    );
    return {
      state: 'ok',
      plants: stations.length,
      devices: devices.length,
      measurements: measurements.length,
      skipped: skipped.length,
      solisFailureDelta: 0,
    };
  }

  async function fetchPaged(path, operation) {
    const records = [];
    for (let pageNo = 1; pageNo <= DEFAULT_PAGE_CAP; pageNo += 1) {
      const payload = await client.post(path, { pageNo, pageSize: PAGE_SIZE });
      const page = payload?.data?.page;
      if (!page || !Array.isArray(page.records)) {
        throw new Error(`SolisCloud ${operation} returned an invalid response`);
      }
      records.push(...page.records);
      const pages = Number(page.pages);
      if (!Number.isFinite(pages) || pageNo >= pages) return records;
    }
    throw new Error(`SolisCloud ${operation} exceeded the page safety cap`);
  }

  async function runBackfillBatch() {
    let steps = 0;
    let rows = 0;
    let failures = 0;
    let state = 'complete';
    for (; steps < backfillStepsPerCycle; steps += 1) {
      const result = await runBackfillStep();
      rows += result.rows;
      failures += result.solisFailureDelta;
      state = result.state;
      if (result.state !== 'progress') break;
    }
    return { state, steps, rows, solisFailureDelta: failures };
  }

  async function runBackfillStep() {
    const plants = await store.listPlants();
    const plantsById = new Map(plants.map((plant) => [plant.stationId, plant]));
    const devices = (await store.listDevices())
      .filter((device) => plantsById.has(device.stationId));

    for (const device of devices) {
      const key = `backfill:device:${device.deviceSn}`;
      const plant = plantsById.get(device.stationId);
      const checkpoint = await store.getCheckpoint(key) || {};
      if (checkpoint.reachedBoundary) continue;
      if (isBackoffActive(checkpoint.backoffUntil, now())) continue;

      const timezone = finiteNumber(plant.timezone) ?? 0;
      const today = localDate(now().getTime(), timezone);
      const boundary = boundaryDate(plant, timezone);
      const cursor = typeof checkpoint.cursorDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(checkpoint.cursorDate)
        ? checkpoint.cursorDate
        : today;

      if (cursor < boundary) {
        await store.setCheckpoint(key, {
          ...checkpoint,
          cursorDate: cursor,
          reachedBoundary: true,
          backoffUntil: null,
          failureAttempts: 0,
        }, { lastSuccessAt: now(), lastError: null });
        continue;
      }

      try {
        const payload = await client.post(INVERTER_DAY_PATH, {
          sn: device.deviceSn,
          money: '',
          time: cursor,
          timeZone: String(timezone),
        });
        if (!Array.isArray(payload?.data)) {
          throw new Error('SolisCloud inverter day returned an invalid response');
        }
        const measurements = [];
        let skipped = 0;
        for (const point of payload.data) {
          const normalized = inverterDayMeasurements(point, device);
          measurements.push(...normalized.measurements);
          skipped += normalized.skipped.length;
        }
        const nextCursor = previousDate(cursor);
        const reachedBoundary = nextCursor < boundary;
        await store.saveMeasurementsAndCheckpoint(
          measurements,
          key,
          {
            cursorDate: nextCursor,
            reachedBoundary,
            backoffUntil: null,
            failureAttempts: 0,
          },
          { backoffUntil: null, lastSuccessAt: now(), lastError: null },
        );
        return {
          state: reachedBoundary ? 'complete' : 'progress',
          device: device.deviceSn,
          date: cursor,
          rows: measurements.length,
          skipped,
          solisFailureDelta: 0,
        };
      } catch {
        const failureAttempts = nonNegativeInteger(checkpoint.failureAttempts) + 1;
        const backoffUntil = new Date(now().getTime() + backoffDelayMs(failureAttempts, random));
        await store.setCheckpoint(key, {
          ...checkpoint,
          cursorDate: cursor,
          reachedBoundary: false,
          backoffUntil: backoffUntil.toISOString(),
          failureAttempts,
        }, { backoffUntil, lastError: 'backfill request failed' });
        return {
          state: 'backoff',
          device: device.deviceSn,
          date: cursor,
          rows: 0,
          solisFailureDelta: 1,
        };
      }
    }
    return { state: 'complete', rows: 0, solisFailureDelta: 0 };
  }

  function boundaryDate(plant, timezone) {
    const configured = localDate(now().getTime() - backfillDays * DAY_MS, timezone);
    const firstPower = finiteNumber(plant?.metadata?.fisPowerTime)
      ?? finiteNumber(plant?.metadata?.fisGenerateTime)
      ?? finiteNumber(plant?.metadata?.createDate);
    if (firstPower == null) return configured;
    const commissioned = localDate(firstPower, timezone);
    return commissioned > configured ? commissioned : configured;
  }

  return { runLiveCycle, runBackfillBatch, runBackfillStep };
}

function localDate(epochMs, timezoneHours) {
  return new Date(epochMs + timezoneHours * 3_600_000).toISOString().slice(0, 10);
}

function previousDate(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  return new Date(parsed.getTime() - DAY_MS).toISOString().slice(0, 10);
}

function isBackoffActive(value, currentTime) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > currentTime.getTime();
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function backoffDelayMs(attempt, random) {
  const exponent = Math.min(10, Math.max(0, attempt - 1));
  const exponential = Math.min(MAX_BACKOFF_MS, DEFAULT_TRANSIENT_BACKOFF_MS * (2 ** exponent));
  const randomValue = Number(random());
  const jitterFactor = Number.isFinite(randomValue)
    ? 0.5 + Math.min(1, Math.max(0, randomValue))
    : 1;
  return Math.min(MAX_BACKOFF_MS, Math.round(exponential * jitterFactor));
}

module.exports = {
  STATION_LIST_PATH,
  INVERTER_LIST_PATH,
  INVERTER_DAY_PATH,
  createSynchronizer,
};
