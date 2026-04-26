const crypto = require('crypto');

function mockTxId(payloadHex, accountId) {
  return crypto.createHash('sha256').update(`${accountId}:${payloadHex}`).digest('hex');
}

/* ── RPC cache + circuit breaker ────────────────────────────────────
 * The Stealth gateway throttles aggressively (returns 503 under load).
 * We layer three protections on top of the raw RPC:
 *   1. Per-method TTL cache (read-only, idempotent calls)
 *   2. In-flight deduplication (concurrent requests await a single call)
 *   3. Circuit breaker on 503/429/502: enter a cool-down, serve stale
 *      cached values during the cool-down rather than hammering the gateway
 * Tunable via env: STEALTH_RPC_COOLDOWN_SECONDS (default 30).
 * ──────────────────────────────────────────────────────────────────── */
const TTL = {
  getinfo: 15_000,
  getbestblock: 15_000,
  getblock: 5 * 60_000,         // block contents are immutable once known
  gettransaction: 5_000,        // upgraded to long when confirmations >= 1
  getaddressbalance: 60_000,
  getaddressoutputs: 60_000,
};
const CONFIRMED_TX_TTL = 10 * 60_000;   // confirmed txs are immutable
const CACHE = new Map();   // key -> { value, expiresAt }
const INFLIGHT = new Map();
let cooldownUntil = 0;
let lastError = null;

function isThrottlingError(err) {
  const msg = String(err?.message || '');
  return /\b(503|502|429)\b/.test(msg) || /service unavailable|too many requests|rate limit/i.test(msg);
}
function cooldownSecs() {
  return Math.max(5, Number(process.env.STEALTH_RPC_COOLDOWN_SECONDS || 30));
}
function ttlFor(method, params, value) {
  if (method === (process.env.STEALTH_RPC_TX_METHOD || 'gettransaction')) {
    const confirmations = value?.confirmations || value?.transaction?.confirmations;
    if (confirmations && confirmations >= 1) return CONFIRMED_TX_TTL;
  }
  return TTL[method] ?? 0;
}
function rpcCacheStats() {
  return {
    cacheSize: CACHE.size,
    inflight: INFLIGHT.size,
    cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null,
    cooldownSecondsRemaining: cooldownUntil > Date.now() ? Math.ceil((cooldownUntil - Date.now()) / 1000) : 0,
    lastError,
  };
}

function createRelay() {
  const mode = process.env.STEALTH_RELAY_MODE || 'mock';
  const rpcId = Number(process.env.STEALTH_RPC_ID || 666420);

  function rpcHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.STEALTH_API_KEY) headers.Authorization = `Bearer ${process.env.STEALTH_API_KEY}`;
    if (process.env.STEALTH_RPC_USERNAME || process.env.STEALTH_RPC_PASSWORD) {
      const user = process.env.STEALTH_RPC_USERNAME || '';
      const pass = process.env.STEALTH_RPC_PASSWORD || '';
      headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }
    return headers;
  }

  async function rpcRaw(method, params = []) {
    const url = process.env.STEALTH_RPC_URL;
    if (!url) throw new Error('STEALTH_RPC_URL required for json-rpc mode');
    const res = await fetch(url, {
      method: 'POST',
      headers: rpcHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
    });
    if (!res.ok) throw new Error(`Stealth RPC ${method} failed: ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`Stealth RPC ${method} error: ${JSON.stringify(body.error)}`);
    return body.result;
  }

  async function rpc(method, params = []) {
    const key = `${method}:${JSON.stringify(params || [])}`;
    const cached = CACHE.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    if (INFLIGHT.has(key)) return INFLIGHT.get(key);

    if (cooldownUntil > Date.now()) {
      if (cached) return cached.value;
      const wait = Math.ceil((cooldownUntil - Date.now()) / 1000);
      throw new Error(`Stealth RPC cooling down for ${wait}s (last: ${lastError || 'throttled'})`);
    }

    const promise = rpcRaw(method, params)
      .then(value => {
        const ttl = ttlFor(method, params, value);
        if (ttl > 0) CACHE.set(key, { value, expiresAt: Date.now() + ttl });
        INFLIGHT.delete(key);
        return value;
      })
      .catch(err => {
        INFLIGHT.delete(key);
        if (isThrottlingError(err)) {
          cooldownUntil = Date.now() + cooldownSecs() * 1000;
          lastError = err.message;
          if (cached) return cached.value;   // serve stale rather than fail
        }
        throw err;
      });

    INFLIGHT.set(key, promise);
    return promise;
  }

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

    if (mode === 'json-rpc') {
      if (!payloadHex || !payloadHex.startsWith('rawtx:')) {
        return {
          mode,
          txId: null,
          confirmed: false,
          relayStatus: 'not_submitted',
          reason: 'json-rpc mode requires a raw transaction; compact payload is encoded but not broadcast',
        };
      }
      const method = process.env.STEALTH_RPC_SEND_METHOD || 'sendrawtransaction';
      const txId = await rpc(method, [payloadHex.replace(/^rawtx:/, '')]);
      return { mode, txId, confirmed: false, relayStatus: 'sent' };
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
    if (mode === 'json-rpc') {
      const method = process.env.STEALTH_RPC_TX_METHOD || 'gettransaction';
      try {
        return { mode, txId, found: true, transaction: await rpc(method, [txId]) };
      } catch (error) {
        return { mode, txId, found: false, error: error.message };
      }
    }
    if (mode === 'stealth-lib') {
      const stealth = require('stealth-lib');
      return stealth.verifyTransaction(txId);
    }
    throw new Error(`unsupported STEALTH_RELAY_MODE: ${mode}`);
  }

  async function status() {
    if (mode === 'mock') {
      return {
        mode,
        rpcConfigured: false,
        latestBlock: {
          height: Math.floor(Date.now() / 60000),
          hash: mockTxId(String(Math.floor(Date.now() / 60000)), 'mock-block'),
          time: Math.floor(Date.now() / 1000),
        },
      };
    }
    if (mode === 'json-rpc') {
      const method = process.env.STEALTH_RPC_STATUS_METHOD || 'getinfo';
      const info = await rpc(method, []);
      return { mode, rpcConfigured: true, info, latestBlock: { height: info?.blocks ?? info?.height ?? null } };
    }
    return { mode, rpcConfigured: Boolean(process.env.STEALTH_RPC_URL) };
  }

  async function transaction(txId) {
    return verify(txId);
  }

  async function bestBlock() {
    if (mode === 'mock') {
      return {
        height: Math.floor(Date.now() / 60000),
        hash: mockTxId(String(Math.floor(Date.now() / 60000)), 'mock-block'),
        time: Math.floor(Date.now() / 1000),
        transactions: [],
      };
    }
    if (mode === 'json-rpc') {
      const method = process.env.STEALTH_RPC_BEST_BLOCK_METHOD || 'getbestblock';
      return rpc(method, []);
    }
    return null;
  }

  async function block(hash) {
    if (mode === 'mock') return bestBlock();
    if (mode === 'json-rpc') {
      const method = process.env.STEALTH_RPC_BLOCK_METHOD || 'getblock';
      return rpc(method, [hash]);
    }
    return null;
  }

  return { submit, verify, status, transaction, bestBlock, block, rpc, mode, cacheStats: rpcCacheStats };
}

module.exports = { createRelay, rpcCacheStats };
