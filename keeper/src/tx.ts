import {
  type Abi,
  type Account,
  type Address,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
  BaseError,
  WaitForTransactionReceiptTimeoutError,
  formatGwei,
} from 'viem';
import type { AlertManager } from './alerts.js';

export interface TxExecutionResult {
  action: string;
  simulated: boolean;
  executed: boolean;
  skippedDryRun: boolean;
  skippedGasCap?: boolean;
  skippedStuckNonce?: boolean;
  txHash?: Hash;
  replacedTxHash?: Hash;
  receipt?: TransactionReceipt;
  revertReason?: string;
}

export interface ExecuteTxParams<
  TAbi extends Abi,
  TFunctionName extends ContractFunctionName<TAbi, 'nonpayable' | 'payable'>,
> {
  label: string;
  address: Address;
  abi: TAbi;
  functionName: TFunctionName;
  args: ContractFunctionArgs<TAbi, 'nonpayable' | 'payable', TFunctionName>;
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
  dryRun: boolean;
  alerts: AlertManager;
  maxGasPriceWei?: bigint;
  txTimeoutMs?: number;
  txBumpBps?: number;
  alertOnSimRevert?: boolean;
  skipBecauseStuckNonce?: boolean;
}

export function extractErrorMessage(err: unknown): string {
  if (err instanceof BaseError) {
    return err.shortMessage || err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof WaitForTransactionReceiptTimeoutError) return true;
  if (err instanceof Error && err.name === 'WaitForTransactionReceiptTimeoutError') return true;
  return extractErrorMessage(err).toLowerCase().includes('timed out');
}

function bumpWei(base: bigint, bumpBps: number): bigint {
  return (base * BigInt(10_000 + bumpBps)) / 10_000n + 1_000_000n;
}

interface PendingNonceRecord {
  nonce: number;
  firstSeenMs: number;
  txHash?: Hash;
}

const stuckNonceTracker = new Map<string, PendingNonceRecord>();

export function recordStuckPendingNonce(keeperAddress: Address, nonce: number, txTimeoutMs: number, txHash?: Hash): void {
  stuckNonceTracker.set(keeperAddress.toLowerCase(), {
    nonce,
    firstSeenMs: Date.now() - txTimeoutMs - 1,
    txHash,
  });
}

export interface PendingNonceGuardResult {
  blocked: boolean;
  latestNonce: number;
  pendingNonce: number;
  ageMs?: number;
}

export async function checkPendingNonceGuard(
  publicClient: PublicClient<Transport, Chain>,
  keeperAddress: Address,
  txTimeoutMs: number,
  alerts?: AlertManager,
  emitAlert = true
): Promise<PendingNonceGuardResult> {
  const key = keeperAddress.toLowerCase();
  const [latestNonce, pendingNonce] = await Promise.all([
    publicClient.getTransactionCount({ address: keeperAddress, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: keeperAddress, blockTag: 'pending' }),
  ]);

  if (pendingNonce <= latestNonce) {
    stuckNonceTracker.delete(key);
    return { blocked: false, latestNonce, pendingNonce };
  }

  let existing = stuckNonceTracker.get(key);
  if (!existing || existing.nonce < latestNonce) {
    existing = { nonce: latestNonce, firstSeenMs: Date.now() };
    stuckNonceTracker.set(key, existing);
  }

  const ageMs = Date.now() - existing.firstSeenMs;
  if (ageMs >= txTimeoutMs) {
    console.warn(
      `[STUCK_NONCE_GUARD] Skipping new tx for ${keeperAddress}: pending nonce ${latestNonce}..${pendingNonce - 1} unconfirmed for ${ageMs}ms (>= ${txTimeoutMs}ms)`
    );
    if (emitAlert && alerts) {
      await alerts.send(
        'STUCK_TX',
        `Keeper has pending nonce ${latestNonce} unconfirmed for ${ageMs}ms; skipping new transactions`,
        {
          keeperAddress,
          latestNonce,
          pendingNonce,
          ageMs,
          txTimeoutMs,
          txHash: existing.txHash,
        }
      );
    }
    return { blocked: true, latestNonce, pendingNonce, ageMs };
  }

  return { blocked: false, latestNonce, pendingNonce, ageMs };
}

/**
 * Guards against stuck pending nonces and excessive gas prices, simulates via eth_call,
 * skips in DRY_RUN=true, and handles stuck transactions via timeout + fee-bumped replacement or alert.
 */
export async function executeContractAction<
  TAbi extends Abi,
  TFunctionName extends ContractFunctionName<TAbi, 'nonpayable' | 'payable'>,
>(params: ExecuteTxParams<TAbi, TFunctionName>): Promise<TxExecutionResult> {
  const {
    label,
    address,
    abi,
    functionName,
    args,
    publicClient,
    walletClient,
    dryRun,
    alerts,
    maxGasPriceWei,
    txTimeoutMs = 30_000,
    txBumpBps = 2000,
    alertOnSimRevert = true,
    skipBecauseStuckNonce = false,
  } = params;

  if (!dryRun) {
    if (skipBecauseStuckNonce) {
      return {
        action: label,
        simulated: false,
        executed: false,
        skippedDryRun: false,
        skippedStuckNonce: true,
        revertReason: 'Skipped due to stuck pending nonce detected in pre-flight check',
      };
    }

    try {
      const nonceGuard = await checkPendingNonceGuard(
        publicClient,
        walletClient.account.address,
        txTimeoutMs,
        alerts,
        true
      );
      if (nonceGuard.blocked) {
        return {
          action: label,
          simulated: false,
          executed: false,
          skippedDryRun: false,
          skippedStuckNonce: true,
          revertReason: `Pending nonce ${nonceGuard.latestNonce} stuck for ${nonceGuard.ageMs}ms (>= ${txTimeoutMs}ms)`,
        };
      }
    } catch (err) {
      const reason = extractErrorMessage(err);
      await alerts.send('RPC_ERROR', `Failed to check pending nonce guard before ${label}`, {
        target: address,
        functionName: String(functionName),
        reason,
      });
      return {
        action: label,
        simulated: false,
        executed: false,
        skippedDryRun: false,
        revertReason: reason,
      };
    }
  }

  let currentGasPrice: bigint;
  try {
    currentGasPrice = await publicClient.getGasPrice();
  } catch (err) {
    const reason = extractErrorMessage(err);
    await alerts.send('RPC_ERROR', `Failed to read gas price before ${label}`, {
      target: address,
      functionName: String(functionName),
      reason,
    });
    return {
      action: label,
      simulated: false,
      executed: false,
      skippedDryRun: false,
      revertReason: reason,
    };
  }

  if (maxGasPriceWei !== undefined && currentGasPrice > maxGasPriceWei) {
    const gasGwei = formatGwei(currentGasPrice);
    const maxGwei = formatGwei(maxGasPriceWei);
    console.warn(`[GAS_CAP] Skipping ${label}: gasPrice=${gasGwei} gwei > MAX_GAS_PRICE_GWEI=${maxGwei} gwei`);
    await alerts.send('HIGH_GAS_PRICE', `Skipped ${label}: gas price ${gasGwei} gwei exceeds cap ${maxGwei} gwei`, {
      label,
      target: address,
      gasPriceGwei: gasGwei,
      maxGasPriceGwei: maxGwei,
    });
    return {
      action: label,
      simulated: false,
      executed: false,
      skippedDryRun: false,
      skippedGasCap: true,
      revertReason: `Gas price ${gasGwei} gwei exceeds cap ${maxGwei} gwei`,
    };
  }

  let simRequest: Record<string, unknown>;
  try {
    const simResult = await publicClient.simulateContract({
      address,
      abi: abi as Abi,
      functionName: functionName as string,
      args: args as readonly unknown[],
      account: walletClient.account,
    });
    simRequest = simResult.request as unknown as Record<string, unknown>;
  } catch (err) {
    const reason = extractErrorMessage(err);
    console.warn(`[SIM_REVERT] Skipping ${label}: ${reason}`);
    if (alertOnSimRevert) {
      await alerts.send('FAILED_TX', `Simulation reverted for ${label}`, {
        target: address,
        functionName: String(functionName),
        reason,
      });
    }
    return {
      action: label,
      simulated: false,
      executed: false,
      skippedDryRun: false,
      revertReason: reason,
    };
  }

  if (dryRun) {
    console.log(`[DRY_RUN] Simulated ${label} successfully (no transaction sent)`);
    return {
      action: label,
      simulated: true,
      executed: false,
      skippedDryRun: true,
    };
  }

  let initialHash: Hash | undefined;
  let nonce: number;
  try {
    nonce = await publicClient.getTransactionCount({
      address: walletClient.account.address,
      blockTag: 'pending',
    });

    initialHash = await walletClient.writeContract({
      ...simRequest,
      nonce,
    } as Parameters<typeof walletClient.writeContract>[0]);

    const pollMs = Math.min(1_000, Math.max(50, Math.floor(txTimeoutMs / 4)));
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: initialHash,
      timeout: txTimeoutMs,
      pollingInterval: pollMs,
    });

    if (receipt.status !== 'success') {
      await alerts.send('FAILED_TX', `Transaction reverted onchain for ${label}`, {
        target: address,
        functionName: String(functionName),
        txHash: initialHash,
      });
      return {
        action: label,
        simulated: true,
        executed: false,
        skippedDryRun: false,
        txHash: initialHash,
        receipt,
        revertReason: 'Onchain receipt status reverted',
      };
    }

    stuckNonceTracker.delete(walletClient.account.address.toLowerCase());
    console.log(`[TX_CONFIRMED] ${label} | tx=${initialHash} | block=${receipt.blockNumber}`);
    return {
      action: label,
      simulated: true,
      executed: true,
      skippedDryRun: false,
      txHash: initialHash,
      receipt,
    };
  } catch (err) {
    if (!initialHash || !isTimeoutError(err)) {
      const reason = extractErrorMessage(err);
      await alerts.send('FAILED_TX', `Failed to send transaction for ${label}`, {
        target: address,
        functionName: String(functionName),
        txHash: initialHash,
        reason,
      });
      return {
        action: label,
        simulated: true,
        executed: false,
        skippedDryRun: false,
        txHash: initialHash,
        revertReason: reason,
      };
    }

    // Handle stuck transaction: timeout reached, attempt fee-bumped replacement
    console.warn(
      `[STUCK_TX] ${label} tx=${initialHash} pending > ${txTimeoutMs}ms (nonce=${nonce!}). Attempting replacement...`
    );

    const pendingTx = await publicClient.getTransaction({ hash: initialHash }).catch(() => null);
    const feeOverrides: Record<string, bigint> = {};
    let candidateCapWei: bigint;

    if (pendingTx?.maxFeePerGas !== undefined) {
      const bumpedMaxFee = bumpWei(pendingTx.maxFeePerGas, txBumpBps);
      const basePrio = pendingTx.maxPriorityFeePerGas ?? 1_000_000n;
      const bumpedPrio = bumpWei(basePrio, txBumpBps);
      feeOverrides.maxFeePerGas = bumpedMaxFee;
      feeOverrides.maxPriorityFeePerGas = bumpedPrio > bumpedMaxFee ? bumpedMaxFee : bumpedPrio;
      candidateCapWei = bumpedMaxFee;
    } else {
      const baseGas = pendingTx?.gasPrice ?? currentGasPrice;
      const bumpedGas = bumpWei(baseGas, txBumpBps);
      feeOverrides.gasPrice = bumpedGas;
      candidateCapWei = bumpedGas;
    }

    if (maxGasPriceWei !== undefined && candidateCapWei > maxGasPriceWei) {
      recordStuckPendingNonce(walletClient.account.address, nonce!, txTimeoutMs, initialHash);
      const candidateGwei = formatGwei(candidateCapWei);
      const capGwei = formatGwei(maxGasPriceWei);
      await alerts.send(
        'STUCK_TX',
        `Stuck tx ${initialHash} for ${label} timed out after ${txTimeoutMs}ms; replacement fee (${candidateGwei} gwei) exceeds MAX_GAS_PRICE_GWEI (${capGwei} gwei)`,
        {
          label,
          txHash: initialHash,
          nonce: nonce!,
          replacementFeeGwei: candidateGwei,
          maxGasPriceGwei: capGwei,
        }
      );
      return {
        action: label,
        simulated: true,
        executed: false,
        skippedDryRun: false,
        txHash: initialHash,
        revertReason: 'Stuck transaction timed out and replacement exceeded MAX_GAS_PRICE_GWEI',
      };
    }

    try {
      const repHash = await walletClient.writeContract({
        ...simRequest,
        nonce: nonce!,
        ...(pendingTx?.gas ? { gas: pendingTx.gas } : {}),
        ...feeOverrides,
      } as Parameters<typeof walletClient.writeContract>[0]);

      const pollMs = Math.min(1_000, Math.max(50, Math.floor(txTimeoutMs / 4)));
      const repReceipt = await publicClient.waitForTransactionReceipt({
        hash: repHash,
        timeout: txTimeoutMs,
        pollingInterval: pollMs,
      });

      await alerts.send('STUCK_TX', `Replaced stuck tx for ${label} with higher fee`, {
        label,
        replacedTxHash: initialHash,
        txHash: repHash,
        nonce: nonce!,
        status: repReceipt.status,
      });

      if (repReceipt.status !== 'success') {
        return {
          action: label,
          simulated: true,
          executed: false,
          skippedDryRun: false,
          txHash: repHash,
          replacedTxHash: initialHash,
          receipt: repReceipt,
          revertReason: 'Replacement transaction reverted onchain',
        };
      }

      stuckNonceTracker.delete(walletClient.account.address.toLowerCase());
      console.log(
        `[TX_REPLACED] ${label} | old=${initialHash} | new=${repHash} | block=${repReceipt.blockNumber}`
      );
      return {
        action: label,
        simulated: true,
        executed: true,
        skippedDryRun: false,
        txHash: repHash,
        replacedTxHash: initialHash,
        receipt: repReceipt,
      };
    } catch (repErr) {
      // Check if original tx actually mined right before replacement landed
      const initialMined = await publicClient.getTransactionReceipt({ hash: initialHash }).catch(() => null);
      if (initialMined) {
        stuckNonceTracker.delete(walletClient.account.address.toLowerCase());
        console.log(
          `[TX_CONFIRMED] ${label} original tx confirmed before replacement | tx=${initialHash} | block=${initialMined.blockNumber}`
        );
        return {
          action: label,
          simulated: true,
          executed: initialMined.status === 'success',
          skippedDryRun: false,
          txHash: initialHash,
          receipt: initialMined,
        };
      }

      recordStuckPendingNonce(walletClient.account.address, nonce!, txTimeoutMs, initialHash);
      const reason = extractErrorMessage(repErr);
      await alerts.send('STUCK_TX', `Stuck tx replacement failed or timed out for ${label}`, {
        label,
        txHash: initialHash,
        nonce: nonce!,
        reason,
      });
      return {
        action: label,
        simulated: true,
        executed: false,
        skippedDryRun: false,
        txHash: initialHash,
        revertReason: reason,
      };
    }
  }
}
