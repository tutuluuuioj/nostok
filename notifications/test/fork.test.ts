import assert from 'node:assert/strict';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pgPkg from 'pg';
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
import { loadConfig as loadIndexerConfig } from '../../indexer/src/config.js';
import { createIndexerContext, runIndexerSync } from '../../indexer/src/indexer.js';
import { loadRiskConfig } from '../../risk/src/config.js';
import { wrapQueryableAsReadOnly as wrapRiskReadOnly } from '../../risk/src/db.js';
import { createRiskContext, runRiskScan } from '../../risk/src/monitor.js';
import { createRiskServer } from '../../risk/src/server.js';
import {
  type ChannelTransports,
  type DnsLookupFn,
  type NotificationOutboundMessage,
  type WebhookHttpRequestOpts,
  createDefaultTransports,
  defaultWebhookRequester,
  resolveAndValidateWebhookTarget,
  validateChannelTarget,
} from '../src/channels.js';
import { loadNotificationsConfig } from '../src/config.js';
import {
  PiiCipher,
  signBlockSenderToken,
  signConfirmSubscriptionToken,
  verifyBlockSenderToken,
  verifyWebhookPayloadSignature,
} from '../src/crypto.js';
import {
  assertNotifTableSql,
  assertReadOnlySql,
  openReadOnlyIndexerDatabase,
  wrapIndexerQueryableAsReadOnly,
} from '../src/db.js';
import {
  createNotificationsContext,
  processDeliveryQueue,
  runNotificationsCycle,
} from '../src/engine.js';
import { MIN_SYBIL_COST_ETH_WEI, createNotificationsServer } from '../src/server.js';
import { formatSiweMessage } from '../src/siwe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const NOTIF_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(NOTIF_DIR, '..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'contracts');

const FOUNDRY_BIN_DIR = process.env.FOUNDRY_BIN_DIR ?? `${process.env.HOME}/.foundry/bin`;
const ANVIL_PORT = Number(process.env.TEST_NOTIF_ANVIL_PORT ?? 18549);
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
  walletSigner1271: generatePrivateKey(),
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
  walletSigner1271: privateKeyToAccount(KEYS.walletSigner1271).address,
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
    console.log(`[NOTIF_TEST] Starting Anvil fork against ${forkUrl} on port ${ANVIL_PORT}...`);
    const proc = spawn(
      `${FOUNDRY_BIN_DIR}/anvil`,
      ['--fork-url', forkUrl, '--port', String(ANVIL_PORT), '--chain-id', '8453', '--silent'],
      { env: getShellEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await waitForRpcReady(LOCAL_RPC_URL, 25_000);
      console.log('[NOTIF_TEST] Anvil Base Mainnet fork ready (chainId=8453)');
      return proc;
    } catch (err) {
      proc.kill('SIGKILL');
      console.warn(`[NOTIF_TEST] Fork RPC ${forkUrl} failed: ${(err as Error).message}`);
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
  console.log('[NOTIF_TEST] Running DeployNostok.s.sol on local Base Mainnet fork...');
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

async function httpJson<T>(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Headers; body: T }> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as T;
  return { status: res.status, headers: res.headers, body: json };
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
    const lenderAccount = privateKeyToAccount(KEYS.lender);
    const signer1271Account = privateKeyToAccount(KEYS.walletSigner1271);
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
    const smartWalletArtifact = loadFoundryArtifact('MockSmartWallet.sol/MockSmartWallet.json');

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

    const smartWalletReceipt = await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.deployContract({
        abi: smartWalletArtifact.abi,
        bytecode: smartWalletArtifact.bytecode,
        args: [ADDRESSES.walletSigner1271],
      }),
    });
    const smartWalletAddr = getAddress(smartWalletReceipt.contractAddress!);

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
        args: [[ADDRESSES.borrower, ADDRESSES.lender, ADDRESSES.liquidator], true],
      }),
    });

    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.writeContract({
        address: nvdac,
        abi: mockB20Artifact.abi,
        functionName: 'mint',
        args: [ADDRESSES.borrower, 100n * 10n ** 18n],
      }),
    });

    await rpcCall('anvil_impersonateAccount', [BASE_USDC_WHALE]);
    await rpcCall('anvil_setBalance', [BASE_USDC_WHALE, '0x56bc75e2d63100000']);
    const transferUsdcAbi = parseAbi(['function transfer(address to, uint256 value) returns (bool)']);
    for (const [to, amt] of [
      [ADDRESSES.borrower, 5_000_000_000n],
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
      [borrowerClient, nvdac, deployed.collateralEscrow, 500n * 10n ** 18n],
      [borrowerClient, BASE_USDC, deployed.loanCore, 50_000_000_000n],
      [lenderClient, BASE_USDC, deployed.loanCore, 50_000_000_000n],
      [liquidatorClient, BASE_USDC, deployed.liquidationAuction, 50_000_000_000n],
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

    // Boot Indexer + Risk Monitor HTTP server (so WS2.6 consumes live WS2.4 Risk Monitor + Indexer!)
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
      assets: [nvdac],
    });
    const idxCtx = await createIndexerContext(idxCfg);
    await runIndexerSync(idxCtx);

    const riskCfg = loadRiskConfig({
      rpcUrl: LOCAL_RPC_URL,
      isFork: true,
      forkChainId: 8453,
      databaseUrl: 'memory://',
      pollIntervalMs: 1000,
      alertCooldownMs: 60_000,
      alertMinActiveMs: 1_000,
      nearLiqBufferBps: 300,
      maxHealthyLagBlocks: 100,
      maxHealthyLagSecs: 86_400,
      loanCore: deployed.loanCore,
      liquidationAuction: deployed.liquidationAuction,
      collateralEscrow: deployed.collateralEscrow,
      assetRegistry: deployed.assetRegistry,
      oracleRouter: deployed.oracleRouter,
    });
    const riskCtx = await createRiskContext(riskCfg, wrapRiskReadOnly(idxCtx.db));
    await runRiskScan(riskCtx, Date.now());
    const riskServer = createRiskServer(riskCtx);
    await new Promise<void>((r) => riskServer.listen(0, '127.0.0.1', r));
    const riskPort = (riskServer.address() as net.AddressInfo).port;
    const riskApiUrl = `http://127.0.0.1:${riskPort}`;

    // Local Webhook transport receiver server + mocked email/Telegram recorders
    const deliveredEmails: NotificationOutboundMessage[] = [];
    const deliveredTelegrams: NotificationOutboundMessage[] = [];
    const deliveredWebhooks: Array<{
      event: string;
      wallet: string;
      payload: unknown;
      rawBody: string;
      headers: http.IncomingHttpHeaders;
    }> = [];
    let forceFailEmail = false;
    let forceFailWebhook = false;
    let mockWebhookInvokeCount = 0;

    const webhookReceiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(rawBody) as {
          event: string;
          wallet: string;
          payload: unknown;
        };
        deliveredWebhooks.push({ ...parsed, rawBody, headers: req.headers });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => webhookReceiver.listen(0, '127.0.0.1', r));
    const webhookRxPort = (webhookReceiver.address() as net.AddressInfo).port;
    const webhookTargetUrl = 'https://hooks.nostok-test.example/user-hook';

    const mockDnsLookup: DnsLookupFn = async (hostname: string) => {
      const lower = hostname.toLowerCase();
      if (lower === 'hooks.nostok-test.example') {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      if (lower === 'rebind-private.example') {
        return [{ address: '10.0.0.12', family: 4 }];
      }
      if (lower === 'rebind-meta.example') {
        return [{ address: '169.254.169.254', family: 4 }];
      }
      if (lower === 'rebind-ipv6.example') {
        return [{ address: '::1', family: 6 }];
      }
      if (lower === 'dualstack.nostok-test.example') {
        return [
          { address: '2606:4700:4700::1111', family: 6 },
          { address: '93.184.216.34', family: 4 },
        ];
      }
      return [{ address: '93.184.216.35', family: 4 }];
    };

    const key1 = crypto.randomBytes(32).toString('hex');
    const key2 = crypto.randomBytes(32).toString('hex');
    const unsubSecret = crypto.randomBytes(32).toString('hex');
    const confirmSecret = crypto.randomBytes(32).toString('hex');
    const sessionSecret = crypto.randomBytes(32).toString('hex');
    const piiHashSecret = crypto.randomBytes(32).toString('hex');
    const webhookSigningSecret = crypto.randomBytes(32).toString('hex');
    const adminSecret = crypto.randomBytes(32).toString('hex');

    const notifCfg = loadNotificationsConfig({
      rpcUrl: LOCAL_RPC_URL,
      isFork: true,
      forkChainId: 8453,
      databaseUrl: 'memory://',
      indexerDatabaseUrl: 'memory://',
      riskApiUrl,
      siweDomain: 'app.nostok.xyz',
      siweUri: 'https://app.nostok.xyz',
      encryptionKeyId: 'k1',
      encryptionKeys: { k1: key1, k2: key2 },
      unsubscribeSecret: unsubSecret,
      confirmSecret,
      sessionSecret,
      piiHashSecret,
      webhookSigningSecret,
      adminSecret,
      publicBaseUrl: 'http://127.0.0.1:3003',
      corsOrigins: ['https://app.nostok.xyz'],
      maxDeliveryAttempts: 3,
      maxCriticalDeliveryAttempts: 6,
      retryBaseMs: 100,
      sendingLeaseMs: 120_000,
      episodeClearDampingMs: 30_000,
      allowedWebhookPorts: [443],
      userRateLimitPerHour: 200,
      maxSubscriptionsPerWallet: 5,
      maxVerifyAttempts: 5,
      confirmRateLimitMax: 20,
      confirmTargetPerHourMax: 3,
      authNonceRateLimitMax: 100,
      authVerifyRateLimitMax: 100,
      subscriptionsRateLimitMax: 100,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30_000,
      rateLimitMax: 500,
      maxBodyBytes: 4096,
      loanCore: deployed.loanCore,
      liquidationAuction: deployed.liquidationAuction,
      assetRegistry: deployed.assetRegistry,
      oracleRouter: deployed.oracleRouter,
      positionNft: deployed.positionNFT,
    });

    const mockTransports: ChannelTransports = {
      async sendEmail(msg) {
        if (forceFailEmail) {
          throw new Error('502 Mock SMTP gateway timeout secret_internal_trace');
        }
        deliveredEmails.push(msg);
      },
      async sendTelegram(msg) {
        deliveredTelegrams.push(msg);
      },
      async sendWebhook(msg) {
        await resolveAndValidateWebhookTarget(msg.target, mockDnsLookup);
        mockWebhookInvokeCount++;
        if (forceFailWebhook) {
          throw new Error('503 Mock webhook upstream down secret_trace');
        }
        const rawBody = JSON.stringify({
          event: msg.alertType,
          severity: msg.severity,
          wallet: msg.wallet,
          title: msg.title,
          message: msg.message,
          payload: msg.payload,
          unsubscribe_url: msg.unsubscribeUrl,
        });
        const tsSec = msg.timestampSec ?? Math.floor(Date.now() / 1000);
        const { signWebhookPayload } = await import('../src/crypto.js');
        const sig = signWebhookPayload(notifCfg.webhookSigningSecret, tsSec, rawBody);
        const res = await fetch(`http://127.0.0.1:${webhookRxPort}/user-hook`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'Content-Type': 'application/json',
            'X-Nostok-Timestamp': sig.timestampHeader,
            'X-Nostok-Signature': sig.signatureHeader,
          },
          body: rawBody,
          signal: AbortSignal.timeout(notifCfg.outboundTimeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      },
    };

    const notifCtx = await createNotificationsContext(notifCfg, {
      indexerDbOverride: wrapIndexerQueryableAsReadOnly({
        query: (sql, params) => idxCtx.db.query(sql, params),
        async close() {},
      }),
      transportsOverride: mockTransports,
      dnsLookupOverride: mockDnsLookup,
    });

    const notifServer = createNotificationsServer(notifCtx);
    await new Promise<void>((r) => notifServer.listen(0, '127.0.0.1', r));
    const notifPort = (notifServer.address() as net.AddressInfo).port;
    const notifUrl = `http://127.0.0.1:${notifPort}`;
    notifCfg.publicBaseUrl = notifUrl;

    try {
      // -----------------------------------------------------------------------
      // TEST 1: Security boundaries, SQL tokenizer, production config, PII AES-256-GCM + PG drop
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 1: SQL guards, PII AES-256-GCM encryption + key rotation, & real PG drop ===');
      assert.throws(
        () =>
          loadNotificationsConfig({
            ...notifCfg,
            isFork: false,
            databaseUrl: 'memory://',
          }),
        /postgres/i
      );
      const prodBaseOverrides = {
        ...notifCfg,
        isFork: false,
        databaseUrl: 'postgres://nostok_notif:pw@localhost:5432/nostok',
        indexerDatabaseUrl: 'postgres://nostok_ro:pw@localhost:5432/nostok',
        publicBaseUrl: 'https://notifications.nostok.xyz',
      };
      const prevCorsEnv = process.env.CORS_ORIGINS;
      delete process.env.CORS_ORIGINS;
      try {
        assert.throws(
          () =>
            loadNotificationsConfig({
              ...prodBaseOverrides,
              corsOrigins: undefined,
            }),
          /CORS_ORIGINS/i
        );
      } finally {
        if (prevCorsEnv !== undefined) process.env.CORS_ORIGINS = prevCorsEnv;
      }
      assert.throws(
        () =>
          loadNotificationsConfig({
            ...prodBaseOverrides,
            corsOrigins: ['*'],
          }),
        /wildcard/i
      );
      assert.throws(
        () =>
          loadNotificationsConfig({
            ...prodBaseOverrides,
            publicBaseUrl: 'http://notifications.nostok.xyz',
          }),
        /https:\/\//i
      );
      assert.throws(
        () =>
          loadNotificationsConfig({
            ...notifCfg,
            unsubscribeSecret: 'a'.repeat(32),
          }),
        /entropy/i
      );
      assert.throws(
        () =>
          loadNotificationsConfig({
            ...notifCfg,
            sessionSecret: notifCfg.unsubscribeSecret,
          }),
        /distinct/i
      );
      assert.throws(
        () =>
          loadNotificationsConfig({
            ...notifCfg,
            confirmSecret: notifCfg.unsubscribeSecret,
          }),
        /distinct/i
      );
      assert.throws(
        () =>
          loadNotificationsConfig({
            ...notifCfg,
            maxCriticalDeliveryAttempts: 3,
          }),
        /at least 6/i
      );

      assert.throws(() => assertReadOnlySql('DELETE FROM loans'), /SELECT/i);
      assert.throws(() => assertReadOnlySql('SELECT U&"pg\\005fsleep"(2)'), /escaped SQL|backslash/i);
      assert.throws(() => assertReadOnlySql("SELECT E'\\x70'"), /escaped SQL/i);
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

      assert.throws(() => assertNotifTableSql('INSERT INTO loans VALUES (1)'), /notif_\*/i);
      assert.throws(() => assertNotifTableSql('UPDATE assets SET status=0'), /notif_\*/i);
      assert.throws(() => assertNotifTableSql('DELETE FROM loan_events'), /notif_\*/i);
      assert.throws(() => assertNotifTableSql('SELECT pg_sleep(1)'), /Disallowed SQL function/i);
      assert.throws(() => assertNotifTableSql('SELECT * FROM (UPDATE notif_nonces SET used=true)'), /Write keyword/i);

      // PiiCipher encryption & key rotation (k1 -> k2)
      const cipherV1 = new PiiCipher('k1', { k1: key1, k2: key2 }, notifCfg.piiHashSecret);
      const cipherV2 = new PiiCipher('k2', { k1: key1, k2: key2 }, notifCfg.piiHashSecret);
      const enc1 = cipherV1.encrypt('borrower@nostok.xyz');
      const enc2 = cipherV2.encrypt('lender@nostok.xyz');
      assert.equal(enc1.keyId, 'k1');
      assert.equal(enc2.keyId, 'k2');
      assert.equal(enc1.ciphertext.includes('borrower@nostok.xyz'), false);
      assert.equal(cipherV2.decrypt(enc1.ciphertext, 'k1'), 'borrower@nostok.xyz');
      assert.equal(cipherV2.decrypt(enc2.ciphertext, 'k2'), 'lender@nostok.xyz');

      // Real PostgreSQL (embedded-postgres) mid-transaction pg_terminate_backend on NotifPostgresPool
      const { openNotifDatabase } = await import('../src/db.js');
      const epgPort = await getFreePort();
      const epgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostok-notif-epg-'));
      const epg = new EmbeddedPostgres({
        databaseDir: path.join(epgDir, 'data'),
        user: 'postgres',
        password: 'pw',
        port: epgPort,
        persistent: false,
      });
      await epg.initialise();
      await epg.start();
      const realPgUrl = `postgres://postgres:pw@127.0.0.1:${epgPort}/postgres`;
      try {
        const realNotifDb = await openNotifDatabase(realPgUrl);
        const admin = new pgPkg.Client({ connectionString: realPgUrl });
        await admin.connect();
        try {
          await assert.rejects(
            () =>
              realNotifDb.transaction(async (tx) => {
                const p = await tx.query<{ pid: number }>('SELECT pg_backend_pid()::INT AS pid');
                await admin.query('SELECT pg_terminate_backend($1)', [Number(p.rows[0].pid)]);
                await tx.query('SELECT 1 AS alive');
              }),
            /terminating connection|closed|57P01/i
          );
          const afterKill = await realNotifDb.query<{ n: number }>('SELECT 1::INT AS n');
          assert.equal(Number(afterKill.rows[0].n), 1);
        } finally {
          await admin.end();
          await realNotifDb.close();
        }
      } finally {
        await epg.stop();
        fs.rmSync(epgDir, { recursive: true, force: true });
      }
      console.log('PASS TEST 1: SQL guards, PII AES-256-GCM + key rotation, and real PG tx kill verified.');

      // -----------------------------------------------------------------------
      // TEST 2: SIWE (EOA + EIP-1271) & Negative Auth Cases
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 2: SIWE (EOA, EIP-1271, wrong domain, expired, reused nonce, wrong signer) ===');
      async function getNonce(wallet: Address): Promise<string> {
        const r = await httpJson<{ nonce: string }>('POST', `${notifUrl}/auth/nonce`, {
          wallet_address: wallet,
        });
        assert.equal(r.status, 200);
        return r.body.nonce;
      }

      const nowIso = new Date().toISOString();
      const futureIso = new Date(Date.now() + 600_000).toISOString();
      const pastIso = new Date(Date.now() - 60_000).toISOString();

      // 2a: Valid EOA SIWE -> get Bearer token for borrower & lender
      const bNonce = await getNonce(ADDRESSES.borrower);
      const bSiweMsg = formatSiweMessage({
        domain: 'app.nostok.xyz',
        address: ADDRESSES.borrower,
        uri: 'https://app.nostok.xyz',
        chainId: 8453,
        nonce: bNonce,
        issuedAt: nowIso,
        expirationTime: futureIso,
      });
      const bSiweSig = await borrowerAccount.signMessage({ message: bSiweMsg });
      const bAuthRes = await httpJson<{ token: string; jti: string; wallet_address: string }>(
        'POST',
        `${notifUrl}/auth/verify`,
        { message: bSiweMsg, signature: bSiweSig }
      );
      assert.equal(bAuthRes.status, 200);
      assert.equal(bAuthRes.body.wallet_address, ADDRESSES.borrower);
      assert.ok(bAuthRes.body.jti && bAuthRes.body.jti.length >= 8, 'Session must include jti');
      const borrowerToken = bAuthRes.body.token;

      // Logout revocation test on a secondary borrower session
      const revNonce = await getNonce(ADDRESSES.borrower);
      const revMsg = formatSiweMessage({
        domain: 'app.nostok.xyz',
        address: ADDRESSES.borrower,
        uri: 'https://app.nostok.xyz',
        chainId: 8453,
        nonce: revNonce,
        issuedAt: nowIso,
        expirationTime: futureIso,
      });
      const revVerify = await httpJson<{ token: string; jti: string }>('POST', `${notifUrl}/auth/verify`, {
        message: revMsg,
        signature: await borrowerAccount.signMessage({ message: revMsg }),
      });
      assert.equal(revVerify.status, 200);
      const revLogout = await httpJson<{ revoked: boolean }>(
        'POST',
        `${notifUrl}/auth/logout`,
        {},
        { Authorization: `Bearer ${revVerify.body.token}` }
      );
      assert.equal(revLogout.status, 200);
      assert.equal(revLogout.body.revoked, true);
      const afterLogout = await httpJson<{ error: { code: string } }>(
        'GET',
        `${notifUrl}/subscriptions`,
        undefined,
        { Authorization: `Bearer ${revVerify.body.token}` }
      );
      assert.equal(afterLogout.status, 401);
      assert.equal(afterLogout.body.error.code, 'SESSION_REVOKED');

      // Reused nonce MUST fail with 401
      const reuseRes = await httpJson<{ error: { code: string } }>(
        'POST',
        `${notifUrl}/auth/verify`,
        { message: bSiweMsg, signature: bSiweSig }
      );
      assert.equal(reuseRes.status, 401, 'Reused nonce must be rejected');

      // Wrong domain MUST fail with 401
      const badDomNonce = await getNonce(ADDRESSES.borrower);
      const badDomMsg = formatSiweMessage({
        domain: 'evil.example.com',
        address: ADDRESSES.borrower,
        uri: 'https://app.nostok.xyz',
        chainId: 8453,
        nonce: badDomNonce,
        issuedAt: nowIso,
        expirationTime: futureIso,
      });
      const badDomRes = await httpJson('POST', `${notifUrl}/auth/verify`, {
        message: badDomMsg,
        signature: await borrowerAccount.signMessage({ message: badDomMsg }),
      });
      assert.equal(badDomRes.status, 401, 'Wrong domain must be rejected');

      // Expired message MUST fail with 401
      const expNonce = await getNonce(ADDRESSES.borrower);
      const expMsg = formatSiweMessage({
        domain: 'app.nostok.xyz',
        address: ADDRESSES.borrower,
        uri: 'https://app.nostok.xyz',
        chainId: 8453,
        nonce: expNonce,
        issuedAt: pastIso,
        expirationTime: pastIso,
      });
      const expRes = await httpJson('POST', `${notifUrl}/auth/verify`, {
        message: expMsg,
        signature: await borrowerAccount.signMessage({ message: expMsg }),
      });
      assert.equal(expRes.status, 401, 'Expired SIWE message must be rejected');

      // Wrong signer MUST fail with 401
      const wrongSigNonce = await getNonce(ADDRESSES.borrower);
      const wrongSigMsg = formatSiweMessage({
        domain: 'app.nostok.xyz',
        address: ADDRESSES.borrower,
        uri: 'https://app.nostok.xyz',
        chainId: 8453,
        nonce: wrongSigNonce,
        issuedAt: nowIso,
        expirationTime: futureIso,
      });
      const wrongSigRes = await httpJson('POST', `${notifUrl}/auth/verify`, {
        message: wrongSigMsg,
        signature: await lenderAccount.signMessage({ message: wrongSigMsg }),
      });
      assert.equal(wrongSigRes.status, 401, 'Wrong signer must be rejected');

      // 2b: Valid EIP-1271 smart wallet SIWE verification
      const swNonce = await getNonce(smartWalletAddr);
      const swMsg = formatSiweMessage({
        domain: 'app.nostok.xyz',
        address: smartWalletAddr,
        uri: 'https://app.nostok.xyz',
        chainId: 8453,
        nonce: swNonce,
        issuedAt: nowIso,
        expirationTime: futureIso,
      });
      const swSig = await signer1271Account.signMessage({ message: swMsg });
      const swAuthRes = await httpJson<{ token: string; wallet_address: string }>(
        'POST',
        `${notifUrl}/auth/verify`,
        { message: swMsg, signature: swSig }
      );
      assert.equal(swAuthRes.status, 200, 'EIP-1271 smart contract wallet SIWE must succeed');
      assert.equal(swAuthRes.body.wallet_address, smartWalletAddr);

      // Lender auth token
      const lNonce = await getNonce(ADDRESSES.lender);
      const lSiweMsg = formatSiweMessage({
        domain: 'app.nostok.xyz',
        address: ADDRESSES.lender,
        uri: 'https://app.nostok.xyz',
        chainId: 8453,
        nonce: lNonce,
        issuedAt: nowIso,
        expirationTime: futureIso,
      });
      const lAuthRes = await httpJson<{ token: string }>(
        'POST',
        `${notifUrl}/auth/verify`,
        { message: lSiweMsg, signature: await lenderAccount.signMessage({ message: lSiweMsg }) }
      );
      assert.equal(lAuthRes.status, 200);
      const lenderToken = lAuthRes.body.token;

      // 2c: Scoped per-IP & per-wallet rate limits on /auth/nonce, /auth/verify, and /subscriptions
      const rlSrv = createNotificationsServer({
        ...notifCtx,
        config: {
          ...notifCtx.config,
          authNonceRateLimitMax: 2,
          authVerifyRateLimitMax: 2,
          subscriptionsRateLimitMax: 2,
        },
      });
      await new Promise<void>((r) => rlSrv.listen(0, '127.0.0.1', r));
      const rlUrl = `http://127.0.0.1:${(rlSrv.address() as net.AddressInfo).port}`;
      try {
        assert.equal(
          (await httpJson('POST', `${rlUrl}/auth/nonce`, { wallet_address: ADDRESSES.borrower })).status,
          200
        );
        assert.equal(
          (await httpJson('POST', `${rlUrl}/auth/nonce`, { wallet_address: ADDRESSES.borrower })).status,
          200
        );
        const nonce429 = await httpJson<{ error: { code: string } }>('POST', `${rlUrl}/auth/nonce`, {
          wallet_address: ADDRESSES.borrower,
        });
        assert.equal(nonce429.status, 429);
        assert.equal(nonce429.body.error.code, 'RATE_LIMIT_EXCEEDED');

        for (let k = 0; k < 2; k++) {
          await httpJson('POST', `${rlUrl}/auth/verify`, { message: bSiweMsg, signature: bSiweSig });
        }
        const verify429 = await httpJson<{ error: { code: string } }>('POST', `${rlUrl}/auth/verify`, {
          message: bSiweMsg,
          signature: bSiweSig,
        });
        assert.equal(verify429.status, 429);

        for (let k = 0; k < 2; k++) {
          await httpJson(
            'POST',
            `${rlUrl}/subscriptions`,
            { channel: 'webhook', target: 'https://0x7f000001/hook' },
            { Authorization: `Bearer ${borrowerToken}` }
          );
        }
        const sub429 = await httpJson<{ error: { code: string } }>(
          'POST',
          `${rlUrl}/subscriptions`,
          { channel: 'webhook', target: 'https://hooks.nostok-test.example/hook' },
          { Authorization: `Bearer ${borrowerToken}` }
        );
        assert.equal(sub429.status, 429);
      } finally {
        await new Promise<void>((r) => rlSrv.close(() => r()));
      }
      console.log('PASS TEST 2: SIWE EOA + EIP-1271 + session jti revocation + scoped rate limits + negative rejections verified.');

      // -----------------------------------------------------------------------
      // TEST 3: Ownership confirmation, SSRF blocks, DNS pinning, redirect block, per-wallet cap & encryption
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 3: Encrypted subscriptions, confirmation, SSRF guards, & per-wallet cap ===');
      const subEmail = await httpJson<{
        id: string;
        masked_target: string;
        key_id: string;
        enabled: boolean;
        verified: boolean;
        verification_required: boolean;
      }>(
        'POST',
        `${notifUrl}/subscriptions`,
        { channel: 'email', target: 'borrower@nostok.xyz' },
        { Authorization: `Bearer ${borrowerToken}` }
      );
      assert.equal(subEmail.status, 201);
      assert.equal(subEmail.body.masked_target, 'bo***@nostok.xyz');
      assert.equal(subEmail.body.enabled, false, 'Unconfirmed email must start disabled');
      assert.equal(subEmail.body.verified, false, 'Unconfirmed email must start unverified');
      assert.equal(subEmail.body.verification_required, true);

      // Wrong code / wrong confirm token rejected
      const badCodeRes = await httpJson(
        'POST',
        `${notifUrl}/subscriptions/confirm`,
        { subscription_id: subEmail.body.id, code: '000000' },
        { Authorization: `Bearer ${borrowerToken}` }
      );
      assert.equal(badCodeRes.status, 400);
      const badTokenRes = await httpJson('POST', `${notifUrl}/subscriptions/confirm`, {
        token: 'tampered.confirm.token',
      });
      assert.equal(badTokenRes.status, 400);

      // Confirm borrower email using code delivered in verification email
      const emailVerifyMsg = deliveredEmails.find((m) => m.subscriptionId === subEmail.body.id)!;
      assert.ok(emailVerifyMsg, 'Expected verification email to be dispatched');
      const okEmailConfirm = await httpJson<{ confirmed: boolean; enabled: boolean; verified: boolean }>(
        'POST',
        `${notifUrl}/subscriptions/confirm`,
        {
          subscription_id: subEmail.body.id,
          code: String(emailVerifyMsg.payload.verification_code),
        },
        { Authorization: `Bearer ${borrowerToken}` }
      );
      assert.equal(okEmailConfirm.status, 200);
      assert.equal(okEmailConfirm.body.confirmed, true);
      assert.equal(okEmailConfirm.body.verified, true);

      // Telegram subscription starts disabled -> confirm via signed token link
      const subTg = await httpJson<{ id: string; enabled: boolean; verified: boolean }>(
        'POST',
        `${notifUrl}/subscriptions`,
        { channel: 'telegram', target: '-10099887766' },
        { Authorization: `Bearer ${borrowerToken}` }
      );
      assert.equal(subTg.status, 201);
      assert.equal(subTg.body.verified, false);
      const tgVerifyMsg = deliveredTelegrams.find((m) => m.subscriptionId === subTg.body.id)!;
      const getConfirmCheck = await httpJson<{ confirmation_required: boolean; method: string }>(
        'GET',
        String(tgVerifyMsg.payload.confirm_url)
      );
      assert.equal(getConfirmCheck.status, 200);
      assert.equal(getConfirmCheck.body.confirmation_required, true);
      const okTgConfirm = await httpJson<{ confirmed: boolean; verified: boolean }>(
        'POST',
        `${notifUrl}/subscriptions/confirm`,
        { token: String(tgVerifyMsg.payload.confirm_token) }
      );
      assert.equal(okTgConfirm.status, 200);
      assert.equal(okTgConfirm.body.verified, true);

      // Valid HTTPS webhook subscription
      const subHook = await httpJson<{ id: string; enabled: boolean; verified: boolean }>(
        'POST',
        `${notifUrl}/subscriptions`,
        { channel: 'webhook', target: webhookTargetUrl },
        { Authorization: `Bearer ${borrowerToken}` }
      );
      assert.equal(subHook.status, 201);
      assert.equal(subHook.body.enabled, true);
      assert.equal(subHook.body.verified, true);

      // Lender email subscription + confirm
      const subLenderEmail = await httpJson<{ id: string }>(
        'POST',
        `${notifUrl}/subscriptions`,
        { channel: 'email', target: 'lender@nostok.xyz' },
        { Authorization: `Bearer ${lenderToken}` }
      );
      assert.equal(subLenderEmail.status, 201);
      const lenderVerifyMsg = deliveredEmails.find((m) => m.subscriptionId === subLenderEmail.body.id)!;
      assert.equal(
        (
          await httpJson('POST', `${notifUrl}/subscriptions/confirm`, {
            token: String(lenderVerifyMsg.payload.confirm_token),
          })
        ).status,
        200
      );

      // SSRF negative tests (API registration + default transport direct sendWebhook + 302 redirect + DNS pinning)
      const ssrfTargets = [
        'http://hooks.nostok-test.example/hook',
        'https://localhost/hook',
        'https://169.254.169.254/latest/meta-data/',
        'https://[::1]/hook',
        'https://0x7f000001/hook',
        'https://0177.0.0.1/hook',
        'https://2130706433/hook',
        'https://rebind-private.example/hook',
        'https://rebind-meta.example/hook',
        'https://rebind-ipv6.example/hook',
      ];
      for (const badUrl of ssrfTargets) {
        const resBad = await httpJson(
          'POST',
          `${notifUrl}/subscriptions`,
          { channel: 'webhook', target: badUrl },
          { Authorization: `Bearer ${borrowerToken}` }
        );
        assert.equal(resBad.status, 400, `SSRF URL must be rejected at subscription: ${badUrl}`);
      }

      // Direct default transport checks: DNS IP pinning, redirect: 'manual' no-follow, & 302 rejection
      const capturedReqOpts: WebhookHttpRequestOpts[] = [];
      const redirectTransport = createDefaultTransports({
        emailFrom: notifCfg.emailFrom,
        telegramApiBase: notifCfg.telegramApiBase,
        outboundTimeoutMs: notifCfg.outboundTimeoutMs,
        webhookSigningSecret: notifCfg.webhookSigningSecret,
        dnsLookup: mockDnsLookup,
        webhookRequester: async (opts) => {
          capturedReqOpts.push(opts);
          return { status: 302 };
        },
      });
      for (const badUrl of ssrfTargets) {
        if (!badUrl.includes('rebind-')) {
          assert.throws(() => validateChannelTarget('webhook', badUrl));
        }
        await assert.rejects(() =>
          redirectTransport.sendWebhook({
            wallet: ADDRESSES.borrower,
            subscriptionId: subHook.body.id,
            channel: 'webhook',
            target: badUrl,
            alertType: 'test',
            severity: 'info',
            title: 't',
            message: 'm',
            payload: {},
            unsubscribeUrl: `${notifUrl}/unsubscribe?token=x`,
          })
        );
      }
      await assert.rejects(
        () =>
          redirectTransport.sendWebhook({
            wallet: ADDRESSES.borrower,
            subscriptionId: subHook.body.id,
            channel: 'webhook',
            target: webhookTargetUrl,
            alertType: 'test',
            severity: 'info',
            title: 't',
            message: 'm',
            payload: {},
            unsubscribeUrl: `${notifUrl}/unsubscribe?token=x`,
          }),
        /redirect blocked/i
      );
      assert.equal(capturedReqOpts.length, 1, '302 redirect must NOT issue a follow-up request');
      assert.equal(capturedReqOpts[0].redirect, 'manual');
      assert.equal(capturedReqOpts[0].pinnedIp, '93.184.216.34');
      assert.ok(
        verifyWebhookPayloadSignature(
          notifCfg.webhookSigningSecret,
          capturedReqOpts[0].body,
          capturedReqOpts[0].headers['X-Nostok-Signature']
        ),
        'Direct webhook requester must carry valid HMAC timestamp signature'
      );

      // Per-wallet subscription cap (maxSubscriptionsPerWallet = 5) verified cleanly via lender SIWE or borrower?
      // Use liquidator wallet so borrower retains strictly its 3 primary channels for TEST 4/5 assertions!
      const liqNonce = await getNonce(ADDRESSES.liquidator);
      const liqMsg = formatSiweMessage({
        domain: 'app.nostok.xyz',
        address: ADDRESSES.liquidator,
        uri: 'https://app.nostok.xyz',
        chainId: 8453,
        nonce: liqNonce,
        issuedAt: nowIso,
        expirationTime: futureIso,
      });
      const liqAuth = await httpJson<{ token: string }>('POST', `${notifUrl}/auth/verify`, {
        message: liqMsg,
        signature: await privateKeyToAccount(KEYS.liquidator).signMessage({ message: liqMsg }),
      });
      assert.equal(liqAuth.status, 200);
      for (let i = 1; i <= 5; i++) {
        const capOk = await httpJson(
          'POST',
          `${notifUrl}/subscriptions`,
          { channel: 'webhook', target: `https://hooks.nostok-test.example/cap-${i}` },
          { Authorization: `Bearer ${liqAuth.body.token}` }
        );
        assert.equal(capOk.status, 201, `Subscription ${i}/5 must succeed`);
      }
      const capExceeded = await httpJson<{ error: { code: string } }>(
        'POST',
        `${notifUrl}/subscriptions`,
        { channel: 'webhook', target: 'https://hooks.nostok-test.example/cap-6' },
        { Authorization: `Bearer ${liqAuth.body.token}` }
      );
      assert.equal(capExceeded.status, 400);
      assert.equal(capExceeded.body.error.code, 'SUBSCRIPTION_LIMIT_EXCEEDED');

      // Verify NO plaintext email or telegram id in notif_subscriptions table
      const rawDbSubs = await notifCtx.notifDb.query<{ target_ciphertext: string; target_hash: string }>(
        'SELECT target_ciphertext, target_hash FROM notif_subscriptions'
      );
      assert.equal(rawDbSubs.rows.length, 9);
      for (const r of rawDbSubs.rows) {
        assert.equal(r.target_ciphertext.includes('borrower@nostok.xyz'), false);
        assert.equal(r.target_ciphertext.includes('-10099887766'), false);
        assert.equal(r.target_hash.includes('borrower@nostok.xyz'), false);
      }

      // Reset recorder arrays after verification emails before TEST 4 lifecycle assertions
      deliveredEmails.length = 0;
      deliveredTelegrams.length = 0;
      deliveredWebhooks.length = 0;
      console.log('PASS TEST 3: Ownership confirmation, SSRF guards, IP pinning, manual redirect, 5-cap & encryption verified.');

      // -----------------------------------------------------------------------
      // TEST 4: Full Loan Lifecycle Alerts on Base Fork
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 4: Loan lifecycle alerts (margin_call, near_liq, liquidation, auction bid/settle, maturity 3d/1d/6h, repay, claim, corporate action, oracle_stale) ===');
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

      async function openLoan(principalUsdc: bigint, termDays: number): Promise<bigint> {
        const blk = await publicClient.getBlock();
        const order = {
          borrower: ADDRESSES.borrower,
          collateralToken: nvdac,
          collateralAmount: 10n * 10n ** 18n,
          minUsdc: principalUsdc,
          maxRateBps: 1000,
          termDays,
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
            chainId: 8453,
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
        return publicClient.readContract({
          address: deployed.loanCore,
          abi: parseAbi(['function nextLoanId() view returns (uint256)']),
          functionName: 'nextLoanId',
        }).then((nextId) => nextId - 1n);
      }

      async function syncAll(nowMs = Date.now()): Promise<void> {
        await runIndexerSync(idxCtx);
        await runRiskScan(riskCtx, nowMs);
        await runNotificationsCycle(notifCtx, nowMs);
      }

      let t = Date.now();

      // 4A: Loan #1 -> Margin Call -> 200 bps Hysteresis -> Full Recovery -> Re-arm Margin Call (sends twice)
      // -> Near Liq -> Liquidation -> Auction Restart -> Partial Buy -> Settle
      const loan1Id = await openLoan(750_000_000n, 14);
      assert.equal(loan1Id, 1n);

      // Price $105 -> margin_call episode 1
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [105_00000000n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      assert.equal(
        deliveredEmails.filter((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'loan_margin_call').length,
        1,
        'Expected loan_margin_call episode 1 email'
      );
      assert.ok(
        deliveredTelegrams.some((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'loan_margin_call'),
        'Expected loan_margin_call Telegram'
      );
      const mcWebhook = deliveredWebhooks.find(
        (w) => w.wallet === ADDRESSES.borrower && w.event === 'loan_margin_call'
      );
      assert.ok(mcWebhook, 'Expected loan_margin_call webhook');
      assert.ok(
        verifyWebhookPayloadSignature(
          notifCfg.webhookSigningSecret,
          mcWebhook.rawBody,
          String(mcWebhook.headers['x-nostok-signature'] ?? '')
        ),
        'Webhook payload MUST carry valid X-Nostok-Signature HMAC header'
      );

      // Verify dedup: immediate rescan must NOT send duplicate loan_margin_call
      const emailsBeforeDedup = deliveredEmails.length;
      t += 5_000;
      await syncAll(t);
      assert.equal(
        deliveredEmails.slice(emailsBeforeDedup).some((m) => m.alertType === 'loan_margin_call'),
        false,
        'Duplicate loan_margin_call must be suppressed by episode dedup_key'
      );

      // 200 bps hysteresis band check: uptick to $109 (LTV ~6881 bps, < 7000 but > 6800) must NOT clear episode 1,
      // so dipping back to $106 (LTV ~7075 >= 7000) must NOT re-send!
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [109_00000000n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [106_00000000n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      assert.equal(
        deliveredEmails.filter((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'loan_margin_call').length,
        1,
        'Hysteresis band (LTV > marginCall-200) must NOT reset episode'
      );

      // Full recovery to $140 (LTV ~5360 <= 6800) clears episode 1; second drop to $105 fires episode 2!
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [140_00000000n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [105_00000000n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      assert.equal(
        deliveredEmails.filter((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'loan_margin_call').length,
        2,
        'Margin -> healthy (past hysteresis) -> margin must fire second loan_margin_call episode'
      );

      // Price $99 -> near_liquidation
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [99_00000000n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      assert.ok(
        deliveredEmails.some((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'loan_near_liquidation'),
        'Expected loan_near_liquidation'
      );

      // Price $92 -> liquidatable -> startLiquidation(1) -> Auction #1
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [92_00000000n],
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
      t += 5_000;
      await syncAll(t);
      assert.equal(
        deliveredEmails.filter((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'liquidation_started').length,
        1,
        'Expected liquidation_started for borrower'
      );
      assert.ok(
        deliveredEmails.some((m) => m.wallet === ADDRESSES.lender && m.alertType === 'liquidation_started'),
        'Expected liquidation_started for lender'
      );

      // Warp 31 minutes past auction start & call restartOrCancelAuction(1) -> must emit second liquidation_started!
      const blkPreRestart = await publicClient.getBlock();
      await rpcCall('evm_setNextBlockTimestamp', [Number(blkPreRestart.timestamp) + 1860]);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [92_00000000n],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await liquidatorClient.writeContract({
          address: deployed.liquidationAuction,
          abi: parseAbi(['function restartOrCancelAuction(uint256 auctionId)']),
          functionName: 'restartOrCancelAuction',
          args: [1n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      assert.equal(
        deliveredEmails.filter((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'liquidation_started').length,
        2,
        'Auction restart must trigger a new liquidation_started alert'
      );

      // Partial buy (2 NVDAc of 5 NVDAc partial-liquidation auction) -> auction_bid;
      // remaining 3 NVDAc -> auction_settled + lender_claimable
      const buyAbi = parseAbi([
        'function buy(uint256 auctionId, uint128 collateralAmount, uint128 maxUsdcPayment) returns (uint128)',
      ]);
      await publicClient.waitForTransactionReceipt({
        hash: await liquidatorClient.writeContract({
          address: deployed.liquidationAuction,
          abi: buyAbi,
          functionName: 'buy',
          args: [1n, 2n * 10n ** 18n, 1_500_000_000n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      assert.ok(
        deliveredEmails.some((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'auction_bid'),
        'Expected auction_bid'
      );

      await publicClient.waitForTransactionReceipt({
        hash: await liquidatorClient.writeContract({
          address: deployed.liquidationAuction,
          abi: buyAbi,
          functionName: 'buy',
          args: [1n, 3n * 10n ** 18n, 1_500_000_000n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      assert.ok(
        deliveredEmails.some((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'auction_settled'),
        'Expected auction_settled'
      );
      assert.ok(
        deliveredEmails.some((m) => m.wallet === ADDRESSES.lender && m.alertType === 'lender_claimable'),
        'Expected lender_claimable after auction settle'
      );

      // Lender claims USDC
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: deployed.loanCore,
          abi: parseAbi(['function claim(address to) returns (uint128)']),
          functionName: 'claim',
          args: [ADDRESSES.lender],
        }),
      });

      // Restore price $140 for Loan #2
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [140_00000000n],
        }),
      });

      const getLoanAbi = parseAbi([
        'function getLoan(uint256) view returns ((address borrower,address collateralToken,uint128 collateralRaw,uint128 principal,uint64 startTime,uint64 maturity,uint32 rateBps,uint32 penaltySpreadBps,uint16 initLtvBps,uint16 marginCallLtvBps,uint16 liqLtvBps,uint16 minInterestDays,uint8 status,uint8 yieldMode,uint8 coreVersion,uint128 interestPaid,uint128 principalRepaid))',
      ]);

      // 4B: Loan #2 (7d term) -> warp time for 3d, 1d, 6h maturity reminders -> repay -> claimable
      const loan2Id = await openLoan(600_000_000n, 7);
      assert.equal(loan2Id, 2n);
      const loan2Chain = await publicClient.readContract({
        address: deployed.loanCore,
        abi: getLoanAbi,
        functionName: 'getLoan',
        args: [2n],
      });

      for (const [offsetSecs, expectedType] of [
        [60 * 3600, 'maturity_reminder_3d'],
        [20 * 3600, 'maturity_reminder_1d'],
        [4 * 3600, 'maturity_reminder_6h'],
      ] as const) {
        await rpcCall('evm_setNextBlockTimestamp', [Number(loan2Chain.maturity) - offsetSecs]);
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [140_00000000n],
          }),
        });
        t += 5_000;
        await syncAll(t);
        assert.ok(
          deliveredEmails.some((m) => m.wallet === ADDRESSES.borrower && m.alertType === expectedType),
          `Expected ${expectedType} email`
        );
      }

      // Repay Loan #2 -> loan_repaid + lender_claimable
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: deployed.loanCore,
          abi: parseAbi(['function repay(uint256 loanId) returns (uint128)']),
          functionName: 'repay',
          args: [2n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      assert.ok(
        deliveredEmails.some((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'loan_repaid'),
        'Expected loan_repaid for borrower'
      );
      assert.ok(
        deliveredEmails.some((m) => m.wallet === ADDRESSES.lender && m.alertType === 'lender_claimable'),
        'Expected lender_claimable on repay'
      );

      // 4B-2: On-chain re-check before maturity reminder (no reminder for repaid loan even with lagging indexer DB)
      const loan2bId = await openLoan(600_000_000n, 7);
      const loan2bChain = await publicClient.readContract({
        address: deployed.loanCore,
        abi: getLoanAbi,
        functionName: 'getLoan',
        args: [loan2bId],
      });
      await runIndexerSync(idxCtx); // Index Loan #2b as Active (status=0)
      await rpcCall('evm_setNextBlockTimestamp', [Number(loan2bChain.maturity) - 4 * 3600]);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [140_00000000n],
        }),
      });
      // Repay Loan #2b WITHOUT calling runIndexerSync!
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: deployed.loanCore,
          abi: parseAbi(['function repay(uint256 loanId) returns (uint128)']),
          functionName: 'repay',
          args: [loan2bId],
        }),
      });
      const rem6hBefore = deliveredEmails.filter(
        (m) => m.wallet === ADDRESSES.borrower && m.alertType === 'maturity_reminder_6h'
      ).length;
      t += 5_000;
      await runRiskScan(riskCtx, t);
      await runNotificationsCycle(notifCtx, t);
      assert.equal(
        deliveredEmails.filter(
          (m) => m.wallet === ADDRESSES.borrower && m.alertType === 'maturity_reminder_6h'
        ).length,
        rem6hBefore,
        'Repaid loan on-chain MUST NOT trigger maturity reminder even if indexer lags'
      );
      await runIndexerSync(idxCtx);

      // 4B-3: Post-maturity grace entry, penalty interest, & default auction pending
      const loan2cId = await openLoan(600_000_000n, 7);
      const loan2cChain = await publicClient.readContract({
        address: deployed.loanCore,
        abi: getLoanAbi,
        functionName: 'getLoan',
        args: [loan2cId],
      });
      await runIndexerSync(idxCtx);
      // 10m past maturity (inside 24h grace)
      await rpcCall('evm_setNextBlockTimestamp', [Number(loan2cChain.maturity) + 600]);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [140_00000000n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      assert.ok(
        deliveredEmails.some(
          (m) =>
            m.wallet === ADDRESSES.borrower &&
            m.alertType === 'loan_grace_entry' &&
            String(m.payload.loan_id) === loan2cId.toString()
        ),
        'Expected loan_grace_entry after maturity'
      );
      assert.ok(
        deliveredEmails.some(
          (m) =>
            m.wallet === ADDRESSES.borrower &&
            m.alertType === 'penalty_interest_accruing' &&
            String(m.payload.loan_id) === loan2cId.toString()
        ),
        'Expected penalty_interest_accruing after maturity'
      );

      // 25h past maturity (> 24h grace) -> default_auction_pending
      await rpcCall('evm_setNextBlockTimestamp', [Number(loan2cChain.maturity) + 90_000]);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [140_00000000n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      assert.ok(
        deliveredEmails.some(
          (m) =>
            m.wallet === ADDRESSES.borrower &&
            m.alertType === 'default_auction_pending' &&
            String(m.payload.loan_id) === loan2cId.toString()
        ),
        'Expected default_auction_pending past maturity + 24h grace'
      );
      // Repay overdue Loan #2c to clean up state
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: deployed.loanCore,
          abi: parseAbi(['function repay(uint256 loanId) returns (uint128)']),
          functionName: 'repay',
          args: [loan2cId],
        }),
      });
      t += 5_000;
      await syncAll(t);

      // 4C: Corporate Action freeze (2x multiplier) + Stale Feed
      const loan3Id = await openLoan(600_000_000n, 14);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'setUIMultiplier',
          args: [initialMult * 2n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      assert.ok(
        deliveredEmails.some(
          (m) =>
            m.wallet === ADDRESSES.borrower &&
            m.alertType === 'asset_frozen_or_corporate_action' &&
            String(m.payload.loan_id) === loan3Id.toString()
        ),
        'Expected asset_frozen_or_corporate_action'
      );

      // Restore multiplier, set feed stale -> oracle_stale
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'setUIMultiplier',
          args: [initialMult],
        }),
      });
      const curBlk = await publicClient.getBlock();
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setUpdatedAt',
          args: [curBlk.timestamp - 30_000n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      assert.ok(
        deliveredEmails.some((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'oracle_stale'),
        'Expected oracle_stale notice'
      );
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [140_00000000n],
        }),
      });
      t += 5_000;
      await syncAll(t);
      console.log('PASS TEST 4: Full loan lifecycle, hysteresis/re-arm, auction restart, on-chain re-check, & post-maturity alerts verified.');

      // -----------------------------------------------------------------------
      // TEST 5: Quiet hours re-queue, critical rate-limit bypass, decrypt catch, circuit breaker, generic DLQ, POST unsub & DELETE /user/data
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 5: Quiet hours, preferences, per-user rate limit, DLQ retry, circuit breaker, unsubscribe, & delete-my-data ===');
      // 5A: Margin call suppressed during quiet hours, then automatically re-queued & delivered when quiet hours end!
      const qTimeMs = t + 5_000;
      const utcHour = new Date(qTimeMs).getUTCHours();
      const prefRes = await httpJson(
        'PUT',
        `${notifUrl}/preferences`,
        {
          alert_types: { auction_bid: false },
          quiet_hours_start: utcHour,
          quiet_hours_end: (utcHour + 1) % 24,
          max_per_hour: 100,
        },
        { Authorization: `Bearer ${borrowerToken}` }
      );
      assert.equal(prefRes.status, 200);

      const loanQuietId = await openLoan(750_000_000n, 14);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [105_00000000n],
        }),
      });
      const emailCountBeforeQuiet = deliveredEmails.length;
      await syncAll(qTimeMs);
      const quietSuppressed = await notifCtx.notifDb.query<{ cnt: number }>(
        "SELECT COUNT(*)::INT AS cnt FROM notif_deliveries WHERE status = 'suppressed_quiet_hours' AND alert_type = 'loan_margin_call'"
      );
      assert.ok(Number(quietSuppressed.rows[0].cnt) >= 1, 'Margin call during quiet hours must be suppressed');
      assert.equal(
        deliveredEmails
          .slice(emailCountBeforeQuiet)
          .some((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'loan_margin_call'),
        false,
        'Suppressed quiet hours margin call must not deliver during quiet window'
      );

      // End quiet hours -> suppressed margin call is re-queued and delivered!
      await httpJson(
        'PUT',
        `${notifUrl}/preferences`,
        { quiet_hours_start: null, quiet_hours_end: null, max_per_hour: 100 },
        { Authorization: `Bearer ${borrowerToken}` }
      );
      await syncAll(qTimeMs + 3_000);
      assert.ok(
        deliveredEmails
          .slice(emailCountBeforeQuiet)
          .some((m) => m.wallet === ADDRESSES.borrower && m.alertType === 'loan_margin_call'),
        'Margin call suppressed during quiet hours MUST be delivered after quiet hours end'
      );

      // Re-enable quiet hours AND set max_per_hour = 1 on borrower -> critical liquidation_started MUST bypass BOTH quiet hours & rate limit!
      await httpJson(
        'PUT',
        `${notifUrl}/preferences`,
        {
          quiet_hours_start: utcHour,
          quiet_hours_end: (utcHour + 1) % 24,
          max_per_hour: 1,
        },
        { Authorization: `Bearer ${borrowerToken}` }
      );
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [92_00000000n],
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await liquidatorClient.writeContract({
          address: deployed.loanCore,
          abi: parseAbi(['function startLiquidation(uint256 loanId) returns (uint256)']),
          functionName: 'startLiquidation',
          args: [loanQuietId],
        }),
      });
      await syncAll(qTimeMs + 6_000);
      assert.ok(
        deliveredEmails
          .slice(emailCountBeforeQuiet)
          .some(
            (m) =>
              m.wallet === ADDRESSES.borrower &&
              m.alertType === 'liquidation_started' &&
              String(m.payload.loan_id) === loanQuietId.toString()
          ),
        'Critical liquidation_started MUST bypass both quiet hours AND per-user hourly rate limit'
      );

      // 5B: Restore price & test per-user rate limit suppression for non-critical lender notice
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [140_00000000n],
        }),
      });
      await httpJson(
        'PUT',
        `${notifUrl}/preferences`,
        { quiet_hours_start: null, quiet_hours_end: null, max_per_hour: 1 },
        { Authorization: `Bearer ${lenderToken}` }
      );
      const loan5Id = await openLoan(600_000_000n, 14);
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: deployed.loanCore,
          abi: parseAbi(['function repay(uint256 loanId) returns (uint128)']),
          functionName: 'repay',
          args: [loan5Id],
        }),
      });
      await syncAll(qTimeMs + 10_000);
      const rlSupp = await notifCtx.notifDb.query<{ cnt: number }>(
        "SELECT COUNT(*)::INT AS cnt FROM notif_deliveries WHERE wallet = $1 AND status = 'suppressed_rate_limit'",
        [ADDRESSES.lender.toLowerCase()]
      );
      assert.ok(Number(rlSupp.rows[0].cnt) >= 1, 'Expected per-user rate limit suppression');

      // 5C: Decrypt failure resilience (GET /subscriptions != 500 + queue continues) + DLQ generic error + Circuit breaker
      await httpJson(
        'PUT',
        `${notifUrl}/preferences`,
        { quiet_hours_start: null, quiet_hours_end: null, max_per_hour: 200 },
        { Authorization: `Bearer ${borrowerToken}` }
      );
      await notifCtx.notifDb.query(
        `INSERT INTO notif_subscriptions (id, wallet, channel, target_ciphertext, key_id, target_hash, enabled, verified)
         VALUES ('sub_corrupt_key', $1, 'email', 'invalid-cipher', 'retired_missing_key', 'corrupt_hash_1', TRUE, TRUE)`,
        [ADDRESSES.borrower.toLowerCase()]
      );
      await notifCtx.notifDb.query(
        `INSERT INTO notif_deliveries (
           id, wallet, subscription_id, channel, alert_type, severity, dedup_key,
           title, message, payload_json, status, attempts, next_attempt_at, created_at
         ) VALUES ('dlv_corrupt_key', $1, 'sub_corrupt_key', 'email', 'loan_repaid', 'info', 'corrupt_key_test',
           'test', 'test', '{}', 'pending', 0, $2, $2)`,
        [ADDRESSES.borrower.toLowerCase(), (qTimeMs + 12_000).toString()]
      );
      const subsWithCorrupt = await httpJson<{
        data: Array<{ id: string; masked_target: string; decryption_error?: boolean }>;
      }>('GET', `${notifUrl}/subscriptions`, undefined, { Authorization: `Bearer ${borrowerToken}` });
      assert.equal(subsWithCorrupt.status, 200, 'GET /subscriptions must NOT 500 on unknown key_id');
      assert.equal(
        subsWithCorrupt.body.data.find((s) => s.id === 'sub_corrupt_key')?.decryption_error,
        true
      );

      // Run failing email retry -> DLQ (at same cycle, corrupt delivery is dead-lettered cleanly without crashing queue)
      forceFailEmail = true;
      const loan6Id = await openLoan(600_000_000n, 14);
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: deployed.loanCore,
          abi: parseAbi(['function repay(uint256 loanId) returns (uint128)']),
          functionName: 'repay',
          args: [loan6Id],
        }),
      });
      let dlqTime = qTimeMs + 15_000;
      await syncAll(dlqTime); // attempt 1 -> retry (and dlv_corrupt_key -> dead_letter!)
      const corruptDlv = await notifCtx.notifDb.query<{ status: string; last_error: string }>(
        "SELECT status, last_error FROM notif_deliveries WHERE id = 'dlv_corrupt_key'"
      );
      assert.equal(corruptDlv.rows[0].status, 'dead_letter');
      assert.equal(corruptDlv.rows[0].last_error, 'delivery failed');
      dlqTime += 35_000;
      await runNotificationsCycle(notifCtx, dlqTime); // attempt 2 (after 30s cooldown) -> retry
      dlqTime += 35_000;
      await runNotificationsCycle(notifCtx, dlqTime); // attempt 3 (after 30s cooldown) -> dead_letter!
      forceFailEmail = false;

      const dlqRes = await httpJson<{
        data: Array<{ alert_type: string; attempts: number; last_error: string }>;
      }>('GET', `${notifUrl}/dead-letters`, undefined, { Authorization: `Bearer ${borrowerToken}` });
      assert.equal(dlqRes.status, 200);
      assert.ok(
        dlqRes.body.data.some((d) => d.alert_type === 'loan_repaid' && Number(d.attempts) === 3)
      );
      for (const row of dlqRes.body.data) {
        assert.equal(row.last_error, 'delivery failed', 'Dead-letter last_error must be generic (never leak internal errors)');
      }

      // Per-host circuit breaker test on webhook host hooks.nostok-test.example (threshold = 3)
      notifCtx.state.circuitBreakers.clear();
      forceFailWebhook = true;
      mockWebhookInvokeCount = 0;
      const prevConcurrency = notifCfg.deliveryConcurrency;
      notifCfg.deliveryConcurrency = 1;
      for (let i = 1; i <= 4; i++) {
        await notifCtx.notifDb.query(
          `INSERT INTO notif_deliveries (
             id, wallet, subscription_id, channel, alert_type, severity, dedup_key,
             title, message, payload_json, status, attempts, next_attempt_at, created_at
           ) VALUES ($1, $2, $3, 'webhook', 'loan_repaid', 'info', $4, 'cb', 'cb', '{}', 'pending', 0, $5, $5)`,
          [
            `dlv_cb_${i}`,
            ADDRESSES.borrower.toLowerCase(),
            subHook.body.id,
            `cb_test_${i}`,
            (dlqTime + 1_000).toString(),
          ]
        );
      }
      await runNotificationsCycle(notifCtx, dlqTime + 2_000);
      notifCfg.deliveryConcurrency = prevConcurrency;
      forceFailWebhook = false;
      assert.equal(
        mockWebhookInvokeCount,
        3,
        'Circuit breaker MUST open after 3 consecutive failures and skip calling transport on the 4th'
      );

      // 5D: Signed Unsubscribe: GET is read-only confirmation preview; POST mutates state
      const anyEmail = deliveredEmails.find((m) => m.subscriptionId === subEmail.body.id)!;
      const badUnsub = await fetch(`${notifUrl}/unsubscribe?token=tampered.token`);
      assert.equal(badUnsub.status, 400);

      const getUnsub = await httpJson<{ confirmation_required: boolean; method: string }>(
        'GET',
        anyEmail.unsubscribeUrl
      );
      assert.equal(getUnsub.status, 200);
      assert.equal(getUnsub.body.confirmation_required, true);
      assert.equal(getUnsub.body.method, 'POST');

      const subsAfterGetUnsub = await httpJson<{ data: Array<{ id: string; enabled: boolean }> }>(
        'GET',
        `${notifUrl}/subscriptions`,
        undefined,
        { Authorization: `Bearer ${borrowerToken}` }
      );
      assert.equal(
        subsAfterGetUnsub.body.data.find((s) => s.id === subEmail.body.id)?.enabled,
        true,
        'GET /unsubscribe MUST NOT mutate subscription state'
      );

      const unsubTokenParam = new URL(anyEmail.unsubscribeUrl).searchParams.get('token')!;
      const postUnsub = await httpJson<{ unsubscribed: boolean }>('POST', `${notifUrl}/unsubscribe`, {
        token: unsubTokenParam,
      });
      assert.equal(postUnsub.status, 200);
      assert.equal(postUnsub.body.unsubscribed, true);

      const subsAfterPostUnsub = await httpJson<{ data: Array<{ id: string; enabled: boolean }> }>(
        'GET',
        `${notifUrl}/subscriptions`,
        undefined,
        { Authorization: `Bearer ${borrowerToken}` }
      );
      assert.equal(subsAfterPostUnsub.body.data.find((s) => s.id === subEmail.body.id)?.enabled, false);

      // 5E: DELETE /user/data wipes all PII, subscriptions, preferences, deliveries, dead-letters & nonces
      const delRes = await httpJson<{ deleted: boolean }>(
        'DELETE',
        `${notifUrl}/user/data`,
        undefined,
        { Authorization: `Bearer ${borrowerToken}` }
      );
      assert.equal(delRes.status, 200);
      assert.equal(delRes.body.deleted, true);

      for (const tbl of [
        'notif_subscriptions',
        'notif_preferences',
        'notif_deliveries',
        'notif_dead_letters',
        'notif_nonces',
      ]) {
        const chk = await notifCtx.notifDb.query<{ cnt: number }>(
          `SELECT COUNT(*)::INT AS cnt FROM ${tbl} WHERE wallet = $1`,
          [ADDRESSES.borrower.toLowerCase()]
        );
        assert.equal(Number(chk.rows[0].cnt), 0, `${tbl} must contain 0 rows after DELETE /user/data`);
      }

      // 413 PAYLOAD_TOO_LARGE hardening check
      const hugeRes = await httpJson<{ error: { code: string } }>(
        'POST',
        `${notifUrl}/auth/nonce`,
        { wallet_address: ADDRESSES.borrower, pad: 'x'.repeat(5000) }
      );
      assert.equal(hugeRes.status, 413);
      assert.equal(hugeRes.body.error.code, 'PAYLOAD_TOO_LARGE');

      console.log('PASS TEST 5: Quiet hours re-queue, critical bypass, decrypt catch, circuit breaker, generic DLQ, POST unsub, & DELETE /user/data verified.');

      // -----------------------------------------------------------------------
      // TEST 6: Phase 2 Security & Reliability Hardening Suite
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 6: Hardening tests (slow-drip/timeout, outage retry/redrive, lease reclaim, brute-force, cap drain, email bombing, login DoS, dual-stack DNS, AuctionCancelled, damping, statement_timeout) ===');

      // 6.1 Slow-drip HTTP server + response size cap + never-resolving Promise.race in queue
      const slowDripServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('partial-1');
        const iv = setInterval(() => {
          if (!res.destroyed) {
            res.write('.');
          }
        }, 50);
        iv.unref?.();
        res.on('close', () => clearInterval(iv));
      });
      await new Promise<void>((r) => slowDripServer.listen(0, '127.0.0.1', r));
      const slowPort = (slowDripServer.address() as net.AddressInfo).port;

      const bigBodyServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('X'.repeat(8192));
      });
      await new Promise<void>((r) => bigBodyServer.listen(0, '127.0.0.1', r));
      const bigPort = (bigBodyServer.address() as net.AddressInfo).port;

      try {
        const tSlow0 = Date.now();
        await assert.rejects(
          () =>
            defaultWebhookRequester({
              url: new URL(`http://127.0.0.1:${slowPort}/slow`),
              pinnedIp: '127.0.0.1',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
              timeoutMs: 250,
              redirect: 'manual',
              _requestImpl: http.request,
            }),
          /deadline|timed out/i,
          'Slow-drip webhook must reject on overall wall-clock deadline despite active socket drips'
        );
        assert.ok(Date.now() - tSlow0 < 1_000, 'Overall webhook deadline must abort promptly');

        await assert.rejects(
          () =>
            defaultWebhookRequester({
              url: new URL(`http://127.0.0.1:${bigPort}/big`),
              pinnedIp: '127.0.0.1',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
              timeoutMs: 2_000,
              maxResponseBytes: 1024,
              redirect: 'manual',
              _requestImpl: http.request,
            }),
          /exceeded 1024 bytes/i,
          'Oversized webhook response body must be rejected'
        );
      } finally {
        await new Promise<void>((r) => slowDripServer.close(() => r()));
        await new Promise<void>((r) => bigBodyServer.close(() => r()));
      }

      // Never-resolving transport inside processDeliveryQueue must time out via Promise.race and move to retry
      const hangKey = generatePrivateKey();
      const hangWallet = privateKeyToAccount(hangKey).address.toLowerCase();
      const hangCipherHook = notifCtx.cipher.encrypt('https://hooks.nostok-test.example/hang');
      const hangCipherEmail = notifCtx.cipher.encrypt('hang@nostok.xyz');
      await notifCtx.notifDb.query(
        `INSERT INTO notif_subscriptions (id, wallet, channel, target_ciphertext, key_id, target_hash, enabled, verified)
         VALUES
           ('sub_hang_hook', $1, 'webhook', $2, $3, 'hang_h_1', TRUE, TRUE),
           ('sub_hang_ok_mail', $1, 'email', $4, $5, 'hang_e_1', TRUE, TRUE)`,
        [hangWallet, hangCipherHook.ciphertext, hangCipherHook.keyId, hangCipherEmail.ciphertext, hangCipherEmail.keyId]
      );
      const tHang = Date.now() + 100_000_000;
      await notifCtx.notifDb.query(
        `INSERT INTO notif_deliveries (
           id, wallet, subscription_id, channel, alert_type, severity, dedup_key,
           title, message, payload_json, status, attempts, next_attempt_at, created_at
         ) VALUES
           ('dlv_never_resolves', $1, 'sub_hang_hook', 'webhook', 'loan_repaid', 'info', 'hang_k_1',
            'hang', 'hang', '{}', 'pending', 0, $2, $2),
           ('dlv_alongside_hang', $1, 'sub_hang_ok_mail', 'email', 'loan_repaid', 'info', 'hang_k_2',
            'ok', 'ok', '{}', 'pending', 0, $2, $2)`,
        [hangWallet, tHang.toString()]
      );
      const hangEmailSent: NotificationOutboundMessage[] = [];
      const hangCtx: typeof notifCtx = {
        ...notifCtx,
        config: { ...notifCtx.config, outboundTimeoutMs: 120 },
        state: { ...notifCtx.state, circuitBreakers: new Map() },
        transports: {
          async sendEmail(m) {
            hangEmailSent.push(m);
          },
          async sendTelegram() {},
          async sendWebhook() {
            return new Promise<void>(() => {});
          },
        },
      };
      const tHangStart = Date.now();
      const hangStats = await processDeliveryQueue(hangCtx, tHang);
      assert.ok(Date.now() - tHangStart < 1_500, 'processDeliveryQueue must bound never-resolving sends via Promise.race');
      assert.equal(hangStats.sent, 1);
      assert.equal(hangStats.retried, 1);
      const hangRowAfter = await notifCtx.notifDb.query<{ status: string }>(
        "SELECT status FROM notif_deliveries WHERE id = 'dlv_never_resolves'"
      );
      assert.equal(hangRowAfter.rows[0].status, 'retry');
      assert.equal(hangEmailSent.length, 1, 'Healthy delivery in queue must succeed despite hung webhook');

      // 6.2 Per-host circuit breaker, zero attempt increment when open, 6+ critical retries, short outage delivery & DLQ redrive
      const cbWallet = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
      const cbHookA = notifCtx.cipher.encrypt('https://host-down.nostok-test.example/a');
      const cbHookB = notifCtx.cipher.encrypt('https://host-up.nostok-test.example/b');
      const cbEmailDomA = notifCtx.cipher.encrypt('a@down-domain.example');
      const cbEmailDomB = notifCtx.cipher.encrypt('b@up-domain.example');
      await notifCtx.notifDb.query(
        `INSERT INTO notif_subscriptions (id, wallet, channel, target_ciphertext, key_id, target_hash, enabled, verified)
         VALUES
           ('sub_cb_a', $1, 'webhook', $2, $3, 'cba', TRUE, TRUE),
           ('sub_cb_b', $1, 'webhook', $4, $5, 'cbb', TRUE, TRUE),
           ('sub_cb_ea', $1, 'email', $6, $7, 'cbea', TRUE, TRUE),
           ('sub_cb_eb', $1, 'email', $8, $9, 'cbeb', TRUE, TRUE)`,
        [
          cbWallet,
          cbHookA.ciphertext,
          cbHookA.keyId,
          cbHookB.ciphertext,
          cbHookB.keyId,
          cbEmailDomA.ciphertext,
          cbEmailDomA.keyId,
          cbEmailDomB.ciphertext,
          cbEmailDomB.keyId,
        ]
      );
      let outageStartMs = tHang + 50_000;
      await notifCtx.notifDb.query(
        `INSERT INTO notif_deliveries (
           id, wallet, subscription_id, channel, alert_type, severity, dedup_key,
           title, message, payload_json, status, attempts, next_attempt_at, created_at
         ) VALUES
           ('dlv_crit_outage', $1, 'sub_cb_a', 'webhook', 'liquidation_started', 'critical', 'crit_out_1',
            'crit', 'crit', '{}', 'pending', 0, $2, $2),
           ('dlv_cb_open_seed1', $1, 'sub_cb_ea', 'email', 'loan_repaid', 'info', 'cbea_1',
            'e', 'e', '{}', 'pending', 0, $2, $2),
           ('dlv_cb_open_seed2', $1, 'sub_cb_ea', 'email', 'loan_repaid', 'info', 'cbea_2',
            'e', 'e', '{}', 'pending', 0, $2, $2),
           ('dlv_cb_email_isolated', $1, 'sub_cb_eb', 'email', 'loan_repaid', 'info', 'cbeb_1',
            'e', 'e', '{}', 'pending', 0, $2, $2)`,
        [cbWallet, outageStartMs.toString()]
      );
      let providerDown = true;
      const outageSentIds: string[] = [];
      const outageCtx: typeof notifCtx = {
        ...notifCtx,
        config: {
          ...notifCtx.config,
          retryBaseMs: 200,
          circuitBreakerThreshold: 2,
          circuitBreakerCooldownMs: 3_000,
          maxDeliveryAttempts: 3,
          maxCriticalDeliveryAttempts: 6,
          deliveryConcurrency: 1,
        },
        state: { ...notifCtx.state, circuitBreakers: new Map() },
        transports: {
          async sendEmail(m) {
            if (m.target.endsWith('@down-domain.example')) {
              throw new Error('503 email domain down');
            }
            outageSentIds.push(m.subscriptionId);
          },
          async sendTelegram() {},
          async sendWebhook(m) {
            if (providerDown && m.target.includes('host-down.nostok-test.example')) {
              throw new Error('503 provider down');
            }
            outageSentIds.push(m.subscriptionId);
          },
        },
      };
      // Attempt 1 & 2 open breaker for @down-domain.example; @up-domain.example STILL sends (isolated hostKey!)
      await processDeliveryQueue(outageCtx, outageStartMs);
      assert.ok(outageSentIds.includes('sub_cb_eb'), 'Per-target email domain must NOT share failed domain breaker');
      // Trip webhook breaker on host-down (attempt 1, then attempt 2 at +200ms opens circuit for 3000ms)
      outageStartMs += 500;
      await processDeliveryQueue(outageCtx, outageStartMs);
      const breakerState = outageCtx.state.circuitBreakers.get('webhook:host-down.nostok-test.example');
      assert.ok(breakerState && breakerState.openUntilMs > outageStartMs, 'Webhook host circuit breaker must open');

      // While circuit is OPEN, running another cycle must reschedule WITHOUT incrementing attempts
      await notifCtx.notifDb.query(
        "UPDATE notif_deliveries SET next_attempt_at = $1 WHERE id = 'dlv_crit_outage'",
        [(outageStartMs + 100).toString()]
      );
      const attemptsBeforeOpen = Number(
        (
          await notifCtx.notifDb.query<{ attempts: number }>(
            "SELECT attempts FROM notif_deliveries WHERE id = 'dlv_crit_outage'"
          )
        ).rows[0].attempts
      );
      await processDeliveryQueue(outageCtx, outageStartMs + 200);
      const rowDuringOpen = (
        await notifCtx.notifDb.query<{ status: string; attempts: number }>(
          "SELECT status, attempts FROM notif_deliveries WHERE id = 'dlv_crit_outage'"
        )
      ).rows[0];
      assert.equal(rowDuringOpen.status, 'retry');
      assert.equal(
        Number(rowDuringOpen.attempts),
        attemptsBeforeOpen,
        'Open circuit breaker must reschedule WITHOUT incrementing attempts'
      );

      // Provider recovers after 3s outage -> critical alert is delivered!
      providerDown = false;
      outageStartMs += 3_500;
      await processDeliveryQueue(outageCtx, outageStartMs);
      const rowAfterRecover = (
        await notifCtx.notifDb.query<{ status: string }>(
          "SELECT status FROM notif_deliveries WHERE id = 'dlv_crit_outage'"
        )
      ).rows[0];
      assert.equal(rowAfterRecover.status, 'sent', 'Critical alert must succeed after short outage recovers');

      // Verify critical alert gets 6+ attempts before DLQ, then test POST /dead-letters/redrive
      providerDown = true;
      await notifCtx.notifDb.query(
        `INSERT INTO notif_deliveries (
           id, wallet, subscription_id, channel, alert_type, severity, dedup_key,
           title, message, payload_json, status, attempts, next_attempt_at, created_at
         ) VALUES (
           'dlv_crit_6_attempts', $1, 'sub_cb_a', 'webhook', 'liquidation_started', 'critical', 'crit_6_att',
           'crit6', 'crit6', '{}', 'pending', 0, $2, $2
         )`,
        [cbWallet, outageStartMs.toString()]
      );
      outageCtx.config.circuitBreakerCooldownMs = 50;
      outageCtx.config.circuitBreakerThreshold = 100;
      for (let step = 1; step <= 5; step++) {
        outageStartMs += 100_000;
        await processDeliveryQueue(outageCtx, outageStartMs);
        const r = (
          await notifCtx.notifDb.query<{ status: string; attempts: number }>(
            "SELECT status, attempts FROM notif_deliveries WHERE id = 'dlv_crit_6_attempts'"
          )
        ).rows[0];
        assert.equal(r.status, 'retry', `Critical attempt ${step}/6 must NOT dead-letter yet`);
        assert.equal(Number(r.attempts), step);
      }
      outageStartMs += 200_000;
      await processDeliveryQueue(outageCtx, outageStartMs);
      const r6 = (
        await notifCtx.notifDb.query<{ status: string; attempts: number }>(
          "SELECT status, attempts FROM notif_deliveries WHERE id = 'dlv_crit_6_attempts'"
        )
      ).rows[0];
      assert.equal(r6.status, 'dead_letter', 'Critical alert moves to DLQ only on 6th attempt');
      assert.equal(Number(r6.attempts), 6);

      // Admin redrive endpoint (wrong secret -> 401; valid x-admin-secret -> redrives cleanly and delivers on next run)
      const badRedrive = await httpJson(
        'POST',
        `${notifUrl}/dead-letters/redrive`,
        { delivery_ids: ['dlv_crit_6_attempts'] },
        { 'x-admin-secret': 'wrong-admin-secret-value-here' }
      );
      assert.equal(badRedrive.status, 401);

      const okRedrive = await httpJson<{ status: string; redriven_count: number; delivery_ids: string[] }>(
        'POST',
        `${notifUrl}/dead-letters/redrive`,
        { delivery_ids: ['dlv_crit_6_attempts'] },
        { 'x-admin-secret': adminSecret }
      );
      assert.equal(okRedrive.status, 200);
      assert.equal(okRedrive.body.redriven_count, 1);
      assert.deepEqual(okRedrive.body.delivery_ids, ['dlv_crit_6_attempts']);

      providerDown = false;
      await processDeliveryQueue(notifCtx, Date.now() + 1_000);
      const rRedriven = (
        await notifCtx.notifDb.query<{ status: string }>(
          "SELECT status FROM notif_deliveries WHERE id = 'dlv_crit_6_attempts'"
        )
      ).rows[0];
      assert.equal(rRedriven.status, 'sent', 'Redriven dead letter must deliver successfully');

      // 6.3 Stuck 'sending' row lease reclaim after worker crash
      const nowLeaseMs = Date.now() + 500_000;
      await notifCtx.notifDb.query(
        `INSERT INTO notif_deliveries (
           id, wallet, subscription_id, channel, alert_type, severity, dedup_key,
           title, message, payload_json, status, attempts, next_attempt_at, claimed_at, lease_until, created_at
         ) VALUES
           ('dlv_stuck_expired', $1, 'sub_cb_b', 'webhook', 'loan_repaid', 'info', 'stuck_exp_1',
            'stuck', 'stuck', '{}', 'sending', 0, $2, $2, $3, $2),
           ('dlv_sending_active', $1, 'sub_cb_b', 'webhook', 'loan_repaid', 'info', 'stuck_act_1',
            'active', 'active', '{}', 'sending', 0, $2, $4, $5, $2)`,
        [
          cbWallet,
          (nowLeaseMs - 200_000).toString(),
          (nowLeaseMs - 30_000).toString(),
          (nowLeaseMs - 10_000).toString(),
          (nowLeaseMs + 110_000).toString(),
        ]
      );
      const leaseSentTargets: string[] = [];
      await processDeliveryQueue(
        {
          ...notifCtx,
          state: { ...notifCtx.state, circuitBreakers: new Map() },
          transports: {
            async sendEmail() {},
            async sendTelegram() {},
            async sendWebhook(m) {
              leaseSentTargets.push(m.title);
            },
          },
        },
        nowLeaseMs
      );
      assert.equal(
        leaseSentTargets.includes('stuck'),
        true,
        'Expired sending lease must be reclaimed and delivered'
      );
      assert.equal(
        leaseSentTargets.includes('active'),
        false,
        'Non-expired sending lease must NOT be double-sent'
      );

      // 6.4 Confirm-code brute-force lockout (5 wrong attempts invalidates code) + separate confirmSecret check
      const bfKey = generatePrivateKey();
      const bfAcct = privateKeyToAccount(bfKey);
      const bfWallet = bfAcct.address;
      const bfNonce = await getNonce(bfWallet);
      const bfSiwe = formatSiweMessage({
        domain: 'app.nostok.xyz',
        address: bfWallet,
        uri: 'https://app.nostok.xyz',
        chainId: 8453,
        nonce: bfNonce,
        issuedAt: nowIso,
        expirationTime: futureIso,
      });
      const bfAuth = await httpJson<{ token: string }>('POST', `${notifUrl}/auth/verify`, {
        message: bfSiwe,
        signature: await bfAcct.signMessage({ message: bfSiwe }),
      });
      const bfTok = bfAuth.body.token;
      const bfSub = await httpJson<{ id: string }>(
        'POST',
        `${notifUrl}/subscriptions`,
        { channel: 'email', target: 'bruteforce-test@nostok.xyz' },
        { Authorization: `Bearer ${bfTok}` }
      );
      assert.equal(bfSub.status, 201);
      const bfEmailMsg = deliveredEmails.find((m) => m.subscriptionId === bfSub.body.id)!;
      const realCode = String(bfEmailMsg.payload.verification_code);

      // Token signed with unsubscribeSecret instead of confirmSecret must fail
      const forgedUnsubAsConfirm = signConfirmSubscriptionToken(
        unsubSecret,
        bfSub.body.id,
        bfWallet,
        '0'.repeat(64)
      );
      const badSecretConfirm = await httpJson('POST', `${notifUrl}/subscriptions/confirm`, {
        token: forgedUnsubAsConfirm,
      });
      assert.equal(badSecretConfirm.status, 400);

      for (let attempt = 1; attempt <= 5; attempt++) {
        const wrongCode = realCode === '999999' ? '888888' : '999999';
        const failTry = await httpJson(
          'POST',
          `${notifUrl}/subscriptions/confirm`,
          { subscription_id: bfSub.body.id, code: wrongCode },
          { Authorization: `Bearer ${bfTok}` }
        );
        assert.equal(failTry.status, 400);
      }
      // On 6th try even with the REAL code, it MUST remain invalidated/locked!
      const after5Wrong = await httpJson(
        'POST',
        `${notifUrl}/subscriptions/confirm`,
        { subscription_id: bfSub.body.id, code: realCode },
        { Authorization: `Bearer ${bfTok}` }
      );
      assert.equal(after5Wrong.status, 400, 'Verification code must be invalidated after 5 failed attempts');

      // 6.5 Quiet-hours drain counts hourly cap by sent_at/next_attempt_at & skips cleared stateful alerts + rate-limit drain
      const qCapKey = generatePrivateKey();
      const qCapAcct = privateKeyToAccount(qCapKey);
      const qCapWallet = qCapAcct.address.toLowerCase();
      const qCapNonce = await getNonce(qCapAcct.address);
      const qCapSiwe = formatSiweMessage({
        domain: 'app.nostok.xyz',
        address: qCapAcct.address,
        uri: 'https://app.nostok.xyz',
        chainId: 8453,
        nonce: qCapNonce,
        issuedAt: nowIso,
        expirationTime: futureIso,
      });
      const qCapTok = (
        await httpJson<{ token: string }>('POST', `${notifUrl}/auth/verify`, {
          message: qCapSiwe,
          signature: await qCapAcct.signMessage({ message: qCapSiwe }),
        })
      ).body.token;
      const qCapSub = await httpJson<{ id: string }>(
        'POST',
        `${notifUrl}/subscriptions`,
        { channel: 'webhook', target: 'https://hooks.nostok-test.example/qcap' },
        { Authorization: `Bearer ${qCapTok}` }
      );
      assert.equal(qCapSub.status, 201);
      await httpJson(
        'PUT',
        `${notifUrl}/preferences`,
        { quiet_hours_start: null, quiet_hours_end: null, max_per_hour: 2 },
        { Authorization: `Bearer ${qCapTok}` }
      );
      const drainBaseNow = Date.now() + 20_000_000;
      const oldQuietCreatedAt = drainBaseNow - 7_200_000; // 2h ago (> 1h)
      await notifCtx.notifDb.query(
        `INSERT INTO notif_deliveries (
           id, wallet, subscription_id, channel, alert_type, severity, dedup_key,
           title, message, payload_json, status, attempts, next_attempt_at, created_at
         ) VALUES
           ('dlv_q_cleared_mc', $1, $2, 'webhook', 'loan_margin_call', 'warning', 'margin_call:999:ep:1',
            'stale mc', 'stale mc', '{}', 'suppressed_quiet_hours', 0, $3, $3),
           ('dlv_q_evt_1', $1, $2, 'webhook', 'loan_repaid', 'info', 'q_evt_1',
            'e1', 'e1', '{}', 'suppressed_quiet_hours', 0, $3, $3),
           ('dlv_q_evt_2', $1, $2, 'webhook', 'loan_repaid', 'info', 'q_evt_2',
            'e2', 'e2', '{}', 'suppressed_quiet_hours', 0, $3, $3),
           ('dlv_q_evt_3', $1, $2, 'webhook', 'loan_repaid', 'info', 'q_evt_3',
            'e3', 'e3', '{}', 'suppressed_quiet_hours', 0, $3, $3),
           ('dlv_q_evt_4', $1, $2, 'webhook', 'loan_repaid', 'info', 'q_evt_4',
            'e4', 'e4', '{}', 'suppressed_quiet_hours', 0, $3, $3)`,
        [qCapWallet, qCapSub.body.id, oldQuietCreatedAt.toString()]
      );
      await runNotificationsCycle(notifCtx, drainBaseNow);
      const clearedRow = (
        await notifCtx.notifDb.query<{ status: string }>(
          "SELECT status FROM notif_deliveries WHERE id = 'dlv_q_cleared_mc'"
        )
      ).rows[0];
      assert.equal(
        clearedRow.status,
        'expired_cleared',
        'Cleared stateful condition from quiet hours must transition to expired_cleared instead of sending'
      );
      const qEvtRows1 = await notifCtx.notifDb.query<{ id: string; status: string }>(
        "SELECT id, status FROM notif_deliveries WHERE id LIKE 'dlv_q_evt_%' ORDER BY id ASC"
      );
      assert.equal(qEvtRows1.rows[0].status, 'sent');
      assert.equal(qEvtRows1.rows[1].status, 'sent');
      assert.equal(
        qEvtRows1.rows[2].status,
        'suppressed_rate_limit',
        '3rd drained row must be capped by max_per_hour = 2'
      );
      assert.equal(qEvtRows1.rows[3].status, 'suppressed_rate_limit');

      // Run 5 seconds later: rows 1 & 2 had sent_at = drainBaseNow so rows 3 & 4 STILL must wait!
      await runNotificationsCycle(notifCtx, drainBaseNow + 5_000);
      const qEvtRowsStill = await notifCtx.notifDb.query<{ status: string }>(
        "SELECT status FROM notif_deliveries WHERE id IN ('dlv_q_evt_3', 'dlv_q_evt_4')"
      );
      assert.ok(qEvtRowsStill.rows.every((r) => r.status === 'suppressed_rate_limit'));

      // Run > 1 hour later: budget opens up and delayed rate-limited events are drained & delivered!
      await runNotificationsCycle(notifCtx, drainBaseNow + 3_605_000);
      const qEvtRowsAfterHour = await notifCtx.notifDb.query<{ status: string }>(
        "SELECT status FROM notif_deliveries WHERE id IN ('dlv_q_evt_3', 'dlv_q_evt_4')"
      );
      assert.ok(
        qEvtRowsAfterHour.rows.every((r) => r.status === 'sent'),
        'Delayed suppressed_rate_limit event alerts must drain and send once hourly budget opens'
      );

      // 6.6 Email bombing protection (3/hour limit per canonical target normalized for +subaddress;
      // attackers from another IP cannot consume the legitimate victim's own quota)
      const bombProxySrv = createNotificationsServer({
        ...notifCtx,
        config: { ...notifCtx.config, trustProxyHops: 1 },
      });
      await new Promise<void>((r) => bombProxySrv.listen(0, '127.0.0.1', r));
      const bombUrl = `http://127.0.0.1:${(bombProxySrv.address() as net.AddressInfo).port}`;
      try {
        // Part A: Same wallet tries +subaddress normalization bypasses (victim-bomb+1..4@nostok.xyz -> 4th blocked 429)
        const plusKey = generatePrivateKey();
        const plusAcct = privateKeyToAccount(plusKey);
        const plusNonce = await getNonce(plusAcct.address);
        const plusSiwe = formatSiweMessage({
          domain: 'app.nostok.xyz',
          address: plusAcct.address,
          uri: 'https://app.nostok.xyz',
          chainId: 8453,
          nonce: plusNonce,
          issuedAt: nowIso,
          expirationTime: futureIso,
        });
        const plusTok = (
          await httpJson<{ token: string }>('POST', `${bombUrl}/auth/verify`, {
            message: plusSiwe,
            signature: await plusAcct.signMessage({ message: plusSiwe }),
          })
        ).body.token;
        for (let idx = 1; idx <= 4; idx++) {
          const pRes = await httpJson<{ error?: { code: string } }>(
            'POST',
            `${bombUrl}/subscriptions`,
            { channel: 'email', target: `victim-plus+${idx}@nostok.xyz` },
            { Authorization: `Bearer ${plusTok}`, 'X-Forwarded-For': '203.0.113.70' }
          );
          if (idx <= 3) {
            assert.equal(pRes.status, 201, `Normalized +subaddress ${idx}/3 should succeed`);
          } else {
            assert.equal(pRes.status, 429, '4th +subaddress email from same wallet must be rate-limited');
            assert.equal(pRes.body.error?.code, 'RATE_LIMIT_EXCEEDED');
          }
        }

        // Part B: Attacker at 198.51.100.55 rotates 4 wallets targeting real-victim@nostok.xyz -> attacker 4th blocked 429,
        // while legitimate victim at 203.0.113.88 STILL succeeds cleanly!
        for (let wIdx = 1; wIdx <= 4; wIdx++) {
          const wKey = generatePrivateKey();
          const wAcct = privateKeyToAccount(wKey);
          const wNonce = await getNonce(wAcct.address);
          const wSiwe = formatSiweMessage({
            domain: 'app.nostok.xyz',
            address: wAcct.address,
            uri: 'https://app.nostok.xyz',
            chainId: 8453,
            nonce: wNonce,
            issuedAt: nowIso,
            expirationTime: futureIso,
          });
          const wTok = (
            await httpJson<{ token: string }>('POST', `${bombUrl}/auth/verify`, {
              message: wSiwe,
              signature: await wAcct.signMessage({ message: wSiwe }),
            })
          ).body.token;
          const subRes = await httpJson<{ error?: { code: string } }>(
            'POST',
            `${bombUrl}/subscriptions`,
            { channel: 'email', target: `real-victim+spam${wIdx}@nostok.xyz` },
            { Authorization: `Bearer ${wTok}`, 'X-Forwarded-For': '198.51.100.55' }
          );
          if (wIdx <= 3) {
            assert.equal(subRes.status, 201);
          } else {
            assert.equal(subRes.status, 429, 'Attacker IP rotating wallets against target must hit 429');
          }
        }
        const realVictimKey = generatePrivateKey();
        const realVictimAcct = privateKeyToAccount(realVictimKey);
        const rvNonce = await getNonce(realVictimAcct.address);
        const rvSiwe = formatSiweMessage({
          domain: 'app.nostok.xyz',
          address: realVictimAcct.address,
          uri: 'https://app.nostok.xyz',
          chainId: 8453,
          nonce: rvNonce,
          issuedAt: nowIso,
          expirationTime: futureIso,
        });
        const rvTok = (
          await httpJson<{ token: string }>('POST', `${bombUrl}/auth/verify`, {
            message: rvSiwe,
            signature: await realVictimAcct.signMessage({ message: rvSiwe }),
          })
        ).body.token;
        const rvRes = await httpJson(
          'POST',
          `${bombUrl}/subscriptions`,
          { channel: 'email', target: 'real-victim@nostok.xyz' },
          { Authorization: `Bearer ${rvTok}`, 'X-Forwarded-For': '203.0.113.88' }
        );
        assert.equal(rvRes.status, 201, 'Other wallets from attacker IP must NOT consume legitimate victim quota');

        // Part C: Gmail dot normalization + googlemail.com alias + trailing domain dots + rotating IP/wallet global 10/h cap
        const gmailKey = generatePrivateKey();
        const gmailAcct = privateKeyToAccount(gmailKey);
        const gmailNonce = await getNonce(gmailAcct.address);
        const gmailSiwe = formatSiweMessage({
          domain: 'app.nostok.xyz',
          address: gmailAcct.address,
          uri: 'https://app.nostok.xyz',
          chainId: 8453,
          nonce: gmailNonce,
          issuedAt: nowIso,
          expirationTime: futureIso,
        });
        const gmailTok = (
          await httpJson<{ token: string }>('POST', `${bombUrl}/auth/verify`, {
            message: gmailSiwe,
            signature: await gmailAcct.signMessage({ message: gmailSiwe }),
          })
        ).body.token;
        const gmailVariants = [
          'a.b.c+one@gmail.com',
          'ab.c@googlemail.com.',
          'a.b.c@gmail.com.',
          'abc+four@googlemail.com',
        ];
        for (let gIdx = 0; gIdx < gmailVariants.length; gIdx++) {
          const gRes = await httpJson<{ error?: { code: string } }>(
            'POST',
            `${bombUrl}/subscriptions`,
            { channel: 'email', target: gmailVariants[gIdx] },
            { Authorization: `Bearer ${gmailTok}`, 'X-Forwarded-For': `203.0.114.${10 + gIdx}` }
          );
          if (gIdx < 3) {
            assert.equal(gRes.status, 201, `Gmail/googlemail canonical variant ${gIdx + 1}/3 should pass`);
          } else {
            assert.equal(
              gRes.status,
              429,
              '4th Gmail dot/googlemail/trailing-dot variant from same wallet must be blocked by per-wallet limiter'
            );
            assert.equal(gRes.body.error?.code, 'RATE_LIMIT_EXCEEDED');
          }
        }

        // Rotating 11 distinct wallets + 11 distinct IPs against one Gmail canonical target hits global 10/h cap
        const globalMax = notifCfg.confirmTargetGlobalPerHourMax;
        for (let rot = 1; rot <= globalMax + 1; rot++) {
          const rKey = generatePrivateKey();
          const rAcct = privateKeyToAccount(rKey);
          const rNonce = await getNonce(rAcct.address);
          const rSiwe = formatSiweMessage({
            domain: 'app.nostok.xyz',
            address: rAcct.address,
            uri: 'https://app.nostok.xyz',
            chainId: 8453,
            nonce: rNonce,
            issuedAt: nowIso,
            expirationTime: futureIso,
          });
          const rTok = (
            await httpJson<{ token: string }>('POST', `${bombUrl}/auth/verify`, {
              message: rSiwe,
              signature: await rAcct.signMessage({ message: rSiwe }),
            })
          ).body.token;
          const rotTarget =
            rot % 2 === 0 ? `bombed.target+${rot}@googlemail.com.` : `bombedtarget+r${rot}@gmail.com`;
          const rotRes = await httpJson<{ error?: { code: string } }>(
            'POST',
            `${bombUrl}/subscriptions`,
            { channel: 'email', target: rotTarget },
            { Authorization: `Bearer ${rTok}`, 'X-Forwarded-For': `198.51.101.${rot}` }
          );
          if (rot <= globalMax) {
            assert.equal(rotRes.status, 201, `Rotating IP+wallet ${rot}/${globalMax} allowed up to global cap`);
          } else {
            assert.equal(
              rotRes.status,
              429,
              'Rotating BOTH IPs and wallets must still hit the global canonical-target cap (10/h)'
            );
            assert.equal(rotRes.body.error?.code, 'RATE_LIMIT_EXCEEDED');
          }
        }

        // M1: Fresh zero-cost SIWE wallets (0 ETH, 0 nonce, 0 indexed history) CANNOT consume an "owner reserve"
        // to push past the 10/h global cap (closing the 13-request fresh-wallet lockout vector).
        for (let sybil = 12; sybil <= 15; sybil++) {
          const sKey = generatePrivateKey();
          const sAcct = privateKeyToAccount(sKey);
          const sNonce = await getNonce(sAcct.address);
          const sSiwe = formatSiweMessage({
            domain: 'app.nostok.xyz',
            address: sAcct.address,
            uri: 'https://app.nostok.xyz',
            chainId: 8453,
            nonce: sNonce,
            issuedAt: nowIso,
            expirationTime: futureIso,
          });
          const sTok = (
            await httpJson<{ token: string }>('POST', `${bombUrl}/auth/verify`, {
              message: sSiwe,
              signature: await sAcct.signMessage({ message: sSiwe }),
            })
          ).body.token;
          const sybilRes = await httpJson<{ error?: { code: string } }>(
            'POST',
            `${bombUrl}/subscriptions`,
            {
              channel: 'email',
              target: sybil % 2 === 0 ? 'bombed.target@gmail.com' : `bombed.target+extra${sybil}@gmail.com`,
            },
            { Authorization: `Bearer ${sTok}`, 'X-Forwarded-For': `198.51.101.${sybil}` }
          );
          assert.equal(sybilRes.status, 429, `Zero-cost sybil wallet #${sybil} must still hit 429`);
          assert.equal(sybilRes.body.error?.code, 'RATE_LIMIT_EXCEEDED');
        }

        // Meanwhile a legitimate wallet WITH on-chain sybil cost (ETH balance / tx / indexed history)
        // STILL succeeds for BOTH plain and +tag addresses even after 15 fresh-wallet+IP requests!
        const gmailVictimKey = generatePrivateKey();
        const gmailVictimAcct = privateKeyToAccount(gmailVictimKey);
        await fetch(LOCAL_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 99,
            method: 'anvil_setBalance',
            params: [gmailVictimAcct.address, '0xb1a2bc2ec50000'], // 0.05 ETH on Base fork
          }),
        });
        const gvNonce = await getNonce(gmailVictimAcct.address);
        const gvSiwe = formatSiweMessage({
          domain: 'app.nostok.xyz',
          address: gmailVictimAcct.address,
          uri: 'https://app.nostok.xyz',
          chainId: 8453,
          nonce: gvNonce,
          issuedAt: nowIso,
          expirationTime: futureIso,
        });
        const gvTok = (
          await httpJson<{ token: string }>('POST', `${bombUrl}/auth/verify`, {
            message: gvSiwe,
            signature: await gmailVictimAcct.signMessage({ message: gvSiwe }),
          })
        ).body.token;
        const isBombedTarget = (t: string) => {
          const low = t.toLowerCase();
          return low.startsWith('bombed.target') || low.startsWith('bombedtarget');
        };
        const beforeBombedCount = deliveredEmails.filter((m) => isBombedTarget(m.target)).length;
        assert.equal(
          beforeBombedCount,
          5,
          `Expected 5 emails delivered to canonical bombed.target before funded victim retry, got ${beforeBombedCount}`
        );
        for (const victimTarget of ['bombed.target@gmail.com', 'bombed.target+alerts@gmail.com']) {
          const gvSubRes = await httpJson<{ id: string; verified: boolean; verification_required?: boolean }>(
            'POST',
            `${bombUrl}/subscriptions`,
            { channel: 'email', target: victimTarget },
            { Authorization: `Bearer ${gvTok}`, 'X-Forwarded-For': '203.0.114.99' }
          );
          assert.equal(
            gvSubRes.status,
            201,
            `Wallet with sybil cost confirming ${victimTarget} must NOT be locked out (returns 201)`
          );
          assert.equal(gvSubRes.body.verification_required, true);
        }
        const afterBombedCount = deliveredEmails.filter((m) => isBombedTarget(m.target)).length;
        assert.equal(afterBombedCount, 5, 'Cross-wallet 24h cap must bound bombed.target deliveries to 5');

        // M2: GET with Accept: text/html returns interactive HTML <form method="POST"> confirm page (tested on unflooded targets)
        for (const cleanTarget of ['m2.confirm.plain@gmail.com', 'm2.confirm.tag+alerts@gmail.com']) {
          const gvSubRes = await httpJson<{ id: string; verified: boolean }>(
            'POST',
            `${bombUrl}/subscriptions`,
            { channel: 'email', target: cleanTarget },
            { Authorization: `Bearer ${gvTok}`, 'X-Forwarded-For': '203.0.114.99' }
          );
          assert.equal(gvSubRes.status, 201);
          const gvMsg = deliveredEmails.find((m) => m.subscriptionId === gvSubRes.body.id)!;
          assert.ok(gvMsg, 'Verification email for clean target must be delivered');
          assert.ok(gvMsg.message.includes('Not me, block this address:'), 'Sent email must include block link');
          const htmlConfirmPage = await fetch(String(gvMsg.payload.confirm_url), {
            headers: { Accept: 'text/html', 'X-Forwarded-For': '203.0.114.99' },
          });
          assert.equal(htmlConfirmPage.status, 200);
          assert.match(htmlConfirmPage.headers.get('content-type') ?? '', /text\/html/i);
          assert.ok(htmlConfirmPage.headers.get('content-security-policy'));
          const htmlConfirmBody = await htmlConfirmPage.text();
          assert.match(htmlConfirmBody, /<form[^>]*method="POST"/i);
          assert.match(htmlConfirmBody, /Confirm subscription/i);

          const gvConfirmRes = await httpJson<{ confirmed: boolean; verified: boolean }>(
            'POST',
            `${bombUrl}/subscriptions/confirm`,
            { token: String(gvMsg.payload.confirm_token) },
            { 'X-Forwarded-For': '203.0.114.99' }
          );
          assert.equal(gvConfirmRes.status, 200);
          assert.equal(gvConfirmRes.body.verified, true);
        }

        // Fix #3b: 4-wallet / 10-IP PoC against lockout.victim@nostok.xyz + "Not me, block this address" link
        const pocTokens: Array<{ address: string; token: string }> = [];
        for (let a = 0; a < 4; a++) {
          const aKey = generatePrivateKey();
          const aAcct = privateKeyToAccount(aKey);
          const aNonce = await getNonce(aAcct.address);
          const aSiwe = formatSiweMessage({
            domain: 'app.nostok.xyz',
            address: aAcct.address,
            uri: 'https://app.nostok.xyz',
            chainId: 8453,
            nonce: aNonce,
            issuedAt: nowIso,
            expirationTime: futureIso,
          });
          const aTok = (
            await httpJson<{ token: string }>('POST', `${bombUrl}/auth/verify`, {
              message: aSiwe,
              signature: await aAcct.signMessage({ message: aSiwe }),
            })
          ).body.token;
          pocTokens.push({ address: aAcct.address, token: aTok });
        }
        let firstSpamSubId = '';
        let pocBlockedResends = 0;
        for (let reqIdx = 0; reqIdx < 10; reqIdx++) {
          const att = pocTokens[reqIdx % 4];
          const pocRes = await httpJson<{ id?: string; error?: { code: string } }>(
            'POST',
            `${bombUrl}/subscriptions`,
            { channel: 'email', target: reqIdx % 2 === 0 ? 'lockout.victim@nostok.xyz' : `lockout.victim+p${reqIdx}@nostok.xyz` },
            { Authorization: `Bearer ${att.token}`, 'X-Forwarded-For': `198.51.102.${reqIdx + 1}` }
          );
          if (reqIdx === 0) {
            assert.equal(pocRes.status, 201);
            firstSpamSubId = String(pocRes.body.id);
          } else if (reqIdx >= 4 && pocRes.status === 429) {
            pocBlockedResends += 1;
          }
        }
        assert.ok(pocBlockedResends >= 1, '4-wallet/10-IP resend PoC must hit confirmTargetResendLimiter before filling 10/h cap');

        // "Not me, block this address" link: GET previews block (JSON & HTML), POST blocks sender wallet, deletes unverified sub, and persists across DELETE /user/data
        const spamMsg = deliveredEmails.find((m) => m.subscriptionId === firstSpamSubId)!;
        assert.ok(spamMsg.message.includes('Not me, block this address:'), 'Email message must contain block link');
        const blockHtmlPage = await fetch(String(spamMsg.payload.block_url), {
          headers: { Accept: 'text/html', 'X-Forwarded-For': '203.0.114.120' },
        });
        assert.equal(blockHtmlPage.status, 200);
        const blockHtmlText = await blockHtmlPage.text();
        assert.match(blockHtmlText, /Block this wallet only/i);
        assert.match(blockHtmlText, /Block this address entirely/i);
        assert.match(blockHtmlText, /does NOT stop existing verified subscriptions/i);
        const blockPreview = await httpJson<{
          confirmation_required: boolean;
          method: string;
          subscription_id: string;
          blocked_wallet: string;
          stops_existing_verified_subscriptions: boolean;
          note: string;
        }>('GET', String(spamMsg.payload.block_url), undefined, { 'X-Forwarded-For': '203.0.114.120' });
        assert.equal(blockPreview.status, 200);
        assert.equal(blockPreview.body.confirmation_required, true);
        assert.equal(blockPreview.body.method, 'POST');
        assert.equal(blockPreview.body.blocked_wallet.toLowerCase(), pocTokens[0].address.toLowerCase());
        assert.equal(blockPreview.body.stops_existing_verified_subscriptions, false);
        assert.match(blockPreview.body.note, /does NOT stop existing verified subscriptions/i);

        // Item 5: Default block token TTL must be 24h (86_400s)
        const defaultBlockTok = signBlockSenderToken('test-secret', 'sub-ttl', pocTokens[0].address, 'cth', undefined, 1_700_000_000_000);
        assert.equal(verifyBlockSenderToken('test-secret', defaultBlockTok, 1_700_000_000_000).exp, 1_700_000_000 + 86_400);

        const blockExec = await httpJson<{
          blocked: boolean;
          subscription_id: string;
          blocked_wallet: string;
          stops_existing_verified_subscriptions: boolean;
          note: string;
        }>(
          'POST',
          `${bombUrl}/subscriptions/block`,
          { token: String(spamMsg.payload.block_token) },
          { 'X-Forwarded-For': '203.0.114.120' }
        );
        assert.equal(blockExec.status, 200);
        assert.equal(blockExec.body.blocked, true);
        assert.equal(blockExec.body.stops_existing_verified_subscriptions, false);
        assert.match(blockExec.body.note, /does NOT stop existing verified subscriptions/i);

        // Item 5: Single-use block token cannot be replayed on GET or POST
        const replayBlockGet = await httpJson<{ error?: { code: string } }>(
          'GET',
          String(spamMsg.payload.block_url),
          undefined,
          { 'X-Forwarded-For': '203.0.114.120' }
        );
        assert.equal(replayBlockGet.status, 400);
        assert.equal(replayBlockGet.body.error?.code, 'BLOCK_TOKEN_ALREADY_USED');
        const replayBlockPost = await httpJson<{ error?: { code: string } }>(
          'POST',
          `${bombUrl}/subscriptions/block`,
          { token: String(spamMsg.payload.block_token) },
          { 'X-Forwarded-For': '203.0.114.120' }
        );
        assert.equal(replayBlockPost.status, 400);
        assert.equal(replayBlockPost.body.error?.code, 'BLOCK_TOKEN_ALREADY_USED');

        const blockedRetry = await httpJson<{ error?: { code: string } }>(
          'POST',
          `${bombUrl}/subscriptions`,
          { channel: 'email', target: 'lockout.victim+retry@nostok.xyz' },
          { Authorization: `Bearer ${pocTokens[0].token}`, 'X-Forwarded-For': '203.0.114.121' }
        );
        assert.equal(blockedRetry.status, 403);
        assert.equal(blockedRetry.body.error?.code, 'SENDER_BLOCKED_BY_RECIPIENT');

        // Attacker calling DELETE /user/data cannot unblock themselves
        const delDataRes = await httpJson(
          'DELETE',
          `${bombUrl}/user/data`,
          undefined,
          { Authorization: `Bearer ${pocTokens[0].token}`, 'X-Forwarded-For': '203.0.114.122' }
        );
        assert.equal(delDataRes.status, 200);
        const blockedAfterDel = await httpJson<{ error?: { code: string } }>(
          'POST',
          `${bombUrl}/subscriptions`,
          { channel: 'email', target: 'lockout.victim@nostok.xyz' },
          { Authorization: `Bearer ${pocTokens[0].token}`, 'X-Forwarded-For': '203.0.114.123' }
        );
        assert.equal(blockedAfterDel.status, 403);
        assert.equal(blockedAfterDel.body.error?.code, 'SENDER_BLOCKED_BY_RECIPIENT');

        // M2: "Block this address entirely" (scope: 'target_all') opts out target across ALL wallets forever
        const optOutSenderKey = generatePrivateKey();
        const optOutSenderAcct = privateKeyToAccount(optOutSenderKey);
        const ooNonce = await getNonce(optOutSenderAcct.address);
        const ooSiwe = formatSiweMessage({
          domain: 'app.nostok.xyz',
          address: optOutSenderAcct.address,
          uri: 'https://app.nostok.xyz',
          chainId: 8453,
          nonce: ooNonce,
          issuedAt: nowIso,
          expirationTime: futureIso,
        });
        const ooTok = (
          await httpJson<{ token: string }>('POST', `${bombUrl}/auth/verify`, {
            message: ooSiwe,
            signature: await optOutSenderAcct.signMessage({ message: ooSiwe }),
          })
        ).body.token;
        const ooSub = await httpJson<{ id: string }>(
          'POST',
          `${bombUrl}/subscriptions`,
          { channel: 'email', target: 'optout.victim@nostok.xyz' },
          { Authorization: `Bearer ${ooTok}`, 'X-Forwarded-For': '203.0.114.140' }
        );
        assert.equal(ooSub.status, 201);
        const ooMsg = deliveredEmails.find((m) => m.subscriptionId === ooSub.body.id)!;
        const blockAllExec = await httpJson<{
          blocked: boolean;
          scope: string;
          block_all: boolean;
          deleted_pending_count: number;
        }>(
          'POST',
          `${bombUrl}/subscriptions/block`,
          { token: String(ooMsg.payload.block_token), scope: 'target_all', block_all: true },
          { 'X-Forwarded-For': '203.0.114.141' }
        );
        assert.equal(blockAllExec.status, 200);
        assert.equal(blockAllExec.body.blocked, true);
        assert.equal(blockAllExec.body.scope, 'target_all');
        assert.equal(blockAllExec.body.block_all, true);
        assert.ok(blockAllExec.body.deleted_pending_count >= 1);

        // Even the funded sybil-cost wallet cannot subscribe to optout.victim@nostok.xyz or +plus variants now!
        const optedOutRetry = await httpJson<{ error?: { code: string } }>(
          'POST',
          `${bombUrl}/subscriptions`,
          { channel: 'email', target: 'optout.victim+any@nostok.xyz' },
          { Authorization: `Bearer ${gvTok}`, 'X-Forwarded-For': '203.0.114.142' }
        );
        assert.equal(optedOutRetry.status, 403);
        assert.equal(optedOutRetry.body.error?.code, 'TARGET_OPTED_OUT');

        // Legitimate funded victim STILL receives 201 (never 429) on lockout.victim after 5/24h cap,
        // and no >5 emails are ever sent to lockout.victim; clean funded target confirms normally
        const pocVictimKey = generatePrivateKey();
        const pocVictimAcct = privateKeyToAccount(pocVictimKey);
        await fetch(LOCAL_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 100,
            method: 'anvil_setBalance',
            params: [pocVictimAcct.address, '0xb1a2bc2ec50000'],
          }),
        });
        const pvNonce = await getNonce(pocVictimAcct.address);
        const pvSiwe = formatSiweMessage({
          domain: 'app.nostok.xyz',
          address: pocVictimAcct.address,
          uri: 'https://app.nostok.xyz',
          chainId: 8453,
          nonce: pvNonce,
          issuedAt: nowIso,
          expirationTime: futureIso,
        });
        const pvTok = (
          await httpJson<{ token: string }>('POST', `${bombUrl}/auth/verify`, {
            message: pvSiwe,
            signature: await pocVictimAcct.signMessage({ message: pvSiwe }),
          })
        ).body.token;
        const pvSub = await httpJson<{ id: string; verification_required?: boolean }>(
          'POST',
          `${bombUrl}/subscriptions`,
          { channel: 'email', target: 'lockout.victim@nostok.xyz' },
          { Authorization: `Bearer ${pvTok}`, 'X-Forwarded-For': '203.0.114.125' }
        );
        assert.equal(pvSub.status, 201);
        assert.equal(pvSub.body.verification_required, true);
        const lockoutDelivered = deliveredEmails.filter((m) =>
          m.target.toLowerCase().startsWith('lockout.victim')
        );
        assert.ok(lockoutDelivered.length <= 5, `lockout.victim emails must be <= 5, got ${lockoutDelivered.length}`);
        const pvCleanSub = await httpJson<{ id: string }>(
          'POST',
          `${bombUrl}/subscriptions`,
          { channel: 'email', target: 'clean.funded.victim@nostok.xyz' },
          { Authorization: `Bearer ${pvTok}`, 'X-Forwarded-For': '203.0.114.125' }
        );
        assert.equal(pvCleanSub.status, 201);
        const pvMsg = deliveredEmails.find((m) => m.subscriptionId === pvCleanSub.body.id)!;
        const pvConfirm = await httpJson<{ confirmed: boolean; verified: boolean }>(
          'POST',
          `${bombUrl}/subscriptions/confirm`,
          { token: String(pvMsg.payload.confirm_token) },
          { 'X-Forwarded-For': '203.0.114.125' }
        );
        assert.equal(pvConfirm.status, 200);
        assert.equal(pvConfirm.body.verified, true);
      } finally {
        await new Promise<void>((r) => bombProxySrv.close(() => r()));
      }

      // Item 4: 40 one-wei wallets + self-verified inbox bypass rejected past 10/h cap; 0.01 ETH threshold + cache + RPC-down strict fallback
      let sybilGetBalanceCalls = 0;
      let sybilForceRpcDown = false;
      const instrumentedNotifPublicClient = new Proxy(notifCtx.publicClient, {
        get(target, prop, receiver) {
          if (prop === 'getBalance') {
            return async (args: { address: Address }) => {
              sybilGetBalanceCalls += 1;
              if (sybilForceRpcDown) {
                throw new Error('Simulated RPC outage');
              }
              return target.getBalance(args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const sybilSrv = createNotificationsServer({
        ...notifCtx,
        publicClient: instrumentedNotifPublicClient,
        config: {
          ...notifCtx.config,
          trustProxyHops: 1,
          rateLimitMax: 5000,
          authNonceRateLimitMax: 5000,
          authVerifyRateLimitMax: 5000,
          subscriptionsRateLimitMax: 5000,
          confirmTargetGlobalPerHourMax: 10,
        },
      });
      await new Promise<void>((r) => sybilSrv.listen(0, '127.0.0.1', r));
      const sybilUrl = `http://127.0.0.1:${(sybilSrv.address() as net.AddressInfo).port}`;
      try {
        const authAtSybil = async (acct: ReturnType<typeof privateKeyToAccount>, ip: string) => {
          const nRes = await httpJson<{ nonce: string }>(
            'POST',
            `${sybilUrl}/auth/nonce`,
            { wallet_address: acct.address },
            { 'X-Forwarded-For': ip }
          );
          const msg = formatSiweMessage({
            domain: 'app.nostok.xyz',
            address: acct.address,
            uri: 'https://app.nostok.xyz',
            chainId: 8453,
            nonce: nRes.body.nonce,
            issuedAt: nowIso,
            expirationTime: futureIso,
          });
          const vRes = await httpJson<{ token: string }>(
            'POST',
            `${sybilUrl}/auth/verify`,
            { message: msg, signature: await acct.signMessage({ message: msg }) },
            { 'X-Forwarded-For': ip }
          );
          return vRes.body.token;
        };

        // Self-verified decoy inbox on a 1-wei wallet must NOT bypass sybil cost
        const oneWeiVerifiedAcct = privateKeyToAccount(generatePrivateKey());
        await fetch(LOCAL_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 201,
            method: 'anvil_setBalance',
            params: [oneWeiVerifiedAcct.address, '0x1'],
          }),
        });
        const oneWeiVerifiedTok = await authAtSybil(oneWeiVerifiedAcct, '198.51.150.1');
        const decoySub = await httpJson<{ id: string }>(
          'POST',
          `${sybilUrl}/subscriptions`,
          { channel: 'email', target: 'decoy.selfverified@nostok.xyz' },
          { Authorization: `Bearer ${oneWeiVerifiedTok}`, 'X-Forwarded-For': '198.51.150.1' }
        );
        assert.equal(decoySub.status, 201);
        const decoyMsg = deliveredEmails.find((m) => m.subscriptionId === decoySub.body.id)!;
        const decoyConfirm = await httpJson('POST', `${sybilUrl}/subscriptions/confirm`, {
          token: String(decoyMsg.payload.confirm_token),
        });
        assert.equal(decoyConfirm.status, 200);

        // 40 rotating 1-wei wallets + rotating IPs (plus the self-verified 1-wei wallet): at most 10 emails sent!
        let oneWeiAllowed = 0;
        let oneWeiRejected = 0;
        for (let i = 0; i < 40; i++) {
          const ip = `198.51.151.${i + 1}`;
          let tok = oneWeiVerifiedTok;
          if (i > 0) {
            const wAcct = privateKeyToAccount(generatePrivateKey());
            await fetch(LOCAL_RPC_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 210 + i,
                method: 'anvil_setBalance',
                params: [wAcct.address, '0x1'],
              }),
            });
            tok = await authAtSybil(wAcct, ip);
          }
          const subRes = await httpJson<{ error?: { code: string } }>(
            'POST',
            `${sybilUrl}/subscriptions`,
            { channel: 'email', target: `forty.onewei+${i}@gmail.com` },
            { Authorization: `Bearer ${tok}`, 'X-Forwarded-For': ip }
          );
          if (subRes.status === 201) {
            oneWeiAllowed += 1;
          } else {
            assert.equal(subRes.status, 429);
            assert.equal(subRes.body.error?.code, 'RATE_LIMIT_EXCEEDED');
            oneWeiRejected += 1;
          }
        }
        assert.equal(oneWeiAllowed, 10, '40 one-wei + self-verified wallets must be capped at 10 global sends');
        assert.equal(oneWeiRejected, 30, 'All 30 remaining one-wei sends past 10 must return 429');

        // Wallet with >= MIN_SYBIL_COST_ETH_WEI (0.01 ETH) succeeds despite empty zero-cost cap & caches getBalance
        const fundedSybilAcct = privateKeyToAccount(generatePrivateKey());
        await fetch(LOCAL_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 260,
            method: 'anvil_setBalance',
            params: [fundedSybilAcct.address, `0x${MIN_SYBIL_COST_ETH_WEI.toString(16)}`],
          }),
        });
        const fundedTok = await authAtSybil(fundedSybilAcct, '198.51.152.10');
        sybilGetBalanceCalls = 0;
        const fundSub1 = await httpJson(
          'POST',
          `${sybilUrl}/subscriptions`,
          { channel: 'email', target: 'forty.onewei@gmail.com' },
          { Authorization: `Bearer ${fundedTok}`, 'X-Forwarded-For': '198.51.152.10' }
        );
        const fundSub2 = await httpJson(
          'POST',
          `${sybilUrl}/subscriptions`,
          { channel: 'email', target: 'forty.onewei+vip@gmail.com' },
          { Authorization: `Bearer ${fundedTok}`, 'X-Forwarded-For': '198.51.152.11' }
        );
        assert.equal(fundSub1.status, 201);
        assert.equal(fundSub2.status, 201);
        assert.equal(sybilGetBalanceCalls, 1, 'Sybil ETH balance check must be cached across requests within TTL');

        // Low fix: Moving 0.01 ETH across 30 wallets/IPs x 3 requests (90 sends total) against one victim:
        // all 90 return generic 201 (never 429), strictly 5 emails delivered per 24h, every email retains block link,
        // and a legitimate ETH-holding victim afterward still sees generic 201 (never locked out)!
        const emailsBefore90 = deliveredEmails.length;
        for (let hop = 0; hop < 30; hop++) {
          const hopAcct = privateKeyToAccount(generatePrivateKey());
          await fetch(LOCAL_RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 270 + hop,
              method: 'anvil_setBalance',
              params: [hopAcct.address, `0x${MIN_SYBIL_COST_ETH_WEI.toString(16)}`],
            }),
          });
          const hopIp = `198.51.154.${hop + 1}`;
          const hopTok = await authAtSybil(hopAcct, hopIp);
          for (let shot = 0; shot < 3; shot++) {
            const hopRes = await httpJson<{ verification_required?: boolean }>(
              'POST',
              `${sybilUrl}/subscriptions`,
              {
                channel: 'email',
                target: shot === 0 ? 'bomb90.victim@gmail.com' : `bomb90.victim+w${hop}s${shot}@gmail.com`,
              },
              { Authorization: `Bearer ${hopTok}`, 'X-Forwarded-For': hopIp }
            );
            assert.equal(
              hopRes.status,
              201,
              `0.01 ETH wallet #${hop} shot #${shot} must receive generic 201 (never 429)`
            );
            assert.equal(hopRes.body.verification_required, true);
          }
        }
        const bomb90Emails = deliveredEmails.slice(emailsBefore90);
        assert.equal(bomb90Emails.length, 5, '90 verification attempts across 30 0.01 ETH wallets must send strictly 5 emails');
        for (const sent of bomb90Emails) {
          assert.ok(
            sent.message.includes('Not me, block this address:'),
            'Every delivered verification email must contain "Not me, block this address:" block link'
          );
          assert.ok(String(sent.payload.block_url).includes('/subscriptions/block?token='));
        }
        const hopVictimAcct = privateKeyToAccount(generatePrivateKey());
        await fetch(LOCAL_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 299,
            method: 'anvil_setBalance',
            params: [hopVictimAcct.address, '0xb1a2bc2ec50000'], // 0.05 ETH
          }),
        });
        const hopVictimTok = await authAtSybil(hopVictimAcct, '203.0.115.77');
        const hopVictimRes = await httpJson<{ verification_required?: boolean }>(
          'POST',
          `${sybilUrl}/subscriptions`,
          { channel: 'email', target: 'bomb90.victim@gmail.com' },
          { Authorization: `Bearer ${hopVictimTok}`, 'X-Forwarded-For': '203.0.115.77' }
        );
        assert.equal(
          hopVictimRes.status,
          201,
          'Legitimate ETH-holding victim must NEVER see 429 lockout even after 90 attacker sends'
        );
        assert.equal(deliveredEmails.length - emailsBefore90, 5, 'No extra email past 5/24h cap');

        // When RPC is down, funded uncached wallet falls back strictly to 10/h global cap -> 429
        sybilForceRpcDown = true;
        const rpcDownFundedAcct = privateKeyToAccount(generatePrivateKey());
        await fetch(LOCAL_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 261,
            method: 'anvil_setBalance',
            params: [rpcDownFundedAcct.address, `0x${MIN_SYBIL_COST_ETH_WEI.toString(16)}`],
          }),
        });
        const rpcDownTok = await authAtSybil(rpcDownFundedAcct, '198.51.153.1');
        const rpcDownRes = await httpJson<{ error?: { code: string } }>(
          'POST',
          `${sybilUrl}/subscriptions`,
          { channel: 'email', target: 'forty.onewei+rpcdown@gmail.com' },
          { Authorization: `Bearer ${rpcDownTok}`, 'X-Forwarded-For': '198.51.153.1' }
        );
        assert.equal(rpcDownRes.status, 429, 'When RPC is down, strict global cap must still reject once full');
        assert.equal(rpcDownRes.body.error?.code, 'RATE_LIMIT_EXCEEDED');
      } finally {
        sybilForceRpcDown = false;
        await new Promise<void>((r) => sybilSrv.close(() => r()));
      }

      // 6.7 No pre-auth login lockout across IPs
      const victimKey = generatePrivateKey();
      const victimAcct = privateKeyToAccount(victimKey);
      const attackerKey = generatePrivateKey();
      const attackerAcct = privateKeyToAccount(attackerKey);
      const loginDosSrv = createNotificationsServer({
        ...notifCtx,
        config: {
          ...notifCtx.config,
          trustProxyHops: 1,
          authNonceRateLimitMax: 2,
          authVerifyRateLimitMax: 2,
        },
      });
      await new Promise<void>((r) => loginDosSrv.listen(0, '127.0.0.1', r));
      const loginDosUrl = `http://127.0.0.1:${(loginDosSrv.address() as net.AddressInfo).port}`;
      try {
        // Attacker at IP 198.51.100.10 spams /auth/nonce & bad /auth/verify naming victim address
        for (let k = 0; k < 4; k++) {
          await httpJson(
            'POST',
            `${loginDosUrl}/auth/nonce`,
            { wallet_address: victimAcct.address },
            { 'X-Forwarded-For': '198.51.100.10' }
          );
          const forgedSiwe = formatSiweMessage({
            domain: 'app.nostok.xyz',
            address: victimAcct.address,
            uri: 'https://app.nostok.xyz',
            chainId: 8453,
            nonce: 'nonexistent' + String(k).padStart(8, '0'),
            issuedAt: nowIso,
            expirationTime: futureIso,
          });
          await httpJson(
            'POST',
            `${loginDosUrl}/auth/verify`,
            {
              message: forgedSiwe,
              signature: await attackerAcct.signMessage({ message: forgedSiwe }),
            },
            { 'X-Forwarded-For': '198.51.100.10' }
          );
        }

        // Legitimate victim at IP 203.0.113.20 MUST still be able to request nonce & log in cleanly!
        const victimNonceRes = await httpJson<{ nonce: string }>(
          'POST',
          `${loginDosUrl}/auth/nonce`,
          { wallet_address: victimAcct.address },
          { 'X-Forwarded-For': '203.0.113.20' }
        );
        assert.equal(victimNonceRes.status, 200, 'Victim /auth/nonce from clean IP must NOT be locked out by attacker');
        const victimSiwe = formatSiweMessage({
          domain: 'app.nostok.xyz',
          address: victimAcct.address,
          uri: 'https://app.nostok.xyz',
          chainId: 8453,
          nonce: victimNonceRes.body.nonce,
          issuedAt: nowIso,
          expirationTime: futureIso,
        });
        const victimVerifyRes = await httpJson<{ token: string }>(
          'POST',
          `${loginDosUrl}/auth/verify`,
          {
            message: victimSiwe,
            signature: await victimAcct.signMessage({ message: victimSiwe }),
          },
          { 'X-Forwarded-For': '203.0.113.20' }
        );
        assert.equal(victimVerifyRes.status, 200, 'Victim /auth/verify from clean IP must NOT be locked out by attacker');
        assert.ok(victimVerifyRes.body.token);
      } finally {
        await new Promise<void>((r) => loginDosSrv.close(() => r()));
      }

      // 6.8 Dual-stack DNS (A + AAAA succeeds and pins A IP), 192.88.99.0/24 blocked, non-443 port blocked
      const dualResolved = await resolveAndValidateWebhookTarget(
        'https://dualstack.nostok-test.example/hook',
        mockDnsLookup
      );
      assert.equal(dualResolved.pinnedIp, '93.184.216.34', 'Dual-stack A + AAAA host must succeed and pin IPv4 A record');
      assert.throws(() => validateChannelTarget('webhook', 'https://192.88.99.1/hook'), /blocked/i);
      assert.throws(
        () => validateChannelTarget('webhook', 'https://hooks.nostok-test.example:8443/hook'),
        /port 8443 is not allowed/i
      );

      // 6.9 AuctionCancelled alert + oracle_stale clear damping + PGlite/adapter statement_timeout
      // Open a real on-chain loan for ADDRESSES.borrower (whose prior data was wiped in 5E) and re-subscribe webhook
      const dampLoanId = await openLoan(600_000_000n, 14);
      await runIndexerSync(idxCtx);
      const acHook = notifCtx.cipher.encrypt('https://hooks.nostok-test.example/ac');
      await notifCtx.notifDb.query(
        `INSERT INTO notif_subscriptions (id, wallet, channel, target_ciphertext, key_id, target_hash, enabled, verified)
         VALUES ('sub_ac_1', $1, 'webhook', $2, $3, 'ac_h_1', TRUE, TRUE)`,
        [ADDRESSES.borrower.toLowerCase(), acHook.ciphertext, acHook.keyId]
      );
      const acDeliveries: NotificationOutboundMessage[] = [];
      const dampingCtx: typeof notifCtx = {
        ...notifCtx,
        config: { ...notifCtx.config, episodeClearDampingMs: 30_000 },
        state: { ...notifCtx.state, circuitBreakers: new Map() },
        transports: {
          async sendEmail() {},
          async sendTelegram() {},
          async sendWebhook(m) {
            acDeliveries.push(m);
          },
        },
      };
      // Insert AuctionCancelled event linked to real open dampLoanId into indexer DB
      await idxCtx.db.query(
        `INSERT INTO loan_events (
           block_number, block_hash, tx_hash, log_index, contract_address, event_name, loan_id, payload, block_timestamp
         ) VALUES (999999999, '0xdead', '0xabc', 0, $1, 'AuctionCancelled', $2, $3, 1700000000)`,
        [deployed.liquidationAuction.toLowerCase(), dampLoanId.toString(), JSON.stringify({ auctionId: '777' })]
      );
      const dampT0 = drainBaseNow + 3_700_000;
      await runNotificationsCycle(dampingCtx, dampT0);
      assert.ok(
        acDeliveries.some(
          (m) =>
            m.wallet.toLowerCase() === ADDRESSES.borrower.toLowerCase() &&
            m.alertType === 'auction_cancelled' &&
            String(m.payload.loan_id) === dampLoanId.toString()
        ),
        'AuctionCancelled event must emit auction_cancelled alert'
      );

      // Episode clear damping check on oracle_stale:
      // 1) Trigger oracle_stale via synthetic Risk API state
      const dampRiskAlerts: Array<{
        dedup_key: string;
        category: string;
        severity: string;
        status: string;
        title: string;
        message: string;
        details: Record<string, unknown>;
      }> = [
        {
          dedup_key: `oracle_stale:${nvdac.toLowerCase()}`,
          category: 'oracle',
          severity: 'warning',
          status: 'active',
          title: 'Stale oracle',
          message: 'Stale',
          details: { token: nvdac.toLowerCase() },
        },
      ];
      const dampMockSrv = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.startsWith('/risk/loans')) {
          res.end(JSON.stringify({ data: [], pagination: { has_more: false } }));
        } else {
          res.end(JSON.stringify({ data: dampRiskAlerts }));
        }
      });
      await new Promise<void>((r) => dampMockSrv.listen(0, '127.0.0.1', r));
      const dampMockPort = (dampMockSrv.address() as net.AddressInfo).port;
      try {
        dampingCtx.config.riskApiUrl = `http://127.0.0.1:${dampMockPort}`;
        await runNotificationsCycle(dampingCtx, dampT0 + 1_000); // triggers :ep:1
        const countEp1 = acDeliveries.filter((m) => m.alertType === 'oracle_stale').length;
        assert.ok(countEp1 >= 1, 'Expected at least 1 oracle_stale episode-1 delivery');

        // Clear for only 5s (< 30s damping), then flap back to stale -> MUST NOT fire :ep:2!
        dampRiskAlerts.length = 0;
        await runNotificationsCycle(dampingCtx, dampT0 + 6_000); // stamps clear_since = dampT0 + 6_000
        dampRiskAlerts.push({
          dedup_key: `oracle_stale:${nvdac.toLowerCase()}`,
          category: 'oracle',
          severity: 'warning',
          status: 'active',
          title: 'Stale oracle',
          message: 'Stale again',
          details: { token: nvdac.toLowerCase() },
        });
        await runNotificationsCycle(dampingCtx, dampT0 + 11_000);
        assert.equal(
          acDeliveries.filter((m) => m.alertType === 'oracle_stale').length,
          countEp1,
          'Brief clear shorter than episodeClearDampingMs must NOT emit duplicate episode alert'
        );

        // Now stay continuously clear past 30s damping window -> re-arms -> next stale sends :ep:2!
        dampRiskAlerts.length = 0;
        await runNotificationsCycle(dampingCtx, dampT0 + 15_000); // stamps clear_since = dampT0 + 15_000
        await runNotificationsCycle(dampingCtx, dampT0 + 46_000); // 31s >= 30s -> clears active=FALSE
        dampRiskAlerts.push({
          dedup_key: `oracle_stale:${nvdac.toLowerCase()}`,
          category: 'oracle',
          severity: 'warning',
          status: 'active',
          title: 'Stale oracle 2',
          message: 'Genuine new stale',
          details: { token: nvdac.toLowerCase() },
        });
        await runNotificationsCycle(dampingCtx, dampT0 + 50_000);
        assert.equal(
          acDeliveries.filter((m) => m.alertType === 'oracle_stale').length,
          countEp1 * 2,
          'Continuous clear >= episodeClearDampingMs must re-arm new episode'
        );
      } finally {
        dampingCtx.config.riskApiUrl = riskApiUrl;
        await new Promise<void>((r) => dampMockSrv.close(() => r()));
      }

      // Statement timeout check on PGlite read-only indexer adapter + slow mock queryable
      const roIdxPglite = await openReadOnlyIndexerDatabase('memory://', { statementTimeoutMs: 60 });
      try {
        const stRes = await roIdxPglite.query<{ st: string }>(
          "SELECT current_setting('statement_timeout') AS st"
        );
        assert.equal(stRes.rows[0].st, '60ms');
      } finally {
        await roIdxPglite.close();
      }
      const slowIdxRo = wrapIndexerQueryableAsReadOnly(
        {
          async query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
            if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'COMMIT' || sql === 'ROLLBACK') {
              return { rows: [] };
            }
            await new Promise((r) => setTimeout(r, 200));
            return { rows: [] };
          },
        },
        { statementTimeoutMs: 40 }
      );
      await assert.rejects(() => slowIdxRo.query('SELECT 1 AS ok'), /statement_timeout/i);

      console.log('PASS TEST 6: All Phase 2 hardening fixes & low-priority safeguards verified.');
      console.log('\nALL WS2.6 USER NOTIFICATIONS BASE MAINNET FORK INTEGRATION TESTS PASSED.');
    } finally {
      await new Promise<void>((r) => notifServer.close(() => r()));
      await new Promise<void>((r) => riskServer.close(() => r()));
      await new Promise<void>((r) => webhookReceiver.close(() => r()));
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
  console.error('\nNOTIFICATIONS FORK TEST FAILED:', err);
  process.exit(1);
});
