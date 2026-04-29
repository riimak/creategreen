# Blockchain Integration Service

Always-on Stealth blockchain relay for critical platform events.

The service can be placed near data collection or receive events from another
platform component. It does not store raw measurements. It encodes compact event
payloads and submits them to Stealth.

## Event Payload V1

The first supported format follows the Stealth integration email example:

| Field | Bytes | Description |
| --- | ---: | --- |
| `device_id` | 2 | unsigned integer, big endian |
| `timestamp` | 4 | UNIX timestamp, big endian |
| `event_code` | 1 | configured event type code |
| `value` | 2 | scaled integer primary value |
| `crc` | 4 | CRC32 over canonical event metadata |

The current production proof format is `stealth-event-v2`:

| Field | Bytes | Description |
| --- | ---: | --- |
| `schema_version` | 1 | currently `2` |
| `source_id` | 2 | OS1BIOS, OS2BIOS, SOLAXBIOS |
| `timestamp` | 4 | UNIX timestamp, big endian |
| `event_code` | 1 | data window, quality, prediction, anomaly, SLA |
| `metric_code` | 1 | PM2.5, temperature, inverter power, etc. |
| `status_code` | 1 | ok, stale, breached, generated, detected |
| `value` | 2 | scaled count, missing ratio, age, severity or point count |
| `crc` | 4 | CRC32 over canonical off-chain metadata |

Total size: 16 bytes, below the 40-byte Stealth payload limit.

`stealth-event-v1` is kept for tests/backward compatibility:

Example event:

```json
{
  "device_id": "0x0A1C",
  "timestamp": 1717699200,
  "event_code": "ok",
  "value": 250
}
```

## Endpoints

```sh
GET /health
GET /status
GET /events
GET /events/latest
POST /events
GET /events/:id
GET /verify/:txid
GET /chain/status
GET /chain/transactions
GET /chain/blocks
GET /feeless/status
```

The service runs one event cycle on startup, then repeats on
`BLOCKCHAIN_INTERVAL_SECONDS`. `POST /events` remains available for manual or
external event submission.

## Event Sources

Configured with `BLOCKCHAIN_EVENT_SOURCE`:

- `demo` -- deterministic heartbeat/status events for demo operation.
- `prediction` -- polls the prediction API for latest anomalies and
  data-quality/SLA issues and anchors new artifacts only once.
- `amqp` -- optional integration through `amqp-adapter.js` when `amqplib` is
  available.

The default Docker Compose mode is `prediction`.

The recommended production source is `prediction`. It anchors meaningful data
pipeline facts only:

- `data_batch_seen`
- `data_quality_changed`
- `prediction_generated`
- `sla_breached`
- `anomaly_detected` (only when `BLOCKCHAIN_ANCHOR_ANOMALIES=true` and the event type is listed in `BLOCKCHAIN_EVENT_FILTERS`)

It does not anchor every measurement row and it does not anchor every poll.
With `PREDICTION_TARGETS=auto`, the prediction service discovers every numeric
field in the configured BIOS stations, and the blockchain service receives
data-window/data-quality/anomaly/SLA events for all discovered fields.
`prediction_generated` is **enabled** by default via `BLOCKCHAIN_ANCHOR_PREDICTIONS=true` in compose; you can set it to `false` to reduce forecast volume on the chain.

Statistical `anomaly_detected` events (model 3-sigma / quality flags from `/anomalies`) are **not** ingested for anchoring unless you opt in. That avoids noisy `prediction-anomaly` rows in production ledgers. To anchor them (e.g. in a lab), set both:

```sh
BLOCKCHAIN_ANCHOR_ANOMALIES=true
# and include anomaly_detected in BLOCKCHAIN_EVENT_FILTERS
```

## AMQP

```sh
BLOCKCHAIN_AMQP_MODE=consume
BLOCKCHAIN_INPUT_HOST=amqp://localhost
BLOCKCHAIN_INPUT_QUEUE=critical-events
node bios-multilevel-platform-services/blockchain/amqp-adapter.js
```

Use `BLOCKCHAIN_AMQP_MODE=consume_publish` to publish processing results to
`BLOCKCHAIN_OUTPUT_QUEUE` (default `map-events`).

## Stealth Relay Modes

- `STEALTH_RELAY_MODE=mock` -- default, deterministic fake transaction id.
- `STEALTH_RELAY_MODE=json-rpc` -- use Stealth JSON-RPC 2.0 for status,
  transaction and block lookups.
- `STEALTH_RELAY_MODE=stealth-lib` -- load the real `stealth-lib` package.

The JSON-RPC shape follows the StealthSend desktop app:

```json
{
  "jsonrpc": "2.0",
  "id": 666420,
  "method": "gettransaction",
  "params": ["<txid>"]
}
```

Useful method defaults:

```sh
STEALTH_RPC_STATUS_METHOD=getinfo
STEALTH_RPC_TX_METHOD=gettransaction
STEALTH_RPC_BLOCK_METHOD=getblock
STEALTH_RPC_BEST_BLOCK_METHOD=getbestblock
STEALTH_RPC_SEND_METHOD=sendrawtransaction
```

Real feeless event submission requires raw transaction construction and signing.
The service exposes `/feeless/status` so the dashboard can show whether this is
configured. At minimum, production submission needs:

- `STEALTH_RPC_URL` for `getbestblock` and `sendrawtransaction`.
- A service wallet/private signing source with spendable UTXO, or
  `STEALTH_RAW_TX_BUILDER_URL` for an external builder.
- Feeless work calculation and transaction signing before broadcast.

Until wallet/UTXO signing is configured, JSON-RPC mode can verify and display
chain status/tx/block data while mock mode remains the full local demo path.

Wallet accounts are deterministically derived per device from
`BLOCKCHAIN_WALLET_SEED` or `BLOCKCHAIN_WALLET_SEED_FILE`.
