const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createTokenCipher } = require('../crypto');
const { createFusionSolarStore } = require('../store');
const { createStateManager } = require('../oauth-state');
const { createHuaweiClient } = require('../huawei-client');
const { createSynchronizer, HISTORICAL_DEVICE_PATH } = require('../sync');
const { createIntegration } = require('../integration');
const { createServer } = require('../server');
const { createFakeHuaweiServer } = require('./fake-huawei');

const FIXED_NOW_MS = Date.parse('2026-08-05T10:00:00Z');
const PRODUCTION_CALLBACK = 'https://bios-multilevel.barrage.net/oauth/fusionsolar/callback';
let Pool;

test('fake Huawei returns sanitized 401 and 429 responses and redacts recorded forms', async (t) => {
  const fake = createFakeHuaweiServer({
    clientId: 'obviously-fake-client',
    clientSecret: 'obviously-fake-client-secret',
    redirectUri: PRODUCTION_CALLBACK,
    now: () => new Date(FIXED_NOW_MS),
  });
  const baseUrl = await fake.listen();
  t.after(() => fake.close());

  const unauthorized = await fetch(`${baseUrl}/thirdData/stations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageNo: 1 }),
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: 'unauthorized' });

  fake.throttleNext(HISTORICAL_DEVICE_PATH);
  const throttled = await fake.fetchAsAuthorized(HISTORICAL_DEVICE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      devDn: 'NE=FAKE-INVERTER-A',
      devTypeId: 1,
      startTime: FIXED_NOW_MS - 86_400_000,
      endTime: FIXED_NOW_MS,
    }),
  });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('retry-after'), '0');
  assert.deepEqual(await throttled.json(), { error: 'flow controlled' });

  const empty = await fake.fetchAsAuthorized(HISTORICAL_DEVICE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      devDn: 'NE=FAKE-INVERTER-A',
      devTypeId: 1,
      startTime: FIXED_NOW_MS - 4 * 86_400_000,
      endTime: FIXED_NOW_MS - 3 * 86_400_000,
    }),
  });
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).data, []);

  const oversizedDeviceBatch = await fake.fetchAsAuthorized('/thirdData/getDevList', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stationCodes: Array.from({ length: 101 }, (_, index) => `PLANT-${index}`).join(','),
    }),
  });
  assert.equal(oversizedDeviceBatch.status, 200);
  assert.deepEqual(await oversizedDeviceBatch.json(), {
    success: false,
    failCode: 20015,
    data: null,
  });

  await fake.exchangeFixtureCode();
  const tokenCall = fake.calls().find((call) => call.path.endsWith('/token'));
  assert.ok(tokenCall);
  assert.deepEqual(
    Object.values(tokenCall.form),
    Object.values(tokenCall.form).map(() => '[REDACTED]'),
  );
  assert.equal(JSON.stringify(fake.calls()).includes('Bearer '), false);
});

test('OAuth, live ingestion, refresh, and restartable history work against PostgreSQL', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async (t) => {
  ({ Pool } = require('pg'));
  const adminPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `fusionsolar_e2e_${process.pid}_${Date.now()}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  let clockMs = FIXED_NOW_MS;
  const now = () => new Date(clockMs);
  const config = {
    port: 0,
    clientId: 'obviously-fake-client',
    clientSecret: 'obviously-fake-client-secret',
    redirectUri: PRODUCTION_CALLBACK,
    setupToken: 'obviously-fake-one-time-setup-token-with-enough-entropy',
    tokenEncryptionKey: Buffer.alloc(32, 29),
    oauthBaseUrl: '',
    apiBaseUrl: '',
    databaseUrl: process.env.TEST_DATABASE_URL,
    liveIntervalMs: 300_000,
    inventoryIntervalMs: 3_600_000,
    requestTimeoutMs: 5_000,
    backfillEnabled: true,
    backfillWindowMs: 86_400_000,
  };
  const fake = createFakeHuaweiServer({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    now,
  });
  const fakeBaseUrl = await fake.listen();
  config.oauthBaseUrl = fakeBaseUrl;
  config.apiBaseUrl = fakeBaseUrl;
  const fakeOrigin = new URL(fakeBaseUrl).origin;
  const outboundDestinations = [];
  const recordingFetch = async (url, options) => {
    const destination = new URL(url);
    outboundDestinations.push({
      href: destination.toString(),
      origin: destination.origin,
      hostname: destination.hostname,
      pathname: destination.pathname,
    });
    if (destination.origin !== fakeOrigin) {
      throw new Error('unexpected outbound integration destination');
    }
    return fetch(destination, options);
  };
  t.after(() => fake.close());

  const first = await createRuntime({
    config,
    schema,
    now,
    fetchImpl: recordingFetch,
  });
  const firstBaseUrl = await listen(first.server);
  fake.setCallbackBaseUrl(firstBaseUrl);
  t.after(async () => {
    await first.stop();
  });

  const start = await fetch(
    `${firstBaseUrl}/oauth/fusionsolar/start?setup_token=${encodeURIComponent(config.setupToken)}`,
    { redirect: 'manual' },
  );
  assert.equal(start.status, 302);
  assert.equal(start.headers.get('cache-control'), 'no-store');

  const authorize = await fetch(start.headers.get('location'), { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const callback = await fetch(authorize.headers.get('location'), { redirect: 'manual' });
  assert.equal(callback.status, 200);
  assert.equal(callback.headers.get('cache-control'), 'no-store');
  assert.match(await callback.text(), /authorization completed/);

  const encrypted = await first.pool.query(
    `SELECT encrypted_access_token::text AS access, encrypted_refresh_token::text AS refresh
     FROM fusionsolar_oauth_credentials WHERE id = 'active'`,
  );
  assert.equal(encrypted.rowCount, 1);
  assert.match(encrypted.rows[0].access, /"ciphertext"/);
  assert.match(encrypted.rows[0].refresh, /"ciphertext"/);
  for (const marker of fake.plaintextTokenMarkers()) {
    assert.equal(encrypted.rows[0].access.includes(marker), false);
    assert.equal(encrypted.rows[0].refresh.includes(marker), false);
  }

  fake.rejectNext('/thirdData/stations');
  const live = await first.synchronizer.runLiveCycle();
  assert.equal(live.plants, 2);
  assert.equal(live.devices, 2);
  assert.equal(live.failures.length, 0);

  const plants = await first.pool.query(
    `SELECT plant_code, source_key FROM fusionsolar_plants ORDER BY plant_code`,
  );
  assert.deepEqual(plants.rows, [
    { plant_code: 'SOMBOR-A', source_key: 'HUAWEI:SOMBOR-A' },
    { plant_code: 'SOMBOR-B', source_key: 'HUAWEI:SOMBOR-B' },
  ]);
  const devices = await first.pool.query(
    `SELECT device_id, plant_code FROM fusionsolar_devices ORDER BY device_id`,
  );
  assert.deepEqual(devices.rows, [
    { device_id: 'inverter-a', plant_code: 'SOMBOR-A' },
    { device_id: 'inverter-b', plant_code: 'SOMBOR-B' },
  ]);
  const deviceListCalls = fake.calls()
    .filter((call) => call.path === '/thirdData/getDevList');
  assert.equal(deviceListCalls.length, 1);
  assert.equal(deviceListCalls[0].json.stationCodes, 'SOMBOR-A,SOMBOR-B');
  assert.equal(deviceListCalls[0].responseKind, 'devices-batch');
  const liveRows = await first.pool.query(
    `SELECT DISTINCT source FROM raw_measurements
     WHERE source IN ('HUAWEI:SOMBOR-A', 'HUAWEI:SOMBOR-B')
     ORDER BY source`,
  );
  assert.deepEqual(liveRows.rows.map((row) => row.source), [
    'HUAWEI:SOMBOR-A',
    'HUAWEI:SOMBOR-B',
  ]);

  const refreshesBeforeExpiry = fake.countCalls('/rest/dp/uidm/oauth2/v1/token', 'refresh_token');
  await first.pool.query(
    `UPDATE fusionsolar_oauth_credentials
     SET access_expires_at = $1
     WHERE id = 'active'`,
    [new Date(clockMs - 1)],
  );
  await first.client.getAccessToken();
  assert.equal(
    fake.countCalls('/rest/dp/uidm/oauth2/v1/token', 'refresh_token'),
    refreshesBeforeExpiry + 1,
  );

  const firstBackfill = await first.synchronizer.runBackfillStep();
  assert.equal(firstBackfill.state, 'progress');
  const checkpointBeforeRestart = await first.store.getCheckpoint('backfill:device:inverter-a');
  assert.equal(checkpointBeforeRestart.before, FIXED_NOW_MS - 86_400_000);

  await first.stop();

  const redeployedConfig = { ...config, setupToken: '' };
  const second = await createRuntime({
    config: redeployedConfig,
    schema,
    now,
    fetchImpl: recordingFetch,
  });
  const secondBaseUrl = await listen(second.server);
  fake.setCallbackBaseUrl(secondBaseUrl);
  t.after(async () => {
    await second.stop();
  });
  const redeployedStatus = await second.integration.status();
  assert.equal(redeployedStatus.state, 'authorized');
  assert.equal(redeployedStatus.configured, true);
  assert.equal(redeployedStatus.setupAvailable, false);
  assert.equal(redeployedStatus.authorized, true);
  assert.deepEqual(redeployedStatus.grantedScopes, ['pvms.openapi.basic']);
  const unavailableStart = await fetch(
    `${secondBaseUrl}/oauth/fusionsolar/start?setup_token=removed`,
    { redirect: 'manual' },
  );
  assert.equal(unavailableStart.status, 404);

  const resumed = await second.synchronizer.runBackfillStep();
  assert.equal(resumed.state, 'progress');
  assert.equal(resumed.nextBefore, checkpointBeforeRestart.before - 86_400_000);
  const inverterAHistory = fake.calls()
    .filter((call) => call.path === HISTORICAL_DEVICE_PATH)
    .filter((call) => call.json?.devDn === 'NE=FAKE-INVERTER-A');
  assert.equal(inverterAHistory.at(-1).json.endTime, checkpointBeforeRestart.before);

  fake.throttleNext(HISTORICAL_DEVICE_PATH);
  const throttled = await second.synchronizer.runBackfillStep();
  assert.equal(throttled.state, 'backoff');
  clockMs += 1;

  let finalBackfill;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    finalBackfill = await second.synchronizer.runBackfillStep();
    if (finalBackfill.state === 'complete' && finalBackfill.reachedBoundary) break;
  }
  assert.deepEqual(
    { state: finalBackfill.state, reachedBoundary: finalBackfill.reachedBoundary },
    { state: 'complete', reachedBoundary: true },
  );
  const historyRows = await second.pool.query(
    `SELECT count(*)::integer AS count
     FROM raw_measurements
     WHERE source LIKE 'HUAWEI:SOMBOR-%:device:%'
       AND ts < $1`,
    [new Date(FIXED_NOW_MS)],
  );
  assert.ok(historyRows.rows[0].count >= 4);
  assert.ok(fake.calls().some((call) => (
    call.path === HISTORICAL_DEVICE_PATH && call.responseKind === 'empty-retention'
  )));
  assert.equal(
    fake.calls().some((call) => call.path.includes('postRawDataInput')),
    false,
  );
  assert.ok(outboundDestinations.length > 0);
  assert.equal(
    outboundDestinations.every(({ origin }) => origin === fakeOrigin),
    true,
  );
  assert.equal(
    outboundDestinations.some(({ hostname, pathname }) => (
      hostname.includes('mars2') || pathname.includes('postRawDataInput')
    )),
    false,
  );
});

async function createRuntime({
  config,
  schema,
  now,
  fetchImpl,
}) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    options: `-c search_path=${schema}`,
    max: 5,
  });
  const store = createFusionSolarStore({
    databaseUrl: config.databaseUrl,
    cipher: createTokenCipher(config.tokenEncryptionKey),
    pool,
  });
  await store.init();
  const client = createHuaweiClient({
    config,
    store,
    fetchImpl,
    now,
    sleep: async () => {},
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
    sleep: async () => {},
  });
  const integration = createIntegration({
    config,
    store,
    client,
    stateManager,
    synchronizer,
  });
  const server = createServer({ config, integration });
  let stopped = false;
  return {
    pool,
    store,
    client,
    synchronizer,
    integration,
    server,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await integration.close();
    },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
