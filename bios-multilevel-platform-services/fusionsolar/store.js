const fs = require('node:fs');
const path = require('node:path');

const MAX_BIND_PARAMETERS = 60_000;

function createFusionSolarStore({ databaseUrl, cipher, pool: injectedPool } = {}) {
  if (!cipher || typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function') {
    throw new Error('createFusionSolarStore: cipher is required');
  }

  const pool = injectedPool || require('../database/pg-pool').createPool(databaseUrl, { max: 5 });

  async function init() {
    const schema = fs.readFileSync(
      path.resolve(__dirname, '../database/schema.sql'),
      'utf8',
    );
    await pool.query(schema);
  }

  async function createNonce(nonceHash, expiresAt) {
    await pool.query(
      `INSERT INTO fusionsolar_oauth_nonces (nonce_hash, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (nonce_hash) DO NOTHING`,
      [nonceHash, expiresAt],
    );
  }

  async function consumeNonce(nonceHash, now) {
    const result = await pool.query(
      `UPDATE fusionsolar_oauth_nonces
       SET consumed_at = now()
       WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > $2
       RETURNING nonce_hash`,
      [nonceHash, now],
    );
    return result.rowCount === 1;
  }

  async function saveCredentials(tokens) {
    if (typeof tokens?.accessToken !== 'string' || tokens.accessToken.trim() === '') {
      throw new Error('accessToken is required');
    }
    if (typeof tokens.refreshToken !== 'string' || tokens.refreshToken.trim() === '') {
      throw new Error('refreshToken is required');
    }

    await pool.query(
      `INSERT INTO fusionsolar_oauth_credentials
         (id, encrypted_access_token, encrypted_refresh_token, access_expires_at,
          granted_scopes, token_type, state, authorized_at, updated_at)
       VALUES ('active', $1, $2, $3, $4, $5, 'authorized', now(), now())
       ON CONFLICT (id) DO UPDATE SET
         encrypted_access_token = EXCLUDED.encrypted_access_token,
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
         access_expires_at = EXCLUDED.access_expires_at,
         granted_scopes = EXCLUDED.granted_scopes,
         token_type = EXCLUDED.token_type,
         state = 'authorized',
         last_error = NULL,
         updated_at = now()`,
      [
        cipher.encrypt(tokens.accessToken),
        cipher.encrypt(tokens.refreshToken),
        tokens.accessExpiresAt,
        tokens.scopes || [],
        tokens.tokenType,
      ],
    );
  }

  async function loadCredentials() {
    const { rows } = await pool.query(
      `SELECT encrypted_access_token, encrypted_refresh_token, access_expires_at,
              granted_scopes, token_type, state, last_error, authorized_at, updated_at
       FROM fusionsolar_oauth_credentials
       WHERE id = 'active'`,
    );
    const row = rows[0];
    if (!row) return null;

    return {
      accessToken: row.encrypted_access_token
        ? cipher.decrypt(row.encrypted_access_token)
        : null,
      refreshToken: row.encrypted_refresh_token
        ? cipher.decrypt(row.encrypted_refresh_token)
        : null,
      accessExpiresAt: row.access_expires_at,
      scopes: row.granted_scopes,
      tokenType: row.token_type,
      state: row.state,
      lastError: row.last_error,
      authorizedAt: row.authorized_at,
      updatedAt: row.updated_at,
    };
  }

  async function setAuthorizationState(state, lastError = null) {
    await pool.query(
      `INSERT INTO fusionsolar_oauth_credentials (id, state, last_error, updated_at)
       VALUES ('active', $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state,
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [state, lastError],
    );
  }

  async function upsertPlants(plants) {
    const rows = deduplicate(plants || [], (plant) => plant.plantCode);
    if (rows.length === 0) return { upserted: 0 };

    const result = await executeBatches(rows, 6, (batch) => {
      const values = [];
      const tuples = batch.map((plant, index) => {
        const offset = index * 6;
        values.push(
          plant.plantCode,
          plant.sourceKey,
          plant.displayName ?? null,
          plant.timezone ?? null,
          plant.visible !== false,
          plant.metadata || {},
        );
        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6})`;
      });
      return {
        sql: `INSERT INTO fusionsolar_plants
                (plant_code, source_key, display_name, timezone, visible, metadata)
              VALUES ${tuples.join(',')}
              ON CONFLICT (plant_code) DO UPDATE SET
                source_key = EXCLUDED.source_key,
                display_name = EXCLUDED.display_name,
                timezone = EXCLUDED.timezone,
                visible = EXCLUDED.visible,
                metadata = EXCLUDED.metadata,
                last_seen_at = now()`,
        values,
      };
    });
    return { upserted: result };
  }

  async function upsertDevices(devices) {
    const rows = deduplicate(devices || [], (device) => device.deviceId);
    if (rows.length === 0) return { upserted: 0 };

    const result = await executeBatches(rows, 6, (batch) => {
      const values = [];
      const tuples = batch.map((device, index) => {
        const offset = index * 6;
        values.push(
          device.deviceId,
          device.plantCode,
          device.deviceType ?? null,
          device.model ?? null,
          device.serialNumber ?? null,
          device.metadata || {},
        );
        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6})`;
      });
      return {
        sql: `INSERT INTO fusionsolar_devices
                (device_id, plant_code, device_type, model, serial_number, metadata)
              VALUES ${tuples.join(',')}
              ON CONFLICT (device_id) DO UPDATE SET
                plant_code = EXCLUDED.plant_code,
                device_type = EXCLUDED.device_type,
                model = EXCLUDED.model,
                serial_number = EXCLUDED.serial_number,
                metadata = EXCLUDED.metadata,
                last_seen_at = now()`,
        values,
      };
    });
    return { upserted: result };
  }

  async function saveMeasurements(measurements) {
    const normalized = (measurements || []).map((measurement) => ({
      ...measurement,
      ts: canonicalTimestamp(measurement.ts),
    }));
    const rows = deduplicate(
      normalized,
      (measurement) => JSON.stringify([
        measurement.source,
        measurement.metric,
        measurement.ts,
      ]),
    );
    if (rows.length === 0) return { upserted: 0 };

    const result = await executeBatches(rows, 5, (batch) => {
      const values = [];
      const tuples = batch.map((measurement, index) => {
        const offset = index * 5;
        values.push(
          measurement.source,
          measurement.metric,
          measurement.ts,
          measurement.value ?? null,
          Boolean(measurement.isMissing),
        );
        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5})`;
      });
      return {
        sql: `INSERT INTO raw_measurements (source, metric, ts, value, is_missing)
              VALUES ${tuples.join(',')}
              ON CONFLICT (source, metric, ts) DO UPDATE
              SET value = EXCLUDED.value,
                  is_missing = EXCLUDED.is_missing,
                  ingested_at = now()`,
        values,
      };
    });
    return { upserted: result };
  }

  async function getCheckpoint(syncKey) {
    const { rows } = await pool.query(
      'SELECT checkpoint FROM fusionsolar_sync_state WHERE sync_key = $1',
      [syncKey],
    );
    return rows[0]?.checkpoint ?? null;
  }

  async function setCheckpoint(syncKey, checkpoint, options = {}) {
    await pool.query(
      `INSERT INTO fusionsolar_sync_state
         (sync_key, checkpoint, backoff_until, last_success_at, last_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (sync_key) DO UPDATE SET
         checkpoint = EXCLUDED.checkpoint,
         backoff_until = COALESCE(EXCLUDED.backoff_until, fusionsolar_sync_state.backoff_until),
         last_success_at = COALESCE(EXCLUDED.last_success_at, fusionsolar_sync_state.last_success_at),
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [
        syncKey,
        checkpoint,
        options.backoffUntil ?? null,
        options.lastSuccessAt ?? null,
        options.lastError ?? null,
      ],
    );
  }

  async function status() {
    const { rows } = await pool.query(
      `SELECT
         credentials.state,
         credentials.granted_scopes,
         credentials.last_error,
         credentials.authorized_at,
         credentials.updated_at,
         (SELECT count(*) FROM fusionsolar_plants WHERE visible = TRUE) AS plant_count,
         (SELECT count(*) FROM fusionsolar_devices) AS device_count,
         (SELECT max(last_success_at) FROM fusionsolar_sync_state) AS last_success_at
       FROM (SELECT 1) AS singleton
       LEFT JOIN fusionsolar_oauth_credentials AS credentials ON credentials.id = 'active'`,
    );
    const row = rows[0] || {};
    return {
      state: row.state || 'not_authorized',
      scopes: row.granted_scopes || [],
      lastError: row.last_error || null,
      authorizedAt: row.authorized_at || null,
      updatedAt: row.updated_at || null,
      plantCount: Number(row.plant_count || 0),
      deviceCount: Number(row.device_count || 0),
      lastSuccessAt: row.last_success_at || null,
    };
  }

  async function close() {
    await pool.end();
  }

  async function executeBatches(rows, parameterCount, buildQuery) {
    const batchSize = Math.floor(MAX_BIND_PARAMETERS / parameterCount);
    let affected = 0;
    for (let index = 0; index < rows.length; index += batchSize) {
      const { sql, values } = buildQuery(rows.slice(index, index + batchSize));
      const result = await pool.query(sql, values);
      affected += result.rowCount || 0;
    }
    return affected;
  }

  return {
    init,
    createNonce,
    consumeNonce,
    saveCredentials,
    loadCredentials,
    setAuthorizationState,
    upsertPlants,
    upsertDevices,
    saveMeasurements,
    getCheckpoint,
    setCheckpoint,
    status,
    close,
  };
}

function deduplicate(rows, keyFor) {
  const unique = new Map();
  for (const row of rows) unique.set(keyFor(row), row);
  return [...unique.values()];
}

function canonicalTimestamp(value) {
  if (
    value === null
    || value === undefined
    || (!['string', 'number'].includes(typeof value) && !(value instanceof Date))
  ) {
    throw new Error('invalid measurement timestamp');
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error('invalid measurement timestamp');
  }
  return timestamp.toISOString();
}

module.exports = { createFusionSolarStore };
