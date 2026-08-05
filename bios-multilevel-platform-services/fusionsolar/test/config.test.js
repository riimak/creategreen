const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, configurationState } = require('../config');

test('loads conservative defaults and reports missing secrets', () => {
  const config = loadConfig({});
  assert.equal(config.port, 8093);
  assert.equal(config.liveIntervalMs, 5 * 60_000);
  assert.equal(config.requestTimeoutMs, 20_000);
  assert.equal(config.backfillEnabled, true);
  assert.equal(configurationState(config), 'not_configured');
});

test('requires an exact 32-byte base64 encryption key when configured', () => {
  const env = {
    DATABASE_URL: 'postgresql://bios:bios@postgres/bios',
    FUSIONSOLAR_CLIENT_ID: '123456789',
    FUSIONSOLAR_CLIENT_SECRET: 'secret',
    FUSIONSOLAR_REDIRECT_URI: 'https://bios-multilevel.barrage.net/oauth/fusionsolar/callback',
    FUSIONSOLAR_SETUP_TOKEN: 'x'.repeat(48),
    FUSIONSOLAR_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    FUSIONSOLAR_OAUTH_BASE_URL: 'https://oauth2.fusionsolar.huawei.com',
    FUSIONSOLAR_API_BASE_URL: 'https://region.example.com',
  };
  assert.equal(configurationState(loadConfig(env)), 'configured');
  assert.throws(
    () => loadConfig({ ...env, FUSIONSOLAR_TOKEN_ENCRYPTION_KEY: 'bad' }),
    /32 bytes/,
  );
});
