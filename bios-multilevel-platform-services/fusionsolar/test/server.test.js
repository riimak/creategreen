const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

test('health remains healthy when Huawei is not configured', async (t) => {
  const server = createServer({
    config: { port: 0 },
    integration: { status: async () => ({ state: 'not_configured' }) },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'fusionsolar' });
});
