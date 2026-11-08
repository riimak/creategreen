const { createPool } = require('./pg-pool');

function createPgPredictionStore(databaseUrl) {
  // The dashboard fires one indexed /measurements query per source on every
  // page load (11+ sources with FusionSolar devices), so 5 connections queue
  // badly under a couple of concurrent clients.
  // 12s is under the dashboard proxy timeout, so a stuck scan becomes an
  // error response instead of an open request that keeps the slot forever.
  const statementTimeoutMs = Math.max(0, Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 12_000));
  // Client-side ceiling, a little above the server-side cancel so the server
  // gets to abort cleanly first; it is the guard that still works when the
  // backend is dead.
  const queryTimeoutMs = Math.max(0, Number(process.env.PG_QUERY_TIMEOUT_MS ?? (statementTimeoutMs > 0 ? statementTimeoutMs + 3_000 : 0)));
  const connectionTimeoutMs = Math.max(0, Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 5_000));
  // Schema application can build indexes over millions of rows.
  const initTimeoutMs = Math.max(60_000, Number(process.env.PG_INIT_TIMEOUT_MS ?? 15 * 60_000));
  const pool = createPool(databaseUrl, {
    max: 10,
    statementTimeoutMs,
    queryTimeoutMs,
    connectionTimeoutMs,
  });

  async function init() {
    const fs = require('fs');
    const path = require('path');
    const schema = fs.readFileSync(path.resolve(__dirname, 'schema.sql'), 'utf8');
    const client = await pool.connect();
    try {
      // Index builds on raw_measurements must not inherit the query timeout.
      if (statementTimeoutMs > 0) await client.query('SET statement_timeout = 0');
      await client.query({ text: schema, query_timeout: initTimeoutMs });
    } finally {
      if (statementTimeoutMs > 0) {
        await client.query(`SET statement_timeout = ${statementTimeoutMs}`).catch(() => {});
      }
      client.release();
    }
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

  /* SLA input: only the columns the summary reads, filtered by time in SQL.
   * The previous approach pulled the newest 10k full rows (JSONB and all) and
   * discarded most of them in JS on every /sla call. */
  async function listDataQualityWindow(sinceIso, limit = 10000) {
    const cap = Math.min(Math.max(Number(limit) || 10000, 1), 50000);
    const { rows } = await pool.query(
      `SELECT source, metric, status, computed_at, input->'missingRatio' AS missing_ratio
       FROM data_quality
       WHERE computed_at >= $1
       ORDER BY computed_at DESC
       LIMIT ${cap}`,
      [sinceIso],
    );
    return rows.map(row => ({
      source: row.source,
      metric: row.metric,
      status: row.status,
      computedAt: row.computed_at?.toISOString?.() || row.computed_at,
      input: { missingRatio: row.missing_ratio === null ? undefined : Number(row.missing_ratio) },
    }));
  }

  /* Paginated artifact listing. Used by the dashboard's Predikcije browser.
   * Accepts source/metric/status/search filters and limit/offset/sort options.
   * Returns { data, total } so the UI can render real pagination instead of
   * pulling a fixed page and filtering in JS.
   *
   * options.includeTotal (default true): callers that only need the rows
   * (the dashboard's "latest N" reads) pass false so no COUNT(*) runs beside
   * every query. An unfiltered total comes from the planner's row estimate
   * (pg_class.reltuples, refreshed by autovacuum/ANALYZE): an exact COUNT(*)
   * over 550k wide rows takes ~50 s on this database, and a pager does not
   * need better than ~1% accuracy. */
  async function listPaginated(kind, filters = {}, options = {}) {
    const table = kind === 'forecasts' ? 'forecasts'
      : kind === 'anomalies' ? 'anomalies'
      : kind === 'dataQuality' ? 'data_quality'
      : kind === 'runs' ? 'prediction_runs' : null;
    if (!table) return { data: [], total: 0, limit: 0, offset: 0 };
    const includeTotal = options.includeTotal !== false;
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
    if (!includeTotal) {
      const data = await pool.query(dataQ, values);
      return { data: data.rows.map(rowToArtifact), total: null, limit, offset };
    }
    const countQ = where.length
      ? `SELECT count(*)::bigint AS total, false AS estimated FROM ${table} ${whereSql}`
      : `SELECT greatest(reltuples, 0)::bigint AS total, true AS estimated FROM pg_class WHERE oid = '${table}'::regclass`;
    const [data, count] = await Promise.all([pool.query(dataQ, values), pool.query(countQ, values)]);
    let total = Number(count.rows[0]?.total ?? 0);
    let totalEstimated = Boolean(count.rows[0]?.estimated);
    if (totalEstimated && total === 0) {
      // Never analyzed yet (reltuples = -1 or 0): fall back to the exact count.
      const exact = await pool.query(`SELECT count(*)::bigint AS total FROM ${table}`);
      total = Number(exact.rows[0].total);
      totalEstimated = false;
    }
    return { data: data.rows.map(rowToArtifact), total, totalEstimated, limit, offset };
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
      // Each cycle re-sends the whole 72h window, so nearly every row already
      // exists with the same value. Rewriting it anyway (just to bump
      // ingested_at) produced ~180k dead tuples plus index churn every 10
      // minutes; the WHERE makes unchanged rows a no-op.
      const sql = `INSERT INTO raw_measurements (source, metric, ts, value, is_missing)
                   VALUES ${tuples.join(',')}
                   ON CONFLICT (source, metric, ts) DO UPDATE
                     SET value = EXCLUDED.value,
                         is_missing = EXCLUDED.is_missing,
                         ingested_at = now()
                   WHERE raw_measurements.value IS DISTINCT FROM EXCLUDED.value
                      OR raw_measurements.is_missing IS DISTINCT FROM EXCLUDED.is_missing`;
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
    if (filters.excludeMissing) where.push(`is_missing = FALSE AND value IS NOT NULL`);

    const sortCol = ({ timestamp: 'ts', source: 'source', metric: 'metric', value: 'value' })[filters.sort] || 'ts';
    const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(Math.max(Number(filters.limit) || 500, 1), 5000);
    const offset = Math.max(0, Number(filters.offset) || 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const bucketSeconds = Number(filters.bucketSeconds);
    if (Number.isFinite(bucketSeconds) && bucketSeconds >= 60) {
      // Server-side downsampling. A 30-day chart or a counter delta does not
      // need 8 640 raw rows; it needs one row per bucket with the aggregates
      // that make sense for a counter (first/last/max) or a gauge (avg/min/
      // max). `value` is the bucket average so the row shape stays compatible
      // with raw rows for existing chart code.
      values.push(bucketSeconds);
      const bucket = `date_bin(make_interval(secs => $${p}), ts, TIMESTAMPTZ '2000-01-01')`;
      const bucketQ = `SELECT source, metric,
                              extract(epoch from ${bucket})::bigint AS timestamp,
                              avg(value) AS value,
                              min(value) AS min,
                              max(value) AS max,
                              (array_agg(value ORDER BY ts) FILTER (WHERE value IS NOT NULL))[1] AS first,
                              (array_agg(value ORDER BY ts DESC) FILTER (WHERE value IS NOT NULL))[1] AS last,
                              count(value)::int AS count,
                              bool_and(is_missing) AS is_missing
                       FROM raw_measurements ${whereSql}
                       GROUP BY source, metric, ${bucket}
                       ORDER BY 3 ${sortDir}
                       LIMIT ${limit} OFFSET ${offset}`;
      const data = await pool.query(bucketQ, values);
      return {
        data: data.rows.map(r => ({
          source: r.source, metric: r.metric, timestamp: Number(r.timestamp),
          value: r.value === null ? null : Number(r.value), isMissing: r.is_missing,
          min: r.min === null ? null : Number(r.min), max: r.max === null ? null : Number(r.max),
          first: r.first === null ? null : Number(r.first), last: r.last === null ? null : Number(r.last),
          count: Number(r.count),
        })),
        total: null,
        limit, offset, bucketSeconds,
      };
    }

    const dataQ = `SELECT source, metric, extract(epoch from ts)::bigint AS timestamp, value, is_missing
                   FROM raw_measurements ${whereSql}
                   ORDER BY ${sortCol} ${sortDir}
                   LIMIT ${limit} OFFSET ${offset}`;
    const data = await pool.query(dataQ, values);
    // COUNT(*) on raw_measurements walks every matching row. The overview
    // never reads total, and running it beside every station query is what
    // filled the pool. Only the measurements table asks for it (count=1).
    let total = null;
    if (filters.includeTotal) {
      const countQ = `SELECT count(*)::bigint AS total FROM raw_measurements ${whereSql}`;
      const count = await pool.query(countQ, values);
      total = Number(count.rows[0].total);
    }
    return {
      data: data.rows.map(r => ({
        source: r.source, metric: r.metric, timestamp: Number(r.timestamp), value: r.value, isMissing: r.is_missing,
      })),
      total,
      limit, offset,
    };
  }

  // Vendor inventory is tiny. The overview station list must not wait on a
  // full scan of raw_measurements to discover Huawei and Solis sources.
  async function listKnownSources() {
    const sources = [];
    // source_key lives on the plant rows only; device source keys are derived
    // through the plant join exactly as the ingest services build them.
    const queries = [
      'SELECT source_key AS source FROM fusionsolar_plants',
      `SELECT p.source_key || ':device:' || d.device_id AS source
         FROM fusionsolar_devices d
         JOIN fusionsolar_plants p ON p.plant_code = d.plant_code`,
      'SELECT source_key AS source FROM soliscloud_plants',
      `SELECT p.source_key || ':device:' || d.device_sn AS source
         FROM soliscloud_devices d
         JOIN soliscloud_plants p ON p.station_id = d.station_id`,
    ];
    for (const sql of queries) {
      try {
        const { rows } = await pool.query(sql);
        for (const row of rows) if (row.source) sources.push(row.source);
      } catch (error) {
        // Vendor tables are absent on deployments that don't run that ingest
        // (42P01 undefined_table). Anything else is a bug and must be visible:
        // a wrong column name sat in this catch for months, logged only by
        // PostgreSQL, while device sources silently dropped out of discovery.
        if (error.code !== '42P01') console.warn(`listKnownSources: ${error.message}`);
      }
    }
    return sources;
  }

  async function rawMeasurementsStats() {
    const { rows } = await pool.query('SELECT * FROM raw_measurements_stats');
    const top = rows[0] || {};
    const [perStation, perMetric] = await Promise.all([
      pool.query(
        `SELECT source, count(*)::bigint AS rows, min(ts) AS earliest, max(ts) AS latest
         FROM raw_measurements GROUP BY source ORDER BY source`,
      ),
      pool.query(
        `SELECT metric, count(*)::bigint AS rows
         FROM raw_measurements GROUP BY metric ORDER BY metric`,
      ),
    ]);
    return {
      perMetric: perMetric.rows.map(r => ({ metric: r.metric, rows: Number(r.rows) })),
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

  // Human-readable labels for dynamically discovered vendor sources
  // (FusionSolar and SolisCloud). Plants map to their portal display name;
  // devices to "<plant> · <device>". The tables may not exist on standalone
  // deployments, hence the per-vendor guards.
  async function sourceLabels() {
    const labels = {};
    try {
      const [plants, devices] = await Promise.all([
        pool.query('SELECT source_key, display_name, plant_code FROM fusionsolar_plants'),
        pool.query(
          `SELECT p.source_key || ':device:' || d.device_id AS source,
                  coalesce(p.display_name, p.plant_code) AS plant_name,
                  coalesce(d.metadata->>'devName', d.model, d.device_id) AS device_name
           FROM fusionsolar_devices d
           JOIN fusionsolar_plants p ON p.plant_code = d.plant_code`,
        ),
      ]);
      for (const row of plants.rows) {
        if (row.display_name) labels[row.source_key] = row.display_name;
      }
      for (const row of devices.rows) {
        labels[row.source] = `${row.plant_name} · ${row.device_name}`;
      }
    } catch {
      // FusionSolar tables absent; continue with other vendors.
    }
    try {
      const [plants, devices] = await Promise.all([
        pool.query('SELECT source_key, display_name, station_id FROM soliscloud_plants'),
        pool.query(
          // SolisCloud device names are generic model strings ("1200"), so
          // the serial number is the only distinctive per-device label.
          `SELECT p.source_key || ':device:' || d.device_sn AS source,
                  coalesce(p.display_name, p.station_id) AS plant_name,
                  'INV-' || d.device_sn AS device_name
           FROM soliscloud_devices d
           JOIN soliscloud_plants p ON p.station_id = d.station_id`,
        ),
      ]);
      for (const row of plants.rows) {
        if (row.display_name) labels[row.source_key] = row.display_name;
      }
      for (const row of devices.rows) {
        labels[row.source] = `${row.plant_name} · ${row.device_name}`;
      }
    } catch {
      // SolisCloud tables absent; labels stay as collected so far.
    }
    return labels;
  }

  async function pruneRawMeasurements(retentionDays) {
    if (!retentionDays || retentionDays <= 0) return { deleted: 0, skipped: 'retention disabled' };
    const { rows } = await pool.query('SELECT prune_raw_measurements($1) AS deleted', [retentionDays]);
    return { deleted: Number(rows[0]?.deleted || 0) };
  }

  /* Health probes must answer quickly even when the pool is busy: short
   * client-side ceiling so a dead backend reports as an error, not a hang. */
  async function ping() {
    await pool.query({ text: 'SELECT 1', query_timeout: 3_000 });
    return { ok: true };
  }

  /* Newest measurement per configured station. One correlated max(ts) per
   * source walks idx_raw_measurements_source_ts backwards: a handful of index
   * probes, independent of table size. */
  async function latestMeasurementTimestamps(sources) {
    const wanted = [...new Set((sources || []).filter(Boolean))];
    if (wanted.length === 0) return [];
    const { rows } = await pool.query(
      `SELECT s.source, (SELECT max(r.ts) FROM raw_measurements r WHERE r.source = s.source) AS latest
       FROM unnest($1::text[]) AS s(source)`,
      [wanted],
    );
    const byName = new Map(rows.map(r => [r.source, r.latest]));
    return wanted.map(source => {
      const latest = byName.get(source);
      return { source, latestTs: latest?.toISOString?.() || latest || null };
    });
  }

  return {
    init, append, list, latest, listPaginated, listDataQualityWindow, checkpoint, setMeta, read, write, stats, prune,
    persistRawRecords, listRawMeasurements, rawMeasurementsStats, pruneRawMeasurements, sourceLabels, listKnownSources,
    ping, latestMeasurementTimestamps,
    file: 'postgres',
  };
}

module.exports = { createPgPredictionStore };
