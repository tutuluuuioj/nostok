import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import {
  buildContentSecurityPolicy,
  getFrontendConfig,
  setFrontendConfigOverrides,
} from './src/lib/contracts.js';

function envToOverrides(env, isProd) {
  return {
    isProd,
    isFork: !isProd && (env.VITE_IS_FORK === 'true' || env.FORK === 'true'),
    chainId: env.VITE_CHAIN_ID ?? '',
    rpcUrl: env.VITE_RPC_URL,
    apiUrl: env.VITE_API_URL,
    notificationsUrl: env.VITE_NOTIFICATIONS_URL,
    riskUrl: env.VITE_RISK_URL ?? (isProd ? '' : undefined),
    siweDomain: env.VITE_SIWE_DOMAIN,
    siweOrigin: env.VITE_SIWE_ORIGIN,
    usdcAddress: env.VITE_USDC_ADDRESS,
    loanCore: env.VITE_LOAN_CORE_ADDRESS,
    orderSettlement: env.VITE_ORDER_SETTLEMENT_ADDRESS,
    liquidationAuction: env.VITE_LIQUIDATION_AUCTION_ADDRESS,
    positionNft: env.VITE_POSITION_NFT_ADDRESS,
    collateralEscrow: env.VITE_COLLATERAL_ESCROW_ADDRESS,
    assetRegistry: env.VITE_ASSET_REGISTRY_ADDRESS,
    oracleRouter: env.VITE_ORACLE_ROUTER_ADDRESS,
    eligibilityGate: env.VITE_ELIGIBILITY_GATE_ADDRESS,
  };
}

function resolveFrontendConfigFromEnv(env, isProd) {
  setFrontendConfigOverrides(envToOverrides(env, isProd));
  try {
    return getFrontendConfig();
  } finally {
    setFrontendConfigOverrides({});
  }
}

function resolveBestAvailableConfig(env, allowProdFallback = true) {
  try {
    return resolveFrontendConfigFromEnv(env, true);
  } catch (err) {
    if (!allowProdFallback) throw err;
    try {
      return resolveFrontendConfigFromEnv(env, false);
    } catch {
      return null;
    }
  }
}

function nostokConfigAndCspPlugin(command, mode, env) {
  let validatedBuildCfg = null;

  const attachSecurityHeaders = (middlewares) => {
    middlewares.use((_req, res, next) => {
      const cfg = validatedBuildCfg ?? resolveBestAvailableConfig(env, true);
      if (cfg) {
        res.setHeader(
          'Content-Security-Policy',
          buildContentSecurityPolicy(cfg, { includeFrameAncestors: true })
        );
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      next();
    });
  };

  return {
    name: 'nostok-config-and-csp',
    buildStart() {
      if (command === 'build' && mode === 'production') {
        // Fails `vite build` immediately on invalid production configuration
        validatedBuildCfg = resolveFrontendConfigFromEnv(env, true);
      }
    },
    configureServer(server) {
      attachSecurityHeaders(server.middlewares);
    },
    configurePreviewServer(server) {
      attachSecurityHeaders(server.middlewares);
    },
    transformIndexHtml(html) {
      const cfg = validatedBuildCfg ?? resolveBestAvailableConfig(env, true);
      if (!cfg) return html;
      const metaCsp = buildContentSecurityPolicy(cfg, { includeFrameAncestors: false });
      return html.replace(
        /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/i,
        `<meta http-equiv="Content-Security-Policy" content="${metaCsp}" />`
      );
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const env = { ...fileEnv, ...process.env };
  return {
    plugins: [react(), nostokConfigAndCspPlugin(command, mode, env)],
    server: { host: '127.0.0.1', port: 3020, strictPort: true },
    preview: { host: '127.0.0.1', port: 3020, strictPort: true },
  };
});
