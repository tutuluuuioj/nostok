import type { Account, Chain, PublicClient, Transport, WalletClient } from 'viem';
import type { AlertManager, KeeperAlert } from './alerts.js';
import type { KeeperConfig } from './config.js';
import type { TxExecutionResult } from './tx.js';

export interface KeeperContext {
  config: KeeperConfig;
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
  alerts: AlertManager;
  /** Tracks alerted tokens within a single polling cycle to prevent duplicate alerts */
  cycleAlertedKeys?: Set<string>;
  /** True when cycle pre-flight detected a stuck pending nonce older than txTimeoutMs */
  skipTxBecauseStuckNonce?: boolean;
}

export interface KeeperCycleSummary {
  timestamp: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  keeperAddress: string;
  keeperEthBalanceWei: bigint;
  syncMultiplierResults: TxExecutionResult[];
  liquidationResults: TxExecutionResult[];
  expiredAuctionResults: TxExecutionResult[];
  alertsEmitted: KeeperAlert[];
}
