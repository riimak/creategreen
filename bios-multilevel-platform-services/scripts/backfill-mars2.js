/* eslint-disable no-console */
/**
 * Mars2 historical backfill for raw_measurements.
 *
 * Walks Mars2 CustomDataExport in chunks (default 7 days) for each station and
 * upserts every measurement into PostgreSQL via the same code path the
 * prediction service uses on each cycle. Idempotent — re-running over the same
 * window only refreshes values, no duplicates.
 *
 * Designed to be run inside the prediction pod:
 *
 *   kubectl -n bios-multilevel-production exec deploy/bios-prediction-production-barrage-autodeploy -- \
 *     node /app/scripts/backfill-mars2.js --from 2024-01-01
 *
 *   # Walk backward until two consecutive empty chunks per station:
 *   kubectl -n bios-multilevel-production exec deploy/bios-prediction-production-barrage-autodeploy -- \
 *     node /app/scripts/backfill-mars2.js --auto
 *
 * Flags:
 *   --from YYYY-MM-DD     start of window (inclusive)
 *   --to   YYYY-MM-DD     end of window (default: now)
 *   --auto                walk backward from --to (or now) until 2 empty chunks
 *   --chunk-days N        chunk size (default 7)
 *   --stations CSV        override PREDICTION_STATIONS for this run
 *   --dry-run             fetch + log, do not persist
 *   --max-empty N         in --auto mode, stop after N consecutive empty chunks (default 2)
 */

'use strict';

const path = require('path');
const { loadFromMars2Range, fieldsFor, METEO_FIELDS, SOLAX_FIELDS } = require(path.resolve(__dirname, '..', 'prediction', 'bios-data'));
const { createPgPredictionStore } = require(path.resolve(__dirname, '..', 'database', 'pg-prediction-store'));

function parseArgs(argv) {
  const out = { auto: false, chunkDays: 7, dryRun: false, maxEmpty: 2 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auto') out.auto = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--chunk-days') out.chunkDays = Math.max(1, Number(argv[++i]) || 7);
    else if (a === '--stations') out.stations = argv[++i];
    else if (a === '--max-empty') out.maxEmpty = Math.max(1, Number(argv[++i]) || 2);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`unknown flag: ${a}`); printHelp(); process.exit(2); }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/backfill-mars2.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--auto] [--chunk-days N] [--stations CSV] [--dry-run] [--max-empty N]`);
}

function fmt(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function ensureConfig() {
  const cfg = {
    mars2ApiBase: process.env.BIOS_API_BASE,
    mars2Username: process.env.BIOS_USERNAME,
    mars2Password: process.env.BIOS_PASSWORD,
    apiBase: process.env.PREDICTION_DATA_API_BASE,
    dataDir: process.env.BIOS_OUTPUT_DIR,
  };
  if (!cfg.mars2ApiBase || !cfg.mars2Username || !cfg.mars2Password) {
    console.error('FATAL: BIOS_API_BASE / BIOS_USERNAME / BIOS_PASSWORD must be set in this pod for Mars2 backfill.');
    process.exit(2);
  }
  return cfg;
}

function ensureDb() {
  if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL must be set; raw_measurements backfill requires Postgres.');
    process.exit(2);
  }
  return createPgPredictionStore(process.env.DATABASE_URL);
}

function stationList(args) {
  return (args.stations || process.env.PREDICTION_STATIONS || 'OS1BIOS,OS2BIOS,SOLAXBIOS')
    .split(',').map(s => s.trim()).filter(Boolean);
}

async function backfillStationRange(store, cfg, station, fromDate, toDate, chunkDays, dryRun) {
  const fields = fieldsFor(station);
  let cursor = new Date(fromDate);
  let totalRows = 0;
  let totalPersisted = 0;
  let chunks = 0;
  let emptyChunks = 0;
  while (cursor < toDate) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + chunkDays * 86400000, toDate.getTime()));
    const t0 = Date.now();
    let records = [];
    try {
      records = await loadFromMars2Range(
        cfg.mars2ApiBase,
        cfg.mars2Username,
        cfg.mars2Password,
        station,
        cursor,
        chunkEnd,
      );
    } catch (err) {
      console.error(`  ${station}  ${fmt(cursor)} → ${fmt(chunkEnd)}  FAIL  ${err.message}`);
      cursor = chunkEnd;
      continue;
    }
    let persisted = 0;
    if (!dryRun && records.length > 0) {
      const r = await store.persistRawRecords(station, fields, records);
      persisted = r.inserted || 0;
    }
    totalRows += records.length;
    totalPersisted += persisted;
    chunks += 1;
    emptyChunks = records.length === 0 ? emptyChunks + 1 : 0;
    console.log(`  ${station}  ${fmt(cursor)} → ${fmt(chunkEnd)}  rows=${records.length}  persisted=${persisted}  ${Date.now() - t0}ms`);
    cursor = chunkEnd;
  }
  return { totalRows, totalPersisted, chunks, emptyChunks };
}

async function backfillStationAuto(store, cfg, station, toDate, chunkDays, maxEmpty, dryRun) {
  const fields = fieldsFor(station);
  let cursorEnd = new Date(toDate);
  let totalRows = 0;
  let totalPersisted = 0;
  let chunks = 0;
  let consecutiveEmpty = 0;
  while (consecutiveEmpty < maxEmpty) {
    const cursorStart = new Date(cursorEnd.getTime() - chunkDays * 86400000);
    const t0 = Date.now();
    let records = [];
    try {
      records = await loadFromMars2Range(
        cfg.mars2ApiBase,
        cfg.mars2Username,
        cfg.mars2Password,
        station,
        cursorStart,
        cursorEnd,
      );
    } catch (err) {
      console.error(`  ${station}  ${fmt(cursorStart)} → ${fmt(cursorEnd)}  FAIL  ${err.message}`);
      cursorEnd = cursorStart;
      continue;
    }
    let persisted = 0;
    if (!dryRun && records.length > 0) {
      const r = await store.persistRawRecords(station, fields, records);
      persisted = r.inserted || 0;
    }
    totalRows += records.length;
    totalPersisted += persisted;
    chunks += 1;
    consecutiveEmpty = records.length === 0 ? consecutiveEmpty + 1 : 0;
    console.log(`  ${station}  ${fmt(cursorStart)} → ${fmt(cursorEnd)}  rows=${records.length}  persisted=${persisted}  emptyStreak=${consecutiveEmpty}/${maxEmpty}  ${Date.now() - t0}ms`);
    cursorEnd = cursorStart;
  }
  return { totalRows, totalPersisted, chunks, earliestReached: cursorEnd.toISOString() };
}

(async () => {
  const args = parseArgs(process.argv);
  const cfg = ensureConfig();
  const store = ensureDb();
  await store.init();
  console.log(`backfill-mars2 starting at ${new Date().toISOString()}`);
  console.log(`  host=${new URL(cfg.mars2ApiBase).host} stations=[${stationList(args).join(',')}] chunkDays=${args.chunkDays} dryRun=${args.dryRun}`);

  const toDate = args.to ? new Date(args.to) : new Date();
  const stations = stationList(args);

  const overall = { rows: 0, persisted: 0, chunks: 0 };
  for (const station of stations) {
    console.log(`\n── ${station} ──`);
    let r;
    if (args.auto) {
      r = await backfillStationAuto(store, cfg, station, toDate, args.chunkDays, args.maxEmpty, args.dryRun);
      console.log(`  ${station}  total rows=${r.totalRows}  persisted=${r.totalPersisted}  chunks=${r.chunks}  earliestReached=${r.earliestReached}`);
    } else {
      if (!args.from) {
        console.error('FATAL: --from required (or pass --auto). Example: --from 2024-01-01');
        process.exit(2);
      }
      const fromDate = new Date(args.from);
      r = await backfillStationRange(store, cfg, station, fromDate, toDate, args.chunkDays, args.dryRun);
      console.log(`  ${station}  total rows=${r.totalRows}  persisted=${r.totalPersisted}  chunks=${r.chunks}`);
    }
    overall.rows += r.totalRows;
    overall.persisted += r.totalPersisted;
    overall.chunks += r.chunks;
  }
  console.log(`\nbackfill-mars2 finished: rows=${overall.rows} persisted=${overall.persisted} chunks=${overall.chunks}`);
  process.exit(0);
})().catch((err) => {
  console.error('backfill-mars2 aborted:', err);
  process.exit(1);
});
