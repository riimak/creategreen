# Predictive Analysis Service

Always-on REST service for short-term prediction, anomaly detection, data
quality and SLA overview over BIOS/SOLAX measurements.

## Endpoints

```sh
GET /health
GET /status
GET /models
GET /forecasts
GET /forecasts/latest?source=OS1BIOS&metric=PM2_5
GET /forecast?source=OS1BIOS&metric=PM2_5&horizon=24
GET /anomalies
GET /data-quality
GET /data-quality/latest?source=OS1BIOS&metric=PM2_5
GET /sla
GET /sla?window=1h|24h|7d
```

Forecast horizon is capped at 48 hours, matching the delivered technical
solution.

## Data Sources

The service reads current data from one of:

- `PREDICTION_DATA_API_BASE` -- existing Worker API, e.g. `/api/data`.
- `BIOS_OUTPUT_DIR` -- local semicolon export files, default `./output`.

Mars2/BIOS remains the source of truth. The service stores only forecast,
anomaly, data-quality and SLA artifacts, not raw measurement rows.

## Models

The first implementation intentionally stays small:

- linear regression
- seasonal hourly baseline
- holdout-based selection between available models

This is enough for a reproducible demonstrator and can be replaced by ARIMA,
Prophet, or neural models later without changing the API.

## Scheduling

Set `PREDICTION_INTERVAL_MINUTES` and `PREDICTION_TARGETS` to refresh forecasts,
anomalies and data-quality state in the background. By default the service uses
`PREDICTION_TARGETS=auto`, discovers every numeric field in the configured
stations, and processes all of them:

```sh
PREDICTION_INTERVAL_MINUTES=60
PREDICTION_TARGETS=auto
PREDICTION_STATIONS=OS1BIOS,OS2BIOS,SOLAXBIOS
```

The service runs one cycle on startup, then repeats on the configured interval.

## Missing Data And SLA

Missing or unrecorded values are treated as data-quality state, not as process
failures. Each cycle stores expected sample count, observed numeric samples,
missing ratio, latest timestamp and status:

- `ok`
- `partial`
- `stale`
- `insufficient_data`

SLA summaries are calculated from these artifacts with `SLA_TARGET_PERCENT`
(default `95`).

Forecast artifacts include `metricInfo`, with label, unit, domain and
description. This keeps the dashboard explicit about what is being forecast:
for example `PM2_5` is shown as fine particles PM2.5 in `ug/m3`, while
`Inverter_AC_power_total` is shown as inverter AC power in `kW`.

Data quality and SLA artifacts also include `inputSource`, so users can see
whether the service is checking live Mars2 REST API input or local
partner-export files.

Optional stale-data notifications can be sent to a generic webhook:

```sh
NOTIFICATIONS_ENABLED=true
NOTIFICATION_WEBHOOK_URL=https://example.invalid/webhook
NOTIFICATION_STALE_AFTER_MINUTES=60
NOTIFICATION_REPEAT_AFTER_MINUTES=240
```
