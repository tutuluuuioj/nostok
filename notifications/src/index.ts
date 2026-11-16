import { loadNotificationsConfig } from './config.js';
import { createNotificationsContext, runNotificationsCycle } from './engine.js';
import { createNotificationsServer } from './server.js';

async function main(): Promise<void> {
  const runOnce =
    process.argv.includes('--once') ||
    process.env.ONCE?.trim().toLowerCase() === 'true';

  const config = loadNotificationsConfig();
  const ctx = await createNotificationsContext(config);

  const initialStats = await runNotificationsCycle(ctx);
  console.log('[NOTIF_SYNC_INIT]', initialStats);

  if (runOnce) {
    await ctx.indexerDb.close();
    await ctx.notifDb.close();
    return;
  }

  const server = createNotificationsServer(ctx);
  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, () => {
      console.log(
        `[NOTIF_START] User alerts service listening on http://${config.host}:${config.port} (pollMs=${config.pollIntervalMs})`
      );
      resolve();
    });
  });

  let stopping = false;
  let timer: NodeJS.Timeout | undefined;

  const scheduleNext = () => {
    if (stopping) return;
    timer = setTimeout(async () => {
      try {
        await runNotificationsCycle(ctx);
      } catch (err) {
        console.error('[NOTIF_LOOP_ERROR]', err instanceof Error ? err.message : String(err));
      }
      scheduleNext();
    }, config.pollIntervalMs);
  };
  scheduleNext();

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[NOTIF_STOP] Received ${signal}; shutting down.`);
    if (timer) clearTimeout(timer);
    server.close(async () => {
      await ctx.indexerDb.close();
      await ctx.notifDb.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[NOTIF_FATAL]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
