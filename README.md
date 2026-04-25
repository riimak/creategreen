# BIOS Multi-level Platform

This repository contains the BIOS multi-level platform support code, organized by audience and delivery purpose.

## Repository Map

| Area | Purpose |
| --- | --- |
| `partner-export/` | Novi Sad / partner export tooling. Fetches Mars2 BIOS data and writes the agreed ASCII/semicolon files. |
| `perl-lib/` | Reusable Perl parser for exported BIOS files, plus tests. |
| `docs/` | GitHub Pages deployment folder for the live BIOS dashboard over production Mars2 API. |
| `bios-multilevel-live-dashboard/` | Ownership/docs for the production Mars2 live dashboard, Cloudflare Worker proxy, and Mars2 API reference. |
| `bios-multilevel-platform-services/` | Assignment add-on services: prediction analysis, blockchain integration, and Deno services dashboard. |
| `output/` | Local generated export files. Only `.gitkeep` is tracked. |

Project assignment documents and technical PDFs are local-only reference material and are ignored by git.

## Partner Export Quick Start

```sh
cp .env.example .env
# fill BIOS_USERNAME and BIOS_PASSWORD
bash bios-export.sh fetch --from "2026-03-01 00:00:00" --to "2026-03-02 00:00:00"
bash bios-export.sh report --month 2026-03
```

The root scripts are compatibility wrappers around `partner-export/`.

## Platform Services Quick Start

```sh
cd bios-multilevel-platform-services
docker compose up --build
```

Open the services dashboard at `http://localhost:8000`.

## Tests

```sh
bash test_bios_export.sh
bash partner-export/test_bios_export.sh
```

When Perl tooling is available:

```sh
prove -Iperl-lib/lib perl-lib/t/
```

When Node.js is available:

```sh
node bios-multilevel-platform-services/prediction/test.js
node bios-multilevel-platform-services/blockchain/test.js
```

## Live Dashboard

The production-data dashboard remains in `docs/` for GitHub Pages. It demonstrates what can be done by consuming the production Mars2 API through the Worker in `bios-multilevel-live-dashboard/`.