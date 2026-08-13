const crypto = require('node:crypto');

const STATE_MAX_AGE_MS = 10 * 60_000;
const STATE_VERSION = '1';
const TIMESTAMP_HEX_LENGTH = 12;
const NONCE_HEX_LENGTH = 64;
const SIGNATURE_HEX_LENGTH = 64;
const PAYLOAD_LENGTH = STATE_VERSION.length + TIMESTAMP_HEX_LENGTH + NONCE_HEX_LENGTH;
const STATE_LENGTH = PAYLOAD_LENGTH + SIGNATURE_HEX_LENGTH;
const ALPHANUMERIC = /^[A-Za-z0-9]+$/;
const HEX = /^[a-f0-9]+$/;

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
    const nonce = crypto.randomBytes(32).toString('hex');
    const timestamp = issuedAt.getTime().toString(16).padStart(TIMESTAMP_HEX_LENGTH, '0');
    if (timestamp.length !== TIMESTAMP_HEX_LENGTH) {
      throw new Error('OAuth state timestamp is out of range');
    }
    const payload = `${STATE_VERSION}${timestamp}${nonce}`;
    const nonceHash = hashNonce(nonce);
    await store.createNonce(
      nonceHash,
      new Date(issuedAt.getTime() + STATE_MAX_AGE_MS),
      setupTokenHash,
    );
    return `${payload}${sign(payload).toString('hex')}`;
  }

  async function verifyAndConsume(state) {
    if (
      typeof state !== 'string'
      || state.length !== STATE_LENGTH
      || !ALPHANUMERIC.test(state)
    ) {
      throw new Error('invalid OAuth state');
    }

    const payload = state.slice(0, PAYLOAD_LENGTH);
    const version = payload.slice(0, STATE_VERSION.length);
    const timestamp = payload.slice(
      STATE_VERSION.length,
      STATE_VERSION.length + TIMESTAMP_HEX_LENGTH,
    );
    const nonce = payload.slice(STATE_VERSION.length + TIMESTAMP_HEX_LENGTH);
    const encodedSignature = state.slice(PAYLOAD_LENGTH);
    if (
      version !== STATE_VERSION
      || !HEX.test(timestamp)
      || !HEX.test(nonce)
      || !/^[a-fA-F0-9]+$/.test(encodedSignature)
    ) {
      throw new Error('invalid OAuth state');
    }

    const suppliedSignature = Buffer.from(encodedSignature, 'hex');
    const expectedSignature = sign(payload);
    if (
      suppliedSignature.toString('hex') !== encodedSignature
      || suppliedSignature.length !== expectedSignature.length
      || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new Error('invalid OAuth state signature');
    }

    const issuedAt = Number.parseInt(timestamp, 16);
    if (!Number.isSafeInteger(issuedAt)) {
      throw new Error('invalid OAuth state payload');
    }

    const current = requireCurrentTime(now);
    const age = current.getTime() - issuedAt;
    if (age < 0) throw new Error('OAuth state was issued in the future');
    if (age > STATE_MAX_AGE_MS) throw new Error('OAuth state expired');

    const setupTokenHash = await store.consumeNonce(hashNonce(nonce), current);
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
