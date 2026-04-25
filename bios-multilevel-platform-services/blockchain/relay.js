const crypto = require('crypto');

function mockTxId(payloadHex, accountId) {
  return crypto.createHash('sha256').update(`${accountId}:${payloadHex}`).digest('hex');
}

function createRelay() {
  const mode = process.env.STEALTH_RELAY_MODE || 'mock';

  async function submit({ payloadHex, account }) {
    if (mode === 'mock') {
      return {
        mode,
        txId: mockTxId(payloadHex, account.accountId),
        confirmed: true,
      };
    }

    if (mode === 'http') {
      const url = process.env.STEALTH_RPC_URL;
      if (!url) throw new Error('STEALTH_RPC_URL required for http relay mode');
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: process.env.STEALTH_API_KEY ? `Bearer ${process.env.STEALTH_API_KEY}` : '',
        },
        body: JSON.stringify({ account, payloadHex }),
      });
      if (!res.ok) throw new Error(`Stealth relay failed: ${res.status}`);
      return { mode, ...(await res.json()) };
    }

    if (mode === 'stealth-lib') {
      // The actual library is intentionally loaded only when requested so the
      // demonstrator runs without Stealth tooling installed.
      const stealth = require('stealth-lib');
      return stealth.submitEvent({ account, payloadHex });
    }

    throw new Error(`unsupported STEALTH_RELAY_MODE: ${mode}`);
  }

  async function verify(txId) {
    if (mode === 'mock') return { mode, txId, found: true };
    if (mode === 'http') {
      const base = process.env.STEALTH_RPC_URL;
      if (!base) throw new Error('STEALTH_RPC_URL required for http relay mode');
      const url = new URL(`/transactions/${txId}`, base);
      const res = await fetch(url);
      if (!res.ok) return { mode, txId, found: false };
      return { mode, txId, found: true, transaction: await res.json() };
    }
    if (mode === 'stealth-lib') {
      const stealth = require('stealth-lib');
      return stealth.verifyTransaction(txId);
    }
    throw new Error(`unsupported STEALTH_RELAY_MODE: ${mode}`);
  }

  return { submit, verify, mode };
}

module.exports = { createRelay };
