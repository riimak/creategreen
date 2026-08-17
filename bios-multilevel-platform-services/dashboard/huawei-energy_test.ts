import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";

/**
 * Unit tests for the Huawei (FusionSolar) aggregation helpers that live
 * inline in index.html. The helpers are pure functions, so we extract their
 * source text and evaluate them in isolation.
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
  extractConst("HUAWEI_INVERTER_POWER_KEYS"),
  extractConst("HUAWEI_GRID_POWER_KEYS"),
  extractConst("HUAWEI_SOC_KEYS"),
  extractConst("HUAWEI_BATT_POWER_KEYS"),
  extractConst("HUAWEI_TO_GRID_KEYS"),
  extractConst("HUAWEI_FROM_GRID_KEYS"),
  extractFunction("processStationRows"),
  extractFunction("pickMetricKey"),
  extractFunction("pickLatestValue"),
  extractFunction("pickSeries"),
  extractFunction("freshLatestValue"),
  extractFunction("sumPowerSeries"),
  extractFunction("isHuaweiSource"),
  extractFunction("huaweiPlantOf"),
  extractFunction("computeHuaweiPlant"),
].join("\n");

const helpers = new Function(
  `${source}
   return { sumPowerSeries, computeHuaweiPlant, isHuaweiSource, huaweiPlantOf };`,
)() as {
  // deno-lint-ignore no-explicit-any
  sumPowerSeries: (list: any[]) => { x: Date; y: number }[];
  // deno-lint-ignore no-explicit-any
  computeHuaweiPlant: (plantSource: string, group: any) => any;
  isHuaweiSource: (s: string) => boolean;
  huaweiPlantOf: (s: string) => string;
};

const BUCKET_MS = 5 * 60 * 1000;
// A fixed instant aligned to a 5-minute bucket boundary keeps expectations exact.
const nowMs = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
const nowS = nowMs / 1000;

function pt(offsetMin: number, y: number) {
  return { x: new Date(nowMs + offsetMin * 60 * 1000), y };
}

Deno.test("source helpers recognize Huawei plant and device sources", () => {
  assert(helpers.isHuaweiSource("HUAWEI:NE=123"));
  assert(helpers.isHuaweiSource("HUAWEI:NE=123:device:42"));
  assert(!helpers.isHuaweiSource("SOLAXBIOS"));
  assertEquals(helpers.huaweiPlantOf("HUAWEI:NE=123:device:42"), "HUAWEI:NE=123");
  assertEquals(helpers.huaweiPlantOf("HUAWEI:NE=123"), "HUAWEI:NE=123");
});

Deno.test("sumPowerSeries sums series per 5-minute bucket with short carry-forward", () => {
  const a = [pt(0, 10), pt(5, 12), pt(10, 14)];
  const b = [pt(0, 1), pt(10, 3)];
  const merged = helpers.sumPowerSeries([a, b]);
  assertEquals(merged.length, 3);
  // b has no reading in the middle bucket: its previous value is carried.
  assertEquals(merged.map((p) => p.y), [11, 13, 17]);
  for (let i = 1; i < merged.length; i += 1) {
    assert(merged[i].x.getTime() > merged[i - 1].x.getTime());
  }
});

Deno.test("sumPowerSeries passes a single series through unchanged", () => {
  const a = [pt(5, 12), pt(0, 10)];
  const merged = helpers.sumPowerSeries([a]);
  assertEquals(merged.map((p) => p.y), [10, 12]);
});

Deno.test("sumPowerSeries drops stale carry-forward after 15 minutes", () => {
  const a = [pt(0, 10), pt(5, 10), pt(10, 10), pt(20, 10), pt(25, 10)];
  const b = [pt(0, 5)];
  const merged = helpers.sumPowerSeries([a, b]);
  // b contributes at +0, +5, +10, +15 (carry limit) but not at +20/+25.
  const ys = merged.map((p) => p.y);
  assertEquals(ys[0], 15);
  assertEquals(ys[ys.length - 1], 10);
});

function row(source: string, metric: string, value: number, tsOffsetSec: number) {
  return { source, metric, value, timestamp: nowS + tsOffsetSec, isMissing: false };
}

Deno.test("computeHuaweiPlant aggregates devices and treats yields as period totals", () => {
  const plantSource = "HUAWEI:NE=201410062";
  const plantRows = [
    row(plantSource, "huawei.plant.daily_yield_kwh", 131.89, -300),
    row(plantSource, "huawei.plant.monthly_yield_kwh", 6710, -300),
    // Older reading from earlier today must NOT be subtracted from the latest.
    row(plantSource, "huawei.plant.daily_yield_kwh", 40.2, -21600),
  ];
  const dev = (id: string) => `${plantSource}:device:${id}`;
  const devices = new Map([
    [dev("1"), [
      row(dev("1"), "huawei.string_inverter.active_power_kw", 20.0, -300),
      row(dev("1"), "huawei.string_inverter.active_power_kw", 18.0, -600),
    ]],
    [dev("2"), [row(dev("2"), "huawei.string_inverter.active_power_kw", 15.9, -300)]],
    [dev("3"), [row(dev("3"), "huawei.power_sensor.active_power_kw", 29.65, -300)]],
    [dev("4"), [
      row(dev("4"), "huawei.battery.state_of_charge_percent", 55, -300),
      row(dev("4"), "huawei.battery.charge_discharge_power_kw", -2.5, -300),
    ]],
    // Stale inverter (2 h old) must not count toward current power.
    [dev("5"), [row(dev("5"), "huawei.string_inverter.active_power_kw", 99, -7200)]],
  ]);

  const snap = helpers.computeHuaweiPlant(plantSource, { plantRows, devices });
  assert(snap, "plant snapshot expected");
  assertAlmostEquals(snap.ac, 35.9, 1e-9);
  assertAlmostEquals(snap.grid, 29.65, 1e-9);
  assertEquals(snap.daily, 131.89);
  assertEquals(snap.monthly, 6710);
  assertEquals(snap.soc, 55);
  assertEquals(snap.battPower, -2.5);
  assert(snap.lastTs >= nowS - 300);
  assert(Array.isArray(snap.acSeries) && snap.acSeries.length > 0);
});

Deno.test("computeHuaweiPlant returns null when the plant has no usable data", () => {
  const snap = helpers.computeHuaweiPlant("HUAWEI:NE=0", {
    plantRows: [],
    devices: new Map(),
  });
  assertEquals(snap, null);
});

Deno.test("measurements meta consumers include observed metrics and dynamic labels", () => {
  assert(
    dashboard.includes("meta.metrics?.observed"),
    "metric dropdown must include metrics observed in the database",
  );
  assert(
    dashboard.includes("dynamicStationLabels"),
    "station labels from /measurements/meta must be used",
  );
});
