const fs = require('node:fs');
const path = require('node:path');

const MAX_BIND_PARAMETERS = 60_000;

function createSolisStore({ databaseUrl, pool: injectedPool } = {}) {
  const pool = injectedPool || require('../database/pg-pool').createPool(databaseUrl, { max: 5 });

  async function init() {
    const schema = fs.readFileSync(
      path.resolve(__dirname, '../database/schema.sql'),
      'utf8',
    );
    if (typeof pool.connect !== 'function') {
      await pool.query(schema);
      return;
    }
    const client = await pool.connect();
    try {
      // Same advisory-lock convention as the other services so that several
      // pods applying schema.sql concurrently serialize instead of colliding.
      await client.query('SELECT pg_advisory_lock(20260805, 9)');
      await client.query(schema);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(20260805, 9)');
      } finally {
        client.release();
      }
    }
  }

  async function upsertPlants(plants) {
    const rows = deduplicate(plants || [], (plant) => plant.stationId);
    if (rows.length === 0) return { upserted: 0 };
    const result = await executeBatches(rows, 6, (batch) => {
      const values = [];
      const tuples = batch.map((plant, index) => {
        const offset = index * 6;
        values.push(
          plant.stationId,
          plant.sourceKey,
          plant.displayName ?? null,
          plant.timezone ?? null,
          plant.visible !== false,
          plant.metadata || {},
        );
        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6})`;
      });
      return {
        sql: `INSERT INTO soliscloud_plants
                (station_id, source_key, display_name, timezone, visible, metadata)
              VALUES ${tuples.join(',')}
              ON CONFLICT (station_id) DO UPDATE SET
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
    const rows = deduplicate(devices || [], (device) => device.deviceSn);
    if (rows.length === 0) return { upserted: 0 };
    const result = await executeBatches(rows, 6, (batch) => {
      const values = [];
      const tuples = batch.map((device, index) => {
        const offset = index * 6;
        values.push(
          device.deviceSn,
          device.stationId,
          device.inverterId ?? null,
          device.model ?? null,
          device.visible !== false,
          device.metadata || {},
        );
        return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6})`;
      });
      return {
        sql: `INSERT INTO soliscloud_devices
                (device_sn, station_id, inverter_id, model, visible, metadata)
              VALUES ${tuples.join(',')}
              ON CONFLICT (device_sn) DO UPDATE SET
                station_id = EXCLUDED.station_id,
                inverter_id = EXCLUDED.inverter_id,
                model = EXCLUDED.model,
                visible = EXCLUDED.visible,
                metadata = EXCLUDED.metadata,
                last_seen_at = now()`,
        values,
      };
    });
    return { upserted: result };
  }

  async function listPlants() {
    const { rows } = await pool.query(
      `SELECT station_id, source_key, display_name, timezone, visible, metadata
       FROM soliscloud_plants
       WHERE visible = TRUE
       ORDER BY station_id`,
    );
    return rows.map((row) => ({
      stationId: row.station_id,
      sourceKey: row.source_key,
      displayName: row.display_name,
      timezone: row.timezone,
      visible: row.visible,
      metadata: row.metadata || {},
    }));
  }

  async function listDevices() {
    const { rows } = await pool.query(
      `SELECT device_sn, station_id, inverter_id, model, visible, metadata
       FROM soliscloud_devices
       WHERE visible = TRUE
       ORDER BY device_sn`,
    );
    return rows.map((row) => ({
      deviceSn: row.device_sn,
      stationId: row.station_id,
      inverterId: row.inverter_id,
      model: row.model,
      visible: row.visible,
      metadata: row.metadata || {},
    }));
  }

  async function saveMeasurementsWith(queryable, measurements) {
    const rows = deduplicate(
      (measurements || []).map((measurement) => ({
        ...measurement,
        ts: canonicalTimestamp(measurement.ts),
      })),
      (measurement) => JSON.stringify([measurement.source, measurement.metric, measurement.ts]),
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
    }, queryable);
    return { upserted: result };
  }

  async function saveMeasurements(measurements) {
    return saveMeasurementsWith(pool, measurements);
  }

  async function getCheckpoint(syncKey) {
    const { rows } = await pool.query(
      'SELECT checkpoint FROM soliscloud_sync_state WHERE sync_key = $1',
      [syncKey],
    );
    return rows[0]?.checkpoint ?? null;
  }

  async function setCheckpointWith(queryable, syncKey, checkpoint, options = {}) {
    await queryable.query(
      `INSERT INTO soliscloud_sync_state
         (sync_key, checkpoint, backoff_until, last_success_at, last_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (sync_key) DO UPDATE SET
         checkpoint = EXCLUDED.checkpoint,
         backoff_until = EXCLUDED.backoff_until,
         last_success_at = COALESCE(EXCLUDED.last_success_at, soliscloud_sync_state.last_success_at),
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

  async function setCheckpoint(syncKey, checkpoint, options = {}) {
    return setCheckpointWith(pool, syncKey, checkpoint, options);
  }

  async function saveMeasurementsAndCheckpoint(measurements, syncKey, checkpoint, options = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await saveMeasurementsWith(client, measurements);
      await setCheckpointWith(client, syncKey, checkpoint, options);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original transactional failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function recordCounters(counters = {}) {
    const values = [
      safeCounter(counters.cycles),
      safeCounter(counters.solisFailures),
      safeCounter(counters.rowsIngested),
      safeCounter(counters.skippedFields),
      safeCounter(counters.backfillSteps),
    ];
    await pool.query(
      `INSERT INTO soliscloud_diagnostics
         (id, cycles, solis_failures, rows_ingested, skipped_fields, backfill_steps, updated_at)
       VALUES ('active', $1, $2, $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET
         cycles = soliscloud_diagnostics.cycles + EXCLUDED.cycles,
         solis_failures = soliscloud_diagnostics.solis_failures + EXCLUDED.solis_failures,
         rows_ingested = soliscloud_diagnostics.rows_ingested + EXCLUDED.rows_ingested,
         skipped_fields = soliscloud_diagnostics.skipped_fields + EXCLUDED.skipped_fields,
         backfill_steps = soliscloud_diagnostics.backfill_steps + EXCLUDED.backfill_steps,
         updated_at = now()`,
      values,
    );
  }

  async function status() {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*) FROM soliscloud_plants WHERE visible = TRUE) AS plant_count,
         (SELECT count(*) FROM soliscloud_devices WHERE visible = TRUE) AS device_count,
         (SELECT max(last_success_at) FROM soliscloud_sync_state WHERE sync_key = 'live')
           AS last_success_at,
         (SELECT last_error FROM soliscloud_sync_state WHERE sync_key = 'live') AS live_error,
         (SELECT count(*) FROM soliscloud_sync_state
          WHERE sync_key LIKE 'backfill:%' AND checkpoint->>'reachedBoundary' = 'true')
           AS backfill_completed,
         (SELECT count(*) FROM soliscloud_sync_state WHERE sync_key LIKE 'backfill:%')
           AS backfill_total,
         (SELECT max(last_success_at) FROM soliscloud_sync_state
          WHERE sync_key LIKE 'backfill:%') AS backfill_last_success_at,
         diagnostics.cycles,
         diagnostics.solis_failures,
         diagnostics.rows_ingested,
         diagnostics.skipped_fields,
         diagnostics.backfill_steps
       FROM (SELECT 1) AS singleton
       LEFT JOIN soliscloud_diagnostics AS diagnostics ON diagnostics.id = 'active'`,
    );
    const row = rows[0] || {};
    return {
      plantCount: Number(row.plant_count || 0),
      deviceCount: Number(row.device_count || 0),
      lastSuccessAt: row.last_success_at || null,
      lastError: row.live_error || null,
      backfill: Number(row.backfill_total || 0) > 0
        ? {
          completed: Number(row.backfill_completed || 0),
          total: Number(row.backfill_total),
          lastSuccessAt: row.backfill_last_success_at || null,
        }
        : null,
      counters: {
        cycles: Number(row.cycles || 0),
        solisFailures: Number(row.solis_failures || 0),
        rowsIngested: Number(row.rows_ingested || 0),
        skippedFields: Number(row.skipped_fields || 0),
        backfillSteps: Number(row.backfill_steps || 0),
      },
    };
  }

  async function close() {
    await pool.end();
  }

  async function executeBatches(rows, parameterCount, buildQuery, queryable = pool) {
    const batchSize = Math.floor(MAX_BIND_PARAMETERS / parameterCount);
    let affected = 0;
    for (let index = 0; index < rows.length; index += batchSize) {
      const { sql, values } = buildQuery(rows.slice(index, index + batchSize));
      const result = await queryable.query(sql, values);
      affected += result.rowCount || 0;
    }
    return affected;
  }

  return {
    init,
    upsertPlants,
    upsertDevices,
    listPlants,
    listDevices,
    saveMeasurements,
    saveMeasurementsAndCheckpoint,
    getCheckpoint,
    setCheckpoint,
    recordCounters,
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
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error('invalid measurement timestamp');
  return timestamp.toISOString();
}

function safeCounter(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error('diagnostic counter must be a non-negative safe integer');
  }
  return number;
}

module.exports = { createSolisStore };
