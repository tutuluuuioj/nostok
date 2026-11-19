import assert from 'node:assert/strict';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
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
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { loanCoreAbi, orderSettlementAbi } from '../src/abi.js';
import { loadApiConfig } from '../src/config.js';
import { assertReadOnlySql, openReadOnlyDatabase, wrapQueryableAsReadOnly } from '../src/db.js';
import { type QuoteResponse } from '../src/quote.js';
import {
  type RelaySignedOrderRecord,
  createApiContext,
  createApiServer,
  runRelayBackgroundRefresh,
  sanitizeTokenSymbol,
} from '../src/server.js';
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
      signerAccount?: typeof borrowerAccount;
      collateralToken: Address;
      collateralAmount: bigint;
      minUsdc?: bigint;
      usdcPrincipal: bigint;
      rateBps: number;
      termDays: number;
      maxLtvBps: number;
      nonce: bigint;
      borrowerAttestation?: Hex;
      lenderAttestation?: Hex;
    }) {
      const signer = params.signerAccount ?? borrowerAccount;
      const blk = await publicClient.getBlock();
      const order = {
        borrower: signer.address,
        collateralToken: params.collateralToken,
        collateralAmount: params.collateralAmount,
        minUsdc: params.minUsdc ?? params.usdcPrincipal,
        maxRateBps: params.rateBps,
        termDays: params.termDays,
        maxLtvBps: params.maxLtvBps,
        minFill: 500_000_000n,
        expiry: blk.timestamp + 3600n,
        nonce: params.nonce,
        yieldMode: 0,
        allowInKindSettlement: false,
      } as const;
      const sig = await signer.signTypedData({
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
      if (params.borrowerAttestation !== undefined || params.lenderAttestation !== undefined) {
        const fillWithAttAbi = [
          {
            type: 'function',
            name: 'fillBorrowOrderWithAttestations',
            stateMutability: 'nonpayable',
            inputs: [
              ...fillOrderAbi[0].inputs,
              { name: 'borrowerAttestation', type: 'bytes' },
              { name: 'lenderAttestation', type: 'bytes' },
            ],
            outputs: [{ name: 'loanId', type: 'uint256' }],
          },
        ] as const;
        return publicClient.waitForTransactionReceipt({
          hash: await params.takerClient.writeContract({
            address: deployed.orderSettlement,
            abi: fillWithAttAbi,
            functionName: 'fillBorrowOrderWithAttestations',
            args: [
              order,
              sig,
              params.usdcPrincipal,
              params.borrowerAttestation ?? '0x',
              params.lenderAttestation ?? '0x',
            ],
          }),
        });
      }
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

    // Loan #2: METAc $600 fill against $1,200 minUsdc order -> partially_filled (Position #2 active)
    await signAndFillBorrowOrder({
      takerClient: lenderClient,
      collateralToken: metac,
      collateralAmount: 20n * 10n ** 18n,
      minUsdc: 1_200_000_000n,
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
      console.log('\n=== TEST 1: Read-only DB & FORK=false fail-closed startup enforcement ===');
      const prevEnv = process.env.DATABASE_URL;
      const prevFork = process.env.FORK;
      const prevTrustProxy = process.env.TRUST_PROXY;
      const prevGeoReq = process.env.GEO_REQUIRE_HEADER;
      const prevGeoDis = process.env.GEO_DISABLED;
      const prevTrustedCidrs = process.env.TRUSTED_PROXY_CIDRS;
      const prevSanctioned = process.env.SANCTIONED_ADDRESSES;
      const prevWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((a) => String(a)).join(' '));
      };
      delete process.env.DATABASE_URL;
      delete process.env.FORK;
      delete process.env.TRUST_PROXY;
      delete process.env.GEO_REQUIRE_HEADER;
      delete process.env.GEO_DISABLED;
      delete process.env.TRUSTED_PROXY_CIDRS;
      delete process.env.SANCTIONED_ADDRESSES;
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

        // M1: FORK=false with default env (TRUST_PROXY=0, GEO_REQUIRE_HEADER unset, GEO_DISABLED unset) MUST refuse to start
        process.env.FORK = 'false';
        process.env.DATABASE_URL = 'postgres://user:pass@127.0.0.1:5432/nostok';
        assert.throws(
          () =>
            loadApiConfig({
              rpcUrl: apiCfg.rpcUrl,
              loanCore: apiCfg.loanCore,
              orderSettlement: apiCfg.orderSettlement,
              liquidationAuction: apiCfg.liquidationAuction,
              positionNft: apiCfg.positionNft,
              collateralEscrow: apiCfg.collateralEscrow,
              assetRegistry: apiCfg.assetRegistry,
              oracleRouter: apiCfg.oracleRouter,
              feeCollector: apiCfg.feeCollector,
              eligibilityGate: apiCfg.eligibilityGate,
              usdc: apiCfg.usdc,
            }),
          /refuses to start without verified edge geoblock/i
        );
        // Partial configs must also refuse to start when FORK=false
        assert.throws(
          () =>
            loadApiConfig({
              ...apiCfg,
              isFork: false,
              databaseUrl: 'postgres://user:pass@127.0.0.1:5432/nostok',
              trustProxyHops: 1,
              geoRequireHeader: false,
              geoDisabled: false,
            }),
          /refuses to start without verified edge geoblock/i
        );
        assert.throws(
          () =>
            loadApiConfig({
              ...apiCfg,
              isFork: false,
              databaseUrl: 'postgres://user:pass@127.0.0.1:5432/nostok',
              trustProxyHops: 0,
              geoRequireHeader: true,
              geoDisabled: false,
            }),
          /refuses to start without verified edge geoblock/i
        );

        // Production config with TRUST_PROXY>=1 + GEO_REQUIRE_HEADER=true succeeds and logs loud warning if SANCTIONED_ADDRESSES is empty
        warnings.length = 0;
        const prodCfg = loadApiConfig({
          ...apiCfg,
          isFork: false,
          databaseUrl: 'postgres://user:pass@127.0.0.1:5432/nostok',
          trustProxyHops: 1,
          geoRequireHeader: true,
          geoDisabled: false,
          sanctionedAddresses: [],
        });
        assert.equal(prodCfg.isFork, false);
        assert.equal(prodCfg.trustProxyHops, 1);
        assert.equal(prodCfg.geoRequireHeader, true);
        assert.ok(
          warnings.some((w) => /\[API_SECURITY_WARNING\].*SANCTIONED_ADDRESSES is empty/i.test(w)),
          'Expected loud SANCTIONED_ADDRESSES warning'
        );

        // Explicit GEO_DISABLED=true override allows startup when FORK=false and emits loud warning
        warnings.length = 0;
        const overrideCfg = loadApiConfig({
          ...apiCfg,
          isFork: false,
          databaseUrl: 'postgres://user:pass@127.0.0.1:5432/nostok',
          trustProxyHops: 0,
          geoRequireHeader: false,
          geoDisabled: true,
        });
        assert.equal(overrideCfg.geoDisabled, true);
        assert.ok(
          warnings.some((w) => /\[API_SECURITY_WARNING\].*GEO_DISABLED=true/i.test(w)),
          'Expected loud GEO_DISABLED=true override warning'
        );

        // Invalid TRUSTED_PROXY_CIDRS fails fast at config load
        assert.throws(
          () =>
            loadApiConfig({
              ...apiCfg,
              trustProxyHops: 1,
              geoRequireHeader: true,
              trustedProxyCidrs: ['not-a-valid-cidr'],
            }),
          /Invalid IP or CIDR entry/i
        );
      } finally {
        console.warn = prevWarn;
        if (prevEnv !== undefined) process.env.DATABASE_URL = prevEnv;
        else delete process.env.DATABASE_URL;
        if (prevFork !== undefined) process.env.FORK = prevFork;
        else delete process.env.FORK;
        if (prevTrustProxy !== undefined) process.env.TRUST_PROXY = prevTrustProxy;
        else delete process.env.TRUST_PROXY;
        if (prevGeoReq !== undefined) process.env.GEO_REQUIRE_HEADER = prevGeoReq;
        else delete process.env.GEO_REQUIRE_HEADER;
        if (prevGeoDis !== undefined) process.env.GEO_DISABLED = prevGeoDis;
        else delete process.env.GEO_DISABLED;
        if (prevTrustedCidrs !== undefined) process.env.TRUSTED_PROXY_CIDRS = prevTrustedCidrs;
        else delete process.env.TRUSTED_PROXY_CIDRS;
        if (prevSanctioned !== undefined) process.env.SANCTIONED_ADDRESSES = prevSanctioned;
        else delete process.env.SANCTIONED_ADDRESSES;
      }

      assert.throws(() => assertReadOnlySql('DELETE FROM loans'), /SELECT/i);
      assert.throws(() => assertReadOnlySql('INSERT INTO orders VALUES (1)'), /SELECT/i);
      assert.throws(() => assertReadOnlySql('SET default_transaction_read_only=off'), /SELECT/i);
      assert.throws(() => assertReadOnlySql('BEGIN'), /SELECT/i);
      assert.throws(() => assertReadOnlySql('MERGE INTO loans USING orders ON false WHEN MATCHED THEN DELETE'), /disallowed|SELECT/i);
      assert.throws(() => assertReadOnlySql('SELECT * INTO tmp_tbl FROM loans'), /disallowed/i);
      assert.throws(() => assertReadOnlySql("SELECT set_config('default_transaction_read_only', 'off', false)"), /disallowed/i);
      assert.throws(() => assertReadOnlySql('SELECT pg_sleep(5)'), /disallowed/i);
      assert.throws(() => assertReadOnlySql('SELECT pg_terminate_backend(1)'), /disallowed/i);
      assert.throws(() => assertReadOnlySql("SELECT lo_import('/etc/passwd')"), /disallowed/i);
      assert.throws(() => assertReadOnlySql("SELECT * FROM dblink('conn', 'SELECT 1')"), /disallowed/i);
      assert.throws(
        () => assertReadOnlySql('SELECT 1; SET default_transaction_read_only=off'),
        /single-statement/i
      );
      assert.throws(() => assertReadOnlySql('SELECT /* sneaky */ 1'), /single-statement/i);
      assert.throws(() => assertReadOnlySql('SELECT U&"pg\\005fsleep"(2)'), /escaped SQL|backslash/i);
      assert.throws(() => assertReadOnlySql('SELECT u&"\\0050g_sleep"(2)'), /escaped SQL|backslash/i);
      assert.throws(() => assertReadOnlySql("SELECT E'\\x70g_sleep'(2)"), /escaped SQL|backslash/i);
      assert.throws(() => assertReadOnlySql('SELECT pg\\005fsleep(2)'), /backslash/i);
      assert.throws(() => assertReadOnlySql('SELECT "pg_sleep"(2)'), /disallowed/i);
      assert.throws(() => assertReadOnlySql(`SELECT 1 AS "a'b", pg_sleep(0.5), 2 AS "c'd"`), /disallowed/i);
      assert.throws(
        () => assertReadOnlySql(`WITH "a'b" AS (SELECT 1), x AS (DELETE FROM loans RETURNING 1), "c'd" AS (SELECT 2) SELECT 1`),
        /disallowed/i
      );
      assert.throws(() => assertReadOnlySql('SELECT $tag$1$tag$'), /dollar-quoted/i);
      assert.throws(() => assertReadOnlySql("SELECT query_to_xml('SELECT 1', true, true, '')"), /disallowed/i);
      assert.throws(() => assertReadOnlySql("SELECT nextval('loans_seq')"), /disallowed/i);
      assert.throws(() => assertReadOnlySql("SELECT setval('loans_seq', 1)"), /disallowed/i);
      assert.throws(() => assertReadOnlySql('SELECT txid_current()'), /disallowed/i);
      assert.throws(() => assertReadOnlySql('SELECT * FROM information_schema.tables'), /disallowed/i);
      assert.throws(() => assertReadOnlySql("SELECT xpath('/a', '<a/>')"), /disallowed/i);
      await assert.rejects(() => apiCtx.db.query('UPDATE loans SET status = 0'), /SELECT/i);

      // Test ReadOnlyPostgresPool (postgres:// wire protocol): connection drop retry + pool error handler
      const roPort = await new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
          const a = srv.address();
          srv.close((e) => (e ? reject(e) : resolve((a as net.AddressInfo).port)));
        });
        srv.on('error', reject);
      });
      const roPglite = new PGlite();
      await roPglite.waitReady;
      const roPgServer = new PGLiteSocketServer({ db: roPglite, host: '127.0.0.1', port: roPort, maxConnections: 5 });
      await roPgServer.start();
      const roPgUrl = `postgres://postgres:postgres@127.0.0.1:${roPort}/postgres`;
      try {
        const roDb = await openReadOnlyDatabase(roPgUrl);
        try {
          const roPool = (roDb as unknown as { pool: { emit: (ev: string, err: Error) => void; _clients?: Array<{ connection?: { stream?: { destroy: () => void } } }> } }).pool;
          roPool.emit(
            'error',
            Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })
          );
          const stream = roPool._clients?.[0]?.connection?.stream;
          if (stream) stream.destroy();
          const okAfterDrop = await roDb.query<{ alive: number }>('SELECT 1 AS alive');
          assert.equal(Number(okAfterDrop.rows[0].alive), 1);
        } finally {
          await roDb.close();
        }
      } finally {
        await roPgServer.stop();
        await roPglite.close();
      }
      console.log('PASS TEST 1: Strict SQL allowlist, postgres:// drop resilience, and FORK=false DATABASE_URL enforcement verified.');

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
      const healthGeo = healthRes.body.geo as Record<string, unknown>;
      const healthSanctions = healthRes.body.sanctions as Record<string, unknown>;
      assert.ok(healthGeo && typeof healthGeo === 'object', '/health must include geo mode object');
      assert.equal(healthGeo.mode, 'local_unverified');
      assert.equal(healthGeo.enabled, false);
      assert.equal(healthGeo.trust_proxy_hops, 0);
      assert.equal(healthGeo.require_header, false);
      assert.equal(healthGeo.trusted_proxy_cidrs_count, 0);
      assert.ok(healthSanctions && typeof healthSanctions === 'object', '/health must include sanctions mode object');
      assert.equal(healthSanctions.mode, 'empty_list');
      assert.equal(healthSanctions.sanctioned_addresses_count, 0);
      console.log('PASS TEST 2: /health reports db_ok=true, rpc_ok=true, lag_blocks=0, geo & sanctions modes.');

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

      const cancelledOrders = await getJson<typeof ordersPage1.body>(
        `${baseUrl}/orders?status=cancelled&asset=${nvdac}`
      );
      assert.equal(cancelledOrders.body.data.length, 1, 'Cancelled zero-fill order must match asset filter');
      assert.equal(cancelledOrders.body.data[0].status, 'cancelled');

      const partialOrders = await getJson<typeof ordersPage1.body>(
        `${baseUrl}/orders?status=partially_filled`
      );
      assert.equal(partialOrders.body.data.length, 1);
      assert.equal(partialOrders.body.data[0].status, 'partially_filled');
      assert.equal((partialOrders.body.data[0].min_usdc as { raw: string }).raw, '1200000000');
      assert.equal((partialOrders.body.data[0].filled_usdc as { raw: string }).raw, '600000000');
      assert.equal((partialOrders.body.data[0].remaining_usdc as { raw: string }).raw, '600000000');

      const filledOrders = await getJson<typeof ordersPage1.body>(`${baseUrl}/orders?status=filled`);
      assert.equal(filledOrders.body.data.length, 2);

      const openOrderStatusRejected = await getJson<{ error: { code: string } }>(
        `${baseUrl}/orders?status=open`
      );
      assert.equal(openOrderStatusRejected.status, 400, 'status=open must be rejected with 400');

      // Unknown min_usdc (e.g., filled via wrapper contract) -> status='unknown' and remaining_usdc=null
      const wrapperOrderHash = '0x' + 'de'.repeat(32);
      await idxCtx.db.query(
        `INSERT INTO orders (order_hash, maker, collateral_token, min_usdc, filled_usdc, order_type, cancelled, maker_nonce, first_seen_block, last_updated_block)
         VALUES ($1, $2, $3, 0, 400000000, 'borrow', FALSE, 0, $4, $4)`,
        [wrapperOrderHash, ADDRESSES.borrower, nvdac, startBlock.toString()]
      );
      try {
        const unknownOrders = await getJson<typeof ordersPage1.body>(`${baseUrl}/orders?status=unknown`);
        assert.equal(unknownOrders.status, 200);
        assert.equal(unknownOrders.body.data.length, 1);
        assert.equal(unknownOrders.body.data[0].status, 'unknown');
        assert.equal(unknownOrders.body.data[0].remaining_usdc, null);
        const filledWithoutUnknown = await getJson<typeof ordersPage1.body>(`${baseUrl}/orders?status=filled`);
        assert.equal(filledWithoutUnknown.body.data.length, 2, 'unknown min_usdc order must NOT show as filled');
      } finally {
        await idxCtx.db.query('DELETE FROM orders WHERE order_hash = $1', [wrapperOrderHash]);
      }

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

      // /assets multicall batching & per-block cache check
      let assetRpcCalls = 0;
      const countedPublicClient = new Proxy(publicClient, {
        get(target, prop, receiver) {
          if (prop === 'getBlockNumber' || prop === 'multicall' || prop === 'readContract') {
            return async (arg?: unknown) => {
              assetRpcCalls++;
              if (prop === 'getBlockNumber') return target.getBlockNumber();
              if (prop === 'multicall') return target.multicall(arg as Parameters<typeof target.multicall>[0]);
              return target.readContract(arg as Parameters<typeof target.readContract>[0]);
            };
          }
          const val = Reflect.get(target, prop, receiver);
          return typeof val === 'function' ? val.bind(target) : val;
        },
      });
      const cachedServer = createApiServer({ ...apiCtx, publicClient: countedPublicClient });
      await new Promise<void>((r) => cachedServer.listen(0, '127.0.0.1', r));
      const cachedPort = (cachedServer.address() as net.AddressInfo).port;
      try {
        assetRpcCalls = 0;
        const a1 = await getJson<{ data: unknown[] }>(`http://127.0.0.1:${cachedPort}/assets`);
        assert.equal(a1.status, 200);
        const coldCalls = assetRpcCalls;
        assert.ok(coldCalls <= 2, `Cold /assets must batch via multicall (got ${coldCalls} RPC calls)`);

        assetRpcCalls = 0;
        const a2 = await getJson<{ data: unknown[] }>(`http://127.0.0.1:${cachedPort}/assets`);
        assert.equal(a2.status, 200);
        assert.equal(assetRpcCalls, 1, 'Same-block repeat /assets must use block cache (getBlockNumber only)');
      } finally {
        await new Promise<void>((r) => cachedServer.close(() => r()));
      }

      // /assets response values
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
      console.log('PASS TEST 3: All list endpoints, filters, /assets multicall + block cache & pagination verified.');

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

      // Reject JSON numbers on /quote amount fields and numbers above MAX_SAFE_INTEGER with 400 (never 500)
      const jsonNumPrincipal = await postJson<{ error: { code: string; message: string } }>(`${baseUrl}/quote`, {
        asset: nvdac,
        principal: 600000000,
        term_days: 14,
        apr_bps: 950,
      });
      assert.equal(jsonNumPrincipal.status, 400);
      assert.equal(jsonNumPrincipal.body.error.code, 'VALIDATION_ERROR');

      const unsafeScientific = await postJson<{ error: { code: string } }>(
        `${baseUrl}/quote`,
        `{"asset":"${nvdac}","collateral_amount":1e21,"term_days":14,"apr_bps":950}`
      );
      assert.equal(unsafeScientific.status, 400);
      assert.equal(unsafeScientific.body.error.code, 'VALIDATION_ERROR');

      const unsafePrecisionLoss = await postJson<{ error: { code: string } }>(
        `${baseUrl}/quote`,
        `{"asset":"${nvdac}","principal":9007199254740993,"term_days":14,"apr_bps":950}`
      );
      assert.equal(unsafePrecisionLoss.status, 400);
      assert.equal(unsafePrecisionLoss.body.error.code, 'VALIDATION_ERROR');

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

      // Rate limiter test: trustProxyHops=1 + maxBuckets=2 + timer eviction
      const rlCtx = {
        ...apiCtx,
        config: {
          ...apiCfg,
          rateLimitMax: 2,
          rateLimitWindowMs: 60_000,
          rateLimitMaxBuckets: 2,
          trustProxyHops: 1,
        },
      };
      const rlServer = createApiServer(rlCtx);
      await new Promise<void>((r) => rlServer.listen(0, '127.0.0.1', r));
      const rlAddr = rlServer.address() as net.AddressInfo;
      try {
        const r1 = await fetch(`http://127.0.0.1:${rlAddr.port}/health`, {
          headers: { 'x-forwarded-for': '203.0.113.1' },
        });
        const r2 = await fetch(`http://127.0.0.1:${rlAddr.port}/health`, {
          headers: { 'x-forwarded-for': '203.0.113.1' },
        });
        const r3 = await fetch(`http://127.0.0.1:${rlAddr.port}/health`, {
          headers: { 'x-forwarded-for': '203.0.113.1' },
        });
        assert.equal(r1.status, 200);
        assert.equal(r2.status, 200);
        assert.equal(r3.status, 429);
        assert.ok(r3.headers.get('retry-after'));

        const bucket2Ok = await fetch(`http://127.0.0.1:${rlAddr.port}/health`, {
          headers: { 'x-forwarded-for': '203.0.113.2' },
        });
        assert.equal(bucket2Ok.status, 200);
        // 3rd distinct IP hits maxBuckets=2 cap
        const bucket3Capped = await fetch(`http://127.0.0.1:${rlAddr.port}/health`, {
          headers: { 'x-forwarded-for': '203.0.113.3' },
        });
        assert.equal(bucket3Capped.status, 429);
      } finally {
        await new Promise<void>((r) => rlServer.close(() => r()));
      }

      // 503 RPC_UNAVAILABLE test on /quote and /assets when RPC fails
      const deadRpcClient = new Proxy(publicClient, {
        get(target, prop, receiver) {
          if (prop === 'getBlockNumber' || prop === 'readContract' || prop === 'multicall' || prop === 'request') {
            return async () => {
              throw new Error('ECONNREFUSED 127.0.0.1:9999');
            };
          }
          const val = Reflect.get(target, prop, receiver);
          return typeof val === 'function' ? val.bind(target) : val;
        },
      });
      const rpcDownServer = createApiServer({ ...apiCtx, publicClient: deadRpcClient });
      await new Promise<void>((r) => rpcDownServer.listen(0, '127.0.0.1', r));
      const rpcDownPort = (rpcDownServer.address() as net.AddressInfo).port;
      try {
        const assetsDown = await getJson<{ error: { code: string; stack?: string } }>(
          `http://127.0.0.1:${rpcDownPort}/assets`
        );
        assert.equal(assetsDown.status, 503);
        assert.equal(assetsDown.body.error.code, 'RPC_UNAVAILABLE');
        assert.equal('stack' in assetsDown.body.error, false);

        const quoteDown = await postJson<{ error: { code: string; stack?: string } }>(
          `http://127.0.0.1:${rpcDownPort}/quote`,
          { asset: nvdac, principal: '600000000', term_days: 14, apr_bps: 950 }
        );
        assert.equal(quoteDown.status, 503);
        assert.equal(quoteDown.body.error.code, 'RPC_UNAVAILABLE');
        assert.equal('stack' in quoteDown.body.error, false);
      } finally {
        await new Promise<void>((r) => rpcDownServer.close(() => r()));
      }
      console.log('PASS TEST 4: 400 validation, safe JSON numbers, CORS, 413 body cap, 429 rate limit, 503 RPC_UNAVAILABLE verified.');

      // -----------------------------------------------------------------------
      // TEST 5: Quote parity with LoanCore / OrderSettlement execution & exact liquidation price sweep
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 5: /quote parity & exact startLiquidation threshold sweep ===');
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

      // Verify GET /quote works in collateral -> principal mode
      const quoteGet = await getJson<QuoteResponse>(
        `${baseUrl}/quote?asset=${nvdac}&collateral_amount=${quotePost.body.amounts.collateral_required.raw}&term_days=14&apr_bps=950`
      );
      assert.equal(quoteGet.status, 200);
      assert.equal(quoteGet.body.accepted, true);
      assert.ok(BigInt(quoteGet.body.amounts.principal.raw) >= 600_000_000n);

      // Verify initial_ltv_bps and health_factor use gross value + min_interest_floor debt
      const expectedOrigDebt =
        BigInt(quotePost.body.amounts.principal.raw) + BigInt(quotePost.body.amounts.min_interest_floor.raw);
      assert.equal(quotePost.body.amounts.origination_debt.raw, expectedOrigDebt.toString());
      const grossUsdc = BigInt(quotePost.body.amounts.collateral_gross_value_usdc.raw);
      const expectedHf = (grossUsdc * 7800n * 10n ** 14n) / expectedOrigDebt;
      assert.equal(quotePost.body.risk.health_factor.raw, expectedHf.toString());

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

      // Step Oracle price via setPrice and simulate LoanCore.startLiquidation(4) to find exact threshold
      const quotedLiqPrice = BigInt(quotePost.body.risk.liquidation_price.raw);
      const quotedLiqPriceAtMat = BigInt(quotePost.body.risk.liquidation_price_at_maturity.raw);
      const startLiqAbi = parseAbi(['function startLiquidation(uint256 loanId) returns (uint256)']);
      async function canStartLiquidationAtPrice(price8: bigint): Promise<boolean> {
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [price8],
          }),
        });
        try {
          await publicClient.simulateContract({
            address: deployed.loanCore,
            abi: startLiqAbi,
            functionName: 'startLiquidation',
            args: [4n],
            account: ADDRESSES.liquidator,
          });
          return true;
        } catch {
          return false;
        }
      }

      // Safe-side direction: quotedLiqPrice itself must NOT liquidate, and quotedLiqPrice - 1n (highest liquidating price) MUST!
      let lo = quotedLiqPrice - 1_000_000n;
      let hi = quotedLiqPrice + 1_000_000n;
      while (lo < hi) {
        const mid = (lo + hi + 1n) / 2n;
        if (await canStartLiquidationAtPrice(mid)) {
          lo = mid;
        } else {
          hi = mid - 1n;
        }
      }
      const exactHighestLiqPrice = lo;
      assert.ok(
        quotedLiqPrice >= exactHighestLiqPrice + 1n,
        `Quoted liquidation_price (${quotedLiqPrice}) must be >= highest liquidating price + 1 (${exactHighestLiqPrice + 1n})`
      );
      assert.equal(
        quotedLiqPrice,
        exactHighestLiqPrice + 1n,
        `Quoted liquidation_price (${quotedLiqPrice}) should be exact first non-liquidating price (${exactHighestLiqPrice + 1n})`
      );

      // Sweep 51 consecutive prices [-25 .. +25] around quotedLiqPrice
      for (let delta = -25n; delta <= 25n; delta++) {
        const probe = quotedLiqPrice + delta;
        const canLiq = await canStartLiquidationAtPrice(probe);
        assert.equal(
          canLiq,
          probe < quotedLiqPrice,
          `51-price origination sweep mismatch at price=${probe} (quotedLiqPrice=${quotedLiqPrice})`
        );
      }

      // Also verify liquidation_price_at_maturity by snapshotting and setting exact block.timestamp = onchainLoan4.maturity
      let matSnapId = await rpcCall<string>('evm_snapshot', []);
      async function canStartLiquidationAtMaturityPrice(price8: bigint): Promise<boolean> {
        await rpcCall('evm_revert', [matSnapId]);
        matSnapId = await rpcCall<string>('evm_snapshot', []);
        await rpcCall('evm_setNextBlockTimestamp', [Number(onchainLoan4.maturity)]);
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [price8],
          }),
        });
        try {
          await publicClient.simulateContract({
            address: deployed.loanCore,
            abi: startLiqAbi,
            functionName: 'startLiquidation',
            args: [4n],
            account: ADDRESSES.liquidator,
          });
          return true;
        } catch {
          return false;
        }
      }

      let loMat = quotedLiqPriceAtMat - 1_000_000n;
      let hiMat = quotedLiqPriceAtMat + 1_000_000n;
      while (loMat < hiMat) {
        const mid = (loMat + hiMat + 1n) / 2n;
        if (await canStartLiquidationAtMaturityPrice(mid)) {
          loMat = mid;
        } else {
          hiMat = mid - 1n;
        }
      }
      const exactHighestMatLiqPrice = loMat;
      assert.ok(
        quotedLiqPriceAtMat >= exactHighestMatLiqPrice + 1n,
        `Quoted liquidation_price_at_maturity (${quotedLiqPriceAtMat}) must be >= exact highest at maturity + 1 (${exactHighestMatLiqPrice + 1n})`
      );
      assert.equal(
        quotedLiqPriceAtMat,
        exactHighestMatLiqPrice + 1n,
        `Quoted liquidation_price_at_maturity (${quotedLiqPriceAtMat}) must equal exact first non-liquidating price (${exactHighestMatLiqPrice + 1n})`
      );
      for (let delta = -25n; delta <= 25n; delta++) {
        const probe = quotedLiqPriceAtMat + delta;
        const canLiq = await canStartLiquidationAtMaturityPrice(probe);
        assert.equal(
          canLiq,
          probe < quotedLiqPriceAtMat,
          `51-price maturity sweep mismatch at price=${probe} (quotedLiqPriceAtMat=${quotedLiqPriceAtMat})`
        );
      }
      await rpcCall('evm_revert', [matSnapId]);

      // Restore NVDA feed back to $140.00
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [140_00000000n],
        }),
      });
      console.log(
        `PASS TEST 5: Quote executed CLEANLY (Loan #4); origLiq=${quotedLiqPrice} (exactHighest+1=${exactHighestLiqPrice + 1n}), matLiq=${quotedLiqPriceAtMat} (exactHighestMat+1=${exactHighestMatLiqPrice + 1n}), 102 boundary prices swept.`
      );

      // -----------------------------------------------------------------------
      // TEST 6: Eligibility parity, cap rejections, extend terms & uint128 bounds
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 6: Eligibility parity (revoked+permissionless, attested), caps & uint128 bounds ===');
      // 6a: Revoked user in permissionlessMode = true MUST be rejected by /quote
      await publicClient.waitForTransactionReceipt({
        hash: await ownerClient.writeContract({
          address: deployed.eligibilityGate,
          abi: parseAbi(['function setPermissionlessMode(bool enabled)']),
          functionName: 'setPermissionlessMode',
          args: [true],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await ownerClient.writeContract({
          address: deployed.eligibilityGate,
          abi: parseAbi(['function revokeUser(address account, bool revoked)']),
          functionName: 'revokeUser',
          args: [ADDRESSES.treasury, true],
        }),
      });
      const qRevokedPerm = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: nvdac,
        principal: '500000000',
        term_days: 14,
        apr_bps: 950,
        borrower: ADDRESSES.treasury,
        lender: ADDRESSES.lender,
      });
      assert.equal(qRevokedPerm.body.accepted, false);
      assert.ok(
        qRevokedPerm.body.rejection_reasons.some((r) => r.code === 'BORROWER_INELIGIBLE'),
        'Revoked user must fail eligibility even in permissionlessMode=true'
      );
      // Restore permissionless=false & unrevoke treasury
      await publicClient.waitForTransactionReceipt({
        hash: await ownerClient.writeContract({
          address: deployed.eligibilityGate,
          abi: parseAbi(['function revokeUser(address account, bool revoked)']),
          functionName: 'revokeUser',
          args: [ADDRESSES.treasury, false],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await ownerClient.writeContract({
          address: deployed.eligibilityGate,
          abi: parseAbi(['function setPermissionlessMode(bool enabled)']),
          functionName: 'setPermissionlessMode',
          args: [false],
        }),
      });

      // 6b: Attested non-allowlisted user (permissionlessMode = false)
      const attestedPriv = generatePrivateKey();
      const attestedAccount = privateKeyToAccount(attestedPriv);
      const attestedWallet = createWalletClient({
        account: attestedAccount,
        chain: forkChain,
        transport: viemHttp(LOCAL_RPC_URL),
      });
      await rpcCall('anvil_setBalance', [attestedAccount.address, '0x56bc75e2d63100000']);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [attestedAccount.address, 20n * 10n ** 18n],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await attestedWallet.writeContract({
          address: nvdac,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.collateralEscrow, 20n * 10n ** 18n],
        }),
      });

      const qNoAtt = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: nvdac,
        principal: '500000000',
        term_days: 14,
        apr_bps: 950,
        borrower: attestedAccount.address,
        lender: ADDRESSES.lender,
      });
      assert.equal(qNoAtt.body.accepted, false);
      assert.ok(qNoAtt.body.rejection_reasons.some((r) => r.code === 'BORROWER_INELIGIBLE'));

      const attSignerAccount = privateKeyToAccount(KEYS.attestationSigner);
      const latestBlkAtt = await publicClient.getBlock();
      const attExpiry = latestBlkAtt.timestamp + 3600n;
      const attTypeHash = keccak256(
        Buffer.from('Attestation(uint256 chainId,address gate,address account,uint256 nonce,uint256 expiry)')
      );
      const attStructHash = keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'address' },
            { type: 'address' },
            { type: 'uint256' },
            { type: 'uint256' },
          ],
          [attTypeHash, 8453n, deployed.eligibilityGate, attestedAccount.address, 0n, attExpiry]
        )
      );
      const attSig = await attSignerAccount.signMessage({ message: { raw: attStructHash } });
      const encodedAttestation = encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'bytes' }],
        [attExpiry, attSig]
      );

      const qWithAtt = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: nvdac,
        principal: '500000000',
        term_days: 14,
        apr_bps: 950,
        borrower: attestedAccount.address,
        lender: ADDRESSES.lender,
        borrower_attestation: encodedAttestation,
      });
      assert.equal(
        qWithAtt.body.accepted,
        true,
        `Valid attested user quote must be accepted: ${JSON.stringify(qWithAtt.body.rejection_reasons)}`
      );
      await signAndFillBorrowOrder({
        takerClient: lenderClient,
        signerAccount: attestedAccount,
        collateralToken: nvdac,
        collateralAmount: BigInt(qWithAtt.body.amounts.collateral_required.raw),
        usdcPrincipal: 500_000_000n,
        rateBps: 950,
        termDays: 14,
        maxLtvBps: qWithAtt.body.asset.allowed_ltv_bps,
        nonce: 0n,
        borrowerAttestation: encodedAttestation,
      });

      // 6c: Cap rejections & uint128 overflow
      const qPerLoan = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: nvdac,
        principal: '1600000000',
        term_days: 14,
        apr_bps: 1000,
      });
      assert.equal(qPerLoan.body.accepted, false);
      assert.ok(qPerLoan.body.rejection_reasons.some((r) => r.code === 'PER_LOAN_CAP_EXCEEDED'));

      // NVDAc has $600 + $500 = $1,100 outstanding; $950 <= $1,500 perLoanCap, $1,100 + $950 > $2,000 assetCap
      const qAssetCap = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: nvdac,
        principal: '950000000',
        term_days: 14,
        apr_bps: 1000,
      });
      assert.equal(qAssetCap.body.accepted, false);
      assert.ok(qAssetCap.body.rejection_reasons.some((r) => r.code === 'ASSET_CAP_EXCEEDED'));

      // METAc has $1,250 outstanding vs $3,000 assetCap; total global outstanding = $2,350 vs $2,600 globalCap
      const qGlobalCap = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: metac,
        principal: '600000000',
        term_days: 14,
        apr_bps: 1000,
      });
      assert.equal(qGlobalCap.body.accepted, false);
      assert.ok(qGlobalCap.body.rejection_reasons.some((r) => r.code === 'GLOBAL_CAP_EXCEEDED'));

      // uint128 overflow via decimal string -> clear rejection, no 500
      const qUint128 = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: nvdac,
        principal: ((1n << 128n) + 1n).toString(),
        term_days: 14,
        apr_bps: 950,
      });
      assert.equal(qUint128.status, 200);
      assert.equal(qUint128.body.accepted, false);
      assert.ok(qUint128.body.rejection_reasons.some((r) => r.code === 'PRINCIPAL_EXCEEDS_UINT128_MAX'));

      // 6d: Extension (< 7 days allowed when existing_elapsed_days > 0) vs new loan (< 7 days rejected)
      const qExtendShort = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: metac,
        collateral_amount: (10n * 10n ** 18n).toString(),
        principal: '200000000',
        term_days: 3,
        existing_elapsed_days: 10, // total 13 <= 90: valid extend term
        apr_bps: 1000,
      });
      assert.ok(
        !qExtendShort.body.rejection_reasons.some((r) => r.code === 'TERM_OUT_OF_RANGE'),
        'Extensions (<7d) must NOT trigger 7-day minimum loan term error'
      );

      // BELOW_MIN_BUY_USDC is warning only (openLoan does not check it)
      const qSubMinBuy = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: nvdac,
        collateral_amount: (10n * 10n ** 18n).toString(),
        principal: '5000000', // $5 < $10 MIN_BUY_USDC and < $500 LOAN_MIN_PRINCIPAL
        term_days: 3, // new loan (<7d)
        apr_bps: 4500, // >40%
        borrower: ADDRESSES.treasury,
      });
      assert.equal(qSubMinBuy.body.accepted, false);
      const subCodes = new Set(qSubMinBuy.body.rejection_reasons.map((r) => r.code));
      assert.ok(subCodes.has('PRINCIPAL_BELOW_MINIMUM'));
      assert.ok(!subCodes.has('BELOW_MIN_BUY_USDC'), 'BELOW_MIN_BUY_USDC must be a warning, not a rejection');
      assert.ok(qSubMinBuy.body.warnings.some((w) => w.code === 'BELOW_MIN_BUY_USDC'));
      assert.ok(subCodes.has('TERM_OUT_OF_RANGE'));
      assert.ok(subCodes.has('APR_EXCEEDS_MAX'));
      assert.ok(subCodes.has('BORROWER_INELIGIBLE'));

      const qUnsupported = await postJson<QuoteResponse>(`${baseUrl}/quote`, {
        asset: ADDRESSES.treasury,
        principal: '600000000',
        term_days: 14,
        apr_bps: 950,
      });
      assert.equal(qUnsupported.status, 200);
      assert.equal(qUnsupported.body.accepted, false);
      assert.equal(qUnsupported.body.asset.status, null);
      assert.equal(qUnsupported.body.asset.status_name, 'Unsupported');
      assert.ok(qUnsupported.body.rejection_reasons.some((r) => r.code === 'ASSET_NOT_SUPPORTED'));

      console.log('PASS TEST 6: Eligibility parity, caps, uint128 bounds, extend terms, unsupported status, and warning separation verified.');

      // TEST 7: POST /orders off-chain signed orderbook relay + GET /orders live merge + security headers
      console.log('\n=== TEST 7: POST /orders relay + GET /orders live state merge + security headers ===');
      const secHeadersRes = await fetch(`${baseUrl}/health`);
      assert.ok(secHeadersRes.headers.get('content-security-policy'));
      assert.equal(secHeadersRes.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(secHeadersRes.headers.get('x-frame-options'), 'DENY');
      assert.equal(secHeadersRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');

      const signerBorrower = privateKeyToAccount(KEYS.borrower);
      const signerLender = privateKeyToAccount(KEYS.lender);
      const latestBlkRelay = await publicClient.getBlock();
      const borrowNonceNow = await publicClient.readContract({
        address: deployed.orderSettlement,
        abi: parseAbi(['function getMakerNonce(address) view returns (uint256)']),
        functionName: 'getMakerNonce',
        args: [ADDRESSES.borrower],
      });
      const lenderNonceNow = await publicClient.readContract({
        address: deployed.orderSettlement,
        abi: parseAbi(['function getMakerNonce(address) view returns (uint256)']),
        functionName: 'getMakerNonce',
        args: [ADDRESSES.lender],
      });
      // Ensure borrower has ample NVDAc balance & CollateralEscrow allowance and lender has ample USDC & LoanCore allowance
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [ADDRESSES.borrower, 30n * 10n ** 18n],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: nvdac,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.collateralEscrow, 50n * 10n ** 18n],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: BASE_USDC_WHALE,
          to: BASE_USDC,
          data: encodeFunctionData({ abi: transferUsdcAbi, functionName: 'transfer', args: [ADDRESSES.lender, 5_000_000_000n] }),
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

      const borrowOrderRelay = {
        borrower: ADDRESSES.borrower,
        collateralToken: nvdac,
        collateralAmount: (12n * 10n ** 18n).toString(),
        minUsdc: '800000000',
        maxRateBps: 900,
        termDays: 30,
        maxLtvBps: 6000,
        minFill: '500000000',
        expiry: (latestBlkRelay.timestamp + 3600n).toString(),
        nonce: borrowNonceNow.toString(),
        yieldMode: 0,
        allowInKindSettlement: false,
      };
      const borrowRelaySig = await signerBorrower.signTypedData({
        domain: {
          name: 'NOSTOK Order Settlement',
          version: '1',
          chainId: 8453,
          verifyingContract: deployed.orderSettlement,
        },
        types: {
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
        },
        primaryType: 'BorrowOrder',
        message: {
          ...borrowOrderRelay,
          collateralAmount: BigInt(borrowOrderRelay.collateralAmount),
          minUsdc: BigInt(borrowOrderRelay.minUsdc),
          minFill: BigInt(borrowOrderRelay.minFill),
          expiry: BigInt(borrowOrderRelay.expiry),
          nonce: BigInt(borrowOrderRelay.nonce),
        },
      });

      // Invalid signature rejected with 400 INVALID_ORDER_SIGNATURE
      const badSigPost = await postJson<{ error: { code: string } }>(`${baseUrl}/orders`, {
        order_type: 'borrow',
        order: borrowOrderRelay,
        signature: '0x' + '11'.repeat(65),
      });
      assert.equal(badSigPost.status, 400);
      assert.equal(badSigPost.body.error.code, 'INVALID_ORDER_SIGNATURE');

      // Valid signed BorrowOrder accepted (201) & visible in GET /orders
      const postBorrowRes = await postJson<{
        order_hash: string;
        status: string;
        order_type: string;
        signature: string;
      }>(`${baseUrl}/orders`, {
        order_type: 'borrow',
        order: borrowOrderRelay,
        signature: borrowRelaySig,
      });
      assert.equal(postBorrowRes.status, 201);
      assert.equal(postBorrowRes.body.status, 'open');
      assert.equal(postBorrowRes.body.order_type, 'borrow');

      // Valid signed LendOffer accepted (201) & visible in GET /orders?order_type=lend
      const lendOfferRelay = {
        lender: ADDRESSES.lender,
        usdcAmount: '1000000000',
        minRateBps: 850,
        termDays: 30,
        allowedCollateral: nvdac,
        maxLtvBps: 6000,
        minFill: '500000000',
        expiry: (latestBlkRelay.timestamp + 3600n).toString(),
        nonce: lenderNonceNow.toString(),
        yieldMode: 0,
      };
      const lendRelaySig = await signerLender.signTypedData({
        domain: {
          name: 'NOSTOK Order Settlement',
          version: '1',
          chainId: 8453,
          verifyingContract: deployed.orderSettlement,
        },
        types: {
          LendOffer: [
            { name: 'lender', type: 'address' },
            { name: 'usdcAmount', type: 'uint128' },
            { name: 'minRateBps', type: 'uint32' },
            { name: 'termDays', type: 'uint16' },
            { name: 'allowedCollateral', type: 'address' },
            { name: 'maxLtvBps', type: 'uint16' },
            { name: 'minFill', type: 'uint128' },
            { name: 'expiry', type: 'uint64' },
            { name: 'nonce', type: 'uint256' },
            { name: 'yieldMode', type: 'uint8' },
          ],
        },
        primaryType: 'LendOffer',
        message: {
          ...lendOfferRelay,
          usdcAmount: BigInt(lendOfferRelay.usdcAmount),
          minFill: BigInt(lendOfferRelay.minFill),
          expiry: BigInt(lendOfferRelay.expiry),
          nonce: BigInt(lendOfferRelay.nonce),
        },
      });
      const postLendRes = await postJson<{ order_hash: string; status: string }>(`${baseUrl}/orders`, {
        order_type: 'lend',
        order: lendOfferRelay,
        signature: lendRelaySig,
      });
      assert.equal(postLendRes.status, 201);

      const getLendsRes = await getJson<{
        pagination: { total: number };
        data: Array<{ order_hash: string; status: string; signature?: string }>;
      }>(`${baseUrl}/orders?order_type=lend`);
      assert.equal(getLendsRes.status, 200);
      assert.ok(getLendsRes.body.data.some((o) => o.order_hash === postLendRes.body.order_hash && o.signature === lendRelaySig));

      // After borrower bumpNonce() on-chain, open relay order moves out of public open book and shows nonce_bumped when include_inactive=true
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: deployed.orderSettlement,
          abi: parseAbi(['function bumpNonce() returns (uint256)']),
          functionName: 'bumpNonce',
        }),
      });
      const inactiveOrders = await getJson<{
        data: Array<{ order_hash: string; status: string }>;
      }>(`${baseUrl}/orders?maker=${ADDRESSES.borrower}&include_inactive=true`);
      const bumpedEntry = inactiveOrders.body.data.find((o) => o.order_hash === postBorrowRes.body.order_hash);
      assert.ok(bumpedEntry);
      assert.equal(bumpedEntry.status, 'nonce_bumped');

      // Item 3: Validation bounds, AssetRegistry check, symbol sanitization, maker/IP/capacity anti-spam & Item 1: 2000-order multicall GET benchmark
      const signBorrowForTest = async (
        acct: ReturnType<typeof privateKeyToAccount>,
        overrides: Partial<typeof borrowOrderRelay>
      ) => {
        const ord = { ...borrowOrderRelay, borrower: acct.address, ...overrides };
        const sig = await acct.signTypedData({
          domain: {
            name: 'NOSTOK Order Settlement',
            version: '1',
            chainId: 8453,
            verifyingContract: deployed.orderSettlement,
          },
          types: {
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
          },
          primaryType: 'BorrowOrder',
          message: {
            ...ord,
            collateralAmount: BigInt(ord.collateralAmount),
            minUsdc: BigInt(ord.minUsdc),
            minFill: BigInt(ord.minFill),
            expiry: BigInt(ord.expiry),
            nonce: BigInt(ord.nonce),
          },
        });
        return { ord, sig };
      };

      const spamSigner1 = privateKeyToAccount(generatePrivateKey());
      const spamSigner1Wallet = createWalletClient({
        account: spamSigner1,
        chain: forkChain,
        transport: viemHttp(LOCAL_RPC_URL),
      });
      await rpcCall('anvil_setBalance', [spamSigner1.address, '0x56bc75e2d63100000']);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [spamSigner1.address, 50n * 10n ** 18n],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await spamSigner1Wallet.writeContract({
          address: nvdac,
          abi: approveAbi,
          functionName: 'approve',
          args: [deployed.collateralEscrow, 50n * 10n ** 18n],
        }),
      });

      // Validation bounds rejected (rate > 4000, term < 7 / > 90, minUsdc < $500, >30d / 10-year expiry)
      for (const badField of [
        { maxRateBps: 100000 },
        { termDays: 3650 },
        { termDays: 3 },
        { minUsdc: '100000000', minFill: '100000000' },
        { expiry: (latestBlkRelay.timestamp + 10n * 365n * 86_400n).toString() },
      ]) {
        const resBad = await postJson<{ error: { code: string } }>(`${baseUrl}/orders`, {
          order_type: 'borrow',
          order: { ...borrowOrderRelay, borrower: spamSigner1.address, nonce: '0', ...badField },
          signature: borrowRelaySig,
        });
        assert.equal(resBad.status, 400, `Out-of-range order payload ${JSON.stringify(badField)} must return 400`);
        assert.equal(resBad.body.error.code, 'VALIDATION_ERROR');
      }

      // 31-day expiry exceeds on-chain 30-day cap for BOTH BorrowOrder and LendOffer (400 ORDER_EXPIRY_TOO_FAR)
      const tooFarBorrow = await signBorrowForTest(spamSigner1, {
        expiry: (latestBlkRelay.timestamp + 31n * 86_400n).toString(),
        nonce: '0',
      });
      const tooFarBorrowRes = await postJson<{ error: { code: string } }>(`${baseUrl}/orders`, {
        order_type: 'borrow',
        order: tooFarBorrow.ord,
        signature: tooFarBorrow.sig,
      });
      assert.equal(tooFarBorrowRes.status, 400);
      assert.equal(tooFarBorrowRes.body.error.code, 'ORDER_EXPIRY_TOO_FAR');

      const tooFarLendOrd = {
        ...lendOfferRelay,
        expiry: (latestBlkRelay.timestamp + 31n * 86_400n).toString(),
      };
      const tooFarLendSig = await signerLender.signTypedData({
        domain: {
          name: 'NOSTOK Order Settlement',
          version: '1',
          chainId: 8453,
          verifyingContract: deployed.orderSettlement,
        },
        types: {
          LendOffer: [
            { name: 'lender', type: 'address' },
            { name: 'usdcAmount', type: 'uint128' },
            { name: 'minRateBps', type: 'uint32' },
            { name: 'termDays', type: 'uint16' },
            { name: 'allowedCollateral', type: 'address' },
            { name: 'maxLtvBps', type: 'uint16' },
            { name: 'minFill', type: 'uint128' },
            { name: 'expiry', type: 'uint64' },
            { name: 'nonce', type: 'uint256' },
            { name: 'yieldMode', type: 'uint8' },
          ],
        },
        primaryType: 'LendOffer',
        message: {
          ...tooFarLendOrd,
          usdcAmount: BigInt(tooFarLendOrd.usdcAmount),
          minFill: BigInt(tooFarLendOrd.minFill),
          expiry: BigInt(tooFarLendOrd.expiry),
          nonce: BigInt(tooFarLendOrd.nonce),
        },
      });
      const tooFarLendRes = await postJson<{ error: { code: string } }>(`${baseUrl}/orders`, {
        order_type: 'lend',
        order: tooFarLendOrd,
        signature: tooFarLendSig,
      });
      assert.equal(tooFarLendRes.status, 400);
      assert.equal(tooFarLendRes.body.error.code, 'ORDER_EXPIRY_TOO_FAR');

      // Item 1: Unfunded free-key BorrowOrders and LendOffers rejected (0 balance OR 0 spender allowance)
      const unfundedKey = privateKeyToAccount(generatePrivateKey());
      const unfundedBorrow = await signBorrowForTest(unfundedKey, { nonce: '0' });
      const unfundedBorrowRes = await postJson<{ error: { code: string } }>(`${baseUrl}/orders`, {
        order_type: 'borrow',
        order: unfundedBorrow.ord,
        signature: unfundedBorrow.sig,
      });
      assert.equal(unfundedBorrowRes.status, 400);
      assert.equal(unfundedBorrowRes.body.error.code, 'INSUFFICIENT_ORDER_FUNDING');

      // Collateral held cleanly on wallet, but CollateralEscrow allowance = 0 -> rejected!
      const noAllowAcct = privateKeyToAccount(generatePrivateKey());
      const noAllowWallet = createWalletClient({
        account: noAllowAcct,
        chain: forkChain,
        transport: viemHttp(LOCAL_RPC_URL),
      });
      await rpcCall('anvil_setBalance', [noAllowAcct.address, '0x56bc75e2d63100000']);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [noAllowAcct.address, 20n * 10n ** 18n],
        }),
      });
      const noAllowBorrow = await signBorrowForTest(noAllowAcct, { nonce: '0' });
      const noAllowBorrowRes = await postJson<{ error: { code: string } }>(`${baseUrl}/orders`, {
        order_type: 'borrow',
        order: noAllowBorrow.ord,
        signature: noAllowBorrow.sig,
      });
      assert.equal(noAllowBorrowRes.status, 400);
      assert.equal(noAllowBorrowRes.body.error.code, 'INSUFFICIENT_ORDER_FUNDING');

      // Unfunded LendOffer (0 USDC / 0 LoanCore allowance) rejected
      const noAllowLendAcct = privateKeyToAccount(generatePrivateKey());
      const noAllowLendWallet = createWalletClient({
        account: noAllowLendAcct,
        chain: forkChain,
        transport: viemHttp(LOCAL_RPC_URL),
      });
      await rpcCall('anvil_setBalance', [noAllowLendAcct.address, '0x56bc75e2d63100000']);
      const signLendForTest = async (
        acct: ReturnType<typeof privateKeyToAccount>,
        overrides: Partial<typeof lendOfferRelay> = {}
      ) => {
        const ord = { ...lendOfferRelay, lender: acct.address, nonce: '0', ...overrides };
        const sig = await acct.signTypedData({
          domain: {
            name: 'NOSTOK Order Settlement',
            version: '1',
            chainId: 8453,
            verifyingContract: deployed.orderSettlement,
          },
          types: {
            LendOffer: [
              { name: 'lender', type: 'address' },
              { name: 'usdcAmount', type: 'uint128' },
              { name: 'minRateBps', type: 'uint32' },
              { name: 'termDays', type: 'uint16' },
              { name: 'allowedCollateral', type: 'address' },
              { name: 'maxLtvBps', type: 'uint16' },
              { name: 'minFill', type: 'uint128' },
              { name: 'expiry', type: 'uint64' },
              { name: 'nonce', type: 'uint256' },
              { name: 'yieldMode', type: 'uint8' },
            ],
          },
          primaryType: 'LendOffer',
          message: {
            ...ord,
            usdcAmount: BigInt(ord.usdcAmount),
            minFill: BigInt(ord.minFill),
            expiry: BigInt(ord.expiry),
            nonce: BigInt(ord.nonce),
          },
        });
        return { ord, sig };
      };
      const zeroUsdcLend = await signLendForTest(noAllowLendAcct);
      const zeroUsdcLendRes = await postJson<{ error: { code: string } }>(`${baseUrl}/orders`, {
        order_type: 'lend',
        order: zeroUsdcLend.ord,
        signature: zeroUsdcLend.sig,
      });
      assert.equal(zeroUsdcLendRes.status, 400);
      assert.equal(zeroUsdcLendRes.body.error.code, 'INSUFFICIENT_ORDER_FUNDING');

      // Fund USDC balance but leave LoanCore allowance at 0 -> still rejected!
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: BASE_USDC_WHALE,
          to: BASE_USDC,
          data: encodeFunctionData({ abi: transferUsdcAbi, functionName: 'transfer', args: [noAllowLendAcct.address, 2_000_000_000n] }),
        }),
      });
      const noLoanAllowLendRes = await postJson<{ error: { code: string } }>(`${baseUrl}/orders`, {
        order_type: 'lend',
        order: zeroUsdcLend.ord,
        signature: zeroUsdcLend.sig,
      });
      assert.equal(noLoanAllowLendRes.status, 400);
      assert.equal(noLoanAllowLendRes.body.error.code, 'INSUFFICIENT_ORDER_FUNDING');

      // Unregistered collateral rejected before storing
      const badAsset = await signBorrowForTest(spamSigner1, { collateralToken: ADDRESSES.treasury, nonce: '0' });
      const badAssetRes = await postJson<{ error: { code: string } }>(`${baseUrl}/orders`, {
        order_type: 'borrow',
        order: badAsset.ord,
        signature: badAsset.sig,
      });
      assert.equal(badAssetRes.status, 400);
      assert.equal(badAssetRes.body.error.code, 'UNSUPPORTED_COLLATERAL_ASSET');

      // maxLtvBps > asset maxInitLtvBps and minUsdc > perLoanCap rejected
      const badLtv = await signBorrowForTest(spamSigner1, { maxLtvBps: 8500, nonce: '0' });
      const badLtvRes = await postJson<{ error: { code: string } }>(`${baseUrl}/orders`, {
        order_type: 'borrow',
        order: badLtv.ord,
        signature: badLtv.sig,
      });
      assert.equal(badLtvRes.status, 400);
      assert.equal(badLtvRes.body.error.code, 'LTV_EXCEEDS_ASSET_MAX');

      const badCap = await signBorrowForTest(spamSigner1, { minUsdc: '4000000000', nonce: '0' });
      const badCapRes = await postJson<{ error: { code: string } }>(`${baseUrl}/orders`, {
        order_type: 'borrow',
        order: badCap.ord,
        signature: badCap.sig,
      });
      assert.equal(badCapRes.status, 400);
      assert.equal(badCapRes.body.error.code, 'PER_LOAN_CAP_EXCEEDED');

      // Symbol sanitization strips >16 chars and HTML/XSS payloads
      assert.equal(sanitizeTokenSymbol(`<img src=x onerror="alert(1)">${'A'.repeat(520)}`), null);
      assert.equal(sanitizeTokenSymbol('TOOLONGSYMBOLNAME17'), null);
      assert.equal(sanitizeTokenSymbol('NVDAc'), 'NVDAc');

      // Anti-spam caps, refresh funding recheck, stale flag on RPC failure, unfunded/near-expiry eviction & 2000-order GET benchmark
      let multicallCount = 0;
      let directReadCount = 0;
      let failRelayMulticall = false;
      let mockSynthFunded = false;
      const instrumentedClient = new Proxy(apiCtx.publicClient, {
        get(target, prop, receiver) {
          if (prop === 'multicall') {
            return async (opts: { contracts: Array<{ functionName: string; args?: unknown[] }> }) => {
              multicallCount += 1;
              if (failRelayMulticall) {
                throw new Error('Injected multicall RPC failure');
              }
              if (
                mockSynthFunded &&
                Array.isArray(opts?.contracts) &&
                opts.contracts.some((c) => {
                  const a0 = String(c?.args?.[0] ?? '').toLowerCase();
                  return a0.startsWith('0x000000000000000000000000');
                })
              ) {
                const isSyntheticCall = (c: { functionName: string; args?: unknown[] }) => {
                  if (
                    c.functionName !== 'isOrderCancelled' &&
                    c.functionName !== 'getOrderFilledAmount' &&
                    c.functionName !== 'getMakerNonce' &&
                    c.functionName !== 'balanceOf' &&
                    c.functionName !== 'allowance'
                  ) {
                    return false;
                  }
                  const a0 = String(c?.args?.[0] ?? '').toLowerCase();
                  return a0.startsWith('0x000000000000000000000000');
                };
                const realCalls = opts.contracts.filter((c) => !isSyntheticCall(c));
                const realResults =
                  realCalls.length > 0
                    ? ((await (target.multicall as (...a: unknown[]) => Promise<unknown[]>)({
                        ...opts,
                        contracts: realCalls,
                      })) as unknown[])
                    : [];
                let realIdx = 0;
                return opts.contracts.map((c) => {
                  if (!isSyntheticCall(c)) {
                    return realResults[realIdx++];
                  }
                  if (c.functionName === 'isOrderCancelled') return { status: 'success', result: false };
                  if (c.functionName === 'getOrderFilledAmount') return { status: 'success', result: 0n };
                  if (c.functionName === 'getMakerNonce') return { status: 'success', result: 0n };
                  if (c.functionName === 'balanceOf' || c.functionName === 'allowance') {
                    return { status: 'success', result: 500n * 10n ** 18n };
                  }
                  return { status: 'success', result: 0n };
                });
              }
              return (target.multicall as (...a: unknown[]) => unknown)(opts);
            };
          }
          if (prop === 'readContract') {
            return (...args: unknown[]) => {
              directReadCount += 1;
              return (target.readContract as (...a: unknown[]) => unknown)(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const spamSignedMap = new Map<string, RelaySignedOrderRecord>();
      const spamCtx = {
        ...apiCtx,
        publicClient: instrumentedClient,
        signedOrders: spamSignedMap,
        config: {
          ...apiCtx.config,
          trustProxyHops: 1,
          rateLimitMax: 5000,
        },
      };
      const spamServer = createApiServer(spamCtx);
      await new Promise<void>((r) => spamServer.listen(0, '127.0.0.1', r));
      const spamUrl = `http://127.0.0.1:${(spamServer.address() as net.AddressInfo).port}`;
      const sevenDaysExpStr = (latestBlkRelay.timestamp + 7n * 86_400n).toString();
      try {
        // Post one legitimate long-lived 7-day order first from lender
        const legitLend7d = await signLendForTest(signerLender, {
          expiry: sevenDaysExpStr,
          nonce: lenderNonceNow.toString(),
        });
        const legitOrder = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
          order_type: 'lend',
          order: legitLend7d.ord,
          signature: legitLend7d.sig,
        });
        assert.equal(legitOrder.status, 201);
        const legitHashLower = legitOrder.body.order_hash.toLowerCase();

        // Approve, relay, and then REVOKE allowance on both BorrowOrder & LendOffer -> GET /orders refresh hides from open & marks status='unfunded'
        await publicClient.waitForTransactionReceipt({
          hash: await noAllowWallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 20n * 10n ** 18n],
          }),
        });
        const fundedBorrowRes = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: noAllowBorrow.ord,
          signature: noAllowBorrow.sig,
        });
        assert.equal(fundedBorrowRes.status, 201);
        await publicClient.waitForTransactionReceipt({
          hash: await noAllowLendWallet.writeContract({
            address: BASE_USDC,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.loanCore, 2_000_000_000n],
          }),
        });
        const fundedLendRes = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
          order_type: 'lend',
          order: zeroUsdcLend.ord,
          signature: zeroUsdcLend.sig,
        });
        assert.equal(fundedLendRes.status, 201);

        // Revoke CollateralEscrow & LoanCore allowances on-chain -> refresh drops both from open book & marks unfunded
        await publicClient.waitForTransactionReceipt({
          hash: await noAllowWallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 0n],
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await noAllowLendWallet.writeContract({
            address: BASE_USDC,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.loanCore, 0n],
          }),
        });
        const openAfterRevoke = await getJson<{
          stale: boolean;
          data: Array<{ order_hash: string }>;
        }>(`${spamUrl}/orders?limit=20`);
        assert.equal(openAfterRevoke.status, 200);
        assert.equal(openAfterRevoke.body.stale, false);
        assert.ok(!openAfterRevoke.body.data.some((o) => o.order_hash === fundedBorrowRes.body.order_hash));
        assert.ok(!openAfterRevoke.body.data.some((o) => o.order_hash === fundedLendRes.body.order_hash));

        const inactiveBorrowAfterRevoke = await getJson<{
          data: Array<{ order_hash: string; status: string; unfunded: boolean; stale: boolean }>;
        }>(`${spamUrl}/orders?maker=${noAllowAcct.address}&include_inactive=true`);
        const revBorrowRow = inactiveBorrowAfterRevoke.body.data.find((o) => o.order_hash === fundedBorrowRes.body.order_hash);
        assert.equal(revBorrowRow?.status, 'unfunded');
        assert.equal(revBorrowRow?.unfunded, true);

        const inactiveLendAfterRevoke = await getJson<{
          data: Array<{ order_hash: string; status: string; unfunded: boolean }>;
        }>(`${spamUrl}/orders?maker=${noAllowLendAcct.address}&include_inactive=true`);
        const revLendRow = inactiveLendAfterRevoke.body.data.find((o) => o.order_hash === fundedLendRes.body.order_hash);
        assert.equal(revLendRow?.status, 'unfunded');
        assert.equal(revLendRow?.unfunded, true);

        // Item 3 Low: When RPC refresh fails, GET /orders flags top-level stale=true, relay_stale=true & item stale=true
        failRelayMulticall = true;
        // Mine 1 block so cached blockNumber invalidates and triggers refresh attempt
        await rpcCall('evm_mine', []);
        const staleOrdersRes = await getJson<{
          stale: boolean;
          relay_stale: boolean;
          data: Array<{ order_hash: string; stale?: boolean }>;
        }>(`${spamUrl}/orders?limit=5`);
        assert.equal(staleOrdersRes.status, 200);
        assert.equal(staleOrdersRes.body.stale, true, 'GET /orders must flag stale=true when RPC refresh fails');
        assert.equal(staleOrdersRes.body.relay_stale, true);
        assert.equal(staleOrdersRes.body.data[0]?.stale, true);
        failRelayMulticall = false;
        const recoveredOrdersRes = await getJson<{ stale: boolean; relay_stale: boolean }>(`${spamUrl}/orders?limit=5`);
        assert.equal(recoveredOrdersRes.body.stale, false);

        // Clean up revoked entries before cap & collateralization tests
        spamSignedMap.delete(fundedBorrowRes.body.order_hash.toLowerCase());
        spamSignedMap.delete(fundedLendRes.body.order_hash.toLowerCase());

        // Medium (a): 1-wei collateral order rejected at admission (400 ORDER_UNDERCOLLATERALIZED) even when funded & escrow-approved
        const oneWeiAcct = privateKeyToAccount(generatePrivateKey());
        const oneWeiWallet = createWalletClient({
          account: oneWeiAcct,
          chain: forkChain,
          transport: viemHttp(LOCAL_RPC_URL),
        });
        await rpcCall('anvil_setBalance', [oneWeiAcct.address, '0x56bc75e2d63100000']);
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdac,
            abi: mockB20Artifact.abi,
            functionName: 'mint',
            args: [oneWeiAcct.address, 1n],
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await oneWeiWallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 1n],
          }),
        });
        const oneWeiBorrow = await signBorrowForTest(oneWeiAcct, {
          collateralAmount: '1',
          minUsdc: '800000000',
          maxLtvBps: 6000,
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const oneWeiRes = await postJson<{ error: { code: string } }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: oneWeiBorrow.ord,
          signature: oneWeiBorrow.sig,
        });
        assert.equal(oneWeiRes.status, 400);
        assert.equal(oneWeiRes.body.error.code, 'ORDER_UNDERCOLLATERALIZED');

        // Medium (a) refresh: Oracle price drop marks open borrow order unfunded + undercollateralized on GET /orders
        const dropAcct = privateKeyToAccount(generatePrivateKey());
        const dropWallet = createWalletClient({
          account: dropAcct,
          chain: forkChain,
          transport: viemHttp(LOCAL_RPC_URL),
        });
        await rpcCall('anvil_setBalance', [dropAcct.address, '0x56bc75e2d63100000']);
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdac,
            abi: mockB20Artifact.abi,
            functionName: 'mint',
            args: [dropAcct.address, 20n * 10n ** 18n],
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await dropWallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 20n * 10n ** 18n],
          }),
        });
        const borderlineBorrow = await signBorrowForTest(dropAcct, {
          collateralAmount: (12n * 10n ** 18n).toString(),
          minUsdc: '800000000',
          maxLtvBps: 6000,
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const borderlineRes = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: borderlineBorrow.ord,
          signature: borderlineBorrow.sig,
        });
        assert.equal(borderlineRes.status, 201);
        // Drop NVDA price from $140 -> $100 ($1200 collateral * 60% = $720 < $800 minUsdc)
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [100_00000000n],
          }),
        });
        const dropRec = spamSignedMap.get(borderlineRes.body.order_hash.toLowerCase())!;
        dropRec.cachedBlockNumber = 0n;
        dropRec.lastRefreshedAtMs = 0;
        const afterDropDefault = await getJson<{ data: Array<{ order_hash: string }> }>(
          `${spamUrl}/orders?maker=${dropAcct.address}`
        );
        assert.equal(
          afterDropDefault.body.data.length,
          0,
          'Undercollateralized order must drop out of default open GET /orders'
        );
        const afterDropInactive = await getJson<{
          data: Array<{ order_hash: string; status: string; unfunded: boolean; undercollateralized?: boolean }>;
        }>(`${spamUrl}/orders?maker=${dropAcct.address}&include_inactive=true`);
        assert.equal(afterDropInactive.body.data[0]?.status, 'unfunded');
        assert.equal(afterDropInactive.body.data[0]?.unfunded, true);
        assert.equal(afterDropInactive.body.data[0]?.undercollateralized, true);
        // Restore NVDA feed back to $140 and clean up test record
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [140_00000000n],
          }),
        });
        spamSignedMap.delete(borderlineRes.body.order_hash.toLowerCase());

        // Medium (b): Summed maker funding for LendOffers (USDC -> LoanCore) & refresh budget overflow
        const lendSumAcct = privateKeyToAccount(generatePrivateKey());
        const lendSumWallet = createWalletClient({
          account: lendSumAcct,
          chain: forkChain,
          transport: viemHttp(LOCAL_RPC_URL),
        });
        await rpcCall('anvil_setBalance', [lendSumAcct.address, '0x56bc75e2d63100000']);
        await publicClient.waitForTransactionReceipt({
          hash: await rawWalletClient.sendTransaction({
            account: BASE_USDC_WHALE,
            to: BASE_USDC,
            data: encodeFunctionData({
              abi: transferUsdcAbi,
              functionName: 'transfer',
              args: [lendSumAcct.address, 1_500_000_000n],
            }),
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await lendSumWallet.writeContract({
            address: BASE_USDC,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.loanCore, 1_500_000_000n],
          }),
        });
        const lendSum1 = await signLendForTest(lendSumAcct, {
          usdcAmount: '1000000000',
          minRateBps: 851,
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const lendSum1Res = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
          order_type: 'lend',
          order: lendSum1.ord,
          signature: lendSum1.sig,
        });
        assert.equal(lendSum1Res.status, 201);
        const lendSumExceed = await signLendForTest(lendSumAcct, {
          usdcAmount: '600000000',
          minRateBps: 852,
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const lendSumExceedRes = await postJson<{ error: { code: string } }>(`${spamUrl}/orders`, {
          order_type: 'lend',
          order: lendSumExceed.ord,
          signature: lendSumExceed.sig,
        });
        assert.equal(lendSumExceedRes.status, 400);
        assert.equal(lendSumExceedRes.body.error.code, 'INSUFFICIENT_ORDER_FUNDING');
        const lendSum2 = await signLendForTest(lendSumAcct, {
          usdcAmount: '500000000',
          minRateBps: 853,
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const lendSum2Res = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
          order_type: 'lend',
          order: lendSum2.ord,
          signature: lendSum2.sig,
        });
        assert.equal(lendSum2Res.status, 201);
        // Drain $400 USDC so balance = $1,100: covers order #1 ($1,000), NOT #1 + #2 ($1,500) -> #2 becomes unfunded on refresh
        await publicClient.waitForTransactionReceipt({
          hash: await lendSumWallet.writeContract({
            address: BASE_USDC,
            abi: transferUsdcAbi,
            functionName: 'transfer',
            args: [BASE_USDC_WHALE, 400_000_000n],
          }),
        });
        spamSignedMap.get(lendSum1Res.body.order_hash.toLowerCase())!.cachedBlockNumber = 0n;
        spamSignedMap.get(lendSum2Res.body.order_hash.toLowerCase())!.cachedBlockNumber = 0n;
        const lendRefreshRes = await getJson<{
          data: Array<{ order_hash: string; status: string; unfunded: boolean }>;
        }>(`${spamUrl}/orders?maker=${lendSumAcct.address}&include_inactive=true`);
        const rLend1 = lendRefreshRes.body.data.find((d) => d.order_hash.toLowerCase() === lendSum1Res.body.order_hash.toLowerCase());
        const rLend2 = lendRefreshRes.body.data.find((d) => d.order_hash.toLowerCase() === lendSum2Res.body.order_hash.toLowerCase());
        assert.equal(rLend1?.status, 'open');
        assert.equal(rLend1?.unfunded, false);
        assert.equal(rLend2?.status, 'unfunded');
        assert.equal(rLend2?.unfunded, true);
        spamSignedMap.delete(lendSum1Res.body.order_hash.toLowerCase());
        spamSignedMap.delete(lendSum2Res.body.order_hash.toLowerCase());

        // Medium (a)+(b) 2,000-slot fill attack test: 100 wallets x 1 wei NVDAc + 1 wei approval x 20 orders across 40 IPs -> all 2000 rejected; real users still post!
        const spam2kWallets = Array.from({ length: 100 }, () => privateKeyToAccount(generatePrivateKey()));
        await Promise.all(
          spam2kWallets.map((w) => rpcCall('anvil_setBalance', [w.address, '0x1bc16d674ec80000']))
        );
        for (const w of spam2kWallets) {
          await publicClient.waitForTransactionReceipt({
            hash: await deployerClient.writeContract({
              address: nvdac,
              abi: mockB20Artifact.abi,
              functionName: 'mint',
              args: [w.address, 1n],
            }),
          });
        }
        await Promise.all(
          spam2kWallets.map(async (w) => {
            const wc = createWalletClient({
              account: w,
              chain: forkChain,
              transport: viemHttp(LOCAL_RPC_URL),
            });
            const h = await wc.writeContract({
              address: nvdac,
              abi: approveAbi,
              functionName: 'approve',
              args: [deployed.collateralEscrow, 1n],
            });
            await publicClient.waitForTransactionReceipt({ hash: h });
          })
        );
        const signed2kPayloads = await Promise.all(
          spam2kWallets.flatMap((w, wIdx) =>
            Array.from({ length: 20 }, async (_, oIdx) => {
              const { ord, sig } = await signBorrowForTest(w, {
                collateralAmount: '1',
                minUsdc: (800_000_000 + oIdx).toString(),
                maxLtvBps: 6000,
                expiry: sevenDaysExpStr,
                nonce: '0',
              });
              return { ord, sig, ip: `198.51.140.${(wIdx % 40) + 1}` };
            })
          )
        );
        let rejected2kCount = 0;
        for (let b = 0; b < signed2kPayloads.length; b += 100) {
          const chunk = signed2kPayloads.slice(b, b + 100);
          const responses = await Promise.all(
            chunk.map((item) =>
              postJson<{ error?: { code: string } }>(
                `${spamUrl}/orders`,
                { order_type: 'borrow', order: item.ord, signature: item.sig },
                { 'X-Forwarded-For': item.ip }
              )
            )
          );
          for (const resp of responses) {
            assert.equal(resp.status, 400);
            assert.equal(resp.body.error?.code, 'ORDER_UNDERCOLLATERALIZED');
            rejected2kCount += 1;
          }
        }
        assert.equal(rejected2kCount, 2000, 'All 2,000 1-wei fill-attack requests must be rejected with 400');
        assert.equal(spamSignedMap.size, 1, 'Only the legit 7d order remains after 2,000 fill attack requests');

        // Real funded borrower still posts cleanly after 2,000 attack attempts
        const realAfter2kBorrow = await signBorrowForTest(dropAcct, {
          collateralAmount: (12n * 10n ** 18n).toString(),
          minUsdc: '801000000',
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const realAfter2kRes = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: realAfter2kBorrow.ord,
          signature: realAfter2kBorrow.sig,
        });
        assert.equal(realAfter2kRes.status, 201);
        spamSignedMap.delete(realAfter2kRes.body.order_hash.toLowerCase());

        // Medium (b): spamSigner1 holds exact 240 NVDAc (50 existing + 190 minted), covers exact 20 orders * 12 NVDAc -> #1..#20 accepted, #21 rejected 400 INSUFFICIENT_ORDER_FUNDING!
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdac,
            abi: mockB20Artifact.abi,
            functionName: 'mint',
            args: [spamSigner1.address, 190n * 10n ** 18n],
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await spamSigner1Wallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 240n * 10n ** 18n],
          }),
        });
        for (let i = 0; i < 20; i++) {
          const { ord, sig } = await signBorrowForTest(spamSigner1, {
            minUsdc: (600_000_000n + BigInt(i)).toString(),
            expiry: sevenDaysExpStr,
            nonce: '0',
          });
          const resMaker = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
            order_type: 'borrow',
            order: ord,
            signature: sig,
          }, { 'X-Forwarded-For': `198.51.100.${i + 1}` });
          assert.equal(resMaker.status, 201);
        }
        const order21Insufficient = await signBorrowForTest(spamSigner1, {
          minUsdc: '600000020',
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const resOrder21Insufficient = await postJson<{ error: { code: string } }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: order21Insufficient.ord,
          signature: order21Insufficient.sig,
        }, { 'X-Forwarded-For': '198.51.100.21' });
        assert.equal(
          resOrder21Insufficient.status,
          400,
          '21st order must be rejected when maker balance/allowance only covers 20'
        );
        assert.equal(resOrder21Insufficient.body.error.code, 'INSUFFICIENT_ORDER_FUNDING');

        // Top up spamSigner1 to 300 NVDAc & allowance -> orders 21..25 succeed and evict oldest down to 20 per-maker cap!
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdac,
            abi: mockB20Artifact.abi,
            functionName: 'mint',
            args: [spamSigner1.address, 60n * 10n ** 18n],
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await spamSigner1Wallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 300n * 10n ** 18n],
          }),
        });
        for (let i = 20; i < 25; i++) {
          const { ord, sig } = await signBorrowForTest(spamSigner1, {
            minUsdc: (600_000_000n + BigInt(i)).toString(),
            expiry: sevenDaysExpStr,
            nonce: '0',
          });
          const resMaker = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
            order_type: 'borrow',
            order: ord,
            signature: sig,
          }, { 'X-Forwarded-For': `198.51.100.${i + 1}` });
          assert.equal(resMaker.status, 201);
        }
        const signer1Count = Array.from(spamSignedMap.values()).filter(
          (r) => r.maker.toLowerCase() === spamSigner1.address.toLowerCase()
        ).length;
        assert.equal(signer1Count, 20, 'Per-maker active relay cap must bound maker to 20 orders');
        assert.ok(spamSignedMap.has(legitHashLower), 'Maker eviction must NEVER evict another maker valid order');

        // Per-IP cap: seed 50 active funded orders attributed to IP 198.51.110.1, then verify #51 returns 429
        const curBlkCap = await publicClient.getBlock();
        const nearExpStr = (curBlkCap.timestamp + 1800n).toString();
        for (let ipIdx = 0; ipIdx < 50; ipIdx++) {
          const ipHash = ('0x' + (9000 + ipIdx).toString(16).padStart(64, 'b')) as Hex;
          const ipMaker = getAddress('0x' + (5000 + ipIdx).toString(16).padStart(40, '0'));
          spamSignedMap.set(ipHash, {
            orderHash: ipHash,
            orderType: 'borrow',
            maker: ipMaker,
            collateralToken: nvdac,
            collateralSymbol: 'NVDAc',
            collateralDecimals: 18,
            collateralAmount: borrowOrderRelay.collateralAmount,
            totalUsdc: '700000000',
            rateBps: 900,
            termDays: 30,
            maxLtvBps: 6000,
            minFill: '500000000',
            expiry: sevenDaysExpStr,
            nonce: '0',
            yieldMode: 0,
            signature: ('0x' + '22'.repeat(65)) as Hex,
            signedOrder: { ...borrowOrderRelay, borrower: ipMaker, nonce: '0', expiry: sevenDaysExpStr },
            submittedAt: new Date().toISOString(),
            submittedAtMs: Date.now(),
            submittedIp: '198.51.110.1',
            cachedFilled: 0n,
            cachedCancelled: false,
            cachedMakerNonce: 0n,
            cachedMakerBalance: 50n * 10n ** 18n,
            cachedMakerAllowance: 50n * 10n ** 18n,
            cachedFundingChecked: true,
            cachedRpcStale: false,
            cachedStatus: 'open',
            cachedBlockNumber: curBlkCap.number,
            lastRefreshedAtMs: Date.now(),
          });
        }
        const ipTestOrder = await signBorrowForTest(spamSigner1, { minUsdc: '777000000', nonce: '0' });
        const overflowIpRes = await postJson<{ error: { code: string } }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: ipTestOrder.ord,
          signature: ipTestOrder.sig,
        }, { 'X-Forwarded-For': '198.51.110.1' });
        assert.equal(overflowIpRes.status, 429);
        assert.equal(overflowIpRes.body.error.code, 'RATE_LIMIT_EXCEEDED');

        // Fill relay to 2000 entries cleanly (1998 long-lived + 1 unfunded + 1 near-expiry):
        // real funded maker MUST evict unfunded first, then near-expiry, before ever seeing 429!
        let fillIdx = 0;
        while (spamSignedMap.size < 1999) {
          fillIdx += 1;
          const synthHash = ('0xaa' + fillIdx.toString(16).padStart(62, '0')) as Hex;
          const synthMaker = getAddress('0x' + (1000 + fillIdx).toString(16).padStart(40, '0'));
          spamSignedMap.set(synthHash, {
            orderHash: synthHash,
            orderType: 'borrow',
            maker: synthMaker,
            collateralToken: nvdac,
            collateralSymbol: 'NVDAc',
            collateralDecimals: 18,
            collateralAmount: borrowOrderRelay.collateralAmount,
            totalUsdc: '700000000',
            rateBps: 900,
            termDays: 30,
            maxLtvBps: 6000,
            minFill: '500000000',
            expiry: fillIdx === 1 ? nearExpStr : sevenDaysExpStr,
            nonce: '0',
            yieldMode: 0,
            signature: ('0x' + '22'.repeat(65)) as Hex,
            signedOrder: { ...borrowOrderRelay, borrower: synthMaker, nonce: '0', expiry: fillIdx === 1 ? nearExpStr : sevenDaysExpStr },
            submittedAt: new Date().toISOString(),
            submittedAtMs: Date.now(),
            submittedIp: `10.0.${Math.floor(fillIdx / 250)}.${fillIdx % 250}`,
            cachedFilled: 0n,
            cachedCancelled: false,
            cachedMakerNonce: 0n,
            cachedMakerBalance: 50n * 10n ** 18n,
            cachedMakerAllowance: 50n * 10n ** 18n,
            cachedFundingChecked: true,
            cachedRpcStale: false,
            cachedStatus: 'open',
            cachedBlockNumber: curBlkCap.number,
            lastRefreshedAtMs: Date.now(),
          });
        }
        const nearExpHash = ('0xaa' + (1).toString(16).padStart(62, '0')) as Hex;
        const unfundedEvictHash = ('0x' + 'ee'.repeat(32)) as Hex;
        spamSignedMap.set(unfundedEvictHash, {
          orderHash: unfundedEvictHash,
          orderType: 'borrow',
          maker: unfundedKey.address,
          collateralToken: nvdac,
          collateralSymbol: 'NVDAc',
          collateralDecimals: 18,
          collateralAmount: borrowOrderRelay.collateralAmount,
          totalUsdc: '700000000',
          rateBps: 900,
          termDays: 30,
          maxLtvBps: 6000,
          minFill: '500000000',
          expiry: sevenDaysExpStr,
          nonce: '0',
          yieldMode: 0,
          signature: ('0x' + '22'.repeat(65)) as Hex,
          signedOrder: { ...borrowOrderRelay, borrower: unfundedKey.address, nonce: '0', expiry: sevenDaysExpStr },
          submittedAt: new Date().toISOString(),
          submittedAtMs: Date.now(),
          submittedIp: '10.99.99.1',
          cachedFilled: 0n,
          cachedCancelled: false,
          cachedMakerNonce: 0n,
          cachedMakerBalance: 0n,
          cachedMakerAllowance: 0n,
          cachedFundingChecked: true,
          cachedRpcStale: false,
          cachedStatus: 'unfunded',
          cachedBlockNumber: curBlkCap.number,
          lastRefreshedAtMs: Date.now(),
        });
        assert.equal(spamSignedMap.size, 2000);

        // Give noAllowAcct approval again & post funded 7-day order #1 -> must evict unfundedEvictHash and return 201!
        await publicClient.waitForTransactionReceipt({
          hash: await noAllowWallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 20n * 10n ** 18n],
          }),
        });
        const realEvictUnfunded = await signBorrowForTest(noAllowAcct, {
          minUsdc: '711000000',
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const evictUnfundedRes = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: realEvictUnfunded.ord,
          signature: realEvictUnfunded.sig,
        }, { 'X-Forwarded-For': '198.51.120.2' });
        assert.equal(evictUnfundedRes.status, 201, 'Real funded borrower must evict unfunded entry instead of 429');
        assert.ok(!spamSignedMap.has(unfundedEvictHash), 'Unfunded entry must be evicted first');
        assert.ok(spamSignedMap.has(nearExpHash), 'Funded near-expiry entry must survive until unfunded entries are evicted');

        // Post funded 7-day order #2 from a fresh foreign funded maker while map is at 2000 funded entries (with nearExpHash expiring in 30m) -> must evict nearExpHash and return 201!
        mockSynthFunded = true;
        const evictNearAcct = privateKeyToAccount(generatePrivateKey());
        const evictNearWallet = createWalletClient({
          account: evictNearAcct,
          chain: forkChain,
          transport: viemHttp(LOCAL_RPC_URL),
        });
        await rpcCall('anvil_setBalance', [evictNearAcct.address, '0x56bc75e2d63100000']);
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdac,
            abi: mockB20Artifact.abi,
            functionName: 'mint',
            args: [evictNearAcct.address, 20n * 10n ** 18n],
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await evictNearWallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 20n * 10n ** 18n],
          }),
        });
        const realEvictNearExp = await signBorrowForTest(evictNearAcct, {
          minUsdc: '712000000',
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const evictNearExpRes = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: realEvictNearExp.ord,
          signature: realEvictNearExp.sig,
        }, { 'X-Forwarded-For': '198.51.120.3' });
        assert.equal(evictNearExpRes.status, 201, 'Real funded borrower must evict about-to-expire entry instead of 429');
        assert.ok(!spamSignedMap.has(nearExpHash), 'About-to-expire entry must be evicted before returning 429');

        // Now ALL 2000 entries are genuinely funded AND long-lived (7 days) -> another foreign wallet hits 429 ORDERBOOK_CAPACITY_EXCEEDED without evicting legit orders!
        const overflowFundedAcct = privateKeyToAccount(generatePrivateKey());
        const overflowFundedWallet = createWalletClient({
          account: overflowFundedAcct,
          chain: forkChain,
          transport: viemHttp(LOCAL_RPC_URL),
        });
        await rpcCall('anvil_setBalance', [overflowFundedAcct.address, '0x56bc75e2d63100000']);
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdac,
            abi: mockB20Artifact.abi,
            functionName: 'mint',
            args: [overflowFundedAcct.address, 20n * 10n ** 18n],
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await overflowFundedWallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 20n * 10n ** 18n],
          }),
        });
        const overflowFundedOrder = await signBorrowForTest(overflowFundedAcct, {
          minUsdc: '713000000',
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const capRes = await postJson<{ error: { code: string } }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: overflowFundedOrder.ord,
          signature: overflowFundedOrder.sig,
        }, { 'X-Forwarded-For': '198.51.120.5' });
        assert.equal(capRes.status, 429);
        assert.equal(capRes.body.error.code, 'ORDERBOOK_CAPACITY_EXCEEDED');
        assert.ok(spamSignedMap.has(legitHashLower), 'Global capacity limit must reject overflow rather than evicting valid long-lived funded orders');

        // 10 parallel GET /orders?limit=5&offset=75 over 2000 relayed orders: singleflight + 2s cache + multicall + SQL LIMIT/OFFSET
        for (const rec of spamSignedMap.values()) {
          rec.cachedBlockNumber = 0n;
          rec.lastRefreshedAtMs = 0;
        }
        multicallCount = 0;
        directReadCount = 0;
        const t0 = Date.now();
        const parallelGets = await Promise.all(
          Array.from({ length: 10 }, (_, k) =>
            getJson<{
              stale: boolean;
              pagination: { total: number; limit: number; offset: number; has_more: boolean };
              data: Array<{ order_hash: string }>;
            }>(`${spamUrl}/orders?limit=5&offset=75`, { 'X-Forwarded-For': `198.51.130.${k + 1}` })
          )
        );
        const elapsedMs = Date.now() - t0;
        for (const r of parallelGets) {
          assert.equal(r.status, 200);
          assert.equal(r.body.stale, false);
          assert.equal(r.body.data.length, 5);
          assert.ok(r.body.pagination.total >= 2000);
          assert.equal(r.body.pagination.limit, 5);
          assert.equal(r.body.pagination.has_more, true);
        }
        assert.ok(elapsedMs < 10_000, `10 parallel GET /orders?limit=5 took ${elapsedMs}ms (must not hang)`);
        assert.equal(multicallCount, 1, `Singleflight must collapse 10 parallel GETs into 1 multicall, saw ${multicallCount}`);
        assert.equal(directReadCount, 0, 'Batched relay refresh must use multicall instead of per-order readContract calls');

        // Second wave hits 2s live-state cache (0 additional RPC calls) and distinct page offset paginates cleanly
        const secondWave = await getJson<{
          pagination: { total: number; limit: number; offset: number; has_more: boolean };
          data: Array<{ order_hash: string }>;
        }>(`${spamUrl}/orders?limit=5&offset=75`, { 'X-Forwarded-For': '198.51.130.50' });
        assert.equal(secondWave.status, 200);
        assert.equal(multicallCount, 1, '2s TTL cache must avoid re-querying RPC on immediate follow-up GET');
        const page2 = await getJson<{
          pagination: { total: number; limit: number; offset: number; has_more: boolean };
          data: Array<{ order_hash: string }>;
        }>(`${spamUrl}/orders?limit=5&offset=80`, { 'X-Forwarded-For': '198.51.130.51' });
        assert.equal(page2.status, 200);
        assert.equal(page2.body.data.length, 5);
        assert.equal(page2.body.pagination.offset, 80);
        assert.notEqual(page2.body.data[0].order_hash, parallelGets[0].body.data[0].order_hash);

        // Item 1a: Oracle stale -> fresh with > 100 (2000) relay orders keeps last status & flags stale=true, then recovers to open (stale=false),
        // AND cached-unfunded records are re-included in paginated GET refresh so funded recovery returns automatically to open.
        const staleAcct = privateKeyToAccount(generatePrivateKey());
        const staleWallet = createWalletClient({
          account: staleAcct,
          chain: forkChain,
          transport: viemHttp(LOCAL_RPC_URL),
        });
        await rpcCall('anvil_setBalance', [staleAcct.address, '0x56bc75e2d63100000']);
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdac,
            abi: mockB20Artifact.abi,
            functionName: 'mint',
            args: [staleAcct.address, 25n * 10n ** 18n],
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await staleWallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 25n * 10n ** 18n],
          }),
        });
        const snapStale = await rpcCall<string>('evm_snapshot', []);
        const removedSynthKey = '0xaa' + (5).toString(16).padStart(62, '0');
        const removedSynthRec = spamSignedMap.get(removedSynthKey);
        spamSignedMap.delete(removedSynthKey);
        const staleOrder = await signBorrowForTest(staleAcct, {
          collateralAmount: (12n * 10n ** 18n).toString(),
          minUsdc: '800000000',
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const stalePostRes = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: staleOrder.ord,
          signature: staleOrder.sig,
        });
        assert.equal(stalePostRes.status, 201);
        const staleHashLower = stalePostRes.body.order_hash.toLowerCase();
        if (removedSynthRec) spamSignedMap.set(removedSynthKey, removedSynthRec);
        spamSignedMap.delete('0xaa' + (6).toString(16).padStart(62, '0'));
        // Re-verify total > 100 (2000 entries)
        if (removedSynthRec) {
          spamSignedMap.set('0xaa' + (6).toString(16).padStart(62, '0'), {
            ...removedSynthRec,
            orderHash: ('0xaa' + (6).toString(16).padStart(62, '0')) as Hex,
          });
        }
        assert.ok(spamSignedMap.size > 100);

        // Warp clock +25_000s (> maxStaleOpenSecs = 21_600s) -> NVDA feed becomes STALE_FEED
        const preWarpBlk = await publicClient.getBlock();
        await rpcCall('evm_setNextBlockTimestamp', [Number(preWarpBlk.timestamp + 25_000n)]);
        await rpcCall('evm_mine', []);
        const staleRec = spamSignedMap.get(staleHashLower)!;
        staleRec.cachedBlockNumber = 0n;
        staleRec.lastRefreshedAtMs = 0;

        // While STALE_FEED, GET /orders?maker=... MUST keep last status ('open'), NOT mark 'unfunded', and flag stale=true
        const duringStaleRes = await getJson<{
          stale: boolean;
          data: Array<{ order_hash: string; status: string; unfunded: boolean; stale: boolean }>;
        }>(`${spamUrl}/orders?maker=${staleAcct.address}`);
        assert.equal(duringStaleRes.status, 200);
        assert.equal(duringStaleRes.body.stale, true);
        assert.equal(duringStaleRes.body.data.length, 1);
        assert.equal(duringStaleRes.body.data[0].status, 'open');
        assert.equal(duringStaleRes.body.data[0].unfunded, false);
        assert.equal(duringStaleRes.body.data[0].stale, true);

        // Restore fresh NVDA feed price -> GET /orders clears stale=false and keeps status='open'
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [140_00000000n],
          }),
        });
        staleRec.cachedBlockNumber = 0n;
        staleRec.lastRefreshedAtMs = 0;
        const afterFreshRes = await getJson<{
          stale: boolean;
          data: Array<{ order_hash: string; status: string; unfunded: boolean; stale: boolean }>;
        }>(`${spamUrl}/orders?maker=${staleAcct.address}`);
        assert.equal(afterFreshRes.status, 200);
        assert.equal(afterFreshRes.body.stale, false);
        assert.equal(afterFreshRes.body.data[0].status, 'open');
        assert.equal(afterFreshRes.body.data[0].stale, false);

        // Re-include cached-unfunded recovery in unfiltered GET when > 100 relay orders:
        // Drain collateral below 12 NVDAc -> marks unfunded; mint back -> unfiltered GET /orders?limit=5 brings it back to 'open'!
        const drainTarget = privateKeyToAccount(generatePrivateKey()).address;
        await publicClient.waitForTransactionReceipt({
          hash: await staleWallet.writeContract({
            address: nvdac,
            abi: parseAbi(['function transfer(address,uint256) returns (bool)']),
            functionName: 'transfer',
            args: [drainTarget, 20n * 10n ** 18n],
          }),
        });
        staleRec.cachedBlockNumber = 0n;
        staleRec.lastRefreshedAtMs = 0;
        const markedUnfundedGet = await getJson<{
          data: Array<{ order_hash: string; status: string; unfunded: boolean }>;
        }>(`${spamUrl}/orders?maker=${staleAcct.address}&include_inactive=true`);
        assert.equal(markedUnfundedGet.body.data[0]?.status, 'unfunded');
        assert.equal(markedUnfundedGet.body.data[0]?.unfunded, true);

        // Restore balance on-chain; then call UNFILTERED GET /orders?limit=5 (>100 orders in map, staleRec not on page 0..5)
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdac,
            abi: mockB20Artifact.abi,
            functionName: 'mint',
            args: [staleAcct.address, 20n * 10n ** 18n],
          }),
        });
        staleRec.cachedBlockNumber = 0n;
        staleRec.lastRefreshedAtMs = 0;
        const unfilteredRecoveryTrigger = await getJson<{ data: Array<{ order_hash: string }> }>(
          `${spamUrl}/orders?limit=5`,
          { 'X-Forwarded-For': '198.51.135.1' }
        );
        assert.equal(unfilteredRecoveryTrigger.status, 200);
        assert.equal(staleRec.cachedStatus, 'open', 'Unfiltered GET over >100 orders must refresh cached-unfunded slice and recover order to open');
        await rpcCall('evm_revert', [snapStale]);
        spamSignedMap.delete(staleHashLower);

        // Item 1c + 1b: Closed-market haircut shortfall (1.05 * 0.95 = 0.9975) marked fillable_when_market_opens (NOT unfunded, NOT evictable)
        // and capacity eviction re-verifies cached-unfunded candidate in multicall before evicting!
        const snapClosed = await rpcCall<string>('evm_snapshot', []);
        const closedAcct = privateKeyToAccount(generatePrivateKey());
        const closedWallet = createWalletClient({
          account: closedAcct,
          chain: forkChain,
          transport: viemHttp(LOCAL_RPC_URL),
        });
        await rpcCall('anvil_setBalance', [closedAcct.address, '0x56bc75e2d63100000']);
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdac,
            abi: mockB20Artifact.abi,
            functionName: 'mint',
            args: [closedAcct.address, 30n * 10n ** 18n],
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await closedWallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 30n * 10n ** 18n],
          }),
        });
        // UI default +5% buffer: 12.5 NVDAc ($1,750 * 60% = $1,050) for $1,000 minUsdc -> at 5% closed haircut: $997.50 < $1,000
        const uiBufferedSlotKey = '0xaa' + (7).toString(16).padStart(62, '0');
        const savedSlot7 = spamSignedMap.get(uiBufferedSlotKey);
        spamSignedMap.delete(uiBufferedSlotKey);
        const uiDefaultOrd = await signBorrowForTest(closedAcct, {
          collateralAmount: (125n * 10n ** 17n).toString(),
          minUsdc: '1000000000',
          maxLtvBps: 6000,
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const uiPostRes = await postJson<{ order_hash: string }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: uiDefaultOrd.ord,
          signature: uiDefaultOrd.sig,
        });
        assert.equal(uiPostRes.status, 201);
        const uiHashLower = uiPostRes.body.order_hash.toLowerCase();

        // Switch market session to VALID_CLOSED (weekend / closed-market session with 5% haircut)
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
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [140_00000000n],
          }),
        });
        const oracleCheckSat = (await publicClient.readContract({
          address: deployed.oracleRouter,
          abi: parseAbi(['function getPrice(address) view returns (uint256, uint8, uint8)']),
          functionName: 'getPrice',
          args: [nvdac],
        })) as readonly [bigint, number, number];
        assert.equal(Number(oracleCheckSat[2]), 1, 'Expected OracleState.VALID_CLOSED (1) during closed market session');

        const uiRec = spamSignedMap.get(uiHashLower)!;
        uiRec.cachedBlockNumber = 0n;
        uiRec.lastRefreshedAtMs = 0;
        const duringWeekendRes = await getJson<{
          data: Array<{
            order_hash: string;
            status: string;
            unfunded: boolean;
            undercollateralized: boolean;
            fillable_when_market_opens?: boolean;
          }>;
        }>(`${spamUrl}/orders?maker=${closedAcct.address}`);
        assert.equal(duringWeekendRes.status, 200);
        assert.equal(duringWeekendRes.body.data[0]?.status, 'open');
        assert.equal(duringWeekendRes.body.data[0]?.unfunded, false);
        assert.equal(duringWeekendRes.body.data[0]?.undercollateralized, false);
        assert.equal(duringWeekendRes.body.data[0]?.fillable_when_market_opens, true);

        // Even at 2000 capacity, closed-market haircut shortfall order must NOT be evictable
        assert.equal(spamSignedMap.size, 2000);
        const satCapRes = await postJson<{ error: { code: string } }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: overflowFundedOrder.ord,
          signature: overflowFundedOrder.sig,
        }, { 'X-Forwarded-For': '198.51.120.6' });
        assert.equal(satCapRes.status, 429);
        assert.ok(spamSignedMap.has(uiHashLower), 'Closed-market haircut shortfall order must NOT be evicted at capacity');

        // Re-verify cached-unfunded candidate before evicting (Item 1b): mark staleRec's slot recovered BEFORE overflow POST
        await rpcCall('evm_revert', [snapClosed]);
        spamSignedMap.delete(uiHashLower);
        if (savedSlot7) spamSignedMap.set(uiBufferedSlotKey, savedSlot7);

        // Seed closedAcct with a valid order that WAS previously cachedStatus='unfunded' at capacity=2000,
        // while closedAcct ALREADY holds full 30 NVDAc balance+allowance on-chain!
        const snapEvictRecheck = await rpcCall<string>('evm_snapshot', []);
        const savedSlot8 = spamSignedMap.get('0xaa' + (8).toString(16).padStart(62, '0'));
        spamSignedMap.delete('0xaa' + (8).toString(16).padStart(62, '0'));
        await rpcCall('anvil_setBalance', [closedAcct.address, '0x56bc75e2d63100000']);
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdac,
            abi: mockB20Artifact.abi,
            functionName: 'mint',
            args: [closedAcct.address, 25n * 10n ** 18n],
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await closedWallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 25n * 10n ** 18n],
          }),
        });
        const recheckOrd = await signBorrowForTest(closedAcct, {
          collateralAmount: (12n * 10n ** 18n).toString(),
          minUsdc: '800000000',
          expiry: sevenDaysExpStr,
          nonce: '0',
        });
        const recheckHash = await publicClient.readContract({
          address: deployed.orderSettlement,
          abi: orderSettlementAbi,
          functionName: 'hashBorrowOrder',
          args: [{
            borrower: closedAcct.address,
            collateralToken: nvdac,
            collateralAmount: 12n * 10n ** 18n,
            minUsdc: 800_000_000n,
            maxRateBps: 900,
            termDays: 30,
            maxLtvBps: 6000,
            minFill: 500_000_000n,
            expiry: BigInt(sevenDaysExpStr),
            nonce: 0n,
            yieldMode: 0,
            allowInKindSettlement: false,
          }],
        });
        const recheckBlk = await publicClient.getBlock();
        spamSignedMap.set(recheckHash.toLowerCase(), {
          orderHash: recheckHash,
          orderType: 'borrow',
          maker: closedAcct.address,
          collateralToken: nvdac,
          collateralSymbol: 'NVDAc',
          collateralDecimals: 18,
          collateralAmount: (12n * 10n ** 18n).toString(),
          totalUsdc: '800000000',
          rateBps: 900,
          termDays: 30,
          maxLtvBps: 6000,
          minFill: '500000000',
          expiry: sevenDaysExpStr,
          nonce: '0',
          yieldMode: 0,
          signedOrder: recheckOrd.ord as unknown as Record<string, unknown>,
          signature: recheckOrd.sig,
          submittedAt: new Date().toISOString(),
          submittedIp: '198.51.142.1',
          submittedAtMs: Date.now() - 10_000,
          cachedFilled: 0n,
          cachedCancelled: false,
          cachedMakerNonce: 0n,
          cachedMakerBalance: 0n,
          cachedMakerAllowance: 0n,
          cachedFundingChecked: true,
          cachedUndercollateralized: false,
          cachedRpcStale: false,
          cachedStatus: 'unfunded',
          cachedBlockNumber: recheckBlk.number,
          lastRefreshedAtMs: Date.now(),
        });
        assert.equal(spamSignedMap.size, 2000);
        const recheckOverflowRes = await postJson<{ error: { code: string } }>(`${spamUrl}/orders`, {
          order_type: 'borrow',
          order: overflowFundedOrder.ord,
          signature: overflowFundedOrder.sig,
        }, { 'X-Forwarded-For': '198.51.120.7' });
        assert.equal(recheckOverflowRes.status, 429, 'Recovered candidate must NOT be evicted; capacity overflow returns 429');
        assert.ok(spamSignedMap.has(recheckHash.toLowerCase()), 'Live recheck must save recovered cached-unfunded order from eviction');
        assert.equal(spamSignedMap.get(recheckHash.toLowerCase())?.cachedStatus, 'open');
        spamSignedMap.delete(recheckHash.toLowerCase());
        if (savedSlot8) spamSignedMap.set('0xaa' + (8).toString(16).padStart(62, '0'), savedSlot8);
        await rpcCall('evm_revert', [snapEvictRecheck]);

        // Item 3 (Low): 20 parallel POSTs from one maker with funding for strictly ONE order -> ONLY 1 accepted, 19 rejected!
        spamSignedMap.delete('0xaa' + (9).toString(16).padStart(62, '0'));
        spamSignedMap.delete('0xaa' + (10).toString(16).padStart(62, '0'));
        const raceAcct = privateKeyToAccount(generatePrivateKey());
        const raceWallet = createWalletClient({
          account: raceAcct,
          chain: forkChain,
          transport: viemHttp(LOCAL_RPC_URL),
        });
        await rpcCall('anvil_setBalance', [raceAcct.address, '0x56bc75e2d63100000']);
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdac,
            abi: mockB20Artifact.abi,
            functionName: 'mint',
            args: [raceAcct.address, 12n * 10n ** 18n],
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await raceWallet.writeContract({
            address: nvdac,
            abi: approveAbi,
            functionName: 'approve',
            args: [deployed.collateralEscrow, 12n * 10n ** 18n],
          }),
        });
        const raceOrders = await Promise.all(
          Array.from({ length: 20 }, (_, idx) =>
            signBorrowForTest(raceAcct, {
              collateralAmount: (12n * 10n ** 18n).toString(),
              minUsdc: (750_000_000 + idx).toString(),
              expiry: sevenDaysExpStr,
              nonce: '0',
            })
          )
        );
        const raceResponses = await Promise.all(
          raceOrders.map((ro, idx) =>
            postJson<{ order_hash?: string; error?: { code: string } }>(
              `${spamUrl}/orders`,
              { order_type: 'borrow', order: ro.ord, signature: ro.sig },
              { 'X-Forwarded-For': `198.51.145.${idx + 1}` }
            )
          )
        );
        const raceAccepted = raceResponses.filter((r) => r.status === 201);
        const raceRejected = raceResponses.filter(
          (r) => r.status === 400 && r.body.error?.code === 'INSUFFICIENT_ORDER_FUNDING'
        );
        assert.equal(raceAccepted.length, 1, `20 parallel POSTs with single-order funding must accept strictly 1, got ${raceAccepted.length}`);
        assert.equal(raceRejected.length, 19, `20 parallel POSTs must reject 19 with INSUFFICIENT_ORDER_FUNDING, got ${raceRejected.length}`);

        // Repro 1 + Item 3 + Item 4: 190 NVDAc bag cycled across 100 makers posting 2000 exact-min orders ->
        // market closes (VALID_CLOSED) -> unfunded orders marked unfunded & evictable regardless of shortfall flag ->
        // real funded makers still get 201 (not 429), closed-market +5% buffer order returns 201 with fillable_when_market_opens:true,
        // and market reopen + background refresh clears shortfall flags across >100 orders cleanly.
        const snapRepro1 = await rpcCall<string>('evm_snapshot', []);
        const savedMapBackup = new Map(spamSignedMap);
        try {
          spamSignedMap.clear();
          const transferAbi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
          const bagMakers = Array.from({ length: 100 }, () => privateKeyToAccount(generatePrivateKey()));
          const bagAmount = 191n * 10n ** 18n; // 20 orders x 9.55 NVDAc (~$802.20 max borrow @ $140 * 60%) <= 191 NVDAc
          const perOrderColl = 955n * 10n ** 16n; // 9.55 NVDAc (exact min for $800 minUsdc @ $140 * 60% = $802.20, falls to $762.09 on 5% closed haircut)

          await Promise.all(
            bagMakers.map((m) => rpcCall('anvil_setBalance', [m.address, '0x1bc16d674ec80000'])) // 2 ETH each
          );
          // Fund maker 0 with the single 191 NVDAc bag and let all 100 approve CollateralEscrow in batches
          await publicClient.waitForTransactionReceipt({
            hash: await deployerClient.writeContract({
              address: nvdac,
              abi: mockB20Artifact.abi,
              functionName: 'mint',
              args: [bagMakers[0].address, bagAmount],
            }),
          });
          const waitFast = (hash: Hex) =>
            publicClient.waitForTransactionReceipt({ hash, pollingInterval: 25 });
          for (const m of bagMakers) {
            const mWallet = createWalletClient({
              account: m,
              chain: forkChain,
              transport: viemHttp(LOCAL_RPC_URL),
            });
            await waitFast(
              await mWallet.writeContract({
                address: nvdac,
                abi: approveAbi,
                functionName: 'approve',
                args: [deployed.collateralEscrow, bagAmount],
                gas: 120_000n,
              })
            );
          }

          for (let m = 0; m < bagMakers.length; m++) {
            const makerAcct = bagMakers[m];
            const makerIp = `198.51.${170 + Math.floor(m / 2)}.${(m % 2) * 20 + 1}`;
            const mSignedOrders = await Promise.all(
              Array.from({ length: 20 }, (_, idx) =>
                signBorrowForTest(makerAcct, {
                  collateralAmount: perOrderColl.toString(),
                  minUsdc: (800_000_000 + idx).toString(),
                  maxLtvBps: 6000,
                  expiry: sevenDaysExpStr,
                  nonce: '0',
                })
              )
            );
            for (const item of mSignedOrders) {
              const pRes = await postJson<{ order_hash?: string }>(`${spamUrl}/orders`, {
                order_type: 'borrow',
                order: item.ord,
                signature: item.sig,
              }, { 'X-Forwarded-For': makerIp });
              assert.equal(pRes.status, 201, `Bag maker ${m} order must be accepted cleanly while holding bag`);
            }
            if (m < bagMakers.length - 1) {
              const mWallet = createWalletClient({
                account: makerAcct,
                chain: forkChain,
                transport: viemHttp(LOCAL_RPC_URL),
              });
              await waitFast(
                await mWallet.writeContract({
                  address: nvdac,
                  abi: transferAbi,
                  functionName: 'transfer',
                  args: [bagMakers[m + 1].address, bagAmount],
                  gas: 120_000n,
                })
              );
            }
          }
          assert.equal(spamSignedMap.size, 2000, 'Relay must now sit at full 2000-order capacity');

          // Close market (VALID_CLOSED with 5% haircut) and refresh so bagMakers[99]'s 20 orders get closed shortfall flag
          // plus simulate pre-loss shortfall flags on unfunded entries so both cases are exercised
          await waitFast(
            await rawWalletClient.sendTransaction({
              account: deployed.nostokTimelock,
              to: deployed.oracleRouter,
              data: encodeFunctionData({
                abi: parseAbi(['function setMarketSession(bool isOpen, bool isManual)']),
                functionName: 'setMarketSession',
                args: [false, true],
              }),
            })
          );
          await waitFast(
            await deployerClient.writeContract({
              address: nvdaFeed,
              abi: mockAggArtifact.abi,
              functionName: 'setPrice',
              args: [140_00000000n],
            })
          );
          const lastBagMaker = bagMakers[99];
          const lastBagRes = await getJson<{
            data: Array<{ status: string; fillable_when_market_opens?: boolean }>;
          }>(`${spamUrl}/orders?maker=${lastBagMaker.address}`);
          assert.equal(lastBagRes.status, 200);
          assert.equal(lastBagRes.body.data.length, 20);
          assert.ok(
            lastBagRes.body.data.every((o) => o.status === 'open' && o.fillable_when_market_opens === true),
            'Funded last bag holder during closed market must stay open with fillable_when_market_opens:true'
          );

          // Now move the bag away from lastBagMaker to deployer so ALL 2000 orders are unfunded on-chain,
          // including 20 whose cachedClosedHaircutShortfall had just been set to true!
          const lastWallet = createWalletClient({
            account: lastBagMaker,
            chain: forkChain,
            transport: viemHttp(LOCAL_RPC_URL),
          });
          await waitFast(
            await lastWallet.writeContract({
              address: nvdac,
              abi: transferAbi,
              functionName: 'transfer',
              args: [deployerClient.account.address, bagAmount],
              gas: 120_000n,
            })
          );
          // Also mark remaining cached records stale with shortfall flag as observed in Repro 1
          for (const rec of spamSignedMap.values()) {
            rec.cachedClosedHaircutShortfall = true;
            rec.cachedStatus = 'unfunded';
          }
          // Verify GET immediately clears shortfall when unfunded
          const afterLossGet = await getJson<{
            data: Array<{ status: string; unfunded: boolean; fillable_when_market_opens?: boolean }>;
          }>(`${spamUrl}/orders?maker=${lastBagMaker.address}&include_inactive=true`);
          assert.equal(afterLossGet.status, 200);
          assert.ok(
            afterLossGet.body.data.every((o) => o.status === 'unfunded' && o.unfunded && !o.fillable_when_market_opens),
            'Unfunded order must clear fillable_when_market_opens even during VALID_CLOSED'
          );

          // Test BOTH eviction paths during VALID_CLOSED:
          // - 20 entries cachedStatus='unfunded' + cachedClosedHaircutShortfall=true (makers 0..19 evict these)
          // - 1980 entries cachedStatus='open' + cachedClosedHaircutShortfall=true (stale; makers 20..24 trigger probeCandidates)
          // ALL 25 real funded makers MUST get 201 Created (never 429)!
          for (const rec of spamSignedMap.values()) {
            rec.cachedClosedHaircutShortfall = true;
            if (rec.maker.toLowerCase() === lastBagMaker.address.toLowerCase()) {
              rec.cachedStatus = 'unfunded';
            } else {
              rec.cachedStatus = 'open';
              rec.lastRefreshedAtMs = 1;
            }
          }
          const realMakers = Array.from({ length: 25 }, () => privateKeyToAccount(generatePrivateKey()));
          await Promise.all(
            realMakers.map((rm) => rpcCall('anvil_setBalance', [rm.address, '0x1bc16d674ec80000']))
          );
          for (const rm of realMakers) {
            await waitFast(
              await deployerClient.writeContract({
                address: nvdac,
                abi: mockB20Artifact.abi,
                functionName: 'mint',
                args: [rm.address, 20n * 10n ** 18n],
                gas: 120_000n,
              })
            );
            await waitFast(
              await createWalletClient({
                account: rm,
                chain: forkChain,
                transport: viemHttp(LOCAL_RPC_URL),
              }).writeContract({
                address: nvdac,
                abi: approveAbi,
                functionName: 'approve',
                args: [deployed.collateralEscrow, 20n * 10n ** 18n],
                gas: 120_000n,
              })
            );
          }
          // Item 3 (Low): Submit orders with default UI +5% buffer (12.5 NVDAc, minUsdc=$1,000 -> $997.50 under 5% closed haircut)
          // WHILE VALID_CLOSED at full 2000 capacity -> MUST return 201 with fillable_when_market_opens:true!
          for (let i = 0; i < realMakers.length; i++) {
            const rm = realMakers[i];
            const rmSigned = await signBorrowForTest(rm, {
              collateralAmount: (125n * 10n ** 17n).toString(),
              minUsdc: '1000000000',
              maxLtvBps: 6000,
              expiry: sevenDaysExpStr,
              nonce: '0',
            });
            const rmRes = await postJson<{
              order_hash: string;
              fillable_when_market_opens?: boolean;
            }>(`${spamUrl}/orders`, {
              order_type: 'borrow',
              order: rmSigned.ord,
              signature: rmSigned.sig,
            }, { 'X-Forwarded-For': `198.51.195.${i + 1}` });
            assert.equal(rmRes.status, 201, `Real funded maker ${i} must evict unfunded shortfall spam cleanly (got ${rmRes.status})`);
            assert.equal(rmRes.body.fillable_when_market_opens, true, 'Closed-market +5% buffer order must be admitted with fillable_when_market_opens:true');
          }

          // Reopen market (VALID_OPEN) and verify Item 4: runRelayBackgroundRefresh + timer clears shortfall flags
          // across >100 orders (e.g. 150 shortfall-flagged entries) without requiring 8+ manual GET loops!
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
            hash: await deployerClient.writeContract({
              address: nvdaFeed,
              abi: mockAggArtifact.abi,
              functionName: 'setPrice',
              args: [140_00000000n],
            }),
          });
          // Mark 300 entries with stale cachedClosedHaircutShortfall=true and run 2 background refresh passes (250 + remaining)
          const flaggedSubset = Array.from(spamSignedMap.values()).slice(0, 300);
          for (let f = 0; f < flaggedSubset.length; f++) {
            flaggedSubset[f].cachedClosedHaircutShortfall = true;
            flaggedSubset[f].lastRefreshedAtMs = 1000 + f;
          }
          // Also ensure none of the remaining 1700 entries still have cachedClosedHaircutShortfall set so these 300 run first
          for (const rec of Array.from(spamSignedMap.values()).slice(300)) {
            rec.cachedClosedHaircutShortfall = false;
            rec.cachedStatus = 'open';
            rec.cachedOracleStale = false;
          }
          const refreshed1 = await runRelayBackgroundRefresh(spamCtx);
          assert.equal(refreshed1, 250, 'First background refresh pass must handle 250 entries in 1 batch');
          const remainingAfter1 = flaggedSubset.filter((r) => r.cachedClosedHaircutShortfall).length;
          assert.ok(
            remainingAfter1 <= 50,
            `First background refresh pass must clear at least 250 shortfall entries (remaining=${remainingAfter1})`
          );
          const refreshed2 = await runRelayBackgroundRefresh(spamCtx);
          assert.ok(refreshed2 >= remainingAfter1, 'Second background refresh pass must process remaining shortfall entries');
          const stillFlagged = flaggedSubset.filter((r) => r.cachedClosedHaircutShortfall);
          assert.equal(stillFlagged.length, 0, 'Market reopen + background refresh must clear cachedClosedHaircutShortfall across all 300 entries');

          // Also verify timer-driven background refresh in createApiServer (relayBgRefreshIntervalMs)
          flaggedSubset[0].cachedClosedHaircutShortfall = true;
          flaggedSubset[0].lastRefreshedAtMs = 1;
          const timerSrv = createApiServer({ ...spamCtx, relayBgRefreshIntervalMs: 40 });
          await new Promise<void>((r) => timerSrv.listen(0, '127.0.0.1', r));
          try {
            const deadline = Date.now() + 3000;
            while (flaggedSubset[0].cachedClosedHaircutShortfall && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 50));
            }
            assert.equal(flaggedSubset[0].cachedClosedHaircutShortfall, false, 'Server background refresh interval timer must automatically clear reopened shortfall flag');
          } finally {
            await new Promise<void>((r) => timerSrv.close(() => r()));
          }

          // Low 2 (busy maker >1000 final orders): exclude_final=true drops expired/cancelled/nonce_bumped while keeping open & unfunded
          const busyMaker = realMakers[0].address;
          const busySubset = Array.from(spamSignedMap.values()).slice(0, 1102);
          for (let k = 0; k < busySubset.length; k++) {
            const rec = busySubset[k];
            rec.maker = busyMaker;
            rec.orderType = 'borrow';
            rec.collateralToken = nvdac;
            rec.cachedOracleStale = false;
            rec.cachedUndercollateralized = false;
            rec.cachedClosedHaircutShortfall = false;
            rec.cachedFundingChecked = true;
            rec.cachedMakerBalance = 100n * 10n ** 18n;
            rec.cachedMakerAllowance = 100n * 10n ** 18n;
            if (k < 400) {
              rec.expiry = '1'; // expired (final)
              rec.cachedCancelled = false;
              rec.cachedFundingOverBudget = false;
              rec.cachedMakerNonce = BigInt(rec.nonce);
              rec.cachedStatus = 'expired';
            } else if (k < 800) {
              rec.expiry = sevenDaysExpStr;
              rec.cachedCancelled = true; // cancelled (final)
              rec.cachedFundingOverBudget = false;
              rec.cachedMakerNonce = BigInt(rec.nonce);
              rec.cachedStatus = 'cancelled';
            } else if (k < 1100) {
              rec.expiry = sevenDaysExpStr;
              rec.cachedCancelled = false;
              rec.cachedFundingOverBudget = false;
              rec.cachedMakerNonce = BigInt(rec.nonce) + 1n; // nonce_bumped (final)
              rec.cachedStatus = 'nonce_bumped';
            } else if (k === 1100) {
              rec.nonce = '0';
              rec.expiry = sevenDaysExpStr;
              rec.cachedCancelled = false;
              rec.cachedFundingOverBudget = true; // unfunded (non-final!)
              rec.cachedMakerNonce = 0n;
              rec.cachedStatus = 'unfunded';
            } else {
              rec.nonce = '0';
              rec.expiry = sevenDaysExpStr;
              rec.cachedCancelled = false;
              rec.cachedFundingOverBudget = false; // open (non-final!)
              rec.cachedMakerNonce = 0n;
              rec.cachedStatus = 'open';
            }
          }
          const busyAllRes = await getJson<{
            pagination: { total: number; has_more: boolean };
            data: Array<{ status: string }>;
          }>(`${spamUrl}/orders?order_type=borrow&maker=${busyMaker}&include_inactive=true&limit=50`);
          assert.equal(busyAllRes.status, 200);
          assert.ok(busyAllRes.body.pagination.total >= 1102, 'Without exclude_final, maker query exceeds 1000 rows');
          assert.equal(busyAllRes.body.pagination.has_more, true);

          const busyNonFinalRes = await getJson<{
            pagination: { total: number; has_more: boolean };
            data: Array<{ status: string }>;
          }>(
            `${spamUrl}/orders?order_type=borrow&maker=${busyMaker}&include_inactive=true&exclude_final=true&limit=50`
          );
          assert.equal(busyNonFinalRes.status, 200);
          assert.equal(busyNonFinalRes.body.pagination.has_more, false);
          assert.ok(busyNonFinalRes.body.data.length >= 2);
          for (const row of busyNonFinalRes.body.data) {
            assert.ok(
              row.status === 'open' || row.status === 'partially_filled' || row.status === 'unfunded',
              `exclude_final=true must only return non-final statuses (got ${row.status})`
            );
          }

          // Also check SQL DB orders with exclude_final=true on main server: no filled/cancelled rows returned
          const dbNonFinalRes = await getJson<{ data: Array<{ status: string }> }>(
            `${baseUrl}/orders?include_inactive=true&exclude_final=true&limit=50`
          );
          assert.equal(dbNonFinalRes.status, 200);
          for (const row of dbNonFinalRes.body.data) {
            assert.notEqual(row.status, 'filled');
            assert.notEqual(row.status, 'cancelled');
          }

          // WS3.4 Piece 4: exact GET /orders?order_hash=0x... lookup + 400 validation on malformed hash
          const targetRec = busySubset[1101];
          const byHashRes = await getJson<{
            pagination: { total: number };
            data: Array<{ order_hash: string; status: string }>;
          }>(
            `${spamUrl}/orders?order_hash=${encodeURIComponent(targetRec.orderHash)}&include_inactive=true`
          );
          assert.equal(byHashRes.status, 200);
          assert.equal(byHashRes.body.pagination.total, 1);
          assert.equal(byHashRes.body.data.length, 1);
          assert.equal(byHashRes.body.data[0].order_hash.toLowerCase(), targetRec.orderHash.toLowerCase());

          const badHashRes = await getJson<{ error?: { code?: string } }>(`${spamUrl}/orders?order_hash=0x1234`);
          assert.equal(badHashRes.status, 400);
        } finally {
          spamSignedMap.clear();
          for (const [k, v] of savedMapBackup.entries()) spamSignedMap.set(k, v);
          await rpcCall('evm_revert', [snapRepro1]);
        }
      } finally {
        mockSynthFunded = false;
        failRelayMulticall = false;
        await new Promise<void>((r) => spamServer.close(() => r()));
      }

      console.log('PASS TEST 7: POST /orders verification, anti-spam caps, symbol sanitization, 2000-order multicall GET benchmark, bumpNonce sync, and security headers verified.');

      // -----------------------------------------------------------------------
      // TEST 8: L1 Trusted Proxy Origin Verification (TRUSTED_PROXY_CIDRS) & /health geo/sanctions reporting
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 8: L1 TRUSTED_PROXY_CIDRS origin verification & /health reporting ===');
      const testAcct = privateKeyToAccount(KEYS.borrower).address;
      const sanctionedAcct: Address = '0x000000000000000000000000000000000000dEaD';

      // Server A: TRUST_PROXY=1, GEO_REQUIRE_HEADER=true, TRUSTED_PROXY_CIDRS=['10.0.0.0/8'] (127.0.0.1 is UNTRUSTED)
      const untrustedProxyCfg = loadApiConfig({
        ...apiCfg,
        trustProxyHops: 1,
        geoRequireHeader: true,
        geoDisabled: false,
        trustedProxyCidrs: ['10.0.0.0/8'],
        sanctionedAddresses: [sanctionedAcct],
        rateLimitMax: 3,
        rateLimitWindowMs: 60_000,
      });
      const untrustedCtx = await createApiContext(untrustedProxyCfg, wrapQueryableAsReadOnly(idxCtx.db));
      const untrustedServer = createApiServer(untrustedCtx);
      await new Promise<void>((r) => untrustedServer.listen(0, '127.0.0.1', r));
      const untrustedUrl = `http://127.0.0.1:${(untrustedServer.address() as net.AddressInfo).port}`;
      try {
        const hRes = await getJson<{
          geo: { mode: string; enabled: boolean; trusted_proxy_cidrs_count: number };
          sanctions: { mode: string; sanctioned_addresses_count: number };
        }>(`${untrustedUrl}/health`);
        assert.equal(hRes.status, 200);
        assert.equal(hRes.body.geo.mode, 'enforced');
        assert.equal(hRes.body.geo.enabled, true);
        assert.equal(hRes.body.geo.trusted_proxy_cidrs_count, 1);
        assert.equal(hRes.body.sanctions.mode, 'configured');
        assert.equal(hRes.body.sanctions.sanctioned_addresses_count, 1);

        // Req 1: Spoofed cf-ipcountry: CH & X-Forwarded-For from direct peer 127.0.0.1 (outside 10.0.0.0/8) -> GEO_UNTRUSTED_PROXY
        const eligResp = await fetch(`${untrustedUrl}/eligibility?account=${testAcct}`, {
          headers: { 'cf-ipcountry': 'CH', 'X-Forwarded-For': '198.51.100.1' },
        });
        assert.equal(eligResp.status, 200);
        const eligBody = (await eligResp.json()) as {
          allowed: boolean;
          geo: { status: string; reason: string | null };
        };
        assert.equal(eligBody.allowed, false);
        assert.equal(eligBody.geo.status, 'untrusted_proxy');
        assert.equal(eligBody.geo.reason, 'GEO_UNTRUSTED_PROXY');

        // Req 2: Spoofed cf-ipcountry: CH on POST /orders -> 403 GEO_UNTRUSTED_PROXY
        const orderResp = await fetch(`${untrustedUrl}/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-ipcountry': 'CH',
            'X-Forwarded-For': '198.51.100.2',
          },
          body: '{}',
        });
        assert.equal(orderResp.status, 403);
        assert.equal(((await orderResp.json()) as { error: { code: string } }).error.code, 'GEO_UNTRUSTED_PROXY');

        // Req 4: Different spoofed X-Forwarded-For still shares the 127.0.0.1 rate-limit bucket (rateLimitMax=3 -> 429!)
        const rlResp = await fetch(`${untrustedUrl}/orders`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cf-ipcountry': 'CH',
            'X-Forwarded-For': '198.51.100.3',
          },
          body: '{}',
        });
        assert.equal(rlResp.status, 429, 'Spoofed X-Forwarded-For from untrusted peer must NOT bypass rate limiting');
      } finally {
        await new Promise<void>((r) => untrustedServer.close(() => r()));
      }

      // Server B: TRUSTED_PROXY_CIDRS=['127.0.0.1/32'] trusts direct loopback peer -> honors cf-ipcountry & X-Forwarded-For
      const trustedProxyCfg = loadApiConfig({
        ...apiCfg,
        trustProxyHops: 1,
        geoRequireHeader: true,
        geoDisabled: false,
        trustedProxyCidrs: ['127.0.0.1/32'],
        sanctionedAddresses: [sanctionedAcct],
        rateLimitMax: 3,
        rateLimitWindowMs: 60_000,
      });
      const trustedCtx = await createApiContext(trustedProxyCfg, wrapQueryableAsReadOnly(idxCtx.db));
      const trustedServer = createApiServer(trustedCtx);
      await new Promise<void>((r) => trustedServer.listen(0, '127.0.0.1', r));
      const trustedUrl = `http://127.0.0.1:${(trustedServer.address() as net.AddressInfo).port}`;
      try {
        for (const clientIp of ['198.51.100.11', '198.51.100.12', '198.51.100.13']) {
          const okResp = await fetch(`${trustedUrl}/eligibility?account=${testAcct}`, {
            headers: { 'cf-ipcountry': 'CH', 'X-Forwarded-For': clientIp },
          });
          assert.equal(okResp.status, 200);
          const okBody = (await okResp.json()) as { allowed: boolean; geo: { country_code: string | null } };
          assert.equal(okBody.allowed, true);
          assert.equal(okBody.geo.country_code, 'CH');
        }
        // US still blocked from trusted proxy
        const usResp = await fetch(`${trustedUrl}/eligibility?account=${testAcct}`, {
          headers: { 'cf-ipcountry': 'US', 'X-Forwarded-For': '198.51.100.14' },
        });
        const usBody = (await usResp.json()) as { allowed: boolean; geo: { reason: string | null } };
        assert.equal(usBody.allowed, false);
        assert.equal(usBody.geo.reason, 'GEO_RESTRICTED');
      } finally {
        await new Promise<void>((r) => trustedServer.close(() => r()));
      }
      console.log('PASS TEST 8: TRUSTED_PROXY_CIDRS origin enforcement, X-Forwarded-For spoofing defense, & /health verified.');

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
