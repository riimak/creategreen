# BIOS feed API for Mars2 (vendor solar plants)

The Huawei FusionSolar and Solis SolisCloud plants are ingested by the
platform services into PostgreSQL. The partner (PMF NS) pulls everything from
Mars2 (`CustomDataExport/BIOS/<code>`), so each plant becomes a Mars2 device
whose template polls this API, and Mars2 exports it exactly like `SOLAXBIOS`.

Implementation: `bios-multilevel-platform-services/prediction/feed.js`,
exposed through the dashboard proxy. Base URL in production:

```text
https://bios-multilevel.barrage.net/prediction/feed
```

## Plants

| Mars2 code (Mjerno mjesto) | Plant | Vendor | Our source key |
| --- | --- | --- | --- |
| `SOKO46` | SC Soko 46 kWp | Huawei FusionSolar | `HUAWEI:NE=201410062` |
| `SOKOBAZEN` | SC SOKO Bazen 275.400 kWp | Huawei FusionSolar | `HUAWEI:NE=201791758` |
| `VETINST` | Veterinarski Institut | Solis SolisCloud | `SOLIS:1298491919450654168` |

Codes are configured with `FEED_PLANTS` (`CODE=SOURCE,...`) in
`prediction/.gitlab/auto-deploy-values.yaml`; change them there if Mars2
assigns different ones.

## Authentication

Two methods, either is enough. Credentials are GitLab CI variables forwarded
into the prediction deployment (`FEED_USERNAME`/`FEED_PASSWORD`,
optionally `FEED_API_KEY`). Without them every endpoint answers `503 feed not
configured`; the feed is never open.

Bearer token, same form as Mars2's own `/Token` so a template's auth block
can be reused:

```http
POST /prediction/feed/token
Content-Type: application/x-www-form-urlencoded

userName=<FEED_USERNAME>&password=<FEED_PASSWORD>&grant_type=password
```

```json
{ "access_token": "…", "token_type": "bearer", "expires_in": 86400 }
```

Then `Authorization: Bearer <access_token>` on every GET. Wrong credentials
answer `400 {"error":"invalid_grant"}`; a missing or expired token `401`.

Static key, for templates that can only send a fixed header:
`X-Feed-Key: <FEED_API_KEY>`.

## Endpoints

### `GET /prediction/feed/plants`

```json
{
  "generatedAt": "2026-11-08T19:02:06Z",
  "layout": [ { "position": 1, "key": "Grid.power.total", "unit": "kW", "kind": "gauge" }, "… 15 entries" ],
  "plants": [
    { "code": "SOKO46", "source": "HUAWEI:NE=201410062", "vendor": "huawei", "name": "SC Soko 46 kWp",
      "capacityKwp": 46, "visible": true, "inventoryKnown": true,
      "devices": [ { "source": "HUAWEI:NE=201410062:device:…", "id": "…", "type": "1", "model": "SUN2000", "serial": "…", "name": "…" } ] }
  ]
}
```

### `GET /prediction/feed/plants/{code}/current`

The newest value per column. `values` is flat on purpose: a template maps
one JSON path per counter, e.g. `$.values['Inverter.AC.power.total']`.

```json
{
  "code": "SOKO46", "name": "SC Soko 46 kWp", "vendor": "huawei", "source": "HUAWEI:NE=201410062",
  "capacityKwp": 46,
  "generatedAt": "2026-11-08T19:02:06Z",
  "timestamp": "2026-11-08T19:00:12Z",
  "values": {
    "Grid.power.total": -3.1,
    "Grid.energy.toGrid.total": 5072,
    "Grid.energy.fromGrid.total": 1810.5,
    "BMS.energy.SOC": null,
    "Inverter.Meter2.AC.power.total": null,
    "Inverter.AC.EPS.power.R": null, "Inverter.AC.EPS.power.S": null, "Inverter.AC.EPS.power.T": null,
    "Inverter.DC.Battery.power.total": null,
    "Inverter.DC.PV.power.MPPT1": null, "Inverter.DC.PV.power.MPPT2": null, "Inverter.DC.PV.power.MPPT3": null, "Inverter.DC.PV.power.MPPT4": null,
    "Inverter.AC.power.total": 12.175,
    "Inverter.AC.energy.out.daily": 76
  },
  "details": {
    "Inverter.AC.power.total": { "position": 14, "unit": "kW", "kind": "gauge", "value": 12.175,
      "timestamp": "2026-11-08T18:59:40Z", "samples": 2, "stale": false, "mapped": true, "verified": true }
  },
  "raw": [ { "source": "HUAWEI:NE=201410062:device:…", "metric": "huawei.string_inverter.active_power_kw", "value": 10.5, "timestamp": "…" } ]
}
```

- `timestamp` is the newest sample used anywhere in `values`; per column,
  `details[key].timestamp` is the oldest sample that went into that value.
- A gauge sample older than 30 minutes (`FEED_STALE_MINUTES`) is not used; a
  counter older than 26 hours (`FEED_STALE_MINUTES_COUNTERS`) is not used. The
  column is then `null` with `details[key].stale = true`.
- `null` means no value; it must map to an empty export cell, never to 0.

### `GET /prediction/feed/plants/{code}/history?from=…&to=…&step=300`

Bucketed series per column (`from`/`to` ISO 8601 or `yyyy-MM-dd HH:mm:ss`
UTC, `to` defaults to now, window at most 31 days, `step` 60..86400 s,
default 300). Gauges are bucket averages, daily counters bucket maxima,
cumulative counters the last value in the bucket.

```json
{ "code": "SOKO46", "from": "…", "to": "…", "stepSeconds": 300,
  "series": { "Inverter.AC.power.total": [ { "timestamp": "2026-11-07T19:00:00Z", "value": 12.175 } ], "…": [] } }
```

### `GET /prediction/feed/plants/{code}/export?fromUTC=…&toUTC=…`

Byte-compatible with Mars2 `CustomDataExport/BIOS/<code>`: a JSON string
`"CODE!ts;v1;…;v15 0xa ts;…"` with Unix-second timestamps, comma decimals,
empty cells for missing values and the literal `0xa` ending each record,
5-minute records (`step` overrides). This is the fallback delivery path if a
Mars2 template cannot be pointed at this API: the partner's
`bios-export.sh` works against it with only the base URL changed.

## Column mapping (SOLAXBIOS layout)

| Pos | Column | Unit | Kind | Huawei | Solis |
| --- | --- | --- | --- | --- | --- |
| 1 | `Grid.power.total` | kW | gauge | sum of `huawei.grid_meter.active_power_kw` / `huawei.power_sensor.active_power_kw` | — |
| 2 | `Grid.energy.toGrid.total` | kWh | cumulative | sum of `*.positive_active_energy_kwh` (feed-in) | `solis.plant.total_grid_sell_kwh` |
| 3 | `Grid.energy.fromGrid.total` | kWh | cumulative | sum of `*.negative_active_energy_kwh` (purchase) | `solis.plant.total_grid_purchased_kwh` |
| 4 | `BMS.energy.SOC` | % | gauge | avg of `huawei.battery.*` / `huawei.ess.state_of_charge_percent` | avg of `solis.inverter.battery_soc_percent` |
| 5 | `Inverter.Meter2.AC.power.total` | kW | gauge | — | — |
| 6–8 | `Inverter.AC.EPS.power.R/S/T` | kW | gauge | — | — |
| 9 | `Inverter.DC.Battery.power.total` | kW | gauge | sum of `huawei.battery.*` / `huawei.ess.charge_discharge_power_kw` | sum of `solis.inverter.battery_power_kw` |
| 10–13 | `Inverter.DC.PV.power.MPPT1–4` | kW | gauge | — | — |
| 14 | `Inverter.AC.power.total` | kW | gauge | sum of `huawei.string_inverter.active_power_kw` / `huawei.residential_inverter.active_power_kw` across devices | `solis.plant.current_power_kw` |
| 15 | `Inverter.AC.energy.out.daily` | kWh | daily | `huawei.plant.daily_yield_kwh` | `solis.plant.daily_yield_kwh` |

"—" columns are always `null`/empty for that vendor. Vendor metrics that do
not fit the layout (monthly/total yield, consumption, battery daily energy,
inverter temperature) are in `raw` and in the metric registries
(`fusionsolar/metric-registry.js`, `soliscloud/metric-registry.js`).

### Sign conventions (verified 2026-11-08)

- `Grid.power.total` on `SOLAXBIOS` is **negative while importing** and
  positive while exporting: at night (inverter 0 kW) Mars2 served −7 to
  −9 kW while `Grid.energy.fromGrid.total` rose 2039 → 2042 kWh and
  `Grid.energy.toGrid.total` stayed at 37 kWh; at midday +5 kW alongside
  31 kW of inverter output.
- Huawei grid meters (`devTypeId` 17) and power sensors (47) count feed-in as
  positive as well (FusionSolar NBI reference; the Homey and Home Assistant
  FusionSolar integrations both invert Huawei's sign to get "positive =
  import"). So Huawei `active_power` maps to column 1 without negation,
  `positive_active_energy` is energy fed to the grid (column 2) and
  `reverse_active_energy` energy drawn from it (column 3).
- Solis names the direction in the field (`gridSell*`, `gridPurchased*`).
- Not verified: the charge/discharge sign of `Inverter.DC.Battery.power.total`
  (Huawei reports charging as positive; the SOLAXBIOS and Solis conventions
  were not checked). Column 9 carries `verified: false` in `details` until
  it is; flip the sign in `LAYOUT` in `prediction/feed.js` if needed.

## Vendor dialects (what Mars2 actually polls)

The Mars2 `Http` driver is not a generic JSON connector; it speaks the vendor
clouds it was built for and the flow is chosen by the device parameters
([admin-recon.md](admin-recon.md) §3). The same plant values are therefore
also served in two vendor dialects, so a Mars2 device cloned from an existing
one can poll us without a Mars2 code change. Both use the same credentials
and the same staleness rules as `/current`; `null` columns stay empty.

### Solax Cloud dialect (primary — the `SOLAXBIOS` device uses it)

```http
GET /prediction/feed/solax/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=<FEED_API_KEY or access_token>&sn=<Mars2 code>
```

```json
{ "success": true, "exception": "Query success!",
  "result": { "inverterSN": "HUAWEI:NE=201410062", "sn": "SOKO46",
              "acpower": 12175, "yieldtoday": 76, "yieldtotal": 98765.4,
              "feedinpower": -3100, "feedinenergy": 5072, "consumeenergy": 1810.5,
              "feedinpowerM2": null, "soc": null, "peps1": null, "peps2": null, "peps3": null,
              "batPower": null, "powerdc1": null, "powerdc2": null, "powerdc3": null, "powerdc4": null,
              "inverterType": "0", "inverterStatus": "102", "uploadTime": "2026-11-08 20:00:12" } }
```

| Solax field | Column | Unit |
| --- | --- | --- |
| `feedinpower` | 1 `Grid.power.total` | W |
| `feedinenergy` | 2 `Grid.energy.toGrid.total` | kWh |
| `consumeenergy` | 3 `Grid.energy.fromGrid.total` | kWh |
| `soc` | 4 `BMS.energy.SOC` | % |
| `feedinpowerM2` | 5 `Inverter.Meter2.AC.power.total` | W |
| `peps1` / `peps2` / `peps3` | 6–8 `Inverter.AC.EPS.power.R/S/T` | W |
| `batPower` | 9 `Inverter.DC.Battery.power.total` | W |
| `powerdc1` … `powerdc4` | 10–13 `Inverter.DC.PV.power.MPPT1–4` | W |
| `acpower` | 14 `Inverter.AC.power.total` | W |
| `yieldtoday` | 15 `Inverter.AC.energy.out.daily` | kWh |
| `yieldtotal` | (not exported) `Inverter.AC.energy.out.total` | kWh |

- Power is sent in **W** like Solax Cloud (Mars2 turns Solax's W into the kW
  it shows for `SOLAXBIOS`); `FEED_SOLAX_POWER_UNIT=kW` switches if a live
  poll proves otherwise.
- `uploadTime` is the newest sample used, as a naive wall-clock time in
  `FEED_SOLAX_TIMEZONE`, default **`Etc/GMT-2` = fixed UTC+2**. Mars2 turns
  a naive timestamp into its exported unix time by subtracting **twice** the
  Croatian UTC offset (it converts local→UTC on storing and again on
  exporting; see admin-recon.md §8), i.e. 2 h in winter and 4 h in summer.
  Solax Cloud sends fixed UTC+2, which is why `SOLAXBIOS` is right in winter
  and two hours early all summer. Measured 2026-11-12 with `Europe/Zagreb`
  (UTC+1): our SOKO46 sample 21:16:49Z (`consumeenergy` 36851.72) appeared
  as 20:16:49Z with the same value; with UTC+2 the exported timestamp equals
  the sample time (21:42:00Z = 21:42:00Z). **From 29 Mar 2027 (DST) the
  value has to become UTC+4 (`Etc/GMT-4`) unless Mars2 is fixed first** —
  the export timestamps of the feed plants should be compared with
  `/prediction/feed/plants/<code>/current` → `timestamp` after any change on
  either side.
- Missing quantities are `null` (Solax itself sends `powerdc3: null`);
  `FEED_SOLAX_EMPTY=zero|omit` if Mars2's deserializer objects.
- `inverterType` is `"0"` (there is no Solax inverter), `inverterStatus`
  `"102"` (Normal) whenever data is flowing.
- Errors keep the Solax envelope: `401 {"success":false,"exception":"invalid
  tokenId"}`, `404 … "unknown sn"` (with `codes`), `503 … "database
  unavailable"`, and `200 {"success":false,"exception":"no data"}` when no
  column has a fresh value (Solax's own query-level failure).

### Solarman dialect (fallback — the `Dvorana Kulturnog centra` device uses it)

```http
POST /prediction/feed/solarman/account/v1.0/token?appId=<anything>
Content-Type: application/json

{ "appSecret": "<FEED_API_KEY or anything>", "email": "<FEED_USERNAME>", "password": "<FEED_PASSWORD or its SHA-256 hex>" }
```

```json
{ "code": null, "msg": null, "success": true, "requestId": "…", "access_token": "…", "token_type": "bearer",
  "refresh_token": null, "expires_in": "86400", "scope": "read", "uid": 0 }
```

Login succeeds with `email`/`password` = feed credentials (Solarman clients
hash the password with SHA-256, so the digest is accepted too) or with
`appSecret` = `FEED_API_KEY`. The token is the same as from `/feed/token`.

```http
POST /prediction/feed/solarman/device/v1.0/currentData?language=en
Authorization: bearer <access_token>
Content-Type: application/json

{ "deviceSn": "<Mars2 code>", "deviceId": 0 }
```

```json
{ "code": null, "msg": null, "success": true, "requestId": "…",
  "deviceSn": "SOKO46", "deviceId": 0, "deviceType": "INVERTER", "deviceState": 1, "collectionTime": 1794168715,
  "dataList": [
    { "key": "Pr1", "value": "46", "unit": "kW", "name": "Rated Power" },
    { "key": "APo_t1", "value": "12.175", "unit": "kW", "name": "Total AC Output Power (Active)" },
    { "key": "Etdy_ge1", "value": "76", "unit": "kWh", "name": "Daily Production (Active)" },
    { "key": "PG_Pt1", "value": "-3.1", "unit": "kW", "name": "Total Grid Power" },
    { "key": "t_gc1", "value": "5072", "unit": "kWh", "name": "Cumulative Grid Feed-in" },
    { "key": "Et_pu1", "value": "1810.5", "unit": "kWh", "name": "Cumulative Energy Purchased" } ] }
```

| `dataList.key` (= Mars2 `CounterCode`) | Column | Seen on the Dvorana device |
| --- | --- | --- |
| `Pr1` | rated power = plant capacity kWp | yes (01) |
| `APo_t1` | 14 `Inverter.AC.power.total` | yes (33) |
| `Et_ge0` | `Inverter.AC.energy.out.total` | yes (34) |
| `Etdy_ge1` | 15 `Inverter.AC.energy.out.daily` | yes (35) |
| `PG_Pt1` | 1 `Grid.power.total` | yes (36) |
| `t_gc1` | 2 `Grid.energy.toGrid.total` | yes (37) |
| `Et_pu1` | 3 `Grid.energy.fromGrid.total` | yes (38) |
| `B_left_cap1` | 4 `BMS.energy.SOC` | not seen — verify |
| `B_P1` | 9 `Inverter.DC.Battery.power.total` | not seen — verify |
| `DP1`–`DP4` | 10–13 `Inverter.DC.PV.power.MPPT1–4` | not seen — verify |

Values are strings and absent quantities are not listed, like Solarman;
`deviceState` is 1 (online) with fresh data and 3 (offline) without.

## Mars2 side

Per plant, in the admin UI (Upravljanje podacima, never as a root node). The
model to copy is `BIOS CREATEGREEN (Solax)` → `SRDFARETLA` + `Solax MT`
([admin-recon.md](admin-recon.md)):

1. Template: Instalacijski alati > Predlošci, create a template from the
   `SRDFARETLA` device node (Solax dialect; it carries the 16 counters with
   their `Http/CounterCode` values and the `Solax` parameter category).
2. Privremeni uređaji > Kreiraj novi uređaj from that template, per plant,
   with device parameters
   `BaseUrl = https://bios-multilevel.barrage.net/prediction/feed/solax/`
   (**trailing slash required**, see below),
   `RealTimeInfoEndpoint = proxyApp/proxy/api/getRealtimeInfo.do`,
   `TokenId = <FEED_API_KEY>`, `DeviceSn = <Mars2 code>`.

   The Http driver resolves `RealTimeInfoEndpoint` against `BaseUrl` as a
   relative URI (RFC 3986). Without the trailing slash the base's last
   segment is replaced, the request goes to
   `/prediction/feed/proxyApp/proxy/api/getRealtimeInfo.do` and Mars2 stores
   nothing (observed 2026-11-12: three devices, 288 planned readouts a day,
   zero records, no alarm anywhere in Mars2). Since the same day the dashboard
   and the prediction service also accept that spelling, a doubled slash and
   a missing separator (`canonicalFeedPath` in `dashboard/feed-path.ts` and
   `prediction/feed.js`), so a BaseUrl typo cannot silently become 404s again.
3. Create the plant node under **Solari**, add component **Mjerno mjesto**
   with ŠIFRA = the Mars2 code, then "Dodaj iz privremenih uređaja".
4. Add a measurement-point node (component **Mjerna točka**, UREĐAJI = the
   new device, VRIJEDI OD = now) with one normalized variable per counter
   (components Varijabla, Mjerna veličina/BROJAČ = the counter, Parametri →
   category `CustomExport`, parameter `Position`). `Position` is **0-based**:
   column 1 `Grid.power.total` = `0` … column 15 `Inverter.AC.energy.out.daily`
   = `14`, identical to `Solax MT`.
5. Polling needs no configuration: counters of a device with the `Http`
   driver are included automatically in readout group `Http`
   (Upravljanje očitanjima > Grupe; schedule `5 minutni`, 288 planned
   readouts a day), the same group that polls `SOLAXBIOS`.

Fallback: the same steps with a template from the `2206239131` Solarman
device and `BaseUrl = …/prediction/feed/solarman`,
`AuthenticationEndpoint = account/v1.0/token?appId=`,
`CurrentDataEndpoint = device/v1.0/currentData?language=en`,
`Email/Password` = feed credentials, `DeviceSn` = the Mars2 code; the
variables then have to be named after the export columns by hand.

Polling is visible on our side: `GET /prediction/freshness` reports
`feed.lastRequestAt`, `feed.lastRequestPath` (which dialect Mars2 uses),
`feed.lastRequestSn`, `feed.requestsTotal`, `feed.dialects` (the Solax knobs
in force), auth failures and `feed.recent` (the last ten calls: time, path,
`sn`, status, caller address, user agent). Every call is written to the
`feed_requests` table, so the figures are the same on both prediction
replicas (`feed.shared: true`); the per-process counters stay under
`feed.local`. The dashboard monitor alerts when polling stops
(`mars2.poll.silent`).

## Errors

| Status | Meaning |
| --- | --- |
| 400 | bad credentials (`invalid_grant`), bad `from`/`to`, window over 31 days |
| 401 | missing or expired token / wrong key |
| 404 | unknown plant code (the body lists the configured codes) |
| 405 | wrong method (token and the Solarman routes are POST only, everything else GET only) |
| 503 | feed not configured, or PostgreSQL unavailable (`Retry-After: 30`) |

The dialect routes answer the same statuses inside their vendor envelope
(`success: false` plus `exception` or `code`/`msg`).
