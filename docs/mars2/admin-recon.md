# Mars2 admin (Elementix) — how the BIOS data is modelled

Read-only survey of the production Mars2 admin UI, done 2026-11-08 as
`biosAdmin` through an in-cluster jump pod (`web.mars2.barrage.net:81` is
reachable only from the cluster; the admin is the `DataManagement` module).
Screenshots are in [`screenshots/`](screenshots/). Nothing was changed.

The point of the survey: find out what a Mars2 "device template" can poll,
so the Huawei and Solis plants can be added to Mars2 as devices that read our
[feed API](feed-contract.md) instead of a vendor cloud.

## 1. Node tree (Upravljanje podacima > Čvorovi)

```text
BIOS                                  root (only the ultimate admin may create roots)
├── Meteo stanice                     OS1BIOS / OS2BIOS (not surveyed)
└── Solari
    ├── BIOS CREATEGREEN (Solax)      node/7   plant node, tags Solax, FNE
    │   ├── Solax MT                  node/431 measurement point ("Mjerna točka")
    │   │   ├── BMS.energy.SOC        15 normalized variables, see §4
    │   │   └── … (Inverter.AC.power.total = node/442)
    │   └── SRDFARETLA                node/8   device (Solax inverter), 16 counters, see §3
    ├── Dvorana Kulturnog centra      node/45  plant node, tags FNE, Solarman; Mjerno mjesto ŠIFRA = Solarman
    │   ├── Inverter
    │   │   └── 2206239131            device (Solarman data logger), 50 counters, see §3
    │   └── Solarman MT               node/447 measurement point, 50 variables (01_Rated_Power = node/463)
    ├── SE Novi Sad Veterina          node/751 empty placeholder (no components)
    │   └── SolisCloud                node/752 empty placeholder (no components)
    └── Sumarne vrijednosti           node/633 totals across plants, see §6
```

Admin URL patterns (hash routes): `#/node/{id}`, `#/node/{id}/counterCView`,
`#/node/{id}/counterCView/counterParametersCView/{counterId}`,
`#/node/{id}/deviceCView`, `#/node/{id}/deviceCView/deviceParametersCView/{id}`,
`#/node/{id}/measurementPointCView`, `#/node/{id}/measurementPlaceCView`,
`#/node/{id}/customDataCView` (the "Parametri" component),
`#/node/{id}/variableCView`, `#/node/{id}/measurementPointVariableCView`,
`#/node/{id}/virtualGroupCView`.

Every node has **Oznake** (tags) and **Komponente**; components are added
with "Dodaj novu komponentu" and removed with the red ✖ (never click it).

## 2. Plant node = Mjerno mjesto (the export code)

`BIOS CREATEGREEN (Solax)` (node/7) has three components:

| Component | Content |
| --- | --- |
| Mjerno mjesto | **ŠIFRA = `SOLAXBIOS`**, Opis empty. This is the `<code>` in `CustomDataExport/BIOS/<code>`. |
| Gis | map position |
| Parametri | categories `LinkToDashboard` (`Id` = 3) and `GIS` (`Icon` = `bolt`) |

`Dvorana Kulturnog centra` (node/45, tags `FNE`, `Solarman`) has the same
three components with ŠIFRA = `Solarman`, so `CustomDataExport/BIOS/Solarman`
is a valid station code — but see §4, nothing is exported for it.

So for a new plant the node under `Solari` gets a `Mjerno mjesto` component
with the code (`SOKO46`, `SOKOBAZEN`, `VETINST`). Screenshot 06.

## 3. Device nodes and counters (what Mars2 polls)

A device node has one component, **Uređaj**, with: Parametri uređaja,
DRIVER, Opis, Tvornički broj, Model, Serijski broj, Godina proizvodnje,
Proizvođač, Vrsta uređaja, Certificiran, Aktivan. Both solar devices use
**DRIVER = `Http`**. What the Http driver does is decided by the device
parameters ("Parametri uređaja", grouped in a named category) — two flavours
exist in production:

### 3a. Solax flavour — device `SRDFARETLA` (node/8), feeds `SOLAXBIOS`

Model `Solax`, Serijski broj `123`, Proizvođač `Končar INEM`, Vrsta
`Električno brojilo`, Aktivan. Parameter category **`Solax`**
(screenshot 10):

| Parameter | Value |
| --- | --- |
| `BaseUrl` | `https://www.solaxcloud.com` |
| `RealTimeInfoEndpoint` | `proxyApp/proxy/api/getRealtimeInfo.do` |
| `TokenId` | the Solax Cloud API token (20251015…, not recorded) |
| `DeviceSn` | `SRDFARETLA` |

No placeholders in the endpoint: Mars2 builds
`{BaseUrl}/{RealTimeInfoEndpoint}?tokenId={TokenId}&sn={DeviceSn}` itself,
i.e. the public Solax Cloud API
`GET https://www.solaxcloud.com/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=…&sn=…`
whose answer is

```json
{ "success": true, "exception": "Query success!",
  "result": { "inverterSN": "…", "sn": "SRDFARETLA", "acpower": 1234.0, "yieldtoday": 12.3,
              "yieldtotal": 2077.0, "feedinpower": -4252.0, "feedinenergy": 40.0, "consumeenergy": 2077.0,
              "feedinpowerM2": 0, "soc": 0, "peps1": 0, "peps2": 0, "peps3": 0, "inverterType": "…",
              "inverterStatus": "…", "uploadTime": "2026-11-08 21:45:03", "batPower": 0,
              "powerdc1": 0, "powerdc2": 0, "powerdc3": null, "powerdc4": null, "batStatus": "…" } }
```

The device has 16 counters (component **Brojač**: Parametri brojača, Mjerna
jedinica, Opis, Zadnje očitanje, Aktivan, Umjeravanje, Povijest). Each
counter has one parameter, category `Http`, **`CounterCode` = the field name
of `result` in PascalCase**:

| Counter (name) | CounterCode | Unit | Zadnje očitanje (2026-11-08) |
| --- | --- | --- | --- |
| `Grid.power.total` | `Feedinpower` | Radna snaga kW | 21:45:03 |
| `Inverter.AC.power.total` | `Acpower` | Radna snaga kW | 21:45:03 |
| `Inverter.DC.Battery.power.total` | `BatPower` | Radna snaga kW | never (no battery) |
| `BMS.energy.SOC`, `Grid.energy.fromGrid.total`, `Grid.energy.toGrid.total`, `Inverter.AC.energy.out.daily`, `Inverter.AC.energy.out.total`, `Inverter.AC.EPS.power.R/S/T`, `Inverter.DC.PV.power.MPPT1–4`, `Inverter.Meter2.AC.power.total` | not opened; by the same rule `Soc`, `Consumeenergy`, `Feedinenergy`, `Yieldtoday`, `Yieldtotal`, `Peps1/2/3`, `Powerdc1–4`, `FeedinpowerM2` | | |

The PascalCase codes (`BatPower`, `Feedinpower`) are the field names as .NET
properties, which means the driver deserialises the Solax answer into a
typed model and reads the property named by `CounterCode`. A facade must
therefore use the **real Solax field names** (`feedinpower`, `batPower`, …);
inventing new keys would not work with this flavour. Counter names are
free text and already equal our 15 column keys.

### 3b. Solarman flavour — device `2206239131` (Dvorana Kulturnog centra)

Created from `SolarmanTemplate` (Instalacijski alati > Predlošci,
screenshots 01–02). Parameter category `SolarmanTemplate`:

| Parameter | Value |
| --- | --- |
| `BaseUrl` | `https://globalapi.solarmanpv.com` |
| `AuthenticationEndpoint` | `account/v1.0/token?appId=` |
| `CurrentDataEndpoint` | `device/v1.0/currentData?language=en` |
| `AppId`, `AppSecret`, `Email`, `Password` | Solarman account |
| `DeviceId`, `DeviceSn` | the data logger |

Flow: `POST {BaseUrl}/{AuthenticationEndpoint}{AppId}` with
`{appSecret, email, password}` → `access_token`; then
`POST {BaseUrl}/{CurrentDataEndpoint}` with `{deviceSn, deviceId}` and
`Authorization: Bearer …` → `{ deviceSn, deviceId, dataList: [{ key, value, unit, name }], success }`.

50 counters named `NN_Name`; `CounterCode` (category `Http`) is the Solarman
`dataList[].key` (screenshots 03–04):

| Counter | CounterCode | Unit |
| --- | --- | --- |
| `01_Rated_Power` | `Pr1` | kW |
| `33_Total_AC_Output_Power_(Active)` | `APo_t1` | kW |
| `34_Cumulative_Production_(Active)` | `Et_ge0` | kWh |
| `35_Daily_Production_(Active)` | `Etdy_ge1` | kWh |
| `36_Total_Grid_Power` | `PG_Pt1` | kW |
| `37_Cumulative_Grid_Feed-in` | `t_gc1` | kWh |
| `38_Cumulative_Energy_Purchased` | `Et_pu1` | kWh |
| `39_Daily_Grid_Feed-in` | `t_gc_tdy1` | kWh |
| `40_Daily-Energy_Purchased` | `Etdy_pu1` | kWh |
| `41_Total_Consumption_Power` | `E_Puse_t1` | (labelled kWh) |
| `42_Cumulative_Consumption` | `Et_use1` | kWh |
| `43_Daily Consumption` | `Etdy_use1` | kWh |

Counters 02–32 and 44–50 were not opened. Counter 33 also carries a
"Nedostajući podaci" (missing data) component. Last reading on this device
was 23.09.2025 12:32 — the Solarman poll has been dead for a year.

## 4. Measurement point and variables (what gets exported)

`Solax MT` (node/431) has one component, **Mjerna točka**: UREĐAJI =
`BIOS/Solari/BIOS CREATEGREEN (Solax)/SRDFARETLA`, VRIJEDI OD
`01.09.2025 10:32`, checkbox "Uređaji bez mjerne točke". `Solarman MT`
(node/447) is the same, bound to `…/Inverter/2206239131` from
`01.09.2025 10:34` (screenshot 05).

Its children are **normalized variables**, one per counter, same names as
the counters, with three components:

- **Varijabla**: Mjerna veličina (e.g. "Električna energija - Radna snaga
  (kW)"), Smjer varijable (Potrošnja), Podrijetlo = Normalizirana,
  Vremenski period = Sekunda, Vrsta = Trenutna vrijednost, Agregacijska
  funkcija = Posljednja vrijednost.
- **Mjerna veličina**: BROJAČ = the counter it reads (e.g.
  `Inverter.Meter2.AC.power.total`).
- **Parametri** (only on the `Solax MT` variables): category
  **`CustomExport`**, parameter **`Position`** — this is what puts a
  variable into `CustomDataExport/BIOS/SOLAXBIOS` (screenshot 07). The
  `Solarman MT` variables (checked on `01_Rated_Power`, node/463) have only
  Varijabla and Mjerna veličina, no Parametri component, so Dvorana
  Kulturnog centra exports nothing.

`Position` is **0-based** and matches our `LAYOUT` order with
`Position = position − 1`:

| Position | Variable | feed.js position |
| --- | --- | --- |
| 0 | `Grid.power.total` | 1 |
| 1 | `Grid.energy.toGrid.total` | 2 |
| 2 | `Grid.energy.fromGrid.total` | 3 |
| 3 | `BMS.energy.SOC` | 4 |
| 4 | `Inverter.Meter2.AC.power.total` | 5 |
| 5 | `Inverter.AC.EPS.power.R` | 6 |
| 6 | `Inverter.AC.EPS.power.S` | 7 |
| 7 | `Inverter.AC.EPS.power.T` | 8 |
| 8 | `Inverter.DC.Battery.power.total` | 9 |
| 9 | `Inverter.DC.PV.power.MPPT1` | 10 |
| 10–12 | `Inverter.DC.PV.power.MPPT2–4` (not opened, by elimination) | 11–13 |
| 13 | `Inverter.AC.power.total` (node/442) | 14 |
| 14 | `Inverter.AC.energy.out.daily` | 15 |

(Only node/442 was read off the UI, from the `Sumarne vrijednosti` formula;
the other variable IDs were not recorded.)

`Inverter.AC.energy.out.total` exists as a counter on the device but has no
variable under `Solax MT`, so it is not exported. The export line
`SOLAXBIOS!1794128401;-4,252;40;2077;;;;;;;;;;;9,056;0xa` is therefore
`Feedinpower (kW); Feedinenergy; Consumeenergy; Soc; …; Acpower; Yieldtoday`.

## 5. Templates and temporary devices

`Instalacijski alati > Predlošci` lists `SolarmanTemplate` (screenshot 01).
Nikolina's procedure (WhatsApp, June 2026): make a template from an existing
device node, upload it under Instalacijski alati, create a temporary device
from the template (`Privremeni uređaji > Kreiraj novi uređaj`), then on the
target node "Dodaj iz privremenih uređaja". A template therefore carries the
device parameters **and the counters with their CounterCodes**; a template
made from `SRDFARETLA` yields a device with our 16 counter names and the
Solax codes already in place.

## 6. Totals (`Sumarne vrijednosti`, node/633)

Five variables (`Snaga iz mreže`, `Trenutna snaga`, `Ukupna dnevna
proizvodnja na solarima`, `Ukupna energija preuzeta iz mreže`, `Ukupna
predana energija u mrežu`) each with a **Virtualna grupa** component holding a
formula over node IDs, e.g. `Trenutna snaga` (node/637) = `#442 + #481`,
where the ELEMENTI table resolves 442 =
`BIOS/Solari/BIOS CREATEGREEN (Solax)/Solax MT/Inverter.AC.power.total` and
481 = `BIOS/Solari/Dvorana Kulturnog centra/Solarman
MT/33_Total_AC_Output_Power_(Active)` (screenshot 11). When the new plants
exist, their `Inverter.AC.power.total` etc. node IDs belong in these
formulas.

## 7. What this means for the feed

The Http driver is not a generic "URL + JSON path" connector; it has
vendor-specific flows selected by the device's parameter set. The cheapest
way to get our data into Mars2 without a Mars2 code change is to **speak one
of those two dialects** from our API and clone the matching device as a
template:

1. **Solax dialect (preferred).** Template from `SRDFARETLA`; per plant a
   temporary device with `BaseUrl = https://bios-multilevel.barrage.net/prediction/feed/solax/`
   (trailing slash — the driver resolves the endpoint against it as a
   relative URI; see section 8),
   `RealTimeInfoEndpoint = proxyApp/proxy/api/getRealtimeInfo.do`,
   `TokenId = <FEED_API_KEY>`, `DeviceSn = <plant code>`. Our side answers the
   Solax `getRealtimeInfo.do` shape with the plant's 15 values in the Solax
   fields (`feedinpower`, `feedinenergy`, `consumeenergy`, `soc`,
   `feedinpowerM2`, `peps1..3`, `batPower`, `powerdc1..4`, `acpower`,
   `yieldtoday`, plus `yieldtotal`), one GET, no token exchange. Counter
   names, CounterCodes and the measurement-point variables come out identical
   to `SOLAXBIOS`, so only `CustomExport/Position` 0–14 has to be set.
2. **Solarman dialect (fallback).** Template from `2206239131`;
   `BaseUrl = …/prediction/feed/solarman`, `AuthenticationEndpoint =
   account/v1.0/token?appId=`, `CurrentDataEndpoint =
   device/v1.0/currentData?language=en`, `Email/Password = FEED_USERNAME /
   FEED_PASSWORD`, `DeviceSn = <plant code>`. Our side answers the token and
   `currentData` shapes with `dataList` keys `APo_t1`, `Et_ge0`, `Etdy_ge1`,
   `PG_Pt1`, `t_gc1`, `Et_pu1`, … (the Solarman keys the counters already
   carry); the 50 counters would need renaming and trimming before export.

Both dialects are implemented in `prediction/feed.js` (`/feed/solax/…`,
`/feed/solarman/…`) and documented in [feed-contract.md](feed-contract.md).
Which flow the driver runs is chosen by Mars2 from the parameter category;
the device `Model` field is cosmetic (the live devices below poll with
`Model = Solax`, `Proizvođač = Končar INEM`, `Vrsta = Električno brojilo`
copied from `SRDFARETLA`).

## 8. What was built (2026-11-12) and how the live system behaves

Three plants were added with the Solax-dialect procedure above. All three
export through `CustomDataExport/BIOS/<code>` with the `SOLAXBIOS` column
layout (15 columns, `Position` 0–14).

| Plant node | Mjerno mjesto code | Device node (name) | Mjerna točka node | Variable nodes (Position) |
|---|---|---|---|---|
| node/872 `SC Soko 46 kWp (Huawei)` | `SOKO46` | node/821 (`SOKO46BIOS`) | node/873 | 874 = 13 (`Inverter.AC.power.total`), 875 = 0 (`Grid.power.total`); the other 13 variables sit under node/873 (IDs not recorded) |
| node/890 `SC SOKO Bazen 275.4 kWp (Huawei)` | `SOKOBAZEN` | node/838 (`SOKOBAZENBIOS`) | node/891 | 901 = 0, 893 = 1, 902 = 2, 903 = 3, 894 = 4, 895 = 5, 904 = 6, 896 = 7, 905 = 8, 897 = 9, 906 = 10, 898 = 11, 907 = 12, 900 = 13, 899 = 14 |
| node/751 `Solis Veterinarski Institut` (pre-existing; empty placeholder child `SolisCloud` node/752 left in place) | `VETINST` | node/855 (`VETINSTBIOS`) | node/908 | 918 = 0, 910 = 1, 919 = 2, 920 = 3, 911 = 4, 912 = 5, 921 = 6, 913 = 7, 922 = 8, 914 = 9, 923 = 10, 915 = 11, 924 = 12, 917 = 13, 916 = 14 |

Device parameters (category `Solax`) on all three: `BaseUrl =
https://bios-multilevel.barrage.net/prediction/feed/solax/`, `TokenId =
<FEED_API_KEY>`, `RealTimeInfoEndpoint = proxyApp/proxy/api/getRealtimeInfo.do`,
`DeviceSn = <code>`. The device node names and the `SOKO46BIOS` serial carry a
`BIOS` suffix from the first attempt; they are labels only, the export codes
are the Mjerno mjesto codes.

Findings from the first live run:

- **`BaseUrl` must end with `/`.** With
  `…/prediction/feed/solax` (no slash) Mars2 showed everything as healthy —
  counters in the readout group, readouts planned, no alarm — and stored
  nothing for hours. The Http driver resolves `RealTimeInfoEndpoint` against
  `BaseUrl` as a relative URI, which drops the base's last segment, so the
  requests went to `/prediction/feed/proxyApp/…` and were refused by the
  dashboard's exact-match allow-list (404). `SRDFARETLA` never hit this
  because its `BaseUrl` is a bare origin (`https://www.solaxcloud.com`).
  Adding the slash made the next 5-minute readout succeed; our side now also
  accepts the slash-less spellings (`canonicalFeedPath`).
- **Polling period = 5 minutes, no configuration needed.** `Upravljanje
  očitanjima > Grupe` has one group, `Http` (id 3, `Na temelju driver-a`,
  schedule `5 minutni`); every counter of an `Http`-driver device is included
  automatically (filter PUTANJA `Sadrži` "Solari/S" showed 48 rows = 16
  counters × 3 devices). `Očitanja > Planirana očitanja` lists 288 readouts
  per 24 h. The export confirms it: `SOLAXBIOS` has one record every 5
  minutes around the clock (355 records in 30 h), vendor data is also 5-minutely.
- **Nothing in Mars2 reports a failing poll.** `Nadzor i upravljanje >
  Očitaj uređaj` answers "BROJ OČITANIH BROJAČA: 0" even for the working
  `SRDFARETLA`; `Alarmi uređaji` / `Alarmi sustava` stayed empty;
  `Administracija > Upravljanje instancama servisa` lists no instances. The
  only places that show the truth are the export itself and our own side:
  `GET /prediction/freshness` → `feed.requestsTotal`, `feed.lastRequestAt`,
  `feed.recent`, and the dashboard access log (`GET <path> -> <status>`).
- **Two time conventions, both constant (measured 2026-11-12):**
  (a) `CustomDataExport` reads `fromUTC`/`toUTC` as Croatian local time, so
  a window ending "now" lacks the newest hour (two in summer) and a request
  for `[F, T]` returns `[F-1h, T-1h]`; every client of ours (prediction
  ingest, partner tool) therefore asks for 2 h more on each side and clips
  the rows to the window it wanted. (b) The Solax dialect stamps a reading
  with `uploadTime` read as fixed UTC+2 (what Solax Cloud sends for
  `SOLAXBIOS`); a naive time in `Europe/Zagreb` came out one hour early in
  winter, so the feed sends `uploadTime` in `Etc/GMT-2`. Proof: our SOKO46
  sample 21:16:49Z (`consumeenergy` 36851.72) was exported as 20:16:49Z with
  the same value; SOLAXBIOS rows match daylight (production 06:25Z–15:00Z
  against sunrise 05:55Z / sunset 15:25Z).
- `CounterCode` matching is case-insensitive in practice (PascalCase codes,
  camelCase JSON — values arrive).
- A template made from `SRDFARETLA` keeps the `Solax` category and the flow.
- Leftovers to decide on: temporary devices `SOKO46BIOS feed` and `Novi
  Solarman uređaj` (50 Solarman counters each, both in the `Http` readout
  group, polling nothing useful) and the placeholder node/752 `SolisCloud`.
  Deleting needs the red ✖ / "Obriši čvor", which this work never used.

## Open points for the Mars2 team

- Node IDs of the new variables for the `Sumarne vrijednosti` formulas:
  `Inverter.AC.power.total` is node 874 (SOKO46), 900 (SOKOBAZEN), 917
  (VETINST) if the totals should include the new plants.
