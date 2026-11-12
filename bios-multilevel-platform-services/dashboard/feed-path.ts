// Mars2's Http driver composes each request URL from a device's BaseUrl and a
// relative endpoint (RealTimeInfoEndpoint for the Solax dialect). How the two
// are joined is the driver's business, and the variants differ in ways that
// matter to an exact-match allow-list: RFC 3986 relative resolution against a
// base without a trailing slash replaces the base's last segment (so the
// dialect segment disappears), plain concatenation doubles or drops a slash.
// Every such spelling is mapped to the canonical path here, so a BaseUrl
// spelled slightly differently in Mars2 cannot silently turn into 404s.

export const FEED_PREFIX = "/prediction/feed";
export const FEED_TOKEN_PATH = `${FEED_PREFIX}/token`;
export const FEED_SOLAX_PATH = `${FEED_PREFIX}/solax/proxyApp/proxy/api/getRealtimeInfo.do`;
export const FEED_SOLARMAN_TOKEN_PATH = `${FEED_PREFIX}/solarman/account/v1.0/token`;
export const FEED_SOLARMAN_DATA_PATH = `${FEED_PREFIX}/solarman/device/v1.0/currentData`;

const SOLAX_VARIANT = /^\/prediction\/feed\/(?:solax\/?)?proxyApp\/proxy\/api\/getRealtimeInfo\.do$/;
const SOLARMAN_VARIANT = /^\/prediction\/feed\/(?:solarman\/?)?(account\/v1\.0\/token|device\/v1\.0\/currentData)$/;

/** Canonical spelling of a feed path; anything outside the feed is returned unchanged. */
export function canonicalFeedPath(pathname: string): string {
  if (!pathname.startsWith(FEED_PREFIX)) return pathname;
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  if (SOLAX_VARIANT.test(collapsed)) return FEED_SOLAX_PATH;
  const solarman = SOLARMAN_VARIANT.exec(collapsed);
  if (solarman) return `${FEED_PREFIX}/solarman/${solarman[1]}`;
  return collapsed;
}
