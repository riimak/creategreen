const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

async function startServer(t, integration) {
  const server = createServer({ config: { port: 0 }, integration });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('health remains healthy when Huawei is not configured', async (t) => {
  const baseUrl = await startServer(t, {
    status: async () => ({ state: 'not_configured' }),
  });
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'fusionsolar' });
});

test('status returns the integration status', async (t) => {
  const status = { state: 'configured', inventory: 'idle' };
  const baseUrl = await startServer(t, {
    status: async () => status,
  });

  const response = await fetch(`${baseUrl}/status`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), status);
});

test('status rejection returns a sanitized internal error', async (t) => {
  const baseUrl = await startServer(t, {
    status: async () => {
      throw new Error('upstream token leaked');
    },
  });

  const response = await fetch(`${baseUrl}/status`, {
    signal: AbortSignal.timeout(1_000),
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'internal error' });
});

test('unknown routes return not found', async (t) => {
  const baseUrl = await startServer(t, {
    status: async () => ({ state: 'not_configured' }),
  });

  const response = await fetch(`${baseUrl}/missing`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not found' });
});
