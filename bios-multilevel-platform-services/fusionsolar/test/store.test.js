const test = require('node:test');
const assert = require('node:assert/strict');
const { createFusionSolarStore } = require('../store');
const { createTokenCipher } = require('../crypto');
const { createIntegration } = require('../integration');
const { createStateManager } = require('../oauth-state');

function fakeCipher() {
  return {
    encrypt(value) {
      return { version: 1, ciphertext: `encrypted:${value}` };
    },
    decrypt(envelope) {
      return envelope.ciphertext.replace('encrypted:', '');
    },
  };
}

function createFakePool(queryHandler = async () => ({ rows: [], rowCount: 0 })) {
  const queries = [];
  return {
    queries,
    ended: false,
    async query(sql, values) {
      queries.push({ sql, values });
      return queryHandler(sql, values, queries);
    },
    async end() {
      this.ended = true;
    },
  };
}

test('nonce consumption atomically returns its bound setup-token hash', async () => {
  let available = false;
  let created = false;
  const pool = createFakePool(async (sql) => {
    if (/INSERT INTO fusionsolar_oauth_nonces/.test(sql)) {
      if (!created || /DO UPDATE/.test(sql)) available = true;
      created = true;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE fusionsolar_oauth_nonces/.test(sql) && available) {
      available = false;
      return { rows: [{ setup_token_hash: 'setup-generation' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });
  const now = new Date();

  await store.createNonce('hash', new Date(now.getTime() + 60_000), 'setup-generation');
  assert.equal(await store.consumeNonce('hash', now), 'setup-generation');
  assert.equal(await store.consumeNonce('hash', now), false);
  await store.createNonce('hash', new Date(now.getTime() + 60_000), 'setup-generation');
  assert.equal(await store.consumeNonce('hash', now), false);

  const updates = pool.queries.filter(({ sql }) => /UPDATE fusionsolar_oauth_nonces/.test(sql));
  assert.equal(updates.length, 3);
  assert.match(updates[0].sql, /consumed_at IS NULL AND expires_at > \$2/);
  assert.match(updates[0].sql, /RETURNING setup_token_hash/);
  assert.deepEqual(updates[0].values, ['hash', now]);
  const insert = pool.queries.find(({ sql }) => /INSERT INTO fusionsolar_oauth_nonces/.test(sql));
  assert.deepEqual(insert.values, ['hash', new Date(now.getTime() + 60_000), 'setup-generation']);
});

test('setup-token consumption is persisted by digest and remains single-use', async () => {
  const consumed = new Set();
  const pool = createFakePool(async (sql, values) => {
    if (/SELECT EXISTS/.test(sql) && /fusionsolar_setup_tokens/.test(sql)) {
      return { rows: [{ consumed: consumed.has(values[0]) }], rowCount: 1 };
    }
    if (/INSERT INTO fusionsolar_setup_tokens/.test(sql)) {
      if (consumed.has(values[0])) return { rows: [], rowCount: 0 };
      consumed.add(values[0]);
      return { rows: [{ token_hash: values[0] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  assert.equal(await store.isSetupTokenConsumed('digest-a'), false);
  assert.equal(await store.consumeSetupToken('digest-a'), true);
  assert.equal(await store.isSetupTokenConsumed('digest-a'), true);
  assert.equal(await store.consumeSetupToken('digest-a'), false);
  assert.equal(await store.isSetupTokenConsumed('digest-b'), false);

  const insert = pool.queries.find(({ sql }) => /INSERT INTO fusionsolar_setup_tokens/.test(sql));
  assert.deepEqual(insert.values, ['digest-a']);
  assert.match(insert.sql, /ON CONFLICT \(token_hash\) DO NOTHING/);
  assert.match(insert.sql, /RETURNING token_hash/);
});

test('credential persistence is conditional on atomically claiming the setup token', async () => {
  let claimed = false;
  const pool = createFakePool(async (sql) => {
    if (/WITH claimed_setup AS/.test(sql)) {
      if (claimed) return { rows: [], rowCount: 0 };
      claimed = true;
      return { rows: [{ id: 'active' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });
  const tokens = {
    accessToken: 'first-access',
    refreshToken: 'first-refresh',
    accessExpiresAt: new Date('2026-08-05T11:00:00Z'),
    scopes: ['pvms.openapi.basic'],
    tokenType: 'Bearer',
  };

  assert.equal(await store.saveCredentialsIfSetupUnused('setup-digest', tokens), true);
  assert.equal(await store.saveCredentialsIfSetupUnused('setup-digest', {
    ...tokens,
    accessToken: 'second-access',
    refreshToken: 'second-refresh',
  }), false);

  assert.equal(pool.queries.length, 2);
  assert.match(pool.queries[0].sql, /INSERT INTO fusionsolar_setup_tokens/);
  assert.match(pool.queries[0].sql, /ON CONFLICT \(token_hash\) DO NOTHING/);
  assert.match(pool.queries[0].sql, /FROM claimed_setup/);
  assert.deepEqual(pool.queries[0].values.slice(0, 3), [
    'setup-digest',
    { version: 1, ciphertext: 'encrypted:first-access' },
    { version: 1, ciphertext: 'encrypted:first-refresh' },
  ]);
});

test('credentials are encrypted before reaching parameterized SQL and decrypted on load', async () => {
  const pool = createFakePool(async (sql) => {
    if (/SELECT encrypted_access_token/.test(sql)) {
      return {
        rows: [{
          encrypted_access_token: { version: 1, ciphertext: 'encrypted:access-secret' },
          encrypted_refresh_token: { version: 1, ciphertext: 'encrypted:refresh-secret' },
          access_expires_at: new Date('2026-08-05T11:00:00Z'),
          granted_scopes: ['pvms.openapi.basic'],
          token_type: 'Bearer',
          state: 'authorized',
          last_error: null,
          authorized_at: new Date('2026-08-05T10:00:00Z'),
          updated_at: new Date('2026-08-05T10:00:00Z'),
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  await store.saveCredentials({
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    accessExpiresAt: new Date('2026-08-05T11:00:00Z'),
    scopes: ['pvms.openapi.basic'],
    tokenType: 'Bearer',
  });

  const insert = pool.queries[0];
  assert.doesNotMatch(insert.sql, /access-secret|refresh-secret/);
  assert.doesNotMatch(insert.sql, /fusionsolar_setup_tokens/);
  assert.deepEqual(insert.values[0], { version: 1, ciphertext: 'encrypted:access-secret' });
  assert.deepEqual(insert.values[1], { version: 1, ciphertext: 'encrypted:refresh-secret' });
  assert.equal(insert.values.includes('access-secret'), false);
  assert.equal(insert.values.includes('refresh-secret'), false);

  const loaded = await store.loadCredentials();
  assert.equal(loaded.accessToken, 'access-secret');
  assert.equal(loaded.refreshToken, 'refresh-secret');
  assert.deepEqual(loaded.scopes, ['pvms.openapi.basic']);
  assert.equal(loaded.state, 'authorized');
});

test('credentials require non-empty access and refresh tokens', async () => {
  const pool = createFakePool(async () => ({ rows: [], rowCount: 1 }));
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  await assert.rejects(
    store.saveCredentials({ refreshToken: 'refresh-secret' }),
    /accessToken is required/,
  );
  await assert.rejects(
    store.saveCredentials({ accessToken: '', refreshToken: 'refresh-secret' }),
    /accessToken is required/,
  );
  await assert.rejects(
    store.saveCredentials({ accessToken: 'access-secret' }),
    /refreshToken is required/,
  );
  await assert.rejects(
    store.saveCredentials({ accessToken: 'access-secret', refreshToken: '   ' }),
    /refreshToken is required/,
  );
  assert.equal(pool.queries.length, 0);
});

test('authorization state and inventory upserts are parameterized', async () => {
  const pool = createFakePool(async () => ({ rows: [], rowCount: 1 }));
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  await store.setAuthorizationState('reauthorization_required', 'refresh token rejected');
  await store.upsertPlants([{
    plantCode: 'plant-1',
    sourceKey: 'HUAWEI:plant-1',
    displayName: 'Sombor',
    timezone: 'Europe/Belgrade',
    visible: true,
    metadata: { capacityKw: 42 },
  }]);
  await store.upsertDevices([{
    deviceId: 'device-1',
    plantCode: 'plant-1',
    deviceType: 'inverter',
    model: 'SUN2000',
    serialNumber: 'serial-1',
    visible: false,
    metadata: { vendor: 'Huawei' },
  }]);

  const [state, plants, devices] = pool.queries;
  assert.deepEqual(state.values, ['reauthorization_required', 'refresh token rejected']);
  assert.match(plants.sql, /ON CONFLICT \(plant_code\) DO UPDATE/);
  assert.deepEqual(plants.values.slice(0, 2), ['plant-1', 'HUAWEI:plant-1']);
  assert.match(devices.sql, /ON CONFLICT \(device_id\) DO UPDATE/);
  assert.match(devices.sql, /visible = EXCLUDED\.visible/);
  assert.deepEqual(devices.values.slice(0, 2), ['device-1', 'plant-1']);
});

test('measurement writes preserve the raw_measurements natural key', async () => {
  const pool = createFakePool(async () => ({ rows: [], rowCount: 1 }));
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  const result = await store.saveMeasurements([{
    source: 'HUAWEI:plant-1',
    metric: 'huawei.plant.active_power_kw',
    ts: '2026-08-05T10:00:00Z',
    value: 12.5,
    isMissing: false,
  }]);

  assert.deepEqual(result, { upserted: 1 });
  assert.match(pool.queries[0].sql, /ON CONFLICT \(source, metric, ts\) DO UPDATE/);
  assert.match(pool.queries[0].sql, /value\s*=\s*EXCLUDED\.value/);
  assert.match(pool.queries[0].sql, /is_missing\s*=\s*EXCLUDED\.is_missing/);
  assert.deepEqual(pool.queries[0].values, [
    'HUAWEI:plant-1',
    'huawei.plant.active_power_kw',
    '2026-08-05T10:00:00.000000Z',
    12.5,
    false,
  ]);
});

test('measurement writes canonicalize equivalent instants before deduplication', async () => {
  const pool = createFakePool(async (_sql, values) => ({
    rows: [],
    rowCount: values.length / 5,
  }));
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  const result = await store.saveMeasurements([
    {
      source: 'HUAWEI:plant-1',
      metric: 'huawei.plant.active_power_kw',
      ts: '2026-08-05T10:00:00Z',
      value: 12.5,
      isMissing: false,
    },
    {
      source: 'HUAWEI:plant-1',
      metric: 'huawei.plant.active_power_kw',
      ts: '2026-08-05T12:00:00+02:00',
      value: 13.5,
      isMissing: false,
    },
  ]);

  assert.deepEqual(result, { upserted: 1 });
  assert.deepEqual(pool.queries[0].values, [
    'HUAWEI:plant-1',
    'huawei.plant.active_power_kw',
    '2026-08-05T10:00:00.000000Z',
    13.5,
    false,
  ]);
});

test('measurement writes preserve microseconds and handle offset day rollover', async () => {
  const pool = createFakePool(async (_sql, values) => ({
    rows: [],
    rowCount: values.length / 5,
  }));
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  assert.deepEqual(await store.saveMeasurements([
    {
      source: 'HUAWEI:plant-1',
      metric: 'huawei.device.voltage_v',
      ts: '2026-08-05T10:00:00.0001Z',
      value: 1,
      isMissing: false,
    },
    {
      source: 'HUAWEI:plant-1',
      metric: 'huawei.device.voltage_v',
      ts: '2026-08-05T10:00:00.0002Z',
      value: 2,
      isMissing: false,
    },
  ]), { upserted: 2 });
  assert.deepEqual(
    [pool.queries[0].values[2], pool.queries[0].values[7]],
    ['2026-08-05T10:00:00.000100Z', '2026-08-05T10:00:00.000200Z'],
  );

  assert.deepEqual(await store.saveMeasurements([
    {
      source: 'HUAWEI:plant-1',
      metric: 'huawei.plant.energy_kwh',
      ts: '2026-08-05T00:30:00.1234+02:00',
      value: 3,
      isMissing: false,
    },
    {
      source: 'HUAWEI:plant-1',
      metric: 'huawei.plant.energy_kwh',
      ts: '2026-08-04T22:30:00.123400Z',
      value: 4,
      isMissing: false,
    },
  ]), { upserted: 1 });
  assert.equal(pool.queries[1].values[2], '2026-08-04T22:30:00.123400Z');
});

test('measurement deduplication keys cannot collide on field delimiters', async () => {
  const pool = createFakePool(async (_sql, values) => ({
    rows: [],
    rowCount: values.length / 5,
  }));
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });
  const ts = '2026-08-05T10:00:00Z';

  const result = await store.saveMeasurements([
    {
      source: 'alpha\u001fbeta',
      metric: 'gamma',
      ts,
      value: 1,
      isMissing: false,
    },
    {
      source: 'alpha',
      metric: 'beta\u001fgamma',
      ts,
      value: 2,
      isMissing: false,
    },
  ]);

  assert.deepEqual(result, { upserted: 2 });
  assert.equal(pool.queries[0].values.length, 10);
});

test('measurement writes reject invalid timestamps before querying PostgreSQL', async () => {
  const pool = createFakePool(async () => ({ rows: [], rowCount: 1 }));
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  for (const ts of [
    'not-a-timestamp',
    '2026-08-05T10:00:00.1234567Z',
    '2026-02-30T10:00:00Z',
    '2026-08-05T10:00:00',
    '2026-08-05T10:00:00+24:00',
  ]) {
    await assert.rejects(
      store.saveMeasurements([{
        source: 'HUAWEI:plant-1',
        metric: 'huawei.plant.active_power_kw',
        ts,
        value: 12.5,
        isMissing: false,
      }]),
      /invalid measurement timestamp/,
    );
  }
  assert.equal(pool.queries.length, 0);
});

test('checkpoints, status, schema initialization, and close use the injected pool', async () => {
  const pool = createFakePool(async (sql) => {
    if (/SELECT checkpoint/.test(sql)) {
      return { rows: [{ checkpoint: { cursor: 'next' } }], rowCount: 1 };
    }
    if (/AS plant_count/.test(sql)) {
      return {
        rows: [{
          state: 'authorized',
          granted_scopes: ['pvms.openapi.basic'],
          last_error: null,
          authorized_at: null,
          updated_at: null,
          plant_count: '2',
          device_count: '4',
          last_success_at: null,
          backfill_completed: '1',
          backfill_total: '3',
          backfill_last_success_at: new Date('2026-08-05T09:00:00Z'),
          cycles: '7',
          huawei_failures: '2',
          token_refreshes: '1',
          rows_ingested: '42',
          skipped_fields: '3',
          backfill_steps: '5',
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  await store.init();
  await store.setCheckpoint('plant:1', { cursor: 'next' }, {
    lastSuccessAt: new Date('2026-08-05T10:00:00Z'),
  });
  await store.recordCounters({
    cycles: 1,
    huaweiFailures: 2,
    rowsIngested: 3,
  });
  assert.deepEqual(await store.getCheckpoint('plant:1'), { cursor: 'next' });
  assert.deepEqual(await store.status(), {
    state: 'authorized',
    scopes: ['pvms.openapi.basic'],
    lastError: null,
    authorizedAt: null,
    updatedAt: null,
    plantCount: 2,
    deviceCount: 4,
    lastSuccessAt: null,
    backfill: {
      completed: 1,
      total: 3,
      lastSuccessAt: new Date('2026-08-05T09:00:00Z'),
    },
    counters: {
      cycles: 7,
      huaweiFailures: 2,
      tokenRefreshes: 1,
      rowsIngested: 42,
      skippedFields: 3,
      backfillSteps: 5,
    },
  });
  await store.close();

  assert.match(pool.queries[0].sql, /CREATE TABLE IF NOT EXISTS fusionsolar_oauth_credentials/);
  const counterWrite = pool.queries.find(({ sql }) => /INSERT INTO fusionsolar_diagnostics/.test(sql));
  assert.match(counterWrite.sql, /cycles = fusionsolar_diagnostics\.cycles \+ EXCLUDED\.cycles/);
  assert.deepEqual(counterWrite.values, [1, 2, 0, 3, 0, 0]);
  assert.equal(pool.ended, true);
});

test('real-pool schema initialization is serialized with a session advisory lock', async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(sql) {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
    async end() {},
  };
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  await store.init();

  assert.equal(statements[0], 'SELECT pg_advisory_lock(20260805, 9)');
  assert.match(statements[1], /CREATE EXTENSION IF NOT EXISTS "pgcrypto"/);
  assert.equal(statements[2], 'SELECT pg_advisory_unlock(20260805, 9)');
  assert.equal(released, true);
});

test('inventory and sync state reads expose only ingestion fields', async () => {
  const pool = createFakePool(async (sql) => {
    if (/FROM fusionsolar_plants/.test(sql)) {
      return {
        rows: [{
          plant_code: 'plant-1',
          source_key: 'HUAWEI:plant-1',
          display_name: 'Plant one',
          timezone: null,
          visible: true,
          metadata: { capacity: 1 },
        }],
        rowCount: 1,
      };
    }
    if (/FROM fusionsolar_devices/.test(sql)) {
      return {
        rows: [{
          device_id: 'device-1',
          plant_code: 'plant-1',
          device_type: '1',
          model: 'SUN2000',
          serial_number: 'sanitized',
          visible: true,
          metadata: { devDn: 'NE=DEVICE-1' },
        }],
        rowCount: 1,
      };
    }
    if (/SELECT checkpoint, backoff_until/.test(sql)) {
      return {
        rows: [{
          checkpoint: { before: 123 },
          backoff_until: new Date('2026-08-05T10:01:00Z'),
          last_success_at: new Date('2026-08-05T10:00:00Z'),
          last_error: null,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  assert.deepEqual(await store.listPlants(), [{
    plantCode: 'plant-1',
    sourceKey: 'HUAWEI:plant-1',
    displayName: 'Plant one',
    timezone: null,
    visible: true,
    metadata: { capacity: 1 },
  }]);
  assert.deepEqual(await store.listDevices(), [{
    deviceId: 'device-1',
    plantCode: 'plant-1',
    deviceType: '1',
    model: 'SUN2000',
    serialNumber: 'sanitized',
    visible: true,
    metadata: { devDn: 'NE=DEVICE-1' },
  }]);
  const deviceRead = pool.queries.find(({ sql }) => /FROM fusionsolar_devices/.test(sql));
  assert.match(deviceRead.sql, /WHERE visible = TRUE/);
  assert.deepEqual(await store.getSyncState('backfill:device:device-1'), {
    checkpoint: { before: 123 },
    backoffUntil: new Date('2026-08-05T10:01:00Z'),
    lastSuccessAt: new Date('2026-08-05T10:00:00Z'),
    lastError: null,
  });
});

test('measurements and checkpoint commit in one database transaction', async () => {
  const queries = [];
  let released = false;
  const client = {
    async query(sql, values) {
      queries.push({ sql, values });
      return { rows: [], rowCount: /INSERT INTO raw_measurements/.test(sql) ? 1 : 0 };
    },
    release() {
      released = true;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      throw new Error('transaction must use one checked-out client');
    },
    async end() {},
  };
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  assert.deepEqual(await store.saveMeasurementsAndCheckpoint(
    [{
      source: 'HUAWEI:plant-1',
      metric: 'huawei.plant.daily_yield_kwh',
      ts: '2026-08-05T10:00:00Z',
      value: 2,
      isMissing: false,
    }],
    'live',
    { collectedAt: 1785924000000 },
    { lastSuccessAt: new Date('2026-08-05T10:00:00Z') },
  ), { upserted: 1 });

  assert.equal(queries[0].sql, 'BEGIN');
  assert.match(queries[1].sql, /INSERT INTO raw_measurements/);
  assert.match(queries[2].sql, /INSERT INTO fusionsolar_sync_state/);
  assert.equal(queries[3].sql, 'COMMIT');
  assert.equal(released, true);
});

test('measurement and checkpoint transaction rolls back on checkpoint failure', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (/INSERT INTO fusionsolar_sync_state/.test(sql)) {
        throw new Error('checkpoint failed');
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      throw new Error('unexpected pool query');
    },
    async end() {},
  };
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });

  await assert.rejects(
    store.saveMeasurementsAndCheckpoint(
      [{
        source: 'HUAWEI:plant-1',
        metric: 'huawei.plant.daily_yield_kwh',
        ts: '2026-08-05T10:00:00Z',
        value: 2,
        isMissing: false,
      }],
      'live',
      { collectedAt: 1785924000000 },
    ),
    /checkpoint failed/,
  );
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(statements.includes('COMMIT'), false);
});

test('PostgreSQL integration preserves nonce and measurement idempotency', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const store = createFusionSolarStore({
    databaseUrl: process.env.TEST_DATABASE_URL,
    cipher: createTokenCipher(Buffer.alloc(32, 9)),
    pool,
  });
  const suffix = `${process.pid}-${Date.now()}`;
  const nonceHash = `nonce-${suffix}`;
  const setupTokenHash = `setup-${suffix}`;
  const authorizedSetupHash = `authorized-setup-${suffix}`;
  const plantCode = `plant-${suffix}`;
  const deviceId = `device-${suffix}`;
  const source = `HUAWEI:${plantCode}`;
  const syncKey = `sync-${suffix}`;

  try {
    await store.init();
    await store.init();
    await store.createNonce(nonceHash, new Date(Date.now() + 60_000), setupTokenHash);
    assert.equal(await store.consumeNonce(nonceHash, new Date()), setupTokenHash);
    assert.equal(await store.consumeNonce(nonceHash, new Date()), false);
    await store.createNonce(nonceHash, new Date(Date.now() + 60_000), setupTokenHash);
    assert.equal(await store.consumeNonce(nonceHash, new Date()), false);
    assert.equal(await store.isSetupTokenConsumed(setupTokenHash), false);
    assert.equal(await store.consumeSetupToken(setupTokenHash), true);
    assert.equal(await store.isSetupTokenConsumed(setupTokenHash), true);
    assert.equal(await store.consumeSetupToken(setupTokenHash), false);
    assert.equal(await store.saveCredentialsIfSetupUnused(authorizedSetupHash, {
      accessToken: 'integration-access',
      refreshToken: 'integration-refresh',
      accessExpiresAt: new Date('2026-08-05T11:00:00Z'),
      scopes: ['pvms.openapi.basic'],
      tokenType: 'Bearer',
    }), true);
    assert.equal(await store.isSetupTokenConsumed(authorizedSetupHash), true);
    assert.equal((await store.loadCredentials()).state, 'authorized');

    assert.deepEqual(await store.upsertPlants([{
      plantCode,
      sourceKey: source,
      displayName: 'Integration plant',
    }]), { upserted: 1 });
    assert.deepEqual(await store.upsertDevices([{
      deviceId,
      plantCode,
      deviceType: 'inverter',
    }]), { upserted: 1 });

    const measurement = {
      source,
      metric: 'huawei.plant.active_power_kw',
      ts: '2026-08-05T00:30:00.1234+02:00',
      value: 12.5,
      isMissing: false,
    };
    assert.deepEqual(await store.saveMeasurements([
      measurement,
      {
        ...measurement,
        ts: '2026-08-04T22:30:00.123400Z',
        value: 13.5,
      },
    ]), { upserted: 1 });
    assert.deepEqual(await store.saveMeasurements([
      {
        ...measurement,
        metric: 'huawei.device.voltage_v',
        ts: '2026-08-05T10:00:00.0001Z',
        value: 1,
      },
      {
        ...measurement,
        metric: 'huawei.device.voltage_v',
        ts: '2026-08-05T10:00:00.0002Z',
        value: 2,
      },
    ]), { upserted: 2 });

    assert.deepEqual(await store.saveMeasurementsAndCheckpoint(
      [{
        ...measurement,
        metric: 'huawei.plant.transactional_yield_kwh',
        value: 22,
      }],
      syncKey,
      { cursor: 'complete' },
      { lastSuccessAt: new Date('2026-08-05T10:00:00Z') },
    ), { upserted: 1 });
    assert.deepEqual(await store.getCheckpoint(syncKey), { cursor: 'complete' });
    assert.equal((await store.getSyncState(syncKey)).lastError, null);
    assert.equal((await store.listPlants()).some((plant) => plant.plantCode === plantCode), true);
    assert.equal((await store.listDevices()).some((device) => device.deviceId === deviceId), true);

    const { rows } = await pool.query(
      `SELECT count(*)::integer AS count, max(value) AS value
       FROM raw_measurements WHERE source = $1 AND metric = $2 AND ts = $3`,
      [source, measurement.metric, '2026-08-04T22:30:00.123400Z'],
    );
    assert.equal(rows[0].count, 1);
    assert.equal(rows[0].value, 13.5);
    const microseconds = await pool.query(
      `SELECT to_char(
         ts AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) AS ts
       FROM raw_measurements
       WHERE source = $1 AND metric = $2
       ORDER BY ts`,
      [source, 'huawei.device.voltage_v'],
    );
    assert.deepEqual(
      microseconds.rows.map((row) => row.ts),
      ['2026-08-05T10:00:00.000100Z', '2026-08-05T10:00:00.000200Z'],
    );
  } finally {
    await pool.query('DELETE FROM fusionsolar_oauth_nonces WHERE nonce_hash = $1', [nonceHash]);
    await pool.query(
      'DELETE FROM fusionsolar_setup_tokens WHERE token_hash = ANY($1)',
      [[setupTokenHash, authorizedSetupHash]],
    );
    await pool.query("DELETE FROM fusionsolar_oauth_credentials WHERE id = 'active'");
    await pool.query('DELETE FROM fusionsolar_sync_state WHERE sync_key = $1', [syncKey]);
    await pool.query('DELETE FROM raw_measurements WHERE source = $1', [source]);
    await pool.query('DELETE FROM fusionsolar_plants WHERE plant_code = $1', [plantCode]);
    await store.close();
  }
});

test('PostgreSQL allows only one completion from two valid pre-issued OAuth states', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const crypto = require('node:crypto');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
  const cipher = createTokenCipher(Buffer.alloc(32, 12));
  const store = createFusionSolarStore({
    databaseUrl: process.env.TEST_DATABASE_URL,
    cipher,
    pool,
  });
  const setupToken = `concurrent-setup-${process.pid}-${Date.now()}`;
  const setupTokenHash = crypto.createHash('sha256').update(setupToken).digest('hex');
  const nonceHashes = [];
  let arrivals = 0;
  let releaseExchanges;
  const exchangesReady = new Promise((resolve) => {
    releaseExchanges = resolve;
  });
  const client = {
    async exchangeCode(code) {
      arrivals += 1;
      if (arrivals === 2) releaseExchanges();
      await exchangesReady;
      return {
        accessToken: `access-${code}`,
        refreshToken: `refresh-${code}`,
        accessExpiresAt: new Date('2026-08-05T11:00:00Z'),
        scopes: ['pvms.openapi.basic'],
        tokenType: 'Bearer',
      };
    },
  };
  const stateManager = createStateManager({
    secret: Buffer.alloc(32, 13),
    store,
    now: () => new Date('2026-08-05T10:00:00Z'),
  });
  const integration = createIntegration({
    config: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://bios-multilevel.barrage.net/oauth/fusionsolar/callback',
      setupToken,
      tokenEncryptionKey: Buffer.alloc(32, 12),
      oauthBaseUrl: 'https://oauth.example.com',
      apiBaseUrl: 'https://api.example.com',
      databaseUrl: process.env.TEST_DATABASE_URL,
      liveIntervalMs: 300_000,
      backfillEnabled: true,
    },
    store,
    client,
    stateManager,
    synchronizer: {
      async runLiveCycle() {},
      async runBackfillStep() {},
    },
  });

  try {
    await store.init();
    await pool.query("DELETE FROM fusionsolar_oauth_credentials WHERE id = 'active'");
    await pool.query(
      'DELETE FROM fusionsolar_setup_tokens WHERE token_hash = $1',
      [setupTokenHash],
    );
    const states = await Promise.all([
      stateManager.issue(setupTokenHash),
      stateManager.issue(setupTokenHash),
    ]);
    for (const state of states) {
      const payload = JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString('utf8'));
      nonceHashes.push(crypto.createHash('sha256').update(payload.nonce).digest('hex'));
    }

    const results = await Promise.all([
      integration.completeCallback(new URLSearchParams({ state: states[0], code: 'code-a' })),
      integration.completeCallback(new URLSearchParams({ state: states[1], code: 'code-b' })),
    ]);

    assert.equal(results.filter(({ ok }) => ok).length, 1);
    const credentials = await store.loadCredentials();
    assert.equal(['access-code-a', 'access-code-b'].includes(credentials.accessToken), true);
    const consumed = await pool.query(
      'SELECT count(*)::integer AS count FROM fusionsolar_setup_tokens WHERE token_hash = $1',
      [setupTokenHash],
    );
    assert.equal(consumed.rows[0].count, 1);
  } finally {
    await pool.query("DELETE FROM fusionsolar_oauth_credentials WHERE id = 'active'");
    await pool.query(
      'DELETE FROM fusionsolar_setup_tokens WHERE token_hash = $1',
      [setupTokenHash],
    );
    if (nonceHashes.length > 0) {
      await pool.query(
        'DELETE FROM fusionsolar_oauth_nonces WHERE nonce_hash = ANY($1)',
        [nonceHashes],
      );
    }
    await store.close();
  }
});

test('PostgreSQL schema upgrade removes unbound legacy nonces and enforces digest not-null', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  const schemaName = `fusionsolar_migration_${process.pid}_${Date.now()}`;
  const quotedSchema = `"${schemaName}"`;
  const schemaSql = fs.readFileSync(
    path.resolve(__dirname, '../../database/schema.sql'),
    'utf8',
  );

  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    await client.query(`
      CREATE TABLE fusionsolar_oauth_nonces (
        nonce_hash TEXT PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `INSERT INTO fusionsolar_oauth_nonces (nonce_hash, expires_at)
       VALUES ('legacy-unbound', now() + interval '10 minutes')`,
    );

    await client.query(schemaSql);

    const remaining = await client.query(
      'SELECT count(*)::integer AS count FROM fusionsolar_oauth_nonces',
    );
    assert.equal(remaining.rows[0].count, 0);
    const column = await client.query(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'fusionsolar_oauth_nonces'
         AND column_name = 'setup_token_hash'`,
      [schemaName],
    );
    assert.equal(column.rows[0].is_nullable, 'NO');
  } finally {
    await client.query('RESET search_path');
    await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    client.release();
    await pool.end();
  }
});
