const METRICS = {
  PM2_5: {
    label: 'Fine particles PM2.5',
    unit: 'ug/m3',
    domain: 'air quality',
    description: 'Concentration of fine suspended particles measured by BIOS meteo stations.',
  },
  PM10: {
    label: 'Suspended particles PM10',
    unit: 'ug/m3',
    domain: 'air quality',
    description: 'Concentration of larger suspended particles measured by BIOS meteo stations.',
  },
  Temperatura: {
    label: 'Air temperature',
    unit: 'C',
    domain: 'meteo',
    description: 'Outdoor air temperature from BIOS meteo stations.',
  },
  Relativna_vlaznost: {
    label: 'Relative humidity',
    unit: '%',
    domain: 'meteo',
    description: 'Outdoor relative humidity from BIOS meteo stations.',
  },
  Suncevo_zracenje: {
    label: 'Solar radiation',
    unit: 'W/m2',
    domain: 'meteo',
    description: 'Solar radiation from BIOS meteo stations, useful for production context.',
  },
  CAQI: {
    label: 'Air quality index',
    unit: 'index',
    domain: 'air quality',
    description: 'Common air quality index from BIOS meteo station measurements.',
  },
  Inverter_AC_power_total: {
    label: 'Inverter AC power',
    unit: 'kW',
    domain: 'electricity production',
    description: 'Total AC output power from the SOLAX inverter.',
  },
  Grid_power_total: {
    label: 'Grid power',
    unit: 'kW',
    domain: 'electricity exchange',
    description: 'Current power exchange with the electrical grid.',
  },
  Inverter_AC_energy_out_daily: {
    label: 'Daily inverter energy',
    unit: 'kWh',
    domain: 'electricity production',
    description: 'Daily produced inverter energy.',
  },
};

function metricInfo(metric) {
  return METRICS[metric] || {
    label: metric,
    unit: '',
    domain: 'measurement',
    description: 'BIOS measurement used by the prediction service.',
  };
}

function targetInfo(source, metric) {
  return {
    source,
    metric,
    ...metricInfo(metric),
  };
}

module.exports = { METRICS, metricInfo, targetInfo };
