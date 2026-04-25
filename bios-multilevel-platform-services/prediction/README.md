# Predictive Analysis Service

Small REST service for short-term prediction and anomaly detection over
BIOS/SOLAX measurements.

## Endpoints

```sh
GET /health
GET /models
GET /forecast?source=OS1BIOS&metric=PM2_5&horizon=24
GET /anomalies?source=OS1BIOS&metric=PM2_5&hours=24
```

Forecast horizon is capped at 48 hours, matching the delivered technical
solution.

## Data Sources

The service reads current data from one of:

- `PREDICTION_DATA_API_BASE` -- existing Worker API, e.g. `/api/data`.
- `BIOS_OUTPUT_DIR` -- local semicolon export files, default `./output`.

Mars2/BIOS remains the source of truth. The service stores only forecast and
anomaly artifacts, not raw measurement rows.

## Models

The first implementation intentionally stays small:

- linear regression
- seasonal hourly baseline
- holdout-based selection between available models

This is enough for a reproducible demonstrator and can be replaced by ARIMA,
Prophet, or neural models later without changing the API.

## Scheduling

Set `PREDICTION_INTERVAL_MINUTES` and `PREDICTION_TARGETS` to refresh forecasts
in the background:

```sh
PREDICTION_INTERVAL_MINUTES=60
PREDICTION_TARGETS=OS1BIOS:PM2_5,SOLAXBIOS:Inverter_AC_power_total
```
