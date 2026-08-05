const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
    async saveCredentialsIfSetupUnused(setupTokenHash) {
      calls.push(`save-if-unused:${setupTokenHash}`);
      return true;
    },
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
    async issue(setupTokenHash) {
      calls.push(`issue:${setupTokenHash}`);
      return 'signed-state';
    },
    async verifyAndConsume() {
      calls.push('verify');
      return crypto.createHash('sha256').update(SETUP_TOKEN).digest('hex');
    },
  };
  const client = {
    authorizationUrl(state) {
      calls.push(`authorize:${state}`);
      return `https://oauth.example.com/authorize?state=${state}`;
    },
    async exchangeCode(_code, options = {}) {
      calls.push(`exchange:${options.persist}`);
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

test('OAuth start remains unavailable after the bootstrap token is removed', async (t) => {
  const deps = dependencies();
  const integration = createIntegration({
    config: configured({ setupToken: '' }),
    ...deps,
  });
  const baseUrl = await startServer(t, integration);

  for (const query of ['', `?setup_token=${encodeURIComponent(SETUP_TOKEN)}`]) {
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
  assert.deepEqual(deps.calls, [
    `issue:${crypto.createHash('sha256').update(SETUP_TOKEN).digest('hex')}`,
    'authorize:signed-state',
  ]);
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
  assert.deepEqual(deps.calls, [
    'verify',
    'exchange:false',
    `save-if-unused:${crypto.createHash('sha256').update(SETUP_TOKEN).digest('hex')}`,
  ]);
  assert.equal(body.includes(code), false);
  assert.equal(body.includes('access-secret'), false);
  assert.match(body, /authorization completed/);
});

test('OAuth callback generically rejects a second completion that loses setup claim', async (t) => {
  const deps = dependencies();
  deps.store.saveCredentialsIfSetupUnused = async () => {
    deps.calls.push('save-if-unused:rejected');
    return false;
  };
  const integration = createIntegration({ config: configured(), ...deps });
  const baseUrl = await startServer(t, integration);
  const code = 'second-valid-but-losing-code';

  const response = await fetch(
    `${baseUrl}/oauth/fusionsolar/callback?code=${code}&state=second-valid-state`,
  );
  const body = await response.text();

  assert.equal(response.status, 400);
  assert.deepEqual(deps.calls, ['verify', 'exchange:false', 'save-if-unused:rejected']);
  assert.equal(body.includes(code), false);
  assert.equal(body.includes('state'), false);
  assert.match(body, /authorization failed/);
});

test('transient code exchange failure leaves setup token claim available to a fresh state', async () => {
  const deps = dependencies();
  let attempts = 0;
  deps.client.exchangeCode = async (_code, options = {}) => {
    deps.calls.push(`exchange:${options.persist}`);
    attempts += 1;
    if (attempts === 1) throw new Error('transient exchange failure');
    return { scopes: ['pvms.openapi.basic'], accessToken: 'replacement-access' };
  };
  const integration = createIntegration({ config: configured(), ...deps });

  const first = await integration.completeCallback(
    new URLSearchParams({ code: 'first-code', state: 'first-state' }),
  );
  const second = await integration.completeCallback(
    new URLSearchParams({ code: 'second-code', state: 'fresh-state' }),
  );

  assert.deepEqual(first, { ok: false });
  assert.deepEqual(second, { ok: true });
  assert.deepEqual(deps.calls, [
    'verify',
    'exchange:false',
    'verify',
    'exchange:false',
    `save-if-unused:${crypto.createHash('sha256').update(SETUP_TOKEN).digest('hex')}`,
  ]);
});

test('outstanding state claims its issued setup generation after rotation or removal', async () => {
  const oldHash = crypto.createHash('sha256').update('old-setup-token').digest('hex');
  for (const setupToken of ['replacement-setup-token', '']) {
    const deps = dependencies();
    deps.stateManager.verifyAndConsume = async () => {
      deps.calls.push('verify');
      return oldHash;
    };
    const claimed = [];
    deps.store.saveCredentialsIfSetupUnused = async (hash) => {
      claimed.push(hash);
      return true;
    };
    const integration = createIntegration({
      config: configured({ setupToken }),
      ...deps,
    });

    assert.deepEqual(await integration.completeCallback(
      new URLSearchParams({ code: 'issued-before-change', state: 'old-state' }),
    ), { ok: true });
    assert.deepEqual(claimed, [oldHash]);
  }
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
    setupAvailable: true,
    authorized: false,
    grantedScopes: [],
    lastSyncAt: null,
    backfill: null,
    lastError: null,
    counters: {
      cycles: 0,
      huaweiFailures: 0,
      tokenRefreshes: 0,
      rowsIngested: 0,
      skippedFields: 0,
      backfillSteps: 0,
    },
  });
  assert.equal(/ciphertext|refreshToken|plantCode|identifier/i.test(serialized), false);
});
