const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStateManager } = require('../oauth-state');

function createMemoryStore() {
  const nonces = new Map();
  return {
    created: [],
    async createNonce(hash, expiresAt) {
      this.created.push({ hash, expiresAt });
      nonces.set(hash, { expiresAt, consumed: false });
    },
    async consumeNonce(hash, at) {
      const nonce = nonces.get(hash);
      if (!nonce || nonce.consumed || nonce.expiresAt <= at) return false;
      nonce.consumed = true;
      return true;
    },
  };
}

test('issued state contains only nonce and issued-at while the store receives only its hash', async () => {
  const now = new Date('2026-08-05T10:00:00Z');
  const store = createMemoryStore();
  const manager = createStateManager({
    secret: Buffer.alloc(32, 1),
    store,
    now: () => now,
  });

  const state = await manager.issue();
  const [encodedPayload, encodedSignature] = state.split('.');
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

  assert.deepEqual(Object.keys(payload).sort(), ['iat', 'nonce']);
  assert.equal(payload.iat, now.getTime());
  assert.match(payload.nonce, /^[A-Za-z0-9_-]+$/);
  assert.equal(
    encodedSignature,
    crypto.createHmac('sha256', Buffer.alloc(32, 1))
      .update(Buffer.from(encodedPayload, 'base64url'))
      .digest('base64url'),
  );
  assert.deepEqual(store.created, [{
    hash: crypto.createHash('sha256').update(payload.nonce).digest('hex'),
    expiresAt: new Date(now.getTime() + 10 * 60_000),
  }]);
  assert.equal(store.created[0].hash.includes(payload.nonce), false);
});

test('state is signed, expires after ten minutes, and is single-use', async () => {
  let current = new Date('2026-08-05T10:00:00Z');
  const manager = createStateManager({
    secret: Buffer.alloc(32, 2),
    store: createMemoryStore(),
    now: () => current,
  });

  const state = await manager.issue();
  assert.equal(await manager.verifyAndConsume(state), true);
  await assert.rejects(() => manager.verifyAndConsume(state), /already used|invalid/i);

  const expiringState = await manager.issue();
  current = new Date('2026-08-05T10:10:00.001Z');
  await assert.rejects(() => manager.verifyAndConsume(expiringState), /expired|invalid/i);
});

test('state rejects malformed values, modified signatures, and future issue times', async () => {
  let current = new Date('2026-08-05T10:00:00Z');
  const manager = createStateManager({
    secret: Buffer.alloc(32, 3),
    store: createMemoryStore(),
    now: () => current,
  });

  const state = await manager.issue();
  const [payload, signature] = state.split('.');
  const modifiedSignature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
  await assert.rejects(() => manager.verifyAndConsume(`${payload}.${modifiedSignature}`), /signature/i);
  await assert.rejects(() => manager.verifyAndConsume('not-a-state'), /invalid/i);

  current = new Date('2026-08-05T09:59:59Z');
  await assert.rejects(() => manager.verifyAndConsume(state), /issued|invalid/i);
});

test('requires a secret and nonce store contract', () => {
  assert.throws(
    () => createStateManager({ secret: Buffer.alloc(31), store: createMemoryStore() }),
    /secret/i,
  );
  assert.throws(
    () => createStateManager({ secret: Buffer.alloc(32), store: {} }),
    /store/i,
  );
});
