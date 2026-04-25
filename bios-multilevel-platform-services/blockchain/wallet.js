const crypto = require('crypto');
const fs = require('fs');

function readSeed() {
  if (process.env.BLOCKCHAIN_WALLET_SEED) return process.env.BLOCKCHAIN_WALLET_SEED;
  const file = process.env.BLOCKCHAIN_WALLET_SEED_FILE;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return 'development-seed-change-me';
}

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

module.exports = { deriveAccount };
