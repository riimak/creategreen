import { assertEquals } from "jsr:@std/assert";
import {
  canonicalFeedPath,
  FEED_SOLARMAN_DATA_PATH,
  FEED_SOLARMAN_TOKEN_PATH,
  FEED_SOLAX_PATH,
  FEED_TOKEN_PATH,
} from "./feed-path.ts";

Deno.test("canonicalFeedPath: every way of joining BaseUrl + endpoint reaches the Solax handler", () => {
  const spellings = [
    // BaseUrl ".../feed/solax" + "/" + endpoint
    "/prediction/feed/solax/proxyApp/proxy/api/getRealtimeInfo.do",
    // BaseUrl ".../feed/solax" resolved as a base URI: the last segment is replaced
    "/prediction/feed/proxyApp/proxy/api/getRealtimeInfo.do",
    // BaseUrl ".../feed/solax/" + "/" + endpoint
    "/prediction/feed/solax//proxyApp/proxy/api/getRealtimeInfo.do",
    // BaseUrl ".../feed/solax" + endpoint, no separator at all
    "/prediction/feed/solaxproxyApp/proxy/api/getRealtimeInfo.do",
  ];
  for (const spelling of spellings) {
    assertEquals(canonicalFeedPath(spelling), FEED_SOLAX_PATH, spelling);
  }
});

Deno.test("canonicalFeedPath: Solarman dialect too", () => {
  assertEquals(canonicalFeedPath("/prediction/feed/account/v1.0/token"), FEED_SOLARMAN_TOKEN_PATH);
  assertEquals(canonicalFeedPath("/prediction/feed/solarman//device/v1.0/currentData"), FEED_SOLARMAN_DATA_PATH);
  assertEquals(canonicalFeedPath("/prediction/feed/solarmanaccount/v1.0/token"), FEED_SOLARMAN_TOKEN_PATH);
  assertEquals(canonicalFeedPath(FEED_SOLARMAN_DATA_PATH), FEED_SOLARMAN_DATA_PATH);
});

Deno.test("canonicalFeedPath: canonical paths and the rest of the feed pass through (slashes collapsed)", () => {
  assertEquals(canonicalFeedPath(FEED_SOLAX_PATH), FEED_SOLAX_PATH);
  assertEquals(canonicalFeedPath(FEED_TOKEN_PATH), FEED_TOKEN_PATH);
  assertEquals(canonicalFeedPath("/prediction/feed//plants"), "/prediction/feed/plants");
  assertEquals(canonicalFeedPath("/prediction/feed/plants/SOKO46/current"), "/prediction/feed/plants/SOKO46/current");
});

Deno.test("canonicalFeedPath: does not rewrite anything that is not the Solax/Solarman endpoint", () => {
  // A different endpoint under the dialect prefix is not promoted to the real one.
  assertEquals(
    canonicalFeedPath("/prediction/feed/solax/proxyApp/proxy/api/getHistory.do"),
    "/prediction/feed/solax/proxyApp/proxy/api/getHistory.do",
  );
  assertEquals(canonicalFeedPath("/prediction/feed/solax/../token"), "/prediction/feed/solax/../token");
  // Outside the feed nothing changes, not even doubled slashes; a doubled slash
  // before "feed" cannot come from joining BaseUrl + endpoint, so it is not a feed path either.
  assertEquals(canonicalFeedPath("/prediction//freshness"), "/prediction//freshness");
  assertEquals(canonicalFeedPath("/prediction//feed/solax/proxyApp/proxy/api/getRealtimeInfo.do"), "/prediction//feed/solax/proxyApp/proxy/api/getRealtimeInfo.do");
  assertEquals(canonicalFeedPath("/api/data"), "/api/data");
});
