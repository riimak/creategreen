function positiveInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

// Comma-separated station id allowlist; empty means "ingest every station
// the account can see".
function stationAllowlist(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ids = value.split(',').map((id) => id.trim()).filter(Boolean);
  return ids.length > 0 ? Object.freeze(ids) : null;
}

function loadConfig(env = process.env) {
  return Object.freeze({
    port: positiveInt(env.SOLISCLOUD_PORT, 8094, 'SOLISCLOUD_PORT'),
    keyId: env.SOLISCLOUD_KEY_ID || '',
    keySecret: env.SOLISCLOUD_KEY_SECRET || '',
    apiBaseUrl: (env.SOLISCLOUD_API_BASE_URL || 'https://www.soliscloud.com:13333').replace(/\/+$/, ''),
    databaseUrl: env.DATABASE_URL || '',
    liveIntervalMs: positiveInt(env.SOLISCLOUD_LIVE_INTERVAL_SECONDS, 300, 'SOLISCLOUD_LIVE_INTERVAL_SECONDS') * 1000,
    requestTimeoutMs: positiveInt(env.SOLISCLOUD_REQUEST_TIMEOUT_SECONDS, 20, 'SOLISCLOUD_REQUEST_TIMEOUT_SECONDS') * 1000,
    // SolisCloud limits each endpoint to 2 requests/second; space calls out.
    minRequestSpacingMs: positiveInt(env.SOLISCLOUD_REQUEST_SPACING_MS, 600, 'SOLISCLOUD_REQUEST_SPACING_MS'),
    backfillEnabled: env.SOLISCLOUD_BACKFILL_ENABLED !== 'false',
    backfillDays: positiveInt(env.SOLISCLOUD_BACKFILL_DAYS, 90, 'SOLISCLOUD_BACKFILL_DAYS'),
    backfillStepsPerCycle: positiveInt(env.SOLISCLOUD_BACKFILL_STEPS_PER_CYCLE, 10, 'SOLISCLOUD_BACKFILL_STEPS_PER_CYCLE'),
    stationIds: stationAllowlist(env.SOLISCLOUD_STATION_IDS),
  });
}

function configurationState(config) {
  return config.keyId && config.keySecret && config.apiBaseUrl && config.databaseUrl
    ? 'configured'
    : 'not_configured';
}

module.exports = { loadConfig, configurationState };
