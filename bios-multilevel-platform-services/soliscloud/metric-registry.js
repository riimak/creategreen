// Field mappings for the three SolisCloud payload shapes we ingest:
//  - station records from /v1/api/userStationList (plant-level live data),
//  - inverter records from /v1/api/inverterList (device-level live data),
//  - intraday points from /v1/api/inverterDay (device-level backfill).
// Values are normalized to kW / kWh using the vendor's unit-string fields;
// counters named daily_* are running totals for the local day (they reset at
// midnight), matching the SolaX convention rather than Huawei period totals.

const POWER_UNITS = { W: 0.001, kW: 1, MW: 1000, GW: 1_000_000 };
const ENERGY_UNITS = { Wh: 0.001, kWh: 1, MWh: 1000, GWh: 1_000_000 };

const STATION_FIELDS = [
  { field: 'power', unitField: 'powerStr', units: POWER_UNITS, metric: 'solis.plant.current_power_kw' },
  { field: 'dayEnergy', unitField: 'dayEnergyStr', units: ENERGY_UNITS, metric: 'solis.plant.daily_yield_kwh' },
  { field: 'monthEnergy', unitField: 'monthEnergyStr', units: ENERGY_UNITS, metric: 'solis.plant.monthly_yield_kwh' },
  { field: 'allEnergy', unitField: 'allEnergyStr', units: ENERGY_UNITS, metric: 'solis.plant.total_yield_kwh' },
  { field: 'gridPurchasedTodayEnergy', units: ENERGY_UNITS, metric: 'solis.plant.daily_grid_purchased_kwh' },
  { field: 'gridSellTodayEnergy', units: ENERGY_UNITS, metric: 'solis.plant.daily_grid_sell_kwh' },
  { field: 'gridPurchasedTotalEnergy', units: ENERGY_UNITS, metric: 'solis.plant.total_grid_purchased_kwh' },
  { field: 'gridSellTotalEnergy', units: ENERGY_UNITS, metric: 'solis.plant.total_grid_sell_kwh' },
  { field: 'homeLoadTodayEnergy', units: ENERGY_UNITS, metric: 'solis.plant.daily_consumption_kwh' },
  { field: 'batteryTodayChargeEnergy', units: ENERGY_UNITS, metric: 'solis.plant.daily_battery_charge_kwh' },
  { field: 'batteryTodayDischargeEnergy', units: ENERGY_UNITS, metric: 'solis.plant.daily_battery_discharge_kwh' },
];

const INVERTER_FIELDS = [
  { field: 'pac', unitField: 'pacStr', units: POWER_UNITS, metric: 'solis.inverter.active_power_kw' },
  { field: 'etoday', unitField: 'etodayStr', units: ENERGY_UNITS, metric: 'solis.inverter.daily_yield_kwh' },
  { field: 'etotal', unitField: 'etotalStr', units: ENERGY_UNITS, metric: 'solis.inverter.total_yield_kwh' },
];

// VERIFIED AGAINST THE LIVE API (2026-08-31): /v1/api/inverterDay power
// fields are reported in WATTS even though pacStr claims "kW" (a 5 kW
// inverter shows pac=2190 at peak; a 50 kW one shows pac=9200 while
// inverterList reports the same devices correctly in kW). The unit strings
// on this endpoint are unreliable, so power uses a fixed W->kW scale.
const INVERTER_DAY_FIELDS = [
  { field: 'pac', scale: 0.001, metric: 'solis.inverter.active_power_kw' },
  { field: 'eToday', units: ENERGY_UNITS, metric: 'solis.inverter.daily_yield_kwh' },
  { field: 'eTotal', units: ENERGY_UNITS, metric: 'solis.inverter.total_yield_kwh' },
  { field: 'batteryCapacitySoc', units: null, metric: 'solis.inverter.battery_soc_percent' },
  { field: 'batteryPower', scale: 0.001, metric: 'solis.inverter.battery_power_kw' },
  { field: 'gridPurchasedTodayEnergy', units: ENERGY_UNITS, metric: 'solis.inverter.daily_grid_purchased_kwh' },
  { field: 'gridSellTodayEnergy', units: ENERGY_UNITS, metric: 'solis.inverter.daily_grid_sell_kwh' },
  { field: 'inverterTemperature', units: null, metric: 'solis.inverter.temperature_c' },
];

function sourceKey(stationId) {
  return `SOLIS:${requiredIdentifier(stationId, 'stationId')}`;
}

function deviceSourceKey(stationId, deviceSn) {
  return `${sourceKey(stationId)}:device:${requiredIdentifier(deviceSn, 'deviceSn')}`;
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unitMultiplier(record, mapping) {
  if (!mapping.units) return 1;
  const unit = mapping.unitField ? record[mapping.unitField] : null;
  if (unit == null || unit === '') {
    // Vendor omits the unit on some fields; canonical units (kW/kWh) apply.
    return 1;
  }
  return typeof unit === 'string' ? mapping.units[unit.trim()] ?? null : null;
}

function mapFields(record, mappings, source, ts) {
  const measurements = [];
  const skipped = [];
  for (const mapping of mappings) {
    if (!(mapping.field in record)) continue;
    const value = finiteNumber(record[mapping.field]);
    const multiplier = mapping.scale ?? unitMultiplier(record, mapping);
    if (value == null || multiplier == null) {
      skipped.push(mapping.field);
      continue;
    }
    measurements.push({
      source,
      metric: mapping.metric,
      ts,
      value: value * multiplier,
      isMissing: false,
    });
  }
  return { measurements, skipped };
}

function recordTimestamp(record) {
  const parsed = finiteNumber(record?.dataTimestamp);
  if (parsed == null || parsed <= 0) return null;
  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeStation(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('station payload is required');
  const stationId = requiredIdentifier(raw.id, 'station id');
  const metadata = {};
  if (finiteNumber(raw.capacity) != null) {
    metadata.capacity = finiteNumber(raw.capacity);
    metadata.capacityUnit = typeof raw.capacityStr === 'string' ? raw.capacityStr : 'kWp';
  }
  for (const field of ['fisPowerTime', 'fisGenerateTime', 'createDate']) {
    if (finiteNumber(raw[field]) != null) metadata[field] = finiteNumber(raw[field]);
  }
  if (typeof raw.installer === 'string' && raw.installer.trim()) metadata.installer = raw.installer.trim();
  return {
    stationId,
    sourceKey: sourceKey(stationId),
    displayName: optionalText(raw.stationName),
    timezone: finiteNumber(raw.timeZone),
    visible: true,
    metadata,
  };
}

function normalizeInverter(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('inverter payload is required');
  const deviceSn = requiredIdentifier(raw.sn, 'inverter sn');
  const stationId = requiredIdentifier(raw.stationId, 'inverter stationId');
  const metadata = {};
  if (finiteNumber(raw.power) != null) {
    metadata.ratedPower = finiteNumber(raw.power);
    metadata.ratedPowerUnit = typeof raw.powerStr === 'string' ? raw.powerStr : 'kW';
  }
  if (typeof raw.name === 'string' && raw.name.trim()) metadata.name = raw.name.trim();
  if (typeof raw.series === 'string' && raw.series.trim()) metadata.series = raw.series.trim();
  return {
    deviceSn,
    stationId,
    inverterId: optionalText(String(raw.id ?? '')),
    model: optionalText(raw.productModel) || optionalText(raw.model),
    visible: true,
    metadata,
  };
}

function stationMeasurements(raw, station) {
  const ts = recordTimestamp(raw);
  if (!ts) return { measurements: [], skipped: ['dataTimestamp'] };
  return mapFields(raw, STATION_FIELDS, station.sourceKey, ts);
}

function inverterMeasurements(raw, device) {
  const ts = recordTimestamp(raw);
  if (!ts) return { measurements: [], skipped: ['dataTimestamp'] };
  return mapFields(raw, INVERTER_FIELDS, deviceSourceKey(device.stationId, device.deviceSn), ts);
}

function inverterDayMeasurements(point, device) {
  const ts = recordTimestamp(point);
  if (!ts) return { measurements: [], skipped: ['dataTimestamp'] };
  return mapFields(point, INVERTER_DAY_FIELDS, deviceSourceKey(device.stationId, device.deviceSn), ts);
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
  STATION_FIELDS,
  INVERTER_FIELDS,
  INVERTER_DAY_FIELDS,
  sourceKey,
  deviceSourceKey,
  normalizeStation,
  normalizeInverter,
  stationMeasurements,
  inverterMeasurements,
  inverterDayMeasurements,
};
