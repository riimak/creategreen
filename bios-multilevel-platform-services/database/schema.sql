-- BIOS Multi-level Platform: PostgreSQL schema
-- Deployed into its own namespace (e.g. database) and accessed by
-- the prediction + blockchain services via DATABASE_URL.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Prediction service tables

CREATE TABLE IF NOT EXISTS forecasts (
  id            TEXT PRIMARY KEY DEFAULT 'forecast-' || extract(epoch from now())::bigint || '-' || substr(gen_random_uuid()::text, 1, 8),
  source        TEXT NOT NULL,
  metric        TEXT NOT NULL,
  model         TEXT,
  residual_error DOUBLE PRECISION,
  sigma         DOUBLE PRECISION,
  horizon_hours INTEGER,
  train_size    INTEGER,
  holdout_size  INTEGER,
  input_from    BIGINT,
  input_to      BIGINT,
  input_count   INTEGER,
  points        JSONB,
  model_comparisons JSONB,
  metric_info   JSONB,
  input_source  JSONB,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forecasts_source_metric ON forecasts (source, metric, computed_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecasts_computed ON forecasts (computed_at DESC);

CREATE TABLE IF NOT EXISTS anomalies (
  id            TEXT PRIMARY KEY DEFAULT 'anomalies-' || extract(epoch from now())::bigint || '-' || substr(gen_random_uuid()::text, 1, 8),
  source        TEXT NOT NULL,
  metric        TEXT NOT NULL,
  anomaly_count INTEGER NOT NULL DEFAULT 0,
  anomaly_data  JSONB,
  metric_info   JSONB,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_anomalies_source_metric ON anomalies (source, metric, computed_at DESC);

CREATE TABLE IF NOT EXISTS data_quality (
  id            TEXT PRIMARY KEY DEFAULT 'quality-' || extract(epoch from now())::bigint || '-' || substr(gen_random_uuid()::text, 1, 8),
  source        TEXT NOT NULL,
  metric        TEXT NOT NULL,
  status        TEXT NOT NULL,
  reasons       TEXT[],
  input         JSONB,
  input_source  JSONB,
  metric_info   JSONB,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quality_source_metric ON data_quality (source, metric, computed_at DESC);

CREATE TABLE IF NOT EXISTS prediction_runs (
  id            TEXT PRIMARY KEY,
  reason        TEXT,
  status        TEXT,
  results       JSONB,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prediction_checkpoints (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Blockchain service tables

CREATE TABLE IF NOT EXISTS blockchain_events (
  id            TEXT PRIMARY KEY,
  event_code    INTEGER,
  event_name    TEXT,
  source_id     INTEGER,
  metric_code   INTEGER,
  status_code   INTEGER,
  value         DOUBLE PRECISION,
  timestamp_val BIGINT,
  payload_hex   TEXT,
  payload_hash  TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',
  tx_id         TEXT,
  block_hash    TEXT,
  confirmations INTEGER DEFAULT 0,
  relay_mode    TEXT,
  relay_status  TEXT,
  relay_reason  TEXT,
  source_kind   TEXT,
  source_ref    TEXT,
  dedupe_key    TEXT UNIQUE,
  retry_counter INTEGER DEFAULT 0,
  last_error    TEXT,
  submitted_at  TIMESTAMPTZ,
  confirmed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bc_events_status ON blockchain_events (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bc_events_tx ON blockchain_events (tx_id) WHERE tx_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bc_events_created ON blockchain_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bc_events_source_kind ON blockchain_events (source_kind, created_at DESC);

CREATE TABLE IF NOT EXISTS blockchain_checkpoints (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Aggregate views for dashboard stats

CREATE OR REPLACE VIEW prediction_stats AS
SELECT
  count(*)                                          AS total_forecasts,
  count(DISTINCT source || ':' || metric)            AS unique_metrics,
  count(DISTINCT source)                             AS unique_stations,
  min(computed_at)                                   AS first_forecast,
  max(computed_at)                                   AS last_forecast,
  count(*) FILTER (WHERE computed_at > now() - interval '24 hours') AS forecasts_24h,
  count(*) FILTER (WHERE computed_at > now() - interval '7 days')   AS forecasts_7d,
  count(*) FILTER (WHERE computed_at > now() - interval '30 days')  AS forecasts_30d
FROM forecasts;

CREATE OR REPLACE VIEW blockchain_stats AS
SELECT
  count(*)                                          AS total_events,
  count(*) FILTER (WHERE status = 'confirmed')       AS confirmed,
  count(*) FILTER (WHERE status = 'sent')            AS sent,
  count(*) FILTER (WHERE status = 'failed')          AS failed,
  count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS events_24h,
  count(*) FILTER (WHERE created_at > now() - interval '7 days')   AS events_7d,
  count(*) FILTER (WHERE created_at > now() - interval '30 days')  AS events_30d,
  min(created_at)                                   AS first_event,
  max(created_at)                                   AS last_event
FROM blockchain_events;

-- Retention: call periodically to prune old records.
-- Default: keep 90 days of forecasts/anomalies/quality, 180 days of blockchain events.
CREATE OR REPLACE FUNCTION prune_old_records(
  forecast_days INTEGER DEFAULT 90,
  blockchain_days INTEGER DEFAULT 180
) RETURNS TABLE(pruned_forecasts BIGINT, pruned_anomalies BIGINT, pruned_quality BIGINT, pruned_events BIGINT) AS $$
BEGIN
  DELETE FROM forecasts WHERE computed_at < now() - make_interval(days => forecast_days);
  GET DIAGNOSTICS pruned_forecasts = ROW_COUNT;
  DELETE FROM anomalies WHERE computed_at < now() - make_interval(days => forecast_days);
  GET DIAGNOSTICS pruned_anomalies = ROW_COUNT;
  DELETE FROM data_quality WHERE computed_at < now() - make_interval(days => forecast_days);
  GET DIAGNOSTICS pruned_quality = ROW_COUNT;
  DELETE FROM blockchain_events WHERE created_at < now() - make_interval(days => blockchain_days);
  GET DIAGNOSTICS pruned_events = ROW_COUNT;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
