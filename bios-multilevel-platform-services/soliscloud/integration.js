const { configurationState } = require('./config');

function createIntegration({
  config,
  store,
  synchronizer,
  clock = {},
} = {}) {
  const configured = configurationState(config || {}) === 'configured';
  const timer = {
    now: typeof clock.now === 'function' ? clock.now : () => new Date(),
    setTimeout: typeof clock.setTimeout === 'function' ? clock.setTimeout : setTimeout,
    clearTimeout: typeof clock.clearTimeout === 'function' ? clock.clearTimeout : clearTimeout,
  };
  let schedulerStarted = false;
  let scheduledTimer = null;
  let activeCycle = null;
  let schedulerError = null;
  let nextCycleDelayMs = config?.liveIntervalMs || 0;

  function startScheduler() {
    if (!configured) return Promise.resolve();
    if (schedulerStarted) return activeCycle || Promise.resolve();
    schedulerStarted = true;
    return runScheduledCycle();
  }

  function stopScheduler() {
    schedulerStarted = false;
    if (scheduledTimer !== null) {
      timer.clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
  }

  function runScheduledCycle() {
    if (!schedulerStarted) return Promise.resolve();
    if (activeCycle) return activeCycle;
    activeCycle = performScheduledCycle()
      .catch(() => {
        schedulerError = 'synchronization failed';
      })
      .finally(() => {
        activeCycle = null;
        if (schedulerStarted && scheduledTimer === null) {
          scheduledTimer = timer.setTimeout(() => {
            scheduledTimer = null;
            return runScheduledCycle();
          }, nextCycleDelayMs);
        }
      });
    return activeCycle;
  }

  async function performScheduledCycle() {
    nextCycleDelayMs = config.liveIntervalMs;
    const live = await synchronizer.runLiveCycle();
    await recordCounters({
      cycles: 1,
      solisFailures: nonNegativeNumber(live?.solisFailureDelta),
      rowsIngested: nonNegativeNumber(live?.measurements),
      skippedFields: nonNegativeNumber(live?.skipped),
    });
    schedulerError = null;
    if (live?.state === 'backoff') {
      nextCycleDelayMs = retryDelayUntil(live.retryAt, timer.now(), config.liveIntervalMs);
      return;
    }
    if (config.backfillEnabled) {
      const backfill = await synchronizer.runBackfillBatch();
      await recordCounters({
        backfillSteps: nonNegativeNumber(backfill?.steps),
        solisFailures: nonNegativeNumber(backfill?.solisFailureDelta),
        rowsIngested: nonNegativeNumber(backfill?.rows),
      });
    }
  }

  async function recordCounters(counters) {
    if (typeof store?.recordCounters === 'function') {
      await store.recordCounters(counters);
    }
  }

  async function status() {
    if (!configured) {
      return {
        state: 'not_configured',
        configured: false,
        plantCount: 0,
        deviceCount: 0,
        lastSyncAt: null,
        backfill: null,
        lastError: null,
        counters: emptyCounters(),
      };
    }
    const stored = await store.status();
    return {
      state: 'configured',
      configured: true,
      plantCount: nonNegativeNumber(stored.plantCount),
      deviceCount: nonNegativeNumber(stored.deviceCount),
      lastSyncAt: stored.lastSuccessAt || null,
      backfill: stored.backfill
        ? {
          completed: nonNegativeNumber(stored.backfill.completed),
          total: nonNegativeNumber(stored.backfill.total),
          lastSuccessAt: stored.backfill.lastSuccessAt || null,
        }
        : null,
      lastError: stored.lastError || schedulerError,
      counters: sanitizeCounters(stored.counters),
    };
  }

  async function close() {
    stopScheduler();
    if (activeCycle) await activeCycle;
    if (typeof store?.close === 'function') await store.close();
  }

  return {
    startScheduler,
    stopScheduler,
    status,
    close,
  };
}

async function buildIntegration(config, dependencies = {}) {
  if (configurationState(config) !== 'configured') {
    return createIntegration({ config, clock: dependencies.clock });
  }
  const { createSolisStore } = require('./store');
  const { createSolisClient } = require('./solis-client');
  const { createSynchronizer } = require('./sync');
  const now = dependencies.clock?.now || (() => new Date());
  const store = createSolisStore({
    databaseUrl: config.databaseUrl,
    pool: dependencies.pool,
  });
  await store.init();
  const client = createSolisClient({
    config,
    fetchImpl: dependencies.fetchImpl,
    now,
    sleep: dependencies.sleep,
  });
  const synchronizer = createSynchronizer({
    client,
    store,
    config,
    now,
    random: dependencies.random,
  });
  return createIntegration({
    config,
    store,
    synchronizer,
    clock: dependencies.clock,
  });
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function emptyCounters() {
  return {
    cycles: 0,
    solisFailures: 0,
    rowsIngested: 0,
    skippedFields: 0,
    backfillSteps: 0,
  };
}

function sanitizeCounters(value) {
  const counters = emptyCounters();
  if (!value || typeof value !== 'object') return counters;
  for (const key of Object.keys(counters)) counters[key] = nonNegativeNumber(value[key]);
  return counters;
}

function retryDelayUntil(value, now, fallback) {
  const retryAt = Date.parse(value);
  const current = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(retryAt) || !Number.isFinite(current)) return fallback;
  return Math.max(0, retryAt - current);
}

module.exports = { buildIntegration, createIntegration };
