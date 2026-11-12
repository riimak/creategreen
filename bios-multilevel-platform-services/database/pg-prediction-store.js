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
      // A failed run has no per-target results; keep its error in the same
      // column so a replica that did not run the cycle can still report it.
      const results = artifact.results ?? (artifact.error ? [{ status: 'failed', error: artifact.error }] : null);
      return pool.query(
        `INSERT INTO prediction_runs (id, reason, status, results, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET status=$3, results=$4, finished_at=$6 RETURNING id`,
        [artifact.id, artifact.reason, artifact.status, JSON.stringify(results),
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

  // Distinct (source, metric) pairs by walking the primary key one probe per
  // pair ("loose index scan") instead of GROUP BY over the whole table, plus
  // the planner's most-common-values histogram for per-source/metric row
  // counts. Both sides of the dashboard's station list come from here, so
  // this used to be two full scans of ~3M rows every 5 minutes.
  const PAIRS_CTE = `
    WITH RECURSIVE pairs AS (
      (SELECT source, metric FROM raw_measurements ORDER BY source, metric LIMIT 1)
      UNION ALL
      SELECT n.source, n.metric
        FROM pairs p
        CROSS JOIN LATERAL (
          SELECT source, metric FROM raw_measurements
           WHERE (source, metric) > (p.source, p.metric)
           ORDER BY source, metric LIMIT 1
        ) n
    ),
    total AS (SELECT greatest(reltuples, 0)::numeric AS n FROM pg_class WHERE oid = 'raw_measurements'::regclass),
    mcv AS (
      SELECT s.attname, v.val, v.freq
        FROM pg_stats s
        CROSS JOIN LATERAL unnest(s.most_common_vals::text::text[], s.most_common_freqs) AS v(val, freq)
       WHERE s.schemaname = current_schema() AND s.tablename = 'raw_measurements' AND s.attname IN ('source', 'metric')
    )`;

  async function rawMeasurementsStats() {
    const { rows } = await pool.query('SELECT * FROM raw_measurements_stats');
    const top = rows[0] || {};
    const [perStation, perMetric] = await Promise.all([
      pool.query(
        `${PAIRS_CTE}
         SELECT s.source,
                (SELECT round(total.n * m.freq)::bigint FROM mcv m, total WHERE m.attname = 'source' AND m.val = s.source) AS rows,
                b.earliest, b.latest
           FROM (SELECT DISTINCT source FROM pairs) s
           CROSS JOIN LATERAL (
             SELECT min(ts) AS earliest, max(ts) AS latest FROM raw_measurements WHERE source = s.source
           ) b
          ORDER BY s.source`,
      ),
      pool.query(
        `${PAIRS_CTE}
         SELECT m.metric,
                (SELECT round(total.n * x.freq)::bigint FROM mcv x, total WHERE x.attname = 'metric' AND x.val = m.metric) AS rows
           FROM (SELECT DISTINCT metric FROM pairs) m
          ORDER BY m.metric`,
      ),
    ]);
    return {
      // Row counts are planner estimates (ANALYZE-fresh, ~1%); sources,
      // metrics and time bounds are exact.
      rowsEstimated: true,
      perMetric: perMetric.rows.map(r => ({ metric: r.metric, rows: r.rows === null ? null : Number(r.rows) })),
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
        rows: r.rows === null ? null : Number(r.rows),
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

  /* ── Feed API support (Mars2 pulls the vendor plants from us) ─────────────
   * Everything here is sized for a poll every few minutes per plant: index
   * probes and short index-only range scans, never a table scan. */

  // Plants and their devices from the vendor inventory tables. Each vendor is
  // guarded separately: a deployment without that ingest has no such tables.
  async function listFeedInventory() {
    const plants = [];
    const vendors = [
      {
        vendor: 'huawei',
        sql: `SELECT p.source_key AS source, p.plant_code AS vendor_id, p.display_name, p.visible, p.metadata,
                     coalesce(json_agg(json_build_object(
                       'source', p.source_key || ':device:' || d.device_id,
                       'id', d.device_id, 'type', d.device_type, 'model', d.model,
                       'serial', d.serial_number, 'name', d.metadata->>'devName'
                     ) ORDER BY d.device_id) FILTER (WHERE d.device_id IS NOT NULL), '[]'::json) AS devices
                FROM fusionsolar_plants p
                LEFT JOIN fusionsolar_devices d ON d.plant_code = p.plant_code
               GROUP BY p.plant_code ORDER BY p.plant_code`,
      },
      {
        vendor: 'solis',
        sql: `SELECT p.source_key AS source, p.station_id AS vendor_id, p.display_name, p.visible, p.metadata,
                     coalesce(json_agg(json_build_object(
                       'source', p.source_key || ':device:' || d.device_sn,
                       'id', d.device_sn, 'type', 'inverter', 'model', d.model,
                       'serial', d.device_sn, 'name', d.inverter_id
                     ) ORDER BY d.device_sn) FILTER (WHERE d.device_sn IS NOT NULL), '[]'::json) AS devices
                FROM soliscloud_plants p
                LEFT JOIN soliscloud_devices d ON d.station_id = p.station_id
               GROUP BY p.station_id ORDER BY p.station_id`,
      },
    ];
    for (const { vendor, sql } of vendors) {
      try {
        const { rows } = await pool.query(sql);
        for (const row of rows) {
          plants.push({
            vendor,
            source: row.source,
            vendorId: row.vendor_id,
            name: row.display_name || row.vendor_id,
            visible: row.visible !== false,
            capacityKwp: Number.isFinite(Number(row.metadata?.capacity)) ? Number(row.metadata.capacity) : null,
            devices: Array.isArray(row.devices) ? row.devices : [],
          });
        }
      } catch (error) {
        if (error.code !== '42P01') console.warn(`listFeedInventory(${vendor}): ${error.message}`);
      }
    }
    return plants;
  }

  // Distinct metrics stored for one source: a loose index scan over the
  // covering key (one probe per metric), so it does not depend on row count.
  async function distinctMetricsForSource(source) {
    const { rows } = await pool.query(
      `WITH RECURSIVE m AS (
         (SELECT metric FROM raw_measurements WHERE source = $1 ORDER BY metric LIMIT 1)
         UNION ALL
         SELECT n.metric FROM m
         CROSS JOIN LATERAL (
           SELECT metric FROM raw_measurements WHERE source = $1 AND metric > m.metric ORDER BY metric LIMIT 1
         ) n
       )
       SELECT metric FROM m`,
      [source],
    );
    return rows.map(r => r.metric);
  }

  // Newest usable sample for each (source, metric) pair in one round trip.
  async function latestSamples(pairs) {
    const wanted = (pairs || []).filter(p => p && p.source && p.metric);
    if (wanted.length === 0) return [];
    const { rows } = await pool.query(
      `SELECT q.source, q.metric, r.ts, r.value
         FROM unnest($1::text[], $2::text[]) AS q(source, metric)
         CROSS JOIN LATERAL (
           SELECT ts, value FROM raw_measurements
            WHERE source = q.source AND metric = q.metric AND is_missing = FALSE AND value IS NOT NULL
            ORDER BY ts DESC LIMIT 1
         ) r`,
      [wanted.map(p => p.source), wanted.map(p => p.metric)],
    );
    return rows.map(r => ({
      source: r.source, metric: r.metric,
      timestamp: r.ts?.toISOString?.() || r.ts, value: Number(r.value),
    }));
  }

  // Bucketed series for many (source, metric) pairs at once; per bucket the
  // aggregates a gauge (avg), a daily counter (max) or a cumulative counter
  // (last) needs. Index-only range scan per pair.
  async function bucketedSeries({ pairs, from, to, bucketSeconds }) {
    const wanted = (pairs || []).filter(p => p && p.source && p.metric);
    if (wanted.length === 0) return [];
    const step = Math.max(60, Number(bucketSeconds) || 300);
    const { rows } = await pool.query(
      `SELECT r.source, r.metric,
              extract(epoch from date_bin(make_interval(secs => $5), r.ts, TIMESTAMPTZ '2000-01-01'))::bigint AS bucket,
              avg(r.value) AS avg, max(r.value) AS max,
              (array_agg(r.value ORDER BY r.ts DESC))[1] AS last,
              count(r.value)::int AS count
         FROM unnest($1::text[], $2::text[]) AS q(source, metric)
         JOIN raw_measurements r ON r.source = q.source AND r.metric = q.metric
        WHERE r.ts >= $3 AND r.ts < $4 AND r.is_missing = FALSE AND r.value IS NOT NULL
        GROUP BY r.source, r.metric, 3
        ORDER BY 3 ASC`,
      [wanted.map(p => p.source), wanted.map(p => p.metric), from, to, step],
    );
    return rows.map(r => ({
      source: r.source, metric: r.metric, bucket: Number(r.bucket),
      avg: Number(r.avg), max: Number(r.max), last: Number(r.last), count: Number(r.count),
    }));
  }

  /* ── Leadership (two prediction replicas, one scheduler) ──────────────────
   * A session-level advisory lock on a dedicated pooled client is the leader
   * badge. PostgreSQL releases it the moment the holder's connection dies, so
   * a crashed or rescheduled leader is replaced at the next attempt without
   * any coordination code. */
  let lockClient = null;

  async function tryAcquireLeadership(name = 'prediction-scheduler') {
    if (lockClient) return true;
    const client = await pool.connect();
    try {
      const { rows } = await client.query({ text: 'SELECT pg_try_advisory_lock(hashtext($1)) AS held', values: [name], query_timeout: 5_000 });
      if (!rows[0]?.held) {
        client.release();
        return false;
      }
      lockClient = client;
      client.once('error', () => {
        // Connection gone: the lock is gone with it.
        if (lockClient === client) lockClient = null;
        try { client.release(new Error('leadership connection lost')); } catch { /* already released */ }
      });
      return true;
    } catch (error) {
      client.release(error);
      throw error;
    }
  }

  /** true while the lock connection still answers; false (and releases) otherwise. */
  async function leadershipHeartbeat() {
    if (!lockClient) return false;
    const client = lockClient;
    try {
      await client.query({ text: 'SELECT 1', query_timeout: 5_000 });
      return true;
    } catch (error) {
      if (lockClient === client) lockClient = null;
      try { client.release(error); } catch { /* already released */ }
      return false;
    }
  }

  async function releaseLeadership() {
    const client = lockClient;
    lockClient = null;
    if (!client) return;
    try {
      await client.query({ text: 'SELECT pg_advisory_unlock_all()', query_timeout: 3_000 });
      client.release();
    } catch (error) {
      try { client.release(error); } catch { /* already released */ }
    }
  }

  /* ── Leases for components without their own database access ─────────────
   * The dashboard runs two replicas but only one may post to Slack and record
   * monitor checks; it asks here every check. A lease is held by its holder
   * until ttl seconds pass without renewal. */
  async function renewLease(name, holder, ttlSeconds) {
    const ttl = Math.min(3600, Math.max(5, Number(ttlSeconds) || 180));
    const { rows } = await pool.query(
      `INSERT INTO service_leases (name, holder, expires_at, updated_at)
       VALUES ($1, $2, now() + make_interval(secs => $3), now())
       ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at, updated_at = now()
         WHERE service_leases.holder = EXCLUDED.holder OR service_leases.expires_at < now()
       RETURNING holder, expires_at`,
      [name, holder, ttl],
    );
    if (rows.length) {
      return { name, holder, held: true, expiresAt: rows[0].expires_at?.toISOString?.() || rows[0].expires_at };
    }
    const current = await pool.query('SELECT holder, expires_at FROM service_leases WHERE name = $1', [name]);
    const row = current.rows[0];
    return { name, holder: row?.holder || null, held: false, expiresAt: row?.expires_at?.toISOString?.() || row?.expires_at || null };
  }

  /* ── Monitor checks (SLO evidence) ────────────────────────────────────────
   * One row per dashboard health check; summarised over a window for the
   * operational SLO panel. Small table, pruned by the scheduler leader. */
  async function appendMonitorCheck(check) {
    await pool.query(
      `INSERT INTO monitor_checks (checked_at, holder, healthy, prediction_ok, prediction_ms, blockchain_ok, blockchain_ms, database_ok, database_ms, problems, data_age)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [check.checkedAt || new Date().toISOString(), check.holder || null, Boolean(check.healthy),
       check.predictionOk ?? null, check.predictionMs ?? null, check.blockchainOk ?? null, check.blockchainMs ?? null,
       check.databaseOk ?? null, check.databaseMs ?? null,
       JSON.stringify(check.problems || []), JSON.stringify(check.dataAge || {})],
    );
  }

  async function monitorSummary(days = 30) {
    const window = Math.min(365, Math.max(1, Number(days) || 30));
    const { rows } = await pool.query(
      `WITH w AS (SELECT * FROM monitor_checks WHERE checked_at > now() - make_interval(days => $1))
       SELECT count(*)::int AS checks,
              min(checked_at) AS first_at, max(checked_at) AS last_at,
              count(*) FILTER (WHERE healthy)::int AS healthy,
              count(*) FILTER (WHERE prediction_ok)::int AS prediction_ok, count(prediction_ok)::int AS prediction_total,
              count(*) FILTER (WHERE blockchain_ok)::int AS blockchain_ok, count(blockchain_ok)::int AS blockchain_total,
              count(*) FILTER (WHERE database_ok)::int AS database_ok, count(database_ok)::int AS database_total,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY prediction_ms) AS prediction_p95_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY database_ms) AS database_p95_ms,
              count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(problems) p WHERE p LIKE 'data.stale:%'))::int AS data_fresh
         FROM w`,
      [window],
    );
    const problems = await pool.query(
      `SELECT p AS key, count(*)::int AS checks
         FROM monitor_checks, jsonb_array_elements_text(problems) p
        WHERE checked_at > now() - make_interval(days => $1)
        GROUP BY p ORDER BY checks DESC LIMIT 20`,
      [window],
    );
    const top = rows[0] || {};
    const iso = (v) => v?.toISOString?.() || v || null;
    return {
      days: window,
      checks: Number(top.checks || 0),
      firstCheckAt: iso(top.first_at),
      lastCheckAt: iso(top.last_at),
      healthy: Number(top.healthy || 0),
      dataFresh: Number(top.data_fresh || 0),
      components: {
        prediction: { ok: Number(top.prediction_ok || 0), total: Number(top.prediction_total || 0), p95Ms: top.prediction_p95_ms === null ? null : Number(top.prediction_p95_ms) },
        blockchain: { ok: Number(top.blockchain_ok || 0), total: Number(top.blockchain_total || 0) },
        database: { ok: Number(top.database_ok || 0), total: Number(top.database_total || 0), p95Ms: top.database_p95_ms === null ? null : Number(top.database_p95_ms) },
      },
      problems: problems.rows.map(r => ({ key: r.key, checks: Number(r.checks) })),
    };
  }

  async function pruneMonitorChecks(days = 90) {
    const { rowCount } = await pool.query('DELETE FROM monitor_checks WHERE checked_at < now() - make_interval(days => $1)', [Math.max(7, Number(days) || 90)]);
    return { deleted: rowCount };
  }

  /* ── Feed requests (Mars2's pulls of the vendor plants) ───────────────────
   * One row per /feed call. Mars2 reaches whichever replica the proxy picks,
   * so the "last poll" that /freshness reports and the mars2.poll.silent
   * alert evaluates must be shared state, not a per-process counter. */
  async function appendFeedRequest(entry) {
    await pool.query({
      text: `INSERT INTO feed_requests (requested_at, replica, path, sn, ok, status, client_ip, user_agent)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      values: [entry.requestedAt || new Date().toISOString(), entry.replica || null, String(entry.path || ''), entry.sn || null,
        Boolean(entry.ok), Number.isFinite(Number(entry.status)) ? Number(entry.status) : null,
        entry.clientIp || null, entry.userAgent || null],
      query_timeout: 5_000,
    });
  }

  /** Totals over the retained window plus the newest `recent` calls (who, what, result). */
  async function feedRequestSummary({ recent = 10 } = {}) {
    const limit = Math.min(100, Math.max(1, Number(recent) || 10));
    const iso = (v) => v?.toISOString?.() || v || null;
    const [totals, lastOk, rows] = await Promise.all([
      pool.query({
        text: `SELECT count(*)::int AS total,
                      count(*) FILTER (WHERE ok)::int AS accepted,
                      count(*) FILTER (WHERE NOT ok)::int AS auth_failures,
                      max(requested_at) FILTER (WHERE ok) AS last_ok_at,
                      max(requested_at) FILTER (WHERE NOT ok) AS last_failure_at
                 FROM feed_requests`,
        query_timeout: 5_000,
      }),
      pool.query({ text: 'SELECT path, sn FROM feed_requests WHERE ok ORDER BY requested_at DESC LIMIT 1', query_timeout: 5_000 }),
      pool.query({
        text: `SELECT requested_at, replica, path, sn, ok, status, client_ip, user_agent
                 FROM feed_requests ORDER BY requested_at DESC LIMIT $1`,
        values: [limit],
        query_timeout: 5_000,
      }),
    ]);
    const t = totals.rows[0] || {};
    return {
      requestsTotal: Number(t.total || 0),
      accepted: Number(t.accepted || 0),
      authFailures: Number(t.auth_failures || 0),
      lastRequestAt: iso(t.last_ok_at),
      lastAuthFailureAt: iso(t.last_failure_at),
      lastRequestPath: lastOk.rows[0]?.path || null,
      lastRequestSn: lastOk.rows[0]?.sn || null,
      recent: rows.rows.map(r => ({
        at: iso(r.requested_at), replica: r.replica, path: r.path, sn: r.sn, ok: r.ok,
        status: r.status === null ? null : Number(r.status), clientIp: r.client_ip, userAgent: r.user_agent,
      })),
    };
  }

  async function pruneFeedRequests(days = 30) {
    const { rowCount } = await pool.query('DELETE FROM feed_requests WHERE requested_at < now() - make_interval(days => $1)', [Math.max(7, Number(days) || 30)]);
    return { deleted: rowCount };
  }

  return {
    init, append, list, latest, listPaginated, listDataQualityWindow, checkpoint, setMeta, read, write, stats, prune,
    persistRawRecords, listRawMeasurements, rawMeasurementsStats, pruneRawMeasurements, sourceLabels, listKnownSources,
    ping, latestMeasurementTimestamps,
    listFeedInventory, distinctMetricsForSource, latestSamples, bucketedSeries,
    tryAcquireLeadership, leadershipHeartbeat, releaseLeadership,
    renewLease, appendMonitorCheck, monitorSummary, pruneMonitorChecks,
    appendFeedRequest, feedRequestSummary, pruneFeedRequests,
    file: 'postgres',
  };
}

module.exports = { createPgPredictionStore };
