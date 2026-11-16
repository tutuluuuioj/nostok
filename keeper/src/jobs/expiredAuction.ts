import { type Address } from 'viem';
import {
  AuctionStatus,
  OracleState,
  ORACLE_STATE_NAMES,
  aggregatorV3Abi,
  assetRegistryAbi,
  liquidationAuctionAbi,
  oracleRouterAbi,
} from '../abi.js';
import { executeContractAction, type TxExecutionResult } from '../tx.js';
import type { KeeperContext } from '../types.js';

async function emitAuctionTokenAlertOnce(
  ctx: KeeperContext,
  type: 'FROZEN_SPLIT' | 'STALE_FEED',
  token: Address,
  auctionId: bigint,
  message: string,
  details: Record<string, string | number | boolean | undefined>
): Promise<void> {
  const key = `${type}:${token.toLowerCase()}`;
  if (ctx.cycleAlertedKeys?.has(key)) return;
  ctx.cycleAlertedKeys?.add(key);
  await ctx.alerts.send(type, message, { ...details, auctionId: auctionId.toString() });
}

/**
 * Job 3: Expired Auction Restart/Cancel Scanner
 * - Scans auctions 1..nextAuctionId - 1 with status == Active (0).
 * - Checks block.timestamp >= startTime + duration (30 min = 1800s) and collateralRemaining > 0.
 * - Verifies exact contract preconditions from LiquidationAuction.sol:351-373 so restartOrCancelAuction(auctionId)
 *   is only called when the contract allows it (and does not silently return as a no-op).
 * - Does not execute floor buys or flash buys.
 */
export async function runExpiredAuctionJob(ctx: KeeperContext): Promise<TxExecutionResult[]> {
  const { config, publicClient, walletClient, alerts } = ctx;
  const results: TxExecutionResult[] = [];

  const [nextAuctionId, block] = await Promise.all([
    publicClient.readContract({
      address: config.liquidationAuction,
      abi: liquidationAuctionAbi,
      functionName: 'nextAuctionId',
    }),
    publicClient.getBlock(),
  ]);

  const nowTs = block.timestamp;
  const totalAuctions = nextAuctionId > 1n ? nextAuctionId - 1n : 0n;
  console.log(`[EXPIRED_AUCTION] Scanning ${totalAuctions} auction(s) at block timestamp ${nowTs}...`);

  for (let auctionId = 1n; auctionId < nextAuctionId; auctionId++) {
    const auction = await publicClient.readContract({
      address: config.liquidationAuction,
      abi: liquidationAuctionAbi,
      functionName: 'getAuction',
      args: [auctionId],
    });

    if (auction.status !== AuctionStatus.Active) {
      continue;
    }

    const expiryTs = BigInt(auction.startTime) + BigInt(auction.duration);
    if (nowTs < expiryTs) {
      const remainingSecs = expiryTs - nowTs;
      console.log(
        `[EXPIRED_AUCTION] Auction #${auctionId} (loan #${auction.loanId}) still active (${remainingSecs}s remaining).`
      );
      continue;
    }

    if (auction.collateralRemaining === 0n) {
      console.log(`[EXPIRED_AUCTION] Auction #${auctionId} has 0 collateralRemaining; skipping.`);
      continue;
    }

    const token = auction.collateralToken;
    const [currentPrice, , oracleState] = await publicClient.readContract({
      address: config.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'getPrice',
      args: [token],
    });

    const stateName = ORACLE_STATE_NAMES[oracleState] ?? `UNKNOWN(${oracleState})`;

    if (oracleState === OracleState.STALE_FEED) {
      await emitAuctionTokenAlertOnce(
        ctx,
        'STALE_FEED',
        token,
        auctionId,
        `Oracle STALE_FEED on expired auction #${auctionId}`,
        { token, price: currentPrice.toString(), oracleState: stateName }
      );
    } else if (oracleState === OracleState.FROZEN_CORPORATE_ACTION) {
      await emitAuctionTokenAlertOnce(
        ctx,
        'FROZEN_SPLIT',
        token,
        auctionId,
        `Asset FROZEN_CORPORATE_ACTION on expired auction #${auctionId}; restart disallowed`,
        { token, oracleState: stateName }
      );
    }

    // Mirrors LiquidationAuction.sol:353-360
    const allowedState =
      oracleState === OracleState.VALID_OPEN ||
      oracleState === OracleState.VALID_CLOSED ||
      oracleState === OracleState.STALE_FEED;

    if (!allowedState || currentPrice === 0n) {
      console.log(
        `[EXPIRED_AUCTION] Auction #${auctionId} expired, but contract disallows restart in state=${stateName} (price=${currentPrice}). Skipping.`
      );
      continue;
    }

    // Mirrors LiquidationAuction.sol:362-373 stale-feed max age cap
    if (oracleState === OracleState.STALE_FEED) {
      const cfg = await publicClient.readContract({
        address: config.assetRegistry,
        abi: assetRegistryAbi,
        functionName: 'getAssetConfig',
        args: [token],
      });

      const [, , , updatedAt] = await publicClient.readContract({
        address: cfg.feed,
        abi: aggregatorV3Abi,
        functionName: 'latestRoundData',
      });

      const doubled = BigInt(cfg.maxStaleOpenSecs) * 2n;
      const rawMaxAge = cfg.maxStaleOpenSecs > 0 ? doubled : 86_400n;
      const maxFeedAge = rawMaxAge > 86_400n ? 86_400n : rawMaxAge;

      if (updatedAt === 0n || nowTs > updatedAt + maxFeedAge) {
        console.warn(
          `[EXPIRED_AUCTION] Auction #${auctionId} is STALE_FEED past max restart age (updatedAt=${updatedAt}, maxFeedAge=${maxFeedAge}, now=${nowTs}). Contract would skip restart; skipping.`
        );
        continue;
      }
    }

    console.log(
      `[EXPIRED_AUCTION] Auction #${auctionId} (loan #${auction.loanId}) expired at ${expiryTs} (now=${nowTs}, state=${stateName}). Calling restartOrCancelAuction...`
    );

    const res = await executeContractAction({
      label: `LiquidationAuction.restartOrCancelAuction(${auctionId})`,
      address: config.liquidationAuction,
      abi: liquidationAuctionAbi,
      functionName: 'restartOrCancelAuction',
      args: [auctionId],
      publicClient,
      walletClient,
      dryRun: config.dryRun,
      alerts,
    });
    results.push(res);
  }

  return results;
}
