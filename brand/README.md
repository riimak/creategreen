# CREATEGREEN brand assets

Official vector logos sliced from the original `.ai` source files.
All assets are SVG and scale cleanly at any size.

| File | What it is | Use |
| --- | --- | --- |
| `creategreen-logo.svg` | Badge (wind turbines + plant) left of the CREATEGREEN wordmark, 485×71 | **Primary lockup** — headers, print, anywhere |
| `creategreen.svg` | Wordmark left, badge right, 485×71 | Alternate lockup |
| `creategreen-logo-with-large-padding.svg` | Wordmark left, badge far right with a wide gap, 800×71 | Wide layouts (e.g. full-width banners) |
| `creategreen-icon.svg` | Badge only, 71×71 (extracted from the lockup) | Avatar / favicon / small mark |
| `interreg-logo.svg` | Official Interreg IPA Croatia–Serbia logo with the EU flag ("co-funded by the European Union"), 802×182 | EU visibility / funding compliance |

## Color

- Brand green: `#91C852` (from the source artwork)
- Interreg blue: `#0B50A1` / `#074EA2`

## Where they are used

- The platform dashboard (`bios-multilevel-platform-services/dashboard`)
  inlines the primary lockup in the header of `index.html` (the Deno handler
  has a strict CSP, but `img-src 'self'` plus inline `<svg>` are fine).
- `creategreen-icon.svg` and `interreg-logo.svg` are served from
  `dashboard/assets/` (favicon and the EU visibility page respectively).
