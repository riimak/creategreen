const argon2 = require('argon2');
const { XorShift1024Star } = require('xorshift.js');
const { Buffer } = require('buffer');
const bitcoin = require('./vendor/bitcoinjs-lib-feeless/src');
const { accountFromWif, readWif, walletReadiness, network } = require('./stealth-wallet');

function toAtomic(amount) {
  return Math.floor(Number(amount) * 1e6);
}

function hexToBytes(hexString) {
  if (hexString.length % 2 !== 0) throw new Error('hex string must have an even number of digits');
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hexString.substr(i * 2, 2), 16);
  return bytes;
}

function concatBytes(arrays) {
  const total = arrays.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const item of arrays) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

function hexToBigInt(hex) {
  return BigInt(`0x${hex.length % 2 ? `0${hex}` : hex}`);
}

function mcostFromSize(blockSize, txBytes) {
  const maxSize = 200000;
  const m = 1000 * 110;
  const base = 256;
  let cost = (1 + txBytes / 1000) * base;
  let newSize = Math.min(blockSize + txBytes, maxSize);
  let i = 2;
  while (i <= (31 * newSize) / maxSize) {
    cost = (cost * m) / 100000;
    i += 1;
  }
  return Math.ceil(Math.min(cost, 4608));
}

async function createWork(data, mcost) {
  const limit = hexToBigInt('0006ffffffffffff');
  const deadline = Date.now() + Number(process.env.STEALTH_FEEWORK_TIMEOUT_SECONDS || 120) * 1000;

  while (Date.now() < deadline) {
    const prng = new XorShift1024Star(Date.now().toString(16));
    const salt = Buffer.from(prng.randomBytes(8));
    const hash = await argon2.hash(Buffer.from(data), {
      salt,
      timeCost: 1,
      memoryCost: mcost,
      hashLength: 8,
      parallelism: 1,
      type: argon2.argon2d,
      raw: true,
    });
    if (hexToBigInt(Buffer.from(hash).toString('hex')) <= limit) return salt.readBigUInt64BE();
  }
  throw new Error('Feeless calculation time exceeded');
}

function writeFeeworkScript(height, mcost, work) {
  const script = Buffer.allocUnsafe(18);
  script.writeUInt8(16, 0);
  script.writeUInt32BE(height, 1);
  script.writeUInt32BE(mcost, 5);
  script.writeBigUInt64BE(work, 9);
  script.writeUInt8(209, 17);
  return script;
}

async function createFeeworkScript(inputCount, unsignedHex, block) {
  const txBytes = unsignedHex.length / 2 + inputCount * 108 + 18;
  const blockHash = String(block.hash).match(/.{1,2}/g).reverse().join('');
  const mcost = mcostFromSize(Number(block.size || 0), txBytes);
  const data = concatBytes([hexToBytes(blockHash), hexToBytes(unsignedHex)]);
  const work = await createWork(data, mcost);
  return writeFeeworkScript(Number(block.height), mcost, work);
}

async function buildFeelessTransaction({ payloadHex, relay }) {
  const account = accountFromWif();
  if (!account.configured) throw new Error(account.reason || 'WIF not configured');
  const readiness = await walletReadiness(relay);
  const utxo = (readiness.outputs || []).find(out => out.txid && out.vout !== null && Number(out.amount) > 0);
  if (!utxo) throw new Error('No spendable UTXO found for service WIF');

  const prevTx = await relay.rpc(process.env.STEALTH_RPC_TX_METHOD || 'gettransaction', [utxo.txid]);
  const prevOut = prevTx.vout?.[Number(utxo.vout)];
  const prevOutHex = prevOut?.scriptPubKey?.hex || utxo.raw?.scriptPubKey?.hex;
  if (!prevOutHex) throw new Error('Could not resolve previous output scriptPubKey');

  const keyPair = bitcoin.ECPair.fromWIF(readWif(), network());
  const tx = new bitcoin.TransactionBuilder(network(), 3000000);
  tx.setVersion(4);
  tx.addInput(utxo.txid, Number(utxo.vout), null, Buffer.from(prevOutHex, 'hex'));
  tx.addOutput(account.address, toAtomic(utxo.amount));

  const payloadScript = bitcoin.payments.embed({ data: [Buffer.from(payloadHex, 'hex')] }).output;
  tx.addOutput(payloadScript, 0);

  const bestBlock = await relay.rpc(process.env.STEALTH_RPC_BEST_BLOCK_METHOD || 'getbestblock', []);
  const unsignedHex = tx.buildIncomplete().toHex();
  const feeworkScript = await createFeeworkScript(tx.__INPUTS.length, unsignedHex, bestBlock);
  tx.addOutput(feeworkScript, 0);
  tx.sign(0, keyPair);

  return {
    rawTransactionHex: tx.build().toHex(),
    sourceAddress: account.address,
    inputCount: 1,
    outputCount: 3,
    selectedUtxo: { txid: utxo.txid, vout: utxo.vout, amount: utxo.amount },
    payloadBytes: payloadHex.length / 2,
  };
}

module.exports = { buildFeelessTransaction };
