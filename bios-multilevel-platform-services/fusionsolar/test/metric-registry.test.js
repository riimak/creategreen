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

test('derives per-MPPT DC power for a SUN2000-50KTL-M3 from its paired PV inputs', () => {
  // Shape and values of a real record for SC Soko 46 kWp (history, 2026-11-25
  // 11:00Z): inputs sharing an MPPT report one voltage; PV7/PV8 are unused.
  const payload = {
    active_power: 5.268,
    day_cap: 20.1,
    total_cap: 23538.91,
    mppt_power: 5.429,
    pv1_u: 671.5, pv1_i: 1.86, pv2_u: 671.5, pv2_i: 1.5,
    pv3_u: 669.3, pv3_i: 1.88, pv4_u: 669.3, pv4_i: 1.48,
    pv5_u: 669.8, pv5_i: 1.67, pv6_u: 669.8, pv6_i: 0,
    pv7_u: 0, pv7_i: 0, pv8_u: 0, pv8_i: 0,
    pv9_u: 0, pv9_i: 0,
    pv27_u: null, pv27_i: null,
    mppt_1_cap: 10244.68, mppt_2_cap: 10175.96, mppt_3_cap: 4746.7, mppt_4_cap: 0,
    temperature: 21.3,
  };
  const result = normalizeKpis({
    source: 'HUAWEI:NE=201410062:device:1000000201410162',
    deviceType: '1',
    timestamp: 1795690800000,
    payload,
    model: 'SUN2000-50KTL-M3',
  });
  const byMetric = Object.fromEntries(result.measurements.map((m) => [m.metric, m.value]));
  const kw = (...pairs) => pairs.reduce((sum, [u, i]) => sum + u * i, 0) / 1000;
  assert.equal(byMetric['huawei.string_inverter.mppt1_power_kw'], kw([671.5, 1.86], [671.5, 1.5]));
  assert.equal(byMetric['huawei.string_inverter.mppt2_power_kw'], kw([669.3, 1.88], [669.3, 1.48]));
  assert.equal(byMetric['huawei.string_inverter.mppt3_power_kw'], kw([669.8, 1.67]));
  assert.equal(byMetric['huawei.string_inverter.mppt4_power_kw'], 0, 'an unused MPPT reports 0, not nothing');
  assert.equal(byMetric['huawei.string_inverter.dc_power_kw'], 5.429, 'mppt_power is the inverter DC total');
  assert.equal(byMetric['huawei.string_inverter.active_power_kw'], 5.268);
  assert.equal(Object.keys(byMetric).length, 8, 'no mppt5+ for a 4-MPPT model');
  assert.ok(result.measurements.every((m) => m.ts === '2026-11-26T11:00:00.000Z' && m.isMissing === false));
  // The PV inputs the derivation consumed are not "skipped"; everything else unmapped still is.
  assert.deepEqual(result.skipped, [
    'pv9_u', 'pv9_i', 'pv27_u', 'pv27_i',
    'mppt_1_cap', 'mppt_2_cap', 'mppt_3_cap', 'mppt_4_cap', 'temperature',
  ]);
  assert.equal(REGISTRY['1'].mppt_power.sourceUnit, 'kW');
  assert.equal(REGISTRY['1'].mppt_power.endpoint, '/thirdData/getDevRealKpi');
});

test('does not guess an MPPT layout for unknown or absent inverter models', () => {
  const payload = { active_power: 1, pv1_u: 600, pv1_i: 1, pv2_u: 600, pv2_i: 1 };
  for (const model of [undefined, null, '', 'SUN2000-100KTL-M1']) {
    const result = normalizeKpis({
      source: 'HUAWEI:NE=1:device:X',
      deviceType: 1,
      timestamp: 1795690800000,
      payload,
      model,
    });
    assert.deepEqual(result.measurements.map((m) => m.metric), ['huawei.string_inverter.active_power_kw']);
    assert.deepEqual(result.skipped, ['pv1_u', 'pv1_i', 'pv2_u', 'pv2_i']);
  }
  // Only string inverters (type 1) carry PV inputs; a meter payload with pv fields is left alone.
  const meter = normalizeKpis({
    source: 'HUAWEI:NE=1:device:M',
    deviceType: 47,
    timestamp: 1795690800000,
    payload: { active_power: 1200, pv1_u: 600, pv1_i: 1 },
    model: 'SUN2000-50KTL-M3',
  });
  assert.deepEqual(meter.measurements.map((m) => m.metric), ['huawei.power_sensor.active_power_kw']);
  // An MPPT whose inputs carry no numeric voltage/current yields nothing rather than 0.
  const partial = normalizeKpis({
    source: 'HUAWEI:NE=1:device:X',
    deviceType: '1',
    timestamp: 1795690800000,
    payload: { pv1_u: 600, pv1_i: 2, pv2_u: 600, pv2_i: 2, pv3_u: null, pv3_i: null, pv4_u: 'n/a', pv4_i: 1 },
    model: 'sun2000-50ktl-m3',
  });
  assert.deepEqual(partial.measurements.map((m) => [m.metric, m.value]), [
    ['huawei.string_inverter.mppt1_power_kw', 2.4],
  ]);
  assert.deepEqual(partial.skipped, ['pv3_u', 'pv3_i', 'pv4_u', 'pv4_i']);
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
