import { loadConfig } from './config.js';
import { createKeeperContext, runKeeperCycle } from './keeper.js';
import { extractErrorMessage } from './tx.js';

async function main(): Promise<void> {
  const runOnce =
    process.argv.includes('--once') ||
    process.env.ONCE?.trim().toLowerCase() === 'true';

  const config = loadConfig();
  const ctx = await createKeeperContext(config);

  console.log(
    `[KEEPER_START] keeper=${ctx.walletClient.account.address} rpc=${config.rpcUrl} assets=${config.assets.length} pollMs=${config.pollIntervalMs} dryRun=${config.dryRun}`
  );

  let stopping = false;
  let timer: NodeJS.Timeout | undefined;

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[KEEPER_STOP] Received ${signal}; shutting down cleanly.`);
    if (timer) clearTimeout(timer);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (runOnce) {
    await runKeeperCycle(ctx);
    return;
  }

  const loop = async () => {
    if (stopping) return;
    try {
      await runKeeperCycle(ctx);
    } catch (err) {
      console.error(`[KEEPER_CYCLE_ERROR] ${extractErrorMessage(err)}`);
    }
    if (!stopping) {
      timer = setTimeout(() => {
        void loop();
      }, config.pollIntervalMs);
    }
  };

  await loop();
}

main().catch((err) => {
  console.error(`[KEEPER_FATAL] ${extractErrorMessage(err)}`);
  process.exit(1);
});
