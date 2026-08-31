const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../server');
const { createIntegration } = require('../integration');
const { loadConfig, configurationState } = require('../config');

async function withServer(integration, run) {
  const server = createServer({ integration });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health endpoint responds without configuration', async () => {
  const integration = createIntegration({ config: loadConfig({}) });
  await withServer(integration, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true, service: 'soliscloud' });
  });
});

test('status reports not_configured without credentials', async () => {
  const integration = createIntegration({ config: loadConfig({}) });
  await withServer(integration, async (base) => {
    const res = await fetch(`${base}/status`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.state, 'not_configured');
    assert.strictEqual(body.configured, false);
  });
});

test('unknown routes return 404', async () => {
  const integration = createIntegration({ config: loadConfig({}) });
  await withServer(integration, async (base) => {
    const res = await fetch(`${base}/v1/api/anything`);
    assert.strictEqual(res.status, 404);
  });
});

test('configuration state requires credentials and a database URL', () => {
  const full = {
    SOLISCLOUD_KEY_ID: 'id',
    SOLISCLOUD_KEY_SECRET: 'secret',
    DATABASE_URL: 'postgres://example/db',
  };
  // The API base URL has a production default, so it is not required.
  assert.strictEqual(configurationState(loadConfig(full)), 'configured');
  for (const key of Object.keys(full)) {
    const partial = { ...full };
    delete partial[key];
    assert.strictEqual(configurationState(loadConfig(partial)), 'not_configured', `missing ${key}`);
  }
});

test('config strips trailing slashes from the API base URL', () => {
  const config = loadConfig({ SOLISCLOUD_API_BASE_URL: 'https://example.test:13333///' });
  assert.strictEqual(config.apiBaseUrl, 'https://example.test:13333');
});

test('config parses the station allowlist', () => {
  assert.strictEqual(loadConfig({}).stationIds, null);
  assert.strictEqual(loadConfig({ SOLISCLOUD_STATION_IDS: '  ' }).stationIds, null);
  assert.deepStrictEqual(
    loadConfig({ SOLISCLOUD_STATION_IDS: '129,  456 ,,' }).stationIds,
    ['129', '456'],
  );
});
