const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const { createIntegration } = require('../integration');

const SETUP_TOKEN = 'bootstrap-secret-that-must-never-be-disclosed';

function configured(overrides = {}) {
  return {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://bios-multilevel.barrage.net/oauth/fusionsolar/callback',
    setupToken: SETUP_TOKEN,
    tokenEncryptionKey: Buffer.alloc(32, 1),
    apiBaseUrl: 'https://region.example.com',
    oauthBaseUrl: 'https://oauth.example.com',
    databaseUrl: 'postgresql://example',
    liveIntervalMs: 300_000,
    backfillEnabled: true,
    ...overrides,
  };
}

function dependencies(overrides = {}) {
  const calls = [];
  const store = {
    async isSetupTokenConsumed() { return false; },
    async consumeSetupToken() { calls.push('consume-setup'); },
    async loadCredentials() { return null; },
    async status() {
      return {
        state: 'not_authorized',
        scopes: [],
        lastError: null,
        lastSuccessAt: null,
        backfill: null,
        encrypted_access_token: { ciphertext: 'must-not-escape' },
        refreshToken: 'must-not-escape',
        plantCode: 'secret-identifier',
      };
    },
    async close() {},
  };
  const stateManager = {
    async issue() {
      calls.push('issue');
      return 'signed-state';
    },
    async verifyAndConsume() {
      calls.push('verify');
      return true;
    },
  };
  const client = {
    authorizationUrl(state) {
      calls.push(`authorize:${state}`);
      return `https://oauth.example.com/authorize?state=${state}`;
    },
    async exchangeCode() {
      calls.push('exchange');
      return { scopes: ['pvms.openapi.basic'], accessToken: 'access-secret' };
    },
  };
  const synchronizer = {
    async runLiveCycle() {},
    async runBackfillStep() {},
  };
  return {
    calls,
    store,
    stateManager,
    client,
    synchronizer,
    ...overrides,
  };
}

async function startServer(t, integration) {
  const server = createServer({ config: { port: 0 }, integration });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('OAuth start hides missing and incorrect setup tokens with 404', async (t) => {
  const deps = dependencies();
  const integration = createIntegration({ config: configured(), ...deps });
  const baseUrl = await startServer(t, integration);

  for (const query of ['', '?setup_token=wrong']) {
    const response = await fetch(`${baseUrl}/oauth/fusionsolar/start${query}`, {
      redirect: 'manual',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not found' });
  }
  assert.deepEqual(deps.calls, []);
});

test('OAuth start redirects valid bootstrap requests without caching or referrers', async (t) => {
  const deps = dependencies();
  const integration = createIntegration({ config: configured(), ...deps });
  const baseUrl = await startServer(t, integration);

  const response = await fetch(
    `${baseUrl}/oauth/fusionsolar/start?setup_token=${encodeURIComponent(SETUP_TOKEN)}`,
    { redirect: 'manual' },
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://oauth.example.com/authorize?state=signed-state');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(deps.calls, ['issue', 'authorize:signed-state']);
});

test('OAuth callback consumes state before handling Huawei errors and returns generic HTML', async (t) => {
  const reflected = 'owner-cancelled-secret-description';
  const deps = dependencies();
  const integration = createIntegration({ config: configured(), ...deps });
  const baseUrl = await startServer(t, integration);

  const response = await fetch(
    `${baseUrl}/oauth/fusionsolar/callback?error=access_denied`
      + `&error_description=${encodeURIComponent(reflected)}&state=signed-state`,
  );
  const body = await response.text();

  assert.equal(response.status, 400);
  assert.deepEqual(deps.calls, ['verify']);
  assert.equal(body.includes(reflected), false);
  assert.equal(body.includes('access_denied'), false);
  assert.equal(body.includes('signed-state'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(
    response.headers.get('content-security-policy'),
    "default-src 'none'; style-src 'unsafe-inline'",
  );
});

test('OAuth callback verifies state before code exchange and consumes bootstrap token on success', async (t) => {
  const code = 'short-lived-secret-code';
  const deps = dependencies();
  const integration = createIntegration({ config: configured(), ...deps });
  const baseUrl = await startServer(t, integration);

  const response = await fetch(
    `${baseUrl}/oauth/fusionsolar/callback?code=${encodeURIComponent(code)}&state=signed-state`,
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.deepEqual(deps.calls, ['verify', 'exchange', 'consume-setup']);
  assert.equal(body.includes(code), false);
  assert.equal(body.includes('access-secret'), false);
  assert.match(body, /authorization completed/);
});

test('consumed bootstrap token remains unusable until configuration rotates it', async (t) => {
  const deps = dependencies();
  deps.store.isSetupTokenConsumed = async () => true;
  const integration = createIntegration({ config: configured(), ...deps });
  const baseUrl = await startServer(t, integration);

  const response = await fetch(
    `${baseUrl}/oauth/fusionsolar/start?setup_token=${encodeURIComponent(SETUP_TOKEN)}`,
    { redirect: 'manual' },
  );

  assert.equal(response.status, 404);
  assert.deepEqual(deps.calls, []);
});

test('status exposes only sanitized integration state', async (t) => {
  const deps = dependencies();
  const integration = createIntegration({ config: configured(), ...deps });
  const baseUrl = await startServer(t, integration);

  const response = await fetch(`${baseUrl}/status`);
  const status = await response.json();
  const serialized = JSON.stringify(status);

  assert.deepEqual(status, {
    state: 'not_authorized',
    configured: true,
    authorized: false,
    grantedScopes: [],
    lastSyncAt: null,
    backfill: null,
    lastError: null,
  });
  assert.equal(/ciphertext|refreshToken|plantCode|identifier/i.test(serialized), false);
});
