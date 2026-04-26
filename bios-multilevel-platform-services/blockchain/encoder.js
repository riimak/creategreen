const crypto = require('crypto');

const EVENT_CODES = {
  ok: 0x01,
  alarm: 0x02,
  export: 0x03,
  config: 0x04,
  critical_measurement: 0x05,
  data_batch_seen: 0x11,
  data_quality_changed: 0x12,
  prediction_generated: 0x13,
  anomaly_detected: 0x14,
  sla_breached: 0x15,
  sla_recovered: 0x16,
  export_file_refreshed: 0x17,
};

const SOURCE_CODES = { OS1BIOS: 0x0a01, OS2BIOS: 0x0a02, SOLAXBIOS: 0x0b01 };
const METRIC_CODES = {
  PM2_5: 0x01,
  PM10: 0x02,
  Temperatura: 0x03,
  Relativna_vlaznost: 0x04,
  Suncevo_zracenje: 0x05,
  CAQI: 0x06,
  Inverter_AC_power_total: 0x21,
  Grid_power_total: 0x22,
  Inverter_AC_energy_out_daily: 0x23,
};
const STATUS_CODES = {
  ok: 0x01,
  partial: 0x02,
  stale: 0x03,
  insufficient_data: 0x04,
  within_sla: 0x05,
  at_risk: 0x06,
  breached: 0x07,
  recovered: 0x08,
  generated: 0x09,
  detected: 0x0a,
};

function parseDeviceId(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '').replace(/^0x/i, '');
  const parsed = Number.parseInt(text, 16);
  if (!Number.isFinite(parsed)) throw new Error('invalid device_id');
  return parsed;
}

function eventCode(value) {
  if (typeof value === 'number') return value;
  return EVENT_CODES[String(value || '').toLowerCase()] || 0xff;
}

function sourceCode(value) {
  if (typeof value === 'number') return value;
  return SOURCE_CODES[String(value || '').toUpperCase()] || parseDeviceId(value);
}

function metricCode(value) {
  if (typeof value === 'number') return value;
  return METRIC_CODES[String(value || '')] || 0xff;
}

function statusCode(value) {
  if (typeof value === 'number') return value;
  return STATUS_CODES[String(value || '').toLowerCase()] || 0xff;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function canonicalEvent(event) {
  return JSON.stringify(event, Object.keys(event).sort());
}

function encodeEventV1(event) {
  const deviceId = parseDeviceId(event.device_id || event.deviceId || event.source);
  const timestamp = Number(event.timestamp || Math.floor(Date.now() / 1000));
  const code = eventCode(event.event_code || event.eventType || event.type);
  const value = Number(event.value || 0);
  const scaledValue = Math.max(0, Math.min(0xffff, Math.round(value)));

  if (deviceId < 0 || deviceId > 0xffff) throw new Error('device_id must fit in 2 bytes');
  if (timestamp < 0 || timestamp > 0xffffffff) throw new Error('timestamp must fit in 4 bytes');
  if (code < 0 || code > 0xff) throw new Error('event_code must fit in 1 byte');

  const canonical = Buffer.from(canonicalEvent(event));
  const crc = crc32(canonical);
  const buffer = Buffer.alloc(13);
  buffer.writeUInt16BE(deviceId, 0);
  buffer.writeUInt32BE(timestamp, 2);
  buffer.writeUInt8(code, 6);
  buffer.writeUInt16BE(scaledValue, 7);
  buffer.writeUInt32BE(crc, 9);

  return {
    schema: 'stealth-event-v1',
    deviceId,
    timestamp,
    eventCode: code,
    value: scaledValue,
    crc,
    hex: buffer.toString('hex').toUpperCase(),
    payloadHash: crypto.createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
  };
}

function decodeEventV1(hex) {
  const buffer = Buffer.from(String(hex).replace(/^0x/i, ''), 'hex');
  if (buffer.length !== 13) throw new Error('stealth-event-v1 payload must be 13 bytes');
  return {
    schema: 'stealth-event-v1',
    deviceId: buffer.readUInt16BE(0),
    timestamp: buffer.readUInt32BE(2),
    eventCode: buffer.readUInt8(6),
    value: buffer.readUInt16BE(7),
    crc: buffer.readUInt32BE(9),
    hex: buffer.toString('hex').toUpperCase(),
  };
}

function encodeEventV2(event) {
  const source = sourceCode(event.source || event.station || event.device_id || event.deviceId);
  const timestamp = Number(event.timestamp || Math.floor(Date.now() / 1000));
  const code = eventCode(event.event_code || event.eventType || event.type);
  const metric = metricCode(event.metric);
  const status = statusCode(event.status || event.qualityStatus || event.slaStatus);
  const value = Number(event.value || 0);
  const scaledValue = Math.max(0, Math.min(0xffff, Math.round(value)));

  if (source < 0 || source > 0xffff) throw new Error('source_id must fit in 2 bytes');
  if (timestamp < 0 || timestamp > 0xffffffff) throw new Error('timestamp must fit in 4 bytes');
  if (code < 0 || code > 0xff) throw new Error('event_code must fit in 1 byte');
  if (metric < 0 || metric > 0xff) throw new Error('metric_code must fit in 1 byte');
  if (status < 0 || status > 0xff) throw new Error('status_code must fit in 1 byte');

  const canonical = Buffer.from(canonicalEvent(event));
  const crc = crc32(canonical);
  const buffer = Buffer.alloc(16);
  buffer.writeUInt8(2, 0);
  buffer.writeUInt16BE(source, 1);
  buffer.writeUInt32BE(timestamp, 3);
  buffer.writeUInt8(code, 7);
  buffer.writeUInt8(metric, 8);
  buffer.writeUInt8(status, 9);
  buffer.writeUInt16BE(scaledValue, 10);
  buffer.writeUInt32BE(crc, 12);

  return {
    schema: 'stealth-event-v2',
    version: 2,
    sourceId: source,
    timestamp,
    eventCode: code,
    metricCode: metric,
    statusCode: status,
    value: scaledValue,
    crc,
    hex: buffer.toString('hex').toUpperCase(),
    payloadHash: crypto.createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
  };
}

function decodeEventV2(hex) {
  const buffer = Buffer.from(String(hex).replace(/^0x/i, ''), 'hex');
  if (buffer.length !== 16) throw new Error('stealth-event-v2 payload must be 16 bytes');
  return {
    schema: 'stealth-event-v2',
    version: buffer.readUInt8(0),
    sourceId: buffer.readUInt16BE(1),
    timestamp: buffer.readUInt32BE(3),
    eventCode: buffer.readUInt8(7),
    metricCode: buffer.readUInt8(8),
    statusCode: buffer.readUInt8(9),
    value: buffer.readUInt16BE(10),
    crc: buffer.readUInt32BE(12),
    hex: buffer.toString('hex').toUpperCase(),
  };
}

function encodeEvent(event) {
  return String(process.env.BLOCKCHAIN_EVENT_SCHEMA || event.schema || 'v2').toLowerCase().includes('v1')
    ? encodeEventV1(event)
    : encodeEventV2(event);
}

function decodeEvent(hex) {
  const clean = String(hex).replace(/^0x/i, '');
  if (clean.length === 26) return decodeEventV1(clean);
  return decodeEventV2(clean);
}

module.exports = {
  EVENT_CODES,
  SOURCE_CODES,
  METRIC_CODES,
  STATUS_CODES,
  crc32,
  encodeEvent,
  decodeEvent,
  encodeEventV1,
  decodeEventV1,
  encodeEventV2,
  decodeEventV2,
};
