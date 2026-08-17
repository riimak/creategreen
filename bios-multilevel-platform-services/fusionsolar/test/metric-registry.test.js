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

test('maps both documented Huawei 26.1 plant energy aliases in kWh', () => {
  for (const prefix of ['daily', 'day']) {
    const result = normalizeKpis({
      source: 'HUAWEI:NE=12345678',
      deviceType: 'plant',
      timestamp: 1785924000000,
      payload: {
        [`${prefix}_on_grid_energy`]: '9500.12',
        [`${prefix}_use_energy`]: 500.41,
      },
    });

    assert.deepEqual(
      result.measurements.map(({ metric, value }) => ({ metric, value })),
      [
        { metric: 'huawei.plant.daily_on_grid_energy_kwh', value: 9500.12 },
        { metric: 'huawei.plant.daily_consumption_kwh', value: 500.41 },
      ],
    );
    assert.deepEqual(result.skipped, []);
  }
  assert.equal(REGISTRY.plant.day_on_grid_energy.sourceUnit, 'kWh');
  assert.equal(REGISTRY.plant.day_use_energy.destinationUnit, 'kWh');
});

test('daily plant energy fields deterministically take precedence over day aliases', () => {
  const result = normalizeKpis({
    source: 'HUAWEI:NE=12345678',
    deviceType: 'plant',
    timestamp: 1785924000000,
    payload: {
      daily_on_grid_energy: '9500.12',
      daily_use_energy: 500.41,
      day_on_grid_energy: 1,
      day_use_energy: 2,
    },
  });

  assert.deepEqual(result.measurements, [
    {
      source: 'HUAWEI:NE=12345678',
      metric: 'huawei.plant.daily_on_grid_energy_kwh',
      ts: '2026-08-05T10:00:00.000Z',
      value: 9500.12,
      isMissing: false,
    },
    {
      source: 'HUAWEI:NE=12345678',
      metric: 'huawei.plant.daily_consumption_kwh',
      ts: '2026-08-05T10:00:00.000Z',
      value: 500.41,
      isMissing: false,
    },
  ]);
  assert.deepEqual(result.skipped, []);
  assert.equal(REGISTRY.plant.daily_on_grid_energy.field, 'daily_on_grid_energy');
  assert.equal(REGISTRY.plant.daily_on_grid_energy.sourceUnit, 'kWh');
  assert.equal(REGISTRY.plant.daily_on_grid_energy.destinationUnit, 'kWh');
  assert.equal(REGISTRY.plant.daily_use_energy.field, 'daily_use_energy');
  assert.equal(REGISTRY.plant.daily_use_energy.sourceUnit, 'kWh');
  assert.equal(REGISTRY.plant.daily_use_energy.destinationUnit, 'kWh');
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

test('maps documented residential battery (type 39) fields and converts watts', () => {
  const result = normalizeKpis({
    source: 'HUAWEI:NE=12345678:device:1000000037723942',
    deviceType: 39,
    timestamp: 1785924000000,
    payload: {
      battery_soc: '87.5',
      ch_discharge_power: -2500,
      charge_cap: 4.812,
      discharge_cap: '3.107',
      rated_capacity: 15,
      battery_status: 2,
      battery_unit_info: { unit1: { sn: 'x', soh: '90.0%' } },
    },
  });

  assert.deepEqual(
    result.measurements.map(({ metric, value }) => ({ metric, value })),
    [
      { metric: 'huawei.battery.state_of_charge_percent', value: 87.5 },
      { metric: 'huawei.battery.charge_discharge_power_kw', value: -2.5 },
      { metric: 'huawei.battery.daily_charge_kwh', value: 4.812 },
      { metric: 'huawei.battery.daily_discharge_kwh', value: 3.107 },
      { metric: 'huawei.battery.rated_capacity_kwh', value: 15 },
    ],
  );
  assert.deepEqual(result.skipped, ['battery_status', 'battery_unit_info']);
  assert.equal(REGISTRY['39'].ch_discharge_power.sourceUnit, 'W');
  assert.equal(REGISTRY['39'].ch_discharge_power.destinationUnit, 'kW');
  assert.equal(REGISTRY['39'].battery_soc.sourceUnit, '%');
});

test('maps documented C&I/utility ESS (type 41) fields and converts watts', () => {
  const result = normalizeKpis({
    source: 'HUAWEI:NE=12345678:device:2000000048834053',
    deviceType: '41',
    timestamp: 1785924000000,
    payload: {
      battery_soc: 42,
      ch_discharge_power: '18000',
      charge_cap: '120.5',
      discharge_cap: 98.25,
      run_state: 1,
    },
  });

  assert.deepEqual(
    result.measurements.map(({ metric, value }) => ({ metric, value })),
    [
      { metric: 'huawei.ess.state_of_charge_percent', value: 42 },
      { metric: 'huawei.ess.charge_discharge_power_kw', value: 18 },
      { metric: 'huawei.ess.daily_charge_kwh', value: 120.5 },
      { metric: 'huawei.ess.daily_discharge_kwh', value: 98.25 },
    ],
  );
  assert.deepEqual(result.skipped, ['run_state']);
  assert.equal(REGISTRY['41'].ch_discharge_power.sourceUnit, 'W');
  assert.equal(REGISTRY['41'].ch_discharge_power.destinationUnit, 'kW');
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
