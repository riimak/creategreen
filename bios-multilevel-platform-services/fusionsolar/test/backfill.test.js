const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSynchronizer,
  HISTORICAL_DEVICE_PATH,
  PLANT_REALTIME_PATH,
} = require('../sync');

const DAY_MS = 24 * 60 * 60_000;

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function createStore({
  checkpoints = new Map(),
  devices = [{
    deviceId: '101',
    plantCode: 'NE=PLANT-1',
    deviceType: '1',
    metadata: { devDn: 'NE=DEVICE-101' },
  }],
  plants = [{
    plantCode: 'NE=PLANT-1',
    sourceKey: 'HUAWEI:NE=PLANT-1',
    visible: true,
  }],
  getSyncState,
  getCheckpoint,
} = {}) {
  const transactions = [];
  return {
    checkpoints,
    transactions,
    async upsertPlants() {},
    async upsertDevices() {},
    async listPlants() {
      return structuredClone(plants);
    },
    async listDevices() {
      return structuredClone(devices);
    },
    async getCheckpoint(key) {
      if (getCheckpoint) return getCheckpoint(key, checkpoints);
      return structuredClone(checkpoints.get(key) || null);
    },
    async getSyncState(key) {
      if (getSyncState) return getSyncState(key);
      const checkpoint = checkpoints.get(key);
      return checkpoint ? { checkpoint: structuredClone(checkpoint), backoffUntil: null } : null;
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

function historyPayload(body, data) {
  return {
    success: true,
    failCode: 0,
    data: data.map(({ collectTime, dataItems }) => ({
      devDn: body.devDn,
      collectTime,
      dataItems,
    })),
    message: null,
  };
}

test('backfill uses the recommended endpoint, walks backward, and resumes after restart', async () => {
  const store = createStore();
  const requests = [];
  const now = Date.parse('2026-08-05T10:00:00Z');
  const client = {
    async request(path, options) {
      assert.equal(path, HISTORICAL_DEVICE_PATH);
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length <= 2) {
        return jsonResponse(historyPayload(body, [{
          collectTime: body.startTime + 300_000,
          dataItems: { active_power: requests.length === 1 ? 2 : 1 },
        }]));
      }
      return jsonResponse(historyPayload(body, []));
    },
  };
  const config = { backfillWindowMs: DAY_MS };
  const firstSynchronizer = createSynchronizer({
    client,
    store,
    config,
    now: () => new Date(now),
  });

  const first = await firstSynchronizer.runBackfillStep();
  assert.deepEqual(requests[0], {
    devDn: 'NE=DEVICE-101',
    devTypeId: 1,
    startTime: now - DAY_MS,
    endTime: now,
  });
  assert.deepEqual(first, {
    state: 'progress',
    nextBefore: now - DAY_MS,
    rows: 1,
    reachedBoundary: false,
  });
  assert.equal(store.transactions[0].key, 'backfill:device:101');
  assert.deepEqual(store.transactions[0].measurements[0], {
    source: 'HUAWEI:NE=PLANT-1:device:101',
    metric: 'huawei.string_inverter.active_power_kw',
    ts: new Date(now - DAY_MS + 300_000).toISOString(),
    value: 2,
    isMissing: false,
  });

  const restarted = createSynchronizer({
    client,
    store,
    config,
    now: () => new Date(now + 10 * DAY_MS),
  });
  const second = await restarted.runBackfillStep();
  assert.equal(requests[1].endTime, now - DAY_MS);
  assert.equal(requests[1].startTime, now - 2 * DAY_MS);
  assert.equal(second.nextBefore, now - 2 * DAY_MS);

  const boundary = await restarted.runBackfillStep();
  assert.equal(requests[2].endTime, now - 2 * DAY_MS);
  assert.deepEqual(boundary, {
    state: 'complete',
    nextBefore: now - 3 * DAY_MS,
    rows: 0,
    reachedBoundary: true,
  });
  assert.equal(store.checkpoints.get('backfill:device:101').reachedBoundary, true);
});

test('documented oversized-range response halves the window with one request per step', async () => {
  const store = createStore();
  const requests = [];
  const now = Date.parse('2026-08-05T10:00:00Z');
  const client = {
    async request(path, options) {
      assert.equal(path, HISTORICAL_DEVICE_PATH);
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return jsonResponse({
          success: false,
          failCode: 40001,
          data: null,
          message: 'raw provider detail',
        });
      }
      return jsonResponse(historyPayload(body, [{
        collectTime: body.startTime,
        dataItems: { active_power: 3 },
      }]));
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: { backfillWindowMs: 2 * DAY_MS },
    now: () => new Date(now),
  });

  const resized = await synchronizer.runBackfillStep();
  assert.equal(requests.length, 1);
  assert.deepEqual(resized, {
    state: 'range_reduced',
    nextBefore: now,
    rows: 0,
    reachedBoundary: false,
  });
  assert.equal(store.checkpoints.get('backfill:device:101').windowMs, DAY_MS);

  const progress = await synchronizer.runBackfillStep();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].endTime - requests[1].startTime, DAY_MS);
  assert.equal(progress.state, 'progress');
  assert.doesNotMatch(JSON.stringify(resized), /raw provider detail/);
});

test('flow control honors Retry-After, persists backoff, and survives restart', async () => {
  const store = createStore();
  const now = Date.parse('2026-08-05T10:00:00Z');
  let requests = 0;
  const client = {
    async request() {
      requests += 1;
      return jsonResponse({
        success: false,
        failCode: 429,
        data: null,
      }, { headers: { 'retry-after': '90' } });
    },
  };
  const first = createSynchronizer({
    client,
    store,
    now: () => new Date(now),
  });

  assert.deepEqual(await first.runBackfillStep(), {
    state: 'backoff',
    nextBefore: now,
    rows: 0,
    reachedBoundary: false,
  });
  assert.equal(
    store.checkpoints.get('backfill:device:101').backoffUntil,
    '2026-08-05T10:01:30.000Z',
  );

  const restarted = createSynchronizer({
    client,
    store,
    now: () => new Date(now + 60_000),
  });
  const skipped = await restarted.runBackfillStep();
  assert.equal(skipped.state, 'backoff');
  assert.equal(skipped.retryAt, '2026-08-05T10:01:30.000Z');
  assert.equal(requests, 1);
});

test('candidate selection skips backed-off devices and chooses another unfinished device', async () => {
  const now = Date.parse('2026-08-05T10:00:00Z');
  const devices = [
    {
      deviceId: '101',
      plantCode: 'NE=PLANT-1',
      deviceType: '1',
      metadata: { devDn: 'NE=DEVICE-101' },
    },
    {
      deviceId: '202',
      plantCode: 'NE=PLANT-1',
      deviceType: '1',
      metadata: { devDn: 'NE=DEVICE-202' },
    },
  ];
  const store = createStore({
    devices,
    checkpoints: new Map([
      ['backfill:device:101', {
        before: now,
        reachedBoundary: false,
        backoffUntil: '2026-08-05T10:05:00.000Z',
      }],
      ['backfill:device:202', { before: now, reachedBoundary: false }],
    ]),
  });
  let requestedDevice;
  const synchronizer = createSynchronizer({
    store,
    now: () => new Date(now),
    client: {
      async request(_path, options) {
        requestedDevice = JSON.parse(options.body).devDn;
        return jsonResponse(historyPayload({ devDn: requestedDevice }, []));
      },
    },
  });

  const result = await synchronizer.runBackfillStep();

  assert.equal(requestedDevice, 'NE=DEVICE-202');
  assert.equal(result.state, 'complete');
});

test('all backed-off candidates return the earliest retry time without HTTP', async () => {
  const now = Date.parse('2026-08-05T10:00:00Z');
  const devices = [
    {
      deviceId: '101',
      plantCode: 'NE=PLANT-1',
      deviceType: '1',
      metadata: { devDn: 'NE=DEVICE-101' },
    },
    {
      deviceId: '202',
      plantCode: 'NE=PLANT-1',
      deviceType: '1',
      metadata: { devDn: 'NE=DEVICE-202' },
    },
  ];
  const store = createStore({
    devices,
    checkpoints: new Map([
      ['backfill:device:101', {
        before: now,
        reachedBoundary: false,
        backoffUntil: '2026-08-05T10:05:00.000Z',
      }],
      ['backfill:device:202', {
        before: now,
        reachedBoundary: false,
        backoffUntil: '2026-08-05T10:02:00.000Z',
      }],
    ]),
  });
  let requests = 0;
  const synchronizer = createSynchronizer({
    store,
    now: () => new Date(now),
    client: {
      async request() {
        requests += 1;
        throw new Error('must not request history');
      },
    },
  });

  assert.deepEqual(await synchronizer.runBackfillStep(), {
    state: 'backoff',
    nextBefore: null,
    rows: 0,
    reachedBoundary: false,
    retryAt: '2026-08-05T10:02:00.000Z',
  });
  assert.equal(requests, 0);
});

test('backfill has no fixed cutoff and live work preempts it', async () => {
  const oldBefore = Date.parse('2010-01-02T00:00:00Z');
  const store = createStore({
    checkpoints: new Map([
      [
        'inventory',
        {
          refreshedAt: '2026-08-05T09:30:00.000Z',
          plants: [{
            plantCode: 'NE=PLANT-1',
            sourceKey: 'HUAWEI:NE=PLANT-1',
            visible: true,
          }],
        },
      ],
      [
        'backfill:device:101',
        { before: oldBefore, windowMs: DAY_MS, reachedBoundary: false },
      ],
    ]),
  });
  let historyCalls = 0;
  let releaseLive;
  const livePending = new Promise((resolve) => {
    releaseLive = resolve;
  });
  const client = {
    async request(path) {
      if (path === PLANT_REALTIME_PATH) {
        await livePending;
        return jsonResponse({
          success: true,
          failCode: 0,
          params: { currentTime: oldBefore },
          data: [{
            stationCode: 'NE=PLANT-1',
            dataItemMap: { day_power: 1 },
          }],
        });
      }
      if (path === '/thirdData/getDevRealKpi') {
        return jsonResponse({
          success: true,
          failCode: 0,
          params: { currentTime: oldBefore },
          data: [],
        });
      }
      historyCalls += 1;
      return jsonResponse(historyPayload({
        devDn: 'NE=DEVICE-101',
      }, []));
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: { inventoryIntervalMs: DAY_MS },
    now: () => new Date('2026-08-05T10:00:00Z'),
  });

  const live = synchronizer.runLiveCycle();
  await Promise.resolve();
  const preempted = await synchronizer.runBackfillStep();
  assert.deepEqual(preempted, {
    state: 'live_pending',
    nextBefore: oldBefore,
    rows: 0,
    reachedBoundary: false,
  });
  assert.equal(historyCalls, 0);
  releaseLive();
  await live;

  const oldHistory = await synchronizer.runBackfillStep();
  assert.equal(historyCalls, 1);
  assert.equal(oldHistory.reachedBoundary, true);
});

test('live preempts backfill while candidate checkpoint work is pending', async () => {
  const now = Date.parse('2026-08-05T10:00:00Z');
  let releaseCandidate;
  let candidateStarted;
  const candidatePending = new Promise((resolve) => { releaseCandidate = resolve; });
  const candidateStart = new Promise((resolve) => { candidateStarted = resolve; });
  const store = createStore({
    checkpoints: new Map([[
      'inventory',
      {
        refreshedAt: '2026-08-05T09:30:00.000Z',
        plants: [{
          plantCode: 'NE=PLANT-1',
          sourceKey: 'HUAWEI:NE=PLANT-1',
          visible: true,
        }],
      },
    ]]),
    async getSyncState() {
      candidateStarted();
      await candidatePending;
      return null;
    },
  });
  let historyCalls = 0;
  const client = {
    async request(path, options) {
      if (path === PLANT_REALTIME_PATH) {
        return jsonResponse({
          success: true,
          failCode: 0,
          params: { currentTime: now },
          data: [{
            stationCode: 'NE=PLANT-1',
            dataItemMap: { day_power: 1 },
          }],
        });
      }
      if (path === '/thirdData/getDevRealKpi') {
        return jsonResponse({
          success: true,
          failCode: 0,
          params: { currentTime: now },
          data: [{ devId: 101, dataItemMap: { active_power: 2 } }],
        });
      }
      historyCalls += 1;
      return jsonResponse(historyPayload(JSON.parse(options.body), []));
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: { inventoryIntervalMs: DAY_MS },
    now: () => new Date(now),
  });

  const backfill = synchronizer.runBackfillStep();
  await candidateStart;
  await synchronizer.runLiveCycle();
  releaseCandidate();

  assert.equal((await backfill).state, 'live_pending');
  assert.equal(historyCalls, 0);
});

test('live preempts backfill while the live checkpoint read is pending', async () => {
  const now = Date.parse('2026-08-05T10:00:00Z');
  let releaseCheckpoint;
  let checkpointStarted;
  const checkpointPending = new Promise((resolve) => { releaseCheckpoint = resolve; });
  const checkpointStart = new Promise((resolve) => { checkpointStarted = resolve; });
  const store = createStore({
    checkpoints: new Map([[
      'inventory',
      {
        refreshedAt: '2026-08-05T09:30:00.000Z',
        plants: [{
          plantCode: 'NE=PLANT-1',
          sourceKey: 'HUAWEI:NE=PLANT-1',
          visible: true,
        }],
      },
    ]]),
    async getCheckpoint(key, checkpoints) {
      if (key === 'live') {
        checkpointStarted();
        await checkpointPending;
      }
      return structuredClone(checkpoints.get(key) || null);
    },
  });
  let historyCalls = 0;
  const client = {
    async request(path, options) {
      if (path === PLANT_REALTIME_PATH) {
        return jsonResponse({
          success: true,
          failCode: 0,
          params: { currentTime: now },
          data: [{
            stationCode: 'NE=PLANT-1',
            dataItemMap: { day_power: 1 },
          }],
        });
      }
      if (path === '/thirdData/getDevRealKpi') {
        return jsonResponse({
          success: true,
          failCode: 0,
          params: { currentTime: now },
          data: [{ devId: 101, dataItemMap: { active_power: 2 } }],
        });
      }
      historyCalls += 1;
      return jsonResponse(historyPayload(JSON.parse(options.body), []));
    },
  };
  const synchronizer = createSynchronizer({
    client,
    store,
    config: { inventoryIntervalMs: DAY_MS },
    now: () => new Date(now),
  });

  const backfill = synchronizer.runBackfillStep();
  await checkpointStart;
  await synchronizer.runLiveCycle();
  releaseCheckpoint();

  assert.equal((await backfill).state, 'live_pending');
  assert.equal(historyCalls, 0);
});

test('HTTP 429 without Retry-After backs off for sixty seconds but 503 uses short fallback', async () => {
  const now = Date.parse('2026-08-05T10:00:00Z');
  for (const [status, expectedBackoff] of [
    [429, '2026-08-05T10:01:00.000Z'],
    [503, '2026-08-05T10:00:01.000Z'],
  ]) {
    const store = createStore();
    const synchronizer = createSynchronizer({
      store,
      now: () => new Date(now),
      client: {
        async request() {
          return jsonResponse({}, { status });
        },
      },
    });

    assert.equal((await synchronizer.runBackfillStep()).state, 'backoff');
    assert.equal(
      store.checkpoints.get('backfill:device:101').backoffUntil,
      expectedBackoff,
    );
  }
});

test('malformed historical records return sanitized skipped diagnostics and advance', async () => {
  const now = Date.parse('2026-08-05T10:00:00Z');
  const rawSecret = 'raw-history-secret';
  const store = createStore();
  const synchronizer = createSynchronizer({
    store,
    now: () => new Date(now),
    client: {
      async request(_path, options) {
        const body = JSON.parse(options.body);
        return jsonResponse({
          success: true,
          failCode: 0,
          data: [
            {
              devDn: body.devDn,
              collectTime: body.startTime,
              dataItems: null,
              raw: rawSecret,
            },
            {
              devDn: body.devDn,
              collectTime: 9e15,
              dataItems: { active_power: 1, raw: rawSecret },
            },
          ],
        });
      },
    },
  });

  const result = await synchronizer.runBackfillStep();

  assert.equal(result.state, 'progress');
  assert.equal(result.nextBefore, now - DAY_MS);
  assert.deepEqual(result.skipped, [
    { scope: 'device:101', index: 0, reason: 'invalid_record' },
    { scope: 'device:101', index: 1, reason: 'invalid_record' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(rawSecret));
});
