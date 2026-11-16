import { type Address } from 'viem';
import {
  OracleState,
  ORACLE_STATE_NAMES,
  assetRegistryAbi,
  b20TokenAbi,
  oracleRouterAbi,
} from '../abi.js';
import { executeContractAction, type TxExecutionResult } from '../tx.js';
import type { KeeperContext } from '../types.js';

async function emitTokenAlertOnce(
  ctx: KeeperContext,
  type: 'FROZEN_SPLIT' | 'STALE_FEED',
  token: Address,
  message: string,
  details: Record<string, string | number | boolean | undefined>
): Promise<void> {
  const key = `${type}:${token.toLowerCase()}`;
  if (ctx.cycleAlertedKeys?.has(key)) return;
  ctx.cycleAlertedKeys?.add(key);
  await ctx.alerts.send(type, message, details);
}

/**
 * Job 1: B20 Multiplier Sync Keeper
 * - Reads token.uiMultiplier() and OracleRouter.recordedMultiplier(token) for each configured asset.
 * - If drift is > 0% and < 5% (< 500 bps), simulates and calls OracleRouter.syncMultiplier(token).
 * - If drift >= 5% (>= 500 bps) or unrecorded baseline freezes the asset, does NOT call syncMultiplier
 *   and emits a FROZEN_SPLIT alert instead.
 */
export async function runSyncMultiplierJob(ctx: KeeperContext): Promise<TxExecutionResult[]> {
  const { config, publicClient, walletClient, alerts } = ctx;
  const results: TxExecutionResult[] = [];

  if (config.assets.length === 0) {
    console.log('[SYNC_MULTIPLIER] No assets configured in ASSET_LIST; skipping.');
    return results;
  }

  for (const token of config.assets) {
    let symbol: string = token;
    try {
      symbol = await publicClient.readContract({
        address: token,
        abi: b20TokenAbi,
        functionName: 'symbol',
      });
    } catch {
      // Non-fatal fallback to address label
    }

    const supported = await publicClient.readContract({
      address: config.assetRegistry,
      abi: assetRegistryAbi,
      functionName: 'isAssetSupported',
      args: [token],
    });
    if (!supported) {
      console.warn(`[SYNC_MULTIPLIER] Asset ${symbol} (${token}) is not supported in AssetRegistry; skipping.`);
      continue;
    }

    let currentMult: bigint;
    try {
      currentMult = await publicClient.readContract({
        address: token,
        abi: b20TokenAbi,
        functionName: 'uiMultiplier',
      });
    } catch {
      console.log(`[SYNC_MULTIPLIER] Asset ${symbol} (${token}) does not expose uiMultiplier(); skipping.`);
      continue;
    }

    if (currentMult === 0n) {
      console.log(`[SYNC_MULTIPLIER] Asset ${symbol} (${token}) returned uiMultiplier() == 0; skipping.`);
      continue;
    }

    const [recMult, priceData] = await Promise.all([
      publicClient.readContract({
        address: config.oracleRouter,
        abi: oracleRouterAbi,
        functionName: 'recordedMultiplier',
        args: [token],
      }),
      publicClient.readContract({
        address: config.oracleRouter,
        abi: oracleRouterAbi,
        functionName: 'getPrice',
        args: [token],
      }),
    ]);

    const [price, , oracleState] = priceData;
    const stateName = ORACLE_STATE_NAMES[oracleState] ?? `UNKNOWN(${oracleState})`;

    if (oracleState === OracleState.STALE_FEED) {
      await emitTokenAlertOnce(
        ctx,
        'STALE_FEED',
        token,
        `Oracle feed for ${symbol} is STALE_FEED`,
        { token, symbol, price: price.toString(), oracleState: stateName }
      );
    }

    if (recMult === 0n) {
      await emitTokenAlertOnce(
        ctx,
        'FROZEN_SPLIT',
        token,
        `Asset ${symbol} has recordedMultiplier == 0 (${stateName}); requires privileged baseline initialization`,
        {
          token,
          symbol,
          currentMultiplier: currentMult.toString(),
          recordedMultiplier: '0',
          oracleState: stateName,
        }
      );
      continue;
    }

    const diff = currentMult > recMult ? currentMult - recMult : recMult - currentMult;
    const diffBps = (diff * 10_000n) / recMult;
    const pct = Number((diff * 10_000_000n) / recMult) / 100_000;

    if (diff === 0n) {
      if (oracleState === OracleState.FROZEN_CORPORATE_ACTION) {
        await emitTokenAlertOnce(
          ctx,
          'FROZEN_SPLIT',
          token,
          `Asset ${symbol} is in FROZEN_CORPORATE_ACTION state (manual registry freeze)`,
          { token, symbol, recordedMultiplier: recMult.toString(), oracleState: stateName }
        );
      } else {
        console.log(`[SYNC_MULTIPLIER] ${symbol} (${token}) in sync | mult=${recMult} | state=${stateName}`);
      }
      continue;
    }

    if (diffBps >= 500n) {
      console.warn(
        `[SYNC_MULTIPLIER] ${symbol} (${token}) multiplier jump >= 5% (${diffBps} bps / ~${pct.toFixed(4)}%). Skipping syncMultiplier and alerting.`
      );
      await emitTokenAlertOnce(
        ctx,
        'FROZEN_SPLIT',
        token,
        `Corporate action / split detected on ${symbol}: multiplier jumped by ${diffBps} bps (~${pct.toFixed(2)}%)`,
        {
          token,
          symbol,
          recordedMultiplier: recMult.toString(),
          currentMultiplier: currentMult.toString(),
          diffBps: diffBps.toString(),
          oracleState: stateName,
        }
      );
      continue;
    }

    console.log(
      `[SYNC_MULTIPLIER] ${symbol} (${token}) drift detected: ${diffBps} bps (~${pct.toFixed(4)}%, diff=${diff} wei). Syncing OracleRouter...`
    );

    const res = await executeContractAction({
      label: `OracleRouter.syncMultiplier(${symbol})`,
      address: config.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'syncMultiplier',
      args: [token],
      publicClient,
      walletClient,
      dryRun: config.dryRun,
      alerts,
    });
    results.push(res);
  }

  return results;
}
