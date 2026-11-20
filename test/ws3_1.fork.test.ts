/// <reference path="./ambient.d.ts" />
import assert from 'node:assert/strict';
import { execSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ReactNamespace from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

if (!(globalThis as { React?: unknown }).React) {
  (globalThis as { React?: unknown }).React = ReactNamespace;
}
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http as viemHttp,
  keccak256,
  parseAbi,
  stringToBytes,
  zeroAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { loadApiConfig } from '../api/src/config.js';
import { wrapQueryableAsReadOnly as wrapApiReadOnly } from '../api/src/db.js';
import { createApiContext, createApiServer } from '../api/src/server.js';
import { loadConfig as loadIndexerConfig } from '../indexer/src/config.js';
import { createIndexerContext, runIndexerSync } from '../indexer/src/indexer.js';
import { loadNotificationsConfig } from '../notifications/src/config.js';
import { wrapIndexerQueryableAsReadOnly } from '../notifications/src/db.js';
import { createNotificationsContext } from '../notifications/src/engine.js';
import { createNotificationsServer } from '../notifications/src/server.js';
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  ELIGIBILITY_DECLARATION_DOMAIN_NAME,
  ELIGIBILITY_DECLARATION_STATEMENT_HASH,
  EXTEND_ORDER_EIP712_TYPES,
  LEND_OFFER_EIP712_TYPES,
  LOAN_CORE_DOMAIN_NAME,
  LOAN_CORE_DOMAIN_VERSION,
  MAX_DECLARATION_TTL_SECS,
  ORDER_SETTLEMENT_DOMAIN_NAME,
  ORDER_SETTLEMENT_DOMAIN_VERSION,
  USDC_DECIMALS,
  eligibilityGateAbi,
  erc20Abi,
  getFrontendConfig,
  loanCoreAbi,
  orderSettlementAbi,
  positionNftAbi,
  setFrontendConfigOverrides,
} from '../src/lib/contracts.js';
import {
  buildDataMetricRows,
  buildOnChainEnvironmentRows,
  evaluateAssetOriginationStatus,
  fetchLiveProtocolContractState,
  fetchLoanQuote,
  fetchMarketSnapshot,
  fetchMarketsAndLiveContracts,
  formatApiAmount,
  formatAssetOraclePrice,
  formatBpsPercent,
  formatOracleUnitValue,
  reconcileLiveAssetsWithApi,
} from '../src/lib/marketsApi.js';
import {
  DEFAULT_COLLATERAL_BUFFER_BPS,
  DEFAULT_EXTEND_DEADLINE_SECS,
  MAX_EXTEND_DEADLINE_SECS,
  SIGNED_BORROW_ORDERS_STORAGE_KEY,
  SIGNED_LEND_OFFERS_STORAGE_KEY,
  approveUsdcForLend,
  bumpMakerNonceOnChain,
  cancelSignedBorrowOrder,
  cancelSignedLendOffer,
  classifyPersistedOrderRemoval,
  computeBorrowApprovalAmountRaw,
  computeBorrowCollateralForFill,
  computeLendApprovalAmountRaw,
  computeRemainingBorrowCollateralRequirement,
  connectWallet,
  decodeContractRevert,
  fetchNotificationsSessionState,
  fetchPaginatedApiRows,
  fetchRelayOrderByHash,
  fetchWalletState,
  fillBorrowOrderAsLender,
  fillLendOfferAsBorrower,
  formatTokenUnitsDisplay,
  formatWeb3Error,
  isNonFinalOrderStatus,
  loadPersistedSignedLendOffers,
  loadPersistedSignedOrders,
  parseBorrowOrderFromJson,
  parseExtendPayloadFromJson,
  parseLendOfferFromJson,
  prepareAndSignBorrowOrder,
  prepareAndSignLendOffer,
  readBorrowAllowanceAndNonce,
  readLendAllowanceAndNonce,
  refreshSignedBorrowOrdersState,
  refreshSignedLendOffersState,
  removeSignedBorrowOrder,
  removeSignedLendOffer,
  resolveExactBorrowAmounts,
  resolveExactLendAmounts,
  resolveOpenBorrowOrdersCollateralSumRaw,
  resolveOpenLendOffersSumRaw,
  setCollateralAllowanceForBorrow,
  setInjectedProvider,
  setUsdcAllowanceForLend,
  buildExtendOrderTypedData,
  computeExactPartialRepayAmounts,
  computeExactRepayAmounts,
  computeExactTopUpAmounts,
  computeLoanProjectedInterestDueRaw,
  executeLoanExtend,
  executeLoanRepay,
  executeLoanTopUp,
  executeLoanClaim,
  fetchWalletPositionsAndClaimable,
  readLoanOnChainState,
  signInWithSiwe,
  signLoanExtension,
  signOutSiwe,
  sumRawBigints,
  validateLendPartialFillPlan,
  bumpEligibilityNonce,
  computeEligibilityAttestationDigest,
  decodeEligibilityAttestation,
  encodeEligibilityAttestation,
  fetchEligibilityScreening,
  readEligibilityStatus,
  signEligibilityDeclaration,
  submitEligibilityDeclaration,
  verifyAndPreviewBorrowOrderFill,
  verifyAndPreviewLendOfferFill,
  verifyAndPreviewLoanExtend,
  verifyAndPreviewLoanRepay,
  verifyAndPreviewLoanTopUp,
  verifyEligibilityDeclaration,
} from '../src/lib/web3.js';
import { App, Frame, isSafetyOrExitRoute, normalizeRoutePath } from '../src/App.jsx';
import { Gate, GateChecking, Restricted } from '../src/components/Gate.jsx';
import { Shell } from '../src/components/Shell.jsx';
import { ErrorBoundary } from '../src/components/ui.jsx';
import { Alerts } from '../src/pages/Alerts.jsx';
import { Borrow } from '../src/pages/Borrow.jsx';
import { Builders } from '../src/pages/Builders.jsx';
import { Data } from '../src/pages/Data.jsx';
import { Lend } from '../src/pages/Lend.jsx';
import { Loan } from '../src/pages/Loan.jsx';
import { Loans } from '../src/pages/Loans.jsx';
import { Markets } from '../src/pages/Markets.jsx';
import { Positions } from '../src/pages/Positions.jsx';
import { Risk } from '../src/pages/Risk.jsx';
import { SubscriptionAction } from '../src/pages/SubscriptionAction.jsx';
import { Wallet } from '../src/pages/Wallet.jsx';
import {
  StoreProvider,
  createWalletEventsHandler,
  evaluateEligibilityDeclaration,
  isHardRestrictionScreening,
  loadPersistedDeclaration,
  savePersistedDeclaration,
  verifyStoredDeclarationOnServer,
} from '../src/store.jsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'contracts');
const FOUNDRY_BIN_DIR = process.env.FOUNDRY_BIN_DIR ?? `${process.env.HOME}/.foundry/bin`;
const ANVIL_PORT = Number(process.env.TEST_WS3_1_ANVIL_PORT ?? 18550);
const LOCAL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_USDC_WHALE: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';

const KEYS = {
  deployer: generatePrivateKey(),
  owner: generatePrivateKey(),
  borrower: generatePrivateKey(),
  lender: generatePrivateKey(),
  guardian: generatePrivateKey(),
  treasury: generatePrivateKey(),
  reserve: generatePrivateKey(),
  attestationSigner: generatePrivateKey(),
  outsider: generatePrivateKey(),
};

const ADDRESSES = {
  deployer: privateKeyToAccount(KEYS.deployer).address,
  owner: privateKeyToAccount(KEYS.owner).address,
  borrower: privateKeyToAccount(KEYS.borrower).address,
  lender: privateKeyToAccount(KEYS.lender).address,
  guardian: privateKeyToAccount(KEYS.guardian).address,
  treasury: privateKeyToAccount(KEYS.treasury).address,
  reserve: privateKeyToAccount(KEYS.reserve).address,
  attestationSigner: privateKeyToAccount(KEYS.attestationSigner).address,
  outsider: privateKeyToAccount(KEYS.outsider).address,
};

function getShellEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${FOUNDRY_BIN_DIR}:${process.env.PATH ?? ''}`,
  };
}

async function waitForRpcReady(rpcUrl: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) {
        const json = (await res.json()) as { result?: string };
        if (json.result) return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for Anvil at ${rpcUrl}`);
}

async function startAnvilFork(): Promise<ChildProcess> {
  const candidates = process.env.FORK_RPC_URL
    ? [process.env.FORK_RPC_URL]
    : ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];

  for (const forkUrl of candidates) {
    console.log(`[WS3.1_TEST] Starting Anvil fork against ${forkUrl} on port ${ANVIL_PORT}...`);
    const proc = spawn(
      `${FOUNDRY_BIN_DIR}/anvil`,
      ['--fork-url', forkUrl, '--port', String(ANVIL_PORT), '--chain-id', '8453', '--silent'],
      { env: getShellEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await waitForRpcReady(LOCAL_RPC_URL, 25_000);
      console.log('[WS3.1_TEST] Anvil Base Mainnet fork ready (chainId=8453)');
      return proc;
    } catch (err) {
      proc.kill('SIGKILL');
      console.warn(`[WS3.1_TEST] Fork RPC ${forkUrl} failed: ${(err as Error).message}`);
    }
  }
  throw new Error('Unable to start Anvil fork against any Base Mainnet RPC');
}

async function rpcCall<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(LOCAL_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method} failed: ${json.error.message}`);
  return json.result as T;
}

function loadFoundryArtifact(relPath: string): { abi: readonly unknown[]; bytecode: Hex } {
  const fullPath = path.join(CONTRACTS_DIR, 'out', relPath);
  const json = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as {
    abi: readonly unknown[];
    bytecode: { object: Hex };
  };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

function parseAddressLine(stdout: string, label: string): Address {
  const m = stdout.match(new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`));
  if (!m) throw new Error(`Failed to parse "${label}" from DeployNostok.s.sol output`);
  return getAddress(m[1]);
}

function deployProtocolWithForge() {
  console.log('[WS3.1_TEST] Running DeployNostok.s.sol on local Base Mainnet fork...');
  const stdout = execSync(
    `forge script script/DeployNostok.s.sol --rpc-url ${LOCAL_RPC_URL} --broadcast`,
    {
      cwd: CONTRACTS_DIR,
      env: {
        ...getShellEnv(),
        DEPLOYER_PRIVATE_KEY: KEYS.deployer,
        OWNER_ADDRESS: ADDRESSES.owner,
        GUARDIAN_ADDRESS: ADDRESSES.guardian,
        TREASURY_ADDRESS: ADDRESSES.treasury,
        RESERVE_ADDRESS: ADDRESSES.reserve,
        ATTESTATION_SIGNER: ADDRESSES.attestationSigner,
      },
      encoding: 'utf8',
    }
  );
  return {
    eligibilityGate: parseAddressLine(stdout, 'EligibilityGate deployed at:'),
    collateralEscrow: parseAddressLine(stdout, 'CollateralEscrow deployed at:'),
    positionNFT: parseAddressLine(stdout, 'PositionNFT deployed at:'),
    assetRegistry: parseAddressLine(stdout, 'AssetRegistry proxy at:'),
    oracleRouter: parseAddressLine(stdout, 'OracleRouter proxy at:'),
    feeCollector: parseAddressLine(stdout, 'FeeCollector proxy at:'),
    loanCore: parseAddressLine(stdout, 'LoanCore proxy at:'),
    liquidationAuction: parseAddressLine(stdout, 'LiquidationAuction proxy at:'),
    orderSettlement: parseAddressLine(stdout, 'OrderSettlement proxy at:'),
    nostokTimelock: parseAddressLine(stdout, 'NostokTimelock deployed at:'),
  };
}

function createMockEip1193Provider(initialAccountKey: Hex, initialChainId = 8453, rpcUrl = LOCAL_RPC_URL) {
  let account = privateKeyToAccount(initialAccountKey);
  let chainId = initialChainId;
  let rejectSwitch = false;
  let midSignNextKey: Hex | null = null;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    setRejectSwitch(v: boolean) {
      rejectSwitch = v;
    },
    setMidSignAccountSwitch(nextKey: Hex | null) {
      midSignNextKey = nextKey;
    },
    setChainId(nextId: number) {
      chainId = nextId;
      for (const fn of listeners.get('chainChanged') ?? []) {
        fn(`0x${nextId.toString(16)}`);
      }
    },
    setAccount(nextKey: Hex) {
      account = privateKeyToAccount(nextKey);
      for (const fn of listeners.get('accountsChanged') ?? []) {
        fn([account.address]);
      }
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    removeListener(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    async request({ method, params = [] }: { method: string; params?: unknown[] }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        return [account.address];
      }
      if (method === 'eth_chainId') {
        return `0x${chainId.toString(16)}`;
      }
      if (method === 'wallet_switchEthereumChain') {
        if (rejectSwitch) {
          throw Object.assign(new Error('User rejected network switch'), { code: 4001 });
        }
        const target = (params[0] as { chainId: string }).chainId;
        chainId = Number.parseInt(target, 16);
        return null;
      }
      if (method === 'personal_sign') {
        const msgHex = params[0] as Hex;
        const sig = await account.signMessage({ message: { raw: msgHex } });
        if (midSignNextKey) {
          account = privateKeyToAccount(midSignNextKey);
          midSignNextKey = null;
        }
        return sig;
      }
      if (method === 'eth_signTypedData_v4') {
        const expectedSigner = getAddress(String(params[0]));
        if (expectedSigner.toLowerCase() !== account.address.toLowerCase()) {
          throw new Error(`Signer mismatch: requested ${expectedSigner}, active ${account.address}`);
        }
        const payload = JSON.parse(String(params[1])) as {
          types: Record<string, Array<{ name: string; type: string }>>;
          domain: Record<string, unknown>;
          primaryType: string;
          message: Record<string, unknown>;
        };
        const { EIP712Domain: _omitDomain, ...signTypes } = payload.types;
        const primaryFields = signTypes[payload.primaryType] ?? [];
        const normalizedMsg: Record<string, unknown> = { ...payload.message };
        for (const field of primaryFields) {
          if (
            (field.type.startsWith('uint') || field.type.startsWith('int')) &&
            normalizedMsg[field.name] !== undefined &&
            normalizedMsg[field.name] !== null
          ) {
            normalizedMsg[field.name] = BigInt(String(normalizedMsg[field.name]));
          }
        }
        const sig = await account.signTypedData({
          domain: {
            ...payload.domain,
            chainId: payload.domain.chainId !== undefined ? Number(payload.domain.chainId) : undefined,
          } as Parameters<typeof account.signTypedData>[0]['domain'],
          types: signTypes,
          primaryType: payload.primaryType,
          message: normalizedMsg,
        });
        if (midSignNextKey) {
          account = privateKeyToAccount(midSignNextKey);
          midSignNextKey = null;
        }
        return sig;
      }
      if (method === 'eth_sendTransaction') {
        const tx = params[0] as { from?: Address; to: Address; data?: Hex; value?: Hex };
        if (tx.from && getAddress(tx.from).toLowerCase() !== account.address.toLowerCase()) {
          throw new Error(`Transaction from mismatch: ${tx.from} != ${account.address}`);
        }
        const wc = createWalletClient({
          account,
          chain: defineChain({
            ...base,
            id: chainId,
            name: 'Base',
            rpcUrls: { default: { http: [rpcUrl] } },
          }),
          transport: viemHttp(rpcUrl),
        });
        return wc.sendTransaction({
          account,
          to: getAddress(tx.to),
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : 0n,
        });
      }
      throw new Error(`Unsupported mock EIP-1193 method: ${method}`);
    },
  };
}

async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      srv.close((err) => (err ? reject(err) : resolve((a as net.AddressInfo).port)));
    });
    srv.on('error', reject);
  });
}

async function runTests(): Promise<void> {
  const anvilProc = await startAnvilFork();
  try {
    const forkChain = defineChain({
      id: BASE_CHAIN_ID,
      name: 'Base Fork',
      nativeCurrency: base.nativeCurrency,
      contracts: base.contracts,
      rpcUrls: { default: { http: [LOCAL_RPC_URL] } },
    });

    const publicClient = createPublicClient({
      chain: forkChain,
      transport: viemHttp(LOCAL_RPC_URL),
      cacheTime: 0,
    });
    const deployerClient = createWalletClient({
      account: privateKeyToAccount(KEYS.deployer),
      chain: forkChain,
      transport: viemHttp(LOCAL_RPC_URL),
    });
    const ownerClient = createWalletClient({
      account: privateKeyToAccount(KEYS.owner),
      chain: forkChain,
      transport: viemHttp(LOCAL_RPC_URL),
    });
    const borrowerAccount = privateKeyToAccount(KEYS.borrower);
    const lenderAccount = privateKeyToAccount(KEYS.lender);
    const attSignerAccount = privateKeyToAccount(KEYS.attestationSigner);
    const borrowerClient = createWalletClient({
      account: borrowerAccount,
      chain: forkChain,
      transport: viemHttp(LOCAL_RPC_URL),
    });
    const lenderClient = createWalletClient({
      account: lenderAccount,
      chain: forkChain,
      transport: viemHttp(LOCAL_RPC_URL),
    });
    const rawWalletClient = createWalletClient({ chain: forkChain, transport: viemHttp(LOCAL_RPC_URL) });

    for (const addr of Object.values(ADDRESSES)) {
      await rpcCall('anvil_setBalance', [addr, '0x56bc75e2d63100000']);
    }
    await rpcCall('anvil_setCode', [ADDRESSES.guardian, '0x600160005500']);

    const deployed = deployProtocolWithForge();
    const startBlock = await publicClient.getBlockNumber();

    const mockB20Artifact = loadFoundryArtifact('MockB20Token.sol/MockB20Token.json');
    const mockAggArtifact = loadFoundryArtifact('MockAggregator.sol/MockAggregator.json');
    const initialMult = 1000537939576369481n;

    const nvdacReceipt = await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.deployContract({
        abi: mockB20Artifact.abi,
        bytecode: mockB20Artifact.bytecode,
        args: ['Coinbase Wrapped NVDA', 'NVDAc', 18, initialMult],
      }),
    });
    const nvdac = getAddress(nvdacReceipt.contractAddress!);

    const nvdaFeedReceipt = await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.deployContract({
        abi: mockAggArtifact.abi,
        bytecode: mockAggArtifact.bytecode,
        args: [8, 140_00000000n],
      }),
    });
    const nvdaFeed = getAddress(nvdaFeedReceipt.contractAddress!);

    await rpcCall('anvil_impersonateAccount', [deployed.nostokTimelock]);
    await rpcCall('anvil_setBalance', [deployed.nostokTimelock, '0x56bc75e2d63100000']);
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: deployed.nostokTimelock,
        to: deployed.oracleRouter,
        data: encodeFunctionData({
          abi: parseAbi(['function setMarketSession(bool isOpen, bool isManual)']),
          functionName: 'setMarketSession',
          args: [true, true],
        }),
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: deployed.nostokTimelock,
        to: deployed.loanCore,
        data: encodeFunctionData({
          abi: parseAbi(['function setGlobalCap(uint128 newCap)']),
          functionName: 'setGlobalCap',
          args: [10_000_000_000n],
        }),
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: deployed.nostokTimelock,
        to: deployed.assetRegistry,
        data: encodeFunctionData({
          abi: [
            {
              type: 'function',
              name: 'setAssetConfig',
              stateMutability: 'nonpayable',
              inputs: [
                { name: 'token', type: 'address' },
                {
                  name: 'config',
                  type: 'tuple',
                  components: [
                    { name: 'feed', type: 'address' },
                    { name: 'feedDecimals', type: 'uint8' },
                    { name: 'tier', type: 'uint8' },
                    { name: 'maxInitLtvBps', type: 'uint16' },
                    { name: 'marginCallLtvBps', type: 'uint16' },
                    { name: 'liqLtvBps', type: 'uint16' },
                    { name: 'badDebtLtvBps', type: 'uint16' },
                    { name: 'maxDiscountBps', type: 'uint16' },
                    { name: 'closedMarketHaircutBps', type: 'uint16' },
                    { name: 'perLoanCap', type: 'uint128' },
                    { name: 'assetCap', type: 'uint128' },
                    { name: 'maxStaleOpenSecs', type: 'uint32' },
                    { name: 'status', type: 'uint8' },
                    { name: 'restricted', type: 'bool' },
                  ],
                },
              ],
              outputs: [],
            },
          ],
          functionName: 'setAssetConfig',
          args: [
            nvdac,
            {
              feed: nvdaFeed,
              feedDecimals: 8,
              tier: 0,
              maxInitLtvBps: 6000,
              marginCallLtvBps: 7000,
              liqLtvBps: 7800,
              badDebtLtvBps: 9000,
              maxDiscountBps: 600,
              closedMarketHaircutBps: 500,
              perLoanCap: 3_000_000_000n,
              assetCap: 8_000_000_000n,
              maxStaleOpenSecs: 21600,
              status: 0,
              restricted: false,
            },
          ],
        }),
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.writeContract({
        address: deployed.oracleRouter,
        abi: parseAbi(['function syncMultiplier(address asset)']),
        functionName: 'syncMultiplier',
        args: [nvdac],
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await ownerClient.writeContract({
        address: deployed.eligibilityGate,
        abi: parseAbi(['function setAllowlistBatch(address[] accounts, bool isAllowed)']),
        functionName: 'setAllowlistBatch',
        args: [[ADDRESSES.borrower, ADDRESSES.lender], true],
      }),
    });

    // Fund borrower with 25 NVDAc (18 decimals) & USDC (6 decimals), lender with USDC
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.writeContract({
        address: nvdac,
        abi: mockB20Artifact.abi,
        functionName: 'mint',
        args: [ADDRESSES.borrower, 25n * 10n ** 18n],
      }),
    });
    await rpcCall('anvil_impersonateAccount', [BASE_USDC_WHALE]);
    await rpcCall('anvil_setBalance', [BASE_USDC_WHALE, '0x56bc75e2d63100000']);
    for (const [to, amt] of [
      [ADDRESSES.borrower, 2_000_000_000n],
      [ADDRESSES.lender, 5_000_000_000n],
    ] as const) {
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: BASE_USDC_WHALE,
          to: BASE_USDC,
          data: encodeFunctionData({
            abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']),
            functionName: 'transfer',
            args: [to, amt],
          }),
        }),
      });
    }

    // Approve & open 2 loans (repay Loan #2 so lender has claimable USDC on LoanCore & borrower has 1 open loan)
    const approveAbi = parseAbi(['function approve(address spender, uint256 value) returns (bool)']);
    await publicClient.waitForTransactionReceipt({
      hash: await borrowerClient.writeContract({
        address: nvdac,
        abi: approveAbi,
        functionName: 'approve',
        args: [deployed.collateralEscrow, 100n * 10n ** 18n],
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await borrowerClient.writeContract({
        address: BASE_USDC,
        abi: approveAbi,
        functionName: 'approve',
        args: [deployed.loanCore, 10_000_000_000n],
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await lenderClient.writeContract({
        address: BASE_USDC,
        abi: approveAbi,
        functionName: 'approve',
        args: [deployed.loanCore, 10_000_000_000n],
      }),
    });

    const borrowTypes = {
      BorrowOrder: [
        { name: 'borrower', type: 'address' },
        { name: 'collateralToken', type: 'address' },
        { name: 'collateralAmount', type: 'uint128' },
        { name: 'minUsdc', type: 'uint128' },
        { name: 'maxRateBps', type: 'uint32' },
        { name: 'termDays', type: 'uint16' },
        { name: 'maxLtvBps', type: 'uint16' },
        { name: 'minFill', type: 'uint128' },
        { name: 'expiry', type: 'uint64' },
        { name: 'nonce', type: 'uint256' },
        { name: 'yieldMode', type: 'uint8' },
        { name: 'allowInKindSettlement', type: 'bool' },
      ],
    } as const;
    const fillOrderAbi = [
      {
        type: 'function',
        name: 'fillBorrowOrder',
        stateMutability: 'nonpayable',
        inputs: [
          {
            name: 'order',
            type: 'tuple',
            components: borrowTypes.BorrowOrder,
          },
          { name: 'signature', type: 'bytes' },
          { name: 'fillUsdc', type: 'uint128' },
        ],
        outputs: [{ name: 'loanId', type: 'uint256' }],
      },
    ] as const;

    async function openLoan(principalUsdc: bigint): Promise<bigint> {
      const blk = await publicClient.getBlock();
      const order = {
        borrower: ADDRESSES.borrower,
        collateralToken: nvdac,
        collateralAmount: 10n * 10n ** 18n,
        minUsdc: principalUsdc,
        maxRateBps: 1000,
        termDays: 14,
        maxLtvBps: 6000,
        minFill: 500_000_000n,
        expiry: blk.timestamp + 3600n,
        nonce: 0n,
        yieldMode: 0,
        allowInKindSettlement: false,
      } as const;
      const sig = await borrowerAccount.signTypedData({
        domain: {
          name: 'NOSTOK Order Settlement',
          version: '1',
          chainId: BASE_CHAIN_ID,
          verifyingContract: deployed.orderSettlement,
        },
        types: borrowTypes,
        primaryType: 'BorrowOrder',
        message: order,
      });
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: deployed.orderSettlement,
          abi: fillOrderAbi,
          functionName: 'fillBorrowOrder',
          args: [order, sig, principalUsdc],
        }),
      });
      const nextId = await publicClient.readContract({
        address: deployed.loanCore,
        abi: parseAbi(['function nextLoanId() view returns (uint256)']),
        functionName: 'nextLoanId',
      });
      return nextId - 1n;
    }

    await openLoan(600_000_000n);
    const loan2Id = await openLoan(600_000_000n);
    await publicClient.waitForTransactionReceipt({
      hash: await borrowerClient.writeContract({
        address: deployed.loanCore,
        abi: parseAbi(['function repay(uint256 loanId) returns (uint128)']),
        functionName: 'repay',
        args: [loan2Id],
      }),
    });

    // Boot indexer, api/, and notifications/ HTTP servers
    const idxCfg = loadIndexerConfig({
      rpcUrl: LOCAL_RPC_URL,
      isFork: true,
      forkChainId: BASE_CHAIN_ID,
      databaseUrl: 'memory://',
      startBlock,
      confirmations: 0,
      loanCore: deployed.loanCore,
      orderSettlement: deployed.orderSettlement,
      liquidationAuction: deployed.liquidationAuction,
      positionNft: deployed.positionNFT,
      collateralEscrow: deployed.collateralEscrow,
      assetRegistry: deployed.assetRegistry,
      oracleRouter: deployed.oracleRouter,
      assets: [nvdac],
    });
    const idxCtx = await createIndexerContext(idxCfg);
    await runIndexerSync(idxCtx);

    const apiCfg = loadApiConfig({
      rpcUrl: LOCAL_RPC_URL,
      isFork: true,
      forkChainId: BASE_CHAIN_ID,
      databaseUrl: 'memory://',
      corsOrigins: ['https://app.nostok.xyz'],
      rateLimitMax: 2000,
      rateLimitWindowMs: 60_000,
      maxBodyBytes: 4096,
      maxPageLimit: 100,
      loanCore: deployed.loanCore,
      orderSettlement: deployed.orderSettlement,
      liquidationAuction: deployed.liquidationAuction,
      positionNft: deployed.positionNFT,
      collateralEscrow: deployed.collateralEscrow,
      assetRegistry: deployed.assetRegistry,
      oracleRouter: deployed.oracleRouter,
      feeCollector: deployed.feeCollector,
      eligibilityGate: deployed.eligibilityGate,
      usdc: BASE_USDC,
    });
    const apiCtx = await createApiContext(apiCfg, wrapApiReadOnly(idxCtx.db));
    const apiServer = createApiServer(apiCtx);
    await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
    const apiUrl = `http://127.0.0.1:${(apiServer.address() as net.AddressInfo).port}`;

    const notifCfg = loadNotificationsConfig({
      rpcUrl: LOCAL_RPC_URL,
      isFork: true,
      forkChainId: BASE_CHAIN_ID,
      databaseUrl: 'memory://',
      indexerDatabaseUrl: 'memory://',
      siweDomain: 'app.nostok.xyz',
      siweUri: 'https://app.nostok.xyz',
      encryptionKeyId: 'k1',
      encryptionKeys: { k1: crypto.randomBytes(32).toString('hex') },
      unsubscribeSecret: crypto.randomBytes(32).toString('hex'),
      confirmSecret: crypto.randomBytes(32).toString('hex'),
      sessionSecret: crypto.randomBytes(32).toString('hex'),
      piiHashSecret: crypto.randomBytes(32).toString('hex'),
      webhookSigningSecret: crypto.randomBytes(32).toString('hex'),
      publicBaseUrl: 'http://127.0.0.1:3003',
      corsOrigins: ['https://app.nostok.xyz'],
      rateLimitMax: 200,
      authNonceRateLimitMax: 50,
      authVerifyRateLimitMax: 50,
      subscriptionsRateLimitMax: 50,
      loanCore: deployed.loanCore,
      liquidationAuction: deployed.liquidationAuction,
      assetRegistry: deployed.assetRegistry,
      oracleRouter: deployed.oracleRouter,
      positionNft: deployed.positionNFT,
    });
    const notifCtx = await createNotificationsContext(notifCfg, {
      indexerDbOverride: wrapIndexerQueryableAsReadOnly({
        query: (sql, params) => idxCtx.db.query(sql, params),
        async close() {},
      }),
      transportsOverride: {
        async sendEmail() {},
        async sendTelegram() {},
        async sendWebhook() {},
      },
    });
    const notifServer = createNotificationsServer(notifCtx);
    await new Promise<void>((r) => notifServer.listen(0, '127.0.0.1', r));
    const notifUrl = `http://127.0.0.1:${(notifServer.address() as net.AddressInfo).port}`;

    try {
      setFrontendConfigOverrides({
        isProd: false,
        isFork: true,
        chainId: BASE_CHAIN_ID,
        rpcUrl: LOCAL_RPC_URL,
        apiUrl,
        notificationsUrl: notifUrl,
        siweDomain: 'app.nostok.xyz',
        siweOrigin: 'https://app.nostok.xyz',
        usdcAddress: BASE_USDC,
        loanCore: deployed.loanCore,
        orderSettlement: deployed.orderSettlement,
        liquidationAuction: deployed.liquidationAuction,
        positionNft: deployed.positionNFT,
        collateralEscrow: deployed.collateralEscrow,
        assetRegistry: deployed.assetRegistry,
        oracleRouter: deployed.oracleRouter,
        eligibilityGate: deployed.eligibilityGate,
      });

      const cfg = getFrontendConfig();
      assert.equal(cfg.chainId, 8453);
      assert.equal(cfg.usdcAddress, BASE_USDC_ADDRESS);
      assert.equal(cfg.contracts.loanCore, deployed.loanCore);

      // 3.1a Wrong network detection & automatic/rejected switch
      console.log('\n=== WS3.1a: Wallet connect & Base (8453) network enforcement ===');
      const walletProvider = createMockEip1193Provider(KEYS.borrower, 1);
      setInjectedProvider(walletProvider);

      walletProvider.setRejectSwitch(true);
      const wrongConn = await connectWallet(walletProvider, cfg);
      assert.equal(wrongConn.address, ADDRESSES.borrower);
      assert.equal(wrongConn.wrongNetwork, true);
      assert.match(wrongConn.error, /rejected/i);
      await assert.rejects(
        () => signInWithSiwe({ address: wrongConn.address, provider: walletProvider, cfg }),
        /Switch wallet to Base \(8453\)/i
      );

      walletProvider.setRejectSwitch(false);
      const switchedConn = await connectWallet(walletProvider, cfg);
      assert.equal(switchedConn.wrongNetwork, false);
      assert.equal(switchedConn.chainId, 8453);
      console.log('PASS WS3.1a: Wrong chain detected cleanly; switch to Base (8453) verified.');

      // 3.1b Live balances (exact USDC 6 dec, B20 18 dec, LoanCore.getClaimable) & API counts
      console.log('\n=== WS3.1b: Live on-chain balances (6/18 dec), claimable, & API reads ===');
      const borrowerState = await fetchWalletState(ADDRESSES.borrower, { cfg });
      assert.ok(borrowerState, 'Expected non-null borrowerState');
      assert.equal(
        borrowerState.stale,
        false,
        `Expected live borrowerState (rpcError="${borrowerState.rpcError}", apiError="${borrowerState.apiError}")`
      );
      assert.equal(borrowerState.rpcChainId, 8453);
      assert.equal(borrowerState.usdcBalance?.decimals, USDC_DECIMALS);
      assert.equal(borrowerState.openBorrowCount, 1);
      const nvdacBal = (borrowerState.collateralBalances as Array<{ token: string; decimals: number; raw: string; formatted: string }>).find(
        (c) => c.token === nvdac
      );
      assert.ok(nvdacBal);
      assert.equal(nvdacBal.decimals, 18);
      // Started with 25 NVDAc; deposited 10 for Loan #1 and 10 for Loan #2; Loan #2 repaid 10 -> 15 NVDAc left
      assert.equal(nvdacBal.raw, (15n * 10n ** 18n).toString());
      assert.equal(nvdacBal.formatted, '15');

      const lenderState = await fetchWalletState(ADDRESSES.lender, { cfg });
      assert.ok(lenderState && !lenderState.stale);
      assert.equal(lenderState.openLenderCount, 1);
      assert.equal(lenderState.claimableUsdc?.decimals, 6);
      assert.ok(BigInt(lenderState.claimableUsdc!.raw) > 600_000_000n, 'Repaid Loan #2 must credit lender claimable on LoanCore');
      console.log('PASS WS3.1b: Live ETH/USDC(6)/NVDAc(18)/getClaimable(6)/API counts verified.');

      // 3.1c Live EligibilityGate checks (allowlist, revocation, EIP-712 attestation context)
      console.log('\n=== WS3.1c: Live EligibilityGate checks (revoked + attested) ===');
      assert.equal(borrowerState.eligibility?.isEligible, true);
      assert.equal(borrowerState.eligibility?.isRevoked, false);

      await publicClient.waitForTransactionReceipt({
        hash: await ownerClient.writeContract({
          address: deployed.eligibilityGate,
          abi: parseAbi(['function revokeUser(address account, bool revoked)']),
          functionName: 'revokeUser',
          args: [ADDRESSES.borrower, true],
        }),
      });
      const revokedState = await fetchWalletState(ADDRESSES.borrower, { cfg });
      assert.equal(revokedState?.eligibility?.isRevoked, true);
      assert.equal(revokedState?.eligibility?.isEligible, false);

      // Test EIP-712/ECDSA attestation for non-allowlisted outsider
      const blockNow = await publicClient.getBlock();
      const expiry = blockNow.timestamp + 3600n;
      const typeHash = keccak256(
        stringToBytes('Attestation(uint256 chainId,address gate,address account,uint256 nonce,uint256 expiry)')
      );
      const structHash = keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'address' },
            { type: 'address' },
            { type: 'uint256' },
            { type: 'uint256' },
          ],
          [typeHash, 8453n, deployed.eligibilityGate, ADDRESSES.outsider, 0n, expiry]
        )
      );
      const attSig = await attSignerAccount.signMessage({ message: { raw: structHash } });
      const attestationHex = encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'bytes' }],
        [expiry, attSig]
      );
      const outsiderNoAtt = await fetchWalletState(ADDRESSES.outsider, { cfg });
      assert.equal(outsiderNoAtt?.eligibility?.isEligible, false);
      const outsiderWithAtt = await fetchWalletState(ADDRESSES.outsider, { cfg, attestationHex });
      assert.equal(outsiderWithAtt?.eligibility?.isEligible, true);
      console.log('PASS WS3.1c: EligibilityGate revocation & signed attestation context verified.');

      // 3.1d Full SIWE Sign-In, verified session query, & Logout jti revocation with notifications/
      console.log('\n=== WS3.1d: SIWE sign-in -> session query -> logout revocation ===');
      const siweSess = await signInWithSiwe({
        address: ADDRESSES.borrower,
        provider: walletProvider,
        cfg,
      });
      assert.equal(siweSess.walletAddress, ADDRESSES.borrower);
      assert.ok(siweSess.token.length > 20);
      assert.ok(siweSess.jti.length >= 8);

      const notifSessionData = await fetchNotificationsSessionState({ token: siweSess.token, cfg });
      assert.ok(Array.isArray(notifSessionData.subscriptions));
      assert.equal(
        (notifSessionData.preferences as { wallet_address?: string }).wallet_address,
        ADDRESSES.borrower
      );

      // Sign out revokes jti on notifications/ -> subsequent call fails 401 SESSION_REVOKED
      await signOutSiwe({ token: siweSess.token, cfg });
      await assert.rejects(
        () => fetchNotificationsSessionState({ token: siweSess.token, cfg }),
        (err: Error & { status?: number; code?: string }) =>
          err.status === 401 && err.code === 'SESSION_REVOKED'
      );
      console.log('PASS WS3.1d: SIWE nonce, EIP-4361 signature, verify, authenticated GET, & /auth/logout revocation verified.');

      // 3.1e Unreachable RPC/API reports explicit errors & stale=true (never shows stale data as live)
      console.log('\n=== WS3.1e: Unreachable RPC & API error / stale state guarantees ===');
      const deadPort = await getFreePort();
      const apiDownState = await fetchWalletState(ADDRESSES.borrower, {
        cfg: { ...cfg, apiUrl: `http://127.0.0.1:${deadPort}` },
      });
      assert.equal(apiDownState?.stale, true);
      assert.match(apiDownState?.apiError ?? '', /API read failed/i);

      const rpcDownState = await fetchWalletState(ADDRESSES.borrower, {
        cfg: { ...cfg, rpcUrl: `http://127.0.0.1:${deadPort}` },
      });
      assert.equal(rpcDownState?.stale, true);
      assert.equal(rpcDownState?.ethBalance, null);
      assert.equal(rpcDownState?.usdcBalance, null);
      assert.match(rpcDownState?.rpcError ?? '', /On-chain read failed/i);
      console.log('PASS WS3.1e: Failed RPC/API reads explicitly flag stale=true and surface clear errors.');

      // 3.1f Review Fixes #1, #2, #3, #5, #6: Snapshot requestId, SIWE domain/origin/mid-sign guard,
      //      prod config enforcement, missing contracts stale, logout failure, dust display, pagination
      console.log('\n=== WS3.1f: Security & UX Fixes #1-#6 integration tests ===');
      // Fix #1: requestId & address tagging
      const snap1 = await fetchWalletState(ADDRESSES.borrower, { cfg, requestId: 41 });
      const snap2 = await fetchWalletState(ADDRESSES.lender, { cfg, requestId: 42 });
      assert.equal(snap1?.address, ADDRESSES.borrower);
      assert.equal(snap1?.requestId, 41);
      assert.equal(snap2?.address, ADDRESSES.lender);
      assert.equal(snap2?.requestId, 42);

      // Fix #2: SIWE domain, origin, chain_id & mid-sign account switch rejection
      await assert.rejects(
        () =>
          signInWithSiwe({
            address: ADDRESSES.borrower,
            provider: walletProvider,
            cfg,
            browserWindow: { location: { host: 'phish.nostok.xyz', origin: 'https://app.nostok.xyz' } },
          }),
        /SIWE domain mismatch/
      );
      await assert.rejects(
        () =>
          signInWithSiwe({
            address: ADDRESSES.borrower,
            provider: walletProvider,
            cfg,
            browserWindow: { location: { host: 'app.nostok.xyz', origin: 'https://phish.nostok.xyz' } },
          }),
        /SIWE URI origin mismatch/
      );
      walletProvider.setMidSignAccountSwitch(KEYS.lender);
      await assert.rejects(
        () => signInWithSiwe({ address: ADDRESSES.borrower, provider: walletProvider, cfg }),
        /Wallet account changed during SIWE signing/
      );
      walletProvider.setAccount(KEYS.borrower);

      // Fix #3: Missing contract address marks stale=true with explicit error; prod throws on missing/http/wrong chain
      const missingContractState = await fetchWalletState(ADDRESSES.borrower, {
        cfg: { ...cfg, contracts: { ...cfg.contracts, eligibilityGate: undefined } },
      });
      assert.equal(missingContractState?.stale, true);
      assert.match(missingContractState?.rpcError ?? '', /Missing required protocol contract address.*eligibilityGate/);

      assert.throws(() => {
        setFrontendConfigOverrides({
          isProd: true,
          isFork: false,
          chainId: 1,
          rpcUrl: 'https://base-private.example',
          apiUrl: 'https://api.nostok.xyz',
          notificationsUrl: 'https://notifications.nostok.xyz',
          riskUrl: 'https://risk.nostok.xyz',
          loanCore: deployed.loanCore,
          orderSettlement: deployed.orderSettlement,
          liquidationAuction: deployed.liquidationAuction,
          positionNft: deployed.positionNFT,
          collateralEscrow: deployed.collateralEscrow,
          assetRegistry: deployed.assetRegistry,
          oracleRouter: deployed.oracleRouter,
          eligibilityGate: deployed.eligibilityGate,
        });
        getFrontendConfig();
      }, /VITE_CHAIN_ID=8453/);

      setFrontendConfigOverrides({
        isProd: false,
        isFork: true,
        chainId: BASE_CHAIN_ID,
        rpcUrl: LOCAL_RPC_URL,
        apiUrl,
        notificationsUrl: notifUrl,
        siweDomain: 'app.nostok.xyz',
        siweOrigin: 'https://app.nostok.xyz',
        usdcAddress: BASE_USDC,
        loanCore: deployed.loanCore,
        orderSettlement: deployed.orderSettlement,
        liquidationAuction: deployed.liquidationAuction,
        positionNft: deployed.positionNFT,
        collateralEscrow: deployed.collateralEscrow,
        assetRegistry: deployed.assetRegistry,
        oracleRouter: deployed.oracleRouter,
        eligibilityGate: deployed.eligibilityGate,
      });

      // Fix #5: logout unreachable throws so store clears local session & reports expiry
      const freshSess = await signInWithSiwe({ address: ADDRESSES.borrower, provider: walletProvider, cfg });
      await assert.rejects(
        () => signOutSiwe({ token: freshSess.token, cfg: { ...cfg, notificationsUrl: `http://127.0.0.1:${deadPort}` } }),
        /.+/
      );
      await signOutSiwe({ token: freshSess.token, cfg });

      // Fix #6: Dust formatting & paginated loans/positions
      assert.equal(formatTokenUnitsDisplay(1n, 6, 2), '<0.01');
      const pagedLoans = await fetchPaginatedApiRows(`${cfg.apiUrl}/loans?borrower=${ADDRESSES.borrower}`, {
        limit: 1,
        maxPages: 5,
      });
      assert.equal(pagedLoans.rows.length, 2);
      assert.equal(pagedLoans.total, 2);
      assert.equal(pagedLoans.truncated, false);
      console.log('PASS WS3.1f: Review fixes #1-#6 verified.');

      // 3.2 WS3.2 Live Market Pages (read-only api/ markets, assets, orders, quotes, stale/degraded states)
      console.log('\n=== WS3.2: Live market pages & GET /quote from api/ ===');
      const liveMkt = await fetchMarketSnapshot({ cfg, requestId: 101 });
      assert.equal(liveMkt.stale, false, `Expected live market snapshot (${liveMkt.error})`);
      assert.equal(liveMkt.degraded, false);
      assert.equal(liveMkt.assets.length, 1);
      assert.equal(liveMkt.assets[0].symbol, 'NVDAc');
      assert.equal(liveMkt.assets[0].decimals, 18);
      assert.equal(liveMkt.assets[0].oracle.state_name, 'VALID_OPEN');
      assert.equal(formatApiAmount(liveMkt.assets[0].oracle.price, { prefixUsd: true }), '$140.00');
      assert.equal(liveMkt.orders.length, 2, 'Expected 2 indexed borrow orders');
      assert.equal(liveMkt.bookSummary?.borrowOrders.length, 2);
      assert.equal(liveMkt.bookSummary?.lendOffers.length, 0);
      assert.equal(liveMkt.bookSummary?.activeLoansCount, 1);
      assert.equal(liveMkt.bookSummary?.repaidLoansCount, 1);
      assert.equal(liveMkt.bookSummary?.totalOutstandingUsdc.raw, '600000000');
      assert.equal(formatBpsPercent(liveMkt.bookSummary?.weightedAverageAprBps), '10.00%');

      // Quote while borrower is revoked must reject BORROWER_INELIGIBLE
      const revokedQuote = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '500000000',
        termDays: 30,
        aprBps: 800,
        borrower: ADDRESSES.borrower,
      });
      assert.equal(revokedQuote.accepted, false);
      assert.ok(
        revokedQuote.rejection_reasons.some((r: { code: string }) => r.code === 'BORROWER_INELIGIBLE'),
        'Revoked borrower quote must report BORROWER_INELIGIBLE'
      );

      // Restore borrower allowlist and obtain accepted live quote
      await publicClient.waitForTransactionReceipt({
        hash: await ownerClient.writeContract({
          address: deployed.eligibilityGate,
          abi: parseAbi(['function revokeUser(address account, bool revoked)']),
          functionName: 'revokeUser',
          args: [ADDRESSES.borrower, false],
        }),
      });

      const okQuote = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '500000000',
        termDays: 30,
        aprBps: 800,
        borrower: ADDRESSES.borrower,
      });
      assert.equal(okQuote.accepted, true);
      assert.equal(okQuote.amounts.principal.raw, '500000000');
      assert.equal(okQuote.amounts.principal.decimals, 6);
      assert.equal(okQuote.asset.decimals, 18);
      assert.ok(BigInt(okQuote.amounts.collateral_required.raw) > 0n);

      // Market snapshot against dead api/ must report stale=true, degraded=true, and zero fallback assets/orders
      const downMkt = await fetchMarketSnapshot({
        cfg: { ...cfg, apiUrl: `http://127.0.0.1:${deadPort}` },
        requestId: 102,
      });
      assert.equal(downMkt.stale, true);
      assert.equal(downMkt.degraded, true);
      assert.equal(downMkt.assets.length, 0);
      assert.equal(downMkt.orders.length, 0);
      assert.match(downMkt.error, /Failed to fetch live market data/i);

      // Market snapshot must also flag stale=true & degraded=true if GET /orders reports stale=true / relay_stale=true while /health is ok
      const origFetchWs3 = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const resp = await origFetchWs3(input, init);
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (urlStr.includes('/orders')) {
          const data = await resp.json();
          return new Response(JSON.stringify({ ...data, stale: true, relay_stale: true }), {
            status: resp.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return resp;
      }) as typeof fetch;
      try {
        const staleOrdersMkt = await fetchMarketSnapshot({ cfg, requestId: 103 });
        assert.equal(staleOrdersMkt.stale, true, 'fetchMarketSnapshot must flag stale=true when /orders returns stale=true');
        assert.equal(staleOrdersMkt.degraded, true);
        assert.match(staleOrdersMkt.error, /stale/i);
      } finally {
        globalThis.fetch = origFetchWs3;
      }
      console.log('PASS WS3.2: Live assets, orders, book metrics, GET /quote, and degraded error states verified.');

      // Pre-WS3.3 Hardening Verification (Fixes #1, #2, #4, #5, Low Fees & CSP)
      console.log('\n=== Pre-WS3.3 Fixes #1-#5 & Low Verification ===');

      // Fix #1: PreviewBanner present, no header demo Alerts count badge, no actionable buttons/forms on demo pages
      const forbiddenDemoActionRe =
        /<button[^>]*>\s*(Open|Download my records|Claim|List this claim|Cancel listing|Buy claim|Dismiss|Repay all|Repay part|Add collateral|Extend|Roll|Post lend offer)\s*<\/button>/i;
      const demoRoutes: Array<{ route: string; el: ReturnType<typeof createElement> }> = [
        { route: '/alerts', el: createElement(Alerts) },
        { route: '/builders', el: createElement(Builders) },
      ];
      for (const { route, el } of demoRoutes) {
        const rendered = renderToStaticMarkup(
          createElement(
            StoreProvider,
            null,
            createElement(MemoryRouter, { initialEntries: [route] }, createElement(Shell, null, el))
          )
        );
        const pageOnlyHtml = renderToStaticMarkup(
          createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: [route] }, el))
        );
        assert.ok(rendered.includes('Preview data, not your positions.'), `${route} must show PreviewBanner`);
        assert.ok(!rendered.includes('class="count"'), `${route} header Alerts nav must drop demo count badge`);
        assert.ok(!/aria-label="Alerts,/.test(rendered), `${route} header must drop demo Alerts count aria-label`);
        assert.ok(!forbiddenDemoActionRe.test(rendered), `${route} must not render actionable demo buttons`);
        assert.ok(!/<button\b/i.test(pageOnlyHtml), `${route} page body must not render any actionable buttons on demo rows`);
        assert.ok(!/type=["']?submit/i.test(pageOnlyHtml), `${route} page body must not render submit controls`);
      }

      const marketsHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/markets'] }, createElement(Shell, null, createElement(Markets)))
        )
      );
      assert.ok(marketsHtml.includes('7 to 90 days'), 'Markets term hint must match 7 to 90 day validation');

      // Fix #2: ErrorBoundary catches invalid prod config (no blank page) & real vite build fails invalid / enforces prod CSP & USDC pin
      assert.equal(
        ErrorBoundary.getDerivedStateFromError(new Error('boom')).error.message,
        'boom',
        'ErrorBoundary.getDerivedStateFromError must capture thrown runtime errors'
      );
      setFrontendConfigOverrides({ isProd: true, chainId: 84532 });
      try {
        const errHtml = renderToStaticMarkup(createElement(App));
        assert.ok(errHtml.includes('Configuration Error'), 'App must render ErrorBoundary fallback on invalid config');
        assert.ok(errHtml.includes('Application cannot start.'), 'ErrorBoundary must render application cannot start heading');
        assert.ok(errHtml.includes('VITE_CHAIN_ID=8453'), 'ErrorBoundary must surface concrete config failure');
      } finally {
        setFrontendConfigOverrides({
          isProd: false,
          isFork: true,
          chainId: BASE_CHAIN_ID,
          rpcUrl: LOCAL_RPC_URL,
          apiUrl,
          notificationsUrl: notifUrl,
          siweDomain: 'app.nostok.xyz',
          siweOrigin: 'https://app.nostok.xyz',
          usdcAddress: BASE_USDC,
          loanCore: deployed.loanCore,
          orderSettlement: deployed.orderSettlement,
          liquidationAuction: deployed.liquidationAuction,
          positionNft: deployed.positionNFT,
          collateralEscrow: deployed.collateralEscrow,
          assetRegistry: deployed.assetRegistry,
          oracleRouter: deployed.oracleRouter,
          eligibilityGate: deployed.eligibilityGate,
        });
      }

      const viteBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'vite');
      const tmpBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostok-vite-build-'));
      try {
        const baseBuildEnv: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: 'production',
          VITE_CHAIN_ID: '8453',
          VITE_RPC_URL: 'https://base-mainnet.private-rpc.example/v1/key',
          VITE_API_URL: 'https://api.nostok.xyz',
          VITE_NOTIFICATIONS_URL: 'https://notifications.nostok.xyz',
          VITE_RISK_URL: 'https://risk.nostok.xyz',
          VITE_LOAN_CORE_ADDRESS: deployed.loanCore,
          VITE_ORDER_SETTLEMENT_ADDRESS: deployed.orderSettlement,
          VITE_LIQUIDATION_AUCTION_ADDRESS: deployed.liquidationAuction,
          VITE_POSITION_NFT_ADDRESS: deployed.positionNFT,
          VITE_COLLATERAL_ESCROW_ADDRESS: deployed.collateralEscrow,
          VITE_ASSET_REGISTRY_ADDRESS: deployed.assetRegistry,
          VITE_ORACLE_ROUTER_ADDRESS: deployed.oracleRouter,
          VITE_ELIGIBILITY_GATE_ADDRESS: deployed.eligibilityGate,
        };
        const badChainBuild = spawnSync(viteBin, ['build', '--outDir', path.join(tmpBuildDir, 'bad1'), '--emptyOutDir'], {
          cwd: REPO_ROOT,
          env: { ...baseBuildEnv, VITE_CHAIN_ID: '1' },
          encoding: 'utf8',
        });
        assert.notEqual(badChainBuild.status, 0, 'vite build MUST fail on non-Base VITE_CHAIN_ID in production');

        const badForkUsdcBuild = spawnSync(
          viteBin,
          ['build', '--outDir', path.join(tmpBuildDir, 'bad2'), '--emptyOutDir'],
          {
            cwd: REPO_ROOT,
            env: {
              ...baseBuildEnv,
              VITE_IS_FORK: 'true',
              FORK: 'true',
              VITE_USDC_ADDRESS: '0x9999999999999999999999999999999999999999',
            },
            encoding: 'utf8',
          }
        );
        assert.notEqual(
          badForkUsdcBuild.status,
          0,
          'vite build MUST ignore VITE_IS_FORK/FORK and fail when VITE_USDC_ADDRESS overrides Base USDC'
        );

        const goodProdOut = path.join(tmpBuildDir, 'good');
        const goodProdBuild = spawnSync(viteBin, ['build', '--outDir', goodProdOut, '--emptyOutDir'], {
          cwd: REPO_ROOT,
          env: { ...baseBuildEnv, VITE_IS_FORK: 'true', FORK: 'true' },
          encoding: 'utf8',
        });
        assert.equal(goodProdBuild.status, 0, `Valid prod vite build failed: ${goodProdBuild.stderr}`);
        const builtIndexHtml = fs.readFileSync(path.join(goodProdOut, 'index.html'), 'utf8');
        assert.ok(
          !/connect-src[^"]*?\shttps:(?:\s|;|")/.test(builtIndexHtml),
          'Built prod index.html CSP must not contain https: wildcard'
        );
        assert.ok(builtIndexHtml.includes('https://base-mainnet.private-rpc.example'));
        assert.ok(builtIndexHtml.includes('https://api.nostok.xyz'));
        assert.ok(builtIndexHtml.includes('https://notifications.nostok.xyz'));
        assert.ok(builtIndexHtml.includes('https://risk.nostok.xyz'));
      } finally {
        fs.rmSync(tmpBuildDir, { recursive: true, force: true });
      }

      // Fix #4: Live chainChanged away (0x1) and back to Base (0x2105) updates connRef synchronously & reloads live snapshot
      const connRef = {
        current: {
          connected: true,
          address: ADDRESSES.borrower,
          chainId: BASE_CHAIN_ID,
          wrongNetwork: false,
          walletError: '',
        },
      };
      const siweRef = { current: null };
      const snapshotSeqRef = { current: 1 };
      const snapshots: Array<{ loading: boolean; data: Awaited<ReturnType<typeof fetchWalletState>> | null }> = [];
      let pendingRefresh: Promise<void> = Promise.resolve();
      const eventsHandler = createWalletEventsHandler({
        connRef,
        siweRef,
        snapshotSeqRef,
        updateWalletConn(updater: any) {
          const next = typeof updater === 'function' ? updater(connRef.current) : updater;
          connRef.current = next;
          return next;
        },
        setWalletSnapshot(snap: any) {
          snapshots.push(snap);
        },
        clearLocalSiweState() {},
        refreshWalletData(addr: string, att: string, opts: { wrongNetwork?: boolean } = {}) {
          assert.equal(
            connRef.current.wrongNetwork,
            false,
            'connRef.current.wrongNetwork must be updated BEFORE refreshWalletData reads it'
          );
          assert.equal(opts.wrongNetwork, false);
          const reqId = ++snapshotSeqRef.current;
          pendingRefresh = (async () => {
            const ws = await fetchWalletState(addr, { cfg, attestationHex: att, requestId: reqId });
            snapshots.push({ loading: false, data: ws });
          })();
          return pendingRefresh;
        },
        getConfig: () => cfg,
      });

      eventsHandler.onChainChanged('0x1');
      assert.equal(connRef.current.wrongNetwork, true);
      assert.equal(connRef.current.chainId, 1);
      assert.equal(snapshots[snapshots.length - 1]?.data, null);

      eventsHandler.onChainChanged('0x2105');
      assert.equal(connRef.current.wrongNetwork, false);
      assert.equal(connRef.current.chainId, BASE_CHAIN_ID);
      await pendingRefresh;
      const reloaded = snapshots[snapshots.length - 1]?.data;
      assert.ok(reloaded && !reloaded.stale, 'Switching back to Base (0x2105) must reload live snapshot');
      assert.equal(reloaded.rpcChainId, BASE_CHAIN_ID);
      assert.equal(reloaded.openBorrowCount, 1);

      // Fix #5 + Low Fees: live FeeCollector fees exposed on /assets + /fees & fetchMarketSnapshot
      assert.ok(liveMkt.fees, 'fetchMarketSnapshot must populate live protocol fees from api/');
      assert.equal(typeof liveMkt.fees.origination_fee_bps, 'number');
      assert.equal(typeof liveMkt.fees.max_origination_bps, 'number');
      const feesHttp = await fetch(`${apiUrl}/fees`);
      assert.equal(feesHttp.status, 200);
      const feesBody = (await feesHttp.json()) as { fees: Record<string, number> };
      assert.equal(feesBody.fees.origination_fee_bps, liveMkt.fees.origination_fee_bps);
      assert.equal(feesBody.fees.safety_reserve_share_bps, liveMkt.fees.safety_reserve_share_bps);
      console.log('PASS Pre-WS3.3 Fixes #1-#5 + Low (demo banners, ErrorBoundary/vite build/CSP, chainChanged reload, live fees) verified.');

      // 3.3 WS3.3 Borrow Flow: exact/rounded-up raw API amounts -> approve -> sign BorrowOrder -> fill -> cancel -> fillLendOffer
      console.log('\n=== WS3.3: Borrow flow (quote -> approve exact -> sign BorrowOrder -> fill -> cancel -> fillLendOffer) ===');
      walletProvider.setAccount(KEYS.borrower);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [ADDRESSES.borrower, 25n * 10n ** 18n],
        }),
      });

      // Reset NVDAc -> CollateralEscrow allowance to 0 so prepareAndSignBorrowOrder must issue exact on-chain approve
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: nvdac,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.collateralEscrow, 0n],
        }),
      });

      // Non-round $700 principal at $140 / 60% LTV: minRequired is ceilDiv(700e6 * 1e20 / 6000 / 140e8),
      // and M3 default +5.00% (500 bps) buffer sizes collateralAmountRaw cleanly above exact min.
      const nonRoundQuote = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '700000000',
        termDays: 30,
        aprBps: 1000,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      assert.equal(nonRoundQuote.accepted, true);
      const exact700 = resolveExactBorrowAmounts(nonRoundQuote);
      assert.equal(exact700.principalRaw, 700_000_000n);
      assert.equal(exact700.bufferBps, DEFAULT_COLLATERAL_BUFFER_BPS);
      assert.equal(exact700.collateralAmountRaw, exact700.bufferedCollateralRaw);
      assert.ok(
        exact700.minRequiredCollateralRaw > 8_333_333_000_000_000_000n,
        `Expected rounded-up minRequiredCollateralRaw > 6-dec floor, got ${exact700.minRequiredCollateralRaw}`
      );
      assert.ok(
        exact700.collateralAmountRaw > exact700.minRequiredCollateralRaw,
        'Default +5.00% buffer must exceed unbuffered minimum collateral'
      );

      // Zero buffer option returns exact unbuffered minimum
      const exact700ZeroBuf = resolveExactBorrowAmounts(nonRoundQuote, { bufferBps: 0 });
      assert.equal(exact700ZeroBuf.collateralAmountRaw, exact700.minRequiredCollateralRaw);

      // Re-quote mismatch check must abort before signing if expectedQuote differs
      await assert.rejects(
        () =>
          prepareAndSignBorrowOrder({
            address: ADDRESSES.borrower,
            collateralToken: nvdac,
            principalRaw: '700000000',
            expectedQuote: {
              ...nonRoundQuote,
              amounts: {
                ...nonRoundQuote.amounts,
                collateral_required: { ...nonRoundQuote.amounts.collateral_required, raw: '1' },
              },
            },
            maxRateBps: 1000,
            termDays: 30,
            maxLtvBps: 6000,
            expiryDays: 7,
            autoApprove: true,
            provider: walletProvider,
            cfg,
          }),
        /Quote changed before signing/
      );

      const memMap = new Map<string, string>();
      const mockStorage = {
        getItem: (k: string) => memMap.get(k) ?? null,
        setItem: (k: string, v: string) => {
          memMap.set(k, v);
        },
      };

      const preparedBorrow = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '700000000',
        expectedQuote: nonRoundQuote,
        maxRateBps: 1000,
        termDays: 30,
        maxLtvBps: 6000,
        expiryDays: 7,
        autoApprove: true,
        storage: mockStorage,
        provider: walletProvider,
        cfg,
      });
      assert.ok(preparedBorrow.approvalTxHash, 'WS3.3 must submit exact ERC-20 approve tx when allowance < required');
      assert.equal(preparedBorrow.order.collateralAmount, exact700.collateralAmountRaw);
      assert.equal(preparedBorrow.order.minUsdc, 700_000_000n);
      assert.equal(preparedBorrow.publishedToApi, true, 'BorrowOrder must auto-publish to POST /orders');
      assert.equal(loadPersistedSignedOrders(mockStorage).length, 1);

      const postApproveMeta = await readBorrowAllowanceAndNonce(ADDRESSES.borrower, nvdac, { cfg });
      assert.equal(
        BigInt(postApproveMeta.allowanceRaw),
        exact700.requiredApprovalRaw,
        'Approval MUST grant signed raw collateral + ceil(principal/minFill) wei slack, never infinite or floored'
      );

      const onchainOrderHash = await publicClient.readContract({
        address: deployed.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'hashBorrowOrder',
        args: [preparedBorrow.order],
      });
      assert.equal(preparedBorrow.orderHash, onchainOrderHash);

      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: deployed.orderSettlement,
          abi: fillOrderAbi,
          functionName: 'fillBorrowOrder',
          args: [preparedBorrow.order, preparedBorrow.signature, 700_000_000n],
        }),
      });

      await runIndexerSync(idxCtx);
      const afterFillLoans = await fetchPaginatedApiRows(`${cfg.apiUrl}/loans`, { cfg });
      assert.equal(afterFillLoans.total, 3, 'Filled WS3.3 BorrowOrder must open Loan #3 in indexer/api');
      const loan3 = (afterFillLoans.rows as Array<Record<string, unknown>>).find(
        (l) => (l.principal as { raw: string })?.raw === '700000000'
      );
      assert.ok(loan3, 'Loan #3 must have exact $700 principal');
      assert.equal((loan3.collateral_amount as { raw: string }).raw, exact700.collateralAmountRaw.toString());

      // Cancel second BorrowOrder on-chain -> lender fill must revert
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: nvdac,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.collateralEscrow, 10n ** 19n],
        }),
      });
      const cancelPrep = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '600000000',
        maxRateBps: 1000,
        termDays: 30,
        maxLtvBps: 6000,
        expiryDays: 7,
        autoApprove: false,
        provider: walletProvider,
        cfg,
      });
      const cancelRes = await cancelSignedBorrowOrder({
        address: ADDRESSES.borrower,
        order: cancelPrep.order,
        provider: walletProvider,
        cfg,
      });
      assert.ok(/^0x[0-9a-fA-F]{64}$/.test(cancelRes.txHash));
      const isCancelledOnChain = await publicClient.readContract({
        address: deployed.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'isOrderCancelled',
        args: [cancelPrep.orderHash],
      });
      assert.equal(isCancelledOnChain, true);
      await assert.rejects(() =>
        lenderClient.writeContract({
          address: deployed.orderSettlement,
          abi: fillOrderAbi,
          functionName: 'fillBorrowOrder',
          args: [cancelPrep.order, cancelPrep.signature, 600_000_000n],
        })
      );

      // Reset allowance to 0 -> Borrower fills lender's signed LendOffer via fillLendOfferAsBorrower ($550 -> non-round 6.547619... NVDAc)
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: nvdac,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.collateralEscrow, 0n],
        }),
      });
      const lenderNonce = (await publicClient.readContract({
        address: deployed.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'getMakerNonce',
        args: [ADDRESSES.lender],
      })) as bigint;
      const latestBlk = await publicClient.getBlock();
      const lendOffer = {
        lender: ADDRESSES.lender,
        usdcAmount: 1_000_000_000n,
        minRateBps: 900,
        termDays: 30,
        allowedCollateral: nvdac,
        maxLtvBps: 6000,
        minFill: 500_000_000n,
        expiry: latestBlk.timestamp + 7200n,
        nonce: lenderNonce,
        yieldMode: 0,
      };
      const lendOfferSig = await lenderAccount.signTypedData({
        domain: {
          name: ORDER_SETTLEMENT_DOMAIN_NAME,
          version: ORDER_SETTLEMENT_DOMAIN_VERSION,
          chainId: BASE_CHAIN_ID,
          verifyingContract: deployed.orderSettlement,
        },
        types: LEND_OFFER_EIP712_TYPES,
        primaryType: 'LendOffer',
        message: lendOffer,
      });

      const fillLendRes = await fillLendOfferAsBorrower({
        address: ADDRESSES.borrower,
        offer: lendOffer,
        signature: lendOfferSig,
        collateralToken: nvdac,
        fillUsdcRaw: '550000000',
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(fillLendRes.loanId, 'fillLendOfferAsBorrower must emit OrderFilled loanId');
      assert.equal(fillLendRes.exact.principalRaw, 550_000_000n);
      assert.ok(fillLendRes.exact.collateralAmountRaw > 6_547_619_000_000_000_000n);

      await runIndexerSync(idxCtx);
      const finalLoans = await fetchPaginatedApiRows(`${cfg.apiUrl}/loans`, { cfg });
      assert.equal(finalLoans.total, 4, 'fillLendOfferAsBorrower must open Loan #4 in indexer/api');
      console.log('PASS WS3.3: Borrow flow (quote -> exact approve -> EIP-712 sign -> fill -> cancel -> fillLendOffer) verified.');

      // 3.4 Pre-WS3.4 Hardening Suite (M3 partial fills & price tick, M4 pre-approve sim & revert decoding, M5 persistence & bumpNonce, M2 routes, Low guards)
      console.log('\n=== Pre-WS3.4 Hardening (M3, M4, M5, M2 Frontend, Low) ===');

      // Mint extra collateral & USDC so M3 partial fills & M5 tests have ample balances
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [ADDRESSES.borrower, 100n * 10n ** 18n],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: BASE_USDC_WHALE,
          to: BASE_USDC,
          data: encodeFunctionData({
            abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']),
            functionName: 'transfer',
            args: [ADDRESSES.lender, 5_000_000_000n],
          }),
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: BASE_USDC,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.loanCore, 20_000_000_000n],
        }),
      });

      // M3: $1000 order signed at exact-min collateral (bufferBps=0) MUST fail $800 partial fill with LtvExceeded (0x8c0fe5c3)
      // while $1000 order signed with default +5% buffer MUST succeed for BOTH $800 + $200 partial fills and a $0.01 price drop!
      const quote1000 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '1000000000',
        termDays: 30,
        aprBps: 900,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      assert.equal(quote1000.accepted, true);
      const exact1000ZeroBuf = resolveExactBorrowAmounts(quote1000, { bufferBps: 0 });
      const exact1000Buffered = resolveExactBorrowAmounts(quote1000, {
        bufferBps: DEFAULT_COLLATERAL_BUFFER_BPS,
        minFillRaw: '500000000',
      });
      assert.ok(exact1000Buffered.collateralAmountRaw > exact1000ZeroBuf.collateralAmountRaw);

      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: nvdac,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.collateralEscrow, 100n * 10n ** 18n],
        }),
      });

      const unbufferedOrderRes = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '1000000000',
        collateralBufferBps: 0,
        minFillRaw: '500000000',
        maxRateBps: 900,
        termDays: 30,
        maxLtvBps: 6000,
        expiryDays: 7,
        autoApprove: false,
        publishToApi: false,
        storage: mockStorage,
        provider: walletProvider,
        cfg,
      });
      let unbufferedFillErr: unknown = null;
      try {
        await publicClient.call({
          account: ADDRESSES.lender,
          to: deployed.orderSettlement,
          data: encodeFunctionData({
            abi: fillOrderAbi,
            functionName: 'fillBorrowOrder',
            args: [unbufferedOrderRes.order, unbufferedOrderRes.signature, 800_000_000n],
          }),
        });
      } catch (e) {
        unbufferedFillErr = e;
      }
      assert.ok(unbufferedFillErr, 'Exact-min ($0 buffer) $1000 order must revert on $800 partial fill');
      const decodedUnbuf = decodeContractRevert({ data: '0x8c0fe5c3' });
      assert.equal(decodedUnbuf?.errorName, 'LtvExceeded');
      assert.match(formatWeb3Error(unbufferedFillErr), /LtvExceeded/);

      // Now sign the SAME $1000 order with default +5.00% collateral buffer (resetting allowance to 0 first to test exact buffered approval)
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: nvdac,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.collateralEscrow, 0n],
        }),
      });
      const bufferedOrderRes = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '1000000000',
        minFillRaw: '500000000',
        maxRateBps: 900,
        termDays: 30,
        maxLtvBps: 6000,
        expiryDays: 7,
        autoApprove: true,
        storage: mockStorage,
        provider: walletProvider,
        cfg,
      });
      assert.equal(
        bufferedOrderRes.order.collateralAmount,
        exact1000Buffered.collateralAmountRaw,
        'Buffered order must sign exact +5.00% buffered collateral raw amount'
      );
      const bufAllowMeta = await readBorrowAllowanceAndNonce(ADDRESSES.borrower, nvdac, { cfg });
      assert.equal(
        BigInt(bufAllowMeta.allowanceRaw),
        exact1000Buffered.requiredApprovalRaw,
        'Approve MUST grant exact buffered collateral amount + partial-fill ceiling slack'
      );
      // Approve enough to cover $800 fill on Order A + $500+$500 fills on Order B
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: nvdac,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.collateralEscrow, exact1000Buffered.collateralAmountRaw * 2n + 1_000n],
        }),
      });
      // Fill $800 partial fill on Order A (succeeds cleanly with +5% buffer!)
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: deployed.orderSettlement,
          abi: fillOrderAbi,
          functionName: 'fillBorrowOrder',
          args: [bufferedOrderRes.order, bufferedOrderRes.signature, 800_000_000n],
        }),
      });

      // Sign another $1000 buffered order and complete TWO consecutive $500 partial fills ($500 + $500 = $1000)
      const bufferedTwoPart = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '1000000000',
        minFillRaw: '500000000',
        maxRateBps: 900,
        termDays: 30,
        maxLtvBps: 6000,
        expiryDays: 7,
        autoApprove: false,
        storage: mockStorage,
        provider: walletProvider,
        cfg,
      });
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: deployed.orderSettlement,
          abi: fillOrderAbi,
          functionName: 'fillBorrowOrder',
          args: [bufferedTwoPart.order, bufferedTwoPart.signature, 500_000_000n],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: deployed.orderSettlement,
          abi: fillOrderAbi,
          functionName: 'fillBorrowOrder',
          args: [bufferedTwoPart.order, bufferedTwoPart.signature, 500_000_000n],
        }),
      });

      // Sign another $1000 buffered order, drop oracle by $0.01 ($140.00 -> $139.99), and prove $500 partial fill STILL passes!
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: nvdac,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.collateralEscrow, exact1000Buffered.requiredApprovalRaw],
        }),
      });
      const bufferedOrderPriceTick = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '1000000000',
        minFillRaw: '500000000',
        maxRateBps: 900,
        termDays: 30,
        maxLtvBps: 6000,
        expiryDays: 7,
        autoApprove: false,
        storage: mockStorage,
        provider: walletProvider,
        cfg,
      });
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [139_99000000n], // -$0.01 tick
        }),
      });
      try {
        await publicClient.waitForTransactionReceipt({
          hash: await lenderClient.writeContract({
            address: deployed.orderSettlement,
            abi: fillOrderAbi,
            functionName: 'fillBorrowOrder',
            args: [bufferedOrderPriceTick.order, bufferedOrderPriceTick.signature, 500_000_000n],
          }),
        });
      } finally {
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [140_00000000n],
          }),
        });
      }
      console.log('PASS M3: +5% collateral buffer prevents LtvExceeded on $800/$200/$500 partial fills and $0.01 price drops.');

      // M4: verifyAndPreviewLendOfferFill + pre-approve simulation catches errors BEFORE any ERC-20 approve tx
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: nvdac,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.collateralEscrow, 0n],
        }),
      });
      const expiredBlk = await publicClient.getBlock();
      const expiredOffer = {
        lender: ADDRESSES.lender,
        usdcAmount: 1_000_000_000n,
        minRateBps: 900,
        termDays: 30,
        allowedCollateral: nvdac,
        maxLtvBps: 6000,
        minFill: 500_000_000n,
        expiry: expiredBlk.timestamp - 60n,
        nonce: lenderNonce,
        yieldMode: 0,
      };
      const expiredOfferSig = await lenderAccount.signTypedData({
        domain: {
          name: ORDER_SETTLEMENT_DOMAIN_NAME,
          version: ORDER_SETTLEMENT_DOMAIN_VERSION,
          chainId: BASE_CHAIN_ID,
          verifyingContract: deployed.orderSettlement,
        },
        types: LEND_OFFER_EIP712_TYPES,
        primaryType: 'LendOffer',
        message: expiredOffer,
      });
      await assert.rejects(
        () =>
          fillLendOfferAsBorrower({
            address: ADDRESSES.borrower,
            offer: expiredOffer,
            signature: expiredOfferSig,
            collateralToken: nvdac,
            fillUsdcRaw: '500000000',
            autoApprove: true,
            provider: walletProvider,
            cfg,
          }),
        /OrderExpired/
      );
      const allowanceAfterRejectedFill = await readBorrowAllowanceAndNonce(ADDRESSES.borrower, nvdac, { cfg });
      assert.equal(
        allowanceAfterRejectedFill.allowanceRaw,
        '0',
        'Failed LendOffer pre-check/simulation MUST NOT trigger an ERC-20 approve tx'
      );

      // Remaining $450 on lendOffer rejects PRINCIPAL_BELOW_MINIMUM cleanly before approve
      await assert.rejects(
        () =>
          verifyAndPreviewLendOfferFill({
            offer: lendOffer,
            signature: lendOfferSig,
            collateralToken: nvdac,
            fillUsdcRaw: '450000000',
            borrowerAddress: ADDRESSES.borrower,
            cfg,
          }),
        /PRINCIPAL_BELOW_MINIMUM/
      );

      // Fresh open $1000 LendOffer + pre-approval preview verification ($500 fill)
      const freshBlk = await publicClient.getBlock();
      const freshOffer = {
        lender: ADDRESSES.lender,
        usdcAmount: 1_000_000_000n,
        minRateBps: 900,
        termDays: 30,
        allowedCollateral: nvdac,
        maxLtvBps: 6000,
        minFill: 500_000_000n,
        expiry: freshBlk.timestamp + 3600n,
        nonce: lenderNonce,
        yieldMode: 0,
      };
      const freshOfferSig = await lenderAccount.signTypedData({
        domain: {
          name: ORDER_SETTLEMENT_DOMAIN_NAME,
          version: ORDER_SETTLEMENT_DOMAIN_VERSION,
          chainId: BASE_CHAIN_ID,
          verifyingContract: deployed.orderSettlement,
        },
        types: LEND_OFFER_EIP712_TYPES,
        primaryType: 'LendOffer',
        message: freshOffer,
      });
      const previewValid = await verifyAndPreviewLendOfferFill({
        offer: freshOffer,
        signature: freshOfferSig,
        collateralToken: nvdac,
        fillUsdcRaw: '500000000',
        borrowerAddress: ADDRESSES.borrower,
        cfg,
      });
      assert.equal(previewValid.simulationVerified, true);
      assert.equal(previewValid.needsApproval, true);
      assert.equal(previewValid.fillAmountRaw, '500000000');

      // Warning PARTIAL_REMAINDER_BELOW_500 fires when partial fill on a $1000 offer leaves $400 (< $500)
      const warnPreview = await verifyAndPreviewLendOfferFill({
        offer: freshOffer,
        signature: freshOfferSig,
        collateralToken: nvdac,
        fillUsdcRaw: '600000000',
        borrowerAddress: ADDRESSES.borrower,
        cfg,
      });
      assert.ok(
        warnPreview.warnings.some((w: { code: string }) => w.code === 'PARTIAL_REMAINDER_BELOW_500'),
        'Preview must warn when remaining USDC after partial fill drops below $500'
      );
      console.log('PASS M4: verifyAndPreviewLendOfferFill + pre-approval eth_call simulation + revert decoding verified.');

      // M5: Persisted BorrowOrders survive, cancel from pasted JSON, and bumpMakerNonceOnChain invalidates open orders
      const persistedList = loadPersistedSignedOrders(mockStorage);
      assert.ok(persistedList.length >= 2);
      const parsedFromJson = parseBorrowOrderFromJson(
        JSON.stringify({
          order: bufferedOrderPriceTick.orderJson,
          signature: bufferedOrderPriceTick.signature,
        })
      );
      const cancelJsonRes = await cancelSignedBorrowOrder({
        address: ADDRESSES.borrower,
        order: parsedFromJson.order,
        storage: mockStorage,
        provider: walletProvider,
        cfg,
      });
      assert.ok(/^0x[0-9a-fA-F]{64}$/.test(cancelJsonRes.txHash));
      // Also cancel M3 partially-filled bufferedOrderRes so subsequent single-order autoApprove covers all open relay commitments
      await cancelSignedBorrowOrder({
        address: ADDRESSES.borrower,
        order: bufferedOrderRes.order,
        storage: mockStorage,
        provider: walletProvider,
        cfg,
      });

      const toBumpOrder = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '500000000',
        maxRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        expiryDays: 7,
        autoApprove: true,
        storage: mockStorage,
        provider: walletProvider,
        cfg,
      });
      assert.equal(toBumpOrder.publishedToApi, true);
      const bumpRes = await bumpMakerNonceOnChain({
        address: ADDRESSES.borrower,
        provider: walletProvider,
        cfg,
      });
      assert.equal(BigInt(bumpRes.newNonce) > toBumpOrder.order.nonce, true);

      const refreshedOrders = await refreshSignedBorrowOrdersState({
        orders: loadPersistedSignedOrders(mockStorage),
        cfg,
      });
      const bumpedLocal = refreshedOrders.find(
        (o: { orderHash: string }) => o.orderHash.toLowerCase() === toBumpOrder.orderHash.toLowerCase()
      );
      assert.equal(bumpedLocal?.onchainStatus, 'nonce_bumped', 'bumpNonce must mark earlier open orders as nonce_bumped');

      const apiAfterBump = await fetchPaginatedApiRows(`${cfg.apiUrl}/orders?maker=${ADDRESSES.borrower}&include_inactive=true`, { cfg });
      const bumpedApiRow = (apiAfterBump.rows as Array<{ order_hash: string; status: string }>).find(
        (r) => r.order_hash.toLowerCase() === toBumpOrder.orderHash.toLowerCase()
      );
      assert.equal(bumpedApiRow?.status, 'nonce_bumped');
      console.log('PASS M5: Orderbook POST /orders relay, persisted storage, paste-JSON cancel, & bumpNonce verified.');

      // Item 2: Multi-fill ERC-20 allowance covers ceil(totalUsdc/minFill) wei slack across 500+500 ($1000), 500x3 ($1500), 700+700+600 ($2000) without manual top-up
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: deployed.nostokTimelock,
          to: deployed.loanCore,
          data: encodeFunctionData({
            abi: parseAbi(['function setGlobalCap(uint128 newCap)']),
            functionName: 'setGlobalCap',
            args: [30_000_000_000n],
          }),
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: deployed.nostokTimelock,
          to: deployed.assetRegistry,
          data: encodeFunctionData({
            abi: [
              {
                type: 'function',
                name: 'setAssetConfig',
                stateMutability: 'nonpayable',
                inputs: [
                  { name: 'token', type: 'address' },
                  {
                    name: 'config',
                    type: 'tuple',
                    components: [
                      { name: 'feed', type: 'address' },
                      { name: 'feedDecimals', type: 'uint8' },
                      { name: 'tier', type: 'uint8' },
                      { name: 'maxInitLtvBps', type: 'uint16' },
                      { name: 'marginCallLtvBps', type: 'uint16' },
                      { name: 'liqLtvBps', type: 'uint16' },
                      { name: 'badDebtLtvBps', type: 'uint16' },
                      { name: 'maxDiscountBps', type: 'uint16' },
                      { name: 'closedMarketHaircutBps', type: 'uint16' },
                      { name: 'perLoanCap', type: 'uint128' },
                      { name: 'assetCap', type: 'uint128' },
                      { name: 'maxStaleOpenSecs', type: 'uint32' },
                      { name: 'status', type: 'uint8' },
                      { name: 'restricted', type: 'bool' },
                    ],
                  },
                ],
                outputs: [],
              },
            ],
            functionName: 'setAssetConfig',
            args: [
              nvdac,
              {
                feed: nvdaFeed,
                feedDecimals: 8,
                tier: 0,
                maxInitLtvBps: 6000,
                marginCallLtvBps: 7000,
                liqLtvBps: 7800,
                badDebtLtvBps: 9000,
                maxDiscountBps: 600,
                closedMarketHaircutBps: 500,
                perLoanCap: 3_000_000_000n,
                assetCap: 20_000_000_000n,
                maxStaleOpenSecs: 21600,
                status: 0,
                restricted: false,
              },
            ],
          }),
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [ADDRESSES.borrower, 200n * 10n ** 18n],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: BASE_USDC_WHALE,
          to: BASE_USDC,
          data: encodeFunctionData({
            abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']),
            functionName: 'transfer',
            args: [ADDRESSES.lender, 15_000_000_000n],
          }),
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: BASE_USDC,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.loanCore, 25_000_000_000n],
        }),
      });

      const multiFillCases = [
        { label: '500+500 of $1000', principalRaw: '1000000000', minFillRaw: '500000000', fills: [500_000_000n, 500_000_000n] },
        { label: '500x3 of $1500', principalRaw: '1500000000', minFillRaw: '500000000', fills: [500_000_000n, 500_000_000n, 500_000_000n] },
        { label: '700+700+600 of $2000', principalRaw: '2000000000', minFillRaw: '600000000', fills: [700_000_000n, 700_000_000n, 600_000_000n] },
      ];
      for (const mf of multiFillCases) {
        await publicClient.waitForTransactionReceipt({
          hash: await borrowerClient.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 0n],
          }),
        });
        const prep = await prepareAndSignBorrowOrder({
          address: ADDRESSES.borrower,
          collateralToken: nvdac,
          principalRaw: mf.principalRaw,
          minFillRaw: mf.minFillRaw,
          maxRateBps: 900,
          termDays: 30,
          maxLtvBps: 6000,
          expiryDays: 7,
          autoApprove: true,
          storage: mockStorage,
          provider: walletProvider,
          cfg,
        });
        assert.ok(prep.approvalTxHash, `${mf.label}: autoApprove must approve exact collateral + slack`);
        const expectedSlack = (BigInt(mf.principalRaw) + BigInt(mf.minFillRaw) - 1n) / BigInt(mf.minFillRaw);
        assert.equal(
          BigInt(prep.exactAmounts.requiredApprovalRaw),
          prep.order.collateralAmount + expectedSlack,
          `${mf.label}: allowance must include ceil(totalUsdc/minFill) wei slack`
        );
        for (const fillAmt of mf.fills) {
          await publicClient.waitForTransactionReceipt({
            hash: await lenderClient.writeContract({
              address: deployed.orderSettlement,
              abi: fillOrderAbi,
              functionName: 'fillBorrowOrder',
              args: [prep.order, prep.signature, fillAmt],
            }),
          });
        }
        const totalFilled = await publicClient.readContract({
          address: deployed.orderSettlement,
          abi: orderSettlementAbi,
          functionName: 'getOrderFilledAmount',
          args: [prep.orderHash],
        });
        assert.equal(totalFilled, BigInt(mf.principalRaw), `${mf.label}: final fill must succeed without ERC20InsufficientAllowance`);
      }
      console.log('PASS Item 2: Multi-fill BorrowOrders (500+500/$1000, 500x3/$1500, 700+700+600/$2000) all fill cleanly with autoApprove slack.');

      // M2 Frontend Pages + Low Borrow UI + Low vite build --mode guard
      const confirmPageHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/subscriptions/confirm?token=testtoken12345'] }, createElement(Shell, null, createElement(SubscriptionAction, { mode: 'confirm' })))
        )
      );
      assert.match(confirmPageHtml, /Confirm email subscription/);
      const blockPageHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/subscriptions/block?token=testtoken12345'] }, createElement(Shell, null, createElement(SubscriptionAction, { mode: 'block' })))
        )
      );
      assert.match(blockPageHtml, /Block this sender wallet only/);
      assert.match(blockPageHtml, /Block this address entirely \(all wallets\)/);
      assert.match(blockPageHtml, /does not stop existing verified subscriptions/i);

      const lendPageHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/lend'] }, createElement(Shell, null, createElement(Lend)))
        )
      );
      assert.ok(!/in-kind|inkind/i.test(lendPageHtml), 'Unused in-kind checkbox must be removed from Lend.jsx');
      const buildersPageHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/builders'] }, createElement(Shell, null, createElement(Builders)))
        )
      );
      assert.ok(!/in-kind|inKind/i.test(buildersPageHtml), 'Unused in-kind/inKind flag must be removed from Builders.jsx');

      const borrowPageHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/borrow'] }, createElement(Shell, null, createElement(Borrow)))
        )
      );
      assert.match(borrowPageHtml, /Collateral buffer \(%\)/);
      assert.match(borrowPageHtml, /Fixed APR \(%\)/);
      assert.match(borrowPageHtml, /EligibilityGate \(on-chain\)/);
      assert.match(borrowPageHtml, /Cancel all open orders \(bumpNonce/);
      assert.ok(!borrowPageHtml.includes('borrow-inkind'), 'Unused in-kind checkbox must be removed');
      assert.ok(!borrowPageHtml.includes('borrow-eligible'), 'Manual EligibilityGate checkbox must be removed');

      // Low: `vite build --mode development` MUST still enforce prod config validation & write _headers
      const tmpModeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostok-vite-mode-'));
      try {
        const modeBuildEnv: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: 'production',
          VITE_CHAIN_ID: '8453',
          VITE_RPC_URL: 'https://base-mainnet.private-rpc.example/v1/key',
          VITE_API_URL: 'https://api.nostok.xyz',
          VITE_NOTIFICATIONS_URL: 'https://notifications.nostok.xyz',
          VITE_RISK_URL: 'https://risk.nostok.xyz',
          VITE_LOAN_CORE_ADDRESS: deployed.loanCore,
          VITE_ORDER_SETTLEMENT_ADDRESS: deployed.orderSettlement,
          VITE_LIQUIDATION_AUCTION_ADDRESS: deployed.liquidationAuction,
          VITE_POSITION_NFT_ADDRESS: deployed.positionNFT,
          VITE_COLLATERAL_ESCROW_ADDRESS: deployed.collateralEscrow,
          VITE_ASSET_REGISTRY_ADDRESS: deployed.assetRegistry,
          VITE_ORACLE_ROUTER_ADDRESS: deployed.oracleRouter,
          VITE_ELIGIBILITY_GATE_ADDRESS: deployed.eligibilityGate,
        };
        const devModeBypassAttempt = spawnSync(
          viteBin,
          ['build', '--mode', 'development', '--outDir', path.join(tmpModeDir, 'bad-mode'), '--emptyOutDir'],
          {
            cwd: REPO_ROOT,
            env: { ...modeBuildEnv, NODE_ENV: 'development', VITE_CHAIN_ID: '1' },
            encoding: 'utf8',
          }
        );
        assert.notEqual(
          devModeBypassAttempt.status,
          0,
          'vite build --mode development MUST NOT bypass production config validation'
        );

        const goodHeadersOut = path.join(tmpModeDir, 'good-headers');
        const goodHeadersBuild = spawnSync(
          viteBin,
          ['build', '--outDir', goodHeadersOut, '--emptyOutDir'],
          { cwd: REPO_ROOT, env: modeBuildEnv, encoding: 'utf8' }
        );
        assert.equal(goodHeadersBuild.status, 0);
        const emittedHeaders = fs.readFileSync(path.join(goodHeadersOut, '_headers'), 'utf8');
        assert.match(emittedHeaders, /Content-Security-Policy:/);
        assert.match(emittedHeaders, /X-Content-Type-Options: nosniff/);
        assert.match(emittedHeaders, /X-Frame-Options: DENY/);
        assert.match(emittedHeaders, /Referrer-Policy: strict-origin-when-cross-origin/);
      } finally {
        fs.rmSync(tmpModeDir, { recursive: true, force: true });
      }
      console.log('PASS M2 Frontend + Low (SubscriptionAction, Borrow UI hardening, vite build --mode guard, _headers).');

      // 3.5 WS3.4 Piece 1: Lender exact raw bigint helpers, LoanCore USDC approval (including multi-fill sum),
      // prepareAndSignLendOffer + cancelSignedLendOffer, and verifyAndPreviewBorrowOrderFill / fillBorrowOrderAsLender -> PositionNFT ID.
      console.log('\n=== WS3.4 Piece 1: Lender primitives (exact raw bigints, LendOffer sign/cancel/multi-fill, BorrowOrder partial fill -> PositionNFT) ===');
      // Verify pure raw bigint helper invariants (no floats/display strings, sum of per-fill rounded-up amounts)
      assert.equal(sumRawBigints(['600000001', '700000001']), 1_300_000_002n);
      const multiLendSizing = computeLendApprovalAmountRaw('1300000000', {
        perFillUsdcRawList: ['600000000', '700000000'],
        existingOpenSumRaw: '500000000',
      });
      assert.equal(
        multiLendSizing.requiredApprovalRaw,
        1_800_000_000n,
        'Partial-fill lend allowance must cover existing open offers plus validated per-fill chunks'
      );
      // Low 1 & 2: Partial-fill plan validation rejects sums > offer/remaining, ANY chunk < max(minFill, $500),
      // and plans whose first entry is not the current fill; warns when a < $500 remainder is unfillable.
      assert.throws(
        () =>
          computeLendApprovalAmountRaw('1000000000', {
            perFillUsdcRawList: ['900000000', '900000000'],
          }),
        /exceeds offer\/remaining/
      );
      assert.throws(
        () =>
          computeLendApprovalAmountRaw('1300000000', {
            perFillUsdcRawList: ['600000001', '700000001'],
          }),
        /exceeds offer\/remaining/
      );
      assert.throws(
        () =>
          computeLendApprovalAmountRaw('1000000000', {
            perFillUsdcRawList: ['600000000', '400000000'],
          }),
        /PRINCIPAL_BELOW_MINIMUM/
      );
      assert.throws(
        () =>
          computeLendApprovalAmountRaw('1100000000', {
            perFillUsdcRawList: ['600000000', '500000000'],
            minFillRaw: '600000000',
          }),
        /below minimum fill/
      );
      assert.throws(
        () =>
          computeLendApprovalAmountRaw('700000000', {
            perFillUsdcRawList: ['500000000', '500000000'],
            maxAllowedTotalRaw: '1700000000',
          }),
        /first entry/
      );
      const unfillableRemPlan = computeLendApprovalAmountRaw('1000000000', {
        perFillUsdcRawList: ['600000000'],
        maxAllowedTotalRaw: '1000000000',
      });
      assert.equal(unfillableRemPlan.remainderAfterPlanRaw, 400_000_000n);
      assert.match(unfillableRemPlan.remainderWarning, /unfillable/i);
      assert.deepEqual(
        validateLendPartialFillPlan(['700000000', '700000000'], '1400000000', '600000000', {
          expectedFirstFillRaw: '700000000',
        }),
        [700_000_000n, 700_000_000n]
      );

      assert.equal(
        computeBorrowCollateralForFill(10_000_000_000_000_000_001n, 1_400_000_000n, 700_000_000n),
        5_000_000_000_000_000_001n,
        'computeBorrowCollateralForFill must match OrderSettlement.sol ceiling division'
      );

      // Top up lender USDC + borrower NVDAc + reset lender LoanCore allowance to 0n
      await rpcCall('anvil_impersonateAccount', [BASE_USDC_WHALE]);
      await rpcCall('anvil_setBalance', [BASE_USDC_WHALE, '0x56bc75e2d63100000']);
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: BASE_USDC_WHALE,
          to: BASE_USDC,
          data: encodeFunctionData({
            abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']),
            functionName: 'transfer',
            args: [ADDRESSES.lender, 25_000_000_000n],
          }),
        }),
      });
      await rpcCall('anvil_stopImpersonatingAccount', [BASE_USDC_WHALE]);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [ADDRESSES.borrower, 50n * 10n ** 18n],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: BASE_USDC,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.loanCore, 0n],
        }),
      });

      const lendMeta0 = await readLendAllowanceAndNonce(ADDRESSES.lender, { cfg });
      assert.equal(lendMeta0.allowanceRaw, '0');
      assert.equal(lendMeta0.spender.toLowerCase(), deployed.loanCore.toLowerCase());
      assert.equal(lendMeta0.decimals, 6);
      assert.ok(BigInt(lendMeta0.balanceRaw) >= 25_000_000_000n);

      // Build expected quote from api/ first using exact raw USDC integer ($1,300 = 1300000000 raw)
      const quote1300Lend = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '1300000000',
        termDays: 30,
        aprBps: 850,
        maxLtvBps: 6000,
        lender: ADDRESSES.lender,
      });
      assert.equal(quote1300Lend.accepted, true);
      const exactLend1300 = resolveExactLendAmounts(quote1300Lend, {
        minFillRaw: '500000000',
        perFillUsdcRawList: ['600000000', '700000000'],
      });
      assert.equal(exactLend1300.requiredApprovalRaw, 1_300_000_000n);

      const lendMemMap = new Map<string, string>();
      const lendStorage = {
        getItem: (k: string) => lendMemMap.get(k) ?? null,
        setItem: (k: string, v: string) => {
          lendMemMap.set(k, v);
        },
      };

      // Item 6: Signing a LendOffer without a live reviewed quote (expectedQuote = null) must be refused by default
      walletProvider.setAccount(KEYS.lender);
      await assert.rejects(
        () =>
          prepareAndSignLendOffer({
            address: ADDRESSES.lender,
            principalRaw: '1300000000',
            allowedCollateral: nvdac,
            expectedQuote: null,
            minRateBps: 850,
            termDays: 30,
            maxLtvBps: 6000,
            minFillRaw: '500000000',
            expiryDays: 7,
            provider: walletProvider,
            cfg,
          }),
        /No reviewed on-screen quote found/
      );

      // Stale quote guard before signing
      walletProvider.setAccount(KEYS.lender);
      await assert.rejects(
        () =>
          prepareAndSignLendOffer({
            address: ADDRESSES.lender,
            principalRaw: '1300000000',
            allowedCollateral: nvdac,
            expectedQuote: {
              ...quote1300Lend,
              amounts: {
                ...quote1300Lend.amounts,
                principal: { ...quote1300Lend.amounts.principal, raw: '1299999999' },
              },
            },
            minRateBps: 850,
            termDays: 30,
            maxLtvBps: 6000,
            minFillRaw: '500000000',
            expiryDays: 7,
            provider: walletProvider,
            cfg,
          }),
        /Quote changed before signing/
      );

      // Sign & approve exact partial-fill sum to LoanCore, publish LendOffer #1 ($1,300)
      const signedLend1 = await prepareAndSignLendOffer({
        address: ADDRESSES.lender,
        principalRaw: '1300000000',
        allowedCollateral: nvdac,
        expectedQuote: quote1300Lend,
        minRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        perFillUsdcRawList: ['600000000', '700000000'],
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: lendStorage,
        provider: walletProvider,
        cfg,
      });
      assert.ok(signedLend1.approvalTxHash, 'First LendOffer must submit exact USDC approve to LoanCore');
      assert.equal(signedLend1.publishedToApi, true, 'Signed LendOffer must auto-publish to api/');
      assert.equal(signedLend1.offer.usdcAmount, 1_300_000_000n);
      assert.equal(loadPersistedSignedLendOffers(lendStorage).length, 1);

      const postLendApproveMeta = await readLendAllowanceAndNonce(ADDRESSES.lender, { cfg });
      assert.equal(
        postLendApproveMeta.allowanceRaw,
        '1300000000',
        'LoanCore allowance must equal exact sum of validated partial-fill chunks (1300000000)'
      );
      const parsedLendJson = parseLendOfferFromJson(
        JSON.stringify({ order: signedLend1.offerJson, signature: signedLend1.signature, orderHash: signedLend1.orderHash })
      );
      assert.equal(parsedLendJson.order.usdcAmount, 1_300_000_000n);

      // Item 4: Refuse self-loans (lender === borrower) on LendOffer fill preview
      await assert.rejects(
        () =>
          verifyAndPreviewLendOfferFill({
            offer: signedLend1.offer,
            signature: signedLend1.signature,
            collateralToken: nvdac,
            fillUsdcRaw: '600000000',
            borrowerAddress: ADDRESSES.lender,
            cfg,
          }),
        /SelfLoanNotAllowed/
      );

      // Sign & cancel a second open LendOffer ($600 with allowedCollateral=zeroAddress + existingOpenUsdcSumRaw cumulative allowance!)
      const quote600Lend = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '600000000',
        termDays: 30,
        aprBps: 900,
        maxLtvBps: 6000,
        lender: ADDRESSES.lender,
      });
      assert.equal(quote600Lend.accepted, true);
      const signedLendCancel = await prepareAndSignLendOffer({
        address: ADDRESSES.lender,
        principalRaw: '600000000',
        expectedQuote: quote600Lend,
        minRateBps: 900,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        existingOpenUsdcSumRaw: '1300000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: lendStorage,
        provider: walletProvider,
        cfg,
      });
      assert.ok(signedLendCancel.approvalTxHash, 'Cumulative second LendOffer must raise LoanCore allowance to cover open sum');
      const cumMeta = await readLendAllowanceAndNonce(ADDRESSES.lender, { cfg });
      assert.equal(cumMeta.allowanceRaw, '1900000000');

      // Item 2: Verify parseLendOfferFromJson -> cancelSignedLendOffer({ offer: parsed.order }) cancels cleanly
      const parsedCancelJson = parseLendOfferFromJson(
        JSON.stringify({
          order: signedLendCancel.offerJson,
          signature: signedLendCancel.signature,
          orderHash: signedLendCancel.orderHash,
        })
      );
      const cancelLendRes = await cancelSignedLendOffer({
        address: ADDRESSES.lender,
        offer: parsedCancelJson.order,
        storage: lendStorage,
        provider: walletProvider,
        cfg,
      });
      assert.ok(cancelLendRes.txHash);
      const syncedLendStates = await refreshSignedLendOffersState({
        offers: loadPersistedSignedLendOffers(lendStorage),
        cfg,
      });
      assert.equal(syncedLendStates.find((o) => o.orderHash === signedLendCancel.orderHash)?.onchainStatus, 'cancelled');
      assert.equal(syncedLendStates.find((o) => o.orderHash === signedLend1.orderHash)?.onchainStatus, 'open');

      // Item 5: Post-cancel allowance reduction helper lowers excess allowance (1900000000 -> remaining open 1300000000)
      const postCancelMetaBefore = await readLendAllowanceAndNonce(ADDRESSES.lender, { cfg });
      assert.equal(postCancelMetaBefore.allowanceRaw, '1900000000');
      const reduceAfterCancel = await setUsdcAllowanceForLend({
        address: ADDRESSES.lender,
        targetAllowanceRaw: '1300000000',
        provider: walletProvider,
        cfg,
      });
      assert.equal(reduceAfterCancel.updated, true);
      assert.equal(reduceAfterCancel.allowanceRaw, '1300000000');

      // Multi-fill signedLend1 as borrower (600 + 700 = 1300 USDC)
      walletProvider.setAccount(KEYS.borrower);
      const lend1FillA = await fillLendOfferAsBorrower({
        address: ADDRESSES.borrower,
        offer: signedLend1.offer,
        signature: signedLend1.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '600000000',
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(lend1FillA.loanId);
      const lend1FillB = await fillLendOfferAsBorrower({
        address: ADDRESSES.borrower,
        offer: signedLend1.offer,
        signature: signedLend1.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '700000000',
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(lend1FillB.loanId && lend1FillB.loanId !== lend1FillA.loanId);
      const afterMultiLendSync = await refreshSignedLendOffersState({
        offers: [syncedLendStates.find((o) => o.orderHash === signedLend1.orderHash)],
        cfg,
      });
      assert.equal(afterMultiLendSync[0].onchainStatus, 'filled');

      // Lender fills an open BorrowOrder in two partial fills (700 + 700 of $1,400):
      // preview BEFORE approval -> exact multi-fill LoanCore approval -> partial fills -> PositionNFT verification!
      const borrowerQuote1400 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '1400000000',
        termDays: 30,
        aprBps: 950,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      assert.equal(borrowerQuote1400.accepted, true);
      const borrowOrder1400 = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '1400000000',
        expectedQuote: borrowerQuote1400,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '600000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        provider: walletProvider,
        cfg,
      });
      assert.equal(borrowOrder1400.publishedToApi, true);

      // Switch to lender and reset LoanCore USDC allowance to 0n before preview
      walletProvider.setAccount(KEYS.lender);
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: BASE_USDC,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.loanCore, 0n],
        }),
      });

      // Pre-approval verification & eth_call simulation succeeds even with allowance == 0n!
      const previewBorrowFill1 = await verifyAndPreviewBorrowOrderFill({
        order: borrowOrder1400.order,
        signature: borrowOrder1400.signature,
        fillUsdcRaw: '700000000',
        lenderAddress: ADDRESSES.lender,
        cfg,
      });
      assert.equal(previewBorrowFill1.needsApproval, true);
      assert.equal(previewBorrowFill1.simulationVerified, true);
      assert.equal(
        previewBorrowFill1.collateralForFillRaw,
        computeBorrowCollateralForFill(
          borrowOrder1400.order.collateralAmount,
          borrowOrder1400.order.minUsdc,
          '700000000'
        ).toString()
      );
      assert.ok(BigInt(previewBorrowFill1.exact.lenderNetInterestRaw) > 0n);

      // Invalid minFill must reject cleanly BEFORE any approve tx
      await assert.rejects(
        () =>
          verifyAndPreviewBorrowOrderFill({
            order: borrowOrder1400.order,
            signature: borrowOrder1400.signature,
            fillUsdcRaw: '500000000',
            lenderAddress: ADDRESSES.lender,
            cfg,
          }),
        /FillAmountTooLow/
      );

      // Item 4: Refuse self-loans (borrower === lender) on BorrowOrder fill preview
      await assert.rejects(
        () =>
          verifyAndPreviewBorrowOrderFill({
            order: borrowOrder1400.order,
            signature: borrowOrder1400.signature,
            fillUsdcRaw: '700000000',
            lenderAddress: ADDRESSES.borrower,
            cfg,
          }),
        /SelfLoanNotAllowed/
      );

      // Item 3 & Low 2: Partial-fill plan whose first entry != current fill OR whose sum exceeds remaining BorrowOrder must reject
      await assert.rejects(
        () =>
          fillBorrowOrderAsLender({
            address: ADDRESSES.lender,
            order: borrowOrder1400.order,
            signature: borrowOrder1400.signature,
            fillUsdcRaw: '700000000',
            perFillUsdcRawList: ['500000000', '500000000'],
            provider: walletProvider,
            cfg,
          }),
        /first entry/
      );
      await assert.rejects(
        () =>
          fillBorrowOrderAsLender({
            address: ADDRESSES.lender,
            order: borrowOrder1400.order,
            signature: borrowOrder1400.signature,
            fillUsdcRaw: '700000000',
            perFillUsdcRawList: ['700000000', '800000000'],
            provider: walletProvider,
            cfg,
          }),
        /exceeds offer\/remaining/
      );

      // Stale expectedPreview check must abort before fill
      await assert.rejects(
        () =>
          fillBorrowOrderAsLender({
            address: ADDRESSES.lender,
            order: borrowOrder1400.order,
            signature: borrowOrder1400.signature,
            fillUsdcRaw: '700000000',
            expectedPreview: { ...previewBorrowFill1, fillAmountRaw: '600000000' },
            provider: walletProvider,
            cfg,
          }),
        /Quote or BorrowOrder fill state changed since preview/
      );

      // Partial fill #1 ($700 of $1,400) approving cumulative sum ['700000000', '700000000'] = 1_400_000_000n to LoanCore
      const borrowFill1 = await fillBorrowOrderAsLender({
        address: ADDRESSES.lender,
        order: borrowOrder1400.order,
        signature: borrowOrder1400.signature,
        fillUsdcRaw: '700000000',
        perFillUsdcRawList: ['700000000', '700000000'],
        expectedPreview: previewBorrowFill1,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(borrowFill1.approvalTxHash, 'Partial fill #1 must approve cumulative multi-fill USDC sum');
      assert.equal(borrowFill1.requiredApprovalRaw, '1400000000');
      assert.ok(borrowFill1.loanId && borrowFill1.positionTokenId === borrowFill1.loanId);
      assert.equal(borrowFill1.positionOwner?.toLowerCase(), ADDRESSES.lender.toLowerCase());

      // Verify on-chain PositionNFT ownership for newly minted tokenId
      const nftOwner1 = await publicClient.readContract({
        address: deployed.positionNFT,
        abi: positionNftAbi,
        functionName: 'ownerOf',
        args: [BigInt(borrowFill1.positionTokenId!)],
      });
      assert.equal(nftOwner1.toLowerCase(), ADDRESSES.lender.toLowerCase());

      // Partial fill #2 ($700 remaining) reuses existing allowance without second approve tx!
      const borrowFill2 = await fillBorrowOrderAsLender({
        address: ADDRESSES.lender,
        order: borrowOrder1400.order,
        signature: borrowOrder1400.signature,
        fillUsdcRaw: '700000000',
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.equal(borrowFill2.approvalTxHash, null, 'Partial fill #2 must reuse existing LoanCore USDC allowance');
      assert.ok(borrowFill2.positionTokenId && borrowFill2.positionTokenId !== borrowFill1.positionTokenId);
      assert.equal(borrowFill2.positionOwner?.toLowerCase(), ADDRESSES.lender.toLowerCase());

      // Approve helper direct verification + reset to 0n (Item 5)
      const directAppRes = await approveUsdcForLend({
        address: ADDRESSES.lender,
        requiredUsdcRaw: 1_000_000n,
        provider: walletProvider,
        cfg,
      });
      assert.equal(directAppRes.approved, true);
      const resetZeroRes = await setUsdcAllowanceForLend({
        address: ADDRESSES.lender,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });
      assert.equal(resetZeroRes.allowanceRaw, '0');

      // Item 1 Medium (Repro A1): Open $1,000 LendOffer with 1000000000 allowance -> fill $600 BorrowOrder
      // Must raise allowance to 1600000000 (not skip approval!) leaving 1000000000 so the $1,000 LendOffer STILL fills in full!
      walletProvider.setAccount(KEYS.lender);
      const quote1000Lend = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '1000000000',
        termDays: 30,
        aprBps: 850,
        maxLtvBps: 6000,
        lender: ADDRESSES.lender,
      });
      assert.equal(quote1000Lend.accepted, true);
      const openOfferA1 = await prepareAndSignLendOffer({
        address: ADDRESSES.lender,
        principalRaw: '1000000000',
        allowedCollateral: nvdac,
        expectedQuote: quote1000Lend,
        minRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: lendStorage,
        provider: walletProvider,
        cfg,
      });
      assert.equal((await readLendAllowanceAndNonce(ADDRESSES.lender, { cfg })).allowanceRaw, '1000000000');

      walletProvider.setAccount(KEYS.borrower);
      const quote600BorrowA1 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '600000000',
        termDays: 30,
        aprBps: 950,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      const borrowOrderA1 = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '600000000',
        expectedQuote: quote600BorrowA1,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '600000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        provider: walletProvider,
        cfg,
      });

      walletProvider.setAccount(KEYS.lender);
      // Low 3: Even with storage = null AND existingOpenSumRaw omitted, resolveOpenLendOffersSumRaw MUST read relay open LendOffers!
      const previewA1RelayOnly = await verifyAndPreviewBorrowOrderFill({
        order: borrowOrderA1.order,
        signature: borrowOrderA1.signature,
        fillUsdcRaw: '600000000',
        lenderAddress: ADDRESSES.lender,
        storage: null,
        cfg,
      });
      assert.equal(
        previewA1RelayOnly.existingOpenSumRaw,
        '1000000000',
        'Relay-only open LendOffer ($1,000) must be included when storage & existingOpenSumRaw are omitted'
      );
      assert.equal(previewA1RelayOnly.requiredApprovalRaw, '1600000000');

      const previewA1 = await verifyAndPreviewBorrowOrderFill({
        order: borrowOrderA1.order,
        signature: borrowOrderA1.signature,
        fillUsdcRaw: '600000000',
        lenderAddress: ADDRESSES.lender,
        storage: lendStorage,
        cfg,
      });
      assert.equal(previewA1.existingOpenSumRaw, '1000000000');
      assert.equal(previewA1.requiredApprovalRaw, '1600000000');
      assert.equal(previewA1.needsApproval, true, 'Fill $600 with open $1,000 LendOffer must still require LoanCore approval up to 1600000000');

      const fillA1Res = await fillBorrowOrderAsLender({
        address: ADDRESSES.lender,
        order: borrowOrderA1.order,
        signature: borrowOrderA1.signature,
        fillUsdcRaw: '600000000',
        expectedPreview: previewA1,
        storage: null,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(fillA1Res.approvalTxHash, 'Repro A1 must submit cumulative approve(1600000000) before filling $600');
      assert.equal(fillA1Res.requiredApprovalRaw, '1600000000');
      assert.equal(
        (await readLendAllowanceAndNonce(ADDRESSES.lender, { cfg })).allowanceRaw,
        '1000000000',
        'After $600 fill, LoanCore allowance must still equal 1000000000 for open $1,000 LendOffer'
      );

      walletProvider.setAccount(KEYS.borrower);
      const fillOpenOfferA1 = await fillLendOfferAsBorrower({
        address: ADDRESSES.borrower,
        offer: openOfferA1.offer,
        signature: openOfferA1.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '1000000000',
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(fillOpenOfferA1.loanId, 'Open $1,000 LendOffer must still fill in full after $600 BorrowOrder fill');

      // Item 1 Medium (Repro A2): Open $700 LendOffer with 700000000 allowance -> fill $900 BorrowOrder
      // Must approve 1600000000 (not overwrite with 900000000!), leaving 700000000 so the $700 LendOffer still fills!
      walletProvider.setAccount(KEYS.lender);
      await setUsdcAllowanceForLend({
        address: ADDRESSES.lender,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });
      const quote700Lend = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '700000000',
        termDays: 30,
        aprBps: 850,
        maxLtvBps: 6000,
        lender: ADDRESSES.lender,
      });
      const openOfferA2 = await prepareAndSignLendOffer({
        address: ADDRESSES.lender,
        principalRaw: '700000000',
        allowedCollateral: nvdac,
        expectedQuote: quote700Lend,
        minRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '700000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: lendStorage,
        provider: walletProvider,
        cfg,
      });
      assert.equal((await readLendAllowanceAndNonce(ADDRESSES.lender, { cfg })).allowanceRaw, '700000000');

      walletProvider.setAccount(KEYS.borrower);
      const quote900BorrowA2 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '900000000',
        termDays: 30,
        aprBps: 950,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      const borrowOrderA2 = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '900000000',
        expectedQuote: quote900BorrowA2,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '900000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        provider: walletProvider,
        cfg,
      });

      walletProvider.setAccount(KEYS.lender);
      const fillA2Res = await fillBorrowOrderAsLender({
        address: ADDRESSES.lender,
        order: borrowOrderA2.order,
        signature: borrowOrderA2.signature,
        fillUsdcRaw: '900000000',
        existingOpenSumRaw: '700000000',
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.equal(fillA2Res.requiredApprovalRaw, '1600000000');
      assert.equal(
        (await readLendAllowanceAndNonce(ADDRESSES.lender, { cfg })).allowanceRaw,
        '700000000',
        'After $900 fill, LoanCore allowance must equal 700000000 (not 0!) so open $700 LendOffer remains fillable'
      );

      walletProvider.setAccount(KEYS.borrower);
      const fillOpenOfferA2 = await fillLendOfferAsBorrower({
        address: ADDRESSES.borrower,
        offer: openOfferA2.offer,
        signature: openOfferA2.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '700000000',
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(fillOpenOfferA2.loanId, 'Open $700 LendOffer must still fill cleanly after $900 BorrowOrder fill');

      // Item 9 (Small hardening): PositionNFT owner mismatch after fill must throw an explicit error
      const quote500Mismatch = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '500000000',
        termDays: 30,
        aprBps: 950,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      const borrowOrderMismatch = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '500000000',
        expectedQuote: quote500Mismatch,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        provider: walletProvider,
        cfg,
      });
      walletProvider.setAccount(KEYS.lender);
      const mismatchClient = new Proxy(publicClient, {
        get(target, prop, receiver) {
          if (prop === 'readContract') {
            return async (args: { functionName?: string; address?: string }) => {
              if (
                args?.functionName === 'ownerOf' &&
                args?.address?.toLowerCase() === deployed.positionNFT.toLowerCase()
              ) {
                return ADDRESSES.borrower;
              }
              return target.readContract(args as never);
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      await assert.rejects(
        () =>
          fillBorrowOrderAsLender({
            address: ADDRESSES.lender,
            order: borrowOrderMismatch.order,
            signature: borrowOrderMismatch.signature,
            fillUsdcRaw: '500000000',
            autoApprove: true,
            provider: walletProvider,
            publicClient: mismatchClient as never,
            cfg,
          }),
        /PositionNFT owner mismatch/
      );

      // Low 1 & Low 4: Remainder < $500 preview warning states unfillable, and unknown persisted offer state fails closed!
      walletProvider.setAccount(KEYS.borrower);
      const quote1000Rem = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '1000000000',
        termDays: 30,
        aprBps: 950,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      const borrowOrder1000Rem = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '1000000000',
        expectedQuote: quote1000Rem,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        provider: walletProvider,
        cfg,
      });
      walletProvider.setAccount(KEYS.lender);
      const remWarnPreview = await verifyAndPreviewBorrowOrderFill({
        order: borrowOrder1000Rem.order,
        signature: borrowOrder1000Rem.signature,
        fillUsdcRaw: '600000000',
        lenderAddress: ADDRESSES.lender,
        existingOpenSumRaw: '0',
        cfg,
      });
      const lowRemWarn = remWarnPreview.warnings.find((w) => w.code === 'PARTIAL_REMAINDER_BELOW_500');
      assert.ok(lowRemWarn && /unfillable/i.test(lowRemWarn.message), 'Remainder < $500 preview warning must explain it is unfillable on-chain');

      const rpcFailClient = new Proxy(publicClient, {
        get(target, prop) {
          if (prop === 'readContract') {
            return async (args: { functionName?: string }) => {
              if (args?.functionName === 'hashLendOffer') {
                throw new Error('simulated RPC timeout');
              }
              return target.readContract(args as never);
            };
          }
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      await assert.rejects(
        () =>
          verifyAndPreviewBorrowOrderFill({
            order: borrowOrder1000Rem.order,
            signature: borrowOrder1000Rem.signature,
            fillUsdcRaw: '1000000000',
            lenderAddress: ADDRESSES.lender,
            storage: lendStorage,
            publicClient: rpcFailClient as never,
            cfg,
          }),
        /Cannot verify open LendOffer/
      );

      // Verify indexer/API reflects new loans and lender's newly minted PositionNFT IDs
      await runIndexerSync(idxCtx);
      const ws34PosRes = await fetchPaginatedApiRows(`${cfg.apiUrl}/positions?owner=${ADDRESSES.lender}`, { cfg });
      const ws34PosRows = ws34PosRes.rows as Array<{ token_id?: string | number; loan_id?: string | number }>;
      assert.ok(
        ws34PosRows.some((p) => String(p.loan_id ?? p.token_id) === borrowFill1.positionTokenId) &&
          ws34PosRows.some((p) => String(p.loan_id ?? p.token_id) === borrowFill2.positionTokenId),
        'Indexer /positions must include both newly minted PositionNFT token IDs from partial BorrowOrder fills'
      );

      walletProvider.setAccount(KEYS.borrower);
      console.log('PASS WS3.4 Piece 1: Lend primitives (exact raw bigints, LendOffer sign/cancel/multi-fill, BorrowOrder partial fills -> PositionNFT IDs, cumulative open-offer allowance & Item 1-6/9 fixes) verified.');

      // 3.6 WS3.4 Piece 2: Live Lend.jsx UI verification (no PreviewBanner/mock assets, live LoanCore/Quote/BorrowOrder fill controls)
      console.log('\n=== WS3.4 Piece 2: Live Lend.jsx UI verification ===');
      const liveLendHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/lend'] }, createElement(Shell, null, createElement(Lend)))
        )
      );
      assert.ok(
        !liveLendHtml.includes('Preview data, not your positions'),
        'Live WS3.4 /lend page must no longer show static PreviewBanner'
      );
      assert.ok(!/in-kind|inkind/i.test(liveLendHtml), 'Unused in-kind checkbox must remain absent on Lend.jsx');
      assert.match(liveLendHtml, /LoanCore \(USDC spender\)/);
      assert.match(liveLendHtml, /EligibilityGate \(on-chain\)/);
      assert.match(liveLendHtml, /Planned partial-fill chunks/);
      assert.match(liveLendHtml, /1\. Simulate live quote/);
      assert.match(liveLendHtml, /2\. Approve \/ verify LoanCore allowance/);
      assert.match(liveLendHtml, /3\. Sign &amp; publish LendOffer/);
      assert.match(liveLendHtml, /Bump maker nonce/);
      assert.match(liveLendHtml, /Fill open BorrowOrders \(mint PositionNFT\)/);
      assert.match(liveLendHtml, /1\. Verify &amp; preview BorrowOrder fill/);
      // Item 6 SSR check: Approve & Sign buttons render disabled without a displayed quoteResult
      assert.match(
        liveLendHtml,
        /<button[^>]*disabled=""[^>]*>2\. Approve \/ verify LoanCore allowance<\/button>/
      );
      assert.match(
        liveLendHtml,
        /<button[^>]*disabled=""[^>]*>3\. Sign &amp; publish LendOffer<\/button>/
      );
      // Item 7 + Lows 2, 4, 5 UI source guard check: account/chain switch useEffect resets preview/quote/action states,
      // BorrowOrder preview uses request sequence guard, unknown offer states block reduction & plan hint clarifies current fill first
      const lendSrc = fs.readFileSync(path.join(process.cwd(), 'src/pages/Lend.jsx'), 'utf8');
      assert.ok(
        lendSrc.includes('[web3?.address, web3?.chainId, web3?.wrongNetwork]') &&
          lendSrc.includes('borrowPreviewSeqRef.current') &&
          lendSrc.includes('blockedByUnknown') &&
          lendSrc.includes('isNonFinalOrderStatus(st)') &&
          lendSrc.includes("st === 'unknown'") &&
          lendSrc.includes('includes current fill first') &&
          lendSrc.includes('setBorrowPreview(null)') &&
          lendSrc.includes('setQuoteResult(null)') &&
          lendSrc.includes('setUsdcAllowanceForLend'),
        'Lend.jsx must enforce account/network resets, BorrowOrder preview seq guard, conservative unknown-status handling, and clear fill-plan labels'
      );
      console.log('PASS WS3.4 Piece 2: Live Lend.jsx SSR, LoanCore approval, LendOffer sign/cancel, & BorrowOrder fill UI verified.');

      // 3.7 WS3.4 Piece 3: Borrower-side LendOffer fill parity, cumulative CollateralEscrow allowance, lossless raw pill math & guards
      console.log('\n=== WS3.4 Piece 3: Borrower LendOffer fill & cumulative CollateralEscrow hardening ===');
      const borrowCumSizing = computeBorrowApprovalAmountRaw('10000000000000000000', '1000000000', '500000000', {
        existingOpenCollateralRaw: '5000000000000000000',
        perFillUsdcRawList: ['500000000', '500000000'],
      });
      assert.equal(
        borrowCumSizing.requiredApprovalRaw,
        15_000_000_000_000_000_002n,
        'Borrow approval sizing must add existing open BorrowOrders collateral + signed collateral + per-fill slack'
      );
      assert.equal(
        computeRemainingBorrowCollateralRequirement('10000000000000000000', '1000000000', '500000000', '600000000'),
        6_000_000_000_000_000_002n,
        'Remaining collateral requirement for partially filled BorrowOrder must cover pro-rata ceil + remaining slack'
      );

      // Clean slate for borrower Piece 3 A1/A2 tests (top up NVDAc + bump old test BorrowOrders)
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [ADDRESSES.borrower, 50n * 10n ** 18n],
        }),
      });
      walletProvider.setAccount(KEYS.borrower);
      await bumpMakerNonceOnChain({ address: ADDRESSES.borrower, provider: walletProvider, cfg });
      await runIndexerSync(idxCtx);

      // Require expectedQuote when requireExpectedQuote: true
      await assert.rejects(
        () =>
          prepareAndSignBorrowOrder({
            address: ADDRESSES.borrower,
            collateralToken: nvdac,
            principalRaw: '600000000',
            expectedQuote: null,
            requireExpectedQuote: true,
            maxRateBps: 900,
            termDays: 30,
            maxLtvBps: 6000,
            minFillRaw: '600000000',
            expiryDays: 7,
            provider: walletProvider,
            cfg,
          }),
        /No reviewed on-screen quote found/
      );

      // Lender creates two open LendOffers for Borrower Repro A1 ($600) and A2 ($900)
      walletProvider.setAccount(KEYS.lender);
      const p3LendQuote600 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '600000000',
        termDays: 30,
        aprBps: 850,
        maxLtvBps: 6000,
        lender: ADDRESSES.lender,
      });
      const p3LendOffer600 = await prepareAndSignLendOffer({
        address: ADDRESSES.lender,
        principalRaw: '600000000',
        allowedCollateral: nvdac,
        expectedQuote: p3LendQuote600,
        minRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '600000000',
        existingOpenUsdcSumRaw: '0',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        provider: walletProvider,
        cfg,
      });
      const p3LendQuote900 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '900000000',
        termDays: 30,
        aprBps: 850,
        maxLtvBps: 6000,
        lender: ADDRESSES.lender,
      });
      const p3LendOffer900 = await prepareAndSignLendOffer({
        address: ADDRESSES.lender,
        principalRaw: '900000000',
        allowedCollateral: nvdac,
        expectedQuote: p3LendQuote900,
        minRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '900000000',
        existingOpenUsdcSumRaw: '600000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        provider: walletProvider,
        cfg,
      });

      // Borrower Repro A1: open relayed $1,000 BorrowOrder (with exact CollateralEscrow allowance) -> fill $600 LendOffer
      // with storage: null & existingOpenCollateralRaw omitted -> must detect relay BorrowOrder, approve cumulative
      // open + fill600, so open $1,000 BorrowOrder STILL fills cleanly afterwards!
      walletProvider.setAccount(KEYS.borrower);
      await setCollateralAllowanceForBorrow({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });
      const p3BorrowStorage = new Map<string, string>();
      const borrowStorageApi = {
        getItem: (k: string) => p3BorrowStorage.get(k) ?? null,
        setItem: (k: string, v: string) => {
          p3BorrowStorage.set(k, v);
        },
      };
      const p3BorrowQuote1000 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '1000000000',
        termDays: 30,
        aprBps: 950,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      const openBorrowP3A1 = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '1000000000',
        expectedQuote: p3BorrowQuote1000,
        requireExpectedQuote: true,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: borrowStorageApi,
        provider: walletProvider,
        cfg,
      });
      assert.equal(openBorrowP3A1.publishedToApi, true);
      const openBorrowReq1000 = BigInt(openBorrowP3A1.exactAmounts.requiredApprovalRaw);

      // Preview filling $600 LendOffer WITHOUT passing storage or existingOpenCollateralRaw -> reads relay!
      const previewBorrowP3A1 = await verifyAndPreviewLendOfferFill({
        offer: p3LendOffer600.offer,
        signature: p3LendOffer600.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '600000000',
        borrowerAddress: ADDRESSES.borrower,
        storage: null,
        cfg,
      });
      assert.equal(
        previewBorrowP3A1.existingOpenCollateralRaw,
        openBorrowReq1000.toString(),
        'verifyAndPreviewLendOfferFill must automatically include relay-only open BorrowOrder collateral'
      );
      assert.equal(
        previewBorrowP3A1.requiredApprovalRaw,
        (openBorrowReq1000 + previewBorrowP3A1.exact.collateralAmountRaw).toString()
      );
      assert.equal(previewBorrowP3A1.needsApproval, true);

      // Unknown BorrowOrder status fail-closed: RPC failure on persisted BorrowOrder must refuse preview cleanly
      const rpcBorrowFailClient = new Proxy(publicClient, {
        get(target, prop) {
          if (prop === 'readContract') {
            return async (args: { functionName?: string }) => {
              if (args?.functionName === 'hashBorrowOrder') {
                throw new Error('simulated RPC timeout');
              }
              return target.readContract(args as never);
            };
          }
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      await assert.rejects(
        () =>
          verifyAndPreviewLendOfferFill({
            offer: p3LendOffer600.offer,
            signature: p3LendOffer600.signature,
            collateralToken: nvdac,
            fillUsdcRaw: '600000000',
            borrowerAddress: ADDRESSES.borrower,
            storage: borrowStorageApi,
            publicClient: rpcBorrowFailClient as never,
            cfg,
          }),
        /Cannot verify open BorrowOrder/
      );

      const fillBorrowP3A1 = await fillLendOfferAsBorrower({
        address: ADDRESSES.borrower,
        offer: p3LendOffer600.offer,
        signature: p3LendOffer600.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '600000000',
        expectedPreview: previewBorrowP3A1,
        storage: null,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(fillBorrowP3A1.loanId);
      assert.ok(fillBorrowP3A1.approvalTxHash, 'Borrower Repro A1 must raise CollateralEscrow allowance to open + fill');
      const postA1BorrowAllow = BigInt((await readBorrowAllowanceAndNonce(ADDRESSES.borrower, nvdac, { cfg })).allowanceRaw);
      assert.equal(
        postA1BorrowAllow,
        openBorrowReq1000,
        'After $600 LendOffer fill, CollateralEscrow allowance must still preserve exact open $1,000 BorrowOrder requirement'
      );

      // Lender fills the open $1,000 BorrowOrder in two $500 fills -> succeeds cleanly without ERC20InsufficientAllowance!
      walletProvider.setAccount(KEYS.lender);
      await approveUsdcForLend({
        address: ADDRESSES.lender,
        requiredUsdcRaw: '2000000000',
        provider: walletProvider,
        cfg,
      });
      await fillBorrowOrderAsLender({
        address: ADDRESSES.lender,
        order: openBorrowP3A1.order,
        signature: openBorrowP3A1.signature,
        fillUsdcRaw: '500000000',
        perFillUsdcRawList: ['500000000', '500000000'],
        existingOpenSumRaw: '900000000',
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      await fillBorrowOrderAsLender({
        address: ADDRESSES.lender,
        order: openBorrowP3A1.order,
        signature: openBorrowP3A1.signature,
        fillUsdcRaw: '500000000',
        existingOpenSumRaw: '900000000',
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });

      // Borrower Repro A2: smaller open $600 BorrowOrder -> larger $900 LendOffer fill must approve (open600 + fill900), NOT overwrite to fill900!
      walletProvider.setAccount(KEYS.borrower);
      await setCollateralAllowanceForBorrow({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });
      const p3BorrowQuote600 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '600000000',
        termDays: 30,
        aprBps: 950,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      const openBorrowP3A2 = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '600000000',
        expectedQuote: p3BorrowQuote600,
        requireExpectedQuote: true,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '600000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: borrowStorageApi,
        provider: walletProvider,
        cfg,
      });
      const openBorrowReq600 = BigInt(openBorrowP3A2.exactAmounts.requiredApprovalRaw);

      const fillBorrowP3A2 = await fillLendOfferAsBorrower({
        address: ADDRESSES.borrower,
        offer: p3LendOffer900.offer,
        signature: p3LendOffer900.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '900000000',
        existingOpenCollateralRaw: openBorrowReq600,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(fillBorrowP3A2.loanId);
      assert.equal(
        (await readBorrowAllowanceAndNonce(ADDRESSES.borrower, nvdac, { cfg })).allowanceRaw,
        openBorrowReq600.toString(),
        'After $900 LendOffer fill, CollateralEscrow allowance must still equal open $600 BorrowOrder requirement'
      );

      // Lender fills open $600 BorrowOrder cleanly
      walletProvider.setAccount(KEYS.lender);
      await fillBorrowOrderAsLender({
        address: ADDRESSES.lender,
        order: openBorrowP3A2.order,
        signature: openBorrowP3A2.signature,
        fillUsdcRaw: '600000000',
        existingOpenSumRaw: '0',
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });

      // Post-cancel CollateralEscrow allowance reduction to 0
      walletProvider.setAccount(KEYS.borrower);
      await setCollateralAllowanceForBorrow({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });
      const borrowCancelP3 = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '600000000',
        expectedQuote: p3BorrowQuote600,
        requireExpectedQuote: true,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '600000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: borrowStorageApi,
        provider: walletProvider,
        cfg,
      });

      await cancelSignedBorrowOrder({
        address: ADDRESSES.borrower,
        order: borrowCancelP3.order,
        storage: borrowStorageApi,
        provider: walletProvider,
        cfg,
      });
      const reducedCollRes = await setCollateralAllowanceForBorrow({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });
      assert.equal(reducedCollRes.allowanceRaw, '0');

      // Borrow.jsx Piece 3 SSR & UI hardening checks
      const liveBorrowHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/borrow'] }, createElement(Shell, null, createElement(Borrow)))
        )
      );
      assert.match(
        liveBorrowHtml,
        /<button[^>]*disabled=""[^>]*>2\. Approve \/ verify allowance<\/button>/
      );
      assert.match(
        liveBorrowHtml,
        /<button[^>]*disabled=""[^>]*>3\. Sign &amp; publish BorrowOrder<\/button>/
      );
      const borrowSrc = fs.readFileSync(path.join(process.cwd(), 'src/pages/Borrow.jsx'), 'utf8');
      const p3LendSrc = fs.readFileSync(path.join(process.cwd(), 'src/pages/Lend.jsx'), 'utf8');
      assert.ok(
        borrowSrc.includes('selectedLendRemainingRaw') &&
          borrowSrc.includes('formatUnits(BigInt(rawRemaining), USDC_DECIMALS)') &&
          borrowSrc.includes('lendPreviewSeqRef.current') &&
          borrowSrc.includes('[web3?.address, web3?.chainId, web3?.wrongNetwork]') &&
          borrowSrc.includes('setLendPreview(null)') &&
          borrowSrc.includes('setCollateralAllowanceForBorrow') &&
          borrowSrc.includes('collateralReductionState') &&
          borrowSrc.includes('blockedByUnknown') &&
          borrowSrc.includes('requireExpectedQuote: true') &&
          borrowSrc.includes('existingOpenCollateralRaw: null') &&
          borrowSrc.includes('ordersTruncated') &&
          borrowSrc.includes('removeSignedBorrowOrder') &&
          p3LendSrc.includes('existingOpenUsdcSumRaw: null') &&
          p3LendSrc.includes('existingOpenSumRaw: null') &&
          p3LendSrc.includes('ordersTruncated') &&
          p3LendSrc.includes('removeSignedLendOffer'),
        'Borrow.jsx and Lend.jsx must enforce lossless raw pill fill, preview seq guard, account/network reset, quote requirement, maker-scoped open sums, truncated guard & corrupt order removal'
      );

      // Raise globalCap & NVDAc assetCap so M1 Borrow+Lend fork suites have ample headroom
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: deployed.nostokTimelock,
          to: deployed.loanCore,
          data: encodeFunctionData({
            abi: parseAbi(['function setGlobalCap(uint128 newCap)']),
            functionName: 'setGlobalCap',
            args: [50_000_000_000n],
          }),
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: deployed.nostokTimelock,
          to: deployed.assetRegistry,
          data: encodeFunctionData({
            abi: [
              {
                type: 'function',
                name: 'setAssetConfig',
                stateMutability: 'nonpayable',
                inputs: [
                  { name: 'token', type: 'address' },
                  {
                    name: 'config',
                    type: 'tuple',
                    components: [
                      { name: 'feed', type: 'address' },
                      { name: 'feedDecimals', type: 'uint8' },
                      { name: 'tier', type: 'uint8' },
                      { name: 'maxInitLtvBps', type: 'uint16' },
                      { name: 'marginCallLtvBps', type: 'uint16' },
                      { name: 'liqLtvBps', type: 'uint16' },
                      { name: 'badDebtLtvBps', type: 'uint16' },
                      { name: 'maxDiscountBps', type: 'uint16' },
                      { name: 'closedMarketHaircutBps', type: 'uint16' },
                      { name: 'perLoanCap', type: 'uint128' },
                      { name: 'assetCap', type: 'uint128' },
                      { name: 'maxStaleOpenSecs', type: 'uint32' },
                      { name: 'status', type: 'uint8' },
                      { name: 'restricted', type: 'bool' },
                    ],
                  },
                ],
                outputs: [],
              },
            ],
            functionName: 'setAssetConfig',
            args: [
              nvdac,
              {
                feed: nvdaFeed,
                feedDecimals: 8,
                tier: 0,
                maxInitLtvBps: 6000,
                marginCallLtvBps: 7000,
                liqLtvBps: 7800,
                badDebtLtvBps: 9000,
                maxDiscountBps: 600,
                closedMarketHaircutBps: 500,
                perLoanCap: 3_000_000_000n,
                assetCap: 40_000_000_000n,
                maxStaleOpenSecs: 21600,
                status: 0,
                restricted: false,
              },
            ],
          }),
        }),
      });

      // M1 (Borrow & Lend): Unfunded open orders hidden from default /orders MUST remain in allowance sums & post-cancel targets
      const erc20TestAbi = parseAbi([
        'function balanceOf(address owner) view returns (uint256)',
        'function transfer(address to, uint256 value) returns (bool)',
      ]);
      const clearStorage = (storageMap: Map<string, string>) => storageMap.clear();
      clearStorage(p3BorrowStorage);

      // --- M1 Borrow side ---
      walletProvider.setAccount(KEYS.borrower);
      await setCollateralAllowanceForBorrow({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });
      const m1BorrowQuote1000 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '1000000000',
        termDays: 30,
        aprBps: 950,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      const m1OpenBorrow = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '1000000000',
        expectedQuote: m1BorrowQuote1000,
        requireExpectedQuote: true,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '1000000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: borrowStorageApi,
        provider: walletProvider,
        cfg,
      });
      assert.equal(m1OpenBorrow.publishedToApi, true);
      const m1OpenBorrowColl = BigInt(m1OpenBorrow.exactAmounts.requiredApprovalRaw);

      walletProvider.setAccount(KEYS.lender);
      const m1LendQuote500 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '500000000',
        termDays: 30,
        aprBps: 850,
        maxLtvBps: 6000,
      });
      const m1Lend500 = await prepareAndSignLendOffer({
        address: ADDRESSES.lender,
        principalRaw: '500000000',
        allowedCollateral: nvdac,
        expectedQuote: m1LendQuote500,
        minRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        existingOpenUsdcSumRaw: '0',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        provider: walletProvider,
        cfg,
      });
      const tmpM1BorrowPreview = await verifyAndPreviewLendOfferFill({
        offer: m1Lend500.offer,
        signature: m1Lend500.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '500000000',
        cfg,
      });
      const m1Fill500Coll = tmpM1BorrowPreview.exact.collateralAmountRaw;
      assert.ok(m1Fill500Coll < m1OpenBorrowColl);

      // Dip borrower's NVDAc balance to JUST m1Fill500Coll -> $1,000 BorrowOrder becomes 'unfunded' and hidden from default GET /orders
      const borNvdacInit = await publicClient.readContract({
        address: nvdac,
        abi: erc20TestAbi,
        functionName: 'balanceOf',
        args: [ADDRESSES.borrower],
      });
      const nvdacParked = borNvdacInit - m1Fill500Coll;
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: nvdac,
          abi: erc20TestAbi,
          functionName: 'transfer',
          args: [ADDRESSES.lender, nvdacParked],
        }),
      });
      await rpcCall('evm_mine', []);

      const m1BorDef = (await fetch(`${cfg.apiUrl}/orders?order_type=borrow&maker=${ADDRESSES.borrower}`).then((r) =>
        r.json()
      )) as { data: Array<{ order_hash: string; status: string }> };
      assert.ok(
        !m1BorDef.data.some((r) => r.order_hash.toLowerCase() === m1OpenBorrow.orderHash.toLowerCase()),
        'Unfunded BorrowOrder must be hidden from default GET /orders'
      );
      const m1BorAll = (await fetch(
        `${cfg.apiUrl}/orders?order_type=borrow&maker=${ADDRESSES.borrower}&include_inactive=true`
      ).then((r) => r.json())) as { data: Array<{ order_hash: string; status: string }> };
      assert.equal(
        m1BorAll.data.find((r) => r.order_hash.toLowerCase() === m1OpenBorrow.orderHash.toLowerCase())?.status,
        'unfunded'
      );

      // While unfunded & hidden: post-cancel target and fill preview BOTH still reserve m1OpenBorrowColl!
      assert.equal(
        await resolveOpenBorrowOrdersCollateralSumRaw({
          borrowerAddress: ADDRESSES.borrower,
          collateralToken: nvdac,
          existingOpenCollateralRaw: null,
          excludeHashes: new Set(['0x' + '11'.repeat(32)]),
          storage: null,
          cfg,
        }),
        m1OpenBorrowColl,
        'Borrow post-cancel target must count unfunded non-final BorrowOrders'
      );
      const m1BorPrev = await verifyAndPreviewLendOfferFill({
        offer: m1Lend500.offer,
        signature: m1Lend500.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '500000000',
        borrowerAddress: ADDRESSES.borrower,
        storage: null,
        cfg,
      });
      assert.equal(m1BorPrev.existingOpenCollateralRaw, m1OpenBorrowColl.toString());
      assert.equal(m1BorPrev.needsApproval, true);
      assert.equal(m1BorPrev.requiredApprovalRaw, (m1OpenBorrowColl + m1Fill500Coll).toString());

      walletProvider.setAccount(KEYS.borrower);
      const m1BorFill500 = await fillLendOfferAsBorrower({
        address: ADDRESSES.borrower,
        offer: m1Lend500.offer,
        signature: m1Lend500.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '500000000',
        expectedPreview: m1BorPrev,
        storage: null,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(m1BorFill500.approvalTxHash);
      assert.equal(
        (await readBorrowAllowanceAndNonce(ADDRESSES.borrower, nvdac, { cfg })).allowanceRaw,
        m1OpenBorrowColl.toString(),
        'CollateralEscrow allowance after filling while BorrowOrder was unfunded must still cover m1OpenBorrow'
      );

      // Restore borrower NVDAc balance -> m1OpenBorrow recovers and fills in full on-chain!
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: nvdac,
          abi: erc20TestAbi,
          functionName: 'transfer',
          args: [ADDRESSES.borrower, nvdacParked],
        }),
      });
      await rpcCall('evm_mine', []);
      walletProvider.setAccount(KEYS.lender);
      const m1RecoveredBorrowFill = await fillBorrowOrderAsLender({
        address: ADDRESSES.lender,
        order: m1OpenBorrow.order,
        signature: m1OpenBorrow.signature,
        fillUsdcRaw: '1000000000',
        existingOpenSumRaw: '0',
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(m1RecoveredBorrowFill.loanId, 'Recovered previously-unfunded BorrowOrder must fill cleanly');

      // --- M1 Lend side (exact prompt repro) ---
      const m1LendStore = new Map<string, string>();
      const m1LendStorage = {
        getItem: (k: string) => m1LendStore.get(k) ?? null,
        setItem: (k: string, v: string) => {
          m1LendStore.set(k, v);
        },
        removeItem: (k: string) => {
          m1LendStore.delete(k);
        },
      };
      walletProvider.setAccount(KEYS.lender);
      await setUsdcAllowanceForLend({
        address: ADDRESSES.lender,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });
      const m1LendQuote1000 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '1000000000',
        termDays: 30,
        aprBps: 850,
        maxLtvBps: 6000,
      });
      const m1OpenLend = await prepareAndSignLendOffer({
        address: ADDRESSES.lender,
        principalRaw: '1000000000',
        allowedCollateral: nvdac,
        expectedQuote: m1LendQuote1000,
        minRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '1000000000',
        existingOpenUsdcSumRaw: '0',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: m1LendStorage,
        provider: walletProvider,
        cfg,
      });
      assert.equal(m1OpenLend.publishedToApi, true);
      assert.equal((await readLendAllowanceAndNonce(ADDRESSES.lender, { cfg })).allowanceRaw, '1000000000');

      walletProvider.setAccount(KEYS.borrower);
      const m1BorrowQuote500 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '500000000',
        termDays: 30,
        aprBps: 950,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      const m1Borrow500 = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '500000000',
        expectedQuote: m1BorrowQuote500,
        requireExpectedQuote: true,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        storage: borrowStorageApi,
        provider: walletProvider,
        cfg,
      });

      // Dip lender's USDC balance to $500 -> $1,000 LendOffer becomes 'unfunded' & hidden on default GET /orders
      const lenUsdcInit = await publicClient.readContract({
        address: BASE_USDC,
        abi: erc20TestAbi,
        functionName: 'balanceOf',
        args: [ADDRESSES.lender],
      });
      const usdcParked = lenUsdcInit - 500_000_000n;
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: BASE_USDC,
          abi: erc20TestAbi,
          functionName: 'transfer',
          args: [ADDRESSES.borrower, usdcParked],
        }),
      });
      await rpcCall('evm_mine', []);

      const m1LenDef = (await fetch(`${cfg.apiUrl}/orders?order_type=lend&maker=${ADDRESSES.lender}`).then((r) =>
        r.json()
      )) as { data: Array<{ order_hash: string; status: string }> };
      assert.ok(
        !m1LenDef.data.some((r) => r.order_hash.toLowerCase() === m1OpenLend.orderHash.toLowerCase()),
        'Unfunded LendOffer must be hidden from default GET /orders'
      );
      const m1LenAll = (await fetch(
        `${cfg.apiUrl}/orders?order_type=lend&maker=${ADDRESSES.lender}&include_inactive=true`
      ).then((r) => r.json())) as { data: Array<{ order_hash: string; status: string }> };
      assert.equal(
        m1LenAll.data.find((r) => r.order_hash.toLowerCase() === m1OpenLend.orderHash.toLowerCase())?.status,
        'unfunded'
      );

      assert.equal(
        await resolveOpenLendOffersSumRaw({
          lenderAddress: ADDRESSES.lender,
          existingOpenSumRaw: null,
          excludeHashes: new Set(['0x' + '22'.repeat(32)]),
          storage: null,
          cfg,
        }),
        1_000_000_000n,
        'Lend post-cancel target must count unfunded non-final LendOffers'
      );
      const m1LenPrev = await verifyAndPreviewBorrowOrderFill({
        order: m1Borrow500.order,
        signature: m1Borrow500.signature,
        fillUsdcRaw: '500000000',
        existingOpenSumRaw: null,
        lenderAddress: ADDRESSES.lender,
        cfg,
      });
      assert.equal(m1LenPrev.existingOpenSumRaw, '1000000000');
      assert.equal(m1LenPrev.needsApproval, true);
      assert.equal(m1LenPrev.requiredApprovalRaw, '1500000000');

      walletProvider.setAccount(KEYS.lender);
      const m1LenFill500 = await fillBorrowOrderAsLender({
        address: ADDRESSES.lender,
        order: m1Borrow500.order,
        signature: m1Borrow500.signature,
        fillUsdcRaw: '500000000',
        existingOpenSumRaw: null,
        expectedPreview: m1LenPrev,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(m1LenFill500.approvalTxHash);
      assert.equal(
        (await readLendAllowanceAndNonce(ADDRESSES.lender, { cfg })).allowanceRaw,
        '1000000000',
        'LoanCore allowance after filling $500 while $1,000 LendOffer was unfunded must stay 1000000000'
      );

      // Restore lender USDC -> previously-unfunded $1,000 LendOffer recovers and fills in full on-chain!
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: BASE_USDC,
          abi: erc20TestAbi,
          functionName: 'transfer',
          args: [ADDRESSES.lender, usdcParked],
        }),
      });
      await rpcCall('evm_mine', []);
      walletProvider.setAccount(KEYS.borrower);
      const m1RecoveredLendFill = await fillLendOfferAsBorrower({
        address: ADDRESSES.borrower,
        offer: m1OpenLend.offer,
        signature: m1OpenLend.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '1000000000',
        existingOpenCollateralRaw: null,
        storage: null,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(m1RecoveredLendFill.loanId, 'Recovered previously-unfunded LendOffer must fill cleanly');

      // Ensure status helper keeps all non-final statuses and drops all 4 terminal statuses
      for (const nonFinal of ['open', 'partially_filled', 'unfunded', 'unknown']) {
        assert.equal(isNonFinalOrderStatus(nonFinal), true);
      }
      for (const terminal of ['filled', 'cancelled', 'expired', 'nonce_bumped']) {
        assert.equal(isNonFinalOrderStatus(terminal), false);
      }

      // Info checks: bad-checksum counterparty throws (never treated as null); corrupt saved entry blocks until removed
      walletProvider.setAccount(KEYS.lender);
      const infoLend500 = await prepareAndSignLendOffer({
        address: ADDRESSES.lender,
        principalRaw: '500000000',
        allowedCollateral: nvdac,
        expectedQuote: m1LendQuote500,
        minRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        existingOpenUsdcSumRaw: '0',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        provider: walletProvider,
        cfg,
      });
      walletProvider.setAccount(KEYS.borrower);
      const infoBorrow500 = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '500000000',
        expectedQuote: m1BorrowQuote500,
        requireExpectedQuote: true,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        provider: walletProvider,
        cfg,
      });
      const invertChecksumHex = (addr: string) =>
        addr.slice(0, 2) +
        addr
          .slice(2)
          .replace(/[a-fA-F]/g, (c) => (c >= 'a' ? c.toUpperCase() : c.toLowerCase()));
      const badChecksumBor = invertChecksumHex(ADDRESSES.borrower);
      const badChecksumLen = invertChecksumHex(ADDRESSES.lender);
      for (const badBor of [badChecksumBor, 'not-an-address']) {
        await assert.rejects(
          () =>
            verifyAndPreviewLendOfferFill({
              offer: infoLend500.offer,
              signature: infoLend500.signature,
              collateralToken: nvdac,
              fillUsdcRaw: '500000000',
              borrowerAddress: badBor,
              cfg,
            }),
          /Invalid borrower address/
        );
      }
      for (const badLen of [badChecksumLen, 'not-an-address']) {
        await assert.rejects(
          () =>
            verifyAndPreviewBorrowOrderFill({
              order: infoBorrow500.order,
              signature: infoBorrow500.signature,
              fillUsdcRaw: '500000000',
              lenderAddress: badLen,
              cfg,
            }),
          /Invalid lender address/
        );
      }

      // Corrupt saved BorrowOrder blocks fill preview cleanly until removed via removeSignedBorrowOrder
      const infoBorrowMap = new Map<string, string>();
      const infoBorrowStorage = {
        getItem: (k: string) => infoBorrowMap.get(k) ?? null,
        setItem: (k: string, v: string) => {
          infoBorrowMap.set(k, v);
        },
        removeItem: (k: string) => {
          infoBorrowMap.delete(k);
        },
      };
      infoBorrowStorage.setItem(
        SIGNED_BORROW_ORDERS_STORAGE_KEY,
        JSON.stringify([
          {
            orderHash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            orderJson: {
              borrower: ADDRESSES.borrower,
              collateralToken: nvdac,
              collateralAmount: 'not-a-bigint',
              minUsdc: '500000000',
            },
            signature: '0x1234',
          },
        ])
      );
      await assert.rejects(
        () =>
          verifyAndPreviewLendOfferFill({
            offer: infoLend500.offer,
            signature: infoLend500.signature,
            collateralToken: nvdac,
            fillUsdcRaw: '500000000',
            borrowerAddress: ADDRESSES.borrower,
            storage: infoBorrowStorage,
            cfg,
          }),
        /Cannot verify open BorrowOrder/
      );
      removeSignedBorrowOrder(
        '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        infoBorrowStorage
      );
      assert.equal(loadPersistedSignedOrders(infoBorrowStorage).length, 0);
      const unblockedBorPreview = await verifyAndPreviewLendOfferFill({
        offer: infoLend500.offer,
        signature: infoLend500.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '500000000',
        borrowerAddress: ADDRESSES.borrower,
        storage: infoBorrowStorage,
        cfg,
      });
      assert.ok(BigInt(unblockedBorPreview.exact.collateralAmountRaw) > 0n);

      // Same clean removal for corrupt persisted LendOffer
      m1LendStorage.setItem(
        SIGNED_LEND_OFFERS_STORAGE_KEY,
        JSON.stringify([
          {
            orderHash: '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
            offerJson: {
              lender: ADDRESSES.lender,
              allowedCollateral: nvdac,
              usdcAmount: 'not-a-bigint',
            },
            signature: '0x1234',
          },
        ])
      );
      await assert.rejects(
        () =>
          verifyAndPreviewBorrowOrderFill({
            order: infoBorrow500.order,
            signature: infoBorrow500.signature,
            fillUsdcRaw: '500000000',
            lenderAddress: ADDRESSES.lender,
            storage: m1LendStorage,
            cfg,
          }),
        /Cannot verify open LendOffer/
      );
      removeSignedLendOffer(
        '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
        m1LendStorage
      );
      assert.equal(loadPersistedSignedLendOffers(m1LendStorage).length, 0);
      const unblockedLenPreview = await verifyAndPreviewBorrowOrderFill({
        order: infoBorrow500.order,
        signature: infoBorrow500.signature,
        fillUsdcRaw: '500000000',
        lenderAddress: ADDRESSES.lender,
        storage: m1LendStorage,
        cfg,
      });
      assert.equal(unblockedLenPreview.fillAmountRaw, '500000000');

      // M2: 1101-order truncated global book (ordersTruncated=true, stale=false) vs maker-scoped query + throw on maker truncation
      const m2ApiUrl = 'http://127.0.0.1:49999';
      const m2Cfg = { ...cfg, apiUrl: m2ApiUrl };
      const origGlobalFetch = globalThis.fetch;
      let simulateMakerTruncated = false;
      let seenBorrowMakerUrl = '';
      let seenLendMakerUrl = '';
      try {
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (urlStr.startsWith(`${m2ApiUrl}/health`)) {
            return new Response(
              JSON.stringify({ status: 'ok', db_ok: true, rpc_ok: true, last_indexed_block: 1, chain_head_block: 1, lag_blocks: 0 }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (urlStr.startsWith(`${m2ApiUrl}/assets`)) {
            return new Response(
              JSON.stringify({ data: [], pagination: { limit: 100, offset: 0, total: 0, has_more: false }, fees: null }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (urlStr.startsWith(`${m2ApiUrl}/orders`)) {
            const parsedUrl = new URL(urlStr);
            const makerParam = parsedUrl.searchParams.get('maker');
            const orderTypeParam = parsedUrl.searchParams.get('order_type');
            const excludeFinalParam = parsedUrl.searchParams.get('exclude_final');
            const offsetParam = Number(parsedUrl.searchParams.get('offset') ?? '0');
            if (makerParam) {
              if (orderTypeParam === 'borrow') seenBorrowMakerUrl = urlStr;
              if (orderTypeParam === 'lend') seenLendMakerUrl = urlStr;
            }
            if (!makerParam) {
              // Global book: 1,101 dummy orders of other makers -> hits maxPages=10 -> ordersTruncated: true, stale: false!
              const dummyRows = Array.from({ length: 100 }, (_, idx) => ({
                order_hash: `0x${(offsetParam + idx + 1).toString(16).padStart(64, '0')}`,
                order_type: idx % 2 === 0 ? 'borrow' : 'lend',
                maker: '0x000000000000000000000000000000000000dead',
                status: 'open',
                collateral_token: nvdac,
                signed_order: { minUsdc: '500000000', usdcAmount: '500000000' },
                signature: '0x01',
              }));
              return new Response(
                JSON.stringify({
                  data: dummyRows,
                  pagination: { limit: 100, offset: offsetParam, total: 1101, has_more: offsetParam < 1000 },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              );
            }
            if (simulateMakerTruncated) {
              const overLimitRows = Array.from({ length: 100 }, (_, idx) => ({
                order_hash: `0x${(offsetParam + idx + 5000).toString(16).padStart(64, '0')}`,
                order_type: orderTypeParam ?? 'borrow',
                maker: makerParam,
                status: 'open',
                collateral_token: nvdac,
                collateral_amount: { raw: '1000000000000000000' },
                min_usdc: { raw: '500000000' },
                min_fill: { raw: '500000000' },
                remaining_usdc: { raw: '500000000' },
                signed_order: {
                  borrower: makerParam,
                  lender: makerParam,
                  collateralToken: nvdac,
                  collateralAmount: '1000000000000000000',
                  minUsdc: '500000000',
                  minFill: '500000000',
                  usdcAmount: '500000000',
                },
                signature: '0x01',
              }));
              return new Response(
                JSON.stringify({
                  data: overLimitRows,
                  pagination: { limit: 100, offset: offsetParam, total: 1101, has_more: true },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              );
            }
            // Low 2 check: without exclude_final=true, pretend maker would hit >1000 historical rows; with exclude_final=true, only 1 non-final row returns
            if (excludeFinalParam !== 'true') {
              const oldRows = Array.from({ length: 100 }, (_, idx) => ({
                order_hash: `0x${(offsetParam + idx + 9000).toString(16).padStart(64, '0')}`,
                order_type: orderTypeParam ?? 'borrow',
                maker: makerParam,
                status: 'filled',
                collateral_token: nvdac,
                signature: '0x01',
              }));
              return new Response(
                JSON.stringify({
                  data: oldRows,
                  pagination: { limit: 100, offset: offsetParam, total: 1500, has_more: true },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              );
            }
            // Maker-scoped query finds maker's own unfunded order even though global book was 1,101 rows!
            if (orderTypeParam === 'borrow') {
              return new Response(
                JSON.stringify({
                  data: [
                    {
                      order_hash: '0x' + 'aa'.repeat(32),
                      order_type: 'borrow',
                      maker: makerParam,
                      status: 'unfunded',
                      collateral_token: nvdac,
                      collateral_amount: { raw: '4200000000000000000' },
                      min_usdc: { raw: '500000000' },
                      min_fill: { raw: '500000000' },
                      remaining_usdc: { raw: '500000000' },
                      signed_order: {
                        borrower: makerParam,
                        collateralToken: nvdac,
                        collateralAmount: '4200000000000000000',
                        minUsdc: '500000000',
                        minFill: '500000000',
                      },
                      signature: '0x01',
                    },
                  ],
                  pagination: { limit: 100, offset: 0, total: 1, has_more: false },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              );
            }
            return new Response(
              JSON.stringify({
                data: [
                  {
                    order_hash: '0x' + 'bb'.repeat(32),
                    order_type: 'lend',
                    maker: makerParam,
                    status: 'unfunded',
                    collateral_token: nvdac,
                    min_usdc: { raw: '750000000' },
                    remaining_usdc: { raw: '750000000' },
                    signed_order: { lender: makerParam, usdcAmount: '750000000' },
                    signature: '0x01',
                  },
                ],
                pagination: { limit: 100, offset: 0, total: 1, has_more: false },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return origGlobalFetch(input, init);
        }) as typeof globalThis.fetch;

        const m2Snap = await fetchMarketSnapshot({ cfg: m2Cfg, includeLoans: false, includeAuctions: false });
        assert.equal(m2Snap.orders.length, 1000, `Expected 1000 truncated rows (error=${m2Snap.error})`);
        assert.equal(m2Snap.ordersTruncated, true);
        assert.equal(m2Snap.stale, false);

        assert.equal(
          await resolveOpenBorrowOrdersCollateralSumRaw({
            borrowerAddress: ADDRESSES.borrower,
            collateralToken: nvdac,
            existingOpenCollateralRaw: null,
            storage: null,
            cfg: m2Cfg,
          }),
          computeRemainingBorrowCollateralRequirement(
            '4200000000000000000',
            '500000000',
            '500000000',
            '500000000'
          ),
          'Maker-scoped borrow query must find maker order despite 1101-row global book truncation'
        );
        assert.ok(seenBorrowMakerUrl.includes('exclude_final=true') && seenBorrowMakerUrl.includes('include_inactive=true'));
        assert.equal(
          await resolveOpenLendOffersSumRaw({
            lenderAddress: ADDRESSES.lender,
            existingOpenSumRaw: null,
            storage: null,
            cfg: m2Cfg,
          }),
          750000000n,
          'Maker-scoped lend query must find maker order despite 1101-row global book truncation'
        );
        assert.ok(seenLendMakerUrl.includes('exclude_final=true') && seenLendMakerUrl.includes('include_inactive=true'));

        simulateMakerTruncated = true;
        await assert.rejects(
          () =>
            resolveOpenBorrowOrdersCollateralSumRaw({
              borrowerAddress: ADDRESSES.borrower,
              collateralToken: nvdac,
              existingOpenCollateralRaw: null,
              storage: null,
              cfg: m2Cfg,
            }),
          /truncated/i
        );
        await assert.rejects(
          () =>
            resolveOpenLendOffersSumRaw({
              lenderAddress: ADDRESSES.lender,
              existingOpenSumRaw: null,
              storage: null,
              cfg: m2Cfg,
            }),
          /truncated/i
        );
      } finally {
        globalThis.fetch = origGlobalFetch;
      }

      // Low 1: multi-tab safe saved-order removal & Remove visibility classification
      const low1Map = new Map<string, string>();
      const low1Store = {
        getItem: (k: string) => low1Map.get(k) ?? null,
        setItem: (k: string, v: string) => {
          low1Map.set(k, v);
        },
      };
      const hashA = '0x' + '1a'.repeat(32);
      const hashB = '0x' + '2b'.repeat(32);
      const hashC = '0x' + '3c'.repeat(32);
      const itemA = {
        orderHash: hashA,
        orderJson: { borrower: ADDRESSES.borrower, collateralToken: nvdac, collateralAmount: '100', minUsdc: '500000000' },
        signature: '0xaa',
      };
      const itemB = {
        orderHash: hashB,
        orderJson: { borrower: ADDRESSES.borrower, collateralToken: nvdac, collateralAmount: '200', minUsdc: '500000000' },
        signature: '0xbb',
      };
      // Simulate Tab A saw [itemA] at index 0, then Tab B prepended itemB -> [itemB, itemA]
      low1Store.setItem(SIGNED_BORROW_ORDERS_STORAGE_KEY, JSON.stringify([itemB, itemA]));
      const afterRemoveHashed = removeSignedBorrowOrder(
        { orderHash: hashA, index: 0, expectedEntry: itemA },
        low1Store
      );
      assert.deepEqual(
        afterRemoveHashed.map((x: { orderHash?: string }) => x.orderHash),
        [hashB],
        'Removing hashA when index 0 shifted must NOT delete newly prepended itemB'
      );

      // Hashless corrupt entry shifted from index 0 -> 1 by Tab B prepending itemC
      const bad1 = { orderHash: '', orderJson: { collateralAmount: 'bad-1' }, signature: '0x01' };
      const bad2 = { orderHash: '', orderJson: { collateralAmount: 'bad-2' }, signature: '0x02' };
      const itemC = { orderHash: hashC, offerJson: { lender: ADDRESSES.lender, usdcAmount: '500000000' }, signature: '0xcc' };
      low1Store.setItem(SIGNED_LEND_OFFERS_STORAGE_KEY, JSON.stringify([itemC, bad1]));
      const afterRemoveHashless = removeSignedLendOffer(
        { orderHash: '', index: 0, expectedEntry: bad1 },
        low1Store
      );
      assert.deepEqual(
        afterRemoveHashless.map((x: { orderHash?: string }) => x.orderHash),
        [hashC],
        'Removing hashless entry after another tab shifted index must delete ONLY matching bad1, not index 0 itemC'
      );
      // If Tab B already removed bad1 leaving only bad2 at index 0, stale Tab A click removes nothing
      low1Store.setItem(SIGNED_LEND_OFFERS_STORAGE_KEY, JSON.stringify([bad2]));
      const afterStaleHashless = removeSignedLendOffer(
        { orderHash: '', index: 0, expectedEntry: bad1 },
        low1Store
      );
      assert.equal(afterStaleHashless.length, 1, 'Stale index click must NOT delete a different hashless entry');

      // Remove button policy: hidden for open/partially_filled/unfunded/saved, direct for corrupt or final, confirm for RPC unknown
      assert.equal(
        classifyPersistedOrderRemoval(
          {
            orderHash: hashA,
            orderJson: { borrower: ADDRESSES.borrower, collateralToken: nvdac, collateralAmount: '100', minUsdc: '500000000' },
            onchainStatus: 'open',
          },
          'borrow'
        ).showRemove,
        false
      );
      assert.equal(
        classifyPersistedOrderRemoval(
          {
            orderHash: hashA,
            offerJson: { lender: ADDRESSES.lender, usdcAmount: '500000000' },
            onchainStatus: 'unfunded',
          },
          'lend'
        ).showRemove,
        false
      );
      const finalPolicy = classifyPersistedOrderRemoval(
        {
          orderHash: hashA,
          orderJson: { borrower: ADDRESSES.borrower, collateralToken: nvdac, collateralAmount: '100', minUsdc: '500000000' },
          onchainStatus: 'cancelled',
        },
        'borrow'
      );
      assert.equal(finalPolicy.showRemove, true);
      assert.equal(finalPolicy.requiresConfirm, false);
      const corruptPolicy = classifyPersistedOrderRemoval(
        { orderHash: '', orderJson: { collateralAmount: 'not-a-bigint' }, onchainStatus: 'unknown' },
        'borrow'
      );
      assert.equal(corruptPolicy.showRemove, true);
      assert.equal(corruptPolicy.isCorrupt, true);
      assert.equal(corruptPolicy.requiresConfirm, false);
      const unknownValidPolicy = classifyPersistedOrderRemoval(
        {
          orderHash: hashA,
          orderJson: { borrower: ADDRESSES.borrower, collateralToken: nvdac, collateralAmount: '100', minUsdc: '500000000' },
          onchainStatus: 'unknown',
        },
        'borrow'
      );
      assert.equal(unknownValidPolicy.showRemove, true);
      assert.equal(unknownValidPolicy.requiresConfirm, true);

      const low1BorrowSrc = fs.readFileSync(path.join(process.cwd(), 'src/pages/Borrow.jsx'), 'utf8');
      const low1LendSrc = fs.readFileSync(path.join(process.cwd(), 'src/pages/Lend.jsx'), 'utf8');
      assert.ok(
        low1BorrowSrc.includes('classifyPersistedOrderRemoval') &&
          low1BorrowSrc.includes('expectedEntry: item') &&
          low1LendSrc.includes('classifyPersistedOrderRemoval') &&
          low1LendSrc.includes('expectedEntry: item')
      );

      console.log(
        'PASS WS3.4 Piece 3 + M1 + M2 + Low 1 + Low 2 + Info: All checks verified cleanly.'
      );

      // 3.8 WS3.4 Piece 4: Markets orderbook fill navigation, deep-link lookup, Any-B20 LendOffer fill & approval TOCTOU guard
      console.log('\n=== WS3.4 Piece 4: Orderbook-to-fill deep links, Any-B20 LendOffer & TOCTOU approval guard ===');
      walletProvider.setAccount(KEYS.lender);
      await setUsdcAllowanceForLend({
        address: ADDRESSES.lender,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });
      const p4AnyLendOffer = await prepareAndSignLendOffer({
        address: ADDRESSES.lender,
        principalRaw: '500000000',
        allowedCollateral: zeroAddress,
        quoteAsset: nvdac,
        expectedQuote: m1LendQuote500,
        minRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        existingOpenUsdcSumRaw: null,
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: m1LendStorage,
        provider: walletProvider,
        cfg,
      });
      assert.equal(p4AnyLendOffer.publishedToApi, true);
      assert.equal(p4AnyLendOffer.offer.allowedCollateral.toLowerCase(), zeroAddress);

      walletProvider.setAccount(KEYS.borrower);
      clearStorage(p3BorrowStorage);
      await setCollateralAllowanceForBorrow({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });
      const p4BorrowOrder = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '500000000',
        expectedQuote: m1BorrowQuote500,
        requireExpectedQuote: true,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        existingOpenCollateralRaw: null,
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: borrowStorageApi,
        provider: walletProvider,
        cfg,
      });
      assert.equal(p4BorrowOrder.publishedToApi, true);

      // fetchRelayOrderByHash validation + exact lookups + includeInactive snapshot
      await assert.rejects(() => fetchRelayOrderByHash('0x1234', { cfg }), /Invalid order hash/);
      const fetchedAnyLend = await fetchRelayOrderByHash(p4AnyLendOffer.orderHash, { cfg });
      assert.equal(fetchedAnyLend?.order_hash?.toLowerCase(), p4AnyLendOffer.orderHash.toLowerCase());
      assert.equal(fetchedAnyLend?.order_type, 'lend');
      const fetchedP4Borrow = await fetchRelayOrderByHash(p4BorrowOrder.orderHash, { cfg });
      assert.equal(fetchedP4Borrow?.order_hash?.toLowerCase(), p4BorrowOrder.orderHash.toLowerCase());
      assert.equal(fetchedP4Borrow?.order_type, 'borrow');
      assert.equal(await fetchRelayOrderByHash(`0x${'ee'.repeat(32)}`, { cfg }), null);

      const inactiveSnap = await fetchMarketSnapshot({
        cfg,
        includeInactive: true,
        includeLoans: false,
        includeAuctions: false,
      });
      assert.ok(
        inactiveSnap.orders.some((o: { status?: string }) => o.status === 'filled' || o.status === 'cancelled'),
        'fetchMarketSnapshot({ includeInactive: true }) must surface historical/inactive orders'
      );

      // TOCTOU approval-increase guard (borrower side): another open BorrowOrder opens after preview -> fill rejects cleanly
      const p4LendPreviewBefore = await verifyAndPreviewLendOfferFill({
        offer: p4AnyLendOffer.offer,
        signature: p4AnyLendOffer.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '500000000',
        borrowerAddress: ADDRESSES.borrower,
        existingOpenCollateralRaw: null,
        storage: null,
        cfg,
      });
      walletProvider.setAccount(KEYS.borrower);
      const p4ExtraBorrow = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '500000000',
        expectedQuote: m1BorrowQuote500,
        requireExpectedQuote: true,
        maxRateBps: 950,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        existingOpenCollateralRaw: null,
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: borrowStorageApi,
        provider: walletProvider,
        cfg,
      });
      await assert.rejects(
        () =>
          fillLendOfferAsBorrower({
            address: ADDRESSES.borrower,
            offer: p4AnyLendOffer.offer,
            signature: p4AnyLendOffer.signature,
            collateralToken: nvdac,
            fillUsdcRaw: '500000000',
            existingOpenCollateralRaw: null,
            storage: null,
            expectedPreview: p4LendPreviewBefore,
            autoApprove: true,
            provider: walletProvider,
            cfg,
          }),
        /Required CollateralEscrow approval increased/
      );
      await cancelSignedBorrowOrder({
        address: ADDRESSES.borrower,
        order: p4ExtraBorrow.order,
        storage: borrowStorageApi,
        provider: walletProvider,
        cfg,
      });

      // TOCTOU approval-increase guard (lender side): another open LendOffer opens after preview -> fill rejects cleanly
      const p4BorPreviewBefore = await verifyAndPreviewBorrowOrderFill({
        order: p4BorrowOrder.order,
        signature: p4BorrowOrder.signature,
        fillUsdcRaw: '500000000',
        lenderAddress: ADDRESSES.lender,
        existingOpenSumRaw: null,
        storage: null,
        cfg,
      });
      walletProvider.setAccount(KEYS.lender);
      const p4ExtraLend = await prepareAndSignLendOffer({
        address: ADDRESSES.lender,
        principalRaw: '500000000',
        allowedCollateral: nvdac,
        expectedQuote: m1LendQuote500,
        minRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        existingOpenUsdcSumRaw: null,
        expiryDays: 7,
        autoApprove: true,
        publishToApi: true,
        storage: m1LendStorage,
        provider: walletProvider,
        cfg,
      });
      await assert.rejects(
        () =>
          fillBorrowOrderAsLender({
            address: ADDRESSES.lender,
            order: p4BorrowOrder.order,
            signature: p4BorrowOrder.signature,
            fillUsdcRaw: '500000000',
            existingOpenSumRaw: null,
            storage: null,
            expectedPreview: p4BorPreviewBefore,
            autoApprove: true,
            provider: walletProvider,
            cfg,
          }),
        /Required LoanCore USDC approval increased/
      );
      await cancelSignedLendOffer({
        address: ADDRESSES.lender,
        offer: p4ExtraLend.offer,
        storage: m1LendStorage,
        provider: walletProvider,
        cfg,
      });

      // Multi-asset zeroAddress LendOffer fills cleanly on-chain with NVDAc while preserving open p4BorrowOrder allowance
      walletProvider.setAccount(KEYS.borrower);
      const p4AnyFill = await fillLendOfferAsBorrower({
        address: ADDRESSES.borrower,
        offer: p4AnyLendOffer.offer,
        signature: p4AnyLendOffer.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '500000000',
        existingOpenCollateralRaw: null,
        storage: null,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(p4AnyFill.loanId, 'Any-B20 (zeroAddress) LendOffer must fill cleanly on-chain');

      // Piece 4 SSR & source checks across Markets, Lend & Borrow deep-link / multi-asset UX
      const p4MarketsHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/markets'] }, createElement(Shell, null, createElement(Markets)))
        )
      );
      assert.ok(!p4MarketsHtml.includes('Order submission and fills arrive in the next release'));
      assert.ok(p4MarketsHtml.includes('Open BorrowOrder') && p4MarketsHtml.includes('Post LendOffer / Fill Borrow'));
      assert.ok(p4MarketsHtml.includes('Include inactive/unfunded') && p4MarketsHtml.includes('Nonce bumped'));

      const p4LendDeepHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: [`/lend?borrowOrder=${p4BorrowOrder.orderHash}`] },
            createElement(Shell, null, createElement(Lend))
          )
        )
      );
      assert.match(p4LendDeepHtml, /Fill open BorrowOrders/);
      const p4BorrowDeepHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: [`/borrow?lendOffer=${p4AnyLendOffer.orderHash}&asset=${nvdac}`] },
            createElement(Shell, null, createElement(Borrow))
          )
        )
      );
      assert.match(p4BorrowDeepHtml, /Fill a signed LendOffer/);

      const p4MarketsSrc = fs.readFileSync(path.join(process.cwd(), 'src/pages/Markets.jsx'), 'utf8');
      const p4LendSrc = fs.readFileSync(path.join(process.cwd(), 'src/pages/Lend.jsx'), 'utf8');
      const p4BorrowSrc = fs.readFileSync(path.join(process.cwd(), 'src/pages/Borrow.jsx'), 'utf8');
      assert.ok(
        p4MarketsSrc.includes('Fill on /lend') &&
          p4MarketsSrc.includes('Fill on /borrow') &&
          p4MarketsSrc.includes('includeInactive') &&
          p4MarketsSrc.includes('ordersTruncated') &&
          p4LendSrc.includes('useSearchParams') &&
          p4LendSrc.includes('fetchRelayOrderByHash') &&
          p4LendSrc.includes('applyBorrowOrderSelection') &&
          p4BorrowSrc.includes('useSearchParams') &&
          p4BorrowSrc.includes('fetchRelayOrderByHash') &&
          p4BorrowSrc.includes('applyLendOfferSelection') &&
          p4BorrowSrc.includes('Any B20') &&
          p4BorrowSrc.includes('Inspect Loan'),
        'Markets.jsx, Lend.jsx, and Borrow.jsx must implement WS3.4 Piece 4 orderbook fill links, deep-link lookup & multi-asset selection'
      );
      console.log('PASS WS3.4 Piece 4: Orderbook fill links, deep-link lookup, Any-B20 LendOffer & TOCTOU approval guards verified.');

      // 3.9 WS3.5 Piece 1: Loan Management Primitives (repay, partialRepay, topUp, extend EIP-712)
      console.log('\n=== WS3.5 Piece 1: LoanCore repay, partialRepay, topUp, extend EIP-712 & Grace math ===');
      const ws35LoanId = p4AnyFill.loanId;

      // Top up borrower & lender USDC + borrower NVDAc for multi-step loan lifecycle assertions
      await rpcCall('anvil_impersonateAccount', [BASE_USDC_WHALE]);
      await rpcCall('anvil_setBalance', [BASE_USDC_WHALE, '0x56bc75e2d63100000']);
      for (const recipient of [ADDRESSES.borrower, ADDRESSES.lender]) {
        await publicClient.waitForTransactionReceipt({
          hash: await rawWalletClient.sendTransaction({
            account: BASE_USDC_WHALE,
            to: BASE_USDC,
            data: encodeFunctionData({
              abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']),
              functionName: 'transfer',
              args: [recipient, 10_000_000_000n],
            }),
          }),
        });
      }
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [ADDRESSES.borrower, 25n * 10n ** 18n],
        }),
      });

      const ws35InitialState = await readLoanOnChainState(ws35LoanId, { cfg });
      assert.equal(ws35InitialState.loanId, ws35LoanId);
      assert.equal(ws35InitialState.borrower.toLowerCase(), ADDRESSES.borrower.toLowerCase());
      assert.equal(ws35InitialState.positionOwner?.toLowerCase(), ADDRESSES.lender.toLowerCase());
      assert.equal(ws35InitialState.isActive, true);
      assert.equal(ws35InitialState.extensionNonce, '0');
      assert.equal(
        computeLoanProjectedInterestDueRaw(ws35InitialState, ws35InitialState.blockTimestamp),
        BigInt(ws35InitialState.dueInterestRaw),
        'Projected spot interest must match LoanCore.getDueInterest() at loan start'
      );

      // Strict input validation: reject floats, zeros, and oversized partial principal
      assert.throws(() => computeExactTopUpAmounts(ws35InitialState, '1.5'), /unsigned integer/);
      assert.throws(() => computeExactTopUpAmounts(ws35InitialState, '0'), /must be >= 1/);
      assert.throws(() => computeExactRepayAmounts(ws35InitialState, { bufferSeconds: 9999n }), /exceeds maximum/);
      assert.throws(() => computeExactPartialRepayAmounts(ws35InitialState, '250.25'), /unsigned integer/);
      assert.throws(
        () => computeExactPartialRepayAmounts(ws35InitialState, ws35InitialState.remainingPrincipalRaw),
        /use full repay\(\) instead/
      );

      // 1) topUp: preserves open p4BorrowOrder CollateralEscrow allowance and approves ONLY CollateralEscrow
      const openBorrowBeforeTopUp = await resolveOpenBorrowOrdersCollateralSumRaw({
        borrowerAddress: ADDRESSES.borrower,
        collateralToken: nvdac,
        cfg,
      });
      assert.ok(openBorrowBeforeTopUp > 0n, 'p4BorrowOrder should still be open before topUp test');
      walletProvider.setAccount(KEYS.borrower);
      await setCollateralAllowanceForBorrow({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });
      const topUpAdditionalRaw = '1000000000000000000'; // +1 NVDAc
      const topUpPreview = await verifyAndPreviewLoanTopUp({
        loanId: ws35LoanId,
        additionalCollateralRaw: topUpAdditionalRaw,
        payerAddress: ADDRESSES.borrower,
        cfg,
      });
      assert.equal(topUpPreview.needsApproval, true);
      assert.equal(topUpPreview.spender.toLowerCase(), deployed.collateralEscrow.toLowerCase());
      assert.equal(
        BigInt(topUpPreview.requiredApprovalRaw),
        openBorrowBeforeTopUp + BigInt(topUpAdditionalRaw)
      );
      await assert.rejects(
        () =>
          executeLoanTopUp({
            address: ADDRESSES.borrower,
            loanId: ws35LoanId,
            additionalCollateralRaw: topUpAdditionalRaw,
            expectedPreview: topUpPreview,
            autoApprove: false,
            provider: walletProvider,
            cfg,
          }),
        /CollateralEscrow allowance is below required/
      );
      await assert.rejects(
        () =>
          executeLoanTopUp({
            address: ADDRESSES.borrower,
            loanId: ws35LoanId,
            additionalCollateralRaw: topUpAdditionalRaw,
            expectedPreview: { ...topUpPreview, requiredApprovalRaw: '1' },
            autoApprove: true,
            provider: walletProvider,
            cfg,
          }),
        /Required CollateralEscrow approval increased since preview/
      );
      const topUpRes = await executeLoanTopUp({
        address: ADDRESSES.borrower,
        loanId: ws35LoanId,
        additionalCollateralRaw: topUpAdditionalRaw,
        expectedPreview: topUpPreview,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(topUpRes.approvalTxHash, 'topUp should approve CollateralEscrow');
      assert.equal(topUpRes.addedCollateralRaw, topUpAdditionalRaw);
      assert.equal(
        BigInt(topUpRes.newCollateralRaw),
        BigInt(ws35InitialState.collateralRaw) + BigInt(topUpAdditionalRaw)
      );
      const stateAfterTopUp = await readLoanOnChainState(ws35LoanId, { cfg });
      assert.equal(stateAfterTopUp.collateralRaw, topUpRes.newCollateralRaw);

      // Spender isolation on topUp + open BorrowOrder allowance preserved
      const escrowAllowAfterTopUp = BigInt(
        await publicClient.readContract({
          address: nvdac,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [ADDRESSES.borrower, deployed.collateralEscrow],
        })
      );
      const settlementCollatAllow = BigInt(
        await publicClient.readContract({
          address: nvdac,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [ADDRESSES.borrower, deployed.orderSettlement],
        })
      );
      const loanCoreCollatAllow = BigInt(
        await publicClient.readContract({
          address: nvdac,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [ADDRESSES.borrower, deployed.loanCore],
        })
      );
      assert.ok(
        escrowAllowAfterTopUp >= openBorrowBeforeTopUp,
        'CollateralEscrow allowance remaining after topUp must still cover open BorrowOrder'
      );
      assert.equal(settlementCollatAllow, 0n, 'OrderSettlement must never receive collateral approval');
      assert.equal(loanCoreCollatAllow, 0n, 'LoanCore must never receive collateral approval');

      // 2) Warp +10 days (T0 + 10d), open a 30-day $500 LendOffer as borrower (valid through T0 + 40d),
      // and execute partialRepay ($200) proving exact pro-rata math, TOCTOU buffer cap & LoanCore spender isolation.
      await rpcCall('evm_increaseTime', [10 * 86_400]);
      await rpcCall('evm_mine', []);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [140_00000000n],
        }),
      });
      const stateDay10 = await readLoanOnChainState(ws35LoanId, { cfg });
      assert.ok(BigInt(stateDay10.dueInterestRaw) > 0n, 'Loan must have accrued interest by Day 10');
      assert.equal(
        computeLoanProjectedInterestDueRaw(stateDay10, stateDay10.blockTimestamp),
        BigInt(stateDay10.dueInterestRaw),
        'Projected interest must match LoanCore.getDueInterest() after +10d warp'
      );

      const ws35Store = new Map<string, string>();
      const ws35Storage = {
        getItem: (k: string) => ws35Store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          ws35Store.set(k, v);
        },
        removeItem: (k: string) => {
          ws35Store.delete(k);
        },
      };
      const quoteDay10 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '500000000',
        termDays: 30,
        aprBps: 850,
        maxLtvBps: 6000,
        lender: ADDRESSES.borrower,
      });
      walletProvider.setAccount(KEYS.borrower);
      const borrowerOpenLendOffer = await prepareAndSignLendOffer({
        address: ADDRESSES.borrower,
        principalRaw: '500000000',
        allowedCollateral: nvdac,
        expectedQuote: quoteDay10,
        minRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        existingOpenUsdcSumRaw: 0n,
        expiryDays: 30,
        autoApprove: true,
        publishToApi: true,
        storage: ws35Storage,
        provider: walletProvider,
        cfg,
      });
      assert.equal(borrowerOpenLendOffer.publishedToApi, true);

      // Reset LoanCore USDC allowance to 0 to force pre-approval simulation + exact approval path
      await setUsdcAllowanceForLend({
        address: ADDRESSES.borrower,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });

      const partialPrincipalRaw = '200000000'; // $200 of $500
      const partialPreview = await verifyAndPreviewLoanRepay({
        loanId: ws35LoanId,
        payerAddress: ADDRESSES.borrower,
        principalRepayRaw: partialPrincipalRaw,
        cfg,
      });
      assert.equal(partialPreview.isPartial, true);
      assert.equal(partialPreview.needsApproval, true);
      assert.equal(partialPreview.spender.toLowerCase(), deployed.loanCore.toLowerCase());
      assert.equal(partialPreview.existingOpenSumRaw, '500000000');
      assert.equal(
        BigInt(partialPreview.requiredApprovalRaw),
        500_000_000n + BigInt(partialPreview.maxPaymentRaw)
      );
      assert.ok(
        BigInt(partialPreview.maxPaymentRaw) >= BigInt(partialPreview.spotTotalPaymentRaw),
        'Buffered maxPaymentRaw must cover spot total'
      );

      // Advance 10s between preview and execute to test sliding 300s buffer + expectedPreview ceiling cap
      await rpcCall('evm_increaseTime', [10]);
      await rpcCall('evm_mine', []);

      const borNvdacBeforePartial = BigInt(
        await publicClient.readContract({
          address: nvdac,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ADDRESSES.borrower],
        })
      );
      await assert.rejects(
        () =>
          executeLoanRepay({
            address: ADDRESSES.borrower,
            loanId: ws35LoanId,
            principalRepayRaw: partialPrincipalRaw,
            expectedPreview: partialPreview,
            autoApprove: false,
            provider: walletProvider,
            cfg,
          }),
        /LoanCore USDC allowance is below required/
      );
      const partialRes = await executeLoanRepay({
        address: ADDRESSES.borrower,
        loanId: ws35LoanId,
        principalRepayRaw: partialPrincipalRaw,
        expectedPreview: partialPreview,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(partialRes.approvalTxHash, 'partialRepay should approve LoanCore');
      assert.equal(partialRes.principalPaidRaw, partialPrincipalRaw);
      assert.equal(partialRes.collateralReleasedRaw, partialPreview.exact.collateralReleasedRaw);
      assert.equal(partialRes.requiredApprovalRaw, partialPreview.requiredApprovalRaw);

      const borNvdacAfterPartial = BigInt(
        await publicClient.readContract({
          address: nvdac,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ADDRESSES.borrower],
        })
      );
      assert.equal(
        borNvdacAfterPartial - borNvdacBeforePartial,
        BigInt(partialRes.collateralReleasedRaw),
        'partialRepay must release pro-rata collateral back to borrower'
      );

      const loanCoreUsdcAfterPartial = BigInt(
        await publicClient.readContract({
          address: BASE_USDC,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [ADDRESSES.borrower, deployed.loanCore],
        })
      );
      const settlementUsdcAllow = BigInt(
        await publicClient.readContract({
          address: BASE_USDC,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [ADDRESSES.borrower, deployed.orderSettlement],
        })
      );
      const escrowUsdcAllow = BigInt(
        await publicClient.readContract({
          address: BASE_USDC,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [ADDRESSES.borrower, deployed.collateralEscrow],
        })
      );
      assert.ok(
        loanCoreUsdcAfterPartial >= 500_000_000n,
        'Open LendOffer $500 USDC allowance on LoanCore must survive partialRepay'
      );
      assert.equal(settlementUsdcAllow, 0n, 'OrderSettlement must never receive USDC approval');
      assert.equal(escrowUsdcAllow, 0n, 'CollateralEscrow must never receive USDC approval');

      const stateAfterPartial = await readLoanOnChainState(ws35LoanId, { cfg });
      assert.equal(stateAfterPartial.remainingPrincipalRaw, '300000000');
      assert.equal(
        computeLoanProjectedInterestDueRaw(stateAfterPartial, stateAfterPartial.blockTimestamp),
        BigInt(stateAfterPartial.dueInterestRaw),
        'Projected interest must match LoanCore.getDueInterest() after partialRepay'
      );

      // 3) extend: verify LoanCore EIP-712 domain, rejection guards & bidirectional counterparty signing (zero approvals)
      const nowDay10 = BigInt(stateAfterPartial.blockTimestamp);
      const sampleExtendTd = buildExtendOrderTypedData({
        extendOrder: {
          loanId: ws35LoanId,
          newMaturity: BigInt(stateAfterPartial.maturity) + 2n * 86_400n,
          newRateBps: 1100,
          nonce: stateAfterPartial.extensionNonce,
          deadline: nowDay10 + 3600n,
        },
        cfg,
      });
      assert.equal(sampleExtendTd.domain.name, LOAN_CORE_DOMAIN_NAME);
      assert.equal(sampleExtendTd.domain.version, LOAN_CORE_DOMAIN_VERSION);
      assert.equal(sampleExtendTd.domain.verifyingContract.toLowerCase(), deployed.loanCore.toLowerCase());
      assert.notEqual(
        sampleExtendTd.domain.name,
        ORDER_SETTLEMENT_DOMAIN_NAME,
        'ExtendOrder must use LoanCore EIP-712 domain, not OrderSettlement'
      );
      assert.ok(Array.isArray(EXTEND_ORDER_EIP712_TYPES.ExtendOrder));

      walletProvider.setAccount(KEYS.lender);
      await assert.rejects(
        () =>
          signLoanExtension({
            address: ADDRESSES.lender,
            loanId: ws35LoanId,
            newMaturity: BigInt(stateAfterPartial.maturity) + 2n * 86_400n,
            newRateBps: 4001,
            deadline: nowDay10 + 3600n,
            provider: walletProvider,
            cfg,
          }),
        /exceeds maximum/
      );
      await assert.rejects(
        () =>
          signLoanExtension({
            address: ADDRESSES.lender,
            loanId: ws35LoanId,
            newMaturity: BigInt(stateAfterPartial.maturity),
            newRateBps: 1100,
            deadline: nowDay10 + 3600n,
            provider: walletProvider,
            cfg,
          }),
        /strictly after current maturity/
      );
      await assert.rejects(
        () =>
          signLoanExtension({
            address: ADDRESSES.lender,
            loanId: ws35LoanId,
            newMaturity: BigInt(stateAfterPartial.maxExtendMaturity) + 1n,
            newRateBps: 1100,
            deadline: nowDay10 + 3600n,
            provider: walletProvider,
            cfg,
          }),
        /exceeds protocol maximum 90 days/
      );

      // Direction 1: Lender (PositionNFT holder) signs -> Borrower submits
      const extMaturity1 = BigInt(stateAfterPartial.maturity) + 2n * 86_400n;
      const extSig1 = await signLoanExtension({
        address: ADDRESSES.lender,
        loanId: ws35LoanId,
        newMaturity: extMaturity1,
        newRateBps: 1100,
        deadline: nowDay10 + 7200n,
        provider: walletProvider,
        cfg,
      });
      assert.equal(extSig1.signerRole, 'holder');
      assert.equal(extSig1.expectedSubmitter.toLowerCase(), ADDRESSES.borrower.toLowerCase());

      // Self-extension must reject cleanly
      await assert.rejects(
        () =>
          verifyAndPreviewLoanExtend({
            ...extSig1.extendOrder,
            signature: extSig1.signature,
            callerAddress: ADDRESSES.lender,
            cfg,
          }),
        /self-extension rejected/
      );

      const extPreview1 = await verifyAndPreviewLoanExtend({
        ...extSig1.extendOrder,
        signature: extSig1.signature,
        callerAddress: ADDRESSES.borrower,
        cfg,
      });
      assert.equal(extPreview1.needsApproval, false);

      walletProvider.setAccount(KEYS.borrower);
      await assert.rejects(
        () =>
          executeLoanExtend({
            address: ADDRESSES.borrower,
            ...extSig1.extendOrder,
            newRateBps: 1200,
            signature: extSig1.signature,
            expectedPreview: extPreview1,
            provider: walletProvider,
            cfg,
          }),
        /Extension parameters changed since preview|signer.*does not match/
      );

      const extRes1 = await executeLoanExtend({
        address: ADDRESSES.borrower,
        ...extSig1.extendOrder,
        signature: extSig1.signature,
        expectedPreview: extPreview1,
        provider: walletProvider,
        cfg,
      });
      assert.equal(extRes1.newMaturity, extMaturity1.toString());
      assert.equal(extRes1.newRateBps, 1100);

      const stateAfterExt1 = await readLoanOnChainState(ws35LoanId, { cfg });
      assert.equal(stateAfterExt1.maturity, extMaturity1.toString());
      assert.equal(stateAfterExt1.rateBps, 1100);
      assert.equal(stateAfterExt1.extensionNonce, '1');
      assert.equal(
        computeLoanProjectedInterestDueRaw(stateAfterExt1, stateAfterExt1.blockTimestamp),
        BigInt(stateAfterExt1.dueInterestRaw),
        'Projected interest must match LoanCore.getDueInterest() after extension rate/maturity lock'
      );

      // Replay with old maturity or stale extension nonce must fail
      await assert.rejects(
        () =>
          verifyAndPreviewLoanExtend({
            ...extSig1.extendOrder,
            nonce: '0',
            signature: extSig1.signature,
            callerAddress: ADDRESSES.borrower,
            cfg,
          }),
        /strictly after current maturity/
      );
      await assert.rejects(
        () =>
          verifyAndPreviewLoanExtend({
            ...extSig1.extendOrder,
            newMaturity: extMaturity1 + 86_400n,
            nonce: '0',
            signature: extSig1.signature,
            callerAddress: ADDRESSES.borrower,
            cfg,
          }),
        /Extension nonce mismatch/
      );
      await assert.rejects(
        () =>
          verifyAndPreviewLoanExtend({
            ...extSig1.extendOrder,
            newMaturity: extMaturity1 + 86_400n,
            nonce: stateAfterExt1.extensionNonce,
            signature: extSig1.signature,
            callerAddress: ADDRESSES.borrower,
            cfg,
          }),
        /signer.*does not match expected counterparty/
      );

      // Direction 2: Borrower signs -> PositionNFT holder executes
      const extMaturity2 = BigInt(stateAfterExt1.maturity) + 3n * 86_400n;
      const extSig2 = await signLoanExtension({
        address: ADDRESSES.borrower,
        loanId: ws35LoanId,
        newMaturity: extMaturity2,
        newRateBps: 900,
        deadline: nowDay10 + 7200n,
        provider: walletProvider,
        cfg,
      });
      assert.equal(extSig2.signerRole, 'borrower');
      walletProvider.setAccount(KEYS.lender);
      const extRes2 = await executeLoanExtend({
        address: ADDRESSES.lender,
        ...extSig2.extendOrder,
        signature: extSig2.signature,
        provider: walletProvider,
        cfg,
      });
      assert.equal(extRes2.newMaturity, extMaturity2.toString());
      assert.equal(extRes2.newRateBps, 900);

      const stateAfterExt2 = await readLoanOnChainState(ws35LoanId, { cfg });
      assert.equal(stateAfterExt2.extensionNonce, '2');

      // 4) Warp past maturity + 12h into Grace WITHOUT refreshing oracle -> test Grace penalty math,
      // partialRepay/extend rejections in Grace, and full repay() preserving open $500 LendOffer allowance
      const warpIntoGraceSecs = Number(extMaturity2 - BigInt(stateAfterExt2.blockTimestamp) + 43_200n);
      await rpcCall('evm_increaseTime', [warpIntoGraceSecs]);
      await rpcCall('evm_mine', []);

      const graceState = await readLoanOnChainState(ws35LoanId, { cfg });
      assert.equal(graceState.isPastMaturity, true);
      assert.equal(graceState.isGrace, true);
      assert.equal(graceState.status, 1);
      assert.equal(graceState.statusName, 'Grace');
      assert.equal(
        computeLoanProjectedInterestDueRaw(graceState, graceState.blockTimestamp),
        BigInt(graceState.dueInterestRaw),
        'Grace-period projected interest (regular + penaltySpreadBps) must match LoanCore.getDueInterest()'
      );

      await assert.rejects(
        () =>
          verifyAndPreviewLoanRepay({
            loanId: ws35LoanId,
            payerAddress: ADDRESSES.borrower,
            principalRepayRaw: '100000000',
            cfg,
          }),
        /Partial repay is only available while Loan #\d+ is Active before maturity/
      );
      walletProvider.setAccount(KEYS.borrower);
      await assert.rejects(
        () =>
          signLoanExtension({
            address: ADDRESSES.borrower,
            loanId: ws35LoanId,
            newMaturity: extMaturity2 + 86_400n,
            newRateBps: 900,
            deadline: BigInt(graceState.blockTimestamp) + 3600n,
            provider: walletProvider,
            cfg,
          }),
        /cannot be extended/
      );

      // Force allowance down to 0 again so full repay proves cumulative LoanCore approval with open $500 LendOffer
      await setUsdcAllowanceForLend({
        address: ADDRESSES.borrower,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg,
      });

      const fullRepayPreview = await verifyAndPreviewLoanRepay({
        loanId: ws35LoanId,
        payerAddress: ADDRESSES.borrower,
        cfg,
      });
      assert.equal(fullRepayPreview.isPartial, false);
      assert.equal(fullRepayPreview.needsApproval, true);
      assert.equal(fullRepayPreview.existingOpenSumRaw, '500000000');
      assert.equal(
        BigInt(fullRepayPreview.requiredApprovalRaw),
        500_000_000n + BigInt(fullRepayPreview.maxPaymentRaw)
      );

      // Simulate block ticks (+30s) inside bufferSeconds during Grace penalty accrual
      await rpcCall('evm_increaseTime', [30]);
      await rpcCall('evm_mine', []);

      const claimableBefore = BigInt(
        await publicClient.readContract({
          address: deployed.loanCore,
          abi: loanCoreAbi,
          functionName: 'getClaimable',
          args: [ADDRESSES.lender],
        })
      );
      const treasuryBefore = BigInt(
        await publicClient.readContract({
          address: BASE_USDC,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ADDRESSES.treasury],
        })
      );
      const reserveBefore = BigInt(
        await publicClient.readContract({
          address: BASE_USDC,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ADDRESSES.reserve],
        })
      );
      const repayRes = await executeLoanRepay({
        address: ADDRESSES.borrower,
        loanId: ws35LoanId,
        expectedPreview: fullRepayPreview,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      assert.ok(repayRes.approvalTxHash, 'full repay should approve LoanCore');
      assert.equal(repayRes.principalPaidRaw, '300000000');
      assert.equal(repayRes.collateralReleasedRaw, graceState.collateralRaw);
      assert.ok(
        BigInt(repayRes.totalPaidRaw) >= BigInt(fullRepayPreview.spotTotalPaymentRaw) &&
          BigInt(repayRes.totalPaidRaw) <= BigInt(fullRepayPreview.maxPaymentRaw),
        'Actual Grace repay must sit inside [spot, maxPaymentRaw]'
      );

      const stateAfterRepay = await readLoanOnChainState(ws35LoanId, { cfg });
      assert.equal(stateAfterRepay.storedStatus, 3);
      assert.equal(stateAfterRepay.statusName, 'Repaid');
      assert.equal(stateAfterRepay.isSettled, true);
      assert.equal(stateAfterRepay.positionOwner, null);
      await assert.rejects(
        () =>
          publicClient.readContract({
            address: deployed.positionNFT,
            abi: positionNftAbi,
            functionName: 'ownerOf',
            args: [BigInt(ws35LoanId)],
          }),
        /ERC721NonexistentToken|reverted/i
      );

      const claimableAfter = BigInt(
        await publicClient.readContract({
          address: deployed.loanCore,
          abi: loanCoreAbi,
          functionName: 'getClaimable',
          args: [ADDRESSES.lender],
        })
      );
      const treasuryAfter = BigInt(
        await publicClient.readContract({
          address: BASE_USDC,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ADDRESSES.treasury],
        })
      );
      const reserveAfter = BigInt(
        await publicClient.readContract({
          address: BASE_USDC,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ADDRESSES.reserve],
        })
      );
      const claimableDelta = claimableAfter - claimableBefore;
      const feeDelta = (treasuryAfter - treasuryBefore) + (reserveAfter - reserveBefore);
      assert.ok(feeDelta > 0n, 'Treasury + reserve must receive protocol interest share on repay');
      assert.ok(claimableDelta > BigInt(repayRes.principalPaidRaw), 'Holder must receive net interest + principal');
      assert.equal(
        claimableDelta + feeDelta,
        BigInt(repayRes.totalPaidRaw),
        'Repay USDC conservation: holder claimable + treasury/reserve fee delta must equal totalPaidRaw'
      );

      const loanCoreUsdcAfterFull = BigInt(
        await publicClient.readContract({
          address: BASE_USDC,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [ADDRESSES.borrower, deployed.loanCore],
        })
      );
      assert.ok(
        loanCoreUsdcAfterFull >= 500_000_000n,
        'Open $500 LendOffer allowance on LoanCore must remain intact after full repay'
      );

      await cancelSignedLendOffer({
        address: ADDRESSES.borrower,
        offer: borrowerOpenLendOffer.offer,
        storage: ws35Storage,
        provider: walletProvider,
        cfg,
      });

      console.log('PASS WS3.5 Piece 1: LoanCore repay, partialRepay, topUp, extend EIP-712 & Grace math verified.');

      // 3.10 WS3.5 Piece 2: Loans.jsx / Loan.jsx Live UI Wiring + Low 1 (payer role), Low 2 (1h default / 24h max extend deadline),
      // Info 1 (optional post-repay buffer allowance trim), & Info 2 ("Overdue - default pending" past maturity+24h)
      console.log('\n=== WS3.5 Piece 2: Loans.jsx / Loan.jsx live UI, Low 1/2, & Info 1/2 verification ===');

      // Refresh oracle price cleanly and open a dedicated 7-day $600 loan (borrower -> lender) for Piece 2 tests
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [140_00000000n],
        }),
      });
      const quoteP2 = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '600000000',
        termDays: 7,
        aprBps: 850,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      walletProvider.setAccount(KEYS.borrower);
      ws35Store.clear();
      const p2BorrowOrd = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '600000000',
        expectedQuote: quoteP2,
        requireExpectedQuote: true,
        maxRateBps: 850,
        termDays: 7,
        maxLtvBps: 6000,
        minFillRaw: '600000000',
        existingOpenCollateralRaw: null,
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        storage: ws35Storage,
        provider: walletProvider,
        cfg,
      });
      walletProvider.setAccount(KEYS.lender);
      const p2OpenFill = await fillBorrowOrderAsLender({
        address: ADDRESSES.lender,
        order: p2BorrowOrd.order,
        signature: p2BorrowOrd.signature,
        fillUsdcRaw: '600000000',
        existingOpenSumRaw: 0n,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      const p2LoanId = p2OpenFill.loanId;
      assert.ok(p2LoanId, 'Piece 2 loan must open on-chain');
      ws35Store.clear();
      await runIndexerSync(idxCtx);

      // Low 1a: PositionNFT holder MUST be blocked from previewing or executing repay/partialRepay/topUp on its own loan
      await assert.rejects(
        () =>
          verifyAndPreviewLoanRepay({
            loanId: p2LoanId,
            payerAddress: ADDRESSES.lender,
            cfg,
          }),
        /PositionNFT lender\/holder.*cannot repay/
      );
      await assert.rejects(
        () =>
          verifyAndPreviewLoanTopUp({
            loanId: p2LoanId,
            additionalCollateralRaw: '100000000000000000',
            payerAddress: ADDRESSES.lender,
            cfg,
          }),
        /PositionNFT lender\/holder.*cannot top up collateral/
      );

      // Low 1b: Third-party / outsider gets payerIsBorrower=false + warning; execute requires allowThirdPartyPayer=true
      const outsiderKey = generatePrivateKey();
      const outsiderAddr = getAddress(privateKeyToAccount(outsiderKey).address);
      await rpcCall('anvil_setBalance', [outsiderAddr, '0x56bc75e2d63100000']);
      await rpcCall('anvil_impersonateAccount', [BASE_USDC_WHALE]);
      await rpcCall('anvil_setBalance', [BASE_USDC_WHALE, '0x56bc75e2d63100000']);
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: BASE_USDC_WHALE,
          to: BASE_USDC,
          data: encodeFunctionData({
            abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']),
            functionName: 'transfer',
            args: [outsiderAddr, 2_000_000_000n],
          }),
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [outsiderAddr, 2n * 10n ** 18n],
        }),
      });

      const outsiderTopUpPreview = await verifyAndPreviewLoanTopUp({
        loanId: p2LoanId,
        additionalCollateralRaw: '500000000000000000', // 0.5 NVDAc
        payerAddress: outsiderAddr,
        cfg,
      });
      assert.equal(outsiderTopUpPreview.payerIsBorrower, false);
      assert.equal(outsiderTopUpPreview.payerIsHolder, false);
      assert.equal(outsiderTopUpPreview.isThirdPartyPayer, true);
      assert.match(outsiderTopUpPreview.thirdPartyWarning, /not the loan borrower/);

      walletProvider.setAccount(outsiderKey);
      await assert.rejects(
        () =>
          executeLoanTopUp({
            address: outsiderAddr,
            loanId: p2LoanId,
            additionalCollateralRaw: '500000000000000000',
            expectedPreview: outsiderTopUpPreview,
            autoApprove: true,
            provider: walletProvider,
            cfg,
          }),
        /Third-party collateral top-up confirmation required/
      );
      const outsiderTopUpRes = await executeLoanTopUp({
        address: outsiderAddr,
        loanId: p2LoanId,
        additionalCollateralRaw: '500000000000000000',
        expectedPreview: outsiderTopUpPreview,
        autoApprove: true,
        allowThirdPartyPayer: true,
        provider: walletProvider,
        cfg,
      });
      assert.equal(outsiderTopUpRes.payerIsBorrower, false);

      const outsiderRepayPreview = await verifyAndPreviewLoanRepay({
        loanId: p2LoanId,
        payerAddress: outsiderAddr,
        principalRepayRaw: '200000000', // $200 partial repay by outsider
        cfg,
      });
      assert.equal(outsiderRepayPreview.payerIsBorrower, false);
      assert.equal(outsiderRepayPreview.payerIsHolder, false);
      assert.equal(outsiderRepayPreview.isThirdPartyPayer, true);
      assert.match(outsiderRepayPreview.thirdPartyWarning, /not the loan borrower/);

      await assert.rejects(
        () =>
          executeLoanRepay({
            address: outsiderAddr,
            loanId: p2LoanId,
            principalRepayRaw: '200000000',
            expectedPreview: outsiderRepayPreview,
            autoApprove: true,
            provider: walletProvider,
            cfg,
          }),
        /Third-party repay confirmation required/
      );

      // Info 1 (outsider, 0 open offers): trimBufferAllowance=true resets LoanCore allowance back to exact 0n after repay!
      const borNvdacBeforeOutsider = BigInt(
        await publicClient.readContract({
          address: nvdac,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ADDRESSES.borrower],
        })
      );
      const outsiderPartialRes = await executeLoanRepay({
        address: outsiderAddr,
        loanId: p2LoanId,
        principalRepayRaw: '200000000',
        expectedPreview: outsiderRepayPreview,
        autoApprove: true,
        allowThirdPartyPayer: true,
        trimBufferAllowance: true,
        provider: walletProvider,
        cfg,
      });
      assert.equal(outsiderPartialRes.payerIsBorrower, false);
      assert.equal(outsiderPartialRes.postTrimAllowanceRaw, '0');
      const outsiderAllowAfterTrim = BigInt(
        await publicClient.readContract({
          address: BASE_USDC,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [outsiderAddr, deployed.loanCore],
        })
      );
      assert.equal(outsiderAllowAfterTrim, 0n, 'trimBufferAllowance must leave 0 leftover LoanCore USDC allowance');
      const borNvdacAfterOutsider = BigInt(
        await publicClient.readContract({
          address: nvdac,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ADDRESSES.borrower],
        })
      );
      assert.equal(
        borNvdacAfterOutsider - borNvdacBeforeOutsider,
        BigInt(outsiderPartialRes.collateralReleasedRaw),
        'Third-party partialRepay must return released collateral to borrower'
      );

      // Low 2: Extend signature deadline defaults to 1h (DEFAULT_EXTEND_DEADLINE_SECS) and caps at 24h (MAX_EXTEND_DEADLINE_SECS)
      const p2ActiveState = await readLoanOnChainState(p2LoanId, { cfg });
      walletProvider.setAccount(KEYS.lender);
      const p2SignedDefault = await signLoanExtension({
        address: ADDRESSES.lender,
        loanId: p2LoanId,
        newMaturity: BigInt(p2ActiveState.maturity) + 2n * 86_400n,
        newRateBps: 900,
        provider: walletProvider,
        cfg,
      });
      assert.equal(
        BigInt(p2SignedDefault.deadline),
        BigInt(p2ActiveState.blockTimestamp) + DEFAULT_EXTEND_DEADLINE_SECS,
        'Omitted extend deadline must default to blockTimestamp + 1h'
      );
      const reparsedExt = parseExtendPayloadFromJson(
        JSON.stringify({
          extendOrder: p2SignedDefault.extendOrderJson,
          signature: p2SignedDefault.signature,
        })
      );
      assert.equal(reparsedExt.extendOrder.loanId.toString(), p2LoanId);

      // Reject >24h & 365-day deadlines in BOTH signing and verification
      await assert.rejects(
        () =>
          signLoanExtension({
            address: ADDRESSES.lender,
            loanId: p2LoanId,
            newMaturity: BigInt(p2ActiveState.maturity) + 2n * 86_400n,
            newRateBps: 900,
            deadline: BigInt(p2ActiveState.blockTimestamp) + MAX_EXTEND_DEADLINE_SECS + 1n,
            provider: walletProvider,
            cfg,
          }),
        /exceeds maximum 24 hours/
      );
      await assert.rejects(
        () =>
          signLoanExtension({
            address: ADDRESSES.lender,
            loanId: p2LoanId,
            newMaturity: BigInt(p2ActiveState.maturity) + 2n * 86_400n,
            newRateBps: 900,
            deadline: BigInt(p2ActiveState.blockTimestamp) + 365n * 86_400n,
            provider: walletProvider,
            cfg,
          }),
        /exceeds maximum 24 hours/
      );
      await assert.rejects(
        () =>
          verifyAndPreviewLoanExtend({
            loanId: p2LoanId,
            newMaturity: BigInt(p2ActiveState.maturity) + 2n * 86_400n,
            newRateBps: 900,
            deadline: BigInt(p2ActiveState.blockTimestamp) + MAX_EXTEND_DEADLINE_SECS + 60n,
            nonce: p2ActiveState.extensionNonce,
            signature: p2SignedDefault.signature,
            callerAddress: ADDRESSES.borrower,
            cfg,
          }),
        /exceeds maximum 24 hours/
      );

      // Open a $500 30-day LendOffer as borrower before warping past maturity+24h so we verify Info 1 + Info 2 together
      const quoteP2Offer = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '500000000',
        termDays: 30,
        aprBps: 850,
        maxLtvBps: 6000,
        lender: ADDRESSES.borrower,
      });
      walletProvider.setAccount(KEYS.borrower);
      const p2BorrowerLendOffer = await prepareAndSignLendOffer({
        address: ADDRESSES.borrower,
        principalRaw: '500000000',
        allowedCollateral: nvdac,
        expectedQuote: quoteP2Offer,
        minRateBps: 850,
        termDays: 30,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        existingOpenUsdcSumRaw: 0n,
        expiryDays: 30,
        autoApprove: true,
        publishToApi: true,
        storage: ws35Storage,
        provider: walletProvider,
        cfg,
      });

      // Info 2: Warp past maturity + 24h (leaving stored contract status = Active while grace period has expired)
      const warpPastGraceSecs = Number(BigInt(p2ActiveState.maturity) - BigInt(p2ActiveState.blockTimestamp) + 86_400n + 120n);
      await rpcCall('evm_increaseTime', [warpPastGraceSecs]);
      await rpcCall('evm_mine', []);

      const overdueState = await readLoanOnChainState(p2LoanId, { cfg });
      assert.equal(overdueState.storedStatus, 0, 'Underlying LoanCore storedStatus remains Active before syncStatus');
      assert.equal(overdueState.isPastMaturity, true);
      assert.equal(overdueState.isPastGraceWindow, true);
      assert.equal(overdueState.isGrace, false, 'isGrace must be false once maturity+24h ends');
      assert.equal(overdueState.isOverdueDefaultPending, true);
      assert.equal(overdueState.statusName, 'Overdue - default pending');

      // Ensure partialRepay & extend stay strictly blocked in "Overdue - default pending"
      await assert.rejects(
        () =>
          verifyAndPreviewLoanRepay({
            loanId: p2LoanId,
            payerAddress: ADDRESSES.borrower,
            principalRepayRaw: '100000000',
            cfg,
          }),
        /Partial repay is only available while Loan #\d+ is Active before maturity/
      );
      await assert.rejects(
        () =>
          signLoanExtension({
            address: ADDRESSES.borrower,
            loanId: p2LoanId,
            newMaturity: BigInt(overdueState.maturity) + 86_400n,
            newRateBps: 850,
            provider: walletProvider,
            cfg,
          }),
        /cannot be extended/
      );

      // Info 1 (borrower with $500 open LendOffer): repay in full + trimBufferAllowance=true resets LoanCore allowance to exact 500_000_000n!
      const p2BorrowerRepayPreview = await verifyAndPreviewLoanRepay({
        loanId: p2LoanId,
        payerAddress: ADDRESSES.borrower,
        cfg,
      });
      assert.equal(p2BorrowerRepayPreview.payerIsBorrower, true);
      assert.equal(p2BorrowerRepayPreview.isThirdPartyPayer, false);
      assert.equal(p2BorrowerRepayPreview.existingOpenSumRaw, '500000000');

      const p2BorrowerRepayRes = await executeLoanRepay({
        address: ADDRESSES.borrower,
        loanId: p2LoanId,
        expectedPreview: p2BorrowerRepayPreview,
        autoApprove: true,
        trimBufferAllowance: true,
        provider: walletProvider,
        cfg,
      });
      assert.equal(p2BorrowerRepayRes.payerIsBorrower, true);
      assert.equal(p2BorrowerRepayRes.postTrimAllowanceRaw, '500000000');
      const borrowerLoanCoreAllowAfterTrim = BigInt(
        await publicClient.readContract({
          address: BASE_USDC,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [ADDRESSES.borrower, deployed.loanCore],
        })
      );
      assert.equal(
        borrowerLoanCoreAllowAfterTrim,
        500_000_000n,
        'trimBufferAllowance must preserve exact open LendOffer sum (500_000_000n) while clearing leftover buffer'
      );
      await cancelSignedLendOffer({
        address: ADDRESSES.borrower,
        offer: p2BorrowerLendOffer.offer,
        storage: ws35Storage,
        provider: walletProvider,
        cfg,
      });

      // Loans.jsx & Loan.jsx SSR + Source Verification (no PreviewBanner/mock rows, Low 1/2 + Info 1/2 UI controls wired)
      const p2LoansHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/loans'] }, createElement(Shell, null, createElement(Loans)))
        )
      );
      assert.ok(!p2LoansHtml.includes('Preview data, not your positions'), '/loans must not render PreviewBanner');
      assert.ok(
        p2LoansHtml.includes('Inspect any on-chain Loan ID directly') &&
          p2LoansHtml.includes('Indexed protocol loans'),
        '/loans must render live indexer & direct lookup UI'
      );

      const p2LoanDetailHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: [`/loans/${p2LoanId}`] },
            createElement(
              Shell,
              null,
              createElement(Routes, null, createElement(Route, { path: '/loans/:id', element: createElement(Loan) }))
            )
          )
        )
      );
      assert.ok(!p2LoanDetailHtml.includes('Preview data, not your positions'), '/loans/:id must not render PreviewBanner');
      assert.match(p2LoanDetailHtml, /Live Base State/);
      assert.match(p2LoanDetailHtml, /Refreshing on-chain state|Refresh LoanCore state/);

      const p2InvalidLoanHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: ['/loan/L-1'] },
            createElement(
              Shell,
              null,
              createElement(Routes, null, createElement(Route, { path: '/loan/:id', element: createElement(Loan) }))
            )
          )
        )
      );
      assert.ok(!p2InvalidLoanHtml.includes('Preview data, not your positions'), '/loan/L-1 must not render PreviewBanner');
      assert.match(p2InvalidLoanHtml, /not found/);

      const loanPageSrc = fs.readFileSync(path.join(process.cwd(), 'src/pages/Loan.jsx'), 'utf8');
      const loansPageSrc = fs.readFileSync(path.join(process.cwd(), 'src/pages/Loans.jsx'), 'utf8');
      assert.ok(
        loanPageSrc.includes('readLoanOnChainState') &&
          loanPageSrc.includes('verifyAndPreviewLoanRepay') &&
          loanPageSrc.includes('executeLoanRepay') &&
          loanPageSrc.includes('verifyAndPreviewLoanTopUp') &&
          loanPageSrc.includes('executeLoanTopUp') &&
          loanPageSrc.includes('signLoanExtension') &&
          loanPageSrc.includes('verifyAndPreviewLoanExtend') &&
          loanPageSrc.includes('executeLoanExtend') &&
          loanPageSrc.includes('Pay for someone else') &&
          loanPageSrc.includes('Top up for someone else') &&
          loanPageSrc.includes('walletIsHolderNotBorrower') &&
          loanPageSrc.includes('Deadline before signing') &&
          loanPageSrc.includes('trimBufferAllowance') &&
          loanPageSrc.includes('repaySeqRef.current') &&
          loanPageSrc.includes('topUpSeqRef.current') &&
          loanPageSrc.includes('extendVerifySeqRef.current') &&
          loanPageSrc.includes('[cleanId, web3?.address, web3?.chainId, web3?.wrongNetwork]') &&
          !loanPageSrc.includes('MaxUint256') &&
          loansPageSrc.includes('fetchPaginatedApiRows') &&
          loansPageSrc.includes('Overdue - default pending'),
        'Loan.jsx and Loans.jsx must wire all WS3.5 Piece 2 live actions, sequence/wallet guards, Lows 1-2, and Infos 1-2'
      );

      console.log('PASS WS3.5 Piece 2: Loans.jsx / Loan.jsx live UI, Low 1/2, & Info 1/2 verified.');

      // 3.11 WS3.6 Piece 1: EligibilityGate ABIs, attestation inspection, bumpMyNonce,
      // server IP geoblock (proxy-spoof resistant + fail-closed), wallet sanctions screening,
      // and EIP-712 Non-US / Reg S Declaration signing & verification (EOA + nonce invalidation)
      console.log('\n=== WS3.6 Piece 1: EligibilityGate, IP geoblock, sanctions screening & EIP-712 declaration ===');

      // 1) Canonical statement hash parity & on-chain getAttestationDigest parity
      const screeningBase = await fetchEligibilityScreening({ account: ADDRESSES.borrower, cfg });
      assert.equal(screeningBase.allowed, true);
      assert.equal(
        screeningBase.declaration_params.statement_hash.toLowerCase(),
        ELIGIBILITY_DECLARATION_STATEMENT_HASH.toLowerCase(),
        'API and frontend canonical Regulation S statement hashes must match identically'
      );
      assert.equal(screeningBase.declaration_params.domain.name, ELIGIBILITY_DECLARATION_DOMAIN_NAME);
      assert.equal(screeningBase.geo.verified, false);
      assert.equal(screeningBase.geo.status, 'local_unverified');

      // Spoof-resistance check: when trustProxyHops === 0, client-sent cf-ipcountry headers MUST be ignored
      const spoofedUsResp = await fetch(`${apiUrl}/eligibility?account=${ADDRESSES.borrower}`, {
        headers: { 'cf-ipcountry': 'US' },
      });
      assert.equal(spoofedUsResp.status, 200);
      const spoofedUsJson = (await spoofedUsResp.json()) as {
        geo: { verified: boolean; country_code: string | null; status: string };
      };
      assert.equal(spoofedUsJson.geo.verified, false, 'Untrusted direct cf-ipcountry header must be ignored when trustProxyHops=0');
      assert.equal(spoofedUsJson.geo.country_code, null);

      // 2) readEligibilityStatus + on-chain attestation digest parity + encode/decode + bumpEligibilityNonce
      const ws36UserKey = generatePrivateKey();
      const ws36UserAddr = getAddress(privateKeyToAccount(ws36UserKey).address);
      await rpcCall('anvil_setBalance', [ws36UserAddr, '0x56bc75e2d63100000']);

      const statusAllowlisted = await readEligibilityStatus(ADDRESSES.borrower, { cfg });
      assert.equal(statusAllowlisted.isEligible, true);
      assert.equal(statusAllowlisted.eligibilityReason, 'allowlisted');
      assert.equal(statusAllowlisted.attestationSigner.toLowerCase(), ADDRESSES.attestationSigner.toLowerCase());

      const statusUnallowlisted = await readEligibilityStatus(ws36UserAddr, { cfg });
      assert.equal(statusUnallowlisted.isEligible, false);
      assert.equal(statusUnallowlisted.eligibilityReason, 'ineligible');
      assert.equal(statusUnallowlisted.userNonce, '0');

      const ws36Block = await publicClient.getBlock({ blockTag: 'latest' });
      const ws36Expiry = ws36Block.timestamp + 3600n;
      const computedDigest = computeEligibilityAttestationDigest({
        chainId: BASE_CHAIN_ID,
        gateAddress: deployed.eligibilityGate,
        account: ws36UserAddr,
        nonce: 0n,
        expiry: ws36Expiry,
      });
      const onchainDigest = await publicClient.readContract({
        address: deployed.eligibilityGate,
        abi: eligibilityGateAbi,
        functionName: 'getAttestationDigest',
        args: [ws36UserAddr, 0n, ws36Expiry],
      });
      assert.equal(
        computedDigest.digest.toLowerCase(),
        (onchainDigest as string).toLowerCase(),
        'computeEligibilityAttestationDigest must match EligibilityGate.getAttestationDigest() on-chain'
      );

      const ws36AttSig = await attSignerAccount.signMessage({ message: { raw: computedDigest.structHash } });
      const ws36AttHex = encodeEligibilityAttestation({ expiry: ws36Expiry, signature: ws36AttSig });
      const decodedAtt = decodeEligibilityAttestation(ws36AttHex);
      assert.equal(decodedAtt.validFormat, true);
      assert.equal(decodedAtt.expiry, ws36Expiry.toString());
      assert.equal(decodeEligibilityAttestation('0x1234').validFormat, false);
      assert.equal(decodeEligibilityAttestation('0xabc').validFormat, false);

      const statusAttested = await readEligibilityStatus(ws36UserAddr, { attestationHex: ws36AttHex, cfg });
      assert.equal(statusAttested.isEligible, true);
      assert.equal(statusAttested.eligibilityReason, 'attested');
      assert.equal(statusAttested.attestation.validFormat, true);
      assert.equal(statusAttested.attestation.isExpired, false);
      assert.equal(statusAttested.attestation.matchesAttestationSigner, true);

      // Expired & wrong-signer & garbage attestation inspections must fail cleanly without throwing
      const expiredExpiry = ws36Block.timestamp - 10n;
      const expDigest = computeEligibilityAttestationDigest({
        chainId: BASE_CHAIN_ID,
        gateAddress: deployed.eligibilityGate,
        account: ws36UserAddr,
        nonce: 0n,
        expiry: expiredExpiry,
      });
      const expSig = await attSignerAccount.signMessage({ message: { raw: expDigest.structHash } });
      const expAttHex = encodeEligibilityAttestation({ expiry: expiredExpiry, signature: expSig });
      const statusExpiredAtt = await readEligibilityStatus(ws36UserAddr, { attestationHex: expAttHex, cfg });
      assert.equal(statusExpiredAtt.isEligible, false);
      assert.equal(statusExpiredAtt.attestation.isExpired, true);

      const wrongSig = await privateKeyToAccount(KEYS.borrower).signMessage({
        message: { raw: computedDigest.structHash },
      });
      const wrongAttHex = encodeEligibilityAttestation({ expiry: ws36Expiry, signature: wrongSig });
      const statusWrongSigner = await readEligibilityStatus(ws36UserAddr, { attestationHex: wrongAttHex, cfg });
      assert.equal(statusWrongSigner.isEligible, false);
      assert.equal(statusWrongSigner.attestation.matchesAttestationSigner, false);

      const statusGarbageAtt = await readEligibilityStatus(ws36UserAddr, { attestationHex: '0x1234', cfg });
      assert.equal(statusGarbageAtt.isEligible, false);
      assert.equal(statusGarbageAtt.attestation.validFormat, false);

      // bumpEligibilityNonce invalidates previously valid KYC attestation on-chain (zero ERC-20 approvals)
      walletProvider.setAccount(ws36UserKey);
      const ws36BumpRes = await bumpEligibilityNonce({
        address: ws36UserAddr,
        provider: walletProvider,
        cfg,
      });
      assert.equal(ws36BumpRes.previousNonce, '0');
      assert.equal(ws36BumpRes.newNonce, '1');
      const statusAfterBump = await readEligibilityStatus(ws36UserAddr, { attestationHex: ws36AttHex, cfg });
      assert.equal(statusAfterBump.userNonce, '1');
      assert.equal(statusAfterBump.isEligible, false, 'Old nonce=0 KYC attestation must fail after bumpMyNonce()');

      // 3) EIP-712 Non-US Declaration signing, API verification, attack guards, nonce invalidation & revocation
      await assert.rejects(
        () =>
          signEligibilityDeclaration({
            address: ws36UserAddr,
            jurisdiction: 'US',
            provider: walletProvider,
            cfg,
          }),
        /restricted under Regulation S/
      );
      await assert.rejects(
        () =>
          signEligibilityDeclaration({
            address: ws36UserAddr,
            jurisdiction: 'T1',
            provider: walletProvider,
            cfg,
          }),
        /restricted under Regulation S/
      );
      await assert.rejects(
        () =>
          signEligibilityDeclaration({
            address: ws36UserAddr,
            jurisdiction: 'SG',
            ttlSeconds: MAX_DECLARATION_TTL_SECS + 1n,
            provider: walletProvider,
            cfg,
          }),
        /exceeds maximum/
      );
      await assert.rejects(
        () =>
          signEligibilityDeclaration({
            address: ws36UserAddr,
            jurisdiction: 'SG',
            ttlSeconds: '3600.5' as unknown as bigint,
            provider: walletProvider,
            cfg,
          }),
        /unsigned integer/
      );

      const signedDecl = await signEligibilityDeclaration({
        address: ws36UserAddr,
        jurisdiction: 'SG',
        ttlSeconds: 3600n,
        submitToApi: true,
        provider: walletProvider,
        cfg,
      });
      assert.equal(signedDecl.declarationJson.nonce, '1');
      assert.equal(signedDecl.declarationJson.jurisdiction, 'SG');
      assert.equal(signedDecl.serverVerification?.verified, true);
      assert.equal(signedDecl.serverVerification?.allowed, true);

      const clientVerifyRes = await verifyEligibilityDeclaration({
        declaration: signedDecl.declarationJson,
        signature: signedDecl.signature,
        cfg,
      });
      assert.equal(clientVerifyRes.verified, true);
      assert.equal(
        clientVerifyRes.digest.toLowerCase(),
        signedDecl.serverVerification.declaration_digest.toLowerCase()
      );

      // Tampered statementHash, wrong signature, & >24h TTL must fail both client and API verification
      const tamperedHashResp = await fetch(`${apiUrl}/eligibility/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          declaration: {
            ...signedDecl.declarationJson,
            statementHash: `0x${'11'.repeat(32)}`,
          },
          signature: signedDecl.signature,
        }),
      });
      assert.equal(tamperedHashResp.status, 400);
      assert.equal(((await tamperedHashResp.json()) as { error: { code: string } }).error.code, 'INVALID_STATEMENT_HASH');

      const badSigResp = await fetch(`${apiUrl}/eligibility/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          declaration: signedDecl.declarationJson,
          signature: `0x${'aa'.repeat(65)}`,
        }),
      });
      assert.equal(badSigResp.status, 400);
      assert.equal(((await badSigResp.json()) as { error: { code: string } }).error.code, 'INVALID_DECLARATION_SIGNATURE');

      const longTtlResp = await fetch(`${apiUrl}/eligibility/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          declaration: {
            ...signedDecl.declarationJson,
            expiresAt: (BigInt(signedDecl.declarationJson.issuedAt) + 365n * 86_400n).toString(),
          },
          signature: signedDecl.signature,
        }),
      });
      assert.equal(longTtlResp.status, 400);
      assert.equal(((await longTtlResp.json()) as { error: { code: string } }).error.code, 'DECLARATION_TTL_OUT_OF_RANGE');

      // Nonce bump invalidates previously valid signed EIP-712 declaration BOTH client-side and server-side
      const bumpRes2 = await bumpEligibilityNonce({
        address: ws36UserAddr,
        provider: walletProvider,
        cfg,
      });
      assert.equal(bumpRes2.newNonce, '2');
      await assert.rejects(
        () =>
          verifyEligibilityDeclaration({
            declaration: signedDecl.declarationJson,
            signature: signedDecl.signature,
            cfg,
          }),
        /does not match on-chain EligibilityGate userNonce/
      );
      await assert.rejects(
        () =>
          submitEligibilityDeclaration({
            declaration: signedDecl.declarationJson,
            signature: signedDecl.signature,
            cfg,
          }),
        /NONCE_MISMATCH|does not match on-chain EligibilityGate userNonce/
      );

      // Revocation on EligibilityGate blocks readEligibilityStatus, signEligibilityDeclaration, GET /eligibility, & POST /eligibility/verify
      await publicClient.waitForTransactionReceipt({
        hash: await ownerClient.writeContract({
          address: deployed.eligibilityGate,
          abi: parseAbi(['function revokeUser(address account, bool revoked)']),
          functionName: 'revokeUser',
          args: [ws36UserAddr, true],
        }),
      });
      try {
        const revStatus = await readEligibilityStatus(ws36UserAddr, { cfg });
        assert.equal(revStatus.isRevoked, true);
        assert.equal(revStatus.eligibilityReason, 'revoked');
        const revScreening = await fetchEligibilityScreening({ account: ws36UserAddr, cfg });
        assert.equal(revScreening.allowed, false);
        assert.ok(revScreening.rejection_reasons.some((r: { code: string }) => r.code === 'WALLET_REVOKED'));
        await assert.rejects(
          () =>
            signEligibilityDeclaration({
              address: ws36UserAddr,
              jurisdiction: 'SG',
              provider: walletProvider,
              cfg,
            }),
          /revoked on EligibilityGate/
        );
        const revVerifyResp = await fetch(`${apiUrl}/eligibility/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            declaration: { ...signedDecl.declarationJson, nonce: '2' },
            signature: signedDecl.signature,
          }),
        });
        assert.equal(revVerifyResp.status, 403);
        assert.equal(((await revVerifyResp.json()) as { error: { code: string } }).error.code, 'WALLET_REVOKED');
      } finally {
        await publicClient.waitForTransactionReceipt({
          hash: await ownerClient.writeContract({
            address: deployed.eligibilityGate,
            abi: parseAbi(['function revokeUser(address account, bool revoked)']),
            functionName: 'revokeUser',
            args: [ws36UserAddr, false],
          }),
        });
      }

      // 4) Trusted Proxy IP Geoblock (fail-closed) + Sanctions Screening on ephemeral API instance
      const sanctionedKey = generatePrivateKey();
      const sanctionedAddr = getAddress(privateKeyToAccount(sanctionedKey).address);
      const geoApiCfg = loadApiConfig({
        rpcUrl: LOCAL_RPC_URL,
        isFork: true,
        forkChainId: BASE_CHAIN_ID,
        databaseUrl: 'memory://',
        corsOrigins: ['https://app.nostok.xyz'],
        rateLimitMax: 2000,
        rateLimitWindowMs: 60_000,
        trustProxyHops: 1,
        geoCountryHeader: 'cf-ipcountry',
        geoRequireHeader: true,
        sanctionedAddresses: [sanctionedAddr],
        maxBodyBytes: 4096,
        maxPageLimit: 100,
        loanCore: deployed.loanCore,
        orderSettlement: deployed.orderSettlement,
        liquidationAuction: deployed.liquidationAuction,
        positionNft: deployed.positionNFT,
        collateralEscrow: deployed.collateralEscrow,
        assetRegistry: deployed.assetRegistry,
        oracleRouter: deployed.oracleRouter,
        feeCollector: deployed.feeCollector,
        eligibilityGate: deployed.eligibilityGate,
        usdc: BASE_USDC,
      });
      const geoApiCtx = await createApiContext(geoApiCfg, wrapApiReadOnly(idxCtx.db));
      const geoApiServer = createApiServer(geoApiCtx);
      await new Promise<void>((r) => geoApiServer.listen(0, '127.0.0.1', r));
      const geoApiUrl = `http://127.0.0.1:${(geoApiServer.address() as net.AddressInfo).port}`;
      const geoCfg = { ...cfg, apiUrl: geoApiUrl };
      let validChDeclPayload: { declaration: unknown; signature: string } | undefined;

      try {
        // Missing geo header -> fail closed (GEO_UNVERIFIED) on GET /eligibility, POST /eligibility/verify, & POST /orders
        const noGeoGet = await fetch(`${geoApiUrl}/eligibility?account=${ADDRESSES.borrower}`);
        const noGeoJson = (await noGeoGet.json()) as { allowed: boolean; geo: { reason: string } };
        assert.equal(noGeoJson.allowed, false);
        assert.equal(noGeoJson.geo.reason, 'GEO_UNVERIFIED');

        const noGeoOrder = await fetch(`${geoApiUrl}/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert.equal(noGeoOrder.status, 403);
        assert.equal(((await noGeoOrder.json()) as { error: { code: string } }).error.code, 'GEO_UNVERIFIED');

        // US, lowercase us, IR, Tor T1, unknown XX, & malformed comma-separated header MUST all fail closed
        for (const [hdrVal, expectedCode] of [
          ['US', 'GEO_RESTRICTED'],
          ['us', 'GEO_RESTRICTED'],
          ['IR', 'GEO_RESTRICTED'],
          ['T1', 'GEO_TOR_BLOCKED'],
          ['XX', 'GEO_UNVERIFIED'],
          ['CH, US', 'GEO_HEADER_MALFORMED'],
        ] as const) {
          const r = await fetch(`${geoApiUrl}/eligibility?account=${ADDRESSES.borrower}`, {
            headers: { 'cf-ipcountry': hdrVal },
          });
          const j = (await r.json()) as { allowed: boolean; geo: { reason: string } };
          assert.equal(j.allowed, false, `cf-ipcountry="${hdrVal}" must be blocked`);
          assert.equal(j.geo.reason, expectedCode);
        }

        // Sanctioned wallet from allowed country CH -> blocked on GET /eligibility & POST /eligibility/verify
        const sancGet = await fetch(`${geoApiUrl}/eligibility?account=${sanctionedAddr}`, {
          headers: { 'cf-ipcountry': 'CH' },
        });
        const sancJson = (await sancGet.json()) as {
          allowed: boolean;
          wallet: { sanctioned: boolean };
          rejection_reasons: Array<{ code: string }>;
        };
        assert.equal(sancJson.allowed, false);
        assert.equal(sancJson.wallet.sanctioned, true);
        assert.ok(sancJson.rejection_reasons.some((r) => r.code === 'WALLET_SANCTIONED'));

        // Non-sanctioned borrower from CH: mismatching declared jurisdiction (GB != CH) rejected; matching CH passes!
        const chFetch: typeof fetch = (input, init) =>
          fetch(input, {
            ...init,
            headers: {
              ...(init?.headers ?? {}),
              'cf-ipcountry': 'CH',
            },
          });
        walletProvider.setAccount(KEYS.borrower);
        await assert.rejects(
          () =>
            signEligibilityDeclaration({
              address: ADDRESSES.borrower,
              jurisdiction: 'GB',
              provider: walletProvider,
              cfg: geoCfg,
              fetchImpl: chFetch,
            }),
          /does not match verified IP jurisdiction \(CH\)/
        );

        const chDecl = await signEligibilityDeclaration({
          address: ADDRESSES.borrower,
          submitToApi: true,
          provider: walletProvider,
          cfg: geoCfg,
          fetchImpl: chFetch,
        });
        assert.equal(chDecl.declarationJson.jurisdiction, 'CH');
        assert.equal(chDecl.serverVerification?.verified, true);
        assert.equal(chDecl.serverVerification?.geo?.country_code, 'CH');
        validChDeclPayload = {
          declaration: chDecl.declarationJson,
          signature: chDecl.signature,
        };

        // Replaying valid CH signature while edge header says US -> 403 GEO_RESTRICTED
        const usReplayResp = await fetch(`${geoApiUrl}/eligibility/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'cf-ipcountry': 'US' },
          body: JSON.stringify({
            declaration: chDecl.declarationJson,
            signature: chDecl.signature,
          }),
        });
        assert.equal(usReplayResp.status, 403);
        assert.equal(((await usReplayResp.json()) as { error: { code: string } }).error.code, 'GEO_RESTRICTED');

        // M1: /health reports geo + sanctions mode accurately on both geo-enforced and local fork servers
        const [geoHealthResp, forkHealthResp] = await Promise.all([
          fetch(`${geoApiUrl}/health`),
          fetch(`${apiUrl}/health`),
        ]);
        assert.equal(geoHealthResp.status, 200);
        assert.equal(forkHealthResp.status, 200);
        const geoHealth = (await geoHealthResp.json()) as {
          geo: { mode: string; enabled: boolean; require_header: boolean; trust_proxy_hops: number };
          sanctions: { mode: string; sanctioned_addresses_count: number };
        };
        const forkHealth = (await forkHealthResp.json()) as {
          geo: { mode: string; enabled: boolean };
          sanctions: { mode: string; sanctioned_addresses_count: number };
        };
        assert.equal(geoHealth.geo.mode, 'enforced');
        assert.equal(geoHealth.geo.enabled, true);
        assert.equal(geoHealth.geo.require_header, true);
        assert.equal(geoHealth.geo.trust_proxy_hops, 1);
        assert.equal(geoHealth.sanctions.mode, 'configured');
        assert.equal(geoHealth.sanctions.sanctioned_addresses_count, 1);
        assert.equal(forkHealth.geo.mode, 'local_unverified');
        assert.equal(forkHealth.geo.enabled, false);
        assert.equal(forkHealth.sanctions.mode, 'empty_list');
        assert.equal(forkHealth.sanctions.sanctioned_addresses_count, 0);
      } finally {
        await new Promise<void>((r) => geoApiServer.close(() => r()));
      }

      // 5) M1: FORK=false default env fails closed; SANCTIONED_ADDRESSES empty emits loud warning
      {
        const prevWarn = console.warn;
        const capturedWarnings: string[] = [];
        console.warn = (...args: unknown[]) => {
          capturedWarnings.push(args.map((a) => String(a)).join(' '));
        };
        try {
          const baseProdFields = {
            rpcUrl: LOCAL_RPC_URL,
            isFork: false,
            databaseUrl: 'postgres://user:pass@127.0.0.1:5432/nostok',
            corsOrigins: ['https://app.nostok.xyz'],
            loanCore: deployed.loanCore,
            orderSettlement: deployed.orderSettlement,
            liquidationAuction: deployed.liquidationAuction,
            positionNft: deployed.positionNFT,
            collateralEscrow: deployed.collateralEscrow,
            assetRegistry: deployed.assetRegistry,
            oracleRouter: deployed.oracleRouter,
            feeCollector: deployed.feeCollector,
            eligibilityGate: deployed.eligibilityGate,
            usdc: BASE_USDC,
          };
          assert.throws(
            () => loadApiConfig({ ...baseProdFields, trustProxyHops: 0, geoRequireHeader: false, geoDisabled: false }),
            /refuses to start without verified edge geoblock/i
          );
          capturedWarnings.length = 0;
          const okProd = loadApiConfig({
            ...baseProdFields,
            trustProxyHops: 1,
            geoRequireHeader: true,
            geoDisabled: false,
            sanctionedAddresses: [],
          });
          assert.equal(okProd.geoRequireHeader, true);
          assert.ok(
            capturedWarnings.some((w) => /\[API_SECURITY_WARNING\].*SANCTIONED_ADDRESSES is empty/i.test(w)),
            'Expected loud SANCTIONED_ADDRESSES warning on empty sanctions list'
          );
          capturedWarnings.length = 0;
          const overrideProd = loadApiConfig({ ...baseProdFields, geoDisabled: true });
          assert.equal(overrideProd.geoDisabled, true);
          assert.ok(
            capturedWarnings.some((w) => /\[API_SECURITY_WARNING\].*GEO_DISABLED=true/i.test(w)),
            'Expected loud GEO_DISABLED=true warning'
          );
        } finally {
          console.warn = prevWarn;
        }
      }

      // 6) L1: TRUSTED_PROXY_CIDRS rejects spoofed cf-ipcountry & X-Forwarded-For from untrusted direct peers
      {
        const l1UntrustedCfg = loadApiConfig({
          ...apiCfg,
          trustProxyHops: 1,
          geoRequireHeader: true,
          trustedProxyCidrs: ['10.0.0.0/8'],
          rateLimitMax: 2,
          rateLimitWindowMs: 60_000,
        });
        const l1UntrustedServer = createApiServer(await createApiContext(l1UntrustedCfg, wrapApiReadOnly(idxCtx.db)));
        await new Promise<void>((r) => l1UntrustedServer.listen(0, '127.0.0.1', r));
        const l1Url = `http://127.0.0.1:${(l1UntrustedServer.address() as net.AddressInfo).port}`;
        try {
          const spoofGet = await fetch(`${l1Url}/eligibility?account=${ADDRESSES.borrower}`, {
            headers: { 'cf-ipcountry': 'CH', 'X-Forwarded-For': '198.51.100.1' },
          });
          const spoofGetJson = (await spoofGet.json()) as {
            allowed: boolean;
            geo: { status: string; reason: string | null };
          };
          assert.equal(spoofGetJson.allowed, false);
          assert.equal(spoofGetJson.geo.status, 'untrusted_proxy');
          assert.equal(spoofGetJson.geo.reason, 'GEO_UNTRUSTED_PROXY');

          const spoofVerify = await fetch(`${l1Url}/eligibility/verify`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'cf-ipcountry': 'CH',
              'X-Forwarded-For': '198.51.100.2',
            },
            body: JSON.stringify(validChDeclPayload),
          });
          assert.equal(spoofVerify.status, 403);
          assert.equal(((await spoofVerify.json()) as { error: { code: string } }).error.code, 'GEO_UNTRUSTED_PROXY');

          const spoofRateLimit = await fetch(`${l1Url}/orders`, {
            headers: { 'X-Forwarded-For': '198.51.100.3' },
          });
          assert.equal(spoofRateLimit.status, 429);
        } finally {
          await new Promise<void>((r) => l1UntrustedServer.close(() => r()));
        }
      }

      console.log('PASS WS3.6 Piece 1: EligibilityGate, IP geoblock, sanctions screening, M1/L1 hardening & EIP-712 declaration verified.');

      // ---------------------------------------------------------------------
      // 3.12 WS3.6 Piece 2 (First Part): Gate, Compliance Screening Store & Declaration Binding
      // ---------------------------------------------------------------------
      console.log('\n=== WS3.6 Piece 2a: Verifiable Gate, compliance store, sessionStorage & declaration binding ===');

      // 1) fetchWalletState enriches eligibility with userNonce, blockTimestamp, eligibilityReason, & decoded attestation
      const enrichedWalletSnap = await fetchWalletState(ws36UserAddr, { cfg, attestationHex: ws36AttHex });
      assert.ok(enrichedWalletSnap?.eligibility, 'fetchWalletState must populate eligibility object');
      assert.equal(enrichedWalletSnap.eligibility.gateAddress.toLowerCase(), deployed.eligibilityGate.toLowerCase());
      assert.equal(enrichedWalletSnap.eligibility.userNonce, '2');
      assert.equal(enrichedWalletSnap.eligibility.isEligible, false, 'Old nonce=0 attestation ineligible after nonce=2 bump');
      assert.equal(enrichedWalletSnap.eligibility.eligibilityReason, 'ineligible');
      assert.equal(enrichedWalletSnap.eligibility.attestation.validFormat, true);
      assert.equal(enrichedWalletSnap.eligibility.attestation.matchesAttestationSigner, false);
      const garbageAttSnap = await fetchWalletState(ws36UserAddr, { cfg, attestationHex: '0x1234' });
      assert.equal(garbageAttSnap?.eligibility?.attestation?.validFormat, false);

      // 2) isHardRestrictionScreening blocks geo, sanctions & revoked wallets while allowing CH non-revoked wallets
      for (const blockedCode of [
        'GEO_RESTRICTED',
        'GEO_TOR_BLOCKED',
        'GEO_UNVERIFIED',
        'GEO_UNTRUSTED_PROXY',
        'GEO_HEADER_MALFORMED',
        'WALLET_SANCTIONED',
        'WALLET_REVOKED',
      ]) {
        assert.equal(
          isHardRestrictionScreening({
            allowed: false,
            geo: { allowed: blockedCode.startsWith('GEO_') ? false : true },
            wallet: { sanctioned: blockedCode === 'WALLET_SANCTIONED' },
            onchain: { is_revoked: blockedCode === 'WALLET_REVOKED' },
            rejection_reasons: [{ code: blockedCode, message: 'blocked' }],
          }),
          true,
          `${blockedCode} must trigger hard restriction`
        );
      }
      assert.equal(
        isHardRestrictionScreening(
          { allowed: true, geo: { allowed: true, verified: true, country_code: 'CH' }, wallet: { sanctioned: false }, onchain: { is_revoked: false }, rejection_reasons: [] },
          null
        ),
        false
      );
      assert.equal(isHardRestrictionScreening(null, { isRevoked: true }), true, 'On-chain revoked wallet must hard-restrict immediately');

      // 3) evaluateEligibilityDeclaration strict binding matrix
      walletProvider.setAccount(ws36UserKey);
      const freshPiece2Decl = await signEligibilityDeclaration({
        address: ws36UserAddr,
        jurisdiction: 'SG',
        ttlSeconds: 3600n,
        submitToApi: true,
        provider: walletProvider,
        cfg,
      });
      const validRecord = {
        account: freshPiece2Decl.declarationJson.account,
        chainId: BASE_CHAIN_ID,
        gateAddress: deployed.eligibilityGate,
        declarationJson: freshPiece2Decl.declarationJson,
        signature: freshPiece2Decl.signature,
        digest: freshPiece2Decl.digest,
        verifiedAt: new Date().toISOString(),
        serverVerification: freshPiece2Decl.serverVerification,
      };
      const evalOk = evaluateEligibilityDeclaration(validRecord, {
        address: ws36UserAddr,
        config: cfg,
        walletEligibility: enrichedWalletSnap.eligibility,
        screeningData: {
          allowed: true,
          geo: { allowed: true, verified: false, status: 'local_unverified', country_code: null },
          onchain: { user_nonce: '2', block_timestamp: enrichedWalletSnap.eligibility.blockTimestamp, is_revoked: false },
          declaration_params: { restricted_countries: ['US', 'CU', 'IR', 'KP', 'SY', 'RU', 'BY', 'MM'] },
        },
      });
      assert.equal(evalOk.valid, true, `Expected valid declaration, got ${evalOk.code}: ${evalOk.reason}`);
      assert.equal(evalOk.code, 'VERIFIED');
      assert.equal(evalOk.jurisdiction, 'SG');

      assert.equal(
        evaluateEligibilityDeclaration(null, { address: ws36UserAddr, config: cfg }).code,
        'DECLARATION_MISSING'
      );
      assert.equal(
        evaluateEligibilityDeclaration(validRecord, { address: null, config: cfg }).code,
        'WALLET_NOT_CONNECTED'
      );
      assert.equal(
        evaluateEligibilityDeclaration(validRecord, { address: ADDRESSES.borrower, config: cfg }).code,
        'DECLARATION_ACCOUNT_MISMATCH'
      );
      assert.equal(
        evaluateEligibilityDeclaration({ ...validRecord, chainId: 1 }, { address: ws36UserAddr, config: cfg }).code,
        'DECLARATION_CHAIN_MISMATCH'
      );
      assert.equal(
        evaluateEligibilityDeclaration(
          { ...validRecord, gateAddress: '0x0000000000000000000000000000000000000001' },
          { address: ws36UserAddr, config: cfg }
        ).code,
        'DECLARATION_GATE_MISMATCH'
      );
      assert.equal(
        evaluateEligibilityDeclaration(
          { ...validRecord, serverVerification: { verified: false } },
          { address: ws36UserAddr, config: cfg }
        ).code,
        'DECLARATION_UNVERIFIED'
      );
      assert.equal(
        evaluateEligibilityDeclaration(validRecord, {
          address: ws36UserAddr,
          config: cfg,
          walletEligibility: { ...enrichedWalletSnap.eligibility, isRevoked: true },
        }).code,
        'WALLET_REVOKED'
      );
      assert.equal(
        evaluateEligibilityDeclaration(validRecord, {
          address: ws36UserAddr,
          config: cfg,
          walletEligibility: { ...enrichedWalletSnap.eligibility, userNonce: '3' },
        }).code,
        'DECLARATION_NONCE_STALE'
      );
      assert.equal(
        evaluateEligibilityDeclaration(validRecord, {
          address: ws36UserAddr,
          config: cfg,
          walletEligibility: {
            ...enrichedWalletSnap.eligibility,
            blockTimestamp: (BigInt(freshPiece2Decl.declarationJson.expiresAt) + 1n).toString(),
          },
        }).code,
        'DECLARATION_EXPIRED'
      );
      assert.equal(
        evaluateEligibilityDeclaration(validRecord, {
          address: ws36UserAddr,
          config: cfg,
          walletEligibility: {
            ...enrichedWalletSnap.eligibility,
            blockTimestamp: (BigInt(freshPiece2Decl.declarationJson.issuedAt) - 301n).toString(),
          },
        }).code,
        'DECLARATION_FUTURE_TIMESTAMP'
      );
      assert.equal(
        evaluateEligibilityDeclaration(
          { ...validRecord, declarationJson: { ...validRecord.declarationJson, statementHash: '0x' + 'aa'.repeat(32) } },
          { address: ws36UserAddr, config: cfg }
        ).code,
        'DECLARATION_STATEMENT_MISMATCH'
      );
      assert.equal(
        evaluateEligibilityDeclaration(
          { ...validRecord, declarationJson: { ...validRecord.declarationJson, jurisdiction: 'US' } },
          { address: ws36UserAddr, config: cfg }
        ).code,
        'DECLARATION_JURISDICTION_RESTRICTED'
      );
      assert.equal(
        evaluateEligibilityDeclaration(validRecord, {
          address: ws36UserAddr,
          config: cfg,
        }).code,
        'DECLARATION_NONCE_UNAVAILABLE',
        'Low 1: missing live userNonce data MUST fail closed'
      );
      assert.equal(
        evaluateEligibilityDeclaration(validRecord, {
          address: ws36UserAddr,
          config: cfg,
          walletEligibility: enrichedWalletSnap.eligibility,
          screeningData: { allowed: true, geo: { verified: true, country_code: 'CH' } },
        }).code,
        'DECLARATION_GEO_MISMATCH'
      );
      assert.equal(
        evaluateEligibilityDeclaration(validRecord, {
          address: ws36UserAddr,
          config: cfg,
          screeningData: { allowed: false, rejection_reasons: [{ code: 'GEO_RESTRICTED', message: 'US blocked' }] },
        }).code,
        'SCREENING_REJECTED'
      );

      // 4) Live bumpEligibilityNonce invalidates valid declaration automatically via fresh fetchWalletState
      const bumpPiece2Res = await bumpEligibilityNonce({
        address: ws36UserAddr,
        provider: walletProvider,
        cfg,
      });
      assert.equal(bumpPiece2Res.newNonce, '3');
      const postBumpSnap = await fetchWalletState(ws36UserAddr, { cfg });
      assert.equal(postBumpSnap?.eligibility?.userNonce, '3');
      assert.equal(
        evaluateEligibilityDeclaration(validRecord, {
          address: ws36UserAddr,
          config: cfg,
          walletEligibility: postBumpSnap?.eligibility,
        }).code,
        'DECLARATION_NONCE_STALE'
      );

      // 5) Gate / Restricted / App / Shell SSR & sessionStorage bypass resistance
      const gateHtml = renderToStaticMarkup(createElement(StoreProvider, null, createElement(Gate)));
      assert.ok(!gateHtml.includes('type="radio"'), 'Mock location radio buttons must be removed from Gate.jsx');
      assert.ok(!gateHtml.includes('Where do you sit?'), 'Old mock gate prompt must be removed');
      assert.ok(gateHtml.includes('IP Geolocation:'), 'Gate must display live IP geolocation status');
      assert.ok(gateHtml.includes('Wallet screening:'), 'Gate must display wallet sanctions/gate screening');
      assert.ok(gateHtml.includes('Re-check screening'), 'Gate must provide screening refresh control');

      const restrictedHtml = renderToStaticMarkup(createElement(StoreProvider, null, createElement(Restricted)));
      assert.ok(restrictedHtml.includes('This interface is not available here.'));
      assert.ok(restrictedHtml.includes('Re-check IP &amp; wallet eligibility') || restrictedHtml.includes('Re-check IP & wallet eligibility'));
      assert.ok(!restrictedHtml.includes('Return to eligibility'), 'Unconditional reset escape hatch must be removed from Restricted');

      const checkingHtml = renderToStaticMarkup(createElement(GateChecking));
      assert.ok(checkingHtml.includes('Verifying eligibility.'));

      // Simulated sessionStorage: pre-seeded gate=accepted MUST NOT expose Shell/Markets before GET /eligibility resolves
      const origSessionStorage = (globalThis as Record<string, unknown>).sessionStorage;
      const memStorage = new Map<string, string>();
      (globalThis as Record<string, unknown>).sessionStorage = {
        getItem: (k: string) => memStorage.get(k) ?? null,
        setItem: (k: string, v: string) => { memStorage.set(k, String(v)); },
        removeItem: (k: string) => { memStorage.delete(k); },
      };
      try {
        memStorage.set('nostok-store-v1', JSON.stringify({ v: 2, gate: 'accepted', orders: [], loans: [], listings: [], claims: [], dismissed: [], nextId: 4000 }));
        const preScreenAppHtml = renderToStaticMarkup(
          createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: ['/markets'] }, createElement(Frame)))
        );
        assert.ok(
          preScreenAppHtml.includes('Verifying eligibility.'),
          'Frame with stored gate=accepted MUST hold on GateChecking until live GET /eligibility runs'
        );
        assert.ok(!preScreenAppHtml.includes('Markets'), 'Gated nav must not render prior to compliance verification');

        memStorage.set('nostok-store-v1', JSON.stringify({ v: 2, gate: 'restricted', orders: [], loans: [], listings: [], claims: [], dismissed: [], nextId: 4000 }));
        const restrictedFrameHtml = renderToStaticMarkup(
          createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: ['/markets'] }, createElement(Frame)))
        );
        assert.ok(restrictedFrameHtml.includes('This interface is not available here.'));

        savePersistedDeclaration(validRecord);
        const rawStoredDecl = JSON.parse(memStorage.get('nostok-eligibility-declaration-v1') ?? '{}') as Record<string, unknown>;
        assert.equal(rawStoredDecl.serverVerification, undefined, 'Low 1: serverVerification MUST NOT be persisted to sessionStorage');

        // Fake sessionStorage payload claiming serverVerification.verified=true + junk signature MUST load unverified
        memStorage.set(
          'nostok-eligibility-declaration-v1',
          JSON.stringify({
            ...validRecord,
            signature: `0x${'ab'.repeat(65)}`,
            serverVerification: { verified: true },
          })
        );
        const restoredTampered = loadPersistedDeclaration();
        assert.equal(restoredTampered?.serverVerification, null, 'Low 1: loadPersistedDeclaration MUST strip serverVerification');
        assert.equal(
          evaluateEligibilityDeclaration(restoredTampered, {
            address: ws36UserAddr,
            config: cfg,
            walletEligibility: postBumpSnap?.eligibility,
          }).code,
          'DECLARATION_UNVERIFIED'
        );

        savePersistedDeclaration(validRecord);
        const restoredDecl = loadPersistedDeclaration();
        assert.equal(restoredDecl?.signature, validRecord.signature);
        assert.equal(restoredDecl?.declarationJson?.account, ws36UserAddr);
        assert.equal(restoredDecl?.serverVerification, null);
        savePersistedDeclaration(null);
        assert.equal(loadPersistedDeclaration(), null);
      } finally {
        if (origSessionStorage === undefined) delete (globalThis as Record<string, unknown>).sessionStorage;
        else (globalThis as Record<string, unknown>).sessionStorage = origSessionStorage;
      }

      const shellStatusHtml = renderToStaticMarkup(
        createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: ['/markets'] }, createElement(Shell, null, createElement(Markets))))
      );
      assert.ok(shellStatusHtml.includes('Geo pending'), 'Shell status line must surface compliance geo indicator');

      console.log('PASS WS3.6 Piece 2a: Verifiable Gate, Restricted guard, compliance store & declaration binding verified.');

      // ---------------------------------------------------------------------
      // 3.13 WS3.6 Piece 2b: Low 1 + Info 1 + Wallet.jsx + Borrow/Lend/Loan Reg S Gating
      // ---------------------------------------------------------------------
      console.log('\n=== WS3.6 Piece 2b: Low 1 re-verify, Info 1 screening clear, Wallet.jsx & Borrow/Lend/Loan gating ===');

      // Info 1: createWalletEventsHandler.onAccountsChanged synchronously clears screening before async fetch completes
      {
        const syncEvents: Array<Record<string, unknown>> = [];
        const infoConnRef = { current: { connected: true, address: ADDRESSES.borrower, wrongNetwork: false } };
        const infoSiweRef = { current: null };
        const infoSeqRef = { current: 0 };
        const handler = createWalletEventsHandler({
          connRef: infoConnRef as any,
          siweRef: infoSiweRef as any,
          snapshotSeqRef: infoSeqRef,
          updateWalletConn: (fn: any) => {
            const next = typeof fn === 'function' ? fn(infoConnRef.current) : fn;
            infoConnRef.current = next;
            return next;
          },
          setWalletSnapshot: () => {},
          clearLocalSiweState: () => {},
          refreshWalletData: () => Promise.resolve(null),
          onComplianceContextReset: (evt: Record<string, unknown>) => syncEvents.push(evt),
        });
        handler.onAccountsChanged([ADDRESSES.lender]);
        assert.equal(syncEvents.length, 1);
        assert.equal(syncEvents[0].accountChanged, true);
        assert.equal(syncEvents[0].clearScreening, true);
        assert.equal(syncEvents[0].nextAddress, ADDRESSES.lender);
        handler.onAccountsChanged([]);
        assert.equal(syncEvents.length, 2);
        assert.equal(syncEvents[1].clearScreening, true);
        assert.equal(syncEvents[1].nextAddress, null);
      }

      // Low 1: On-load & pre-tx live POST /eligibility/verify re-verification against real fork & API
      walletProvider.setAccount(ws36UserKey);
      const piece2bDecl = await signEligibilityDeclaration({
        address: ws36UserAddr,
        jurisdiction: 'CH',
        ttlSeconds: 3600n,
        submitToApi: true,
        provider: walletProvider,
        cfg,
      });
      const unsignedStrippedDecl = {
        account: piece2bDecl.declarationJson.account,
        chainId: BASE_CHAIN_ID,
        gateAddress: deployed.eligibilityGate,
        declarationJson: piece2bDecl.declarationJson,
        signature: piece2bDecl.signature,
        digest: piece2bDecl.digest,
        serverVerification: null,
      };
      const reverified = await verifyStoredDeclarationOnServer({
        declaration: unsignedStrippedDecl,
        address: ws36UserAddr,
        cfg,
      });
      assert.equal(reverified.verified, true);
      assert.equal(reverified.record.serverVerification.verified, true);
      assert.equal(
        evaluateEligibilityDeclaration(reverified.record, {
          address: ws36UserAddr,
          config: cfg,
          walletEligibility: reverified.liveStatus,
        }).code,
        'VERIFIED'
      );

      // Tampered junk signature in stored declaration MUST be rejected by verifyStoredDeclarationOnServer
      await assert.rejects(
        () =>
          verifyStoredDeclarationOnServer({
            declaration: {
              ...unsignedStrippedDecl,
              signature: `0x${'ab'.repeat(65)}`,
            },
            address: ws36UserAddr,
            cfg,
          }),
        /INVALID_DECLARATION_SIGNATURE|signature|verification/i
      );

      // Live geo-enforced API server: switching IP to US rejects verifyStoredDeclarationOnServer before any tx
      const piece2bGeoCfg = loadApiConfig({
        rpcUrl: LOCAL_RPC_URL,
        isFork: true,
        forkChainId: BASE_CHAIN_ID,
        databaseUrl: 'memory://',
        corsOrigins: ['https://app.nostok.xyz'],
        rateLimitMax: 2000,
        rateLimitWindowMs: 60_000,
        trustProxyHops: 1,
        geoCountryHeader: 'cf-ipcountry',
        geoRequireHeader: true,
        sanctionedAddresses: [],
        maxBodyBytes: 4096,
        maxPageLimit: 100,
        loanCore: deployed.loanCore,
        orderSettlement: deployed.orderSettlement,
        liquidationAuction: deployed.liquidationAuction,
        positionNft: deployed.positionNFT,
        collateralEscrow: deployed.collateralEscrow,
        assetRegistry: deployed.assetRegistry,
        oracleRouter: deployed.oracleRouter,
        feeCollector: deployed.feeCollector,
        eligibilityGate: deployed.eligibilityGate,
        usdc: BASE_USDC,
      });
      const piece2bGeoServer = createApiServer(await createApiContext(piece2bGeoCfg, wrapApiReadOnly(idxCtx.db)));
      await new Promise<void>((r) => piece2bGeoServer.listen(0, '127.0.0.1', r));
      const piece2bGeoUrl = `http://127.0.0.1:${(piece2bGeoServer.address() as net.AddressInfo).port}`;
      try {
        await assert.rejects(
          () =>
            verifyStoredDeclarationOnServer({
              declaration: unsignedStrippedDecl,
              address: ws36UserAddr,
              cfg: { ...cfg, apiUrl: piece2bGeoUrl },
              submitImpl: (args: any) =>
                submitEligibilityDeclaration({
                  ...args,
                  fetchImpl: (input: any, init: any) =>
                    fetch(input, {
                      ...init,
                      headers: { ...(init?.headers ?? {}), 'cf-ipcountry': 'US' },
                    }),
                }),
            }),
          /GEO_RESTRICTED|restricted/i
        );
      } finally {
        await new Promise<void>((r) => piece2bGeoServer.close(() => r()));
      }

      // On-chain bumpEligibilityNonce immediately invalidates pre-tx verifyStoredDeclarationOnServer check
      const bump2bRes = await bumpEligibilityNonce({
        address: ws36UserAddr,
        provider: walletProvider,
        cfg,
      });
      assert.equal(bump2bRes.newNonce, '4');
      await assert.rejects(
        () =>
          verifyStoredDeclarationOnServer({
            declaration: unsignedStrippedDecl,
            address: ws36UserAddr,
            cfg,
          }),
        /does not match on-chain EligibilityGate userNonce|does not match declaration nonce|NONCE_MISMATCH/i
      );

      // Wallet.jsx, Borrow.jsx, Lend.jsx, Loan.jsx SSR checks + gating coverage
      const walletHtml = renderToStaticMarkup(
        createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: ['/wallet'] }, createElement(Wallet)))
      );
      assert.ok(
        walletHtml.includes('Compliance, EligibilityGate &amp; EIP-712 Reg S Declaration'),
        'Wallet.jsx must render compliance & Reg S declaration sheet'
      );
      assert.ok(walletHtml.includes('Sign &amp; verify EIP-712 Reg S declaration'));
      assert.ok(walletHtml.includes('Bump EligibilityGate nonce (on-chain)'));

      const borrowGateHtml = renderToStaticMarkup(
        createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: ['/borrow'] }, createElement(Borrow)))
      );
      assert.ok(borrowGateHtml.includes('EIP-712 Reg S declaration'), 'Borrow.jsx must render Reg S declaration status row');

      const lendGateHtml = renderToStaticMarkup(
        createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: ['/lend'] }, createElement(Lend)))
      );
      assert.ok(lendGateHtml.includes('EIP-712 Reg S declaration'), 'Lend.jsx must render Reg S declaration status row');

      const loanGateHtml = renderToStaticMarkup(
        createElement(
          StoreProvider,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: ['/loans/1'] },
            createElement(Routes, null, createElement(Route, { path: '/loans/:id', element: createElement(Loan) }))
          )
        )
      );
      assert.ok(loanGateHtml.includes('Loan #1'), 'Loan.jsx detail route must render cleanly with Reg S gate');

      for (const pageFile of ['Borrow.jsx', 'Lend.jsx', 'Loan.jsx']) {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'pages', pageFile), 'utf8');
        assert.ok(src.includes('ComplianceTxGateBanner'), `${pageFile} must render ComplianceTxGateBanner`);
        assert.ok(src.includes('ensureDeclarationVerifiedForTx()'), `${pageFile} must enforce pre-tx Reg S re-verification`);
        assert.ok(src.includes('eligibilityDeclarationValid'), `${pageFile} must gate tx buttons on eligibilityDeclarationValid`);
      }

      console.log('PASS WS3.6 Piece 2b: Low 1, Info 1, Wallet.jsx declaration UI & Borrow/Lend/Loan Reg S gating verified.');

      // ---------------------------------------------------------------------
      // 3.14 M1 Fix: Safety / Exit Actions Never Blocked Under US IP, Revoked Wallet or API Outage
      // ---------------------------------------------------------------------
      console.log('\n=== WS3.6 Piece 2b M1 Fix: Manage existing positions & exit actions under US IP / revoked / API outage ===');

      // 1) Restricted & Gate expose "Manage existing positions" links to /loans, /loan/:id, /borrow, /lend, /wallet
      assert.ok(restrictedHtml.includes('Manage existing positions (/loans)'));
      assert.ok(restrictedHtml.includes('/loans'));
      assert.ok(restrictedHtml.includes('/loan/&lt;id&gt;') || restrictedHtml.includes('/loan/'));
      assert.ok(gateHtml.includes('Manage existing positions (/loans)'));

      // With restricted gate persisted, /markets stays behind Restricted while safety/exit routes bypass Restricted
      const m1StorageMap = new Map<string, string>();
      const origM1SessionStorage = (globalThis as Record<string, unknown>).sessionStorage;
      (globalThis as Record<string, unknown>).sessionStorage = {
        getItem: (k: string) => m1StorageMap.get(k) ?? null,
        setItem: (k: string, v: string) => { m1StorageMap.set(k, String(v)); },
        removeItem: (k: string) => { m1StorageMap.delete(k); },
      };
      try {
        m1StorageMap.set(
          'nostok-store-v1',
          JSON.stringify({ v: 2, gate: 'restricted', orders: [], loans: [], listings: [], claims: [], dismissed: [], nextId: 4000 })
        );
        const blockedMarketsHtml = renderToStaticMarkup(
          createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: ['/markets'] }, createElement(Frame)))
        );
        assert.ok(blockedMarketsHtml.includes('This interface is not available here.'));
        assert.ok(blockedMarketsHtml.includes('Manage existing positions (/loans)'));

        for (const exitRoute of ['/loans', '/loans/', '/loans/1', '/loans/1/', '/loan/1', '/loan/1/', '/positions', '/positions/', '/borrow', '/borrow/', '/lend', '/lend/', '/wallet', '/wallet/']) {
          assert.equal(isSafetyOrExitRoute(exitRoute), true, `${exitRoute} must match isSafetyOrExitRoute`);
          const exitHtml = renderToStaticMarkup(
            createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: [exitRoute] }, createElement(Frame)))
          );
          assert.ok(
            !exitHtml.includes('This interface is not available here.'),
            `${exitRoute} must remain reachable even when Restricted`
          );
          assert.ok(!exitHtml.includes('<h1>Verifying eligibility.</h1>'), `${exitRoute} must not hold behind GateChecking`);
        }

        // Trailing-empty or extra segments (/loan/, /loan/1/x, /loans/1/x, /borrow/x) must NEVER bypass Restricted/Gate!
        for (const nonExitRoute of ['/loan/', '/loan/1/x', '/loan/1/x/', '/loans/1/x', '/borrow/extra']) {
          assert.equal(isSafetyOrExitRoute(nonExitRoute), false, `${nonExitRoute} must not match isSafetyOrExitRoute`);
          const nonExitHtml = renderToStaticMarkup(
            createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: [nonExitRoute] }, createElement(Frame)))
          );
          assert.ok(
            nonExitHtml.includes('This interface is not available here.'),
            `${nonExitRoute} must remain gated behind Restricted instead of showing Home ungated`
          );
        }
        assert.equal(normalizeRoutePath('/borrow/'), '/borrow');

        const restrictedWithRouter = renderToStaticMarkup(
          createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(Restricted)))
        );
        assert.ok(restrictedWithRouter.includes('href="/loans"'));
        assert.ok(restrictedWithRouter.includes('Open /loan/:id'));
      } finally {
        if (origM1SessionStorage === undefined) delete (globalThis as Record<string, unknown>).sessionStorage;
        else (globalThis as Record<string, unknown>).sessionStorage = origM1SessionStorage;
      }

      // 2) Verify source separation: safety/exit handlers NEVER call ensureDeclarationVerifiedForTx(), new-risk handlers DO
      const extractHandlerBody = (src: string, fnHeader: string) => {
        const start = src.indexOf(fnHeader);
        assert.ok(start >= 0, `Missing handler ${fnHeader}`);
        const braceStart = src.indexOf('{', start);
        let depth = 0;
        for (let i = braceStart; i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
          }
        }
        return src.slice(start);
      };
      const loanPageSource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'pages', 'Loan.jsx'), 'utf8');
      assert.ok(!extractHandlerBody(loanPageSource, 'async function handleConfirmRepay(').includes('ensureDeclarationVerifiedForTx'));
      assert.ok(!extractHandlerBody(loanPageSource, 'async function handleConfirmTopUp(').includes('ensureDeclarationVerifiedForTx'));
      assert.ok(extractHandlerBody(loanPageSource, 'async function handleSignExtend(').includes('ensureDeclarationVerifiedForTx'));
      assert.ok(extractHandlerBody(loanPageSource, 'async function handleConfirmExtend(').includes('ensureDeclarationVerifiedForTx'));

      const borrowPageSource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'pages', 'Borrow.jsx'), 'utf8');
      for (const exitFn of [
        'async function handleReduceCollateralAfterCancel(',
        'async function handleCancelOrder(',
        'async function handleCancelPastedJson(',
        'async function handleBumpAllNonces(',
      ]) {
        assert.ok(!extractHandlerBody(borrowPageSource, exitFn).includes('ensureDeclarationVerifiedForTx'), `${exitFn} must NOT require Reg S declaration`);
      }
      for (const riskFn of [
        'async function handleApproveCollateral(',
        'async function handleSignBorrowOrder(',
        'async function handleConfirmFillLendOffer(',
      ]) {
        assert.ok(extractHandlerBody(borrowPageSource, riskFn).includes('ensureDeclarationVerifiedForTx'), `${riskFn} MUST enforce Reg S declaration`);
      }

      const lendPageSource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'pages', 'Lend.jsx'), 'utf8');
      for (const exitFn of [
        'async function handleReduceAllowanceAfterCancel(',
        'async function handleCancelOffer(',
        'async function handleCancelPastedJson(',
        'async function handleBumpAllNonces(',
      ]) {
        assert.ok(!extractHandlerBody(lendPageSource, exitFn).includes('ensureDeclarationVerifiedForTx'), `${exitFn} must NOT require Reg S declaration`);
      }
      for (const riskFn of [
        'async function handleApproveUsdc(',
        'async function handleSignLendOffer(',
        'async function handleConfirmFillBorrowOrder(',
      ]) {
        assert.ok(extractHandlerBody(lendPageSource, riskFn).includes('ensureDeclarationVerifiedForTx'), `${riskFn} MUST enforce Reg S declaration`);
      }

      // 3) Live fork setup: open an active loan + open BorrowOrder + open LendOffer on clean chain
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [140_00000000n],
        }),
      });
      const m1Store = new Map<string, string>();
      const m1Storage = {
        getItem: (k: string) => m1Store.get(k) ?? null,
        setItem: (k: string, v: string) => { m1Store.set(k, String(v)); },
        removeItem: (k: string) => { m1Store.delete(k); },
      };

      walletProvider.setAccount(KEYS.borrower);
      const m1Quote = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '700000000',
        termDays: 14,
        aprBps: 800,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      const m1FillBorrowOrd = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '700000000',
        expectedQuote: m1Quote,
        requireExpectedQuote: true,
        maxRateBps: 800,
        termDays: 14,
        maxLtvBps: 6000,
        minFillRaw: '700000000',
        existingOpenCollateralRaw: 0n,
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        storage: m1Storage,
        provider: walletProvider,
        cfg,
      });
      walletProvider.setAccount(KEYS.lender);
      const m1OpenedLoan = await fillBorrowOrderAsLender({
        address: ADDRESSES.lender,
        order: m1FillBorrowOrd.order,
        signature: m1FillBorrowOrd.signature,
        fillUsdcRaw: '700000000',
        existingOpenSumRaw: 0n,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      const m1LoanId = m1OpenedLoan.loanId;
      assert.ok(m1LoanId, 'M1 test loan must open cleanly');

      // Also create an open BorrowOrder + open LendOffer to test cancelling, bumping nonce, and reducing allowances under restrictions
      m1Store.clear();
      walletProvider.setAccount(KEYS.borrower);
      const m1OpenBorrowOrd = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '600000000',
        expectedQuote: await fetchLoanQuote({
          cfg,
          asset: nvdac,
          principalRaw: '600000000',
          termDays: 14,
          aprBps: 800,
          maxLtvBps: 6000,
          borrower: ADDRESSES.borrower,
        }),
        requireExpectedQuote: true,
        maxRateBps: 800,
        termDays: 14,
        maxLtvBps: 6000,
        minFillRaw: '600000000',
        existingOpenCollateralRaw: 0n,
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        storage: m1Storage,
        provider: walletProvider,
        cfg,
      });

      walletProvider.setAccount(KEYS.lender);
      const m1OpenLendOffer = await prepareAndSignLendOffer({
        address: ADDRESSES.lender,
        principalRaw: '600000000',
        allowedCollateral: nvdac,
        expectedQuote: await fetchLoanQuote({
          cfg,
          asset: nvdac,
          principalRaw: '600000000',
          termDays: 14,
          aprBps: 800,
          maxLtvBps: 6000,
        }),
        requireExpectedQuote: true,
        minRateBps: 800,
        termDays: 14,
        maxLtvBps: 6000,
        minFillRaw: '600000000',
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        storage: m1Storage,
        provider: walletProvider,
        cfg,
      });

      // Sign a valid borrower CH declaration at current state for testing blocked re-verify under US IP / revoked / API outage
      walletProvider.setAccount(KEYS.borrower);
      const borrowerValidDecl = await signEligibilityDeclaration({
        address: ADDRESSES.borrower,
        jurisdiction: 'CH',
        ttlSeconds: 3600n,
        submitToApi: true,
        provider: walletProvider,
        cfg,
      });
      const borrowerDeclRecord = {
        account: borrowerValidDecl.declarationJson.account,
        chainId: BASE_CHAIN_ID,
        gateAddress: deployed.eligibilityGate,
        declarationJson: borrowerValidDecl.declarationJson,
        signature: borrowerValidDecl.signature,
        digest: borrowerValidDecl.digest,
        serverVerification: null,
      };

      // Mode A: US IP (GEO_RESTRICTED) -> cannot sign/verify/post-order/extend, BUT CAN topUp, partialRepay, cancel & reduce allowance!
      const usGeoApiCfg = loadApiConfig({
        rpcUrl: LOCAL_RPC_URL,
        isFork: true,
        forkChainId: BASE_CHAIN_ID,
        databaseUrl: 'memory://',
        corsOrigins: ['https://app.nostok.xyz'],
        rateLimitMax: 2000,
        rateLimitWindowMs: 60_000,
        trustProxyHops: 1,
        geoCountryHeader: 'cf-ipcountry',
        geoRequireHeader: true,
        sanctionedAddresses: [],
        maxBodyBytes: 4096,
        maxPageLimit: 100,
        loanCore: deployed.loanCore,
        orderSettlement: deployed.orderSettlement,
        liquidationAuction: deployed.liquidationAuction,
        positionNft: deployed.positionNFT,
        collateralEscrow: deployed.collateralEscrow,
        assetRegistry: deployed.assetRegistry,
        oracleRouter: deployed.oracleRouter,
        feeCollector: deployed.feeCollector,
        eligibilityGate: deployed.eligibilityGate,
        usdc: BASE_USDC,
      });
      const usGeoApiServer = createApiServer(await createApiContext(usGeoApiCfg, wrapApiReadOnly(idxCtx.db)));
      await new Promise<void>((r) => usGeoApiServer.listen(0, '127.0.0.1', r));
      const usGeoApiUrl = `http://127.0.0.1:${(usGeoApiServer.address() as net.AddressInfo).port}`;
      const usCfg = { ...cfg, apiUrl: usGeoApiUrl };
      const usFetch: typeof fetch = (input, init) =>
        fetch(input, { ...init, headers: { ...(init?.headers ?? {}), 'cf-ipcountry': 'US' } });
      try {
        await assert.rejects(
          () =>
            signEligibilityDeclaration({
              address: ADDRESSES.borrower,
              provider: walletProvider,
              cfg: usCfg,
              fetchImpl: usFetch,
            }),
          /GEO_RESTRICTED|restricted/i
        );
        await assert.rejects(
          () =>
            verifyStoredDeclarationOnServer({
              declaration: borrowerDeclRecord,
              address: ADDRESSES.borrower,
              cfg: usCfg,
              submitImpl: (args: any) => submitEligibilityDeclaration({ ...args, fetchImpl: usFetch }),
            }),
          /GEO_RESTRICTED|restricted/i
        );
        const usPostOrder = await usFetch(`${usGeoApiUrl}/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert.equal(usPostOrder.status, 403);
        assert.equal(((await usPostOrder.json()) as { error: { code: string } }).error.code, 'GEO_RESTRICTED');

        // Safety actions from US IP MUST still succeed
        walletProvider.setAccount(KEYS.borrower);
        const usTopUpPrev = await verifyAndPreviewLoanTopUp({
          loanId: m1LoanId,
          additionalCollateralRaw: '100000000000000000', // 0.1 NVDAc
          payerAddress: ADDRESSES.borrower,
          storage: m1Storage,
          cfg: usCfg,
        });
        const usTopUpRes = await executeLoanTopUp({
          address: ADDRESSES.borrower,
          loanId: m1LoanId,
          additionalCollateralRaw: '100000000000000000',
          expectedPreview: usTopUpPrev,
          autoApprove: true,
          storage: m1Storage,
          provider: walletProvider,
          cfg: usCfg,
        });
        assert.ok(usTopUpRes.txHash, 'US IP borrower must still be able to top up collateral');

        const usPartialPrev = await verifyAndPreviewLoanRepay({
          loanId: m1LoanId,
          payerAddress: ADDRESSES.borrower,
          principalRepayRaw: '100000000', // $100 partial repay
          storage: m1Storage,
          cfg: usCfg,
        });
        const usPartialRes = await executeLoanRepay({
          address: ADDRESSES.borrower,
          loanId: m1LoanId,
          principalRepayRaw: '100000000',
          expectedPreview: usPartialPrev,
          autoApprove: true,
          storage: m1Storage,
          provider: walletProvider,
          cfg: usCfg,
        });
        assert.equal(usPartialRes.isPartial, true);

        const usCancelBorrow = await cancelSignedBorrowOrder({
          address: ADDRESSES.borrower,
          order: m1OpenBorrowOrd.order,
          storage: m1Storage,
          provider: walletProvider,
          cfg: usCfg,
        });
        assert.ok(usCancelBorrow.txHash, 'US IP maker must still be able to cancel BorrowOrder');
        const usReduceColl = await setCollateralAllowanceForBorrow({
          address: ADDRESSES.borrower,
          collateralToken: nvdac,
          targetAllowanceRaw: '0',
          provider: walletProvider,
          cfg: usCfg,
        });
        assert.equal(usReduceColl.allowanceRaw, '0');
      } finally {
        await new Promise<void>((r) => usGeoApiServer.close(() => r()));
      }

      // Mode B: Revoked wallet -> cannot sign/verify declaration or fill new orders, BUT CAN topUp, partialRepay, bumpNonce, reduce allowance!
      await publicClient.waitForTransactionReceipt({
        hash: await ownerClient.writeContract({
          address: deployed.eligibilityGate,
          abi: parseAbi(['function revokeUser(address account, bool revoked)']),
          functionName: 'revokeUser',
          args: [ADDRESSES.borrower, true],
        }),
      });
      try {
        await assert.rejects(
          () =>
            verifyStoredDeclarationOnServer({
              declaration: borrowerDeclRecord,
              address: ADDRESSES.borrower,
              cfg,
            }),
          /WALLET_REVOKED|revoked/i
        );
        const revScreen = await fetchEligibilityScreening({ account: ADDRESSES.borrower, cfg });
        assert.equal(isHardRestrictionScreening(revScreen, null), true);

        walletProvider.setAccount(KEYS.borrower);
        const revTopUpPrev = await verifyAndPreviewLoanTopUp({
          loanId: m1LoanId,
          additionalCollateralRaw: '100000000000000000',
          payerAddress: ADDRESSES.borrower,
          storage: m1Storage,
          cfg,
        });
        const revTopUpRes = await executeLoanTopUp({
          address: ADDRESSES.borrower,
          loanId: m1LoanId,
          additionalCollateralRaw: '100000000000000000',
          expectedPreview: revTopUpPrev,
          autoApprove: true,
          storage: m1Storage,
          provider: walletProvider,
          cfg,
        });
        assert.ok(revTopUpRes.txHash, 'Revoked borrower must still be able to topUp collateral');

        const revPartialPrev = await verifyAndPreviewLoanRepay({
          loanId: m1LoanId,
          payerAddress: ADDRESSES.borrower,
          principalRepayRaw: '50000000',
          storage: m1Storage,
          cfg,
        });
        const revPartialRes = await executeLoanRepay({
          address: ADDRESSES.borrower,
          loanId: m1LoanId,
          principalRepayRaw: '50000000',
          expectedPreview: revPartialPrev,
          autoApprove: true,
          storage: m1Storage,
          provider: walletProvider,
          cfg,
        });
        assert.equal(revPartialRes.isPartial, true);

        const revBump = await bumpMakerNonceOnChain({
          address: ADDRESSES.borrower,
          storage: m1Storage,
          provider: walletProvider,
          cfg,
        });
        assert.ok(BigInt(revBump.newNonce) > 0n);
        const revReduceColl = await setCollateralAllowanceForBorrow({
          address: ADDRESSES.borrower,
          collateralToken: nvdac,
          targetAllowanceRaw: '0',
          provider: walletProvider,
          cfg,
        });
        assert.equal(revReduceColl.allowanceRaw, '0');
      } finally {
        await publicClient.waitForTransactionReceipt({
          hash: await ownerClient.writeContract({
            address: deployed.eligibilityGate,
            abi: parseAbi(['function revokeUser(address account, bool revoked)']),
            functionName: 'revokeUser',
            args: [ADDRESSES.borrower, false],
          }),
        });
      }

      // Mode C: API down (dead port) -> cannot screen/quote/verify/sign-for-order/extend, BUT CAN topUp, full repay, cancel, bumpNonce, reduce allowance!
      const deadApiCfg = { ...cfg, apiUrl: 'http://127.0.0.1:59999' };
      await assert.rejects(
        () => fetchEligibilityScreening({ account: ADDRESSES.borrower, cfg: deadApiCfg }),
        /fetch|ECONNREFUSED|failed/i
      );
      await assert.rejects(
        () =>
          verifyStoredDeclarationOnServer({
            declaration: borrowerDeclRecord,
            address: ADDRESSES.borrower,
            cfg: deadApiCfg,
          }),
        /fetch|ECONNREFUSED|failed/i
      );
      await assert.rejects(
        () =>
          fetchLoanQuote({
            cfg: deadApiCfg,
            asset: nvdac,
            principalRaw: '500000000',
            termDays: 14,
            aprBps: 800,
            maxLtvBps: 6000,
            borrower: ADDRESSES.borrower,
          }),
        /fetch|ECONNREFUSED|failed/i
      );

      // Lender cancel + bumpNonce + reduce USDC allowance with dead API
      walletProvider.setAccount(KEYS.lender);
      const deadApiCancelLend = await cancelSignedLendOffer({
        address: ADDRESSES.lender,
        offer: m1OpenLendOffer.offer,
        storage: m1Storage,
        provider: walletProvider,
        cfg: deadApiCfg,
      });
      assert.ok(deadApiCancelLend.txHash, 'Lender cancel must succeed during API outage');
      const deadApiBumpLend = await bumpMakerNonceOnChain({
        address: ADDRESSES.lender,
        storage: m1Storage,
        provider: walletProvider,
        cfg: deadApiCfg,
      });
      assert.ok(BigInt(deadApiBumpLend.newNonce) > 0n);
      const deadApiReduceUsdc = await setUsdcAllowanceForLend({
        address: ADDRESSES.lender,
        targetAllowanceRaw: '0',
        provider: walletProvider,
        cfg: deadApiCfg,
      });
      assert.equal(deadApiReduceUsdc.allowanceRaw, '0');

      // Borrower topUp + full repay with dead API
      walletProvider.setAccount(KEYS.borrower);
      const deadApiTopUpPrev = await verifyAndPreviewLoanTopUp({
        loanId: m1LoanId,
        additionalCollateralRaw: '100000000000000000',
        payerAddress: ADDRESSES.borrower,
        storage: m1Storage,
        cfg: deadApiCfg,
      });
      assert.ok(deadApiTopUpPrev.openOrdersWarning.includes('api/ open-orders query unavailable'));
      const deadApiTopUpRes = await executeLoanTopUp({
        address: ADDRESSES.borrower,
        loanId: m1LoanId,
        additionalCollateralRaw: '100000000000000000',
        expectedPreview: deadApiTopUpPrev,
        autoApprove: true,
        storage: m1Storage,
        provider: walletProvider,
        cfg: deadApiCfg,
      });
      assert.ok(deadApiTopUpRes.txHash, 'Borrower topUp must succeed during API outage');

      const deadApiRepayPrev = await verifyAndPreviewLoanRepay({
        loanId: m1LoanId,
        payerAddress: ADDRESSES.borrower,
        storage: m1Storage,
        cfg: deadApiCfg,
      });
      assert.ok(deadApiRepayPrev.openOrdersWarning.includes('api/ open-orders query unavailable'));
      const deadApiRepayRes = await executeLoanRepay({
        address: ADDRESSES.borrower,
        loanId: m1LoanId,
        expectedPreview: deadApiRepayPrev,
        autoApprove: true,
        storage: m1Storage,
        provider: walletProvider,
        cfg: deadApiCfg,
      });
      assert.ok(deadApiRepayRes.txHash, 'Borrower full repay must succeed during API outage');
      const m1SettledState = await readLoanOnChainState(m1LoanId, { cfg: deadApiCfg });
      assert.equal(m1SettledState.isSettled, true);

      console.log('PASS WS3.6 Piece 2b M1 Fix: Safety/exit paths open & new-risk actions blocked across US IP, revoked wallet & API outage.');

      // ---------------------------------------------------------------------
      // 3.15 Low 1 Repro & Fix: API-only $1,000 LendOffer + API down + Repay with trim -> allowance MUST stay intact!
      // ---------------------------------------------------------------------
      console.log('\n=== Low 1 Repro Fix: Skip post-repay USDC allowance trim when openOrdersWarning is set ===');

      // Top up borrower USDC & mint NVDAc for borrower & lender so exact offer creation + repay + subsequent fill succeed cleanly
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: BASE_USDC_WHALE,
          to: BASE_USDC,
          data: encodeFunctionData({
            abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']),
            functionName: 'transfer',
            args: [ADDRESSES.borrower, 3_000_000_000n],
          }),
        }),
      });
      for (const mintTo of [ADDRESSES.borrower, ADDRESSES.lender]) {
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdac,
            abi: mockB20Artifact.abi,
            functionName: 'mint',
            args: [mintTo, 20n * 10n ** 18n],
          }),
        });
      }
      await rpcCall('evm_mine', []);

      // 1) Open an active $500 loan for borrower (lender fills borrower's BorrowOrder)
      const low1SetupMap = new Map<string, string>();
      const low1SetupStorage = {
        getItem: (k: string) => low1SetupMap.get(k) ?? null,
        setItem: (k: string, v: string) => { low1SetupMap.set(k, String(v)); },
        removeItem: (k: string) => { low1SetupMap.delete(k); },
      };
      walletProvider.setAccount(KEYS.borrower);
      const low1LoanQuote = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '500000000',
        termDays: 14,
        aprBps: 800,
        maxLtvBps: 6000,
        borrower: ADDRESSES.borrower,
      });
      const low1BorrowOrder = await prepareAndSignBorrowOrder({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        principalRaw: '500000000',
        expectedQuote: low1LoanQuote,
        requireExpectedQuote: true,
        maxRateBps: 800,
        termDays: 14,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        existingOpenCollateralRaw: 0n,
        expiryDays: 7,
        autoApprove: true,
        publishToApi: false,
        storage: low1SetupStorage,
        provider: walletProvider,
        cfg,
      });
      walletProvider.setAccount(KEYS.lender);
      const low1Opened = await fillBorrowOrderAsLender({
        address: ADDRESSES.lender,
        order: low1BorrowOrder.order,
        signature: low1BorrowOrder.signature,
        fillUsdcRaw: '500000000',
        existingOpenSumRaw: 0n,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      const low1LoanId = low1Opened.loanId;
      assert.ok(low1LoanId, 'Low 1 test loan must open on-chain');

      // 2) Borrower signs & relays an API-ONLY $1,000 USDC LendOffer, using throwaway local storage (not present locally later!)
      const low1ApiOfferStore = new Map<string, string>();
      const low1ApiOfferStorage = {
        getItem: (k: string) => low1ApiOfferStore.get(k) ?? null,
        setItem: (k: string, v: string) => { low1ApiOfferStore.set(k, String(v)); },
        removeItem: (k: string) => { low1ApiOfferStore.delete(k); },
      };
      walletProvider.setAccount(KEYS.borrower);
      const low1LendQuote = await fetchLoanQuote({
        cfg,
        asset: nvdac,
        principalRaw: '1000000000',
        termDays: 14,
        aprBps: 800,
        maxLtvBps: 6000,
      });
      const low1ApiOnlyOffer = await prepareAndSignLendOffer({
        address: ADDRESSES.borrower,
        principalRaw: '1000000000',
        allowedCollateral: nvdac,
        expectedQuote: low1LendQuote,
        requireExpectedQuote: true,
        minRateBps: 800,
        termDays: 14,
        maxLtvBps: 6000,
        minFillRaw: '500000000',
        expiryDays: 7,
        existingOpenSumRaw: 0n,
        autoApprove: true,
        publishToApi: true,
        storage: low1ApiOfferStorage,
        provider: walletProvider,
        cfg,
      });
      assert.equal(low1ApiOnlyOffer.publishedToApi, true, 'API-only $1,000 LendOffer must be published to api/');

      // Reset borrower local storage completely so the $1,000 LendOffer exists ONLY on api/ (repro setup)
      const low1EmptyMap = new Map<string, string>();
      const low1EmptyStorage = {
        getItem: (k: string) => low1EmptyMap.get(k) ?? null,
        setItem: (k: string, v: string) => { low1EmptyMap.set(k, String(v)); },
        removeItem: (k: string) => { low1EmptyMap.delete(k); },
      };

      // Preview while API is healthy just to inspect combined approval target, then ensure exact combined allowance (1,000 + repayMax)
      const low1OnlinePrev = await verifyAndPreviewLoanRepay({
        loanId: low1LoanId,
        payerAddress: ADDRESSES.borrower,
        storage: low1EmptyStorage,
        cfg,
      });
      assert.ok(
        BigInt(low1OnlinePrev.existingOpenSumRaw) >= 1_000_000_000n,
        'Online preview must discover API-only $1,000 LendOffer'
      );
      await approveUsdcForLend({
        address: ADDRESSES.borrower,
        requiredUsdcRaw: low1OnlinePrev.requiredApprovalRaw,
        provider: walletProvider,
        cfg,
      });

      // 3) Simulate API outage (deadApiCfg) and repay WITH trimBufferAllowance: true
      const low1DeadApiTopUpPrev = await verifyAndPreviewLoanTopUp({
        loanId: low1LoanId,
        additionalCollateralRaw: '100000000000000000',
        payerAddress: ADDRESSES.borrower,
        storage: low1EmptyStorage,
        cfg: deadApiCfg,
      });
      assert.ok(low1DeadApiTopUpPrev.openOrdersWarning.includes('api/ open-orders query unavailable'));

      const low1DeadApiRepayPrev = await verifyAndPreviewLoanRepay({
        loanId: low1LoanId,
        payerAddress: ADDRESSES.borrower,
        storage: low1EmptyStorage,
        cfg: deadApiCfg,
      });
      assert.ok(low1DeadApiRepayPrev.openOrdersWarning.includes('api/ open-orders query unavailable'));
      assert.equal(
        low1DeadApiRepayPrev.existingOpenSumRaw,
        '0',
        'Local empty storage yields 0 local open LendOffers while API is unreachable'
      );

      const low1RepayRes = await executeLoanRepay({
        address: ADDRESSES.borrower,
        loanId: low1LoanId,
        expectedPreview: low1DeadApiRepayPrev,
        autoApprove: true,
        trimBufferAllowance: true,
        storage: low1EmptyStorage,
        provider: walletProvider,
        cfg: deadApiCfg,
      });
      assert.ok(low1RepayRes.txHash, 'Repay during API outage must still settle on-chain');
      assert.equal(
        low1RepayRes.allowanceTrimTxHash,
        null,
        'Post-repay LoanCore allowance trim MUST be skipped when openOrdersWarning is set'
      );
      assert.match(
        low1RepayRes.allowanceTrimSkippedReason || '',
        /api\/ open-orders query unavailable/i
      );

      const postOutageAllow = BigInt(
        (await readLendAllowanceAndNonce(ADDRESSES.borrower, { cfg: deadApiCfg })).allowanceRaw
      );
      assert.ok(
        postOutageAllow >= 1_000_000_000n,
        `API-only $1,000 LendOffer allowance MUST NOT be cut to 0 during outage (got ${postOutageAllow})`
      );

      // 4) API recovers: counterparty (lender acting as borrower) fills borrower's API-only $1,000 LendOffer and it succeeds!
      walletProvider.setAccount(KEYS.lender);
      const low1OfferFillPrev = await verifyAndPreviewLendOfferFill({
        offer: low1ApiOnlyOffer.offer,
        signature: low1ApiOnlyOffer.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '1000000000',
        borrowerAddress: ADDRESSES.lender,
        storage: low1EmptyStorage,
        cfg,
      });
      const low1OfferFillRes = await fillLendOfferAsBorrower({
        address: ADDRESSES.lender,
        offer: low1ApiOnlyOffer.offer,
        signature: low1ApiOnlyOffer.signature,
        collateralToken: nvdac,
        fillUsdcRaw: '1000000000',
        expectedPreview: low1OfferFillPrev,
        autoApprove: true,
        storage: low1EmptyStorage,
        provider: walletProvider,
        cfg,
      });
      assert.ok(low1OfferFillRes.loanId, 'API-only $1,000 LendOffer must still be fillable after outage repay');

      // Source & policy sanity: Loan.jsx shows openOrdersWarning on both previews + skipped reason; web3.js never uses MaxUint256
      const low1LoanSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'pages', 'Loan.jsx'), 'utf8');
      assert.ok(low1LoanSrc.includes('repayPreview.openOrdersWarning'));
      assert.ok(low1LoanSrc.includes('topUpPreview.openOrdersWarning'));
      assert.ok(low1LoanSrc.includes('repayResult.allowanceTrimSkippedReason'));
      const web3CodeOnly = fs
        .readFileSync(path.join(REPO_ROOT, 'src', 'lib', 'web3.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      assert.ok(
        !/maxUint256|0xf{64}|2n\s*\*\*\s*256n\s*-\s*1n/i.test(web3CodeOnly),
        'web3.js code must never approve MaxUint256 / unlimited allowance'
      );

      console.log('PASS Low 1 Fix: Post-repay trim skipped during API outage; API-only $1,000 LendOffer allowance preserved & fillable.');

      // ---------------------------------------------------------------------
      // 3.16 WS3.7 Piece 1: Direct Base RPC Readings for Risk.jsx & Data.jsx
      // ---------------------------------------------------------------------
      console.log('\n=== WS3.7 Piece 1: Live Base AssetRegistry, OracleRouter, LoanCore & FeeCollector reads on Risk & Data ===');

      const ws37LiveBefore = await fetchLiveProtocolContractState({ cfg });
      assert.equal(ws37LiveBefore.ok, true, `Direct Base RPC snapshot failed: ${ws37LiveBefore.error}`);
      assert.ok(BigInt(ws37LiveBefore.blockNumber) > 0n);
      assert.equal(ws37LiveBefore.protocol.paused, false);
      assert.equal(ws37LiveBefore.protocol.marketOpen, true);
      assert.equal(ws37LiveBefore.protocol.sequencerValid, true);
      assert.ok(BigInt(ws37LiveBefore.protocol.originatedLoansCount) >= 1n);
      assert.ok(ws37LiveBefore.fees && Number.isInteger(ws37LiveBefore.fees.origination_fee_bps));

      const nvdaLiveOpen = ws37LiveBefore.assets.find((a) => a.token.toLowerCase() === nvdac.toLowerCase());
      assert.ok(nvdaLiveOpen, 'AssetRegistry log discovery must detect NVDAc without hardcoding');
      assert.equal(nvdaLiveOpen.status, 0);
      assert.equal(nvdaLiveOpen.status_name, 'Active');
      assert.equal(nvdaLiveOpen.oracle.state, 0);
      assert.equal(nvdaLiveOpen.oracle.state_name, 'VALID_OPEN');
      assert.equal(nvdaLiveOpen.ltv.max_init_ltv_bps, 6000);
      assert.equal(nvdaLiveOpen.ltv.liq_ltv_bps, 7800);
      assert.equal(nvdaLiveOpen.ltv.closed_market_haircut_bps, 500);
      assert.ok(BigInt(nvdaLiveOpen.oracle.price.raw) > 0n);
      assert.equal(
        nvdaLiveOpen.oracle.gross_unit_value_usdc.raw,
        nvdaLiveOpen.oracle.effective_unit_value_usdc.raw,
        'Open session must have zero closed-market haircut on OracleRouter.getValue'
      );

      // Mutate real on-chain protocol state via timelock: Closed market + Paused LoanCore + Frozen AssetStatus
      try {
        await publicClient.waitForTransactionReceipt({
          hash: await rawWalletClient.sendTransaction({
            account: deployed.nostokTimelock,
            to: deployed.oracleRouter,
            data: encodeFunctionData({
              abi: parseAbi(['function setMarketSession(bool isOpen, bool isManual)']),
              functionName: 'setMarketSession',
              args: [false, true],
            }),
          }),
        });
        const ws37LiveClosed = await fetchLiveProtocolContractState({ cfg });
        assert.equal(ws37LiveClosed.ok, true);
        assert.equal(ws37LiveClosed.protocol.marketOpen, false);
        const nvdaClosed = ws37LiveClosed.assets.find((a) => a.token.toLowerCase() === nvdac.toLowerCase())!;
        assert.equal(nvdaClosed.oracle.state, 1, 'OracleRouter must report VALID_CLOSED when market session closed');
        assert.equal(nvdaClosed.oracle.state_name, 'VALID_CLOSED');
        assert.ok(
          BigInt(nvdaClosed.oracle.effective_unit_value_usdc.raw) < BigInt(nvdaClosed.oracle.gross_unit_value_usdc.raw),
          'OracleRouter.getValue must apply 500 bps closed-market haircut live on-chain'
        );

        await publicClient.waitForTransactionReceipt({
          hash: await rawWalletClient.sendTransaction({
            account: deployed.nostokTimelock,
            to: deployed.loanCore,
            data: encodeFunctionData({
              abi: parseAbi(['function setPaused(bool isPaused)']),
              functionName: 'setPaused',
              args: [true],
            }),
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await rawWalletClient.sendTransaction({
            account: deployed.nostokTimelock,
            to: deployed.assetRegistry,
            data: encodeFunctionData({
              abi: parseAbi(['function setAssetStatus(address token, uint8 newStatus)']),
              functionName: 'setAssetStatus',
              args: [nvdac, 3],
            }),
          }),
        });

        const ws37LiveFrozenPaused = await fetchLiveProtocolContractState({ cfg });
        assert.equal(ws37LiveFrozenPaused.protocol.paused, true);
        const nvdaFrozen = ws37LiveFrozenPaused.assets.find((a) => a.token.toLowerCase() === nvdac.toLowerCase())!;
        assert.equal(nvdaFrozen.status, 3);
        assert.equal(nvdaFrozen.status_name, 'Frozen');
        assert.equal(nvdaFrozen.oracle.state, 2);
        assert.equal(nvdaFrozen.oracle.state_name, 'FROZEN_CORPORATE_ACTION');

        const envRowsFrozen = buildOnChainEnvironmentRows(ws37LiveFrozenPaused);
        assert.ok(envRowsFrozen.some((r) => r.label === 'LoanCore.paused()' && r.value.startsWith('PAUSED')));

        const reconciledDrift = reconcileLiveAssetsWithApi(
          [{ token: nvdac, symbol: 'NVDAc', status: 0, status_name: 'Active', oracle: { state: 0, state_name: 'VALID_OPEN' } }],
          ws37LiveFrozenPaused
        );
        assert.ok(reconciledDrift.discrepancies.length >= 2, 'Live RPC vs stale API mismatch must be flagged');
      } finally {
        await publicClient.waitForTransactionReceipt({
          hash: await rawWalletClient.sendTransaction({
            account: deployed.nostokTimelock,
            to: deployed.assetRegistry,
            data: encodeFunctionData({
              abi: parseAbi(['function setAssetStatus(address token, uint8 newStatus)']),
              functionName: 'setAssetStatus',
              args: [nvdac, 0],
            }),
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await rawWalletClient.sendTransaction({
            account: deployed.nostokTimelock,
            to: deployed.loanCore,
            data: encodeFunctionData({
              abi: parseAbi(['function setPaused(bool isPaused)']),
              functionName: 'setPaused',
              args: [false],
            }),
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await rawWalletClient.sendTransaction({
            account: deployed.nostokTimelock,
            to: deployed.oracleRouter,
            data: encodeFunctionData({
              abi: parseAbi(['function setMarketSession(bool isOpen, bool isManual)']),
              functionName: 'setMarketSession',
              args: [true, true],
            }),
          }),
        });
      }

      // API unreachable fallback: fetchMarketsAndLiveContracts & buildDataMetricRows MUST still read live AssetRegistry/OracleRouter/LoanCore/FeeCollector!
      const ws37OutageCombined = await fetchMarketsAndLiveContracts({
        cfg: deadApiCfg,
        includeLoans: true,
        includeAuctions: true,
      });
      assert.equal(ws37OutageCombined.market.degraded, true);
      assert.equal(ws37OutageCombined.onChain.ok, true);
      assert.ok(ws37OutageCombined.assets.length >= 1, 'Risk & Book must still list on-chain assets during API outage');
      assert.ok(ws37OutageCombined.onChain.fees && ws37OutageCombined.onChain.fees.max_origination_bps > 0);
      const outageDataRows = buildDataMetricRows(
        ws37OutageCombined.market.bookSummary,
        ws37OutageCombined.market,
        ws37OutageCombined.market.health,
        ws37OutageCombined.onChain
      );
      const outageDataMap = Object.fromEntries(outageDataRows.map((r) => [r.label, r.value]));
      assert.notEqual(outageDataMap['Outstanding principal'], 'Unavailable');
      assert.notEqual(outageDataMap['Global USDC cap / remaining'], 'Unavailable');
      assert.equal(outageDataMap['Protocol status (LoanCore.paused)'], 'Active');
      assert.match(outageDataMap['Collateral escrowed (CollateralEscrow)'], /NVDAc/);

      // Render Risk & Data components safely
      const riskPageHtml = renderToStaticMarkup(
        createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: ['/risk'] }, createElement(Shell, null, createElement(Risk))))
      );
      assert.ok(riskPageHtml.includes('Live asset state (AssetRegistry &amp; OracleRouter)'));
      assert.ok(riskPageHtml.includes('Protocol fees &amp; caps (FeeCollector)'));

      const dataPageHtml = renderToStaticMarkup(
        createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: ['/data'] }, createElement(Shell, null, createElement(Data))))
      );
      assert.ok(dataPageHtml.includes('Live protocol book metrics.'));

      console.log('PASS WS3.7 Piece 1: Direct Base RPC AssetRegistry/OracleRouter/LoanCore/FeeCollector readings & Risk/Data rendering verified.');

      // ---------------------------------------------------------------------
      // 3.17 WS3.7 Piece 2 + Low 1 + Infos (1)-(5): Markets.jsx & hardened on-chain readers
      // ---------------------------------------------------------------------
      console.log('\n=== WS3.7 Piece 2: Markets.jsx live contracts + Low 1 (unsupported/failing asset isolation) & Infos (1)-(5) ===');

      // Info (4) & (5): Verify sequencerGracePeriod read dynamically from OracleRouter and updated paused label
      assert.equal(typeof ws37LiveBefore.protocol.sequencerGracePeriodSecs, 'number');
      assert.ok(ws37LiveBefore.protocol.sequencerGracePeriodSecs > 0);
      const envRowsGrace = buildOnChainEnvironmentRows(ws37LiveBefore);
      assert.ok(
        envRowsGrace.some(
          (r) =>
            r.label === 'OracleRouter.isSequencerValid()' &&
            r.value.includes(`${ws37LiveBefore.protocol.sequencerGracePeriodSecs}s`)
        ),
        'sequencerGracePeriod must be read from chain rather than hardcoded'
      );

      // Low 1 (part A): API / list includes an unregistered ERC20 -> isAssetSupported checked FIRST -> skipped without breaking snapshot (`ok:true`) and marked `not verified on-chain`!
      const unregReceipt = await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.deployContract({
          abi: mockB20Artifact.abi,
          bytecode: mockB20Artifact.bytecode,
          args: ['Unregistered Equity', 'UNREG', 18, 1_000_000_000_000_000_000n],
        }),
      });
      const unregToken = getAddress(unregReceipt.contractAddress!);
      const low1OnChainWithUnreg = await fetchLiveProtocolContractState({
        cfg,
        tokenAddresses: [nvdac, unregToken],
      });
      assert.equal(
        low1OnChainWithUnreg.ok,
        true,
        'Unregistered token in candidate list MUST NOT cause overall snapshot ok=false'
      );
      assert.ok(
        low1OnChainWithUnreg.assets.some((a) => a.token.toLowerCase() === nvdac.toLowerCase() && a.onchain_verified),
        'NVDAc must still load live on-chain alongside unsupported token'
      );
      assert.ok(
        low1OnChainWithUnreg.unsupportedTokens.some((t) => t.toLowerCase() === unregToken.toLowerCase()),
        'Unsupported token must be skipped after isAssetSupported(token)=false check'
      );
      const low1RecWithUnreg = reconcileLiveAssetsWithApi(
        [
          { token: nvdac, symbol: 'NVDAc', status: 0, status_name: 'Active', oracle: { state: 0, state_name: 'VALID_OPEN' } },
          {
            token: unregToken,
            symbol: 'UNREG',
            status: 0,
            status_name: 'Active',
            oracle: {
              price: { raw: '5000000000', formatted: '50', decimals: 8, symbol: 'USD' },
              state: 0,
              state_name: 'VALID_OPEN',
            },
          },
        ],
        low1OnChainWithUnreg
      );
      const unregMerged = low1RecWithUnreg.assets.find((a) => a.token.toLowerCase() === unregToken.toLowerCase())!;
      assert.equal(unregMerged.source, 'api_only');
      assert.equal(unregMerged.status_name, 'not verified on-chain');
      assert.equal(unregMerged.oracle.state_name, 'not verified on-chain');
      assert.equal(unregMerged.oracle.price, null);
      assert.equal(formatAssetOraclePrice(unregMerged.oracle), 'not verified on-chain');
      assert.equal(evaluateAssetOriginationStatus(unregMerged, low1OnChainWithUnreg.protocol).canOriginate, false);

      // Low 1 (part B) & Info (2): Failed individual asset read (and sub-read failures) mark that asset/field as "unavailable", NEVER valid, 0, or STALE_FEED!
      const brokenSupportedFake = '0x8888888888888888888888888888888888888888';
      const spyClientPartialAndAssetFail = {
        ...publicClient,
        getBlock: (args: any) => publicClient.getBlock(args),
        getLogs: (args: any) => publicClient.getLogs(args),
        readContract: async (args: any) => {
          if (args.functionName === 'isAssetSupported' && getAddress(args.args[0]) === brokenSupportedFake) {
            return true;
          }
          if (args.functionName === 'getAssetConfig' && getAddress(args.args[0]) === brokenSupportedFake) {
            throw new Error('Simulated getAssetConfig revert on single bad asset');
          }
          if (
            (args.functionName === 'getPrice' ||
              args.functionName === 'recordedMultiplier' ||
              args.functionName === 'getBalance') &&
            getAddress(args.args[0]) === nvdac
          ) {
            throw new Error(`Simulated sub-read RPC failure for ${args.functionName}`);
          }
          return publicClient.readContract(args);
        },
      };
      const partialFailSnap = await fetchLiveProtocolContractState({
        cfg,
        publicClient: spyClientPartialAndAssetFail,
        tokenAddresses: [nvdac, brokenSupportedFake],
        includeLogDiscovery: false,
      });
      assert.equal(partialFailSnap.ok, true, 'Single failing asset MUST NOT mark entire snapshot ok=false');
      const brokenOut = partialFailSnap.assets.find(
        (a) => a.token.toLowerCase() === brokenSupportedFake.toLowerCase()
      )!;
      assert.equal(brokenOut.unavailable, true);
      assert.equal(brokenOut.status_name, 'unavailable');
      assert.equal(brokenOut.oracle.state_name, 'unavailable');
      assert.equal(formatAssetOraclePrice(brokenOut.oracle), 'unavailable');

      const partialNvda = partialFailSnap.assets.find((a) => a.token.toLowerCase() === nvdac.toLowerCase())!;
      assert.equal(partialNvda.unavailable, false);
      assert.equal(partialNvda.oracle.state, null, 'Failed getPrice must yield null state, NOT STALE_FEED (3)');
      assert.equal(partialNvda.oracle.state_name, 'unavailable');
      assert.equal(partialNvda.oracle.price, null);
      assert.equal(formatAssetOraclePrice(partialNvda.oracle), 'unavailable');
      assert.equal(partialNvda.multiplier.recorded, null, 'Failed recordedMultiplier must yield null (unavailable), NOT 0');
      assert.equal(partialNvda.escrow_balance, null, 'Failed escrow getBalance must yield null (unavailable), NOT 0');

      // Info (1): Configurable deployBlock (`fromBlock`) chunked AssetConfigSet discovery across small chunks!
      let getLogsCallCount = 0;
      const chunkSpyClient = {
        ...publicClient,
        getBlock: (args: any) => publicClient.getBlock(args),
        readContract: (args: any) => publicClient.readContract(args),
        getLogs: async (args: any) => {
          getLogsCallCount += 1;
          return publicClient.getLogs(args);
        },
      };
      const deployBlockSnap = await fetchLiveProtocolContractState({
        cfg: { ...cfg, deployBlock: startBlock.toString() },
        publicClient: chunkSpyClient,
        logChunkSize: 15n,
      });
      assert.equal(deployBlockSnap.ok, true);
      assert.ok(getLogsCallCount > 1, `Expected multi-chunk getLogs scan from deployBlock=${startBlock} (got ${getLogsCallCount})`);
      assert.ok(deployBlockSnap.assets.some((a) => a.token.toLowerCase() === nvdac.toLowerCase()));

      // Info (3): Stale feed price MUST be marked `(stale)` when OracleState is STALE_FEED!
      try {
        const latestBlk = await publicClient.getBlock({ blockTag: 'latest' });
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setUpdatedAt',
            args: [BigInt(latestBlk.timestamp) - 30_000n],
          }),
        });
        const staleCombined = await fetchMarketsAndLiveContracts({
          cfg,
          includeLoans: false,
          includeAuctions: false,
        });
        assert.equal(staleCombined.onChain.ok, true);
        const nvdaStale = staleCombined.assets.find((a) => a.token.toLowerCase() === nvdac.toLowerCase())!;
        assert.equal(nvdaStale.oracle.state, 3);
        assert.equal(nvdaStale.oracle.state_name, 'STALE_FEED');
        const stalePriceDisplay = formatAssetOraclePrice(nvdaStale.oracle);
        assert.match(stalePriceDisplay, /^\$140\.00 \(stale\)$/);
        const staleReady = evaluateAssetOriginationStatus(nvdaStale, staleCombined.onChain.protocol);
        assert.equal(staleReady.canOriginate, false);
        assert.match(staleReady.message, /STALE_FEED.*stale/);
      } finally {
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [140_00000000n],
          }),
        });
      }

      // WS3.7 Piece 2: Markets.jsx renders cleanly with live contract headers & source check
      const marketsPageHtml = renderToStaticMarkup(
        createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: ['/markets'] }, createElement(Shell, null, createElement(Markets))))
      );
      assert.ok(marketsPageHtml.includes('Registered collateral assets (AssetRegistry &amp; OracleRouter)'));
      assert.ok(marketsPageHtml.includes('Live on-chain loan quote calculator'));
      const marketsPageSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'pages', 'Markets.jsx'), 'utf8');
      assert.ok(marketsPageSrc.includes('fetchMarketsAndLiveContracts'));
      assert.ok(marketsPageSrc.includes('formatAssetOraclePrice'));
      assert.ok(marketsPageSrc.includes('evaluateAssetOriginationStatus'));

      console.log('PASS WS3.7 Piece 2 + Low 1 + Infos (1)-(5): Markets.jsx live AssetRegistry/OracleRouter integration & hardened snapshot semantics verified.');

      // ---------------------------------------------------------------------
      // 3.18 b68087c Review Low 1 & Infos (1)-(5) + Positions.jsx Live Claim & Enumeration
      // ---------------------------------------------------------------------
      console.log('\n=== b68087c Fixes (Low 1 + Infos 1-5) & Positions.jsx (Live PositionNFT + LoanCore.claim) ===');

      // Low 1: LoanCore.paused() failure yields paused=null and evaluateAssetOriginationStatus blocks as unknown
      const pausedFailClient = {
        ...publicClient,
        getBlock: (args: any) => publicClient.getBlock(args),
        getLogs: (args: any) => publicClient.getLogs(args),
        readContract: async (args: any) => {
          if (args.functionName === 'paused') throw new Error('Simulated paused() RPC failure');
          return publicClient.readContract(args);
        },
      };
      const pausedFailSnap = await fetchLiveProtocolContractState({
        cfg,
        publicClient: pausedFailClient,
        includeLogDiscovery: false,
      });
      assert.equal(pausedFailSnap.ok, true);
      assert.equal(pausedFailSnap.protocol.paused, null);
      const pausedUnknownNvda = pausedFailSnap.assets.find((a) => a.token.toLowerCase() === nvdac.toLowerCase())!;
      const pausedUnknownStatus = evaluateAssetOriginationStatus(pausedUnknownNvda, pausedFailSnap.protocol);
      assert.equal(pausedUnknownStatus.canOriginate, false);
      assert.match(pausedUnknownStatus.message, /pause status unknown/i);

      // Info 2: deployBlock above head + getLogs error both fall back and populate discoveryWarning
      const latestForkBlk = await publicClient.getBlockNumber();
      const aboveHeadSnap = await fetchLiveProtocolContractState({
        cfg: { ...cfg, deployBlock: (latestForkBlk + 500n).toString() },
      });
      assert.equal(aboveHeadSnap.ok, true);
      assert.match(aboveHeadSnap.discoveryWarning, /exceeds chain head/i);
      assert.ok(aboveHeadSnap.assets.some((a) => a.token.toLowerCase() === nvdac.toLowerCase()));

      const getLogsErrorClient = {
        ...publicClient,
        getBlock: (args: any) => publicClient.getBlock(args),
        readContract: (args: any) => publicClient.readContract(args),
        getLogs: async () => {
          throw new Error('Simulated getLogs limit failure');
        },
      };
      const logErrSnap = await fetchLiveProtocolContractState({
        cfg: { ...cfg, deployBlock: startBlock.toString() },
        publicClient: getLogsErrorClient,
      });
      assert.equal(logErrSnap.ok, true);
      assert.match(logErrSnap.discoveryWarning, /log scan failed/i);
      assert.ok(logErrSnap.assets.some((a) => a.token.toLowerCase() === nvdac.toLowerCase()));

      // Info 4: Failed ERC20.decimals() read yields null (unavailable) instead of silent 18
      const decimalsFailClient = {
        ...publicClient,
        getBlock: (args: any) => publicClient.getBlock(args),
        getLogs: (args: any) => publicClient.getLogs(args),
        readContract: async (args: any) => {
          if (args.functionName === 'decimals' && getAddress(args.address) === nvdac) {
            throw new Error('Simulated decimals() revert');
          }
          return publicClient.readContract(args);
        },
      };
      const decimalsFailSnap = await fetchLiveProtocolContractState({
        cfg,
        publicClient: decimalsFailClient,
        includeLogDiscovery: false,
      });
      const decimalsFailNvda = decimalsFailSnap.assets.find((a) => a.token.toLowerCase() === nvdac.toLowerCase())!;
      assert.equal(decimalsFailNvda.decimals, null);
      assert.equal(decimalsFailNvda.escrow_balance, null);
      assert.equal(decimalsFailNvda.oracle.gross_unit_value_usdc, null);
      assert.equal(evaluateAssetOriginationStatus(decimalsFailNvda, decimalsFailSnap.protocol).canOriginate, false);

      // Info 5: Frozen asset on-chain price & unit value display 'n/a' instead of '$0.00'
      try {
        await publicClient.waitForTransactionReceipt({
          hash: await rawWalletClient.sendTransaction({
            account: deployed.nostokTimelock,
            to: deployed.assetRegistry,
            data: encodeFunctionData({
              abi: parseAbi(['function setAssetStatus(address token, uint8 newStatus)']),
              functionName: 'setAssetStatus',
              args: [nvdac, 3],
            }),
          }),
        });
        const frozenSnap = await fetchLiveProtocolContractState({ cfg, includeLogDiscovery: false });
        const frozenNvda = frozenSnap.assets.find((a) => a.token.toLowerCase() === nvdac.toLowerCase())!;
        assert.equal(frozenNvda.oracle.state_name, 'FROZEN_CORPORATE_ACTION');
        assert.equal(formatAssetOraclePrice(frozenNvda.oracle), 'n/a');
        assert.equal(formatOracleUnitValue(frozenNvda.oracle.effective_unit_value_usdc, frozenNvda.oracle), 'n/a');
      } finally {
        await publicClient.waitForTransactionReceipt({
          hash: await rawWalletClient.sendTransaction({
            account: deployed.nostokTimelock,
            to: deployed.assetRegistry,
            data: encodeFunctionData({
              abi: parseAbi(['function setAssetStatus(address token, uint8 newStatus)']),
              functionName: 'setAssetStatus',
              args: [nvdac, 0],
            }),
          }),
        });
      }

      // Info 1: Markets.jsx ties BOTH card Quote button & Simulate live quote button to evaluateAssetOriginationStatus
      assert.ok(marketsPageSrc.includes('disabled={!itemOrigination.canOriginate}'));
      assert.ok(marketsPageSrc.includes('disabled={quoteLoading || !selectedOriginationStatus.canOriginate}'));

      // Live Positions.jsx enumeration (both api/ healthy and api/ down) + ungated LoanCore.claim(to)
      const borrowerPositionsSnap = await fetchWalletPositionsAndClaimable({
        address: ADDRESSES.borrower,
        cfg,
      });
      assert.equal(borrowerPositionsSnap.rpcError, '');
      assert.ok(borrowerPositionsSnap.nftBalanceCount! >= 1, 'Borrower holds fresh PositionNFT from low1OfferFillRes');
      assert.ok(
        borrowerPositionsSnap.positions.some((p) => p.loanId === String(low1OfferFillRes.loanId) && p.onchainVerified),
        'Live Positions must enumerate newly minted PositionNFT verified on-chain'
      );

      // Direct Base RPC enumeration fallback while api/ is unreachable
      const borrowerOutagePositions = await fetchWalletPositionsAndClaimable({
        address: ADDRESSES.borrower,
        cfg: deadApiCfg,
      });
      assert.ok(borrowerOutagePositions.apiError.length > 0);
      assert.ok(
        borrowerOutagePositions.positions.some((p) => p.loanId === String(low1OfferFillRes.loanId)),
        'Positions must still enumerate held PositionNFTs on Base RPC during api/ outage'
      );

      // Lender claims accumulated repaid principal + interest via LoanCore.claim() WHILE revoked & API down
      const lenderPreClaim = await fetchWalletPositionsAndClaimable({
        address: ADDRESSES.lender,
        cfg: deadApiCfg,
      });
      assert.ok(BigInt(lenderPreClaim.claimableRaw ?? '0') > 0n, 'Lender must have accumulated claimable USDC on LoanCore');
      const expectedClaimRaw = BigInt(lenderPreClaim.claimableRaw!);
      const recipientUsdcBefore = BigInt(
        await publicClient.readContract({
          address: BASE_USDC,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [ADDRESSES.outsider],
        })
      );

      await publicClient.waitForTransactionReceipt({
        hash: await ownerClient.writeContract({
          address: deployed.eligibilityGate,
          abi: parseAbi(['function revokeUser(address account, bool revoked)']),
          functionName: 'revokeUser',
          args: [ADDRESSES.lender, true],
        }),
      });
      try {
        walletProvider.setAccount(KEYS.lender);
        // Info 4: alternate payout recipient requires explicit confirmation
        await assert.rejects(
          () =>
            executeLoanClaim({
              address: ADDRESSES.lender,
              recipient: ADDRESSES.outsider,
              provider: walletProvider,
              cfg: deadApiCfg,
            }),
          /Explicit confirmation required/i
        );
        const claimRes = await executeLoanClaim({
          address: ADDRESSES.lender,
          recipient: ADDRESSES.outsider,
          allowAlternateRecipient: true,
          provider: walletProvider,
          cfg: deadApiCfg,
        });
        assert.ok(claimRes.txHash);
        assert.equal(claimRes.claimant, getAddress(ADDRESSES.lender), 'Claimed event topic 1 is msg.sender claimant');
        assert.equal(claimRes.recipient, getAddress(ADDRESSES.outsider), 'Payout recipient tracks validated claim(to) address');
        assert.equal(claimRes.claimedAmountRaw, expectedClaimRaw.toString());
        assert.equal(claimRes.remainingClaimableRaw, '0');
        assert.equal(
          BigInt(claimRes.recipientUsdcBalanceRaw),
          recipientUsdcBefore + expectedClaimRaw,
          'Claimed USDC must transfer directly from LoanCore to recipient even when revoked & API dead'
        );
      } finally {
        await publicClient.waitForTransactionReceipt({
          hash: await ownerClient.writeContract({
            address: deployed.eligibilityGate,
            abi: parseAbi(['function revokeUser(address account, bool revoked)']),
            functionName: 'revokeUser',
            args: [ADDRESSES.lender, false],
          }),
        });
      }

      // Low 1 + Infos 1-3: Position enumeration edge cases (stale API rows, ownerOf failure, isAuctionLocked failure, RPC-down foreign owner)
      const heldLoanId = String(low1OfferFillRes.loanId);
      const mockPosSrv = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            pagination: { total: 3, limit: 100, offset: 0, has_more: false },
            data: [
              // Stale row pretending borrower owns loan #1 (actually lender/burned/other owner) so activeApiCount >= 1
              {
                loan_id: '1',
                owner: ADDRESSES.borrower,
                auction_locked: false,
                is_burned: false,
                collateral_token: nvdac,
                collateral_symbol: 'NVDAc',
                principal: { raw: '500000000' },
                loan_status: 0,
                loan_status_name: 'ACTIVE',
              },
              // Foreign owner row returned alongside
              {
                loan_id: heldLoanId,
                owner: ADDRESSES.outsider,
                auction_locked: true,
                is_burned: false,
                collateral_token: nvdac,
                collateral_symbol: 'NVDAc',
                principal: { raw: '500000000' },
                loan_status: 0,
                loan_status_name: 'ACTIVE',
              },
            ],
          })
        );
      });
      await new Promise<void>((r) => mockPosSrv.listen(0, '127.0.0.1', () => r()));
      const mockPosPort = (mockPosSrv.address() as net.AddressInfo).port;
      const mockPosCfg = { ...cfg, apiUrl: `http://127.0.0.1:${mockPosPort}` };
      try {
        // Low 1: stale API row (loan #1 is not owned on-chain by borrower) -> verifiedOwnedCount < balanceOf -> fallback scan STILL runs & finds heldLoanId
        const staleScanSnap = await fetchWalletPositionsAndClaimable({
          address: ADDRESSES.borrower,
          cfg: mockPosCfg,
        });
        assert.equal(staleScanSnap.apiError, '');
        assert.ok(staleScanSnap.verifiedOwnedCount! >= 1);
        assert.ok(
          staleScanSnap.positions.some((p) => p.loanId === heldLoanId && p.onchainVerified),
          'Low 1: stale API row must not skip fallback scan when verifiedOwnedCount < nftBalanceCount'
        );

        // Info 3: RPC-down mode filters out foreign-owned API rows
        const deadRpcClient = {
          ...publicClient,
          getBlock: async () => {
            throw new Error('simulated Base RPC outage');
          },
          readContract: async () => {
            throw new Error('simulated Base RPC outage');
          },
        } as unknown as typeof publicClient;
        const rpcDownSnap = await fetchWalletPositionsAndClaimable({
          address: ADDRESSES.borrower,
          cfg: mockPosCfg,
          publicClient: deadRpcClient,
        });
        assert.ok(rpcDownSnap.rpcError.length > 0);
        assert.ok(
          rpcDownSnap.positions.every((p) => p.owner.toLowerCase() === ADDRESSES.borrower.toLowerCase()),
          'Info 3: RPC-down mode must filter out API rows owned by another address'
        );

        // Infos 1 & 2: ownerOf read failure retains API position as ownerUnknown, isAuctionLocked read failure returns null
        const matchingApiSrv = http.createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              pagination: { total: 1, limit: 100, offset: 0, has_more: false },
              data: [
                {
                  loan_id: heldLoanId,
                  owner: ADDRESSES.borrower,
                  auction_locked: false,
                  is_burned: false,
                  collateral_token: nvdac,
                  collateral_symbol: 'NVDAc',
                  principal: { raw: '500000000' },
                  loan_status: 0,
                  loan_status_name: 'ACTIVE',
                },
              ],
            })
          );
        });
        await new Promise<void>((r) => matchingApiSrv.listen(0, '127.0.0.1', () => r()));
        try {
          const matchingApiCfg = {
            ...cfg,
            apiUrl: `http://127.0.0.1:${(matchingApiSrv.address() as net.AddressInfo).port}`,
          };
          const partialFailRpcClient = {
            ...publicClient,
            readContract: async (args: Parameters<typeof publicClient.readContract>[0]) => {
              if (args.functionName === 'ownerOf' && String(args.args?.[0]) === heldLoanId) {
                throw new Error('transient ownerOf timeout');
              }
              if (args.functionName === 'isAuctionLocked' && String(args.args?.[0]) === heldLoanId) {
                throw new Error('transient isAuctionLocked timeout');
              }
              return publicClient.readContract(args);
            },
          } as unknown as typeof publicClient;
          const partialFailSnap = await fetchWalletPositionsAndClaimable({
            address: ADDRESSES.borrower,
            cfg: matchingApiCfg,
            publicClient: partialFailRpcClient,
          });
          const unknownPos = partialFailSnap.positions.find((p) => p.loanId === heldLoanId);
          assert.ok(unknownPos, 'Info 1: failed ownerOf read must not drop API position silently');
          assert.equal(unknownPos!.ownerUnknown, true);
          assert.equal(unknownPos!.isBurned, false);
          assert.equal(unknownPos!.onchainVerified, false);
          assert.equal(unknownPos!.auctionLocked, null, 'Info 2: failed isAuctionLocked read must return null, never false');
          assert.equal(partialFailSnap.positionsIncomplete, true);
        } finally {
          await new Promise<void>((r) => matchingApiSrv.close(() => r()));
        }
      } finally {
        await new Promise<void>((r) => mockPosSrv.close(() => r()));
      }

      // Positions.jsx SSR render & ungated source check (no PreviewBanner, no ensureDeclarationVerifiedForTx)
      const positionsPageHtml = renderToStaticMarkup(
        createElement(StoreProvider, null, createElement(MemoryRouter, { initialEntries: ['/positions'] }, createElement(Shell, null, createElement(Positions))))
      );
      assert.ok(!positionsPageHtml.includes('Preview data, not your positions.'));
      assert.ok(positionsPageHtml.includes('LoanCore pull-payment USDC claims (claim)'));
      assert.ok(positionsPageHtml.includes('Held PositionNFTs'));
      assert.ok(positionsPageHtml.includes('Secondary Position Market status'));
      const positionsSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'pages', 'Positions.jsx'), 'utf8');
      assert.ok(!positionsSrc.includes('ensureDeclarationVerifiedForTx'), 'Positions.jsx claim flow must never gate behind Reg S declaration');
      assert.ok(positionsSrc.includes('executeLoanClaim'));
      assert.ok(positionsSrc.includes('confirm-alternate-claim-recipient'));

      console.log('PASS WS3.7 Review Fixes + Live Positions.jsx (PositionNFT Enumeration & Ungated LoanCore.claim) verified.');

      console.log('\nALL WS3.1 + WS3.2 + PRE-WS3.3 + WS3.3 + PRE-WS3.4 + WS3.4 PIECE 1-4 + WS3.5 PIECE 1-2 + WS3.6 + WS3.7 + POSITIONS FORK TESTS PASSED.');
    } finally {
      await new Promise<void>((r) => notifServer.close(() => r()));
      await new Promise<void>((r) => apiServer.close(() => r()));
      await notifCtx.notifDb.close();
      await notifCtx.indexerDb.close();
      await idxCtx.db.close();
    }
  } finally {
    anvilProc.kill('SIGKILL');
    fs.rmSync(path.join(CONTRACTS_DIR, 'broadcast'), { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('\nWS3.1 FORK TEST FAILED:', err);
  process.exit(1);
});
