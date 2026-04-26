const fs = require('fs');
const bitcoin = require('./vendor/bitcoinjs-lib-feeless/src');

const NETWORKS = {
  mainnet: {
    messagePrefix: 'unused',
    bip32: { public: 0x0488b21e, private: 0x0488ade4 },
    pubKeyHash: 0x3e,
    scriptHash: 0x55,
    wif: 0xbe,
  },
  testnet: {
    messagePrefix: 'unused',
    bip32: { public: 0x043587cf, private: 0x04358394 },
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    wif: 0xef,
  },
};

function network() {
  return NETWORKS[process.env.STEALTH_NETWORK || 'mainnet'] || NETWORKS.mainnet;
}

function readWif() {
  if (process.env.STEALTH_WIF) return process.env.STEALTH_WIF.trim();
  const file = process.env.STEALTH_WIF_FILE;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return '';
}

function accountFromWif() {
  const wif = readWif();
  if (!wif) return { configured: false, reason: 'WIF not configured' };
  try {
    const keyPair = bitcoin.ECPair.fromWIF(wif, network());
    const payment = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: network() });
    return {
      configured: true,
      address: payment.address,
      publicKey: keyPair.publicKey.toString('hex'),
      network: process.env.STEALTH_NETWORK || 'mainnet',
    };
  } catch (error) {
    return { configured: false, reason: `Invalid WIF for configured network: ${error.message}` };
  }
}

function normalizeOutputs(outputs) {
  if (!Array.isArray(outputs)) return [];
  return outputs
    .filter(out => String(out.isspent ?? 'false') === 'false')
    .map(out => ({
      txid: out.txid || out.tx_hash || out.hash || out.prev_txid || null,
      vout: out.vout ?? out.outputIndex ?? out.n ?? out.index ?? null,
      amount: Number(out.amount ?? out.value ?? out.satoshis ?? 0),
      raw: out,
    }));
}

async function walletReadiness(relay) {
  const account = accountFromWif();
  if (!account.configured) return { ...account, balance: null, outputs: [], spendableOutputs: 0 };
  if (!process.env.STEALTH_RPC_URL || !relay?.rpc) {
    return {
      ...account,
      balance: null,
      outputs: [],
      spendableOutputs: 0,
      rpcChecked: false,
      reason: 'RPC not configured, cannot discover UTXO',
    };
  }

  const result = { ...account, rpcChecked: true };
  try {
    result.balance = await relay.rpc(process.env.STEALTH_RPC_BALANCE_METHOD || 'getaddressbalance', [account.address]);
  } catch (error) {
    result.balanceError = error.message;
  }

  try {
    const outputs = await relay.rpc(process.env.STEALTH_RPC_OUTPUTS_METHOD || 'getaddressoutputs', [account.address, 1, 99999]);
    result.outputs = normalizeOutputs(outputs);
    result.spendableOutputs = result.outputs.filter(out => Number(out.amount) > 0).length;
  } catch (error) {
    result.outputs = [];
    result.spendableOutputs = 0;
    result.outputsError = error.message;
  }

  return result;
}

module.exports = { accountFromWif, readWif, walletReadiness, normalizeOutputs, network };
