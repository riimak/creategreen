const crypto = require('node:crypto');
const { configurationState } = require('./config');

class OAuthRouteNotFoundError extends Error {
  constructor() {
    super('OAuth route not found');
    this.name = 'OAuthRouteNotFoundError';
  }
}

function createIntegration({
  config,
  store,
  client,
  stateManager,
  synchronizer,
  clock = {},
} = {}) {
  const configured = configurationState(config || {}) === 'configured';
  const timer = {
    now: typeof clock.now === 'function' ? clock.now : () => new Date(),
    setTimeout: typeof clock.setTimeout === 'function' ? clock.setTimeout : setTimeout,
    clearTimeout: typeof clock.clearTimeout === 'function' ? clock.clearTimeout : clearTimeout,
  };
  const setupDigest = digest(config?.setupToken || '');
  let schedulerStarted = false;
  let scheduledTimer = null;
  let activeCycle = null;
  let schedulerError = null;
  let nextCycleDelayMs = config?.liveIntervalMs || 0;

  async function startUrl(suppliedToken) {
    if (
      !configured
      || typeof config.setupToken !== 'string'
      || config.setupToken === ''
      || !constantTimeTokenMatch(config.setupToken, suppliedToken)
      || await store.isSetupTokenConsumed(setupDigest)
    ) {
      throw new OAuthRouteNotFoundError();
    }
    const state = await stateManager.issue(setupDigest);
    return client.authorizationUrl(state);
  }

  async function completeCallback(params) {
    try {
      const issuedSetupDigest = await stateManager.verifyAndConsume(params?.get?.('state'));
      if (params.get('error')) return { ok: false };
      const code = params.get('code');
      if (typeof code !== 'string' || code === '') return { ok: false };
      const tokens = await client.exchangeCode(code, { persist: false });
      const saved = await store.saveCredentialsIfSetupUnused(issuedSetupDigest, tokens);
      if (!saved) return { ok: false };
      requestImmediateCycle();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

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

  function requestImmediateCycle() {
    if (!schedulerStarted) return;
    if (scheduledTimer !== null) {
      timer.clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
    return runScheduledCycle();
  }

  function runScheduledCycle() {
    if (!schedulerStarted) return Promise.resolve();
    if (activeCycle) return activeCycle;
    activeCycle = performScheduledCycle()
      .catch((error) => {
        schedulerError = sanitizeError(error);
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
    const stored = await store.status();
    if (stored.state !== 'authorized') return;
    let live;
    let liveError = null;
    try {
      live = await synchronizer.runLiveCycle();
    } catch (error) {
      liveError = error;
      throw error;
    } finally {
      await recordCounters({
        cycles: 1,
        huaweiFailures: liveError
          ? 1
          : liveFailureDelta(live),
        rowsIngested: nonNegativeNumber(live?.measurements),
        skippedFields: nonNegativeNumber(live?.skipped),
      });
    }
    schedulerError = null;
    if (live?.state === 'backoff') {
      nextCycleDelayMs = retryDelayUntil(live.retryAt, timer.now(), config.liveIntervalMs);
      return;
    }
    if (config.backfillEnabled) {
      const backfill = await synchronizer.runBackfillStep();
      await recordCounters({
        backfillSteps: 1,
        huaweiFailures: backfill?.huaweiFailureDelta === 1 ? 1 : 0,
        rowsIngested: nonNegativeNumber(backfill?.rows),
        skippedFields: arrayLength(backfill?.skipped),
      });
    }
  }

  async function recordCounters(counters) {
    if (typeof store.recordCounters === 'function') {
      await store.recordCounters(counters);
    }
  }

  async function status() {
    if (!configured) {
      return {
        state: 'not_configured',
        configured: false,
        setupAvailable: Boolean(config?.setupToken),
        authorized: false,
        grantedScopes: [],
        lastSyncAt: null,
        backfill: null,
        lastError: null,
        counters: emptyCounters(),
      };
    }
    const stored = await store.status();
    const state = safeAuthorizationState(stored.state);
    return {
      state,
      configured: true,
      setupAvailable: Boolean(config?.setupToken),
      authorized: state === 'authorized',
      grantedScopes: Array.isArray(stored.scopes)
        ? stored.scopes.filter((scope) => typeof scope === 'string')
        : [],
      lastSyncAt: stored.lastSuccessAt || null,
      backfill: sanitizeBackfill(stored.backfill),
      lastError: sanitizeError(stored.lastError) || schedulerError,
      counters: sanitizeCounters(stored.counters),
    };
  }

  async function close() {
    stopScheduler();
    if (activeCycle) await activeCycle;
    if (typeof store?.close === 'function') await store.close();
  }

  return {
    startUrl,
    completeCallback,
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

  const { createTokenCipher } = require('./crypto');
  const { createFusionSolarStore } = require('./store');
  const { createStateManager } = require('./oauth-state');
  const { createHuaweiClient } = require('./huawei-client');
  const { createSynchronizer } = require('./sync');
  const now = dependencies.clock?.now || (() => new Date());
  const cipher = createTokenCipher(config.tokenEncryptionKey);
  const store = createFusionSolarStore({
    databaseUrl: config.databaseUrl,
    cipher,
    pool: dependencies.pool,
  });
  await store.init();
  const client = createHuaweiClient({
    config,
    store,
    fetchImpl: dependencies.fetchImpl,
    now,
    sleep: dependencies.sleep,
  });
  const stateSecret = crypto.createHash('sha256')
    .update('fusionsolar-oauth-state\0')
    .update(config.tokenEncryptionKey)
    .digest();
  const stateManager = createStateManager({ secret: stateSecret, store, now });
  const synchronizer = createSynchronizer({
    client,
    store,
    config,
    now,
    sleep: dependencies.sleep,
    random: dependencies.random,
  });
  return createIntegration({
    config,
    store,
    client,
    stateManager,
    synchronizer,
    clock: dependencies.clock,
  });
}

function constantTimeTokenMatch(expected, supplied) {
  const expectedDigest = digest(typeof expected === 'string' ? expected : '');
  const suppliedDigest = digest(typeof supplied === 'string' ? supplied : '');
  return crypto.timingSafeEqual(
    Buffer.from(expectedDigest, 'hex'),
    Buffer.from(suppliedDigest, 'hex'),
  );
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeAuthorizationState(value) {
  return ['authorized', 'not_authorized', 'reauthorization_required'].includes(value)
    ? value
    : 'not_authorized';
}

function sanitizeBackfill(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    completed: nonNegativeNumber(value.completed),
    total: nonNegativeNumber(value.total),
    lastSuccessAt: value.lastSuccessAt || null,
  };
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function liveFailureDelta(live) {
  const perAssetFailures = arrayLength(live?.failures);
  const explicit = Number(live?.huaweiFailureDelta);
  if (Number.isSafeInteger(explicit) && explicit >= 0) {
    return perAssetFailures + explicit;
  }
  return perAssetFailures + (live?.state === 'backoff' ? 1 : 0);
}

function emptyCounters() {
  return {
    cycles: 0,
    huaweiFailures: 0,
    tokenRefreshes: 0,
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

function sanitizeError(error) {
  if (!error) return null;
  const message = String(error.message || error).toLowerCase();
  if (message.includes('authorization') || message.includes('oauth')) {
    return 'authorization failed';
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'upstream request timed out';
  }
  if (message.includes('backfill')) return 'backfill failed';
  if (message.includes('live') || message.includes('sync') || message.includes('inventory')) {
    return 'synchronization failed';
  }
  return 'integration error';
}

module.exports = {
  OAuthRouteNotFoundError,
  buildIntegration,
  createIntegration,
};
