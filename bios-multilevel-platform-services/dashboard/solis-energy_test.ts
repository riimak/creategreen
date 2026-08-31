import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";

/**
 * Unit tests for the Solis (SolisCloud) aggregation helpers that live inline
 * in index.html. Like huawei-energy_test.ts, the helpers are pure functions,
 * so we extract their source text and evaluate them in isolation.
 */
const dashboard = await Deno.readTextFile(
  new URL("./index.html", import.meta.url),
);

function extractFunction(name: string): string {
  const start = dashboard.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in index.html`);
  let i = dashboard.indexOf("{", start);
  let depth = 0;
  for (; i < dashboard.length; i += 1) {
    if (dashboard[i] === "{") depth += 1;
    else if (dashboard[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return dashboard.slice(start, i + 1);
}

function extractConst(name: string): string {
  const start = dashboard.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`const ${name} not found in index.html`);
  const end = dashboard.indexOf(";\n", start);
  return dashboard.slice(start, end + 1);
}

const source = [
  extractConst("SOLIS_INVERTER_POWER_KEYS"),
  extractConst("SOLIS_PLANT_POWER_KEYS"),
  extractConst("SOLIS_SOC_KEYS"),
  extractConst("SOLIS_BATT_POWER_KEYS"),
  extractConst("SOLIS_TO_GRID_KEYS"),
  extractConst("SOLIS_FROM_GRID_KEYS"),
  extractFunction("processStationRows"),
  extractFunction("pickMetricKey"),
  extractFunction("pickLatestValue"),
  extractFunction("pickSeries"),
  extractFunction("freshLatestValue"),
  extractFunction("sumPowerSeries"),
  extractFunction("isSolisSource"),
  extractFunction("solisPlantOf"),
  extractFunction("computeSolisPlant"),
].join("\n");

const helpers = new Function(
  `${source}
   return { computeSolisPlant, isSolisSource, solisPlantOf };`,
)() as {
  // deno-lint-ignore no-explicit-any
  computeSolisPlant: (plantSource: string, group: any) => any;
  isSolisSource: (s: string) => boolean;
  solisPlantOf: (s: string) => string;
};

const nowS = Math.floor(Date.now() / 1000);

function row(metric: string, value: number, ageSec = 60) {
  return { metric, value, timestamp: nowS - ageSec, isMissing: false };
}

Deno.test("source helpers recognize Solis plant and device sources", () => {
  assert(helpers.isSolisSource("SOLIS:129849"));
  assert(helpers.isSolisSource("SOLIS:129849:device:SN1"));
  assert(!helpers.isSolisSource("HUAWEI:NE=123"));
  assert(!helpers.isSolisSource("SOLAXBIOS"));
  assertEquals(helpers.solisPlantOf("SOLIS:129849:device:SN1"), "SOLIS:129849");
  assertEquals(helpers.solisPlantOf("SOLIS:129849"), "SOLIS:129849");
});

Deno.test("computeSolisPlant sums device power and reads plant yields", () => {
  const group = {
    plantRows: [
      row("solis.plant.daily_yield_kwh", 21.5),
      row("solis.plant.monthly_yield_kwh", 340),
      row("solis.plant.current_power_kw", 7.7),
      row("solis.plant.total_grid_sell_kwh", 1200),
      row("solis.plant.total_grid_purchased_kwh", 90),
    ],
    devices: new Map([
      ["SOLIS:42:device:A", [row("solis.inverter.active_power_kw", 3.2)]],
      ["SOLIS:42:device:B", [row("solis.inverter.active_power_kw", 4.4)]],
    ]),
  };
  const snap = helpers.computeSolisPlant("SOLIS:42", group);
  assert(snap !== null);
  // Device sum (7.6) wins over the plant-level reading (7.7).
  assertAlmostEquals(snap.ac, 7.6, 1e-9);
  assertEquals(snap.daily, 21.5);
  assertEquals(snap.monthly, 340);
  assertEquals(snap.toGrid, 1200);
  assertEquals(snap.fromGrid, 90);
  assertEquals(snap.grid, null);
  assert(snap.lastTs > 0);
});

Deno.test("plant-level power is the fallback when no device rows exist", () => {
  const group = {
    plantRows: [
      row("solis.plant.current_power_kw", 5.5),
      row("solis.plant.daily_yield_kwh", 10),
    ],
    devices: new Map(),
  };
  const snap = helpers.computeSolisPlant("SOLIS:42", group);
  assertEquals(snap.ac, 5.5);
  assertEquals(snap.daily, 10);
  assert(Array.isArray(snap.acSeries));
  assert(snap.acSeries.length > 0);
});

Deno.test("stale device power is ignored, falling back to fresh plant power", () => {
  const group = {
    plantRows: [row("solis.plant.current_power_kw", 2.5)],
    devices: new Map([
      // Two hours old — must not contribute to "current" power.
      ["SOLIS:42:device:A", [row("solis.inverter.active_power_kw", 9.9, 2 * 3600)]],
    ]),
  };
  const snap = helpers.computeSolisPlant("SOLIS:42", group);
  assertEquals(snap.ac, 2.5);
});

Deno.test("battery SOC averages and battery power sums across devices", () => {
  const group = {
    plantRows: [],
    devices: new Map([
      ["SOLIS:42:device:A", [
        row("solis.inverter.battery_soc_percent", 80),
        row("solis.inverter.battery_power_kw", -1.5),
      ]],
      ["SOLIS:42:device:B", [
        row("solis.inverter.battery_soc_percent", 60),
        row("solis.inverter.battery_power_kw", 0.5),
      ]],
    ]),
  };
  const snap = helpers.computeSolisPlant("SOLIS:42", group);
  assertEquals(snap.soc, 70);
  assertAlmostEquals(snap.battPower, -1.0, 1e-9);
});

Deno.test("an empty group yields null", () => {
  assertEquals(helpers.computeSolisPlant("SOLIS:42", { plantRows: [], devices: new Map() }), null);
});
