const crypto = require('node:crypto');

// SolisCloud request signing (HMAC-SHA1 over verb, body MD5, content type,
// date, and path). The docs specify "application/json;charset=UTF-8" but the
// server rejects that value in the string-to-sign; only "application/json"
// passes validation, so it is used consistently in the header and signature.
const CONTENT_TYPE = 'application/json';

class SolisApiError extends Error {
  constructor(message, { status, code, transient = false } = {}) {
    super(message);
    this.name = 'SolisApiError';
    this.status = status;
    this.code = code;
    this.transient = transient;
  }
}

function createSolisClient({
  config,
  fetchImpl = fetch,
  now = () => new Date(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!config?.keyId || !config?.keySecret || !config?.apiBaseUrl) {
    throw new Error('SolisCloud client requires keyId, keySecret, and apiBaseUrl');
  }
  const spacingMs = config.minRequestSpacingMs || 600;
  const timeoutMs = config.requestTimeoutMs || 20_000;
  // Serialize requests through a queue so concurrent callers still respect
  // the vendor's 2-requests-per-second endpoint limit.
  let lastRequestAt = 0;
  let queue = Promise.resolve();

  function signedHeaders(path, body) {
    const contentMd5 = crypto.createHash('md5').update(body, 'utf8').digest('base64');
    const date = new Date(now().getTime()).toUTCString();
    const toSign = ['POST', contentMd5, CONTENT_TYPE, date, path].join('\n');
    const sign = crypto.createHmac('sha1', config.keySecret).update(toSign, 'utf8').digest('base64');
    return {
      'Content-MD5': contentMd5,
      'Content-Type': CONTENT_TYPE,
      Date: date,
      Authorization: `API ${config.keyId}:${sign}`,
    };
  }

  async function throttled(task) {
    const run = queue.then(async () => {
      const waitMs = lastRequestAt + spacingMs - now().getTime();
      if (waitMs > 0) await sleep(waitMs);
      lastRequestAt = now().getTime();
      return task();
    });
    // Keep the queue alive after failures; callers observe the rejection.
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function post(path, bodyObj, { signal } = {}) {
    const body = JSON.stringify(bodyObj ?? {});
    return throttled(async () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response;
      try {
        response = await fetchImpl(config.apiBaseUrl + path, {
          method: 'POST',
          headers: signedHeaders(path, body),
          body,
          signal: combined,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new SolisApiError(`SolisCloud request failed: ${path}`, { transient: true });
      }
      if (!response.ok) {
        throw new SolisApiError(`SolisCloud request rejected: ${path}`, {
          status: response.status,
          transient: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new SolisApiError(`SolisCloud returned invalid JSON: ${path}`, { transient: true });
      }
      if (!payload || payload.success !== true || String(payload.code) !== '0') {
        throw new SolisApiError(`SolisCloud call failed: ${path}`, {
          code: payload?.code,
          // Vendor throttling surfaces as code B0500 ("too frequent").
          transient: String(payload?.code).toUpperCase() === 'B0500',
        });
      }
      return payload;
    });
  }

  return { post };
}

module.exports = { createSolisClient, SolisApiError };
