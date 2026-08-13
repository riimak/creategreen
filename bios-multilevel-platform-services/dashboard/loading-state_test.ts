import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert";

const dashboard = await Deno.readTextFile(
  new URL("./index.html", import.meta.url),
);

const INITIAL_PANELS = [
  ["energy", "cardEnergy"],
  ["power", "cardPower"],
  ["forecast", "cardForecastCompact"],
  ["health", "tileHealth"],
  ["ledger", "cardLedgerSummary"],
  ["alerts", "cardAlerts"],
] as const;

Deno.test("overview exposes accessible loading feedback on first paint", () => {
  for (const [panel, elementId] of INITIAL_PANELS) {
    assertMatch(
      dashboard,
      new RegExp(
        `<[^>]+id="${elementId}"[^>]+data-load-panel="${panel}"[^>]+aria-busy="true"`,
      ),
      `${panel} panel must be busy in static HTML`,
    );
    assertStringIncludes(
      dashboard,
      `id="${panel}LoadStatus"`,
      `${panel} panel must expose a status message`,
    );
  }

  assertStringIncludes(dashboard, 'role="status"');
  assertStringIncludes(dashboard, 'aria-live="polite"');
});

Deno.test("loading feedback is localized in Croatian and English", () => {
  const hrStart = dashboard.indexOf("  hr: {");
  const enStart = dashboard.indexOf("  en: {", hrStart);
  const enEnd = dashboard.indexOf("\n};", enStart);
  assert(hrStart >= 0 && enStart > hrStart && enEnd > enStart);
  const dictionaries = [
    dashboard.slice(hrStart, enStart),
    dashboard.slice(enStart, enEnd),
  ];

  for (
    const key of [
      "loading.energy",
      "loading.power",
      "loading.forecast",
      "loading.health",
      "loading.ledger",
      "loading.alerts",
      "loading.timed_out",
      "loading.failed",
      "loading.retry",
    ]
  ) {
    for (const dictionary of dictionaries) {
      assertEquals(
        dictionary.match(new RegExp(`'${key}'`, "g"))?.length,
        1,
        `${key} must be defined once in each translation dictionary`,
      );
    }
  }
});

Deno.test("panel state controller supports terminal states and timeout recovery", () => {
  assertStringIncludes(
    dashboard,
    "const PANEL_STATES = new Set(['loading', 'ready', 'empty', 'error']);",
  );
  assertMatch(
    dashboard,
    /function setPanelState\(panelId, state, messageKey\)/,
  );
  assertStringIncludes(dashboard, "const INITIAL_LOADING_TIMEOUT_MS = 10_000;");
  assertStringIncludes(dashboard, "setPanelState(panelId, 'error', 'loading.timed_out')");
  assertStringIncludes(dashboard, "data-panel-retry");
});

Deno.test("loading motion is subtle and respects reduced motion", () => {
  assertStringIncludes(dashboard, ".panel-load-status");
  assertStringIncludes(dashboard, ".panel-load-skeleton");
  assertMatch(
    dashboard,
    /@media\(prefers-reduced-motion:reduce\)[\s\S]*?\.panel-load-skeleton/,
  );
  assert(
    !dashboard.includes("loading-overlay"),
    "loading feedback must not block the dashboard",
  );
});
