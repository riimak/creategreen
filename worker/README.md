# CREATEGREEN API Worker

Cloudflare Worker that proxies the Mars2 API. Handles authentication,
parses the wire format, and returns clean JSON. Credentials are stored
as Worker secrets -- never exposed to the browser.

## Deploy

```sh
cd worker
npx wrangler deploy
```

## Set secrets

```sh
npx wrangler secret put BIOS_USERNAME
npx wrangler secret put BIOS_PASSWORD
```

## Local development

```sh
npx wrangler dev
# then: curl "http://localhost:8787/api?station=OS1BIOS&hours=6"
```

## API

```
GET /api?station=OS1BIOS&hours=24
```

| Param     | Required | Default | Description                          |
|-----------|----------|---------|--------------------------------------|
| `station` | yes      |         | OS1BIOS, OS2BIOS, or SOLAXBIOS       |
| `hours`   | no       | 24      | Time window (1-168)                  |

### Response

```json
{
  "station": "OS1BIOS",
  "fields": ["Temperatura", "Relativna vlaznost", ...],
  "count": 24,
  "from": "2026-03-23 00:00:00",
  "to": "2026-03-24 00:00:00",
  "data": [
    {
      "station": "OS1BIOS",
      "timestamp": 1774047600,
      "Temperatura": 9.1,
      "Relativna vlaznost": 52.1,
      ...
    }
  ]
}
```
