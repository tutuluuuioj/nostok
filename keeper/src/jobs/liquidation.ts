import { type Address, zeroAddress } from 'viem';
import {
  LoanStatus,
  OracleState,
  ORACLE_STATE_NAMES,
  loanCoreAbi,
  oracleRouterAbi,
} from '../abi.js';
import { executeContractAction, type TxExecutionResult } from '../tx.js';
import type { KeeperContext } from '../types.js';

async function emitLoanTokenAlertOnce(
  ctx: KeeperContext,
  type: 'FROZEN_SPLIT' | 'STALE_FEED',
  token: Address,
  loanId: bigint,
  message: string,
  details: Record<string, string | number | boolean | undefined>
): Promise<void> {
  const key = `${type}:${token.toLowerCase()}`;
  if (ctx.cycleAlertedKeys?.has(key)) return;
  ctx.cycleAlertedKeys?.add(key);
  await ctx.alerts.send(type, message, { ...details, loanId: loanId.toString() });
}

/**
 * Job 2: Loan Liquidation & Default Scanner
 * - Scans loans 1..nextLoanId - 1 with status Active (0) or Grace (1).
 * - If oracleState == VALID_OPEN and block.timestamp > maturity + 24h -> LoanCore.startDefaultAuction(loanId).
 * - Else if oracleState == VALID_OPEN and currentLtvBps >= liqLtvBps -> LoanCore.startLiquidation(loanId).
 */
export async function runLiquidationJob(ctx: KeeperContext): Promise<TxExecutionResult[]> {
  const { config, publicClient, walletClient, alerts } = ctx;
  const results: TxExecutionResult[] = [];

  const [nextLoanId, gracePeriodSecs, block] = await Promise.all([
    publicClient.readContract({
      address: config.loanCore,
      abi: loanCoreAbi,
      functionName: 'nextLoanId',
    }),
    publicClient.readContract({
      address: config.loanCore,
      abi: loanCoreAbi,
      functionName: 'GRACE_PERIOD_SECONDS',
    }),
    publicClient.getBlock(),
  ]);

  const nowTs = block.timestamp;
  const totalLoans = nextLoanId > 1n ? nextLoanId - 1n : 0n;
  console.log(`[LIQUIDATION] Scanning ${totalLoans} loan(s) at block timestamp ${nowTs}...`);

  for (let loanId = 1n; loanId < nextLoanId; loanId++) {
    const loan = await publicClient.readContract({
      address: config.loanCore,
      abi: loanCoreAbi,
      functionName: 'getLoan',
      args: [loanId],
    });

    if (loan.borrower === zeroAddress || loan.collateralToken === zeroAddress) {
      continue;
    }

    if (loan.status !== LoanStatus.Active && loan.status !== LoanStatus.Grace) {
      continue;
    }

    const token = loan.collateralToken;
    const [[price, , oracleState], [grossValueUsdc], dueInterest] = await Promise.all([
      publicClient.readContract({
        address: config.oracleRouter,
        abi: oracleRouterAbi,
        functionName: 'getPrice',
        args: [token],
      }),
      publicClient.readContract({
        address: config.oracleRouter,
        abi: oracleRouterAbi,
        functionName: 'getValue',
        args: [token, loan.collateralRaw],
      }),
      publicClient.readContract({
        address: config.loanCore,
        abi: loanCoreAbi,
        functionName: 'getDueInterest',
        args: [loanId],
      }),
    ]);

    const stateName = ORACLE_STATE_NAMES[oracleState] ?? `UNKNOWN(${oracleState})`;

    if (oracleState === OracleState.STALE_FEED) {
      await emitLoanTokenAlertOnce(
        ctx,
        'STALE_FEED',
        token,
        loanId,
        `Oracle STALE_FEED prevents liquidation check for loan #${loanId}`,
        { token, price: price.toString(), oracleState: stateName }
      );
    } else if (oracleState === OracleState.FROZEN_CORPORATE_ACTION) {
      await emitLoanTokenAlertOnce(
        ctx,
        'FROZEN_SPLIT',
        token,
        loanId,
        `Asset FROZEN_CORPORATE_ACTION prevents liquidation for loan #${loanId}`,
        { token, oracleState: stateName }
      );
    }

    const graceDeadline = BigInt(loan.maturity) + BigInt(gracePeriodSecs);
    const isPastGrace = nowTs > graceDeadline;

    const debtPrincipal = loan.principal - loan.principalRepaid;
    const currentDebt = debtPrincipal + dueInterest;
    const currentLtvBps =
      grossValueUsdc > 0n ? (currentDebt * 10_000n) / grossValueUsdc : 10_000n;

    if (isPastGrace) {
      if (oracleState !== OracleState.VALID_OPEN) {
        console.log(
          `[LIQUIDATION] Loan #${loanId} past maturity + 24h (deadline=${graceDeadline}, now=${nowTs}), waiting for VALID_OPEN (state=${stateName}).`
        );
        continue;
      }

      console.log(
        `[LIQUIDATION] Loan #${loanId} passed grace period (maturity=${loan.maturity}, now=${nowTs}). Starting default auction...`
      );
      const res = await executeContractAction({
        label: `LoanCore.startDefaultAuction(${loanId})`,
        address: config.loanCore,
        abi: loanCoreAbi,
        functionName: 'startDefaultAuction',
        args: [loanId],
        publicClient,
        walletClient,
        dryRun: config.dryRun,
        alerts,
      });
      results.push(res);
      continue;
    }

    if (currentLtvBps >= BigInt(loan.liqLtvBps)) {
      if (oracleState !== OracleState.VALID_OPEN) {
        console.log(
          `[LIQUIDATION] Loan #${loanId} LTV=${currentLtvBps} bps >= liqLtvBps=${loan.liqLtvBps} bps, but oracle is ${stateName} (requires VALID_OPEN).`
        );
        continue;
      }

      console.log(
        `[LIQUIDATION] Loan #${loanId} liquidatable: LTV=${currentLtvBps} bps >= liqLtvBps=${loan.liqLtvBps} bps (debt=${currentDebt}, colVal=${grossValueUsdc}). Starting liquidation...`
      );
      const res = await executeContractAction({
        label: `LoanCore.startLiquidation(${loanId})`,
        address: config.loanCore,
        abi: loanCoreAbi,
        functionName: 'startLiquidation',
        args: [loanId],
        publicClient,
        walletClient,
        dryRun: config.dryRun,
        alerts,
      });
      results.push(res);
    } else {
      console.log(
        `[LIQUIDATION] Loan #${loanId} healthy | LTV=${currentLtvBps} bps < liq=${loan.liqLtvBps} bps | oracle=${stateName}`
      );
    }
  }

  return results;
}
