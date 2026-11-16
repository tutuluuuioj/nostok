import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { AlertManager } from './alerts.js';
import type { KeeperConfig } from './config.js';
import { runExpiredAuctionJob } from './jobs/expiredAuction.js';
import { runLiquidationJob } from './jobs/liquidation.js';
import { runSyncMultiplierJob } from './jobs/syncMultiplier.js';
import { checkPendingNonceGuard, extractErrorMessage, type TxExecutionResult } from './tx.js';
import type { KeeperContext, KeeperCycleSummary } from './types.js';

export function validateChainId(
  chainId: number,
  config: Pick<KeeperConfig, 'isFork' | 'forkChainId'>
): void {
  if (!config.isFork && chainId !== 8453) {
    throw new Error(
      `Invalid chainId ${chainId}: expected Base Mainnet (8453). Set FORK=true and FORK_CHAIN_ID=${chainId} to run on a non-8453 fork.`
    );
  }
  if (config.isFork && chainId !== config.forkChainId) {
    throw new Error(
      `Invalid fork chainId ${chainId}: expected FORK_CHAIN_ID=${config.forkChainId}.`
    );
  }
}

export async function createKeeperContext(config: KeeperConfig): Promise<KeeperContext> {
  const account = privateKeyToAccount(config.keeperPrivateKey);

  const probeClient = createPublicClient({
    transport: http(config.rpcUrl),
  });
  const chainId = await probeClient.getChainId();
  validateChainId(chainId, config);

  const chain = defineChain({
    id: chainId,
    name: chainId === base.id ? base.name : `Nostok Chain ${chainId}`,
    nativeCurrency: base.nativeCurrency,
    rpcUrls: {
      default: { http: [config.rpcUrl] },
    },
  });

  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl),
  });

  const alerts = new AlertManager(config.telegramWebhookUrl, config.telegramChatId);

  return {
    config,
    publicClient,
    walletClient,
    alerts,
  };
}

export async function runKeeperCycle(ctx: KeeperContext): Promise<KeeperCycleSummary> {
  const cycleCtx: KeeperContext = {
    ...ctx,
    cycleAlertedKeys: new Set<string>(),
  };

  const alertStartIdx = cycleCtx.alerts.history.length;
  const keeperAddress = cycleCtx.walletClient.account.address;

  let blockNumber = 0n;
  let blockTimestamp = 0n;
  let balanceWei = 0n;

  try {
    const block = await cycleCtx.publicClient.getBlock();
    blockNumber = block.number;
    blockTimestamp = block.timestamp;
  } catch (err) {
    const reason = extractErrorMessage(err);
    console.error(`[CYCLE_ERROR] Failed to fetch latest block: ${reason}`);
    await cycleCtx.alerts.send('RPC_ERROR', 'Failed to fetch latest block header', { reason });
  }

  try {
    balanceWei = await cycleCtx.publicClient.getBalance({ address: keeperAddress });
    console.log(
      `[CYCLE] block=${blockNumber} ts=${blockTimestamp} keeper=${keeperAddress} eth=${formatEther(balanceWei)} dryRun=${cycleCtx.config.dryRun}`
    );

    if (balanceWei < cycleCtx.config.minKeeperEthWei) {
      await cycleCtx.alerts.send('LOW_ETH_BALANCE', 'Keeper ETH balance is below configured threshold', {
        keeperAddress,
        balanceEth: formatEther(balanceWei),
        thresholdEth: formatEther(cycleCtx.config.minKeeperEthWei),
      });
    }
  } catch (err) {
    const reason = extractErrorMessage(err);
    console.error(`[CYCLE_ERROR] Failed to check keeper ETH balance: ${reason}`);
    await cycleCtx.alerts.send('RPC_ERROR', 'Failed to fetch keeper ETH balance', {
      keeperAddress,
      reason,
    });
  }

  if (!cycleCtx.config.dryRun) {
    try {
      const nonceGuard = await checkPendingNonceGuard(
        cycleCtx.publicClient,
        keeperAddress,
        cycleCtx.config.txTimeoutMs,
        cycleCtx.alerts,
        true
      );
      if (nonceGuard.blocked) {
        cycleCtx.skipTxBecauseStuckNonce = true;
      }
    } catch (err) {
      const reason = extractErrorMessage(err);
      console.error(`[CYCLE_ERROR] Failed to check pending nonce guard: ${reason}`);
      await cycleCtx.alerts.send('RPC_ERROR', 'Failed to check pending nonce guard', {
        keeperAddress,
        reason,
      });
    }
  }

  let syncMultiplierResults: TxExecutionResult[] = [];
  try {
    syncMultiplierResults = await runSyncMultiplierJob(cycleCtx);
  } catch (err) {
    const reason = extractErrorMessage(err);
    console.error(`[JOB_ERROR] syncMultiplier job failed: ${reason}`);
    await cycleCtx.alerts.send('RPC_ERROR', 'syncMultiplier job threw an unexpected error', {
      job: 'syncMultiplier',
      reason,
    });
  }

  let liquidationResults: TxExecutionResult[] = [];
  try {
    liquidationResults = await runLiquidationJob(cycleCtx);
  } catch (err) {
    const reason = extractErrorMessage(err);
    console.error(`[JOB_ERROR] liquidation job failed: ${reason}`);
    await cycleCtx.alerts.send('RPC_ERROR', 'liquidation job threw an unexpected error', {
      job: 'liquidation',
      reason,
    });
  }

  let expiredAuctionResults: TxExecutionResult[] = [];
  try {
    expiredAuctionResults = await runExpiredAuctionJob(cycleCtx);
  } catch (err) {
    const reason = extractErrorMessage(err);
    console.error(`[JOB_ERROR] expiredAuction job failed: ${reason}`);
    await cycleCtx.alerts.send('RPC_ERROR', 'expiredAuction job threw an unexpected error', {
      job: 'expiredAuction',
      reason,
    });
  }

  const alertsEmitted = cycleCtx.alerts.history.slice(alertStartIdx);

  return {
    timestamp: new Date().toISOString(),
    blockNumber,
    blockTimestamp,
    keeperAddress,
    keeperEthBalanceWei: balanceWei,
    syncMultiplierResults,
    liquidationResults,
    expiredAuctionResults,
    alertsEmitted,
  };
}
