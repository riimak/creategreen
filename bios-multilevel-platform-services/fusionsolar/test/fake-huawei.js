const http = require('node:http');

const AUTHORIZE_PATH = '/rest/dp/uidm/oauth2/v1/authorize';
const TOKEN_PATH = '/rest/dp/uidm/oauth2/v1/token';
const HISTORY_PATH = '/rest/openapi/pvms/nbi/v1/device/history';
const REQUIRED_SCOPE = 'pvms.openapi.basic';
const FIXTURE_CODE = 'obviously-fake-authorization-code';
const INITIAL_ACCESS_TOKEN = 'obviously-fake-access-token-1';
const INITIAL_REFRESH_TOKEN = 'obviously-fake-refresh-token-1';

function createFakeHuaweiServer({
  clientId,
  clientSecret,
  redirectUri,
  now = () => new Date('2026-08-05T10:00:00Z'),
} = {}) {
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('fake Huawei requires client credentials and redirect URI');
  }

  const recordedCalls = [];
  const rejectOnce = new Map();
  const throttleOnce = new Map();
  let callbackBaseUrl = null;
  let currentAccessToken = INITIAL_ACCESS_TOKEN;
  let currentRefreshToken = INITIAL_REFRESH_TOKEN;
  let refreshSequence = 1;
  let baseUrl = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-huawei.invalid');
    try {
      if (req.method === 'GET' && url.pathname === AUTHORIZE_PATH) {
        const call = record({
          method: req.method,
          path: url.pathname,
          query: redactQuery(url.searchParams),
        });
        if (
          url.searchParams.get('response_type') !== 'code'
          || url.searchParams.get('client_id') !== clientId
          || url.searchParams.get('redirect_uri') !== redirectUri
          || url.searchParams.get('scope') !== REQUIRED_SCOPE
          || !url.searchParams.get('state')
          || !callbackBaseUrl
        ) {
          call.responseKind = 'invalid-authorize';
          return json(res, 400, { error: 'invalid authorization request' });
        }
        const callback = new URL('/oauth/fusionsolar/callback', callbackBaseUrl);
        callback.searchParams.set('code', FIXTURE_CODE);
        callback.searchParams.set('state', url.searchParams.get('state'));
        call.responseKind = 'authorize-redirect';
        res.writeHead(302, {
          Location: callback.toString(),
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        return res.end();
      }

      if (req.method === 'POST' && url.pathname === TOKEN_PATH) {
        const body = new URLSearchParams(await readBody(req));
        const grantType = body.get('grant_type');
        const call = record({
          method: req.method,
          path: url.pathname,
          grantType,
          form: redactForm(body),
        });
        if (body.get('client_id') !== clientId || body.get('client_secret') !== clientSecret) {
          call.responseKind = 'invalid-client';
          return json(res, 401, { error: 'invalid client' });
        }
        if (
          grantType === 'authorization_code'
          && body.get('code') === FIXTURE_CODE
          && body.get('redirect_uri') === redirectUri
        ) {
          call.responseKind = 'code-token';
          return json(res, 200, tokenPayload(
            currentAccessToken,
            currentRefreshToken,
            3600,
          ), { 'Cache-Control': 'no-store' });
        }
        if (grantType === 'refresh_token' && body.get('refresh_token') === currentRefreshToken) {
          refreshSequence += 1;
          currentAccessToken = `obviously-fake-access-token-${refreshSequence}`;
          currentRefreshToken = `obviously-fake-refresh-token-${refreshSequence}`;
          call.responseKind = 'refresh-token';
          return json(res, 200, tokenPayload(
            currentAccessToken,
            currentRefreshToken,
            3600,
          ), { 'Cache-Control': 'no-store' });
        }
        call.responseKind = 'invalid-grant';
        return json(res, 400, { error: 'invalid grant' }, { 'Cache-Control': 'no-store' });
      }

      if (req.method === 'POST' && isApiPath(url.pathname)) {
        const rawBody = await readBody(req);
        const parsedBody = parseJson(rawBody);
        const call = record({
          method: req.method,
          path: url.pathname,
          json: parsedBody,
        });
        if (
          req.headers.authorization !== `Bearer ${currentAccessToken}`
          || consume(rejectOnce, url.pathname)
        ) {
          call.responseKind = 'unauthorized';
          return json(res, 401, { error: 'unauthorized' });
        }
        if (consume(throttleOnce, url.pathname)) {
          call.responseKind = 'flow-controlled';
          return json(res, 429, { error: 'flow controlled' }, { 'Retry-After': '0' });
        }
        return handleApi(url.pathname, parsedBody, call, res);
      }

      return json(res, 404, { error: 'not found' });
    } catch {
      return json(res, 500, { error: 'fake server error' });
    }
  });

  function handleApi(pathname, body, call, res) {
    const currentTime = currentTimeMs(now);
    if (pathname === '/thirdData/stations') {
      const pageNo = Number(body?.pageNo);
      const pages = [
        [{
          plantCode: 'SOMBOR-A',
          plantName: 'Sombor A',
          capacity: 100,
          gridConnectionDate: new Date(currentTime - 3 * 86_400_000).toISOString(),
        }],
        [{
          plantCode: 'SOMBOR-B',
          plantName: 'Sombor B',
          capacity: 200,
          gridConnectionDate: new Date(currentTime - 3 * 86_400_000).toISOString(),
        }],
      ];
      if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > pages.length) {
        call.responseKind = 'invalid-page';
        return json(res, 400, { error: 'invalid page' });
      }
      call.responseKind = `plants-page-${pageNo}`;
      return success(res, {
        list: pages[pageNo - 1],
        pageNo,
        pageCount: pages.length,
      });
    }
    if (pathname === '/thirdData/getDevList') {
      const stationCodes = String(body?.stationCodes || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (stationCodes.length > 100) {
        call.responseKind = 'device-batch-too-large';
        return json(res, 200, {
          success: false,
          failCode: 20015,
          data: null,
        });
      }
      const requested = new Set(stationCodes);
      call.responseKind = 'devices-batch';
      return success(res, [
        device('inverter-a', 'SOMBOR-A', 'NE=FAKE-INVERTER-A', 'FAKE-A'),
        device('inverter-b', 'SOMBOR-B', 'NE=FAKE-INVERTER-B', 'FAKE-B'),
      ].filter((row) => requested.has(row.stationCode)));
    }
    if (pathname === '/thirdData/getStationRealKpi') {
      const requested = new Set(String(body?.stationCodes || '').split(','));
      call.responseKind = 'plant-live';
      return success(res, [
        plantKpi('SOMBOR-A', 11.5),
        plantKpi('SOMBOR-B', 22.5),
      ].filter((row) => requested.has(row.stationCode)), currentTime);
    }
    if (pathname === '/thirdData/getDevRealKpi') {
      const requested = new Set(String(body?.devIds || '').split(','));
      call.responseKind = 'device-live';
      return success(res, [
        deviceKpi('inverter-a', 10.5),
        deviceKpi('inverter-b', 20.5),
      ].filter((row) => requested.has(String(row.devId))), currentTime);
    }
    if (pathname === HISTORY_PATH) {
      const history = historyRows(body, currentTime);
      call.responseKind = history.length === 0 ? 'empty-retention' : 'history';
      return success(res, history);
    }
    call.responseKind = 'unexpected-api';
    return json(res, 404, { error: 'not found' });
  }

  function record(call) {
    recordedCalls.push(call);
    return call;
  }

  return {
    async listen() {
      if (server.listening) return baseUrl;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      return baseUrl;
    },
    setCallbackBaseUrl(value) {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('callback base URL must be HTTP(S)');
      }
      callbackBaseUrl = parsed.origin;
    },
    rejectNext(pathname) {
      increment(rejectOnce, pathname);
    },
    throttleNext(pathname) {
      increment(throttleOnce, pathname);
    },
    calls() {
      return recordedCalls.map((call) => structuredClone(call));
    },
    countCalls(pathname, grantType) {
      return recordedCalls.filter((call) => (
        call.path === pathname && (grantType === undefined || call.grantType === grantType)
      )).length;
    },
    plaintextTokenMarkers() {
      return [
        'obviously-fake-access-token',
        'obviously-fake-refresh-token',
      ];
    },
    fetchAsAuthorized(pathname, options = {}) {
      if (!baseUrl) throw new Error('fake Huawei is not listening');
      const headers = new Headers(options.headers);
      headers.set('Authorization', `Bearer ${currentAccessToken}`);
      return fetch(`${baseUrl}${pathname}`, { ...options, headers });
    },
    exchangeFixtureCode() {
      if (!baseUrl) throw new Error('fake Huawei is not listening');
      return fetch(`${baseUrl}${TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: FIXTURE_CODE,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      });
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function isApiPath(pathname) {
  return pathname.startsWith('/thirdData/') || pathname === HISTORY_PATH;
}

function device(id, stationCode, devDn, esnCode) {
  return {
    id,
    stationCode,
    devTypeId: 1,
    devDn,
    devName: `Fake inverter ${id}`,
    model: 'SUN2000-FAKE',
    esnCode,
  };
}

function plantKpi(stationCode, dailyYield) {
  return {
    stationCode,
    dataItemMap: {
      day_power: dailyYield,
      month_power: dailyYield * 10,
      total_power: dailyYield * 100,
    },
  };
}

function deviceKpi(devId, activePower) {
  return {
    devId,
    dataItemMap: {
      active_power: activePower,
      day_cap: activePower * 2,
      total_cap: activePower * 100,
    },
  };
}

function historyRows(body, currentTime) {
  const devDn = body?.devDn;
  const startTime = Number(body?.startTime);
  const endTime = Number(body?.endTime);
  if (
    !['NE=FAKE-INVERTER-A', 'NE=FAKE-INVERTER-B'].includes(devDn)
    || !Number.isFinite(startTime)
    || !Number.isFinite(endTime)
  ) {
    return [];
  }
  const offset = devDn.endsWith('-A') ? 0 : 0.25;
  return [
    currentTime - 60 * 60_000,
    currentTime - 25 * 60 * 60_000,
  ].filter((timestamp) => timestamp >= startTime && timestamp <= endTime)
    .map((collectTime, index) => ({
      devDn,
      collectTime,
      dataItems: {
        active_power: 7 + offset + index,
        day_cap: 14 + offset + index,
        total_cap: 700 + offset + index,
      },
    }));
}

function tokenPayload(accessToken, refreshToken, expiresIn) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    scope: REQUIRED_SCOPE,
    token_type: 'Bearer',
  };
}

function success(res, data, currentTime) {
  return json(res, 200, {
    success: true,
    failCode: 0,
    data,
    ...(currentTime === undefined ? {} : { params: { currentTime } }),
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function redactQuery(searchParams) {
  return Object.fromEntries(
    [...searchParams.keys()].map((key) => [key, '[REDACTED]']),
  );
}

function redactForm(searchParams) {
  return Object.fromEntries(
    [...searchParams.keys()].map((key) => [key, '[REDACTED]']),
  );
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function consume(map, key) {
  const count = map.get(key) || 0;
  if (count === 0) return false;
  if (count === 1) map.delete(key);
  else map.set(key, count - 1);
  return true;
}

function currentTimeMs(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('fake Huawei clock returned an invalid date');
  }
  return value.getTime();
}

module.exports = { createFakeHuaweiServer };
