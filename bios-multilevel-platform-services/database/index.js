// Store factory: use PostgreSQL when DATABASE_URL is set, fall back to JSON files.
// This lets the platform run in both modes:
//   - Local dev / Docker Compose: JSON files in Docker volumes (zero deps)
//   - Kubernetes production: PostgreSQL in a dedicated database namespace

const { createStore: createJsonPredictionStore } = require('../prediction/store');
const { createStore: createJsonBlockchainStore } = require('../blockchain/store');

async function createPredictionStore() {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const { createPgPredictionStore } = require('./pg-prediction-store');
    const store = createPgPredictionStore(dbUrl);
    await store.init();
    console.log('Prediction store: PostgreSQL');
    return store;
  }
  console.log('Prediction store: JSON file');
  return createJsonPredictionStore(process.env.PREDICTION_DB_PATH);
}

async function createBlockchainStore() {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const { createPgBlockchainStore } = require('./pg-blockchain-store');
    const store = createPgBlockchainStore(dbUrl);
    await store.init();
    console.log('Blockchain store: PostgreSQL');
    return store;
  }
  console.log('Blockchain store: JSON file');
  return createJsonBlockchainStore(process.env.BLOCKCHAIN_DB_PATH);
}

module.exports = { createPredictionStore, createBlockchainStore };
