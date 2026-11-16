import { loadRiskConfig } from './config.js';
import { createRiskContext, runRiskScan } from './monitor.js';
import { createRiskServer } from './server.js';

async function main(): Promise<void> {
  const runOnce =
    process.argv.includes('--once') ||
    process.env.ONCE?.trim().toLowerCase() === 'true';

  const config = loadRiskConfig();
  const ctx = await createRiskContext(config);

  const initialSummary = await runRiskScan(ctx);
  console.log('[RISK_SCAN_INIT]', {
    status: initialSummary.status,
    chainHeadBlock: initialSummary.chain_head_block,
    openLoans: Object.values(initialSummary.loan_counts).reduce((a, b) => a + b, 0),
    activeAlerts: initialSummary.active_alerts,
  });

  if (runOnce) {
    await ctx.db.close();
    return;
  }

  const server = createRiskServer(ctx);
  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, () => {
      console.log(
        `[RISK_START] Read-only risk monitor listening on http://${config.host}:${config.port} (pollMs=${config.pollIntervalMs})`
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
        await runRiskScan(ctx);
      } catch (err) {
        console.error('[RISK_LOOP_ERROR]', err instanceof Error ? err.message : String(err));
      }
      scheduleNext();
    }, config.pollIntervalMs);
  };
  scheduleNext();

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[RISK_STOP] Received ${signal}; shutting down.`);
    if (timer) clearTimeout(timer);
    server.close(async () => {
      await ctx.db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[RISK_FATAL]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
