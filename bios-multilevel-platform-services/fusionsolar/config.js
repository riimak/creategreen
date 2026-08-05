function positiveInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const PRODUCTION_REDIRECT_URI = 'https://bios-multilevel.barrage.net/oauth/fusionsolar/callback';
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function encryptionKey(raw) {
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (!CANONICAL_BASE64.test(raw) || key.toString('base64') !== raw || key.length !== 32) {
    throw new Error('FUSIONSOLAR_TOKEN_ENCRYPTION_KEY must be canonical base64 encoding of exactly 32 bytes');
  }
  return key;
}

function loadConfig(env = process.env) {
  return Object.freeze({
    port: positiveInt(env.FUSIONSOLAR_PORT, 8093, 'FUSIONSOLAR_PORT'),
    clientId: env.FUSIONSOLAR_CLIENT_ID || '',
    clientSecret: env.FUSIONSOLAR_CLIENT_SECRET || '',
    redirectUri: env.FUSIONSOLAR_REDIRECT_URI || '',
    setupToken: env.FUSIONSOLAR_SETUP_TOKEN || '',
    tokenEncryptionKey: encryptionKey(env.FUSIONSOLAR_TOKEN_ENCRYPTION_KEY),
    oauthBaseUrl: env.FUSIONSOLAR_OAUTH_BASE_URL || 'https://oauth2.fusionsolar.huawei.com',
    apiBaseUrl: env.FUSIONSOLAR_API_BASE_URL || '',
    databaseUrl: env.DATABASE_URL || '',
    liveIntervalMs: positiveInt(env.FUSIONSOLAR_LIVE_INTERVAL_SECONDS, 300, 'FUSIONSOLAR_LIVE_INTERVAL_SECONDS') * 1000,
    inventoryIntervalMs: positiveInt(env.FUSIONSOLAR_INVENTORY_INTERVAL_SECONDS, 3600, 'FUSIONSOLAR_INVENTORY_INTERVAL_SECONDS') * 1000,
    requestTimeoutMs: positiveInt(env.FUSIONSOLAR_REQUEST_TIMEOUT_SECONDS, 20, 'FUSIONSOLAR_REQUEST_TIMEOUT_SECONDS') * 1000,
    backfillEnabled: env.FUSIONSOLAR_BACKFILL_ENABLED !== 'false',
  });
}

function configurationState(config) {
  return config.clientId && config.clientSecret && config.redirectUri === PRODUCTION_REDIRECT_URI
    && config.setupToken && config.tokenEncryptionKey
    && config.apiBaseUrl && config.databaseUrl
    ? 'configured'
    : 'not_configured';
}

module.exports = { loadConfig, configurationState };
