# CREATEGREEN brand assets

Logo extracted from the official Interreg IPA Croatia–Serbia CREATEGREEN
visibility sticker. The mark is monochrome lime green.

| File | What it is | Use |
| --- | --- | --- |
| `creategreen-wordmark.svg` | Vector wordmark (traced, scalable) | **Primary asset** — headers, print, anywhere |
| `creategreen-wordmark.png` | Wordmark, transparent, 1166×160 | Quick raster use |
| `creategreen-icon.png` | Circular badge (wind turbines + plant), transparent, 512×512 | Avatar / favicon / small mark |
| `creategreen-lockup.png` | Icon + wordmark horizontal lockup, transparent, 1199×206 | Combined branding |

## Color

- Lime green: `#A5C14E` (sampled from the source artwork)

## Notes

- The wordmark is vectorized, so it stays crisp at any size. Prefer the SVG.
- The icon is a raster: the source badge is only ~48 px, so it is soft when
  enlarged — best used small. (It cannot be sharpened beyond the source.)
- The platform dashboard (`bios-multilevel-platform-services/dashboard`) is
  served by a Deno handler that only serves fixed routes and has a strict CSP.
  It does not serve arbitrary static files, but its `img-src` allows `data:`
  and inline `<svg>`. To use the logo there, inline the SVG markup (or embed a
  `data:` URI) rather than linking to a file path.
