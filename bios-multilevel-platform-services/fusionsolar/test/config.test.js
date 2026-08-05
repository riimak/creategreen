const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, configurationState } = require('../config');

const REDIRECT_URI = 'https://bios-multilevel.barrage.net/oauth/fusionsolar/callback';

function configuredEnv() {
  return {
    DATABASE_URL: 'postgresql://bios:bios@postgres/bios',
    FUSIONSOLAR_CLIENT_ID: '123456789',
    FUSIONSOLAR_CLIENT_SECRET: 'secret',
    FUSIONSOLAR_REDIRECT_URI: REDIRECT_URI,
    FUSIONSOLAR_SETUP_TOKEN: 'x'.repeat(48),
    FUSIONSOLAR_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    FUSIONSOLAR_OAUTH_BASE_URL: 'https://oauth2.fusionsolar.huawei.com',
    FUSIONSOLAR_API_BASE_URL: 'https://region.example.com',
  };
}

test('loads conservative defaults and reports missing secrets', () => {
  const config = loadConfig({});
  assert.equal(config.port, 8093);
  assert.equal(config.liveIntervalMs, 5 * 60_000);
  assert.equal(config.requestTimeoutMs, 20_000);
  assert.equal(config.backfillEnabled, true);
  assert.equal(configurationState(config), 'not_configured');
});

test('requires an exact 32-byte base64 encryption key when configured', () => {
  const env = configuredEnv();
  assert.equal(configurationState(loadConfig(env)), 'configured');
  assert.throws(
    () => loadConfig({ ...env, FUSIONSOLAR_TOKEN_ENCRYPTION_KEY: 'bad' }),
    /32 bytes/,
  );
});

test('rejects non-canonical base64 encryption keys', () => {
  const env = configuredEnv();
  const canonical = env.FUSIONSOLAR_TOKEN_ENCRYPTION_KEY;

  assert.throws(
    () => loadConfig({ ...env, FUSIONSOLAR_TOKEN_ENCRYPTION_KEY: `${canonical.slice(0, 8)}!${canonical.slice(8)}` }),
    /canonical base64/,
  );
  assert.throws(
    () => loadConfig({ ...env, FUSIONSOLAR_TOKEN_ENCRYPTION_KEY: canonical.replace(/=$/, '') }),
    /canonical base64/,
  );
});

test('requires the production redirect URI to report configured', () => {
  const config = loadConfig({
    ...configuredEnv(),
    FUSIONSOLAR_REDIRECT_URI: 'https://example.com/oauth/fusionsolar/callback',
  });

  assert.equal(configurationState(config), 'not_configured');
});

test('setup token is optional for core runtime configuration after bootstrap', () => {
  const config = loadConfig({
    ...configuredEnv(),
    FUSIONSOLAR_SETUP_TOKEN: '',
  });

  assert.equal(config.setupToken, '');
  assert.equal(configurationState(config), 'configured');
});
