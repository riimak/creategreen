const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenCipher } = require('../crypto');

test('encrypts with unique IVs and rejects tampering', () => {
  const cipher = createTokenCipher(Buffer.alloc(32, 3));
  const first = cipher.encrypt('refresh-secret');
  const second = cipher.encrypt('refresh-secret');

  assert.notEqual(first.iv, second.iv);
  assert.equal(cipher.decrypt(first), 'refresh-secret');
  assert.throws(() => cipher.decrypt({
    ...first,
    tag: Buffer.alloc(16).toString('base64'),
  }));
});

test('requires an exact 32-byte buffer key', () => {
  assert.throws(() => createTokenCipher('not-a-buffer'), /32-byte key/);
  assert.throws(() => createTokenCipher(Buffer.alloc(31)), /32-byte key/);
});
