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

-- Mars2 raw measurements (long-term historical store).
-- Tall layout: one row per (source, metric, timestamp) so the dashboard can
-- filter by metric without unpacking JSON. Backfill plus ongoing cycle inserts
-- both write here via INSERT ... ON CONFLICT DO UPDATE on the natural key.
CREATE TABLE IF NOT EXISTS raw_measurements (
  source        TEXT NOT NULL,
  metric        TEXT NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  value         DOUBLE PRECISION,
  is_missing    BOOLEAN NOT NULL DEFAULT FALSE,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, metric, ts)
);

CREATE INDEX IF NOT EXISTS idx_raw_measurements_ts ON raw_measurements (ts DESC);
CREATE INDEX IF NOT EXISTS idx_raw_measurements_source_metric_ts ON raw_measurements (source, metric, ts DESC);
CREATE INDEX IF NOT EXISTS idx_raw_measurements_ingested ON raw_measurements (ingested_at DESC);

CREATE OR REPLACE VIEW raw_measurements_stats AS
SELECT
  count(*)                                  AS total_rows,
  count(DISTINCT source)                    AS unique_sources,
  count(DISTINCT metric)                    AS unique_metrics,
  min(ts)                                   AS earliest,
  max(ts)                                   AS latest,
  count(*) FILTER (WHERE value IS NULL)     AS missing_rows,
  count(*) FILTER (WHERE ts > now() - interval '24 hours') AS rows_24h,
  count(*) FILTER (WHERE ts > now() - interval '7 days')   AS rows_7d
FROM raw_measurements;

-- FusionSolar OAuth, inventory, and synchronization state.

CREATE TABLE IF NOT EXISTS fusionsolar_oauth_credentials (
  id                     TEXT PRIMARY KEY DEFAULT 'active',
  encrypted_access_token JSONB,
  encrypted_refresh_token JSONB,
  access_expires_at      TIMESTAMPTZ,
  granted_scopes         TEXT[] NOT NULL DEFAULT '{}',
  token_type             TEXT,
  state                  TEXT NOT NULL DEFAULT 'not_authorized',
  last_error             TEXT,
  authorized_at          TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fusionsolar_oauth_nonces (
  nonce_hash       TEXT PRIMARY KEY,
  expires_at       TIMESTAMPTZ NOT NULL,
  consumed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fusionsolar_setup_tokens (
  token_hash       TEXT PRIMARY KEY,
  consumed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fusionsolar_plants (
  plant_code       TEXT PRIMARY KEY,
  source_key       TEXT NOT NULL UNIQUE,
  display_name     TEXT,
  timezone         TEXT,
  visible          BOOLEAN NOT NULL DEFAULT TRUE,
  metadata         JSONB NOT NULL DEFAULT '{}',
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fusionsolar_devices (
  device_id        TEXT PRIMARY KEY,
  plant_code       TEXT NOT NULL REFERENCES fusionsolar_plants(plant_code) ON DELETE CASCADE,
  device_type      TEXT,
  model            TEXT,
  serial_number    TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}',
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fusionsolar_devices_plant
  ON fusionsolar_devices (plant_code);

CREATE TABLE IF NOT EXISTS fusionsolar_sync_state (
  sync_key         TEXT PRIMARY KEY,
  checkpoint       JSONB NOT NULL DEFAULT '{}',
  backoff_until    TIMESTAMPTZ,
  last_success_at  TIMESTAMPTZ,
  last_error       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
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
-- raw_measurements is NOT pruned by this function; it has its own optional pruner
-- driven by RAW_MEASUREMENTS_RETENTION_DAYS in the prediction service (default: off).
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

-- Optional pruner for raw_measurements; called from the prediction service when
-- RAW_MEASUREMENTS_RETENTION_DAYS is set (off by default to preserve backfill).
CREATE OR REPLACE FUNCTION prune_raw_measurements(retention_days INTEGER)
RETURNS BIGINT AS $$
DECLARE deleted BIGINT;
BEGIN
  DELETE FROM raw_measurements WHERE ts < now() - make_interval(days => retention_days);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;
