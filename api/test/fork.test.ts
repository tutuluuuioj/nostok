import assert from 'node:assert/strict';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http as viemHttp,
  parseAbi,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { loanCoreAbi } from '../src/abi.js';
import { loadApiConfig } from '../src/config.js';
import { assertReadOnlySql, wrapQueryableAsReadOnly } from '../src/db.js';
import { type QuoteResponse } from '../src/quote.js';
import { createApiContext, createApiServer } from '../src/server.js';
import { loadConfig as loadIndexerConfig } from '../../indexer/src/config.js';
import { createIndexerContext, runIndexerSync } from '../../indexer/src/indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const API_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_DIR, '..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'contracts');

const FOUNDRY_BIN_DIR = process.env.FOUNDRY_BIN_DIR ?? `${process.env.HOME}/.foundry/bin`;
const ANVIL_PORT = Number(process.env.TEST_API_ANVIL_PORT ?? 18547);
const LOCAL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_USDC_WHALE: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';

const KEYS = {
  deployer: generatePrivateKey(),
  owner: generatePrivateKey(),
  borrower: generatePrivateKey(),
  lender: generatePrivateKey(),
  liquidator: generatePrivateKey(),
  guardian: generatePrivateKey(),
  treasury: generatePrivateKey(),
  reserve: generatePrivateKey(),
  attestationSigner: generatePrivateKey(),
};

const ADDRESSES = {
  deployer: privateKeyToAccount(KEYS.deployer).address,
  owner: privateKeyToAccount(KEYS.owner).address,
  borrower: privateKeyToAccount(KEYS.borrower).address,
  lender: privateKeyToAccount(KEYS.lender).address,
  liquidator: privateKeyToAccount(KEYS.liquidator).address,
  guardian: privateKeyToAccount(KEYS.guardian).address,
  treasury: privateKeyToAccount(KEYS.treasury).address,
  reserve: privateKeyToAccount(KEYS.reserve).address,
  attestationSigner: privateKeyToAccount(KEYS.attestationSigner).address,
};

interface DeployedAddresses {
  eligibilityGate: Address;
  collateralEscrow: Address;
  positionNFT: Address;
  assetRegistry: Address;
  oracleRouter: Address;
  feeCollector: Address;
  loanCore: Address;
  liquidationAuction: Address;
  orderSettlement: Address;
  nostokTimelock: Address;
}

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
    console.log(`[API_TEST] Starting Anvil fork against ${forkUrl} on port ${ANVIL_PORT}...`);
    const proc = spawn(
      `${FOUNDRY_BIN_DIR}/anvil`,
      ['--fork-url', forkUrl, '--port', String(ANVIL_PORT), '--chain-id', '8453', '--silent'],
      { env: getShellEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await waitForRpcReady(LOCAL_RPC_URL, 25_000);
      console.log('[API_TEST] Anvil Base Mainnet fork ready (chainId=8453)');
      return proc;
    } catch (err) {
      proc.kill('SIGKILL');
      console.warn(`[API_TEST] Fork RPC ${forkUrl} failed: ${(err as Error).message}`);
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
  if (json.error) {
    throw new Error(`RPC ${method} failed: ${json.error.message}`);
  }
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
  const re = new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`);
  const m = stdout.match(re);
  if (!m) throw new Error(`Failed to parse "${label}" from DeployNostok.s.sol output`);
  return getAddress(m[1]);
}

function deployProtocolWithForge(): DeployedAddresses {
  console.log('[API_TEST] Running DeployNostok.s.sol on local Base Mainnet fork...');
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

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: T }> {
  const res = await fetch(url, { method: 'GET', headers });
  const body = (await res.json()) as T;
  return { status: res.status, headers: res.headers, body };
}

async function postJson<T>(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Headers; body: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  const body = (await res.json()) as T;
  return { status: res.status, headers: res.headers, body };
}

async function runTests(): Promise<void> {
  const anvilProc = await startAnvilFork();

  try {
    const forkChain = defineChain({
      id: 8453,
      name: 'Base Fork',
      nativeCurrency: base.nativeCurrency,
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
    const borrowerClient = createWalletClient({
      account: borrowerAccount,
      chain: forkChain,
      transport: viemHttp(LOCAL_RPC_URL),
    });
    const lenderClient = createWalletClient({
      account: privateKeyToAccount(KEYS.lender),
      chain: forkChain,
      transport: viemHttp(LOCAL_RPC_URL),
    });
    const liquidatorClient = createWalletClient({
      account: privateKeyToAccount(KEYS.liquidator),
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

    const nvdacReceipt = await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.deployContract({
        abi: mockB20Artifact.abi,
        bytecode: mockB20Artifact.bytecode,
        args: ['Coinbase Wrapped NVDA', 'NVDAc', 18, 1000537939576369481n],
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

    const metacReceipt = await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.deployContract({
        abi: mockB20Artifact.abi,
        bytecode: mockB20Artifact.bytecode,
        args: ['Coinbase Wrapped META', 'METAc', 18, 1000313792289598084n],
      }),
    });
    const metac = getAddress(metacReceipt.contractAddress!);
    const metaFeedReceipt = await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.deployContract({
        abi: mockAggArtifact.abi,
        bytecode: mockAggArtifact.bytecode,
        args: [8, 200_00000000n],
      }),
    });
    const metaFeed = getAddress(metaFeedReceipt.contractAddress!);

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

    // Configure low globalUsdcCap = $2,600 so global cap rejection is testable cleanly
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: deployed.nostokTimelock,
        to: deployed.loanCore,
        data: encodeFunctionData({
          abi: parseAbi(['function setGlobalCap(uint128 newCap)']),
          functionName: 'setGlobalCap',
          args: [2_600_000_000n],
        }),
      }),
    });

    const setCfgAbi = [
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
    ] as const;

    // NVDAc: perLoanCap=$1,500, assetCap=$2,000
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: deployed.nostokTimelock,
        to: deployed.assetRegistry,
        data: encodeFunctionData({
          abi: setCfgAbi,
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
              perLoanCap: 1_500_000_000n,
              assetCap: 2_000_000_000n,
              maxStaleOpenSecs: 21600,
              status: 0,
              restricted: false,
            },
          ],
        }),
      }),
    });

    // METAc: perLoanCap=$2,000, assetCap=$3,000
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: deployed.nostokTimelock,
        to: deployed.assetRegistry,
        data: encodeFunctionData({
          abi: setCfgAbi,
          functionName: 'setAssetConfig',
          args: [
            metac,
            {
              feed: metaFeed,
              feedDecimals: 8,
              tier: 0,
              maxInitLtvBps: 6000,
              marginCallLtvBps: 7000,
              liqLtvBps: 7800,
              badDebtLtvBps: 9000,
              maxDiscountBps: 600,
              closedMarketHaircutBps: 500,
              perLoanCap: 2_000_000_000n,
              assetCap: 3_000_000_000n,
              maxStaleOpenSecs: 21600,
              status: 0,
              restricted: false,
            },
          ],
        }),
      }),
    });

    await publicClient.waitForTransactionReceipt({
      hash: await ownerClient.writeContract({
        address: deployed.eligibilityGate,
        abi: parseAbi(['function setAllowlistBatch(address[] accounts, bool isAllowed)']),
        functionName: 'setAllowlistBatch',
        args: [[ADDRESSES.borrower, ADDRESSES.lender, ADDRESSES.liquidator], true],
      }),
    });

    // Fund borrower with NVDAc + METAc, and lender/liquidator with real Base USDC
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.writeContract({
        address: nvdac,
        abi: mockB20Artifact.abi,
        functionName: 'mint',
        args: [ADDRESSES.borrower, 50n * 10n ** 18n],
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.writeContract({
        address: metac,
        abi: mockB20Artifact.abi,
        functionName: 'mint',
        args: [ADDRESSES.borrower, 50n * 10n ** 18n],
      }),
    });

    await rpcCall('anvil_impersonateAccount', [BASE_USDC_WHALE]);
    await rpcCall('anvil_setBalance', [BASE_USDC_WHALE, '0x56bc75e2d63100000']);
    const transferUsdcAbi = parseAbi(['function transfer(address to, uint256 value) returns (bool)']);
    for (const [to, amt] of [
      [ADDRESSES.borrower, 2_000_000_000n],
      [ADDRESSES.lender, 10_000_000_000n],
      [ADDRESSES.liquidator, 8_000_000_000n],
    ] as const) {
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: BASE_USDC_WHALE,
          to: BASE_USDC,
          data: encodeFunctionData({ abi: transferUsdcAbi, functionName: 'transfer', args: [to, amt] }),
        }),
      });
    }

    const approveAbi = parseAbi(['function approve(address spender, uint256 value) returns (bool)']);
    for (const [client, token, spender, amt] of [
      [borrowerClient, nvdac, deployed.collateralEscrow, 50n * 10n ** 18n],
      [borrowerClient, metac, deployed.collateralEscrow, 50n * 10n ** 18n],
      [borrowerClient, BASE_USDC, deployed.loanCore, 2_000_000_000n],
      [lenderClient, BASE_USDC, deployed.loanCore, 10_000_000_000n],
      [liquidatorClient, BASE_USDC, deployed.loanCore, 5_000_000_000n],
      [liquidatorClient, BASE_USDC, deployed.liquidationAuction, 5_000_000_000n],
    ] as const) {
      await publicClient.waitForTransactionReceipt({
        hash: await client.writeContract({
          address: token,
          abi: approveAbi,
          functionName: 'approve',
          args: [spender, amt],
        }),
      });
    }

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
            components: [
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
          },
          { name: 'signature', type: 'bytes' },
          { name: 'fillUsdc', type: 'uint128' },
        ],
        outputs: [{ name: 'loanId', type: 'uint256' }],
      },
    ] as const;

    async function signAndFillBorrowOrder(params: {
      takerClient: typeof lenderClient;
      collateralToken: Address;
      collateralAmount: bigint;
      usdcPrincipal: bigint;
      rateBps: number;
      termDays: number;
      maxLtvBps: number;
      nonce: bigint;
    }) {
      const blk = await publicClient.getBlock();
      const order = {
        borrower: ADDRESSES.borrower,
        collateralToken: params.collateralToken,
        collateralAmount: params.collateralAmount,
        minUsdc: params.usdcPrincipal,
        maxRateBps: params.rateBps,
        termDays: params.termDays,
        maxLtvBps: params.maxLtvBps,
        minFill: 500_000_000n,
        expiry: blk.timestamp + 3600n,
        nonce: params.nonce,
        yieldMode: 0,
        allowInKindSettlement: false,
      } as const;
      const sig = await borrowerAccount.signTypedData({
        domain: {
          name: 'NOSTOK Order Settlement',
          version: '1',
          chainId: 8453,
          verifyingContract: deployed.orderSettlement,
        },
        types: borrowTypes,
        primaryType: 'BorrowOrder',
        message: order,
      });
      return publicClient.waitForTransactionReceipt({
        hash: await params.takerClient.writeContract({
          address: deployed.orderSettlement,
          abi: fillOrderAbi,
          functionName: 'fillBorrowOrder',
          args: [order, sig, params.usdcPrincipal],
        }),
      });
    }

    // Create rich on-chain state:
    // Loan #1: NVDAc $800 -> liquidated & settled (Auction #1 Settled, Position #1 burned)
    await signAndFillBorrowOrder({
      takerClient: lenderClient,
      collateralToken: nvdac,
      collateralAmount: 10n * 10n ** 18n,
      usdcPrincipal: 800_000_000n,
      rateBps: 1000,
      termDays: 14,
      maxLtvBps: 6000,
      nonce: 0n,
    });
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.writeContract({
        address: nvdaFeed,
        abi: mockAggArtifact.abi,
        functionName: 'setPrice',
        args: [72_00000000n],
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await liquidatorClient.writeContract({
        address: deployed.loanCore,
        abi: parseAbi(['function startLiquidation(uint256 loanId) returns (uint256)']),
        functionName: 'startLiquidation',
        args: [1n],
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await liquidatorClient.writeContract({
        address: deployed.liquidationAuction,
        abi: parseAbi([
          'function buy(uint256 auctionId, uint128 collateralAmount, uint128 maxUsdcPayment) returns (uint128)',
        ]),
        functionName: 'buy',
        args: [1n, 10n * 10n ** 18n, 900_000_000n],
      }),
    });
    // Restore NVDA feed back to $140.00 for Loan #4 quoting
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.writeContract({
        address: nvdaFeed,
        abi: mockAggArtifact.abi,
        functionName: 'setPrice',
        args: [140_00000000n],
      }),
    });

    // Loan #2: METAc $600 -> stays Active (Position #2 active, unlocked)
    await signAndFillBorrowOrder({
      takerClient: lenderClient,
      collateralToken: metac,
      collateralAmount: 10n * 10n ** 18n,
      usdcPrincipal: 600_000_000n,
      rateBps: 900,
      termDays: 30,
      maxLtvBps: 6000,
      nonce: 0n,
    });

    // Loan #3: METAc $650 with liquidator as lender -> startLiquidation -> Auction #2 stays Active
    await signAndFillBorrowOrder({
      takerClient: liquidatorClient,
      collateralToken: metac,
      collateralAmount: 6n * 10n ** 18n,
      usdcPrincipal: 650_000_000n,
      rateBps: 1100,
      termDays: 21,
      maxLtvBps: 6000,
      nonce: 0n,
    });
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.writeContract({
        address: metaFeed,
        abi: mockAggArtifact.abi,
        functionName: 'setPrice',
        args: [120_00000000n],
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.writeContract({
        address: deployed.loanCore,
        abi: parseAbi(['function startLiquidation(uint256 loanId) returns (uint256)']),
        functionName: 'startLiquidation',
        args: [3n],
      }),
    });
    // Restore META feed to $200.00 for clean quote testing
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.writeContract({
        address: metaFeed,
        abi: mockAggArtifact.abi,
        functionName: 'setPrice',
        args: [200_00000000n],
      }),
    });

    // Cancel an unused borrow order so /orders?status=cancelled has real indexed data
    const blkCancel = await publicClient.getBlock();
    await publicClient.waitForTransactionReceipt({
      hash: await borrowerClient.writeContract({
        address: deployed.orderSettlement,
        abi: [
          {
            type: 'function',
            name: 'cancelBorrowOrder',
            stateMutability: 'nonpayable',
            inputs: [
              {
                name: 'order',
                type: 'tuple',
                components: [
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
              },
            ],
            outputs: [],
          },
        ] as const,
        functionName: 'cancelBorrowOrder',
        args: [
          {
            borrower: ADDRESSES.borrower,
            collateralToken: nvdac,
            collateralAmount: 10n * 10n ** 18n,
            minUsdc: 700_000_000n,
            maxRateBps: 1000,
            termDays: 14,
            maxLtvBps: 6000,
            minFill: 500_000_000n,
            expiry: blkCancel.timestamp + 3600n,
            nonce: 99n,
            yieldMode: 0,
            allowInKindSettlement: false,
          },
        ],
      }),
    });

    // Index all fork state using the WS2.1/WS2.2 indexer
    const idxCfg = loadIndexerConfig({
      rpcUrl: LOCAL_RPC_URL,
      isFork: true,
      forkChainId: 8453,
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
      assets: [nvdac, metac],
    });
    const idxCtx = await createIndexerContext(idxCfg);
    await runIndexerSync(idxCtx);

    const apiCfg = loadApiConfig({
      rpcUrl: LOCAL_RPC_URL,
      isFork: true,
      forkChainId: 8453,
      databaseUrl: 'memory://',
      corsOrigins: ['https://app.nostok.xyz'],
      rateLimitMax: 200,
      rateLimitWindowMs: 60_000,
      maxBodyBytes: 1024,
      maxPageLimit: 50,
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

    const apiCtx = await createApiContext(apiCfg, wrapQueryableAsReadOnly(idxCtx.db));
    const server = createApiServer(apiCtx);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    console.log(`[API_TEST] Read-only HTTP API listening on ${baseUrl}`);

    try {
      // -----------------------------------------------------------------------
      // TEST 1: Config & Read-only DB enforcement
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 1: Read-only DB & FORK=false DATABASE_URL enforcement ===');
      const prevEnv = process.env.DATABASE_URL;
      const prevFork = process.env.FORK;
      delete process.env.DATABASE_URL;
      delete process.env.FORK;
      try {
        assert.throws(
          () =>
            loadApiConfig({
              ...apiCfg,
              isFork: false,
              databaseUrl: 'memory://',
            }),
          /postgres:\/\/ or postgresql:\/\//i
        );
      } finally {
        if (prevEnv !== undefined) process.env.DATABASE_URL = prevEnv;
        if (prevFork !== undefined) process.env.FORK = prevFork;
      }

      assert.throws(() => assertReadOnlySql('DELETE FROM loans'), /SELECT queries only/i);
      assert.throws(() => assertReadOnlySql('INSERT INTO orders VALUES (1)'), /SELECT queries only/i);
      await assert.rejects(() => apiCtx.db.query('UPDATE loans SET status = 0'), /SELECT queries only/i);
      console.log('PASS TEST 1: API rejects writes and requires postgres(ql):// when FORK=false.');

      // -----------------------------------------------------------------------
      // TEST 2: /health endpoint
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 2: /health endpoint ===');
      const healthRes = await getJson<Record<string, unknown>>(`${baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.body.status, 'ok');
      assert.equal(healthRes.body.db_ok, true);
      assert.equal(healthRes.body.rpc_ok, true);
      assert.equal(healthRes.body.lag_blocks, '0');
      assert.ok(typeof healthRes.body.block_number === 'string');
      assert.ok(typeof healthRes.body.freshness_timestamp === 'string');
      console.log('PASS TEST 2: /health reports db_ok=true, rpc_ok=true, lag_blocks=0.');

      // -----------------------------------------------------------------------
      // TEST 3: /orders, /loans, /positions, /auctions, /assets + filters & pagination
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 3: List endpoints, filters, pagination edges & formatting ===');
      const ordersPage1 = await getJson<{
        block_number: string;
        freshness_timestamp: string;
        pagination: { total: number; limit: number; has_more: boolean; next_cursor: string | null };
        data: Array<Record<string, unknown>>;
      }>(`${baseUrl}/orders?limit=2&offset=0`);
      assert.equal(ordersPage1.status, 200);
      assert.equal(ordersPage1.body.pagination.total, 4);
      assert.equal(ordersPage1.body.data.length, 2);
      assert.equal(ordersPage1.body.pagination.has_more, true);
      assert.equal(ordersPage1.body.pagination.next_cursor, '2');

      const ordersPage2 = await getJson<typeof ordersPage1.body>(
        `${baseUrl}/orders?limit=2&cursor=2`
      );
      assert.equal(ordersPage2.status, 200);
      assert.equal(ordersPage2.body.data.length, 2);
      assert.equal(ordersPage2.body.pagination.has_more, false);
      assert.equal(ordersPage2.body.pagination.next_cursor, null);

      const ordersPastEnd = await getJson<typeof ordersPage1.body>(`${baseUrl}/orders?limit=10&offset=99`);
      assert.equal(ordersPastEnd.status, 200);
      assert.equal(ordersPastEnd.body.data.length, 0);

      const cancelledOrders = await getJson<typeof ordersPage1.body>(`${baseUrl}/orders?status=cancelled`);
      assert.equal(cancelledOrders.body.data.length, 1);

      const metacOrders = await getJson<typeof ordersPage1.body>(`${baseUrl}/orders?asset=${metac}`);
      assert.equal(metacOrders.body.data.length, 2);

      // /loans filters & decimal strings
      const activeLoans = await getJson<{
        pagination: { total: number };
        data: Array<{
          loan_id: string;
          principal: { raw: string; formatted: string; decimals: number };
          collateral_amount: { raw: string; formatted: string; decimals: number };
        }>;
      }>(`${baseUrl}/loans?status=Active&asset=${metac}`);
      assert.equal(activeLoans.status, 200);
      assert.equal(activeLoans.body.data.length, 1);
      assert.equal(activeLoans.body.data[0].loan_id, '2');
      assert.equal(activeLoans.body.data[0].principal.raw, '600000000');
      assert.equal(activeLoans.body.data[0].principal.formatted, '600');
      assert.equal(activeLoans.body.data[0].collateral_amount.raw, '10000000000000000000');
      assert.equal(activeLoans.body.data[0].collateral_amount.formatted, '10');

      const liqLenderLoans = await getJson<typeof activeLoans.body>(
        `${baseUrl}/loans?lender=${ADDRESSES.liquidator}`
      );
      assert.equal(liqLenderLoans.body.data.length, 1);
      assert.equal(liqLenderLoans.body.data[0].loan_id, '3');

      // /positions filters
      const burnedPos = await getJson<{ data: Array<{ loan_id: string }> }>(
        `${baseUrl}/positions?burned=true`
      );
      assert.equal(burnedPos.body.data.length, 1);
      assert.equal(burnedPos.body.data[0].loan_id, '1');

      const lockedPos = await getJson<{ data: Array<{ loan_id: string }> }>(
        `${baseUrl}/positions?auction_locked=true&owner=${ADDRESSES.liquidator}`
      );
      assert.equal(lockedPos.body.data.length, 1);
      assert.equal(lockedPos.body.data[0].loan_id, '3');

      // /auctions filters
      const activeAuctions = await getJson<{ data: Array<{ auction_id: string; loan_id: string }> }>(
        `${baseUrl}/auctions?status=active`
      );
      assert.equal(activeAuctions.body.data.length, 1);
      assert.equal(activeAuctions.body.data[0].auction_id, '2');
      assert.equal(activeAuctions.body.data[0].loan_id, '3');

      const loan1Auctions = await getJson<{ data: Array<{ auction_id: string; status_name: string }> }>(
        `${baseUrl}/auctions?loan=1`
      );
      assert.equal(loan1Auctions.body.data.length, 1);
      assert.equal(loan1Auctions.body.data[0].status_name, 'Settled');

      // /assets
      const assetsRes = await getJson<{
        data: Array<{
          token: string;
          symbol: string;
          oracle: { price: { raw: string; formatted: string }; state_name: string };
          caps: { asset_remaining: { raw: string } };
          multiplier: { recorded: { raw: string }; ui: { raw: string } };
        }>;
      }>(`${baseUrl}/assets?asset=${nvdac}&status=Active`);
      assert.equal(assetsRes.status, 200);
      assert.equal(assetsRes.body.data.length, 1);
      assert.equal(assetsRes.body.data[0].symbol, 'NVDAc');
      assert.equal(assetsRes.body.data[0].oracle.price.formatted, '140');
      assert.equal(assetsRes.body.data[0].oracle.state_name, 'VALID_OPEN');
      assert.ok(BigInt(assetsRes.body.data[0].multiplier.recorded.raw) > 0n);
      console.log('PASS TEST 3: All list endpoints, filters, pagination cursors/offsets & formatting verified.');

      // -----------------------------------------------------------------------
      // TEST 4: Input validation, CORS, body limit, rate limit, no stack trace
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 4: Validation (400), CORS, body cap (413), rate limit (429), sanitized errors ===');
      const badAddrRes = await getJson<{ error: { code: string; message: string; stack?: string } }>(
        `${baseUrl}/loans?borrower=${ADDRESSES.borrower.toLowerCase()}`
      );
      assert.equal(badAddrRes.status, 400);
      assert.equal(badAddrRes.body.error.code, 'VALIDATION_ERROR');
      assert.equal('stack' in badAddrRes.body.error, false);

      const badMixedCase = await getJson<{ error: { code: string } }>(
        `${baseUrl}/loans?borrower=0xAbCdEf0123456789012345678901234567890123`
      );
      assert.equal(badMixedCase.status, 400);
      assert.equal(badMixedCase.body.error.code, 'VALIDATION_ERROR');

      const overMaxLimit = await getJson<{ error: { code: string } }>(`${baseUrl}/orders?limit=999`);
      assert.equal(overMaxLimit.status, 400);

      const bothOffsetCursor = await getJson<{ error: { code: string } }>(
        `${baseUrl}/orders?offset=0&cursor=0`
      );
      assert.equal(bothOffsetCursor.status, 400);

      // Preflight CORS
      const corsPre = await fetch(`${baseUrl}/orders`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://app.nostok.xyz' },
      });
      assert.equal(corsPre.status, 204);
      assert.equal(corsPre.headers.get('access-control-allow-origin'), 'https://app.nostok.xyz');

      // Oversized JSON body > 1024 bytes
      const hugeRes = await postJson<{ error: { code: string } }>(`${baseUrl}/quote`, {
        asset: nvdac,
        principal: '600000000',
        term_days: 14,
        apr_bps: 950,
        padding: 'x'.repeat(2048),
      });
      assert.equal(hugeRes.status, 413);
      assert.equal(hugeRes.body.error.code, 'PAYLOAD_TOO_LARGE');

      // Rate limiter test on dedicated tight server instance
      const rlCtx = { ...apiCtx, config: { ...apiCfg, rateLimitMax: 2, rateLimitWindowMs: 60_000 } };
      const rlServer = createApiServer(rlCtx);
      await new Promise<void>((r) => rlServer.listen(0, '127.0.0.1', r));
      const rlAddr = rlServer.address() as net.AddressInfo;
      try {
        const r1 = await fetch(`http://127.0.0.1:${rlAddr.port}/health`);
        const r2 = await fetch(`http://127.0.0.1:${rlAddr.port}/health`);
        const r3 = await fetch(`http://127.0.0.1:${rlAddr.port}/health`);
        assert.equal(r1.status, 200);
        assert.equal(r2.status, 200);
        assert.equal(r3.status, 429);
        assert.ok(r3.headers.get('retry-after'));
      } finally {
        await new Promise<void>((r) => rlServer.close(() => r()));
      }
      console.log('PASS TEST 4: 400 validation, CORS, 413 body cap, 429 rate limit, and zero stack traces verified.');

      // -----------------------------------------------------------------------
      // TEST 5: Quote parity with LoanCore / OrderSettlement execution on fork
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 5: /quote parity with real on-chain OrderSettlement.fillBorrowOrder ===');
      const quotePost = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: nvdac,
        principal: '600000000', // $600 USDC
        term_days: 14,
        apr_bps: 950,
        borrower: ADDRESSES.borrower,
        lender: ADDRESSES.lender,
      });
      assert.equal(quotePost.status, 200);
      assert.equal(quotePost.body.accepted, true, `Unexpected quote rejection: ${JSON.stringify(quotePost.body.rejection_reasons)}`);
      assert.equal(quotePost.body.amounts.principal.raw, '600000000');
      assert.equal(quotePost.body.amounts.origination_fee.raw, '600000'); // 10 bps of $600 = $0.60
      assert.equal(quotePost.body.amounts.net_proceeds.raw, '599400000');

      // Also verify GET /quote works cleanly in collateral -> principal mode
      const quoteGet = await getJson<QuoteResponse>(
        `${baseUrl}/quote?asset=${nvdac}&collateral_amount=${quotePost.body.amounts.collateral_required.raw}&term_days=14&apr_bps=950`
      );
      assert.equal(quoteGet.status, 200);
      assert.equal(quoteGet.body.accepted, true);
      assert.ok(BigInt(quoteGet.body.amounts.principal.raw) >= 600_000_000n);

      // Execute the EXACT quoted principal and collateral_required on the fork!
      const usdcBalAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
      const borrowerUsdcBefore = await publicClient.readContract({
        address: BASE_USDC,
        abi: usdcBalAbi,
        functionName: 'balanceOf',
        args: [ADDRESSES.borrower],
      });

      await signAndFillBorrowOrder({
        takerClient: lenderClient,
        collateralToken: nvdac,
        collateralAmount: BigInt(quotePost.body.amounts.collateral_required.raw),
        usdcPrincipal: BigInt(quotePost.body.amounts.principal.raw),
        rateBps: 950,
        termDays: 14,
        maxLtvBps: quotePost.body.asset.allowed_ltv_bps,
        nonce: 0n,
      });

      const borrowerUsdcAfter = await publicClient.readContract({
        address: BASE_USDC,
        abi: usdcBalAbi,
        functionName: 'balanceOf',
        args: [ADDRESSES.borrower],
      });
      const onchainLoan4 = await publicClient.readContract({
        address: deployed.loanCore,
        abi: loanCoreAbi,
        functionName: 'getLoan',
        args: [4n],
      });
      assert.equal(onchainLoan4.principal, BigInt(quotePost.body.amounts.principal.raw));
      assert.equal(onchainLoan4.collateralRaw, BigInt(quotePost.body.amounts.collateral_required.raw));
      assert.equal(
        borrowerUsdcAfter - borrowerUsdcBefore,
        BigInt(quotePost.body.amounts.net_proceeds.raw),
        'On-chain borrower proceeds must match quoted net_proceeds to the exact wei'
      );
      console.log(
        `PASS TEST 5: Exact quoted loan executed on Base fork (Loan #4: principal=${onchainLoan4.principal}, collateral=${onchainLoan4.collateralRaw}, proceeds=${borrowerUsdcAfter - borrowerUsdcBefore}).`
      );

      // -----------------------------------------------------------------------
      // TEST 6: Quote rejection rules (caps, LTV, APR, 90d term, min principal, eligibility)
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 6: Quote rejections above caps & protocol limits ===');
      // 6a: Exceed perLoanCap ($1,500 on NVDAc) and assetCap ($2,000, $1,400 remaining after Loan #4)
      const qPerLoan = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: nvdac,
        principal: '1600000000',
        term_days: 14,
        apr_bps: 1000,
      });
      assert.equal(qPerLoan.body.accepted, false);
      assert.ok(qPerLoan.body.rejection_reasons.some((r) => r.code === 'PER_LOAN_CAP_EXCEEDED'));
      assert.ok(qPerLoan.body.rejection_reasons.some((r) => r.code === 'GLOBAL_CAP_EXCEEDED'));

      // 6b: Exceed assetCap ONLY on NVDAc ($1,450 <= $1,500 perLoanCap, $600 + $1,450 > $2,000 assetCap; wait 1850+1450 > 2600 too; raise globalCap check via METAc below)
      const qAssetCap = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: nvdac,
        principal: '1450000000',
        term_days: 14,
        apr_bps: 1000,
      });
      assert.equal(qAssetCap.body.accepted, false);
      assert.ok(qAssetCap.body.rejection_reasons.some((r) => r.code === 'ASSET_CAP_EXCEEDED'));

      // 6c: Exceed globalUsdcCap ONLY on METAc ($1,000 <= $2,000 perLoanCap, $1,250 + $1,000 <= $3,000 assetCap, $1,850 + $1,000 > $2,600 globalCap)
      const qGlobalCap = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: metac,
        principal: '1000000000',
        term_days: 14,
        apr_bps: 1000,
      });
      assert.equal(qGlobalCap.body.accepted, false);
      assert.ok(qGlobalCap.body.rejection_reasons.some((r) => r.code === 'GLOBAL_CAP_EXCEEDED'));

      // 6d: Collateral-only above cap ($1,000 collateral math: 100 METAc * $200 * 60% = $12,000 -> exceeds all caps)
      const qColOverCap = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: metac,
        collateral_amount: (100n * 10n ** 18n).toString(),
        term_days: 14,
        apr_bps: 1000,
      });
      assert.equal(qColOverCap.body.accepted, false);
      assert.ok(qColOverCap.body.rejection_reasons.some((r) => r.code === 'GLOBAL_CAP_EXCEEDED'));

      // 6e: LTV exceeded, <$500 principal, >40% APR, >90d total term, ineligible borrower
      const qBadTerms = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: nvdac,
        collateral_amount: (2n * 10n ** 18n).toString(), // $280 value -> max $168
        principal: '400000000', // < $500 AND > LTV
        term_days: 40,
        existing_elapsed_days: 60, // 60 + 40 = 100 > 90 days
        apr_bps: 4500, // > 40%
        borrower: ADDRESSES.treasury, // not allowlisted
      });
      assert.equal(qBadTerms.body.accepted, false);
      const badCodes = new Set(qBadTerms.body.rejection_reasons.map((r) => r.code));
      assert.ok(badCodes.has('PRINCIPAL_BELOW_MINIMUM'));
      assert.ok(badCodes.has('LTV_EXCEEDED'));
      assert.ok(badCodes.has('MAX_90_DAY_TOTAL_TERM_EXCEEDED'));
      assert.ok(badCodes.has('APR_EXCEEDS_MAX'));
      assert.ok(badCodes.has('BORROWER_INELIGIBLE'));

      console.log('PASS TEST 6: All cap and constraint rejections verified accurately.');
      console.log('\nALL API WS2.3 BASE MAINNET FORK INTEGRATION TESTS PASSED.');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await idxCtx.db.close();
    }
  } finally {
    anvilProc.kill('SIGKILL');
    fs.rmSync(path.join(CONTRACTS_DIR, 'broadcast'), { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('\nAPI FORK TEST FAILED:', err);
  process.exit(1);
});
