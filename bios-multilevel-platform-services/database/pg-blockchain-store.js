const { Pool } = require('pg');

function createPgBlockchainStore(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  async function init() {
    const fs = require('fs');
    const path = require('path');
    const schema = fs.readFileSync(path.resolve(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
  }

  async function put(record) {
    await pool.query(
      `INSERT INTO blockchain_events (
        id, event_code, event_name, source_id, metric_code, status_code,
        value, timestamp_val, payload_hex, payload_hash,
        status, tx_id, block_hash, confirmations,
        relay_mode, relay_status, relay_reason,
        source_kind, source_ref, dedupe_key,
        retry_counter, last_error,
        submitted_at, confirmed_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
      ON CONFLICT (id) DO UPDATE SET
        status=$11, tx_id=$12, block_hash=$13, confirmations=$14,
        relay_mode=$15, relay_status=$16, relay_reason=$17,
        retry_counter=$21, last_error=$22,
        submitted_at=$23, confirmed_at=$24, updated_at=$26`,
      [
        record.id, record.eventCode, record.eventName, record.sourceId,
        record.metricCode, record.statusCode, record.value, record.timestamp,
        record.payloadHex, record.payloadHash,
        record.status, record.txId, record.blockHash, record.confirmations || 0,
        record.relayMode, record.relayStatus, record.relayReason,
        record.sourceKind, record.sourceRef, record.dedupeKey,
        record.retryCounter || 0, record.lastError,
        record.submittedAt, record.confirmedAt,
        record.createdAt || new Date().toISOString(),
        record.updatedAt || new Date().toISOString(),
      ]
    );
    return record;
  }

  async function get(id) {
    const { rows } = await pool.query(
      `SELECT * FROM blockchain_events WHERE id=$1 OR tx_id=$1 LIMIT 1`, [id]
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async function list(predicate = () => true, limit = 100) {
    const { rows } = await pool.query(
      `SELECT * FROM blockchain_events ORDER BY created_at DESC LIMIT $1`, [limit]
    );
    return rows.map(rowToRecord).filter(predicate);
  }

  async function latest(predicate = () => true) {
    const items = await list(predicate, 1);
    return items[0] || null;
  }

  async function markSeen(key, value) {
    if (value !== undefined) {
      await pool.query(
        `INSERT INTO blockchain_checkpoints (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
        [key, JSON.stringify(value)]
      );
    }
    const { rows } = await pool.query(
      `SELECT value FROM blockchain_checkpoints WHERE key=$1`, [key]
    );
    return rows[0]?.value || null;
  }

  async function checkpoint(key, value) {
    return markSeen(`checkpoint:${key}`, value);
  }

  async function setMeta(key, value) {
    return markSeen(`meta:${key}`, value);
  }

  function read() {
    return { events: [], meta: {}, checkpoints: {}, seen: {} };
  }
  function write() {}

  function rowToRecord(row) {
    return {
      id: row.id,
      eventCode: row.event_code,
      eventName: row.event_name,
      sourceId: row.source_id,
      metricCode: row.metric_code,
      statusCode: row.status_code,
      value: row.value,
      timestamp: row.timestamp_val,
      payloadHex: row.payload_hex,
      payloadHash: row.payload_hash,
      status: row.status,
      txId: row.tx_id,
      blockHash: row.block_hash,
      confirmations: row.confirmations,
      relayMode: row.relay_mode,
      relayStatus: row.relay_status,
      relayReason: row.relay_reason,
      sourceKind: row.source_kind,
      sourceRef: row.source_ref,
      dedupeKey: row.dedupe_key,
      retryCounter: row.retry_counter,
      lastError: row.last_error,
      submittedAt: row.submitted_at?.toISOString?.() || row.submitted_at,
      confirmedAt: row.confirmed_at?.toISOString?.() || row.confirmed_at,
      createdAt: row.created_at?.toISOString?.() || row.created_at,
      updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    };
  }

  async function stats() {
    const { rows } = await pool.query('SELECT * FROM blockchain_stats');
    return rows[0] || {};
  }

  async function prune(days = 180) {
    const { rows } = await pool.query('SELECT * FROM prune_old_records(90, $1)', [days]);
    return rows[0] || {};
  }

  return { init, put, get, list, latest, markSeen, checkpoint, setMeta, read, write, stats, prune, file: 'postgres' };
}

module.exports = { createPgBlockchainStore };
