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
} from 'viem';
import type { AlertManager } from './alerts.js';

export interface TxExecutionResult {
  action: string;
  simulated: boolean;
  executed: boolean;
  skippedDryRun: boolean;
  txHash?: Hash;
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
  alertOnSimRevert?: boolean;
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

/**
 * Simulates a contract call via eth_call before attempting to broadcast.
 * Skips broadcasting if simulation reverts or if DRY_RUN=true.
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
    alertOnSimRevert = true,
  } = params;

  let simRequest: unknown;
  try {
    const simResult = await publicClient.simulateContract({
      address,
      abi: abi as Abi,
      functionName: functionName as string,
      args: args as readonly unknown[],
      account: walletClient.account,
    });
    simRequest = simResult.request;
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

  try {
    const hash = await walletClient.writeContract(simRequest as Parameters<typeof walletClient.writeContract>[0]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status !== 'success') {
      await alerts.send('FAILED_TX', `Transaction reverted onchain for ${label}`, {
        target: address,
        functionName: String(functionName),
        txHash: hash,
      });
      return {
        action: label,
        simulated: true,
        executed: false,
        skippedDryRun: false,
        txHash: hash,
        receipt,
        revertReason: 'Onchain receipt status reverted',
      };
    }

    console.log(`[TX_CONFIRMED] ${label} | tx=${hash} | block=${receipt.blockNumber}`);
    return {
      action: label,
      simulated: true,
      executed: true,
      skippedDryRun: false,
      txHash: hash,
      receipt,
    };
  } catch (err) {
    const reason = extractErrorMessage(err);
    await alerts.send('FAILED_TX', `Failed to send transaction for ${label}`, {
      target: address,
      functionName: String(functionName),
      reason,
    });
    return {
      action: label,
      simulated: true,
      executed: false,
      skippedDryRun: false,
      revertReason: reason,
    };
  }
}
