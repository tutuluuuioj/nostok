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
  resolveAndValidateWebhookTarget,
  validateChannelTarget,
} from '../src/channels.js';
import { loadNotificationsConfig } from '../src/config.js';
import {
  PiiCipher,
  verifyWebhookPayloadSignature,
} from '../src/crypto.js';
import {
  assertNotifTableSql,
  assertReadOnlySql,
  wrapIndexerQueryableAsReadOnly,
} from '../src/db.js';
import { createNotificationsContext, runNotificationsCycle } from '../src/engine.js';
import { createNotificationsServer } from '../src/server.js';
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
      return [{ address: '93.184.216.35', family: 4 }];
    };

    const key1 = crypto.randomBytes(32).toString('hex');
    const key2 = crypto.randomBytes(32).toString('hex');
    const unsubSecret = crypto.randomBytes(32).toString('hex');
    const sessionSecret = crypto.randomBytes(32).toString('hex');
    const piiHashSecret = crypto.randomBytes(32).toString('hex');
    const webhookSigningSecret = crypto.randomBytes(32).toString('hex');

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
      sessionSecret,
      piiHashSecret,
      webhookSigningSecret,
      publicBaseUrl: 'http://127.0.0.1:3003',
      corsOrigins: ['https://app.nostok.xyz'],
      maxDeliveryAttempts: 3,
      retryBaseMs: 100,
      userRateLimitPerHour: 200,
      maxSubscriptionsPerWallet: 5,
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
      dlqTime += 5_000;
      await runNotificationsCycle(notifCtx, dlqTime); // attempt 2 -> retry
      dlqTime += 10_000;
      await runNotificationsCycle(notifCtx, dlqTime); // attempt 3 -> dead_letter!
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
