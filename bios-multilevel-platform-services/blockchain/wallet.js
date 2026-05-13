const crypto = require('crypto');
const fs = require('fs');

const DEFAULT_SEED = 'development-seed-change-me';

function readSeed() {
  if (process.env.BLOCKCHAIN_WALLET_SEED) return process.env.BLOCKCHAIN_WALLET_SEED;
  const file = process.env.BLOCKCHAIN_WALLET_SEED_FILE;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return DEFAULT_SEED;
}

// The public default seed is committed in source — anyone can re-derive every
// device account from it. We always log loud at startup if it is in use with
// a real chain. Set BLOCKCHAIN_WALLET_SEED_STRICT=true to refuse to start
// instead of warning (recommended once a unique seed is provisioned).
function assertSeedSafe() {
  const seed = readSeed();
  if (seed !== DEFAULT_SEED) return;
  const relayMode = (process.env.STEALTH_RELAY_MODE || 'mock').toLowerCase();
  const realBroadcast = String(process.env.STEALTH_ENABLE_REAL_BROADCAST || 'false').toLowerCase() === 'true';
  const onChain = relayMode !== 'mock' || realBroadcast;
  if (!onChain) return;
  const strict = String(process.env.BLOCKCHAIN_WALLET_SEED_STRICT || 'false').toLowerCase() === 'true';
  const msg = 'BLOCKCHAIN_WALLET_SEED is the public default but the relay is not in mock mode. '
    + 'Every device account is publicly derivable. '
    + 'Set BLOCKCHAIN_WALLET_SEED (or BLOCKCHAIN_WALLET_SEED_FILE) to a unique secret.';
  if (strict) throw new Error(`Refusing to start: ${msg}`);
  console.warn(`${new Date().toISOString()} blockchain — SECURITY WARNING: ${msg}`);
}

assertSeedSafe();

function deriveAccount(deviceId) {
  const seed = readSeed();
  const normalized = String(deviceId);
  const digest = crypto.createHmac('sha256', seed).update(normalized).digest('hex');
  return {
    deviceId: normalized,
    derivationPath: `m/44'/10205'/0'/0/${Number.parseInt(digest.slice(0, 8), 16) % 100000}`,
    accountId: `xst-${digest.slice(0, 32)}`,
  };
}

module.exports = { deriveAccount, assertSeedSafe };
