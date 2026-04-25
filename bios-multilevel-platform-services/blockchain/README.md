# Blockchain Integration Service

Lean Stealth blockchain relay for critical platform events.

The service can be placed near data collection or receive events from another
platform component. It does not store raw measurements. It encodes a compact
event payload and submits it to Stealth.

## Event Payload V1

The first supported format follows the Stealth integration email example:

| Field | Bytes | Description |
| --- | ---: | --- |
| `device_id` | 2 | unsigned integer, big endian |
| `timestamp` | 4 | UNIX timestamp, big endian |
| `event_code` | 1 | configured event type code |
| `value` | 2 | scaled integer primary value |
| `crc` | 4 | CRC32 over canonical event metadata |

Total size: 13 bytes, below the 40-byte Stealth payload limit.

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
POST /events
GET /events/:id
GET /verify/:txid
```

`POST /events` is a REST fallback/demo path. In platform deployment, the service
can consume events from AMQP through `amqp-adapter.js`.

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
- `STEALTH_RELAY_MODE=http` -- POST payloads to `STEALTH_RPC_URL`.
- `STEALTH_RELAY_MODE=stealth-lib` -- load the real `stealth-lib` package.

Wallet accounts are deterministically derived per device from
`BLOCKCHAIN_WALLET_SEED` or `BLOCKCHAIN_WALLET_SEED_FILE`.
