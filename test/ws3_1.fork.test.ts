import assert from 'node:assert/strict';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
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
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http as viemHttp,
  keccak256,
  parseAbi,
  stringToBytes,
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
  USDC_DECIMALS,
  getFrontendConfig,
  setFrontendConfigOverrides,
} from '../src/lib/contracts.js';
import {
  connectWallet,
  fetchNotificationsSessionState,
  fetchWalletState,
  setInjectedProvider,
  signInWithSiwe,
  signOutSiwe,
} from '../src/lib/web3.js';

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

function createMockEip1193Provider(initialAccountKey: Hex, initialChainId = 8453) {
  let account = privateKeyToAccount(initialAccountKey);
  let chainId = initialChainId;
  let rejectSwitch = false;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    setRejectSwitch(v: boolean) {
      rejectSwitch = v;
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
        return account.signMessage({ message: { raw: msgHex } });
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
      rateLimitMax: 200,
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
        chainId: BASE_CHAIN_ID,
        rpcUrl: LOCAL_RPC_URL,
        apiUrl,
        notificationsUrl: notifUrl,
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

      console.log('\nALL WS3.1 FRONTEND WALLET + SIWE BASE MAINNET FORK TESTS PASSED.');
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
