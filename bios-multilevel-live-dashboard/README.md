# BIOS Multi-level Live Dashboard

Production Mars2 API demo for the BIOS team.

The deployed GitHub Pages dashboard remains in `docs/` because GitHub Pages is
configured to publish that folder. This directory owns the supporting pieces:

- `worker.js` -- Cloudflare Worker proxy for the Mars2 API.
- `wrangler.toml` -- Worker deployment config.
- `README-worker.md` -- Worker deployment notes.
- `api-reference/` -- Mars2 API reference.
- `test-api.sh` -- API probe script.

This area demonstrates live production data consumption. The prediction and
blockchain add-on services live separately in `bios-multilevel-platform-services/`.
