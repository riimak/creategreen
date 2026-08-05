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

function sourceKey(plantCode) {
  const normalized = requiredText(plantCode, 'plantCode');
  return `HUAWEI:${normalized}`;
}

function normalizePlant(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('plant payload is required');
  const plantCode = requiredText(raw.plantCode, 'plantCode');
  const metadata = {};
  if (raw.capacity != null) {
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
} = {}) {
  const normalizedSource = requiredText(source, 'source');
  const ts = timestampIso(timestamp);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('KPI payload is required');
  }

  const mappings = REGISTRY[String(deviceType)] || {};
  const measurements = [];
  const skipped = [];
  for (const [field, rawValue] of Object.entries(payload)) {
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
  normalizePlant,
  normalizeDevice,
  normalizeKpis,
  sourceKey,
};
