const test = require('node:test');
const assert = require('node:assert/strict');
const { createIntegration } = require('../integration');
const { createShutdown } = require('../server');

function config(overrides = {}) {
  return {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://bios-multilevel.barrage.net/oauth/fusionsolar/callback',
    setupToken: 'bootstrap-secret',
    tokenEncryptionKey: Buffer.alloc(32, 1),
    apiBaseUrl: 'https://region.example.com',
    oauthBaseUrl: 'https://oauth.example.com',
    databaseUrl: 'postgresql://example',
    liveIntervalMs: 5_000,
    backfillEnabled: true,
    ...overrides,
  };
}

function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => new Date('2026-08-05T10:00:00Z'),
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending() {
      return [...timers.entries()];
    },
    async run(id) {
      const timer = timers.get(id);
      timers.delete(id);
      return timer.callback();
    },
  };
}

function dependencies({ authorization = 'authorized', live, backfill } = {}) {
  const calls = [];
  const store = {
    async status() {
      calls.push('status');
      return {
        state: authorization,
        scopes: authorization === 'authorized' ? ['pvms.openapi.basic'] : [],
        lastSuccessAt: null,
        backfill: null,
        lastError: null,
      };
    },
    async close() {
      calls.push('close');
    },
    async recordCounters(counters) {
      calls.push(`counters:${JSON.stringify(counters)}`);
    },
  };
  const synchronizer = {
    async runLiveCycle() {
      calls.push('live');
      if (live) return live();
      return {};
    },
    async runBackfillStep() {
      calls.push('backfill');
      if (backfill) return backfill();
      return {};
    },
  };
  return { calls, store, synchronizer };
}

test('unconfigured integration reports not_configured and never schedules polling', async () => {
  const clock = fakeClock();
  const integration = createIntegration({ config: config({ clientSecret: '' }), clock });

  integration.startScheduler();

  assert.deepEqual(await integration.status(), {
    state: 'not_configured',
    configured: false,
    setupAvailable: true,
    authorized: false,
    grantedScopes: [],
    lastSyncAt: null,
    backfill: null,
    lastError: null,
    counters: {
      cycles: 0,
      huaweiFailures: 0,
      tokenRefreshes: 0,
      rowsIngested: 0,
      skippedFields: 0,
      backfillSteps: 0,
    },
  });
  assert.deepEqual(clock.pending(), []);
});

test('configured but unauthorized integration schedules checks without polling Huawei', async () => {
  const clock = fakeClock();
  const deps = dependencies({ authorization: 'not_authorized' });
  const integration = createIntegration({ config: config(), clock, ...deps });

  await integration.startScheduler();

  assert.deepEqual(deps.calls, ['status']);
  assert.equal(clock.pending().length, 1);
  assert.equal(clock.pending()[0][1].delay, 5_000);
});

test('authorized scheduler runs live immediately and one backfill step per cadence', async () => {
  const clock = fakeClock();
  const deps = dependencies();
  const integration = createIntegration({ config: config(), clock, ...deps });

  await integration.startScheduler();
  assert.deepEqual(deps.calls, [
    'status',
    'live',
    'counters:{"cycles":1,"huaweiFailures":0,"rowsIngested":0,"skippedFields":0}',
    'backfill',
    'counters:{"backfillSteps":1,"huaweiFailures":0,"rowsIngested":0,"skippedFields":0}',
  ]);

  const [[timerId, scheduled]] = clock.pending();
  assert.equal(scheduled.delay, 5_000);
  await clock.run(timerId);

  assert.equal(deps.calls.filter((call) => call === 'live').length, 2);
  assert.equal(deps.calls.filter((call) => call === 'backfill').length, 2);
  assert.equal(clock.pending().length, 1);
});

test('scheduler waits for a persisted backoff retry time and skips backfill', async () => {
  const clock = fakeClock();
  const deps = dependencies({
    live: async () => ({
      state: 'backoff',
      retryAt: '2026-08-05T10:02:00.000Z',
    }),
  });
  const integration = createIntegration({ config: config(), clock, ...deps });

  await integration.startScheduler();

  assert.equal(deps.calls.filter((call) => call === 'live').length, 1);
  assert.equal(deps.calls.includes('backfill'), false);
  assert.equal(clock.pending()[0][1].delay, 120_000);
});

test('authorized scheduler continues polling after redeploy without a setup token', async () => {
  const clock = fakeClock();
  const deps = dependencies();
  const integration = createIntegration({
    config: config({ setupToken: '' }),
    clock,
    ...deps,
  });

  await integration.startScheduler();

  assert.equal(deps.calls.filter((call) => call === 'live').length, 1);
  assert.equal(deps.calls.filter((call) => call === 'backfill').length, 1);
  assert.deepEqual(await integration.status(), {
    state: 'authorized',
    configured: true,
    setupAvailable: false,
    authorized: true,
    grantedScopes: ['pvms.openapi.basic'],
    lastSyncAt: null,
    backfill: null,
    lastError: null,
    counters: {
      cycles: 0,
      huaweiFailures: 0,
      tokenRefreshes: 0,
      rowsIngested: 0,
      skippedFields: 0,
      backfillSteps: 0,
    },
  });
  assert.equal(clock.pending().length, 1);
});

test('scheduler neither overlaps cycles nor backfills after failed live work', async () => {
  const clock = fakeClock();
  let releaseLive;
  let liveCalls = 0;
  const deps = dependencies({
    live: async () => {
      liveCalls += 1;
      if (liveCalls === 1) {
        await new Promise((resolve) => {
          releaseLive = resolve;
        });
        throw new Error('live failed with secret-token-value');
      }
      return {};
    },
  });
  const integration = createIntegration({ config: config(), clock, ...deps });

  const first = integration.startScheduler();
  const duplicate = integration.startScheduler();
  assert.equal(liveCalls, 0);
  await Promise.resolve();
  assert.equal(liveCalls, 1);
  assert.equal(clock.pending().length, 0);

  releaseLive();
  await first;
  await duplicate;

  assert.equal(deps.calls.filter((call) => call === 'live').length, 1);
  assert.equal(deps.calls.includes('backfill'), false);
  assert.equal(clock.pending().length, 1);
  assert.equal((await integration.status()).lastError.includes('secret-token-value'), false);
});

test('close clears scheduled timers and closes the store', async () => {
  const clock = fakeClock();
  const deps = dependencies();
  const integration = createIntegration({ config: config(), clock, ...deps });

  await integration.startScheduler();
  assert.equal(clock.pending().length, 1);

  await integration.close();

  assert.equal(clock.pending().length, 0);
  assert.equal(deps.calls.at(-1), 'close');
});

test('process shutdown stops scheduling and closes both server and integration once', async () => {
  const calls = [];
  const shutdown = createShutdown({
    server: {
      close(callback) {
        calls.push('server-close');
        callback();
      },
    },
    integration: {
      stopScheduler() {
        calls.push('stop');
      },
      async close() {
        calls.push('integration-close');
      },
    },
  });

  await Promise.all([shutdown(), shutdown()]);

  assert.deepEqual(calls, ['stop', 'server-close', 'integration-close']);
});
