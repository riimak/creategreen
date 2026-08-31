const test = require('node:test');
const assert = require('node:assert');
const { createSolisClient, SolisApiError } = require('../solis-client');
const { createFakeSolis, pageResponse } = require('./fake-solis');

const KEY_ID = '2424242424242424242';
const KEY_SECRET = 'test-secret-value';

function clientConfig(apiBaseUrl, overrides = {}) {
  return {
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    apiBaseUrl,
    minRequestSpacingMs: 1,
    requestTimeoutMs: 2000,
    ...overrides,
  };
}

test('signs requests so a signature-verifying server accepts them', async () => {
  const fake = createFakeSolis({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    data: { '/v1/api/userStationList': pageResponse([{ id: 1 }]) },
  });
  const base = await fake.listen();
  try {
    const client = createSolisClient({ config: clientConfig(base) });
    const payload = await client.post('/v1/api/userStationList', { pageNo: 1, pageSize: 10 });
    assert.strictEqual(payload.success, true);
    assert.strictEqual(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0].body, { pageNo: 1, pageSize: 10 });
  } finally {
    await fake.close();
  }
});

test('a wrong secret is rejected by signature verification', async () => {
  const fake = createFakeSolis({ keyId: KEY_ID, keySecret: KEY_SECRET, data: {} });
  const base = await fake.listen();
  try {
    const client = createSolisClient({
      config: clientConfig(base, { keySecret: 'wrong-secret' }),
    });
    await assert.rejects(
      client.post('/v1/api/userStationList', { pageNo: 1 }),
      (error) => error instanceof SolisApiError && error.status === 403,
    );
  } finally {
    await fake.close();
  }
});

test('vendor-level failure codes raise SolisApiError', async () => {
  const fake = createFakeSolis({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    data: {
      '/v1/api/inverterList': { success: false, code: 'B0500', msg: 'too frequent' },
    },
  });
  const base = await fake.listen();
  try {
    const client = createSolisClient({ config: clientConfig(base) });
    await assert.rejects(
      client.post('/v1/api/inverterList', { pageNo: 1 }),
      (error) => error instanceof SolisApiError && error.transient === true,
    );
  } finally {
    await fake.close();
  }
});

test('spaces consecutive requests by the configured interval', async () => {
  const fake = createFakeSolis({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    data: { '/v1/api/userStationList': pageResponse([]) },
  });
  const base = await fake.listen();
  try {
    let clockMs = 1_000_000;
    const waits = [];
    const client = createSolisClient({
      config: clientConfig(base, { minRequestSpacingMs: 600 }),
      now: () => new Date(clockMs),
      sleep: async (ms) => {
        waits.push(ms);
        clockMs += ms;
      },
    });
    await client.post('/v1/api/userStationList', { pageNo: 1 });
    await client.post('/v1/api/userStationList', { pageNo: 2 });
    assert.strictEqual(waits.length, 1);
    assert.ok(waits[0] > 0 && waits[0] <= 600, `unexpected spacing wait ${waits[0]}`);
  } finally {
    await fake.close();
  }
});
