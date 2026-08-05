const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REGISTRY,
  normalizePlant,
  normalizeDevice,
  normalizeKpis,
} = require('../metric-registry');

test('normalizes Huawei 26.1 plant and device inventory fields', () => {
  const plant = normalizePlant({
    plantCode: ' NE=12345678 ',
    plantName: 'Sanitized plant',
    capacity: 146.5,
    gridConnectionDate: '2022-11-21T16:23:00+08:00',
  });
  const device = normalizeDevice({
    id: -214543629611879,
    devDn: 'NE=45112560',
    devName: 'Sanitized inverter',
    stationCode: 'NE=12345678',
    esnCode: 'SANITIZED-SN',
    devTypeId: 1,
    model: 'SUN2000-17KTL',
  }, plant.plantCode);

  assert.deepEqual(plant, {
    plantCode: 'NE=12345678',
    sourceKey: 'HUAWEI:NE=12345678',
    displayName: 'Sanitized plant',
    timezone: null,
    visible: true,
    metadata: {
      capacity: 146.5,
      capacityUnit: 'kWp',
      gridConnectionDate: '2022-11-21T16:23:00+08:00',
    },
  });
  assert.deepEqual(device, {
    deviceId: '-214543629611879',
    plantCode: 'NE=12345678',
    deviceType: '1',
    model: 'SUN2000-17KTL',
    serialNumber: 'SANITIZED-SN',
    metadata: {
      devDn: 'NE=45112560',
      devName: 'Sanitized inverter',
    },
  });
});

test('maps only documented Huawei 26.1 plant yield fields', () => {
  const result = normalizeKpis({
    source: 'HUAWEI:NE=12345678',
    deviceType: 'plant',
    timestamp: 1785924000000,
    payload: {
      day_power: '91.2',
      total_power: 35100,
      active_power: 12.5,
      real_health_state: '3',
    },
  });

  assert.deepEqual(result.measurements, [
    {
      source: 'HUAWEI:NE=12345678',
      metric: 'huawei.plant.daily_yield_kwh',
      ts: '2026-08-05T10:00:00.000Z',
      value: 91.2,
      isMissing: false,
    },
    {
      source: 'HUAWEI:NE=12345678',
      metric: 'huawei.plant.total_yield_kwh',
      ts: '2026-08-05T10:00:00.000Z',
      value: 35100,
      isMissing: false,
    },
  ]);
  assert.deepEqual(result.skipped, ['active_power', 'real_health_state']);
  assert.equal(REGISTRY.plant.day_power.sourceUnit, 'kWh');
  assert.equal(REGISTRY.plant.day_power.endpoint, '/thirdData/getStationRealKpi');
  assert.equal(REGISTRY.plant.day_power.verified, true);
});

test('converts documented meter watts to kW without coercing invalid values', () => {
  const result = normalizeKpis({
    source: 'HUAWEI:device-17',
    deviceType: 17,
    timestamp: 1785924000123,
    payload: {
      active_power: '12500',
      active_cap: 'not-a-number',
      unsupported_numeric: 7,
    },
  });

  assert.deepEqual(result.measurements, [{
    source: 'HUAWEI:device-17',
    metric: 'huawei.grid_meter.active_power_kw',
    ts: '2026-08-05T10:00:00.123Z',
    value: 12.5,
    isMissing: false,
  }]);
  assert.deepEqual(result.skipped, ['active_cap', 'unsupported_numeric']);
  assert.equal(REGISTRY['17'].active_power.sourceUnit, 'W');
  assert.equal(REGISTRY['17'].active_power.destinationUnit, 'kW');
});

test('rejects missing immutable identifiers and invalid timestamps', () => {
  assert.throws(() => normalizePlant({ plantCode: '  ' }), /plantCode/);
  assert.throws(
    () => normalizeDevice({ id: null, devTypeId: 1 }, 'NE=12345678'),
    /device id/,
  );
  assert.throws(
    () => normalizeKpis({
      source: 'HUAWEI:NE=12345678',
      deviceType: 'plant',
      timestamp: '2026-08-05 10:00',
      payload: { day_power: 1 },
    }),
    /timestamp/,
  );
});
