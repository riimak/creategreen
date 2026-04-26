const { Pool } = require('pg');

function createPgPredictionStore(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

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

  return { init, append, list, latest, checkpoint, setMeta, read, write, stats, prune, file: 'postgres' };
}

module.exports = { createPgPredictionStore };
