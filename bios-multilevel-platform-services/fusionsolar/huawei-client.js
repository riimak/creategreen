const AUTHORIZE_PATH = '/rest/dp/uidm/oauth2/v1/authorize';
const TOKEN_PATH = '/rest/dp/uidm/oauth2/v1/token';
const REQUIRED_SCOPE = 'pvms.openapi.basic';
const REFRESH_EARLY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 60_000;

function createHuaweiClient({
  config,
  store,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  validateDependencies(config, store, fetchImpl, now, sleep);
  let refreshInFlight = null;

  function authorizationUrl(state) {
    if (typeof state !== 'string' || state === '') throw new Error('OAuth state is required');
    const url = endpoint(config.oauthBaseUrl, AUTHORIZE_PATH);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: REQUIRED_SCOPE,
      state,
    }).toString();
    return url.toString();
  }

  async function exchangeCode(code) {
    if (typeof code !== 'string' || code === '') throw new Error('authorization code is required');
    const credentials = await requestToken(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }));
    await store.saveCredentials(credentials);
    return credentials;
  }

  async function getAccessToken() {
    const credentials = await store.loadCredentials();
    if (!credentials?.accessToken || !credentials.refreshToken) {
      throw new Error('FusionSolar authorization is required');
    }
    const current = currentTime();
    const expiresAt = new Date(credentials.accessExpiresAt);
    if (
      Number.isNaN(expiresAt.getTime())
      || expiresAt.getTime() <= current.getTime() + REFRESH_EARLY_MS
    ) {
      return (await refresh(credentials)).accessToken;
    }
    return credentials.accessToken;
  }

  async function refresh(credentials, rejectedAccessToken) {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const latest = await store.loadCredentials();
      const currentCredentials = latest || credentials;
      if (
        rejectedAccessToken
        && currentCredentials?.accessToken
        && currentCredentials.accessToken !== rejectedAccessToken
      ) {
        return currentCredentials;
      }
      if (!currentCredentials?.refreshToken) {
        throw new Error('FusionSolar authorization is required');
      }

      try {
        const refreshed = await requestToken(
          new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: currentCredentials.refreshToken,
            client_id: config.clientId,
            client_secret: config.clientSecret,
          }),
          currentCredentials.refreshToken,
        );
        await store.saveCredentials(refreshed);
        return refreshed;
      } catch (error) {
        if (error instanceof HuaweiClientError && error.permanent) {
          await store.setAuthorizationState('reauthorization_required', error.message);
        }
        throw error;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function requestToken(body, previousRefreshToken) {
    const url = endpoint(config.oauthBaseUrl, TOKEN_PATH);
    let response;
    let retried = false;
    while (true) {
      response = await externalFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      }, 'token request');
      if (!retried && isTransient(response.status)) {
        retried = true;
        await sleep(retryDelay(response));
        continue;
      }
      break;
    }

    if (!response.ok) {
      throw new HuaweiClientError(
        `Huawei token request failed with status ${response.status} at ${TOKEN_PATH}`,
        isPermanentStatus(response.status),
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new HuaweiClientError('Huawei token response was invalid', true);
    }
    return normalizeToken(payload, previousRefreshToken, currentTime());
  }

  async function request(path, options = {}) {
    if (!isReplayableBody(options.body)) {
      throw new HuaweiClientError('Huawei API request body must be replayable', true);
    }
    const url = apiUrl(path);
    let accessToken = await getAccessToken();
    let refreshedAfterUnauthorized = false;
    let retriedTransient = false;

    while (true) {
      const headers = new Headers(options.headers);
      headers.set('Authorization', `Bearer ${accessToken}`);
      if (!headers.has('Accept')) headers.set('Accept', 'application/json');
      const response = await externalFetch(url, {
        ...options,
        headers,
      }, 'API request');

      if (response.status === 401 && !refreshedAfterUnauthorized) {
        refreshedAfterUnauthorized = true;
        accessToken = (await refresh(await store.loadCredentials(), accessToken)).accessToken;
        continue;
      }
      if (isTransient(response.status) && !retriedTransient) {
        retriedTransient = true;
        await sleep(retryDelay(response));
        continue;
      }
      if (!response.ok) {
        throw new HuaweiClientError(
          `Huawei API request failed with status ${response.status} at ${url.pathname}`,
          isPermanentStatus(response.status),
        );
      }
      return response;
    }
  }

  function apiUrl(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error('Huawei API path must be root-relative');
    }
    const base = new URL(config.apiBaseUrl);
    const url = endpoint(config.apiBaseUrl, path);
    if (url.origin !== base.origin) throw new Error('Huawei API path must remain on the configured origin');
    return url;
  }

  async function externalFetch(url, options, operation) {
    const controller = new AbortController();
    const signals = [controller.signal];
    if (options.signal) signals.push(options.signal);
    const signal = signals.length === 1 ? controller.signal : AbortSignal.any(signals);
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      return await fetchImpl(url.toString(), { ...options, signal });
    } catch {
      if (controller.signal.aborted) {
        throw new HuaweiClientError(`${operationLabel(operation)} timed out at ${url.pathname}`, false);
      }
      throw new HuaweiClientError(`${operationLabel(operation)} failed at ${url.pathname}`, false);
    } finally {
      clearTimeout(timer);
    }
  }

  function currentTime() {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error('Huawei client clock returned an invalid date');
    }
    return value;
  }

  function retryDelay(response) {
    const value = response.headers.get('retry-after');
    if (value && /^\d+$/.test(value.trim())) {
      return Math.min(Number(value.trim()) * 1000, MAX_RETRY_AFTER_MS);
    }
    if (value) {
      const at = Date.parse(value);
      if (Number.isFinite(at)) {
        return Math.min(Math.max(0, at - currentTime().getTime()), MAX_RETRY_AFTER_MS);
      }
    }
    return 1000;
  }

  return {
    authorizationUrl,
    exchangeCode,
    getAccessToken,
    request,
  };
}

class HuaweiClientError extends Error {
  constructor(message, permanent) {
    super(message);
    this.name = 'HuaweiClientError';
    this.permanent = permanent;
  }
}

function normalizeToken(payload, previousRefreshToken, issuedAt) {
  const accessToken = typeof payload?.access_token === 'string'
    ? payload.access_token.trim()
    : '';
  const refreshToken = typeof payload?.refresh_token === 'string' && payload.refresh_token.trim()
    ? payload.refresh_token.trim()
    : previousRefreshToken;
  const expiresIn = Number(payload?.expires_in);
  const scopes = typeof payload?.scope === 'string'
    ? payload.scope.split(/\s+/).filter(Boolean)
    : [];
  if (
    !accessToken
    || !refreshToken
    || !Number.isFinite(expiresIn)
    || expiresIn <= 0
    || typeof payload?.token_type !== 'string'
    || payload.token_type.toLowerCase() !== 'bearer'
    || !scopes.includes(REQUIRED_SCOPE)
  ) {
    throw new HuaweiClientError('Huawei token response was invalid', true);
  }
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: new Date(issuedAt.getTime() + expiresIn * 1000),
    scopes,
    tokenType: 'Bearer',
  };
}

function endpoint(baseUrl, path) {
  const base = new URL(baseUrl);
  const url = new URL(path, base);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Huawei endpoint must use HTTPS');
  }
  return url;
}

function validateDependencies(config, store, fetchImpl, now, sleep) {
  if (
    !config
    || !config.clientId
    || !config.clientSecret
    || !config.redirectUri
    || !config.oauthBaseUrl
    || !config.apiBaseUrl
    || !Number.isInteger(config.requestTimeoutMs)
    || config.requestTimeoutMs <= 0
  ) {
    throw new Error('Huawei client requires valid configuration');
  }
  if (
    !store
    || typeof store.saveCredentials !== 'function'
    || typeof store.loadCredentials !== 'function'
    || typeof store.setAuthorizationState !== 'function'
  ) {
    throw new Error('Huawei client requires a credential store');
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof sleep !== 'function') {
    throw new Error('Huawei client dependencies are invalid');
  }
}

function isTransient(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isPermanentStatus(status) {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isReplayableBody(body) {
  return body == null
    || typeof body === 'string'
    || body instanceof URLSearchParams
    || body instanceof ArrayBuffer
    || ArrayBuffer.isView(body)
    || body instanceof Blob
    || body instanceof FormData;
}

function operationLabel(operation) {
  return `Huawei ${operation}`;
}

module.exports = { createHuaweiClient };
