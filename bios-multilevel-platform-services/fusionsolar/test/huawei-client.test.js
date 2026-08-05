const test = require('node:test');
const assert = require('node:assert/strict');
const { createHuaweiClient } = require('../huawei-client');

const REQUIRED_SCOPE = 'pvms.openapi.basic';
const NOW = new Date('2026-08-05T10:00:00Z');

function config(overrides = {}) {
  return {
    clientId: 'fixture-client',
    clientSecret: 'fixture-client-secret',
    redirectUri: 'https://bios-multilevel.barrage.net/oauth/fusionsolar/callback',
    oauthBaseUrl: 'https://oauth2.fusionsolar.huawei.com',
    apiBaseUrl: 'https://api.example.test',
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

function memoryStore(credentials = null) {
  return {
    credentials,
    saved: [],
    states: [],
    counters: [],
    async loadCredentials() {
      return this.credentials;
    },
    async saveCredentials(value) {
      this.saved.push(value);
      this.credentials = value;
    },
    async setAuthorizationState(state, message) {
      this.states.push({ state, message });
    },
    async recordCounters(value) {
      this.counters.push(value);
    },
  };
}

function tokenResponse(overrides = {}, status = 200) {
  return new Response(JSON.stringify({
    access_token: 'fixture-access',
    refresh_token: 'fixture-refresh',
    expires_in: 3600,
    scope: REQUIRED_SCOPE,
    token_type: 'Bearer',
    ...overrides,
  }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authorizedCredentials(overrides = {}) {
  return {
    accessToken: 'stored-access',
    refreshToken: 'stored-refresh',
    accessExpiresAt: new Date('2026-08-05T11:00:00Z'),
    scopes: [REQUIRED_SCOPE],
    tokenType: 'Bearer',
    ...overrides,
  };
}

test('authorization URL has the exact path, callback, state, and basic-only scope', () => {
  const client = createHuaweiClient({
    config: config(),
    store: memoryStore(),
    fetchImpl: async () => { throw new Error('not used'); },
    now: () => NOW,
  });

  const url = new URL(client.authorizationUrl('signed-state'));
  assert.equal(url.origin, 'https://oauth2.fusionsolar.huawei.com');
  assert.equal(url.pathname, '/rest/dp/uidm/oauth2/v1/authorize');
  assert.deepEqual([...url.searchParams.keys()].sort(), [
    'client_id',
    'redirect_uri',
    'response_type',
    'scope',
    'state',
  ]);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'fixture-client');
  assert.equal(url.searchParams.get('redirect_uri'), config().redirectUri);
  assert.equal(url.searchParams.get('scope'), REQUIRED_SCOPE);
  assert.equal(url.searchParams.get('state'), 'signed-state');
  assert.doesNotMatch(url.href, /control/);
});

test('code exchange uses the exact token path and form body, then persists normalized credentials', async () => {
  const requests = [];
  const store = memoryStore();
  const client = createHuaweiClient({
    config: config(),
    store,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return tokenResponse();
    },
    now: () => NOW,
  });

  const credentials = await client.exchangeCode('fixture-authorization-code');

  assert.equal(new URL(requests[0].url).pathname, '/rest/dp/uidm/oauth2/v1/token');
  assert.equal(requests[0].options.method, 'POST');
  assert.match(new Headers(requests[0].options.headers).get('content-type'), /application\/x-www-form-urlencoded/);
  const body = new URLSearchParams(requests[0].options.body);
  assert.deepEqual(Object.fromEntries(body), {
    grant_type: 'authorization_code',
    code: 'fixture-authorization-code',
    client_id: 'fixture-client',
    client_secret: 'fixture-client-secret',
    redirect_uri: config().redirectUri,
  });
  assert.deepEqual(credentials, {
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    accessExpiresAt: new Date('2026-08-05T11:00:00Z'),
    scopes: [REQUIRED_SCOPE],
    tokenType: 'Bearer',
  });
  assert.deepEqual(store.saved, [credentials]);
});

test('code exchange can defer persistence to an atomic setup-token claim', async () => {
  const store = memoryStore();
  const client = createHuaweiClient({
    config: config(),
    store,
    fetchImpl: async () => tokenResponse(),
    now: () => NOW,
  });

  const credentials = await client.exchangeCode('fixture-code', { persist: false });

  assert.equal(credentials.accessToken, 'fixture-access');
  assert.deepEqual(store.saved, []);
});

test('token exchange requires Bearer type and the granted basic scope', async () => {
  for (const response of [
    tokenResponse({ token_type: 'MAC' }),
    tokenResponse({ scope: 'pvms.openapi.control' }),
  ]) {
    const store = memoryStore();
    const client = createHuaweiClient({
      config: config(),
      store,
      fetchImpl: async () => response,
      now: () => NOW,
    });
    await assert.rejects(() => client.exchangeCode('fixture-code'), /token response/i);
    assert.equal(store.saved.length, 0);
  }
});

test('refreshes at least sixty seconds early and preserves an omitted refresh token', async () => {
  const store = memoryStore(authorizedCredentials({
    accessExpiresAt: new Date('2026-08-05T10:01:00Z'),
  }));
  let refreshBody;
  const client = createHuaweiClient({
    config: config(),
    store,
    fetchImpl: async (_url, options) => {
      refreshBody = new URLSearchParams(options.body);
      return tokenResponse({ refresh_token: undefined });
    },
    now: () => NOW,
  });

  assert.equal(await client.getAccessToken(), 'fixture-access');
  assert.equal(refreshBody.get('grant_type'), 'refresh_token');
  assert.equal(refreshBody.get('refresh_token'), 'stored-refresh');
  assert.equal(store.saved[0].refreshToken, 'stored-refresh');
  assert.deepEqual(store.counters, [{ tokenRefreshes: 1 }]);
});

test('coalesces concurrent refreshes into one request', async () => {
  const store = memoryStore(authorizedCredentials({
    accessExpiresAt: new Date('2026-08-05T10:00:30Z'),
  }));
  let release;
  let calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const client = createHuaweiClient({
    config: config(),
    store,
    fetchImpl: async () => {
      calls += 1;
      await pending;
      return tokenResponse();
    },
    now: () => NOW,
  });

  const first = client.getAccessToken();
  const second = client.getAccessToken();
  release();
  assert.deepEqual(await Promise.all([first, second]), ['fixture-access', 'fixture-access']);
  assert.equal(calls, 1);
  assert.equal(store.saved.length, 1);
});

test('an API 401 forces one refresh and retries once with the replacement token', async () => {
  const store = memoryStore(authorizedCredentials());
  const calls = [];
  const client = createHuaweiClient({
    config: config(),
    store,
    fetchImpl: async (url, options) => {
      const request = { path: new URL(url).pathname, authorization: new Headers(options.headers).get('authorization') };
      calls.push(request);
      if (request.path.includes('/token')) return tokenResponse({ access_token: 'replacement-access' });
      if (request.authorization === 'Bearer stored-access') return new Response('', { status: 401 });
      return new Response('{"ok":true}', { status: 200 });
    },
    now: () => NOW,
  });

  const response = await client.request('/rest/openapi/pvms/v1/plants?secret_query=hidden');
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(({ authorization }) => authorization), [
    'Bearer stored-access',
    null,
    'Bearer replacement-access',
  ]);
});

test('honors Retry-After once before retrying a throttled API request', async () => {
  const sleeps = [];
  let calls = 0;
  const client = createHuaweiClient({
    config: config(),
    store: memoryStore(authorizedCredentials()),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
      return new Response('{"ok":true}', { status: 200 });
    },
    now: () => NOW,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  assert.equal((await client.request('/rest/openapi/pvms/v1/plants')).status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('uses documented sixty-second fallback for 429 without Retry-After', async () => {
  const sleeps = [];
  const client = createHuaweiClient({
    config: config(),
    store: memoryStore(authorizedCredentials()),
    fetchImpl: async () => new Response('', { status: 429 }),
    now: () => NOW,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  await assert.rejects(
    client.request('/rest/openapi/pvms/v1/plants'),
    (error) => error.status === 429 && error.retryAfterMs === 60_000,
  );
  assert.deepEqual(sleeps, [60_000]);
});

test('keeps the short fallback for 5xx without Retry-After', async () => {
  const sleeps = [];
  const client = createHuaweiClient({
    config: config(),
    store: memoryStore(authorizedCredentials()),
    fetchImpl: async () => new Response('', { status: 503 }),
    now: () => NOW,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  await assert.rejects(
    client.request('/rest/openapi/pvms/v1/plants'),
    (error) => error.status === 503 && error.retryAfterMs === 1000,
  );
  assert.deepEqual(sleeps, [1000]);
});

test('exposes sanitized retry metadata after repeated API throttling', async () => {
  const client = createHuaweiClient({
    config: config(),
    store: memoryStore(authorizedCredentials()),
    fetchImpl: async () => new Response('', {
      status: 429,
      headers: { 'Retry-After': '90' },
    }),
    now: () => NOW,
    sleep: async () => {},
  });

  await assert.rejects(
    client.request('/rest/openapi/pvms/nbi/v1/device/history'),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 90_000);
      assert.equal(error.permanent, false);
      assert.doesNotMatch(error.message, /access|refresh|secret/i);
      return true;
    },
  );
});

test('can disable transient retries for one-call backfill steps', async () => {
  let calls = 0;
  const client = createHuaweiClient({
    config: config(),
    store: memoryStore(authorizedCredentials()),
    fetchImpl: async () => {
      calls += 1;
      return new Response('', { status: 503 });
    },
    now: () => NOW,
    sleep: async () => {
      throw new Error('must not sleep');
    },
  });

  await assert.rejects(
    client.request('/rest/openapi/pvms/nbi/v1/device/history', {
      method: 'POST',
      body: '{}',
      retryTransient: false,
    }),
    (error) => error.status === 503 && error.permanent === false,
  );
  assert.equal(calls, 1);
});

test('retries API requests with supported replayable body types', async () => {
  const form = new FormData();
  form.set('field', 'value');
  const arrayBuffer = Uint8Array.from([1, 2, 3]).buffer;
  const bodies = [
    undefined,
    'string-body',
    new URLSearchParams({ field: 'value' }),
    Buffer.from('buffer-body'),
    Uint8Array.from([4, 5, 6]),
    arrayBuffer,
    new DataView(arrayBuffer),
    new Blob(['blob-body']),
    form,
  ];

  for (const body of bodies) {
    const seen = [];
    const client = createHuaweiClient({
      config: config(),
      store: memoryStore(authorizedCredentials()),
      fetchImpl: async (_url, options) => {
        seen.push(options.body);
        return new Response('', { status: seen.length === 1 ? 408 : 200 });
      },
      now: () => NOW,
      sleep: async () => {},
    });

    assert.equal((await client.request('/rest/resource', { method: 'POST', body })).status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[0], body);
    assert.equal(seen[1], body);
  }
});

test('rejects non-replayable request bodies before any external request', async () => {
  const bodies = [
    new ReadableStream({
      start(controller) {
        controller.enqueue('stream-body-secret');
        controller.close();
      },
    }),
    (async function* bodyGenerator() {
      yield 'generator-body-secret';
    }()),
  ];

  for (const body of bodies) {
    let called = false;
    const client = createHuaweiClient({
      config: config(),
      store: memoryStore(authorizedCredentials()),
      fetchImpl: async () => {
        called = true;
        return new Response('', { status: 200 });
      },
      now: () => NOW,
    });

    const error = await client.request('/rest/resource?query-secret=hidden', {
      method: 'POST',
      body,
    }).catch((caught) => caught);
    assert.ok(error instanceof Error);
    assert.match(error.message, /body.*replay/i);
    assert.doesNotMatch(error.message, /stream-body-secret|generator-body-secret|query-secret|\?/);
    assert.equal(called, false);
  }
});

test('permanent refresh failures require reauthorization with a sanitized message', async () => {
  const secrets = [
    'stored-refresh',
    'fixture-client-secret',
    'response-body-secret',
  ];
  const store = memoryStore(authorizedCredentials({
    accessExpiresAt: new Date('2026-08-05T09:00:00Z'),
  }));
  const client = createHuaweiClient({
    config: config(),
    store,
    fetchImpl: async () => new Response(
      JSON.stringify({ error: 'invalid_grant', detail: 'response-body-secret' }),
      { status: 400 },
    ),
    now: () => NOW,
  });

  await assert.rejects(() => client.getAccessToken(), /status 400/i);
  assert.equal(store.states.length, 1);
  assert.equal(store.states[0].state, 'reauthorization_required');
  for (const secret of secrets) {
    assert.doesNotMatch(store.states[0].message, new RegExp(secret));
  }
});

test('a 408 refresh response retries and remains a sanitized transient failure', async () => {
  const store = memoryStore(authorizedCredentials({
    accessExpiresAt: new Date('2026-08-05T09:00:00Z'),
  }));
  const sleeps = [];
  let calls = 0;
  const client = createHuaweiClient({
    config: config(),
    store,
    fetchImpl: async () => {
      calls += 1;
      return new Response('response-body-secret', { status: 408 });
    },
    now: () => NOW,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  const error = await client.getAccessToken().catch((caught) => caught);
  assert.ok(error instanceof Error);
  assert.match(error.message, /status 408/i);
  assert.doesNotMatch(error.message, /response-body-secret|stored-refresh|fixture-client-secret/);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual(store.states, []);
});

test('external request errors omit bodies, codes, tokens, client secrets, and URL queries', async () => {
  const secrets = [
    'fixture-code-secret',
    'fixture-client-secret',
    'stored-access',
    'stored-refresh',
    'response-body-secret',
    'query-secret',
  ];
  const store = memoryStore(authorizedCredentials());
  const exchangeClient = createHuaweiClient({
    config: config(),
    store,
    fetchImpl: async () => new Response('response-body-secret', { status: 400 }),
    now: () => NOW,
  });
  const exchangeError = await exchangeClient.exchangeCode('fixture-code-secret').catch((error) => error);

  const apiClient = createHuaweiClient({
    config: config(),
    store,
    fetchImpl: async () => new Response('response-body-secret', { status: 500 }),
    now: () => NOW,
    sleep: async () => {},
  });
  const apiError = await apiClient.request('/rest/resource?credential=query-secret', {
    method: 'POST',
    body: 'request-body-secret',
  }).catch((error) => error);

  for (const error of [exchangeError, apiError]) {
    assert.ok(error instanceof Error);
    for (const secret of [...secrets, 'request-body-secret']) {
      assert.doesNotMatch(error.message, new RegExp(secret));
    }
    assert.doesNotMatch(error.message, /\?/);
  }
});

test('every external request has a bounded AbortController timeout', async () => {
  const client = createHuaweiClient({
    config: config({ requestTimeoutMs: 5 }),
    store: memoryStore(authorizedCredentials()),
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      assert.ok(options.signal instanceof AbortSignal);
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
    now: () => NOW,
  });

  await assert.rejects(
    () => client.request('/rest/resource?credential=query-secret'),
    (error) => {
      assert.match(error.message, /failed|timed out/i);
      assert.doesNotMatch(error.message, /query-secret|\?/);
      return true;
    },
  );
});

test('authenticated requests reject insecure non-local API origins', async () => {
  let called = false;
  const client = createHuaweiClient({
    config: config({ apiBaseUrl: 'http://api.example.test' }),
    store: memoryStore(authorizedCredentials()),
    fetchImpl: async () => {
      called = true;
      return new Response('', { status: 200 });
    },
    now: () => NOW,
  });

  await assert.rejects(() => client.request('/rest/resource'), /HTTPS/i);
  assert.equal(called, false);
});
