const { walletReadiness } = require('./stealth-wallet');

async function feelessStatus(relay) {
  const hasRpc = Boolean(process.env.STEALTH_RPC_URL);
  const hasWallet = Boolean(
    process.env.STEALTH_WIF
    || process.env.STEALTH_WIF_FILE
    || process.env.STEALTH_WALLET_SEED
    || process.env.STEALTH_WALLET_SEED_FILE
  );
  const hasBuilder = Boolean(process.env.STEALTH_RAW_TX_BUILDER_URL);
  const wallet = await walletReadiness(relay);
  const hasSpendableUtxo = Number(wallet.spendableOutputs || 0) > 0;
  const realBroadcastEnabled = String(process.env.STEALTH_ENABLE_REAL_BROADCAST || 'false').toLowerCase() === 'true';
  const localBuilderAvailable = true;

  return {
    configured: hasRpc && (hasBuilder || (hasWallet && hasSpendableUtxo)),
    realBroadcastEnabled,
    rpcConfigured: hasRpc,
    walletConfigured: hasWallet,
    spendableUtxo: hasSpendableUtxo,
    externalBuilderConfigured: hasBuilder,
    localBuilderAvailable,
    mode: hasBuilder ? 'external-builder' : hasWallet ? 'local-wif' : 'not-configured',
    wallet: {
      configured: wallet.configured,
      address: wallet.address || null,
      publicKey: wallet.publicKey || null,
      network: wallet.network || process.env.STEALTH_NETWORK || 'mainnet',
      balance: wallet.balance ?? null,
      spendableOutputs: wallet.spendableOutputs || 0,
      rpcChecked: Boolean(wallet.rpcChecked),
      reason: wallet.reason || null,
      balanceError: wallet.balanceError || null,
      outputsError: wallet.outputsError || null,
    },
    requirements: [
      'Stealth JSON-RPC URL for getbestblock and sendrawtransaction',
      'A service WIF/private signing source with spendable UTXO, or an external raw transaction builder',
      'Feeless work calculation and transaction signing before broadcast',
    ],
    note: hasRpc && hasSpendableUtxo && realBroadcastEnabled
      ? 'Real feeless broadcasting is enabled. The service will build, sign, and submit compact proof transactions.'
      : hasRpc && hasSpendableUtxo
        ? 'RPC, WIF, spendable UTXO, and local builder are ready. Set STEALTH_ENABLE_REAL_BROADCAST=true to submit transactions.'
        : hasRpc
          ? 'RPC is configured. Real submission still requires a spendable UTXO.'
          : 'Mock mode can demonstrate traceability. Real feeless submission requires Stealth RPC and signing configuration.',
  };
}

module.exports = { feelessStatus };
