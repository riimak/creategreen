const assert = require('assert');
const { encodeEventV1, decodeEventV1, crc32 } = require('./encoder');
const { deriveAccount } = require('./wallet');

process.env.STEALTH_RELAY_MODE = 'mock';
process.env.BLOCKCHAIN_DB_PATH = 'bios-multilevel-platform-services/data/blockchain-test-store.json';
const { processEvent } = require('./server');

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

const account = deriveAccount(decoded.deviceId);
assert.ok(account.accountId.startsWith('xst-'));

processEvent(event).then(result => {
  assert.strictEqual(result.accepted, true);
  assert.strictEqual(result.status, 'confirmed');
  assert.ok(result.txId);
  console.log('blockchain tests passed');
});
