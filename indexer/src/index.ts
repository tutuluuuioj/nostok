import { loadConfig } from './config.js';
import { createIndexerContext, runIndexerSync } from './indexer.js';

async function main(): Promise<void> {
  const runOnce =
    process.argv.includes('--once') ||
    process.env.ONCE?.trim().toLowerCase() === 'true';

  const config = loadConfig();
  const ctx = await createIndexerContext(config);

  console.log(
    `[INDEXER_START] chainId=${ctx.publicClient.chain.id} rpc=${config.rpcUrl} startBlock=${config.startBlock} confirmations=${config.confirmations} assets=${ctx.trackedAssets.size}`
  );

  let stopping = false;
  let timer: NodeJS.Timeout | undefined;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[INDEXER_STOP] Received ${signal}; closing DB connection.`);
    if (timer) clearTimeout(timer);
    await ctx.db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (runOnce) {
    const summary = await runIndexerSync(ctx);
    console.log('[INDEXER_ONCE_DONE]', summary);
    await ctx.db.close();
    return;
  }

  const loop = async () => {
    if (stopping) return;
    try {
      const summary = await runIndexerSync(ctx);
      if (summary.reorgDetected || summary.blocksProcessed > 0) {
        console.log('[INDEXER_SYNC]', summary);
      }
    } catch (err) {
      console.error('[INDEXER_SYNC_ERROR]', err instanceof Error ? err.message : String(err));
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
  console.error('[INDEXER_FATAL]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
