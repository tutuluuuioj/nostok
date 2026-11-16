import { loadApiConfig } from './config.js';
import { createApiContext, createApiServer } from './server.js';

async function main(): Promise<void> {
  const config = loadApiConfig();
  const ctx = await createApiContext(config);
  const server = createApiServer(ctx);

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, () => {
      console.log(
        `[API_START] Read-only NOSTOK API listening on http://${config.host}:${config.port} (chainId=${ctx.publicClient.chain.id}, cors=${config.corsOrigins.join(',')}, rateLimit=${config.rateLimitMax}/${config.rateLimitWindowMs}ms)`
      );
      resolve();
    });
  });

  const shutdown = async (signal: string) => {
    console.log(`[API_STOP] Received ${signal}; shutting down gracefully.`);
    server.close(async () => {
      await ctx.db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[API_FATAL]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
