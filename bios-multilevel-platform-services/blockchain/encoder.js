const crypto = require('crypto');

const EVENT_CODES = {
  ok: 0x01,
  alarm: 0x02,
  export: 0x03,
  config: 0x04,
  critical_measurement: 0x05,
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

module.exports = {
  EVENT_CODES,
  crc32,
  encodeEventV1,
  decodeEventV1,
};
