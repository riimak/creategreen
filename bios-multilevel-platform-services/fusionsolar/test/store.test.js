const test = require('node:test');
const assert = require('node:assert/strict');
const { createFusionSolarStore } = require('../store');
const { createTokenCipher } = require('../crypto');

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

test('nonce consumption uses one atomic, parameterized update', async () => {
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
      return { rows: [{ nonce_hash: 'hash' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const store = createFusionSolarStore({ pool, cipher: fakeCipher() });
  const now = new Date();

  await store.createNonce('hash', new Date(now.getTime() + 60_000));
  assert.equal(await store.consumeNonce('hash', now), true);
  assert.equal(await store.consumeNonce('hash', now), false);
  await store.createNonce('hash', new Date(now.getTime() + 60_000));
  assert.equal(await store.consumeNonce('hash', now), false);

  const updates = pool.queries.filter(({ sql }) => /UPDATE fusionsolar_oauth_nonces/.test(sql));
  assert.equal(updates.length, 3);
  assert.match(updates[0].sql, /consumed_at IS NULL AND expires_at > \$2/);
  assert.match(updates[0].sql, /RETURNING nonce_hash/);
  assert.deepEqual(updates[0].values, ['hash', now]);
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
    metadata: { vendor: 'Huawei' },
  }]);

  const [state, plants, devices] = pool.queries;
  assert.deepEqual(state.values, ['reauthorization_required', 'refresh token rejected']);
  assert.match(plants.sql, /ON CONFLICT \(plant_code\) DO UPDATE/);
  assert.deepEqual(plants.values.slice(0, 2), ['plant-1', 'HUAWEI:plant-1']);
  assert.match(devices.sql, /ON CONFLICT \(device_id\) DO UPDATE/);
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
    '2026-08-05T10:00:00.000Z',
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
    '2026-08-05T10:00:00.000Z',
    13.5,
    false,
  ]);
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

  await assert.rejects(
    store.saveMeasurements([{
      source: 'HUAWEI:plant-1',
      metric: 'huawei.plant.active_power_kw',
      ts: 'not-a-timestamp',
      value: 12.5,
      isMissing: false,
    }]),
    /invalid measurement timestamp/,
  );
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
  });
  await store.close();

  assert.match(pool.queries[0].sql, /CREATE TABLE IF NOT EXISTS fusionsolar_oauth_credentials/);
  assert.equal(pool.ended, true);
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
  const plantCode = `plant-${suffix}`;
  const deviceId = `device-${suffix}`;
  const source = `HUAWEI:${plantCode}`;
  const syncKey = `sync-${suffix}`;

  try {
    await store.init();
    await store.init();
    await store.createNonce(nonceHash, new Date(Date.now() + 60_000));
    assert.equal(await store.consumeNonce(nonceHash, new Date()), true);
    assert.equal(await store.consumeNonce(nonceHash, new Date()), false);
    await store.createNonce(nonceHash, new Date(Date.now() + 60_000));
    assert.equal(await store.consumeNonce(nonceHash, new Date()), false);

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
      ts: '2026-08-05T10:00:00Z',
      value: 12.5,
      isMissing: false,
    };
    assert.deepEqual(await store.saveMeasurements([
      measurement,
      {
        ...measurement,
        ts: '2026-08-05T12:00:00+02:00',
        value: 13.5,
      },
    ]), { upserted: 1 });

    await store.setCheckpoint(syncKey, { cursor: 'complete' });
    assert.deepEqual(await store.getCheckpoint(syncKey), { cursor: 'complete' });

    const { rows } = await pool.query(
      `SELECT count(*)::integer AS count, max(value) AS value
       FROM raw_measurements WHERE source = $1 AND metric = $2 AND ts = $3`,
      [source, measurement.metric, measurement.ts],
    );
    assert.equal(rows[0].count, 1);
    assert.equal(rows[0].value, 13.5);
  } finally {
    await pool.query('DELETE FROM fusionsolar_oauth_nonces WHERE nonce_hash = $1', [nonceHash]);
    await pool.query('DELETE FROM fusionsolar_sync_state WHERE sync_key = $1', [syncKey]);
    await pool.query('DELETE FROM raw_measurements WHERE source = $1', [source]);
    await pool.query('DELETE FROM fusionsolar_plants WHERE plant_code = $1', [plantCode]);
    await store.close();
  }
});
