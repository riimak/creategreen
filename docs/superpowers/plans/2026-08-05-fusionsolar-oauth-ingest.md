# FusionSolar OAuth and Data Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated FusionSolar service that completes Huawei OAuth, securely manages tokens, discovers every authorized plant, and continuously stores live and historical measurements without changing the existing Mars2 ingestion path.

**Architecture:** A new internal Node.js service owns Huawei credentials, OAuth, polling, normalization, and PostgreSQL persistence. The public Deno dashboard proxies only the registered `/oauth/fusionsolar/*` routes to that service. Numeric observations use the existing `raw_measurements` table; FusionSolar metadata, encrypted credentials, nonces, and checkpoints use dedicated tables.

**Tech Stack:** Node.js 22 CommonJS, built-in `node:test`, Web Crypto/`node:crypto`, native `fetch`, PostgreSQL through the existing `database/pg-pool.js`, Deno dashboard, Docker Compose, GitLab CI, Kubernetes Helm values and NetworkPolicy.

## Global Constraints

- Keep the existing Mars2/SOLAX ingest unchanged and independently operational.
- Use OAuth 2.0 Authorization Code with callback `https://bios-multilevel.barrage.net/oauth/fusionsolar/callback`.
- Request only `pvms.openapi.basic`; do not add control APIs.
- Ingest every plant the owner authorizes.
- Never log authorization codes, access tokens, refresh tokens, client secrets, encryption keys, setup tokens, or complete secret-bearing URLs.
- Encrypt OAuth tokens with AES-256-GCM before database persistence.
- Live polling always has priority over historical backfill.
- Backfill progressively to the oldest history Huawei exposes; do not hardcode an assumed retention period.
- Do not write to Mars2 in this release. Preserve a normalized boundary for a later `postRawDataInput` publisher.
- Do not add FusionSolar-specific UI work unless verification proves the existing dynamic measurement UI cannot display the new sources.
- Do not create git commits during execution unless the user explicitly authorizes commits.

## Planned File Structure

### New FusionSolar service

- `bios-multilevel-platform-services/fusionsolar/config.js` — parse and validate environment configuration.
- `bios-multilevel-platform-services/fusionsolar/crypto.js` — AES-256-GCM token encryption.
- `bios-multilevel-platform-services/fusionsolar/oauth-state.js` — signed, expiring OAuth state.
- `bios-multilevel-platform-services/fusionsolar/store.js` — FusionSolar metadata, credential, nonce, checkpoint, and measurement persistence.
- `bios-multilevel-platform-services/fusionsolar/huawei-client.js` — OAuth and authenticated Huawei HTTP client.
- `bios-multilevel-platform-services/fusionsolar/metric-registry.js` — explicit Huawei KPI normalization.
- `bios-multilevel-platform-services/fusionsolar/sync.js` — inventory, live sync, and resumable backfill.
- `bios-multilevel-platform-services/fusionsolar/server.js` — HTTP routes, scheduler, health, and status.
- `bios-multilevel-platform-services/fusionsolar/package.json` — test scripts and service metadata.
- `bios-multilevel-platform-services/fusionsolar/Dockerfile` — Node 22 runtime.
- `bios-multilevel-platform-services/fusionsolar/.gitlab/auto-deploy-values.yaml` — internal service deployment.
- `bios-multilevel-platform-services/fusionsolar/test/*.test.js` — unit and integration tests.

### Existing files

- `bios-multilevel-platform-services/database/schema.sql` — dedicated FusionSolar tables.
- `bios-multilevel-platform-services/dashboard/oauth-proxy.ts` — isolated strict proxy helper.
- `bios-multilevel-platform-services/dashboard/oauth-proxy_test.ts` — Deno proxy tests.
- `bios-multilevel-platform-services/dashboard/main.ts` — route the public OAuth prefix.
- `bios-multilevel-platform-services/dashboard/.gitlab/auto-deploy-values.yaml` — internal service URL.
- `bios-multilevel-platform-services/docker-compose.yml` — local FusionSolar service.
- `bios-multilevel-platform-services/deploy/network-policies.yaml` — dashboard-to-FusionSolar ingress.
- `.gitlab-ci.yml` — image build, deploy, and protected variable forwarding.
- `.env.example` — non-secret configuration contract.

---

### Task 1: Service Configuration and Health Skeleton

**Files:**
- Create: `bios-multilevel-platform-services/fusionsolar/package.json`
- Create: `bios-multilevel-platform-services/fusionsolar/config.js`
- Create: `bios-multilevel-platform-services/fusionsolar/server.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/config.test.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/server.test.js`

**Interfaces:**
- Produces: `loadConfig(env): FusionSolarConfig`
- Produces: `configurationState(config): "configured" | "not_configured"`
- Produces: `createServer({ config, integration }): http.Server`
- `FusionSolarConfig` contains `port`, `clientId`, `clientSecret`, `redirectUri`, `setupToken`, `tokenEncryptionKey`, `oauthBaseUrl`, `apiBaseUrl`, `databaseUrl`, `liveIntervalMs`, `inventoryIntervalMs`, `requestTimeoutMs`, and `backfillEnabled`.

- [ ] **Step 1: Write configuration tests**

```js
// fusionsolar/test/config.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, configurationState } = require('../config');

test('loads conservative defaults and reports missing secrets', () => {
  const config = loadConfig({});
  assert.equal(config.port, 8093);
  assert.equal(config.liveIntervalMs, 5 * 60_000);
  assert.equal(config.requestTimeoutMs, 20_000);
  assert.equal(config.backfillEnabled, true);
  assert.equal(configurationState(config), 'not_configured');
});

test('requires an exact 32-byte base64 encryption key when configured', () => {
  const env = {
    DATABASE_URL: 'postgresql://bios:bios@postgres/bios',
    FUSIONSOLAR_CLIENT_ID: '123456789',
    FUSIONSOLAR_CLIENT_SECRET: 'secret',
    FUSIONSOLAR_REDIRECT_URI: 'https://bios-multilevel.barrage.net/oauth/fusionsolar/callback',
    FUSIONSOLAR_SETUP_TOKEN: 'x'.repeat(48),
    FUSIONSOLAR_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    FUSIONSOLAR_OAUTH_BASE_URL: 'https://oauth2.fusionsolar.huawei.com',
    FUSIONSOLAR_API_BASE_URL: 'https://region.example.com',
  };
  assert.equal(configurationState(loadConfig(env)), 'configured');
  assert.throws(
    () => loadConfig({ ...env, FUSIONSOLAR_TOKEN_ENCRYPTION_KEY: 'bad' }),
    /32 bytes/,
  );
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
node --test "bios-multilevel-platform-services/fusionsolar/test/config.test.js"
```

Expected: FAIL with `Cannot find module '../config'`.

- [ ] **Step 3: Implement the configuration boundary**

```js
// fusionsolar/config.js
function positiveInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function encryptionKey(raw) {
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('FUSIONSOLAR_TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
  return key;
}

function loadConfig(env = process.env) {
  return Object.freeze({
    port: positiveInt(env.FUSIONSOLAR_PORT, 8093, 'FUSIONSOLAR_PORT'),
    clientId: env.FUSIONSOLAR_CLIENT_ID || '',
    clientSecret: env.FUSIONSOLAR_CLIENT_SECRET || '',
    redirectUri: env.FUSIONSOLAR_REDIRECT_URI || '',
    setupToken: env.FUSIONSOLAR_SETUP_TOKEN || '',
    tokenEncryptionKey: encryptionKey(env.FUSIONSOLAR_TOKEN_ENCRYPTION_KEY),
    oauthBaseUrl: env.FUSIONSOLAR_OAUTH_BASE_URL || 'https://oauth2.fusionsolar.huawei.com',
    apiBaseUrl: env.FUSIONSOLAR_API_BASE_URL || '',
    databaseUrl: env.DATABASE_URL || '',
    liveIntervalMs: positiveInt(env.FUSIONSOLAR_LIVE_INTERVAL_SECONDS, 300, 'FUSIONSOLAR_LIVE_INTERVAL_SECONDS') * 1000,
    inventoryIntervalMs: positiveInt(env.FUSIONSOLAR_INVENTORY_INTERVAL_SECONDS, 3600, 'FUSIONSOLAR_INVENTORY_INTERVAL_SECONDS') * 1000,
    requestTimeoutMs: positiveInt(env.FUSIONSOLAR_REQUEST_TIMEOUT_SECONDS, 20, 'FUSIONSOLAR_REQUEST_TIMEOUT_SECONDS') * 1000,
    backfillEnabled: env.FUSIONSOLAR_BACKFILL_ENABLED !== 'false',
  });
}

function configurationState(config) {
  return config.clientId && config.clientSecret && config.redirectUri
    && config.setupToken && config.tokenEncryptionKey
    && config.apiBaseUrl && config.databaseUrl
    ? 'configured'
    : 'not_configured';
}

module.exports = { loadConfig, configurationState };
```

- [ ] **Step 4: Add a minimal injectable HTTP server and tests**

```js
// fusionsolar/test/server.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

test('health remains healthy when Huawei is not configured', async (t) => {
  const server = createServer({
    config: { port: 0 },
    integration: { status: async () => ({ state: 'not_configured' }) },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'fusionsolar' });
});
```

```js
// fusionsolar/server.js
const http = require('node:http');

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function createServer({ integration }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://internal');
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'fusionsolar' });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, await integration.status());
    }
    return json(res, 404, { error: 'not found' });
  });
}

module.exports = { createServer };
```

- [ ] **Step 5: Add the package test command and run tests**

```json
{
  "name": "bios-fusionsolar",
  "private": true,
  "version": "1.0.0",
  "scripts": {
    "test": "node --test test/*.test.js"
  }
}
```

Run:

```powershell
Set-Location "bios-multilevel-platform-services/fusionsolar"
npm test
```

Expected: all configuration and health tests PASS.

- [ ] **Step 6: Review checkpoint**

Inspect the diff for Task 1. If the user has explicitly authorized commits, commit with:

```powershell
git add "bios-multilevel-platform-services/fusionsolar"
git commit -m "feat: scaffold FusionSolar integration service"
```

Otherwise leave the task uncommitted and continue.

---

### Task 2: Database Schema, Encryption, and Store

**Files:**
- Modify: `bios-multilevel-platform-services/database/schema.sql`
- Create: `bios-multilevel-platform-services/fusionsolar/crypto.js`
- Create: `bios-multilevel-platform-services/fusionsolar/store.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/crypto.test.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/store.test.js`

**Interfaces:**
- Consumes: existing `createPool(databaseUrl, opts)` from `database/pg-pool.js`.
- Produces: `createTokenCipher(key): { encrypt(plaintext), decrypt(envelope) }`.
- Produces: `createFusionSolarStore({ databaseUrl, cipher }): FusionSolarStore`.
- `FusionSolarStore` methods: `init`, `createNonce`, `consumeNonce`, `saveCredentials`, `loadCredentials`, `setAuthorizationState`, `upsertPlants`, `upsertDevices`, `saveMeasurements`, `getCheckpoint`, `setCheckpoint`, `status`, and `close`.

- [ ] **Step 1: Extend the schema**

Add idempotent DDL:

```sql
CREATE TABLE IF NOT EXISTS fusionsolar_oauth_credentials (
  id                    TEXT PRIMARY KEY DEFAULT 'active',
  encrypted_access_token JSONB,
  encrypted_refresh_token JSONB,
  access_expires_at     TIMESTAMPTZ,
  granted_scopes        TEXT[] NOT NULL DEFAULT '{}',
  token_type            TEXT,
  state                 TEXT NOT NULL DEFAULT 'not_authorized',
  last_error            TEXT,
  authorized_at         TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fusionsolar_oauth_nonces (
  nonce_hash       TEXT PRIMARY KEY,
  expires_at       TIMESTAMPTZ NOT NULL,
  consumed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fusionsolar_plants (
  plant_code       TEXT PRIMARY KEY,
  source_key       TEXT NOT NULL UNIQUE,
  display_name     TEXT,
  timezone         TEXT,
  visible          BOOLEAN NOT NULL DEFAULT TRUE,
  metadata         JSONB NOT NULL DEFAULT '{}',
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fusionsolar_devices (
  device_id        TEXT PRIMARY KEY,
  plant_code       TEXT NOT NULL REFERENCES fusionsolar_plants(plant_code) ON DELETE CASCADE,
  device_type      TEXT,
  model            TEXT,
  serial_number    TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}',
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fusionsolar_devices_plant
  ON fusionsolar_devices (plant_code);

CREATE TABLE IF NOT EXISTS fusionsolar_sync_state (
  sync_key         TEXT PRIMARY KEY,
  checkpoint       JSONB NOT NULL DEFAULT '{}',
  backoff_until    TIMESTAMPTZ,
  last_success_at  TIMESTAMPTZ,
  last_error       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Write cipher tests and verify failure**

```js
// fusionsolar/test/crypto.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenCipher } = require('../crypto');

test('encrypts with unique IVs and rejects tampering', () => {
  const cipher = createTokenCipher(Buffer.alloc(32, 3));
  const first = cipher.encrypt('refresh-secret');
  const second = cipher.encrypt('refresh-secret');
  assert.notEqual(first.iv, second.iv);
  assert.equal(cipher.decrypt(first), 'refresh-secret');
  assert.throws(() => cipher.decrypt({ ...first, tag: Buffer.alloc(16).toString('base64') }));
});
```

Run:

```powershell
node --test "bios-multilevel-platform-services/fusionsolar/test/crypto.test.js"
```

Expected: FAIL with `Cannot find module '../crypto'`.

- [ ] **Step 3: Implement AES-256-GCM**

```js
// fusionsolar/crypto.js
const crypto = require('node:crypto');

function createTokenCipher(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('token cipher requires 32-byte key');
  return {
    encrypt(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return {
        version: 1,
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      };
    },
    decrypt(envelope) {
      if (envelope?.version !== 1) throw new Error('unsupported token envelope');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

module.exports = { createTokenCipher };
```

- [ ] **Step 4: Write store contract tests**

Use a fake pool for SQL contract tests and a real PostgreSQL integration test when `TEST_DATABASE_URL` exists:

```js
test('nonce consumption is single-use', async () => {
  const store = createMemoryCompatibleStoreForTest();
  await store.createNonce('hash', new Date(Date.now() + 60_000));
  assert.equal(await store.consumeNonce('hash', new Date()), true);
  assert.equal(await store.consumeNonce('hash', new Date()), false);
});

test('measurement writes preserve the raw_measurements natural key', async () => {
  const result = await store.saveMeasurements([
    { source: 'HUAWEI:plant-1', metric: 'huawei.plant.active_power_kw', ts: '2026-08-05T10:00:00Z', value: 12.5, isMissing: false },
  ]);
  assert.equal(result.upserted, 1);
});
```

- [ ] **Step 5: Implement the PostgreSQL store**

Key SQL must be parameterized. Token persistence encrypts before query:

```js
async function saveCredentials(tokens) {
  await pool.query(
    `INSERT INTO fusionsolar_oauth_credentials
       (id, encrypted_access_token, encrypted_refresh_token, access_expires_at,
        granted_scopes, token_type, state, authorized_at, updated_at)
     VALUES ('active',$1,$2,$3,$4,$5,'authorized',now(),now())
     ON CONFLICT (id) DO UPDATE SET
       encrypted_access_token=EXCLUDED.encrypted_access_token,
       encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,
       access_expires_at=EXCLUDED.access_expires_at,
       granted_scopes=EXCLUDED.granted_scopes,
       token_type=EXCLUDED.token_type,
       state='authorized', last_error=NULL, updated_at=now()`,
    [
      cipher.encrypt(tokens.accessToken),
      cipher.encrypt(tokens.refreshToken),
      tokens.accessExpiresAt,
      tokens.scopes,
      tokens.tokenType,
    ],
  );
}
```

`consumeNonce` must use one atomic update:

```sql
UPDATE fusionsolar_oauth_nonces
SET consumed_at = now()
WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > $2
RETURNING nonce_hash
```

`saveMeasurements` must batch parameterized rows and use:

```sql
ON CONFLICT (source, metric, ts) DO UPDATE
SET value=EXCLUDED.value, is_missing=EXCLUDED.is_missing, ingested_at=now()
```

- [ ] **Step 6: Run store and crypto tests**

Run:

```powershell
node --test "bios-multilevel-platform-services/fusionsolar/test/crypto.test.js" "bios-multilevel-platform-services/fusionsolar/test/store.test.js"
```

Expected: all tests PASS; PostgreSQL-only test SKIP when `TEST_DATABASE_URL` is absent.

- [ ] **Step 7: Review checkpoint**

If commits are authorized:

```powershell
git add "bios-multilevel-platform-services/database/schema.sql" "bios-multilevel-platform-services/fusionsolar"
git commit -m "feat: add encrypted FusionSolar persistence"
```

---

### Task 3: OAuth State and Huawei Token Client

**Files:**
- Create: `bios-multilevel-platform-services/fusionsolar/oauth-state.js`
- Create: `bios-multilevel-platform-services/fusionsolar/huawei-client.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/oauth-state.test.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/huawei-client.test.js`

**Interfaces:**
- Produces: `createStateManager({ secret, store, now }): { issue(), verifyAndConsume(state) }`.
- Produces: `createHuaweiClient({ config, store, fetchImpl, now, sleep }): HuaweiClient`.
- `HuaweiClient` methods: `authorizationUrl(state)`, `exchangeCode(code)`, `getAccessToken()`, `request(path, options)`.

- [ ] **Step 1: Write state lifecycle tests**

Test valid state, modified signature, expiry, and replay:

```js
test('state is signed, expiring, and single-use', async () => {
  const manager = createStateManager({
    secret: Buffer.alloc(32, 1),
    store,
    now: () => new Date('2026-08-05T10:00:00Z'),
  });
  const state = await manager.issue();
  assert.equal(await manager.verifyAndConsume(state), true);
  await assert.rejects(() => manager.verifyAndConsume(state), /already used|invalid/);
  await assert.rejects(() => manager.verifyAndConsume(`${state}x`), /signature/);
});
```

- [ ] **Step 2: Implement signed state**

Use `base64url(payload).base64url(HMAC-SHA256(payload))`. The payload contains only `nonce` and `iat`; store only `sha256(nonce)`. Use `crypto.timingSafeEqual` and a 10-minute maximum age.

- [ ] **Step 3: Write Huawei client tests with injected fetch**

Cover exact authorize parameters, form-encoded code exchange, early refresh,
single-flight refresh, one retry on `401`, `Retry-After`, and redacted errors:

```js
test('authorization URL uses the registered callback and basic scope', () => {
  const url = new URL(client.authorizationUrl('signed-state'));
  assert.equal(url.pathname, '/rest/dp/uidm/oauth2/v1/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('scope'), 'pvms.openapi.basic');
});

test('exchange sends application/x-www-form-urlencoded', async () => {
  await client.exchangeCode('short-lived-code');
  assert.equal(request.method, 'POST');
  assert.match(request.headers['Content-Type'], /application\/x-www-form-urlencoded/);
  assert.equal(new URLSearchParams(request.body).get('grant_type'), 'authorization_code');
});
```

- [ ] **Step 4: Implement token operations**

Use Huawei endpoints:

```js
const AUTHORIZE_PATH = '/rest/dp/uidm/oauth2/v1/authorize';
const TOKEN_PATH = '/rest/dp/uidm/oauth2/v1/token';
```

Code exchange body:

```js
new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  client_id: config.clientId,
  client_secret: config.clientSecret,
  redirect_uri: config.redirectUri,
});
```

Refresh body:

```js
new URLSearchParams({
  grant_type: 'refresh_token',
  refresh_token: credentials.refreshToken,
  client_id: config.clientId,
  client_secret: config.clientSecret,
});
```

Normalize token responses to:

```js
{
  accessToken,
  refreshToken,
  accessExpiresAt: new Date(now().getTime() + expiresIn * 1000),
  scopes: scope.split(/\s+/).filter(Boolean),
  tokenType: 'Bearer',
}
```

Refresh at least 60 seconds before expiry. Preserve the previous refresh token
only if Huawei omits a replacement. On permanent refresh failure call
`store.setAuthorizationState('reauthorization_required', safeMessage)`.

- [ ] **Step 5: Run OAuth tests**

Run:

```powershell
node --test "bios-multilevel-platform-services/fusionsolar/test/oauth-state.test.js" "bios-multilevel-platform-services/fusionsolar/test/huawei-client.test.js"
```

Expected: all tests PASS and no captured log contains fixture secrets.

- [ ] **Step 6: Review checkpoint**

If commits are authorized:

```powershell
git add "bios-multilevel-platform-services/fusionsolar"
git commit -m "feat: implement FusionSolar OAuth lifecycle"
```

---

### Task 4: Inventory and Metric Normalization

**Files:**
- Create: `bios-multilevel-platform-services/fusionsolar/metric-registry.js`
- Create: `bios-multilevel-platform-services/fusionsolar/sync.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/metric-registry.test.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/inventory.test.js`

**Interfaces:**
- Produces: `normalizePlant(raw): FusionSolarPlant`.
- Produces: `normalizeDevice(raw, plantCode): FusionSolarDevice`.
- Produces: `normalizeKpis({ source, deviceType, timestamp, payload }): Measurement[]`.
- Produces: `createSynchronizer({ client, store, config, now, sleep }): Synchronizer`.
- `Synchronizer` methods: `refreshInventory`, `runLiveCycle`, `runBackfillStep`, `status`.

- [ ] **Step 1: Write fixture-based normalization tests**

Create minimal sanitized Huawei-shaped fixtures based on the 26.1 response
contracts. Assert stable source keys, timestamp interpretation, numeric-only
output, unit conversion, and unknown-field reporting:

```js
test('maps verified plant power and yield without borrowing SOLAX names', () => {
  const result = normalizeKpis({
    source: 'HUAWEI:plant-1',
    deviceType: 'plant',
    timestamp: 1785924000000,
    payload: { active_power: 12.5, day_power: 91.2, unknown_text: 'running' },
  });
  assert.deepEqual(result.measurements, [
    { source: 'HUAWEI:plant-1', metric: 'huawei.plant.active_power_kw', ts: '2026-08-05T10:00:00.000Z', value: 12.5, isMissing: false },
    { source: 'HUAWEI:plant-1', metric: 'huawei.plant.daily_yield_kwh', ts: '2026-08-05T10:00:00.000Z', value: 91.2, isMissing: false },
  ]);
  assert.deepEqual(result.skipped, ['unknown_text']);
});
```

Before finalizing field names, cross-check every mapping against the attached
SmartPVMS 26.1 PDF. Do not infer units from names.

- [ ] **Step 2: Implement an explicit registry**

```js
const REGISTRY = Object.freeze({
  plant: Object.freeze({
    active_power: { metric: 'huawei.plant.active_power_kw', convert: Number },
    day_power: { metric: 'huawei.plant.daily_yield_kwh', convert: Number },
  }),
});
```

Keep endpoint, Huawei field, device type, units, and conversion together in
each registry entry. Reject non-finite values.

- [ ] **Step 3: Write inventory tests**

The fake client returns multiple pages and two plants. Assert that every page
is consumed, both plants are stored, devices remain attached to the correct
plant, and a missing plant on a later refresh becomes `visible=false` rather
than being deleted.

- [ ] **Step 4: Implement paginated inventory discovery**

Use the 26.1 Plant List and Device List API request/response shapes. Keep API
paths in named constants. Pagination must stop on the documented terminal
condition, with a hard safety cap that raises a sanitized error if Huawei
returns a repeating page.

Create source keys as:

```js
function sourceKey(plantCode) {
  return `HUAWEI:${String(plantCode).trim()}`;
}
```

- [ ] **Step 5: Run normalization and inventory tests**

Run:

```powershell
node --test "bios-multilevel-platform-services/fusionsolar/test/metric-registry.test.js" "bios-multilevel-platform-services/fusionsolar/test/inventory.test.js"
```

Expected: all tests PASS.

- [ ] **Step 6: Review checkpoint**

If commits are authorized:

```powershell
git add "bios-multilevel-platform-services/fusionsolar"
git commit -m "feat: discover and normalize FusionSolar assets"
```

---

### Task 5: Live Ingestion and Resumable Maximum Backfill

**Files:**
- Modify: `bios-multilevel-platform-services/fusionsolar/sync.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/live-sync.test.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/backfill.test.js`

**Interfaces:**
- Consumes: `HuaweiClient.request`, store inventory and checkpoint methods, and `normalizeKpis`.
- Produces: live cycle result `{ plants, devices, measurements, skipped, failures }`.
- Produces: backfill result `{ state, nextBefore, rows, reachedBoundary }`.

- [ ] **Step 1: Write live-cycle tests**

Test:

- inventory refresh is performed when stale;
- every visible plant and supported device is polled;
- one malformed device does not abort another;
- writes are batched and idempotent;
- checkpoints advance only after the corresponding measurement transaction;
- a `429` stores backoff and stops lower-priority work.

```js
test('live polling survives one device failure', async () => {
  const result = await synchronizer.runLiveCycle();
  assert.equal(result.measurements, 4);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].scope, /device-bad/);
  assert.equal(store.savedMeasurements.length, 4);
});
```

- [ ] **Step 2: Implement live collection**

Call the Huawei real-time plant and device endpoints documented in 26.1.
Group requests according to documented list-size limits. Use the response
collection timestamp, not local receipt time, for `raw_measurements.ts`.

Serialize overlapping cycles:

```js
let liveRun = null;
async function runLiveCycle() {
  if (liveRun) return liveRun;
  liveRun = doLiveCycle().finally(() => { liveRun = null; });
  return liveRun;
}
```

- [ ] **Step 3: Write backwards backfill tests**

Test a fake history endpoint that:

- returns data for two windows;
- rejects an oversized first window;
- returns `429` with `Retry-After`;
- resumes from the persisted `before` checkpoint after a simulated restart;
- eventually returns no earlier data.

Assert that live work is checked before each backfill batch and that no fixed
historical cutoff is imposed.

- [ ] **Step 4: Implement one bounded backfill step**

`runBackfillStep()` performs at most one Huawei history request per invocation.
It:

1. selects the next eligible device checkpoint;
2. skips while backoff is active;
3. computes the current request window;
4. fetches and normalizes the historical response;
5. transactionally saves rows and the next `before` checkpoint;
6. halves the window on a documented range-size rejection; and
7. marks `reachedBoundary=true` only after a successful empty response at the
   oldest attempted boundary.

The scheduler calls one backfill step only after a live cycle or during idle
time. This prevents a large backfill loop from exhausting Huawei flow limits.

- [ ] **Step 5: Run sync tests**

Run:

```powershell
node --test "bios-multilevel-platform-services/fusionsolar/test/live-sync.test.js" "bios-multilevel-platform-services/fusionsolar/test/backfill.test.js"
```

Expected: all tests PASS.

- [ ] **Step 6: Review checkpoint**

If commits are authorized:

```powershell
git add "bios-multilevel-platform-services/fusionsolar"
git commit -m "feat: ingest live and historical FusionSolar data"
```

---

### Task 6: OAuth HTTP Routes, Scheduler, and Sanitized Status

**Files:**
- Modify: `bios-multilevel-platform-services/fusionsolar/server.js`
- Create: `bios-multilevel-platform-services/fusionsolar/integration.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/oauth-routes.test.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/scheduler.test.js`

**Interfaces:**
- Produces: `createIntegration({ config, store, client, stateManager, synchronizer, clock })`.
- Integration methods: `startUrl(setupToken)`, `completeCallback(params)`, `startScheduler`, `stopScheduler`, and `status`.

- [ ] **Step 1: Write route tests**

Cover:

- `/start` rejects missing/wrong setup token with `404` rather than revealing configuration;
- valid `/start` returns `302` to Huawei;
- callback errors produce a safe HTML result;
- valid callback verifies state before exchanging code;
- callback response and logs contain no code/token;
- `/status` never includes encrypted envelopes or credentials.

- [ ] **Step 2: Implement routes**

Expected route shape:

```js
if (req.method === 'GET' && url.pathname === '/oauth/fusionsolar/start') {
  const location = await integration.startUrl(url.searchParams.get('setup_token') || '');
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', Referrer-Policy: 'no-referrer' });
  return res.end();
}

if (req.method === 'GET' && url.pathname === '/oauth/fusionsolar/callback') {
  const result = await integration.completeCallback(url.searchParams);
  res.writeHead(result.ok ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  return res.end(result.ok ? '<h1>FusionSolar authorization completed</h1>' : '<h1>FusionSolar authorization failed</h1>');
}
```

Compare setup tokens with a SHA-256 digest plus `timingSafeEqual`. Never log
`req.url` for OAuth routes because it contains setup token, code, and state.

- [ ] **Step 3: Write deterministic scheduler tests**

Inject timers/clock. Assert:

- service starts as `not_configured` without secrets;
- configured but unauthorized service does not poll;
- authorized service runs live sync immediately and then at the configured cadence;
- one backfill step follows successful live work;
- shutdown clears timers and closes the store.

- [ ] **Step 4: Implement integration composition and process entrypoint**

When `server.js` is executed directly:

```js
const config = loadConfig();
const integration = await buildIntegration(config);
const server = createServer({ config, integration });
server.listen(config.port, '0.0.0.0');
integration.startScheduler();

async function shutdown() {
  integration.stopScheduler();
  await integration.close();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

Keep `createServer` import-safe for tests.

- [ ] **Step 5: Run the entire service suite**

Run:

```powershell
Set-Location "bios-multilevel-platform-services/fusionsolar"
npm test
```

Expected: all FusionSolar tests PASS.

- [ ] **Step 6: Review checkpoint**

If commits are authorized:

```powershell
git add "bios-multilevel-platform-services/fusionsolar"
git commit -m "feat: expose secure FusionSolar OAuth routes"
```

---

### Task 7: Strict Dashboard OAuth Proxy

**Files:**
- Create: `bios-multilevel-platform-services/dashboard/oauth-proxy.ts`
- Create: `bios-multilevel-platform-services/dashboard/oauth-proxy_test.ts`
- Modify: `bios-multilevel-platform-services/dashboard/main.ts`

**Interfaces:**
- Produces: `proxyFusionSolarOAuth(req, serviceBase, fetchImpl): Promise<Response>`.
- Only permits `GET /oauth/fusionsolar/start` and
  `GET /oauth/fusionsolar/callback`.

- [ ] **Step 1: Write Deno proxy tests**

Test allowlisted paths, rejected method/path, preserved query string and
redirect, dropped internal/server headers, no CORS headers, and generic
upstream error:

```ts
Deno.test("preserves Huawei redirect without exposing internal host", async () => {
  const response = await proxyFusionSolarOAuth(
    new Request("https://bios-multilevel.barrage.net/oauth/fusionsolar/start?setup_token=opaque"),
    "http://fusionsolar:8093",
    async () => new Response(null, { status: 302, headers: { location: "https://oauth2.fusionsolar.huawei.com/authorize" } }),
  );
  assertEquals(response.status, 302);
  assertEquals(response.headers.get("location"), "https://oauth2.fusionsolar.huawei.com/authorize");
  assertEquals(response.headers.get("server"), null);
});
```

- [ ] **Step 2: Implement the strict helper**

The helper:

- requires method `GET`;
- matches an exact two-path set;
- forwards only `accept`, `user-agent`, and `x-request-id`;
- uses `redirect: "manual"`;
- copies safe response headers including `location`, `content-type`, and
  `cache-control`;
- applies the dashboard security headers; and
- returns `{ "error": "upstream unreachable" }` on network failure.

- [ ] **Step 3: Wire the route into `main.ts`**

Add `FUSIONSOLAR_SERVICE_URL` lookup and route before the generic 404:

```ts
if (url.pathname.startsWith("/oauth/fusionsolar/")) {
  const serviceBase = Deno.env.get("FUSIONSOLAR_SERVICE_URL") || "";
  if (!serviceBase) return json({ error: "FusionSolar service is not configured" }, 502);
  return proxyFusionSolarOAuth(req, serviceBase);
}
```

Do not add OAuth routes to the prediction/blockchain proxy allowlists.

- [ ] **Step 4: Run Deno tests and type checking**

Run:

```powershell
deno test "bios-multilevel-platform-services/dashboard/oauth-proxy_test.ts"
deno check "bios-multilevel-platform-services/dashboard/main.ts"
```

Expected: tests PASS and type check exits 0.

- [ ] **Step 5: Review checkpoint**

If commits are authorized:

```powershell
git add "bios-multilevel-platform-services/dashboard"
git commit -m "feat: proxy FusionSolar OAuth callback"
```

---

### Task 8: Container, Compose, CI, Helm, Network Policy, and Environment Contract

**Files:**
- Create: `bios-multilevel-platform-services/fusionsolar/Dockerfile`
- Create: `bios-multilevel-platform-services/fusionsolar/.gitlab/auto-deploy-values.yaml`
- Modify: `bios-multilevel-platform-services/docker-compose.yml`
- Modify: `bios-multilevel-platform-services/dashboard/.gitlab/auto-deploy-values.yaml`
- Modify: `bios-multilevel-platform-services/deploy/network-policies.yaml`
- Modify: `.gitlab-ci.yml`
- Modify: `.env.example`

**Interfaces:**
- Produces internal service `bios-fusionsolar-production-barrage-autodeploy:8093`.
- Dashboard consumes `FUSIONSOLAR_SERVICE_URL`.

- [ ] **Step 1: Add the Dockerfile**

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY certs/bipa_ca.crt /usr/local/share/ca-certificates/bipa_ca.crt
RUN apk add --no-cache ca-certificates && update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
COPY bios-multilevel-platform-services/fusionsolar ./fusionsolar
COPY bios-multilevel-platform-services/database ./database
RUN cd database && npm install --omit=dev
ENV FUSIONSOLAR_PORT=8093
EXPOSE 8093
CMD ["node", "fusionsolar/server.js"]
```

- [ ] **Step 2: Add Compose service**

Add `fusionsolar` with port 8093, PostgreSQL dependency, healthcheck, and
environment passthrough. Add to dashboard:

```yaml
FUSIONSOLAR_SERVICE_URL: http://fusionsolar:8093
```

Do not provide fake secret defaults. Empty credentials must result in
`not_configured`.

- [ ] **Step 3: Add internal Helm values**

Mirror prediction's internal ClusterIP pattern:

- service port 8093;
- ingress disabled;
- `/health` liveness/readiness/startup probes;
- PostgreSQL CA mount;
- modest 100m/128Mi requests and 500m/256Mi limits;
- non-secret base URLs and callback in `extraEnv`;
- secrets appended by protected CI variables.

- [ ] **Step 4: Extend GitLab CI**

Add `build-fusionsolar` and `production-fusionsolar` jobs. Forward:

```text
FUSIONSOLAR_CLIENT_ID
FUSIONSOLAR_CLIENT_SECRET
FUSIONSOLAR_SETUP_TOKEN
FUSIONSOLAR_TOKEN_ENCRYPTION_KEY
FUSIONSOLAR_API_BASE_URL
FUSIONSOLAR_OAUTH_BASE_URL
FUSIONSOLAR_REDIRECT_URI
FUSIONSOLAR_LIVE_INTERVAL_SECONDS
FUSIONSOLAR_INVENTORY_INTERVAL_SECONDS
FUSIONSOLAR_REQUEST_TIMEOUT_SECONDS
FUSIONSOLAR_BACKFILL_ENABLED
```

Never echo values; log names only. Add `production-fusionsolar` as an optional
dashboard dependency so the dashboard deploy follows the internal service.

- [ ] **Step 5: Add dashboard service URL**

In dashboard Helm values:

```yaml
- name: FUSIONSOLAR_SERVICE_URL
  value: "http://bios-fusionsolar-production-barrage-autodeploy:8093"
```

- [ ] **Step 6: Add NetworkPolicy**

Create a policy selecting
`app: bios-fusionsolar-production-barrage-autodeploy` and allowing ingress on
TCP 8093 only from
`app: bios-dashboard-production-barrage-autodeploy`.

- [ ] **Step 7: Document environment variables**

Add empty secret values and safe defaults to `.env.example`. Include a key
generation command:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set the callback example exactly to the registered URI.

- [ ] **Step 8: Build and smoke-test Compose**

Before starting, inspect running IDE terminals to avoid duplicating an existing
Compose stack.

Run:

```powershell
docker compose -f "bios-multilevel-platform-services/docker-compose.yml" build fusionsolar dashboard
docker compose -f "bios-multilevel-platform-services/docker-compose.yml" up -d postgres fusionsolar dashboard
Invoke-RestMethod "http://localhost:8093/health"
Invoke-RestMethod "http://localhost:8093/status"
Invoke-RestMethod "http://localhost:8000/health"
```

Expected:

- all three health calls succeed;
- FusionSolar status is `not_configured`;
- existing dashboard remains available;
- no Huawei network call occurs without credentials.

- [ ] **Step 9: Review checkpoint**

If commits are authorized:

```powershell
git add ".gitlab-ci.yml" ".env.example" "bios-multilevel-platform-services"
git commit -m "build: deploy FusionSolar integration service"
```

---

### Task 9: End-to-End Fake Huawei Verification and Operational Runbook

**Files:**
- Create: `bios-multilevel-platform-services/fusionsolar/test/fake-huawei.js`
- Create: `bios-multilevel-platform-services/fusionsolar/test/end-to-end.test.js`
- Create: `bios-multilevel-platform-services/fusionsolar/README.md`

**Interfaces:**
- Fake server implements authorize redirect, token exchange, refresh, paginated
  plants/devices, live KPI, history, `401`, `429`, and empty retention boundary.
- Runbook documents configuration, authorization, status, reauthorization,
  credential rotation, and production acceptance.

- [ ] **Step 1: Build the fake Huawei server**

Make fixture behavior deterministic and keep fixture secrets obviously fake.
The server records calls but redacts form fields before test output.

- [ ] **Step 2: Write the end-to-end test**

The test must:

1. initialize the test schema;
2. start fake Huawei and FusionSolar servers;
3. request `/start` with a test setup token;
4. follow the simulated owner authorization callback;
5. verify encrypted—not plaintext—tokens in PostgreSQL;
6. run live sync for two plants;
7. verify expected `HUAWEI:<plantCode>` rows;
8. force access-token expiry and verify refresh;
9. run and resume historical backfill;
10. verify no Mars2 HTTP call was made.

- [ ] **Step 3: Write the operational runbook**

Document:

- required protected CI variables;
- exact registered callback;
- how to generate encryption/setup secrets;
- how to open the one-time authorization URL safely;
- expected `/status` states;
- how to rotate client secret and encryption key;
- how to trigger reauthorization;
- how to inspect plant/device visibility without printing tokens;
- Huawei flow-control behavior;
- acceptance checklist for both Sombor plants; and
- deferred Mars2 prerequisites: provisioned counters, write permission, and
  `counterNodeId` mapping.

- [ ] **Step 4: Run all verification**

Run:

```powershell
node --test "bios-multilevel-platform-services/fusionsolar/test/*.test.js"
deno test "bios-multilevel-platform-services/dashboard/oauth-proxy_test.ts"
deno check "bios-multilevel-platform-services/dashboard/main.ts"
node "bios-multilevel-platform-services/prediction/test.js"
node "bios-multilevel-platform-services/blockchain/test.js"
docker compose -f "bios-multilevel-platform-services/docker-compose.yml" config
```

Expected: all tests PASS, Deno check exits 0, and Compose config renders without
missing required syntax.

- [ ] **Step 5: Security regression scan**

Search tracked source and test output for actual configured values and dangerous
logging patterns. Confirm:

- no secret is committed;
- no `console.log` prints token/code/setup values;
- OAuth responses set `Cache-Control: no-store`;
- proxy route allowlist has exactly two paths;
- `pvms.openapi.control` is absent from runtime requests; and
- no code calls Mars2 `postRawDataInput`.

- [ ] **Step 6: Final review checkpoint**

Review `git diff`, test evidence, and the design specification together. If
commits are authorized:

```powershell
git add "bios-multilevel-platform-services/fusionsolar" "docs/superpowers"
git commit -m "test: verify FusionSolar ingestion end to end"
```

Otherwise leave all verified changes uncommitted for user review.

## Production Acceptance (after Huawei credentials arrive)

- [ ] Configure protected/masked CI variables without posting values in chat.
- [ ] Deploy the service and verify `/health` and sanitized `/status`.
- [ ] Open the one-time setup URL and authorize with the FusionSolar owner account.
- [ ] Confirm returned scope includes `pvms.openapi.basic`.
- [ ] Confirm both Sombor plants and expected inverter devices are visible.
- [ ] Confirm live rows arrive in `raw_measurements`.
- [ ] Confirm an access-token refresh succeeds.
- [ ] Confirm backfill checkpoints move backward without `429` loops.
- [ ] Rotate or disable the setup token after authorization.
- [ ] Do not enable Mars2 publishing until its write permission and counter mapping are separately validated.
