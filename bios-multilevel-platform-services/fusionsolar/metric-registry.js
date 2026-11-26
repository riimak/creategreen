const PLANT_REALTIME_PATH = '/thirdData/getStationRealKpi';
const DEVICE_REALTIME_PATH = '/thirdData/getDevRealKpi';

function identity(value) {
  return value;
}

function wattsToKilowatts(value) {
  return value / 1000;
}

function entry({
  endpoint,
  field,
  deviceType,
  metric,
  sourceUnit,
  destinationUnit = sourceUnit,
  convert = identity,
}) {
  return Object.freeze({
    endpoint,
    field,
    deviceType,
    metric,
    sourceUnit,
    destinationUnit,
    convert,
    verified: true,
  });
}

function plantEntry(field, metric, unit = 'kWh') {
  return entry({
    endpoint: PLANT_REALTIME_PATH,
    field,
    deviceType: 'plant',
    metric,
    sourceUnit: unit,
  });
}

function inverterEntry(deviceType, field, metric, unit) {
  return entry({
    endpoint: DEVICE_REALTIME_PATH,
    field,
    deviceType,
    metric,
    sourceUnit: unit,
  });
}

function meterEntry(deviceType, field, metric, sourceUnit, destinationUnit, convert) {
  return entry({
    endpoint: DEVICE_REALTIME_PATH,
    field,
    deviceType,
    metric,
    sourceUnit,
    destinationUnit,
    convert,
  });
}

const REGISTRY = Object.freeze({
  plant: Object.freeze({
    day_power: plantEntry('day_power', 'huawei.plant.daily_yield_kwh'),
    month_power: plantEntry('month_power', 'huawei.plant.monthly_yield_kwh'),
    total_power: plantEntry('total_power', 'huawei.plant.total_yield_kwh'),
    daily_on_grid_energy: plantEntry(
      'daily_on_grid_energy',
      'huawei.plant.daily_on_grid_energy_kwh',
    ),
    daily_use_energy: plantEntry(
      'daily_use_energy',
      'huawei.plant.daily_consumption_kwh',
    ),
    day_on_grid_energy: plantEntry(
      'day_on_grid_energy',
      'huawei.plant.daily_on_grid_energy_kwh',
    ),
    day_use_energy: plantEntry(
      'day_use_energy',
      'huawei.plant.daily_consumption_kwh',
    ),
  }),
  '1': Object.freeze({
    active_power: inverterEntry(
      '1',
      'active_power',
      'huawei.string_inverter.active_power_kw',
      'kW',
    ),
    day_cap: inverterEntry(
      '1',
      'day_cap',
      'huawei.string_inverter.daily_yield_kwh',
      'kWh',
    ),
    total_cap: inverterEntry(
      '1',
      'total_cap',
      'huawei.string_inverter.total_yield_kwh',
      'kWh',
    ),
    // Total DC input power of the inverter (all MPPTs), kW.
    mppt_power: inverterEntry(
      '1',
      'mppt_power',
      'huawei.string_inverter.dc_power_kw',
      'kW',
    ),
  }),
  '38': Object.freeze({
    active_power: inverterEntry(
      '38',
      'active_power',
      'huawei.residential_inverter.active_power_kw',
      'kW',
    ),
    day_cap: inverterEntry(
      '38',
      'day_cap',
      'huawei.residential_inverter.daily_yield_kwh',
      'kWh',
    ),
    total_cap: inverterEntry(
      '38',
      'total_cap',
      'huawei.residential_inverter.total_yield_kwh',
      'kWh',
    ),
  }),
  '17': Object.freeze({
    active_power: meterEntry(
      '17',
      'active_power',
      'huawei.grid_meter.active_power_kw',
      'W',
      'kW',
      wattsToKilowatts,
    ),
    active_cap: meterEntry(
      '17',
      'active_cap',
      'huawei.grid_meter.positive_active_energy_kwh',
      'kWh',
      'kWh',
    ),
    reverse_active_cap: meterEntry(
      '17',
      'reverse_active_cap',
      'huawei.grid_meter.negative_active_energy_kwh',
      'kWh',
      'kWh',
    ),
  }),
  // Residential battery. Real-time KPI fields per SmartPVMS 26.1.0 NBI
  // reference (getDevRealKpi, devTypeId 39): SOC in %, power in W,
  // charge_cap/discharge_cap are period totals for the current day.
  '39': Object.freeze({
    battery_soc: inverterEntry(
      '39',
      'battery_soc',
      'huawei.battery.state_of_charge_percent',
      '%',
    ),
    ch_discharge_power: meterEntry(
      '39',
      'ch_discharge_power',
      'huawei.battery.charge_discharge_power_kw',
      'W',
      'kW',
      wattsToKilowatts,
    ),
    charge_cap: inverterEntry(
      '39',
      'charge_cap',
      'huawei.battery.daily_charge_kwh',
      'kWh',
    ),
    discharge_cap: inverterEntry(
      '39',
      'discharge_cap',
      'huawei.battery.daily_discharge_kwh',
      'kWh',
    ),
    rated_capacity: inverterEntry(
      '39',
      'rated_capacity',
      'huawei.battery.rated_capacity_kwh',
      'kWh',
    ),
  }),
  // C&I and utility ESS (getDevRealKpi, devTypeId 41).
  '41': Object.freeze({
    battery_soc: inverterEntry(
      '41',
      'battery_soc',
      'huawei.ess.state_of_charge_percent',
      '%',
    ),
    ch_discharge_power: meterEntry(
      '41',
      'ch_discharge_power',
      'huawei.ess.charge_discharge_power_kw',
      'W',
      'kW',
      wattsToKilowatts,
    ),
    charge_cap: inverterEntry(
      '41',
      'charge_cap',
      'huawei.ess.daily_charge_kwh',
      'kWh',
    ),
    discharge_cap: inverterEntry(
      '41',
      'discharge_cap',
      'huawei.ess.daily_discharge_kwh',
      'kWh',
    ),
  }),
  '47': Object.freeze({
    active_power: meterEntry(
      '47',
      'active_power',
      'huawei.power_sensor.active_power_kw',
      'W',
      'kW',
      wattsToKilowatts,
    ),
    active_cap: meterEntry(
      '47',
      'active_cap',
      'huawei.power_sensor.positive_active_energy_kwh',
      'kWh',
      'kWh',
    ),
    reverse_active_cap: meterEntry(
      '47',
      'reverse_active_cap',
      'huawei.power_sensor.negative_active_energy_kwh',
      'kWh',
      'kWh',
    ),
  }),
});

// Per-MPPT DC power (huawei.string_inverter.mppt<N>_power_kw), derived.
//
// The string-inverter KPIs (getDevRealKpi and the history endpoint, devTypeId 1)
// carry no per-MPPT power: only the total `mppt_power`, the cumulative energy
// per MPPT (`mppt_N_cap`) and voltage/current per PV input (`pvN_u`, `pvN_i`).
// Inputs wired to the same MPPT are paralleled and report one voltage, so the
// power of an MPPT is the sum of u*i over its inputs. Which inputs share an
// MPPT is fixed by the inverter model:
//
//   SUN2000-50KTL-M3: 4 MPPTs, 2 inputs each (PV1+PV2 -> MPPT1 ... PV7+PV8 -> MPPT4).
//   Verified 2026-11-26 on SC Soko 46 kWp (NE=201410162): PV1/PV2, PV3/PV4 and
//   PV5/PV6 report identical voltages, sum(u*i) follows `mppt_power` within 3 %,
//   and the per-pair power equals the 5-minute deltas of `mppt_1..3_cap`.
//
// Models not listed here get no derived MPPT metrics (their PV fields stay in
// `skipped`), rather than a guessed grouping.
const STRING_INVERTER_LAYOUTS = Object.freeze({
  'SUN2000-50KTL-M3': Object.freeze({ mppts: 4, inputsPerMppt: 2 }),
});

function stringInverterLayout(model) {
  const key = typeof model === 'string' ? model.trim().toUpperCase() : '';
  return STRING_INVERTER_LAYOUTS[key] || null;
}

function mpptPowerMetric(mppt) {
  return `huawei.string_inverter.mppt${mppt}_power_kw`;
}

/**
 * Per-MPPT power from the PV input voltages and currents of one string
 * inverter record. Returns the measurements and the payload fields they used,
 * so callers can leave those out of the "skipped" diagnostics. An MPPT whose
 * inputs all lack a numeric u or i yields nothing (not 0).
 */
function deriveStringInverterMppt({ source, deviceType, ts, payload, model }) {
  const measurements = [];
  const consumed = [];
  if (String(deviceType) !== '1') return { measurements, consumed };
  const layout = stringInverterLayout(model);
  if (!layout) return { measurements, consumed };
  for (let mppt = 1; mppt <= layout.mppts; mppt += 1) {
    let watts = 0;
    let inputs = 0;
    for (let k = 0; k < layout.inputsPerMppt; k += 1) {
      const n = (mppt - 1) * layout.inputsPerMppt + k + 1;
      const u = finiteNumber(payload[`pv${n}_u`]);
      const i = finiteNumber(payload[`pv${n}_i`]);
      if (u == null || i == null) continue;
      consumed.push(`pv${n}_u`, `pv${n}_i`);
      watts += u * i;
      inputs += 1;
    }
    if (inputs === 0) continue;
    measurements.push({
      source,
      metric: mpptPowerMetric(mppt),
      ts,
      value: watts / 1000,
      isMissing: false,
    });
  }
  return { measurements, consumed };
}

function sourceKey(plantCode) {
  const normalized = requiredText(plantCode, 'plantCode');
  return `HUAWEI:${normalized}`;
}

function normalizePlant(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('plant payload is required');
  const plantCode = requiredText(raw.plantCode, 'plantCode');
  const metadata = {};
  if (raw.capacity != null) {
    if (typeof raw.capacity !== 'number' || !Number.isFinite(raw.capacity)) {
      throw new Error('plant capacity must be a finite number');
    }
    metadata.capacity = raw.capacity;
    metadata.capacityUnit = 'kWp';
  }
  if (raw.gridConnectionDate != null) {
    metadata.gridConnectionDate = raw.gridConnectionDate;
  }

  return {
    plantCode,
    sourceKey: sourceKey(plantCode),
    displayName: optionalText(raw.plantName),
    timezone: null,
    visible: true,
    metadata,
  };
}

function normalizeDevice(raw, plantCode) {
  if (!raw || typeof raw !== 'object') throw new Error('device payload is required');
  const deviceId = requiredIdentifier(raw.id, 'device id');
  const normalizedPlantCode = requiredText(plantCode, 'plantCode');
  const responsePlantCode = optionalText(raw.stationCode);
  if (responsePlantCode && responsePlantCode !== normalizedPlantCode) {
    throw new Error('device plantCode does not match its inventory request');
  }

  const metadata = {};
  if (raw.devDn != null) metadata.devDn = raw.devDn;
  if (raw.devName != null) metadata.devName = raw.devName;
  if (raw.softwareVersion != null) metadata.softwareVersion = raw.softwareVersion;
  if (raw.invType != null) metadata.invType = raw.invType;

  return {
    deviceId,
    plantCode: normalizedPlantCode,
    deviceType: requiredIdentifier(raw.devTypeId, 'device type'),
    model: optionalText(raw.model),
    serialNumber: optionalText(raw.esnCode),
    metadata,
  };
}

function normalizeKpis({
  source,
  deviceType,
  timestamp,
  payload,
  model = null,
} = {}) {
  const normalizedSource = requiredText(source, 'source');
  const ts = timestampIso(timestamp);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('KPI payload is required');
  }

  const mappings = REGISTRY[String(deviceType)] || {};
  const derived = deriveStringInverterMppt({
    source: normalizedSource,
    deviceType,
    ts,
    payload,
    model,
  });
  const consumed = new Set(derived.consumed);
  const measurements = [...derived.measurements];
  const skipped = [];
  for (const [field, rawValue] of Object.entries(payload)) {
    if (shadowedPlantAlias(deviceType, field, payload)) continue;
    if (consumed.has(field)) continue;
    const mapping = mappings[field];
    const numericValue = finiteNumber(rawValue);
    if (!mapping || numericValue == null) {
      skipped.push(field);
      continue;
    }
    const converted = mapping.convert(numericValue);
    if (!Number.isFinite(converted)) {
      skipped.push(field);
      continue;
    }
    measurements.push({
      source: normalizedSource,
      metric: mapping.metric,
      ts,
      value: converted,
      isMissing: false,
    });
  }
  return { measurements, skipped };
}

function shadowedPlantAlias(deviceType, field, payload) {
  if (String(deviceType) !== 'plant') return false;
  const preferred = {
    day_on_grid_energy: 'daily_on_grid_energy',
    day_use_energy: 'daily_use_energy',
  }[field];
  return preferred
    ? Object.prototype.hasOwnProperty.call(payload, preferred)
    : false;
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampIso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('timestamp must be milliseconds since the epoch');
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error('timestamp is invalid');
  return timestamp.toISOString();
}

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function requiredIdentifier(value, name) {
  if (
    (typeof value !== 'string' && typeof value !== 'number')
    || String(value).trim() === ''
    || (typeof value === 'number' && !Number.isFinite(value))
  ) {
    throw new Error(`${name} is required`);
  }
  return String(value).trim();
}

function optionalText(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

module.exports = {
  REGISTRY,
  STRING_INVERTER_LAYOUTS,
  mpptPowerMetric,
  normalizePlant,
  normalizeDevice,
  normalizeKpis,
  sourceKey,
};
