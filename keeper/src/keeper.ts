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
import type { KeeperContext, KeeperCycleSummary } from './types.js';

export async function createKeeperContext(config: KeeperConfig): Promise<KeeperContext> {
  const account = privateKeyToAccount(config.keeperPrivateKey);

  const probeClient = createPublicClient({
    transport: http(config.rpcUrl),
  });
  const chainId = await probeClient.getChainId();

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

  const [block, balanceWei] = await Promise.all([
    cycleCtx.publicClient.getBlock(),
    cycleCtx.publicClient.getBalance({ address: keeperAddress }),
  ]);

  console.log(
    `[CYCLE] block=${block.number} ts=${block.timestamp} keeper=${keeperAddress} eth=${formatEther(balanceWei)} dryRun=${cycleCtx.config.dryRun}`
  );

  if (balanceWei < cycleCtx.config.minKeeperEthWei) {
    await cycleCtx.alerts.send('LOW_ETH_BALANCE', 'Keeper ETH balance is below configured threshold', {
      keeperAddress,
      balanceEth: formatEther(balanceWei),
      thresholdEth: formatEther(cycleCtx.config.minKeeperEthWei),
    });
  }

  const syncMultiplierResults = await runSyncMultiplierJob(cycleCtx);
  const liquidationResults = await runLiquidationJob(cycleCtx);
  const expiredAuctionResults = await runExpiredAuctionJob(cycleCtx);

  const alertsEmitted = cycleCtx.alerts.history.slice(alertStartIdx);

  return {
    timestamp: new Date().toISOString(),
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    keeperAddress,
    keeperEthBalanceWei: balanceWei,
    syncMultiplierResults,
    liquidationResults,
    expiredAuctionResults,
    alertsEmitted,
  };
}
