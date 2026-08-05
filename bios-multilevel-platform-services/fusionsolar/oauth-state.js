const crypto = require('node:crypto');

const STATE_MAX_AGE_MS = 10 * 60_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function createStateManager({ secret, store, now = () => new Date() } = {}) {
  if (!Buffer.isBuffer(secret) || secret.length < 32) {
    throw new Error('OAuth state secret must be at least 32 bytes');
  }
  if (
    !store
    || typeof store.createNonce !== 'function'
    || typeof store.consumeNonce !== 'function'
  ) {
    throw new Error('OAuth state store must implement createNonce and consumeNonce');
  }
  if (typeof now !== 'function') throw new Error('OAuth state clock must be a function');

  function sign(payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest();
  }

  async function issue(setupTokenHash) {
    if (typeof setupTokenHash !== 'string' || setupTokenHash === '') {
      throw new Error('setup-token hash is required for OAuth state');
    }
    const issuedAt = requireCurrentTime(now);
    const nonce = crypto.randomBytes(32).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      nonce,
      iat: issuedAt.getTime(),
    }));
    const encodedPayload = payload.toString('base64url');
    const nonceHash = hashNonce(nonce);
    await store.createNonce(
      nonceHash,
      new Date(issuedAt.getTime() + STATE_MAX_AGE_MS),
      setupTokenHash,
    );
    return `${encodedPayload}.${sign(payload).toString('base64url')}`;
  }

  async function verifyAndConsume(state) {
    if (typeof state !== 'string') throw new Error('invalid OAuth state');
    const parts = state.split('.');
    if (
      parts.length !== 2
      || !BASE64URL.test(parts[0])
      || !BASE64URL.test(parts[1])
    ) {
      throw new Error('invalid OAuth state');
    }

    const [encodedPayload, encodedSignature] = parts;
    const payloadBytes = Buffer.from(encodedPayload, 'base64url');
    const suppliedSignature = Buffer.from(encodedSignature, 'base64url');
    const expectedSignature = sign(payloadBytes);
    if (
      suppliedSignature.toString('base64url') !== encodedSignature
      || payloadBytes.toString('base64url') !== encodedPayload
      || suppliedSignature.length !== expectedSignature.length
      || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new Error('invalid OAuth state signature');
    }

    let payload;
    try {
      payload = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
      throw new Error('invalid OAuth state payload');
    }
    if (
      !payload
      || Object.keys(payload).length !== 2
      || typeof payload.nonce !== 'string'
      || !BASE64URL.test(payload.nonce)
      || !Number.isSafeInteger(payload.iat)
    ) {
      throw new Error('invalid OAuth state payload');
    }

    const current = requireCurrentTime(now);
    const age = current.getTime() - payload.iat;
    if (age < 0) throw new Error('OAuth state was issued in the future');
    if (age > STATE_MAX_AGE_MS) throw new Error('OAuth state expired');

    const setupTokenHash = await store.consumeNonce(hashNonce(payload.nonce), current);
    if (!setupTokenHash) throw new Error('OAuth state is invalid or already used');
    return setupTokenHash;
  }

  return { issue, verifyAndConsume };
}

function hashNonce(nonce) {
  return crypto.createHash('sha256').update(nonce).digest('hex');
}

function requireCurrentTime(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('OAuth state clock returned an invalid date');
  }
  return value;
}

module.exports = { createStateManager };
