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
| `SOKO46BIOS` | SC Soko 46 kWp | Huawei FusionSolar | `HUAWEI:NE=201410062` |
| `SOKOBAZENBIOS` | SC SOKO Bazen 275.400 kWp | Huawei FusionSolar | `HUAWEI:NE=201791758` |
| `VETINSTBIOS` | Veterinarski Institut | Solis SolisCloud | `SOLIS:1298491919450654168` |

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
    { "code": "SOKO46BIOS", "source": "HUAWEI:NE=201410062", "vendor": "huawei", "name": "SC Soko 46 kWp",
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
  "code": "SOKO46BIOS", "name": "SC Soko 46 kWp", "vendor": "huawei", "source": "HUAWEI:NE=201410062",
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
{ "code": "SOKO46BIOS", "from": "…", "to": "…", "stepSeconds": 300,
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

## Mars2 side

Per plant, in the admin UI (Upravljanje podacima, never as a root node):

1. Create the plant node under **Solari**; set **Mjerno mjesto** code to the
   Mars2 code above.
2. Create the device from the feed template (Instalacijski alati >
   Predlošci, then Privremeni uređaji > Kreiraj novi uređaj) with the
   plant-specific URL `…/feed/plants/<code>/current`, and attach it with
   "Dodaj iz privremenih uređaja".
3. One Variable per column with `CustomExport` position 1..15 exactly as on
   `SOLAXBIOS`, so `CustomDataExport/BIOS/<code>` has the same layout.
4. Poll every 5 minutes (vendor data arrives every 5 minutes; Mars2 pulls of
   the existing stations are 10 minutes).

Polling is visible on our side: `GET /prediction/freshness` reports
`feed.lastRequestAt`, `feed.lastRequestPath`, `feed.requestsTotal` and auth
failures, and the dashboard monitor alerts when polling stops
(`mars2.poll.silent`).

## Errors

| Status | Meaning |
| --- | --- |
| 400 | bad credentials (`invalid_grant`), bad `from`/`to`, window over 31 days |
| 401 | missing or expired token / wrong key |
| 404 | unknown plant code (the body lists the configured codes) |
| 405 | wrong method (token is POST only, data is GET only) |
| 503 | feed not configured, or PostgreSQL unavailable (`Retry-After: 30`) |
