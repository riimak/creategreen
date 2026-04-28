const { createPool } = require('./pg-pool');

function createPgPredictionStore(databaseUrl) {
  const pool = createPool(databaseUrl, { max: 5 });

  async function init() {
    const fs = require('fs');
    const path = require('path');
    const schema = fs.readFileSync(path.resolve(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
  }

  function append(kind, artifact) {
    const id = artifact.id || `${kind}-${Date.now()}`;
    if (kind === 'forecasts') {
      return pool.query(
        `INSERT INTO forecasts (id, source, metric, model, residual_error, sigma, horizon_hours,
         train_size, holdout_size, input_from, input_to, input_count, points, model_comparisons,
         metric_info, input_source, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, artifact.source, artifact.metric, artifact.model, artifact.residualError,
         artifact.sigma, artifact.horizonHours, artifact.trainSize, artifact.holdoutSize,
         artifact.input?.from, artifact.input?.to, artifact.input?.count,
         JSON.stringify(artifact.points), JSON.stringify(artifact.modelComparisons),
         JSON.stringify(artifact.metricInfo), JSON.stringify(artifact.inputSource),
         artifact.computedAt || new Date().toISOString()]
      ).then(() => artifact);
    }
    if (kind === 'anomalies') {
      return pool.query(
        `INSERT INTO anomalies (id, source, metric, anomaly_count, anomaly_data, metric_info, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, artifact.source, artifact.metric, artifact.anomalies?.length || 0,
         JSON.stringify(artifact.anomalies), JSON.stringify(artifact.metricInfo),
         artifact.computedAt || new Date().toISOString()]
      ).then(() => artifact);
    }
    if (kind === 'dataQuality') {
      return pool.query(
        `INSERT INTO data_quality (id, source, metric, status, reasons, input, input_source, metric_info, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, artifact.source, artifact.metric, artifact.status,
         artifact.reasons || [], JSON.stringify(artifact.input),
         JSON.stringify(artifact.inputSource), JSON.stringify(artifact.metricInfo),
         artifact.computedAt || new Date().toISOString()]
      ).then(() => artifact);
    }
    if (kind === 'runs') {
      return pool.query(
        `INSERT INTO prediction_runs (id, reason, status, results, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET status=$3, results=$4, finished_at=$6 RETURNING id`,
        [artifact.id, artifact.reason, artifact.status, JSON.stringify(artifact.results),
         artifact.startedAt, artifact.finishedAt]
      ).then(() => artifact);
    }
    return Promise.resolve(artifact);
  }

  async function list(kind, predicate = () => true, limit = 100) {
    const table = kind === 'forecasts' ? 'forecasts'
      : kind === 'anomalies' ? 'anomalies'
      : kind === 'dataQuality' ? 'data_quality'
      : kind === 'runs' ? 'prediction_runs' : null;
    if (!table) return [];
    const { rows } = await pool.query(
      `SELECT * FROM ${table} ORDER BY created_at DESC LIMIT $1`, [limit]
    );
    return rows.map(rowToArtifact).filter(predicate);
  }

  async function latest(kind, predicate = () => true) {
    const items = await list(kind, predicate, 1);
    return items[0] || null;
  }

  /* Paginated artifact listing. Used by the dashboard's Predikcije browser.
   * Accepts source/metric/status/search filters and limit/offset/sort options.
   * Returns { data, total } so the UI can render real pagination instead of
   * pulling a fixed page and filtering in JS. */
  async function listPaginated(kind, filters = {}, options = {}) {
    const table = kind === 'forecasts' ? 'forecasts'
      : kind === 'anomalies' ? 'anomalies'
      : kind === 'dataQuality' ? 'data_quality'
      : kind === 'runs' ? 'prediction_runs' : null;
    if (!table) return { data: [], total: 0, limit: 0, offset: 0 };
    const where = [];
    const values = [];
    let p = 1;
    if (filters.source) { where.push(`source = $${p++}`); values.push(filters.source); }
    if (filters.metric) { where.push(`metric = $${p++}`); values.push(filters.metric); }
    if (filters.status) { where.push(`status = $${p++}`); values.push(filters.status); }
    if (filters.search) {
      const cols = kind === 'forecasts'
        ? `coalesce(source,'') || ' ' || coalesce(metric,'') || ' ' || coalesce(model,'')`
        : kind === 'dataQuality'
          ? `coalesce(source,'') || ' ' || coalesce(metric,'') || ' ' || coalesce(status,'')`
          : `coalesce(source,'') || ' ' || coalesce(metric,'')`;
      where.push(`(${cols}) ILIKE $${p++}`);
      values.push(`%${filters.search}%`);
    }
    const sortCol = ({
      timestamp: 'computed_at',
      computed_at: 'computed_at',
      created_at: 'created_at',
      source: 'source',
      metric: 'metric',
    })[options.sort] || 'computed_at';
    const sortDir = options.sortDir === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 1000);
    const offset = Math.max(0, Number(options.offset) || 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const dataQ = `SELECT * FROM ${table} ${whereSql} ORDER BY ${sortCol} ${sortDir} LIMIT ${limit} OFFSET ${offset}`;
    const countQ = `SELECT count(*)::bigint AS total FROM ${table} ${whereSql}`;
    const [data, count] = await Promise.all([pool.query(dataQ, values), pool.query(countQ, values)]);
    return { data: data.rows.map(rowToArtifact), total: Number(count.rows[0].total), limit, offset };
  }

  async function checkpoint(key, value) {
    if (value !== undefined) {
      await pool.query(
        `INSERT INTO prediction_checkpoints (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
        [key, JSON.stringify(value)]
      );
    }
    const { rows } = await pool.query(`SELECT value FROM prediction_checkpoints WHERE key=$1`, [key]);
    return rows[0]?.value || null;
  }

  async function setMeta(key, value) {
    return checkpoint(`meta:${key}`, value);
  }

  function read() {
    return { forecasts: [], anomalies: [], dataQuality: [], runs: [], meta: {}, checkpoints: {} };
  }
  function write() {}

  function rowToArtifact(row) {
    return {
      id: row.id,
      source: row.source,
      metric: row.metric,
      model: row.model,
      residualError: row.residual_error,
      sigma: row.sigma,
      horizonHours: row.horizon_hours,
      trainSize: row.train_size,
      holdoutSize: row.holdout_size,
      input: row.input || { from: row.input_from, to: row.input_to, count: row.input_count },
      points: row.points,
      modelComparisons: row.model_comparisons,
      metricInfo: row.metric_info,
      inputSource: row.input_source,
      computedAt: row.computed_at?.toISOString?.() || row.computed_at,
      status: row.status,
      reasons: row.reasons,
      anomalies: row.anomaly_data,
      anomalyCount: row.anomaly_count,
      reason: row.reason,
      results: row.results,
      startedAt: row.started_at?.toISOString?.() || row.started_at,
      finishedAt: row.finished_at?.toISOString?.() || row.finished_at,
    };
  }

  async function stats() {
    const { rows } = await pool.query('SELECT * FROM prediction_stats');
    return rows[0] || {};
  }

  async function prune(forecastDays = 90) {
    const { rows } = await pool.query('SELECT * FROM prune_old_records($1, 180)', [forecastDays]);
    return rows[0] || {};
  }

  /* ── Mars2 raw measurements ──────────────────────────────────────────────
   * `records` is the array returned by bios-data.loadRecords for one station:
   *   [{ source, timestamp, <metric1>: val, <metric2>: val, ... }]
   * We expand to (source, metric, ts) rows and bulk-insert with ON CONFLICT
   * DO UPDATE so re-running the cycle / backfill is idempotent. */
  async function persistRawRecords(source, fields, records) {
    if (!records || records.length === 0) return { inserted: 0 };
    // IMPORTANT: batch by EXPANDED measurement rows, not source records.
    // SOLAX can return ~2k timestamps * ~14 metrics => ~28k measurement rows.
    // At 5 bind params per row, libpq's 65535 param limit can be exceeded.
    const PARAMS_PER_ROW = 5;
    const MAX_BIND_PARAMS = 60000; // leave headroom under 65535
    const MAX_ROWS_PER_BATCH = Math.floor(MAX_BIND_PARAMS / PARAMS_PER_ROW);
    let total = 0;
    const batch = new Map();

    const flush = async () => {
      if (batch.size === 0) return;
      const values = [];
      const tuples = [];
      let p = 1;
      for (const row of batch.values()) {
        tuples.push(`($${p++},$${p++},$${p++},$${p++},$${p++})`);
        values.push(...row);
      }
      const sql = `INSERT INTO raw_measurements (source, metric, ts, value, is_missing)
                   VALUES ${tuples.join(',')}
                   ON CONFLICT (source, metric, ts) DO UPDATE
                     SET value = EXCLUDED.value,
                         is_missing = EXCLUDED.is_missing,
                         ingested_at = now()`;
      const r = await pool.query(sql, values);
      total += r.rowCount || 0;
      batch.clear();
    };

    for (const row of records) {
      const station = row.source || source;
      if (!Number.isFinite(row.timestamp)) continue;
      const tsIso = new Date(row.timestamp * 1000).toISOString();
      for (const metric of fields) {
        const v = row[metric];
        const isMissing = !Number.isFinite(v);
        // Mars2 exports can include duplicate timestamps in a single window.
        // Deduplicate inside each SQL batch to avoid ON CONFLICT self-conflicts.
        const key = `${station}\x1f${metric}\x1f${tsIso}`;
        batch.set(key, [station, metric, tsIso, isMissing ? null : v, isMissing]);
        if (batch.size >= MAX_ROWS_PER_BATCH) {
          await flush();
        }
      }
    }
    await flush();
    return { inserted: total };
  }

  async function listRawMeasurements(filters = {}) {
    const where = [];
    const values = [];
    let p = 1;
    if (filters.source) { where.push(`source = $${p++}`); values.push(filters.source); }
    if (filters.metric) { where.push(`metric = $${p++}`); values.push(filters.metric); }
    if (filters.from)   { where.push(`ts >= $${p++}`);    values.push(filters.from); }
    if (filters.to)     { where.push(`ts <= $${p++}`);    values.push(filters.to); }
    if (Number.isFinite(filters.valueMin)) { where.push(`value >= $${p++}`); values.push(filters.valueMin); }
    if (Number.isFinite(filters.valueMax)) { where.push(`value <= $${p++}`); values.push(filters.valueMax); }
    if (filters.search) {
      where.push(`(source ILIKE $${p} OR metric ILIKE $${p})`);
      values.push(`%${filters.search}%`);
      p += 1;
    }
    if (filters.missingOnly) where.push(`is_missing = TRUE`);

    const sortCol = ({ timestamp: 'ts', source: 'source', metric: 'metric', value: 'value' })[filters.sort] || 'ts';
    const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(Number(filters.limit) || 500, 1), 5000);
    const offset = Math.max(0, Number(filters.offset) || 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const dataQ = `SELECT source, metric, extract(epoch from ts)::bigint AS timestamp, value, is_missing
                   FROM raw_measurements ${whereSql}
                   ORDER BY ${sortCol} ${sortDir}
                   LIMIT ${limit} OFFSET ${offset}`;
    const countQ = `SELECT count(*)::bigint AS total FROM raw_measurements ${whereSql}`;
    const [data, count] = await Promise.all([pool.query(dataQ, values), pool.query(countQ, values)]);
    return {
      data: data.rows.map(r => ({
        source: r.source, metric: r.metric, timestamp: Number(r.timestamp), value: r.value, isMissing: r.is_missing,
      })),
      total: Number(count.rows[0].total),
      limit, offset,
    };
  }

  async function rawMeasurementsStats() {
    const { rows } = await pool.query('SELECT * FROM raw_measurements_stats');
    const top = rows[0] || {};
    const perStation = await pool.query(
      `SELECT source, count(*)::bigint AS rows, min(ts) AS earliest, max(ts) AS latest
       FROM raw_measurements GROUP BY source ORDER BY source`,
    );
    return {
      totalRows: Number(top.total_rows || 0),
      uniqueSources: Number(top.unique_sources || 0),
      uniqueMetrics: Number(top.unique_metrics || 0),
      missingRows: Number(top.missing_rows || 0),
      rows24h: Number(top.rows_24h || 0),
      rows7d: Number(top.rows_7d || 0),
      earliest: top.earliest?.toISOString?.() || top.earliest || null,
      latest:   top.latest?.toISOString?.()   || top.latest   || null,
      perStation: perStation.rows.map(r => ({
        source: r.source,
        rows: Number(r.rows),
        earliest: r.earliest?.toISOString?.() || r.earliest,
        latest: r.latest?.toISOString?.() || r.latest,
      })),
    };
  }

  async function pruneRawMeasurements(retentionDays) {
    if (!retentionDays || retentionDays <= 0) return { deleted: 0, skipped: 'retention disabled' };
    const { rows } = await pool.query('SELECT prune_raw_measurements($1) AS deleted', [retentionDays]);
    return { deleted: Number(rows[0]?.deleted || 0) };
  }

  return {
    init, append, list, latest, listPaginated, checkpoint, setMeta, read, write, stats, prune,
    persistRawRecords, listRawMeasurements, rawMeasurementsStats, pruneRawMeasurements,
    file: 'postgres',
  };
}

module.exports = { createPgPredictionStore };
