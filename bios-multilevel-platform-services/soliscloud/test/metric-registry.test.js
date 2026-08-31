const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeStation,
  normalizeInverter,
  stationMeasurements,
  inverterMeasurements,
  inverterDayMeasurements,
  sourceKey,
  deviceSourceKey,
} = require('../metric-registry');

const TS = 1788167536272;
const TS_ISO = new Date(TS).toISOString();

test('normalizes a station record with metadata', () => {
  const station = normalizeStation({
    id: '1298491919450845346',
    stationName: 'Bogojević',
    capacity: 13.64,
    capacityStr: 'kWp',
    timeZone: 1,
    fisPowerTime: 1700000000000,
    installer: 'Green Energy Save Group',
  });
  assert.strictEqual(station.stationId, '1298491919450845346');
  assert.strictEqual(station.sourceKey, 'SOLIS:1298491919450845346');
  assert.strictEqual(station.displayName, 'Bogojević');
  assert.strictEqual(station.timezone, 1);
  assert.strictEqual(station.metadata.capacity, 13.64);
  assert.strictEqual(station.metadata.fisPowerTime, 1700000000000);
});

test('station measurements convert units and use the record timestamp', () => {
  const raw = {
    id: '42',
    dataTimestamp: String(TS),
    power: 250,
    powerStr: 'W',
    dayEnergy: 5.2,
    dayEnergyStr: 'kWh',
    monthEnergy: 1.2,
    monthEnergyStr: 'MWh',
    allEnergy: 32.3,
    allEnergyStr: 'MWh',
    gridSellTodayEnergy: 4.4,
    batteryTodayChargeEnergy: 1.1,
  };
  const station = normalizeStation(raw);
  const { measurements, skipped } = stationMeasurements(raw, station);
  const byMetric = Object.fromEntries(measurements.map((m) => [m.metric, m]));
  assert.strictEqual(byMetric['solis.plant.current_power_kw'].value, 0.25);
  assert.strictEqual(byMetric['solis.plant.daily_yield_kwh'].value, 5.2);
  assert.strictEqual(byMetric['solis.plant.monthly_yield_kwh'].value, 1200);
  assert.ok(Math.abs(byMetric['solis.plant.total_yield_kwh'].value - 32_300) < 1e-6);
  assert.strictEqual(byMetric['solis.plant.daily_grid_sell_kwh'].value, 4.4);
  assert.strictEqual(byMetric['solis.plant.daily_battery_charge_kwh'].value, 1.1);
  assert.ok(measurements.every((m) => m.ts === TS_ISO));
  assert.ok(measurements.every((m) => m.source === 'SOLIS:42'));
  assert.deepStrictEqual(skipped, []);
});

test('station records without a data timestamp produce no measurements', () => {
  const raw = { id: '42', power: 5, powerStr: 'kW' };
  const { measurements, skipped } = stationMeasurements(raw, normalizeStation(raw));
  assert.deepStrictEqual(measurements, []);
  assert.deepStrictEqual(skipped, ['dataTimestamp']);
});

test('unknown unit strings skip the field instead of mis-scaling it', () => {
  const raw = { id: '42', dataTimestamp: String(TS), power: 5, powerStr: 'PS' };
  const { measurements, skipped } = stationMeasurements(raw, normalizeStation(raw));
  assert.deepStrictEqual(measurements, []);
  assert.deepStrictEqual(skipped, ['power']);
});

test('normalizes inverter records and maps live fields', () => {
  const raw = {
    id: '1308675217950565426',
    sn: '103330025B200238',
    stationId: '1298491919450845346',
    productModel: '3330',
    power: 10,
    powerStr: 'kW',
    pac: 2.679,
    pacStr: 'kW',
    etoday: 5.4,
    etodayStr: 'kWh',
    etotal: 1.2,
    etotalStr: 'MWh',
    dataTimestamp: String(TS),
  };
  const device = normalizeInverter(raw);
  assert.strictEqual(device.deviceSn, '103330025B200238');
  assert.strictEqual(device.stationId, '1298491919450845346');
  assert.strictEqual(device.model, '3330');
  const { measurements } = inverterMeasurements(raw, device);
  const byMetric = Object.fromEntries(measurements.map((m) => [m.metric, m]));
  assert.strictEqual(byMetric['solis.inverter.active_power_kw'].value, 2.679);
  assert.strictEqual(byMetric['solis.inverter.daily_yield_kwh'].value, 5.4);
  assert.strictEqual(byMetric['solis.inverter.total_yield_kwh'].value, 1200);
  assert.ok(measurements.every((m) => (
    m.source === deviceSourceKey('1298491919450845346', '103330025B200238')
  )));
});

test('inverter day points treat power as watts despite the kW unit string', () => {
  const device = { deviceSn: 'SN1', stationId: '42' };
  // Real payload shape: pacStr lies ("kW"), values are watts (vendor bug,
  // verified against the live API for 5 kW and 50 kW inverters).
  const point = {
    dataTimestamp: String(TS),
    pac: 7420,
    pacStr: 'kW',
    eToday: 12.5,
    eTotal: 36362,
    batteryCapacitySoc: 88,
    batteryPower: -1500,
    gridPurchasedTodayEnergy: 0.7,
    inverterTemperature: 41.2,
  };
  const { measurements } = inverterDayMeasurements(point, device);
  const byMetric = Object.fromEntries(measurements.map((m) => [m.metric, m]));
  assert.strictEqual(byMetric['solis.inverter.active_power_kw'].value, 7.42);
  assert.strictEqual(byMetric['solis.inverter.daily_yield_kwh'].value, 12.5);
  assert.strictEqual(byMetric['solis.inverter.total_yield_kwh'].value, 36362);
  assert.strictEqual(byMetric['solis.inverter.battery_soc_percent'].value, 88);
  assert.strictEqual(byMetric['solis.inverter.battery_power_kw'].value, -1.5);
  assert.strictEqual(byMetric['solis.inverter.daily_grid_purchased_kwh'].value, 0.7);
  assert.strictEqual(byMetric['solis.inverter.temperature_c'].value, 41.2);
});

test('source keys require identifiers', () => {
  assert.throws(() => sourceKey(''), /stationId is required/);
  assert.throws(() => deviceSourceKey('42', ''), /deviceSn is required/);
});
