const assert = require('assert');
const fs = require('fs');
const { encodeEventV1, decodeEventV1, encodeEventV2, decodeEventV2, crc32 } = require('./encoder');
const { deriveAccount } = require('./wallet');
const { accountFromWif } = require('./stealth-wallet');

process.env.STEALTH_RELAY_MODE = 'mock';
process.env.BLOCKCHAIN_DB_PATH = 'bios-multilevel-platform-services/data/blockchain-test-store.json';
try { fs.unlinkSync(process.env.BLOCKCHAIN_DB_PATH); } catch {}
const { processEvent, demoEvents, chainStatus, chainTransactions, chainBlocks } = require('./server');

const event = {
  device_id: '0x0A1C',
  timestamp: 1717699200,
  event_code: 'ok',
  value: 250,
  metadata: { source: 'BIOS' },
};

const encoded = encodeEventV1(event);
assert.strictEqual(encoded.bytes, 13);
assert.strictEqual(encoded.hex.slice(0, 4), '0A1C');
assert.strictEqual(encoded.hex.slice(12, 14), '01');
assert.strictEqual(encoded.hex.slice(14, 18), '00FA');

const decoded = decodeEventV1(encoded.hex);
assert.strictEqual(decoded.deviceId, 0x0A1C);
assert.strictEqual(decoded.timestamp, 1717699200);
assert.strictEqual(decoded.value, 250);
assert.strictEqual(typeof crc32(Buffer.from('abc')), 'number');

const encodedV2 = encodeEventV2({
  source: 'OS1BIOS',
  metric: 'PM2_5',
  timestamp: 1717699200,
  event_code: 'data_quality_changed',
  status: 'stale',
  value: 250,
});
assert.strictEqual(encodedV2.bytes, 16);
assert.strictEqual(encodedV2.version, 2);
assert.strictEqual(decodeEventV2(encodedV2.hex).metricCode, encodedV2.metricCode);

const account = deriveAccount(decoded.deviceId);
assert.ok(account.accountId.startsWith('xst-'));
const stealthAccount = accountFromWif();
assert.strictEqual(typeof stealthAccount.configured, 'boolean');

processEvent(event).then(result => {
  assert.strictEqual(result.accepted, true);
  assert.strictEqual(result.status, 'confirmed');
  assert.ok(result.txId);
  return processEvent(event);
}).then(result => {
  assert.strictEqual(result.accepted, false);
  assert.strictEqual(result.reason, 'duplicate');
  assert.ok(demoEvents().length > 0);
  return chainStatus();
}).then(result => {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.relayMode, 'mock');
  return chainTransactions(5);
}).then(result => {
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length > 0);
  return chainBlocks(5);
}).then(result => {
  assert.ok(Array.isArray(result.data));
  console.log('blockchain tests passed');
});
