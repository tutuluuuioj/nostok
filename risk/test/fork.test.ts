import assert from 'node:assert/strict';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
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
import { AlertEngine, type RiskAlert } from '../src/alerts.js';
import { loadRiskConfig } from '../src/config.js';
import { assertReadOnlySql, openReadOnlyDatabase, wrapQueryableAsReadOnly } from '../src/db.js';
import {
  type LoanRiskSnapshot,
  type RiskSummarySnapshot,
  createRiskContext,
  runRiskScan,
} from '../src/monitor.js';
import { createRiskServer, renderPrometheusMetrics } from '../src/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RISK_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(RISK_DIR, '..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'contracts');

const FOUNDRY_BIN_DIR = process.env.FOUNDRY_BIN_DIR ?? `${process.env.HOME}/.foundry/bin`;
const ANVIL_PORT = Number(process.env.TEST_RISK_ANVIL_PORT ?? 18548);
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
    console.log(`[RISK_TEST] Starting Anvil fork against ${forkUrl} on port ${ANVIL_PORT}...`);
    const proc = spawn(
      `${FOUNDRY_BIN_DIR}/anvil`,
      ['--fork-url', forkUrl, '--port', String(ANVIL_PORT), '--chain-id', '8453', '--silent'],
      { env: getShellEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await waitForRpcReady(LOCAL_RPC_URL, 25_000);
      console.log('[RISK_TEST] Anvil Base Mainnet fork ready (chainId=8453)');
      return proc;
    } catch (err) {
      proc.kill('SIGKILL');
      console.warn(`[RISK_TEST] Fork RPC ${forkUrl} failed: ${(err as Error).message}`);
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
  console.log('[RISK_TEST] Running DeployNostok.s.sol on local Base Mainnet fork...');
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

async function getJson<T>(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Headers; body: T }> {
  const res = await fetch(url, { method: 'GET', headers });
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
    const lenderClient = createWalletClient({
      account: privateKeyToAccount(KEYS.lender),
      chain: forkChain,
      transport: viemHttp(LOCAL_RPC_URL),
    });
    const borrowerClient = createWalletClient({
      account: borrowerAccount,
      chain: forkChain,
      transport: viemHttp(LOCAL_RPC_URL),
    });
    const rawWalletClient = createWalletClient({ chain: forkChain, transport: viemHttp(LOCAL_RPC_URL) });

    for (const addr of Object.values(ADDRESSES)) {
      await rpcCall('anvil_setBalance', [addr, '0x56bc75e2d63100000']);
    }
    // Set non-empty code on guardian (DeployNostok expects a contract/multisig guardian address)
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
          args: [5_000_000_000n], // $5,000 global cap
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

    async function setNvdacCapAndStatus(assetCap: bigint, status = 0): Promise<void> {
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
                perLoanCap: 2_000_000_000n,
                assetCap,
                maxStaleOpenSecs: 21600,
                status,
                restricted: false,
              },
            ],
          }),
        }),
      });
    }

    await setNvdacCapAndStatus(2_500_000_000n, 0);

    // Sync initial multiplier baseline so MultiplierSynced is indexed & recordedMultiplier > 0
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
      [borrowerClient, BASE_USDC, deployed.loanCore, 2_000_000_000n],
      [lenderClient, BASE_USDC, deployed.loanCore, 10_000_000_000n],
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

    // Originate Loan #1: 10 NVDAc ($1,400 @ $140), $750 principal, 10% APR, 14d term
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

    const blk = await publicClient.getBlock();
    const order = {
      borrower: ADDRESSES.borrower,
      collateralToken: nvdac,
      collateralAmount: 10n * 10n ** 18n,
      minUsdc: 750_000_000n,
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
        args: [order, sig, 750_000_000n],
      }),
    });

    // Sync WS2.1/WS2.2 indexer
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

    // Local webhook collector server for Scenario (g)
    const webhookEvents: Array<{ action: string; alert: RiskAlert }> = [];
    const webhookServer = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          action: string;
          alert: RiskAlert;
        };
        webhookEvents.push({ action: parsed.action, alert: parsed.alert });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', resolve));
    const webhookPort = (webhookServer.address() as net.AddressInfo).port;
    const webhookUrl = `http://127.0.0.1:${webhookPort}/webhook`;

    const riskCfg = loadRiskConfig({
      rpcUrl: LOCAL_RPC_URL,
      isFork: true,
      forkChainId: 8453,
      databaseUrl: 'memory://',
      pollIntervalMs: 1000,
      alertCooldownMs: 60_000,
      webhookUrl,
      nearLiqBufferBps: 300,
      priceDeviationWarnBps: 500,
      keeperInactivityAlertSecs: 120,
      maxHealthyLagBlocks: 10,
      maxHealthyLagSecs: 600,
      rateLimitMax: 200,
      rateLimitWindowMs: 60_000,
      maxPageLimit: 50,
      loanCore: deployed.loanCore,
      liquidationAuction: deployed.liquidationAuction,
      collateralEscrow: deployed.collateralEscrow,
      assetRegistry: deployed.assetRegistry,
      oracleRouter: deployed.oracleRouter,
    });

    const riskCtx = await createRiskContext(riskCfg, wrapQueryableAsReadOnly(idxCtx.db));

    async function setNvdaPrice(price8Dec: bigint): Promise<void> {
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setPrice',
          args: [price8Dec],
        }),
      });
      await runIndexerSync(idxCtx);
    }

    async function canStartLiquidationOnchain(loanId: bigint): Promise<boolean> {
      try {
        await publicClient.simulateContract({
          address: deployed.loanCore,
          abi: parseAbi(['function startLiquidation(uint256 loanId) returns (uint256)']),
          functionName: 'startLiquidation',
          args: [loanId],
          account: ADDRESSES.liquidator,
        });
        return true;
      } catch {
        return false;
      }
    }

    const startTimeMs = Date.now();
    try {
      // -----------------------------------------------------------------------
      // TEST 1: Read-only DB & FORK=false enforcement
      // -----------------------------------------------------------------------
      console.log('\n=== TEST 1: Read-only DB & FORK=false DATABASE_URL enforcement ===');
      const prevEnvUrl = process.env.DATABASE_URL;
      const prevEnvFork = process.env.FORK;
      delete process.env.DATABASE_URL;
      delete process.env.FORK;
      try {
        assert.throws(
          () => loadRiskConfig({ ...riskCfg, isFork: false, databaseUrl: 'memory://' }),
          /postgres:\/\/ or postgresql:\/\//i
        );
      } finally {
        if (prevEnvUrl !== undefined) process.env.DATABASE_URL = prevEnvUrl;
        if (prevEnvFork !== undefined) process.env.FORK = prevEnvFork;
      }

      assert.throws(() => assertReadOnlySql('DELETE FROM loans'), /SELECT/i);
      assert.throws(() => assertReadOnlySql('INSERT INTO assets VALUES (1)'), /SELECT/i);
      assert.throws(() => assertReadOnlySql('UPDATE loans SET status=0'), /SELECT/i);
      assert.throws(() => assertReadOnlySql('SET default_transaction_read_only=off'), /SELECT/i);
      assert.throws(() => assertReadOnlySql('SELECT * INTO bad FROM loans'), /disallowed/i);
      assert.throws(
        () => assertReadOnlySql("SELECT set_config('default_transaction_read_only','off',false)"),
        /disallowed/i
      );
      assert.throws(() => assertReadOnlySql('SELECT pg_terminate_backend(1)'), /disallowed/i);
      assert.throws(() => assertReadOnlySql('SELECT 1; DROP TABLE loans'), /single-statement/i);
      assert.throws(() => assertReadOnlySql('SELECT /* sneaky */ 1'), /single-statement/i);
      assert.throws(() => assertReadOnlySql('SELECT 1 -- comment'), /single-statement/i);
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
      assert.throws(
        () => loadRiskConfig({ ...riskCfg, webhookUrl: 'ftp://example.com/hook' }),
        /http:\/\/ or https:\/\//i
      );
      assert.throws(
        () => loadRiskConfig({ ...riskCfg, webhookUrl: 'not-a-url' }),
        /Invalid WEBHOOK_URL/i
      );
      assert.doesNotThrow(() => assertReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x'));
      await assert.rejects(() => riskCtx.db.query('UPDATE loans SET status = 0'), /SELECT/i);
      console.log('PASS TEST 1: Strict read-only enforcement & WEBHOOK_URL validation verified.');

      // -----------------------------------------------------------------------
      // Scenario (a): Price drop progression + startLiquidation sweep parity
      // -----------------------------------------------------------------------
      console.log('\n=== Scenario (a): Loan risk progression & startLiquidation price sweep ===');
      let t = startTimeMs;
      let summary = await runRiskScan(riskCtx, t);
      assert.equal(summary.status, 'healthy');
      assert.equal(summary.monitor_degraded, false);
      assert.equal(summary.loan_counts.healthy, 1);
      assert.equal(riskCtx.state.latestLoans[0].risk_status, 'healthy');
      assert.equal(summary.keeper.last_sync_multiplier_block !== null, true);

      // Drop to $105.00 -> gross=$1,050, debt~$750.57 -> ~7148 bps (>= 7000 marginCall, < 7500 nearLiq)
      await setNvdaPrice(105_00000000n);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(riskCtx.state.latestLoans[0].risk_status, 'margin_call');
      assert.equal(summary.loan_counts.margin_call, 1);
      assert.ok(
        riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === 'loan_risk:1:margin_call' && a.severity === 'info')
      );
      // Price dropped 25% ($140 -> $105), so oracle_price_deviation also triggers cleanly
      assert.ok(
        riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === `oracle_price_deviation:${nvdac.toLowerCase()}`)
      );

      // Drop to $99.00 -> gross=$990 -> ~7581 bps (>= 7500 nearLiq, < 7800 liq)
      await setNvdaPrice(99_00000000n);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(riskCtx.state.latestLoans[0].risk_status, 'near_liquidation');
      assert.equal(summary.loan_counts.near_liquidation, 1);
      assert.ok(
        riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === 'loan_risk:1:near_liq' && a.severity === 'warning')
      );

      // Drop to $95.00 -> gross=$950 -> ~7901 bps (>= 7800 liq)
      await setNvdaPrice(95_00000000n);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(riskCtx.state.latestLoans[0].risk_status, 'liquidatable');
      assert.equal(summary.loan_counts.liquidatable, 1);
      assert.ok(
        riskCtx.alerts
          .getActiveAlerts()
          .some((a) => a.dedup_key === 'loan_risk:1:liquidatable' && a.severity === 'critical')
      );

      // Price sweep comparing monitor liquidatable classification vs LoanCore.startLiquidation across >=50 boundary prices
      const reportedLiqPrice = BigInt(riskCtx.state.latestLoans[0].liquidation_price.raw);

      // First binary search exact highest liquidating price on-chain
      let lo = reportedLiqPrice - 5_000n;
      let hi = reportedLiqPrice + 5_000n;
      while (lo < hi) {
        const mid = (lo + hi + 1n) / 2n;
        await setNvdaPrice(mid);
        if (await canStartLiquidationOnchain(1n)) {
          lo = mid;
        } else {
          hi = mid - 1n;
        }
      }
      const exactTriggerPrice = lo;
      assert.ok(
        reportedLiqPrice >= exactTriggerPrice + 1n,
        `Risk liquidation_price (${reportedLiqPrice}) must be >= highest liquidating price + 1 (${exactTriggerPrice + 1n})`
      );
      assert.equal(
        reportedLiqPrice,
        exactTriggerPrice + 1n,
        `Risk liquidation_price (${reportedLiqPrice}) must equal exact first non-liquidating price (${exactTriggerPrice + 1n})`
      );

      // Sweep 51 consecutive prices [-25 .. +25] around reportedLiqPrice (without syncing indexer on every tick to verify 100% on-chain oracle reads too)
      for (let delta = -25n; delta <= 25n; delta++) {
        const probePrice = reportedLiqPrice + delta;
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [probePrice],
          }),
        });
        t += 5_000;
        await runRiskScan(riskCtx, t);
        const monitorLiq: boolean = riskCtx.state.latestLoans[0].risk_status === 'liquidatable';
        const chainLiq: boolean = await canStartLiquidationOnchain(1n);
        assert.equal(
          chainLiq,
          probePrice < reportedLiqPrice,
          `On-chain boundary mismatch at price=${probePrice} (reportedLiqPrice=${reportedLiqPrice})`
        );
        assert.equal(
          monitorLiq,
          chainLiq,
          `51-price sweep mismatch: monitor=${monitorLiq}, chain=${chainLiq} at price=${probePrice}`
        );
      }

      // Restore $140.00 -> healthy + sync indexer -> resolve loan/deviation/lag alerts
      await setNvdaPrice(140_00000000n);
      t += 5_000;
      await runRiskScan(riskCtx, t);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(riskCtx.state.latestLoans[0].risk_status, 'healthy');
      assert.equal(
        riskCtx.alerts.getActiveAlerts().filter((a) => a.dedup_key.startsWith('loan_risk:1:')).length,
        0
      );
      console.log(
        `PASS Scenario (a): healthy -> margin_call -> near_liquidation -> liquidatable + 51-price boundary sweep verified (liqPrice=${reportedLiqPrice} === exactHighest+1=${exactTriggerPrice + 1n}).`
      );

      // -----------------------------------------------------------------------
      // Scenario (b): Stale feed -> oracle_stale alert -> refresh -> resolved
      // -----------------------------------------------------------------------
      console.log('\n=== Scenario (b): Stale oracle feed detection & resolution ===');
      const curBlk = await publicClient.getBlock();
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdaFeed,
          abi: mockAggArtifact.abi,
          functionName: 'setUpdatedAt',
          args: [curBlk.timestamp - 30_000n], // > maxStaleOpenSecs (21600)
        }),
      });
      await runIndexerSync(idxCtx);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(summary.assets[0].oracle_state_name, 'STALE_FEED');
      assert.ok(summary.assets[0].feed_age_seconds >= 30_000);
      assert.ok(
        riskCtx.alerts
          .getActiveAlerts()
          .some((a) => a.dedup_key === `oracle_stale:${nvdac.toLowerCase()}` && a.severity === 'critical')
      );

      await setNvdaPrice(140_00000000n);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(summary.assets[0].oracle_state_name, 'VALID_OPEN');
      assert.equal(
        riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === `oracle_stale:${nvdac.toLowerCase()}`),
        false
      );
      const staleHistory = riskCtx.alerts
        .getAllAlerts()
        .find((a) => a.dedup_key === `oracle_stale:${nvdac.toLowerCase()}`);
      assert.equal(staleHistory?.status, 'resolved');
      console.log('PASS Scenario (b): Stale feed alert triggered and auto-resolved on refresh.');

      // -----------------------------------------------------------------------
      // Scenario (c): Multiplier drift (1.5% warn) & corporate action freeze (2x page)
      // -----------------------------------------------------------------------
      console.log('\n=== Scenario (c): B20 multiplier drift (1.5%) & corporate action freeze (2x) ===');
      const driftMult = (initialMult * 10150n + 9999n) / 10000n;
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'setUIMultiplier',
          args: [driftMult],
        }),
      });
      await runIndexerSync(idxCtx);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(summary.assets[0].multiplier_drift_bps, 150);
      assert.ok(
        riskCtx.alerts
          .getActiveAlerts()
          .some((a) => a.dedup_key === `multiplier_drift:${nvdac.toLowerCase()}` && a.severity === 'warning')
      );

      // 2x split/freeze
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'setUIMultiplier',
          args: [initialMult * 2n],
        }),
      });
      await runIndexerSync(idxCtx);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(summary.assets[0].oracle_state_name, 'FROZEN_CORPORATE_ACTION');
      assert.ok(summary.assets[0].multiplier_drift_bps >= 500);
      assert.ok(
        riskCtx.alerts
          .getActiveAlerts()
          .some((a) => a.dedup_key === `corporate_action_freeze:${nvdac.toLowerCase()}` && a.severity === 'page')
      );

      // Restore multiplier
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'setUIMultiplier',
          args: [initialMult],
        }),
      });
      await runIndexerSync(idxCtx);
      t += 5_000;
      await runRiskScan(riskCtx, t);
      assert.equal(
        riskCtx.alerts
          .getActiveAlerts()
          .some(
            (a) =>
              a.dedup_key === `multiplier_drift:${nvdac.toLowerCase()}` ||
              a.dedup_key === `corporate_action_freeze:${nvdac.toLowerCase()}`
          ),
        false
      );
      console.log('PASS Scenario (c): Multiplier drift warning and 2x corporate action page alert verified.');

      // -----------------------------------------------------------------------
      // Scenario (d): Indexer lag alert & resolution
      // -----------------------------------------------------------------------
      console.log('\n=== Scenario (d): Indexer block lag alert & resolution ===');
      await rpcCall('anvil_mine', ['0x10', '0x1']); // mine 16 blocks without syncing (> maxHealthyLagBlocks=10)
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.ok(BigInt(summary.indexer.lag_blocks ?? '0') >= 16n);
      assert.ok(riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === 'indexer_lag'));

      await runIndexerSync(idxCtx);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(summary.indexer.lag_blocks, '0');
      assert.equal(riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === 'indexer_lag'), false);
      console.log('PASS Scenario (d): Indexer lag alert triggered and resolved on sync.');

      // -----------------------------------------------------------------------
      // Scenario (e): Keeper inactivity on liquidatable loan
      // -----------------------------------------------------------------------
      console.log('\n=== Scenario (e): Keeper inactivity on unacted liquidatable loan ===');
      await setNvdaPrice(90_00000000n);
      t += 5_000;
      await runRiskScan(riskCtx, t); // sets firstSeenTs
      await rpcCall('evm_increaseTime', [200]); // > keeperInactivityAlertSecs=120
      await rpcCall('evm_mine', []);
      await runIndexerSync(idxCtx);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.ok(summary.keeper.unacted_liquidatable_loans.some((u) => u.loan_id === '1' && u.stalled_seconds >= 200));
      assert.ok(
        riskCtx.alerts
          .getActiveAlerts()
          .some((a) => a.dedup_key === 'keeper_inactive:loan:1' && a.severity === 'critical')
      );

      // Restore $140.00 and stabilize previousPrices
      await setNvdaPrice(140_00000000n);
      t += 5_000;
      await runRiskScan(riskCtx, t);
      t += 5_000;
      await runRiskScan(riskCtx, t);
      assert.equal(riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === 'keeper_inactive:loan:1'), false);
      console.log('PASS Scenario (e): Keeper inactivity alert verified and resolved.');

      // -----------------------------------------------------------------------
      // Scenario (f): Cap utilization (80%/95%), Escrow mismatch, & Protocol pause
      // -----------------------------------------------------------------------
      console.log('\n=== Scenario (f): Cap utilization (80%/95%), escrow mismatch, & protocol pause ===');
      // 750 / 900 = 8333 bps (>= 80% warning)
      await setNvdacCapAndStatus(900_000_000n, 0);
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: deployed.nostokTimelock,
          to: deployed.loanCore,
          data: encodeFunctionData({
            abi: parseAbi(['function setGlobalCap(uint128 newCap)']),
            functionName: 'setGlobalCap',
            args: [900_000_000n],
          }),
        }),
      });
      await runIndexerSync(idxCtx);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(summary.assets[0].asset_cap_utilization_bps, 8333);
      assert.equal(summary.global_cap_utilization_bps, 8333);
      assert.ok(
        riskCtx.alerts
          .getActiveAlerts()
          .some((a) => a.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}` && a.severity === 'warning')
      );
      assert.ok(riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === 'global_cap_util' && a.severity === 'warning'));

      // 3-way escrow check:
      // 1) Token donation surplus (balanceOf=11e18 > ledger=10e18 === openLoans=10e18): info alert, auto-resolves so never permanent
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [deployed.collateralEscrow, 1n * 10n ** 18n],
        }),
      });
      await runIndexerSync(idxCtx);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(summary.assets[0].escrow_matches_open_loans, true, 'Donation surplus must not fail solvency check');
      assert.ok(
        riskCtx.alerts
          .getActiveAlerts()
          .some((a) => a.dedup_key === `escrow_surplus:${nvdac.toLowerCase()}` && a.severity === 'info')
      );
      // Next scan (> minActiveMs) auto-resolves escrow_surplus so donations do not leave alerts active forever
      t += 5_000;
      await runRiskScan(riskCtx, t);
      assert.equal(
        riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === `escrow_surplus:${nvdac.toLowerCase()}`),
        false
      );

      // 2) Real shortfall: transfer 2 NVDAc out -> balanceOf=9e18 < ledger=10e18 -> CRITICAL escrow_mismatch
      await rpcCall('anvil_impersonateAccount', [deployed.collateralEscrow]);
      await rpcCall('anvil_setBalance', [deployed.collateralEscrow, '0x56bc75e2d63100000']);
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: deployed.collateralEscrow,
          to: nvdac,
          data: encodeFunctionData({
            abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']),
            functionName: 'transfer',
            args: [ADDRESSES.treasury, 2n * 10n ** 18n],
          }),
        }),
      });
      await runIndexerSync(idxCtx);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(summary.assets[0].escrow_matches_open_loans, false);
      assert.ok(
        riskCtx.alerts
          .getActiveAlerts()
          .some((a) => a.dedup_key === `escrow_mismatch:${nvdac.toLowerCase()}` && a.severity === 'critical')
      );

      // While escrow_mismatch is already active, a transient failed escrow read ("unknown") MUST preserve it (Fix #9)
      const preserveSnapId = await rpcCall<string>('evm_snapshot', []);
      try {
        await rpcCall('anvil_setCode', [deployed.collateralEscrow, '0xfe']);
        t += 5_000;
        const unknownWhileMismatchSummary = await runRiskScan(riskCtx, t);
        assert.equal(unknownWhileMismatchSummary.assets[0].escrow_matches_open_loans, 'unknown');
        assert.ok(
          riskCtx.alerts
            .getActiveAlerts()
            .some(
              (a) => a.dedup_key === `escrow_mismatch:${nvdac.toLowerCase()}` && a.severity === 'critical'
            ),
          'Active critical escrow_mismatch alert MUST be preserved when escrow read transiently returns unknown'
        );
      } finally {
        await rpcCall('evm_revert', [preserveSnapId]);
      }

      // Restore exact 10 NVDAc in escrow
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({
          address: nvdac,
          abi: mockB20Artifact.abi,
          functionName: 'mint',
          args: [deployed.collateralEscrow, 1n * 10n ** 18n],
        }),
      });
      await runIndexerSync(idxCtx);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(summary.assets[0].escrow_matches_open_loans, true);

      // Failed getBalance read must produce "unknown" and skip escrow_mismatch alert (Fix 9)
      const escrowSnapId = await rpcCall<string>('evm_snapshot', []);
      try {
        await rpcCall('anvil_setCode', [deployed.collateralEscrow, '0xfe']);
        t += 5_000;
        const unknownEscrowSummary = await runRiskScan(riskCtx, t);
        assert.equal(unknownEscrowSummary.assets[0].escrow_ledger_balance, 'unknown');
        assert.equal(unknownEscrowSummary.assets[0].escrow_matches_open_loans, 'unknown');
        assert.equal(
          riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === `escrow_mismatch:${nvdac.toLowerCase()}`),
          false,
          'Failed getBalance read must NOT default to 0n or fire escrow_mismatch'
        );
      } finally {
        await rpcCall('evm_revert', [escrowSnapId]);
      }

      // Lagging indexer test (Fix 2 & Fix 3):
      // Snapshot clean state, perform partialRepay on Loan #1 AND open+repay Loan #2 WITHOUT syncing indexer!
      const lagSnapId = await rpcCall<string>('evm_snapshot', []);
      try {
        // Increase cap temporarily so Loan #2 can open, then sync or don't sync — wait: open & repay WITHOUT syncing indexer!
        await setNvdacCapAndStatus(2_500_000_000n, 0);
        await publicClient.waitForTransactionReceipt({
          hash: await rawWalletClient.sendTransaction({
            account: deployed.nostokTimelock,
            to: deployed.loanCore,
            data: encodeFunctionData({
              abi: parseAbi(['function setGlobalCap(uint128 newCap)']),
              functionName: 'setGlobalCap',
              args: [5_000_000_000n],
            }),
          }),
        });
        await runIndexerSync(idxCtx);

        // Partial repay $400 of $750 principal on Loan #1 -> leaves $350 principal & 4.666... NVDAc collateral (LTV unchanged ~53.6%, WAIT: drop price to $80 -> old DB 750 / 800 = 93.75% LIQUIDATABLE, whereas actually after $400 partialRepay + 4.666 NVDAc... WAIT! Pro-rata collateral release keeps LTV proportional unless topUp or less release! Look: if we partialRepay $400 THEN topUp 5 NVDAc OR repay without proportional? Wait: Contract partialRepay releases pro-rata collateral = 400/750 = 53.33%, leaving 350/4.666 NVDAc! So BOTH ratios match EXCEPT if price is set to $80 and DB had stale collateral OR wait: how does the user's bug happen?! Suppose partialRepay happens on-chain, reducing principal from 750->350 AND collateral 10->4.666. BEFORE our fix, monitor used DB principal_repaid=0 mixed with ON-CHAIN principal=750 & collateralRaw=4.666 -> 750 / (4.666 * 140) = 114%!! THAT'S WHY DB principal_repaid=0 + on-chain collateralRaw=4.666 gave 8932 bps instead of 5361 bps!!)
        // Re-check! YES!! Mixing on-chain collateralRaw=4.6667 with stale DB principal_repaid=0 ($750 instead of $350) doubles the calculated LTV!
        await publicClient.waitForTransactionReceipt({
          hash: await borrowerClient.writeContract({
            address: deployed.loanCore,
            abi: parseAbi(['function partialRepay(uint256 loanId, uint128 principalRepayAmount) returns (uint128)']),
            functionName: 'partialRepay',
            args: [1n, 400_000_000n],
          }),
        });
        // Also open Loan #2 and repay it in full, ALL WITHOUT running runIndexerSync!
        const blkL2 = await publicClient.getBlock();
        const order2 = {
          borrower: ADDRESSES.borrower,
          collateralToken: nvdac,
          collateralAmount: 10n * 10n ** 18n,
          minUsdc: 600_000_000n,
          maxRateBps: 1000,
          termDays: 14,
          maxLtvBps: 6000,
          minFill: 500_000_000n,
          expiry: blkL2.timestamp + 3600n,
          nonce: 0n,
          yieldMode: 0,
          allowInKindSettlement: false,
        } as const;
        const sig2 = await borrowerAccount.signTypedData({
          domain: {
            name: 'NOSTOK Order Settlement',
            version: '1',
            chainId: 8453,
            verifyingContract: deployed.orderSettlement,
          },
          types: borrowTypes,
          primaryType: 'BorrowOrder',
          message: order2,
        });
        await publicClient.waitForTransactionReceipt({
          hash: await lenderClient.writeContract({
            address: deployed.orderSettlement,
            abi: fillOrderAbi,
            functionName: 'fillBorrowOrder',
            args: [order2, sig2, 600_000_000n],
          }),
        });
        await publicClient.waitForTransactionReceipt({
          hash: await borrowerClient.writeContract({
            address: deployed.loanCore,
            abi: parseAbi(['function repay(uint256 loanId) returns (uint128)']),
            functionName: 'repay',
            args: [2n],
          }),
        });

        // Do NOT sync idxCtx! Run risk scan while indexer lags behind partialRepay + open + repay
        t += 5_000;
        const lagSummary = await runRiskScan(riskCtx, t);
        const loan1Snap = riskCtx.state.latestLoans.find((l) => l.loan_id === '1');
        assert.ok(loan1Snap, 'Loan #1 must be evaluated on-chain');
        assert.equal(loan1Snap.principal_remaining.raw, '350000000', 'Must use on-chain principalRepaid (750 - 400 = 350)');
        assert.equal(loan1Snap.risk_status, 'healthy', 'Lagging DB principal_repaid must NOT cause false liquidatable');
        assert.equal(lagSummary.assets[0].escrow_matches_open_loans, true, 'Lagging DB after partialRepay + repay must NOT cause false escrow_mismatch');
        assert.equal(
          riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === `escrow_mismatch:${nvdac.toLowerCase()}`),
          false
        );

        // Defaulted loan past maturity + 24h grace without startDefaultAuction (Fix 6)
        const loan1Chain = await publicClient.readContract({
          address: deployed.loanCore,
          abi: parseAbi([
            'function getLoan(uint256) view returns ((address borrower,address collateralToken,uint128 collateralRaw,uint128 principal,uint64 startTime,uint64 maturity,uint32 rateBps,uint32 penaltySpreadBps,uint16 initLtvBps,uint16 marginCallLtvBps,uint16 liqLtvBps,uint16 minInterestDays,uint8 status,uint8 yieldMode,uint8 coreVersion,uint128 interestPaid,uint128 principalRepaid))',
          ]),
          functionName: 'getLoan',
          args: [1n],
        });
        // Jump to maturity + 25 hours (1h past 24h grace) and refresh price so feed is fresh VALID_OPEN
        await rpcCall('evm_setNextBlockTimestamp', [Number(loan1Chain.maturity) + 25 * 3600]);
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [140_00000000n],
          }),
        });
        t += 5_000;
        const defaultSummary = await runRiskScan(riskCtx, t);
        const defaultedLoan1 = riskCtx.state.latestLoans.find((l) => l.loan_id === '1');
        assert.equal(
          defaultedLoan1?.risk_status,
          'liquidatable',
          'Loan 25h past maturity without startDefaultAuction must be liquidatable, never healthy'
        );
        assert.ok(defaultSummary.keeper.unacted_defaulted_loans.some((u) => u.loan_id === '1'));
        assert.ok(
          riskCtx.alerts
            .getActiveAlerts()
            .some((a) => a.dedup_key === 'keeper_inactive:default:1' && a.severity === 'critical')
        );
        const defMetrics = renderPrometheusMetrics(riskCtx);
        assert.ok(defMetrics.includes('nostok_risk_keeper_seconds_since_sync_multiplier'));
        assert.ok(defMetrics.includes('nostok_risk_keeper_seconds_since_start_liquidation'));
        assert.ok(defMetrics.includes('nostok_risk_keeper_seconds_since_default_or_restart'));
        assert.ok(defMetrics.includes('nostok_risk_keeper_unacted_default_loans 1'));
      } finally {
        await rpcCall('evm_revert', [lagSnapId]);
      }
      // Restore 900 USDC caps & clear temporary alerts before pause + Scenario (g)
      await setNvdacCapAndStatus(900_000_000n, 0);
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: deployed.nostokTimelock,
          to: deployed.loanCore,
          data: encodeFunctionData({
            abi: parseAbi(['function setGlobalCap(uint128 newCap)']),
            functionName: 'setGlobalCap',
            args: [900_000_000n],
          }),
        }),
      });
      await runIndexerSync(idxCtx);
      t += 5_000;
      await runRiskScan(riskCtx, t);

      // Pause via guardian, unpause via timelock
      await rpcCall('anvil_impersonateAccount', [ADDRESSES.guardian]);
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: ADDRESSES.guardian,
          to: deployed.loanCore,
          data: encodeFunctionData({
            abi: parseAbi(['function setPaused(bool isPaused)']),
            functionName: 'setPaused',
            args: [true],
          }),
        }),
      });
      await runIndexerSync(idxCtx);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(summary.protocol_paused, true);
      assert.ok(riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === 'protocol_paused' && a.severity === 'page'));

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
      await runIndexerSync(idxCtx);
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      assert.equal(summary.protocol_paused, false);
      assert.equal(summary.assets[0].escrow_matches_open_loans, true);
      assert.equal(riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === 'protocol_paused'), false);
      assert.equal(
        riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === `escrow_mismatch:${nvdac.toLowerCase()}`),
        false
      );
      await riskCtx.alerts.flushWebhooks(5_000);
      console.log('PASS Scenario (f): Caps, 3-way escrow, lagging-indexer partialRepay/repay, default>24h grace, and protocol pause verified.');

      // -----------------------------------------------------------------------
      // Scenario (g): Alert dedup, cooldown, escalation, resolve & webhook POSTs
      // -----------------------------------------------------------------------
      console.log('\n=== Scenario (g): Alert dedup, cooldown suppression, escalation, resolve & webhook ===');
      // Currently asset_cap_util:<nvdac> is active (triggered in Scenario f at ~83.33% 'warning')
      const countBeforeDedup = webhookEvents.length;
      const capAlertBefore = riskCtx.alerts
        .getActiveAlerts()
        .find((a) => a.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`);
      assert.ok(capAlertBefore);
      const sentBefore = capAlertBefore.notifications_sent;
      const occBefore = capAlertBefore.occurrences;

      // Immediate rescan within 60s cooldown must NOT send webhook or increment notifications_sent
      t += 5_000;
      await runRiskScan(riskCtx, t);
      await riskCtx.alerts.flushWebhooks(5_000);
      const capAlertDedup = riskCtx.alerts
        .getActiveAlerts()
        .find((a) => a.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`);
      assert.equal(capAlertDedup?.occurrences, occBefore + 1);
      assert.equal(capAlertDedup?.notifications_sent, sentBefore);
      assert.equal(
        webhookEvents.slice(countBeforeDedup).some((e) => e.alert.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`),
        false
      );

      // Advance past 60_000ms cooldown -> repeat webhook dispatched
      t += 65_000;
      await runRiskScan(riskCtx, t);
      await riskCtx.alerts.flushWebhooks(5_000);
      const repeatEvt = webhookEvents
        .slice(countBeforeDedup)
        .find((e) => e.action === 'repeat' && e.alert.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`);
      assert.ok(repeatEvt, 'Expected repeat webhook after cooldown elapsed');
      assert.equal(repeatEvt.alert.notifications_sent, sentBefore + 1);

      // Escalate severity warning -> critical within cooldown by tightening cap to 780 USDC (96.15%)
      await setNvdacCapAndStatus(780_000_000n, 0);
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: deployed.nostokTimelock,
          to: deployed.loanCore,
          data: encodeFunctionData({
            abi: parseAbi(['function setGlobalCap(uint128 newCap)']),
            functionName: 'setGlobalCap',
            args: [780_000_000n],
          }),
        }),
      });
      await runIndexerSync(idxCtx);
      const preEscLen = webhookEvents.length;
      t += 5_000; // within cooldown!
      await runRiskScan(riskCtx, t);
      await riskCtx.alerts.flushWebhooks(5_000);
      const escEvt = webhookEvents
        .slice(preEscLen)
        .find((e) => e.action === 'escalate' && e.alert.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`);
      assert.ok(escEvt, 'Escalation must fire webhook immediately even within cooldown');
      assert.equal(escEvt.alert.severity, 'critical');

      // Severity downgrade notification (critical -> warning by relaxing cap 780 -> 900 USDC = 83.33%)
      await setNvdacCapAndStatus(900_000_000n, 0);
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: deployed.nostokTimelock,
          to: deployed.loanCore,
          data: encodeFunctionData({
            abi: parseAbi(['function setGlobalCap(uint128 newCap)']),
            functionName: 'setGlobalCap',
            args: [900_000_000n],
          }),
        }),
      });
      await runIndexerSync(idxCtx);
      const preDownLen = webhookEvents.length;
      t += 5_000;
      await runRiskScan(riskCtx, t);
      await riskCtx.alerts.flushWebhooks(5_000);
      const downEvt = webhookEvents
        .slice(preDownLen)
        .find((e) => e.action === 'downgrade' && e.alert.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`);
      assert.ok(downEvt, 'Severity downgrade must emit downgrade webhook immediately');
      assert.equal(downEvt.alert.severity, 'warning');

      // Clear caps back to $2,500 / $5,000 -> resolve webhook dispatched
      await setNvdacCapAndStatus(2_500_000_000n, 0);
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: deployed.nostokTimelock,
          to: deployed.loanCore,
          data: encodeFunctionData({
            abi: parseAbi(['function setGlobalCap(uint128 newCap)']),
            functionName: 'setGlobalCap',
            args: [5_000_000_000n],
          }),
        }),
      });
      await runIndexerSync(idxCtx);
      const preResLen = webhookEvents.length;
      t += 5_000;
      summary = await runRiskScan(riskCtx, t);
      await riskCtx.alerts.flushWebhooks(5_000);
      const resEvt = webhookEvents
        .slice(preResLen)
        .find((e) => e.action === 'resolve' && e.alert.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`);
      assert.ok(resEvt, 'Clearing condition must emit resolve webhook');
      assert.equal(resEvt.alert.status, 'resolved');
      assert.ok(resEvt.alert.resolved_at !== null);
      assert.equal(summary.status, 'healthy');

      // Hanging webhook (never responds) + flap damping + bounded transitions ring buffer test
      const hangingSockets: net.Socket[] = [];
      const hangServer = http.createServer((_req, _res) => {
        // intentionally never reply
      });
      hangServer.on('connection', (sock) => hangingSockets.push(sock));
      await new Promise<void>((resolve) => hangServer.listen(0, '127.0.0.1', resolve));
      const hangPort = (hangServer.address() as net.AddressInfo).port;
      try {
        const hangEngine = new AlertEngine(60_000, `http://127.0.0.1:${hangPort}/hang`, {
          minActiveMs: 2_000,
          webhookTimeoutMs: 250,
          maxWebhookAttempts: 1,
          maxTransitions: 500,
        });
        const tHangStart = Date.now();
        await hangEngine.syncObservations(
          [{ dedupKey: 'flap:test', category: 'test', severity: 'warning', title: 'Flap', message: 'm', details: {} }],
          1_000_000
        );
        // Clearing within minActiveMs (500ms < 2000ms) must NOT resolve (flap damping)
        await hangEngine.syncObservations([], 1_000_500);
        assert.equal(hangEngine.getActiveAlerts().length, 1, 'Alert must resist resolving before minActiveMs');
        // Clearing once minActiveMs has elapsed DOES resolve
        await hangEngine.syncObservations([], 1_002_500);
        assert.equal(hangEngine.getActiveAlerts().length, 0);
        const scanElapsedMs = Date.now() - tHangStart;
        assert.ok(scanElapsedMs < 200, `Non-blocking webhook must not block syncObservations (took ${scanElapsedMs}ms)`);
        await hangEngine.flushWebhooks(1_500);

        // Verify transitions ring buffer stays bounded at maxTransitions (500) even after 600 transitions
        for (let idx = 0; idx < 600; idx++) {
          await hangEngine.syncObservations(
            [{ dedupKey: `ring:${idx}`, category: 'test', severity: 'info', title: 'R', message: 'r', details: {} }],
            2_000_000 + idx * 10_000
          );
        }
        assert.ok(hangEngine.transitions.length <= 500, `transitions length must be <= 500, got ${hangEngine.transitions.length}`);
      } finally {
        for (const s of hangingSockets) s.destroy();
        await new Promise<void>((resolve) => hangServer.close(() => resolve()));
      }
      console.log(`PASS Scenario (g): Alert lifecycle, downgrade, flap damping, non-blocking hanging webhook, & ${webhookEvents.length} transitions verified.`);

      // -----------------------------------------------------------------------
      // HTTP endpoints & hardening (/metrics, /risk/summary, /risk/loans, /risk/alerts, 400, 405, 429)
      // -----------------------------------------------------------------------
      console.log('\n=== HTTP Endpoints & Security Hardening ===');
      const server = createRiskServer(riskCtx);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const srvPort = (server.address() as net.AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${srvPort}`;
      try {
        const metricsRes = await fetch(`${baseUrl}/metrics`);
        assert.equal(metricsRes.status, 200);
        const metricsTxt = await metricsRes.text();
        assert.ok(metricsTxt.includes('nostok_risk_monitor_up 1'));
        assert.ok(metricsTxt.includes('nostok_risk_open_loans_count{status="healthy"} 1'));
        assert.ok(metricsTxt.includes('nostok_risk_asset_cap_utilization_bps'));
        assert.ok(metricsTxt.includes('nostok_risk_loan_ltv_bps'));

        const sumRes = await getJson<RiskSummarySnapshot>(`${baseUrl}/risk/summary`);
        assert.equal(sumRes.status, 200);
        assert.equal(sumRes.body.status, 'healthy');
        assert.equal(sumRes.body.loan_counts.healthy, 1);

        const healthRes = await getJson<RiskSummarySnapshot>(`${baseUrl}/health`);
        assert.equal(healthRes.status, 200);
        assert.equal(healthRes.body.monitor_degraded, false);

        const loansRes = await getJson<{ data: LoanRiskSnapshot[]; pagination: { total: number } }>(
          `${baseUrl}/risk/loans?status=healthy&asset=${nvdac}&limit=10`
        );
        assert.equal(loansRes.status, 200);
        assert.equal(loansRes.body.data.length, 1);
        assert.equal(loansRes.body.data[0].loan_id, '1');

        const alertsRes = await getJson<{ data: RiskAlert[]; pagination: { total: number } }>(
          `${baseUrl}/risk/alerts?status=resolved&category=caps`
        );
        assert.equal(alertsRes.status, 200);
        assert.ok(alertsRes.body.data.length >= 2);
        assert.ok(alertsRes.body.data.every((a) => a.status === 'resolved' && a.category === 'caps'));

        const badChecksum = await getJson<{ error: { code: string; stack?: string } }>(
          `${baseUrl}/risk/loans?asset=${nvdac.toLowerCase()}`
        );
        assert.equal(badChecksum.status, 400);
        assert.equal(badChecksum.body.error.code, 'VALIDATION_ERROR');
        assert.equal('stack' in badChecksum.body.error, false);

        const postRejected = await fetch(`${baseUrl}/risk/summary`, { method: 'POST' });
        assert.equal(postRejected.status, 405);

        // Rate limiter test
        const rlServer = createRiskServer({
          ...riskCtx,
          config: { ...riskCfg, rateLimitMax: 2, rateLimitWindowMs: 60_000 },
        });
        await new Promise<void>((resolve) => rlServer.listen(0, '127.0.0.1', resolve));
        const rlPort = (rlServer.address() as net.AddressInfo).port;
        try {
          const r1 = await fetch(`http://127.0.0.1:${rlPort}/health`);
          const r2 = await fetch(`http://127.0.0.1:${rlPort}/health`);
          const r3 = await fetch(`http://127.0.0.1:${rlPort}/health`);
          assert.equal(r1.status, 200);
          assert.equal(r2.status, 200);
          assert.equal(r3.status, 429);
          assert.ok(r3.headers.get('retry-after'));
        } finally {
          await new Promise<void>((resolve) => rlServer.close(() => resolve()));
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      console.log('PASS HTTP Endpoints & Security Hardening verified.');

      // -----------------------------------------------------------------------
      // Scenario (h): Real dead TCP port degraded boot, outage preservation & recovery
      // -----------------------------------------------------------------------
      console.log('\n=== Scenario (h): Real dead port degraded boot & RPC outage resilience ===');
      // 1) Degraded boot when RPC port is dead at startup (must not exit/throw)
      const closedBootPort = await getFreePort();
      const bootDegCtx = await createRiskContext(
        { ...riskCfg, rpcUrl: `http://127.0.0.1:${closedBootPort}`, webhookUrl: undefined },
        wrapQueryableAsReadOnly(idxCtx.db)
      );
      assert.equal(bootDegCtx.state.monitorDegraded, true);
      const bootDegSum = await runRiskScan(bootDegCtx, Date.now());
      assert.equal(bootDegSum.monitor_degraded, true);
      assert.equal(bootDegSum.status, 'degraded');

      // 2) Live relay port to Anvil -> scan 1 triggers warning alert -> stop relay so port is genuinely dead (ECONNREFUSED)
      const relaySockets: net.Socket[] = [];
      const relayServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          try {
            const upRes = await fetch(LOCAL_RPC_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: Buffer.concat(chunks),
            });
            const bodyTxt = await upRes.text();
            res.statusCode = upRes.status;
            res.setHeader('Content-Type', 'application/json');
            res.end(bodyTxt);
          } catch (err) {
            res.statusCode = 502;
            res.end(String(err));
          }
        });
      });
      relayServer.on('connection', (sock) => relaySockets.push(sock));
      await new Promise<void>((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
      const relayPort = (relayServer.address() as net.AddressInfo).port;
      const relayCtx = await createRiskContext(
        { ...riskCfg, rpcUrl: `http://127.0.0.1:${relayPort}`, webhookUrl: undefined },
        wrapQueryableAsReadOnly(idxCtx.db)
      );

      // Trigger cap warning while relay is up
      await setNvdacCapAndStatus(900_000_000n, 0);
      t += 5_000;
      await runRiskScan(relayCtx, t);
      assert.ok(relayCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`));

      // Shut down the relay server so relayPort is a real dead TCP port!
      for (const s of relaySockets) s.destroy();
      await new Promise<void>((resolve) => relayServer.close(() => resolve()));

      t += 5_000;
      const degradedSum = await runRiskScan(relayCtx, t);
      assert.equal(degradedSum.monitor_degraded, true);
      assert.equal(degradedSum.status, 'degraded');
      assert.ok(degradedSum.rpc_errors_total >= 1);
      assert.ok(relayCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === 'monitor:degraded'));
      assert.ok(
        relayCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`),
        'Pre-existing alert must be preserved during real dead-port RPC outage'
      );

      const degSrv = createRiskServer(relayCtx);
      await new Promise<void>((resolve) => degSrv.listen(0, '127.0.0.1', resolve));
      const degPort = (degSrv.address() as net.AddressInfo).port;
      try {
        const degSumHttp = await getJson<RiskSummarySnapshot>(`http://127.0.0.1:${degPort}/risk/summary`);
        assert.equal(degSumHttp.status, 503);
        assert.equal(degSumHttp.body.monitor_degraded, true);
        const degMetrics = await (await fetch(`http://127.0.0.1:${degPort}/metrics`)).text();
        assert.ok(degMetrics.includes('nostok_risk_monitor_up 0'));
      } finally {
        await new Promise<void>((resolve) => degSrv.close(() => resolve()));
      }

      // Restore healthy RPC on riskCtx & clear cap alert
      await setNvdacCapAndStatus(2_500_000_000n, 0);
      t += 5_000;
      const recovered = await runRiskScan(riskCtx, t);
      assert.equal(recovered.monitor_degraded, false);
      assert.equal(recovered.status, 'healthy');

      // 3) Single loan getLoan(uint256) read failure preserves active loan_risk alerts without false escrow_mismatch
      let failGetLoan = false;
      const loanFailProxy = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          const bodyBuf = Buffer.concat(chunks);
          if (failGetLoan && bodyBuf.toString('utf8').toLowerCase().includes('504006ca')) {
            res.statusCode = 500;
            res.end('Injected getLoan read failure');
            return;
          }
          const upRes = await fetch(LOCAL_RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: bodyBuf,
          });
          res.statusCode = upRes.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(await upRes.text());
        });
      });
      await new Promise<void>((resolve) => loanFailProxy.listen(0, '127.0.0.1', resolve));
      const loanFailPort = (loanFailProxy.address() as net.AddressInfo).port;
      try {
        const lfCtx = await createRiskContext(
          { ...riskCfg, rpcUrl: `http://127.0.0.1:${loanFailPort}`, webhookUrl: undefined },
          wrapQueryableAsReadOnly(idxCtx.db)
        );
        // Trigger margin call on Loan #4 at $105
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [105_00000000n],
          }),
        });
        t += 5_000;
        await runRiskScan(lfCtx, t);
        const activeMc = lfCtx.alerts
          .getActiveAlerts()
          .find((a) => a.dedup_key.endsWith(':margin_call') || a.dedup_key.endsWith(':liquidatable'));
        assert.ok(activeMc, 'Expected an active loan_risk alert before injecting getLoan failure');

        failGetLoan = true;
        t += 5_000;
        const lfSummary = await runRiskScan(lfCtx, t);
        assert.equal(lfSummary.monitor_degraded, false);
        assert.equal(lfSummary.assets[0].escrow_matches_open_loans, 'unknown');
        assert.ok(
          lfCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === activeMc.dedup_key),
          'Active loan alert MUST be preserved when getLoan() read fails'
        );
        assert.equal(
          lfCtx.alerts.getActiveAlerts().some((a) => a.dedup_key.startsWith('escrow_mismatch:')),
          false,
          'Missing getLoan() read must NOT emit false escrow_mismatch'
        );
      } finally {
        failGetLoan = false;
        await new Promise<void>((resolve) => loanFailProxy.close(() => resolve()));
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.writeContract({
            address: nvdaFeed,
            abi: mockAggArtifact.abi,
            functionName: 'setPrice',
            args: [140_00000000n],
          }),
        });
      }
      console.log('PASS Scenario (h): Dead-port degraded boot, getLoan preservation & recovery verified.');

      // -----------------------------------------------------------------------
      // Scenario (i): Real PostgreSQL (embedded-postgres) pg_terminate_backend recovery
      // -----------------------------------------------------------------------
      console.log('\n=== Scenario (i): Real PostgreSQL pg_terminate_backend & pool error recovery ===');
      const pgPort = await getFreePort();
      const epgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostok-risk-epg-'));
      const epg = new EmbeddedPostgres({
        databaseDir: path.join(epgDir, 'data'),
        user: 'postgres',
        password: 'pw',
        port: pgPort,
        persistent: false,
      });
      await epg.initialise();
      await epg.start();
      const realPgUrl = `postgres://postgres:pw@127.0.0.1:${pgPort}/postgres`;
      try {
        // Populate real PostgreSQL with real indexed state from our fork
        const idxRealCfg = loadIndexerConfig({
          rpcUrl: LOCAL_RPC_URL,
          isFork: false,
          databaseUrl: realPgUrl,
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
        const idxRealCtx = await createIndexerContext(idxRealCfg);
        await runIndexerSync(idxRealCtx);
        await idxRealCtx.db.close();

        const wireRiskCfg = loadRiskConfig({
          ...riskCfg,
          isFork: false,
          forkChainId: 8453,
          databaseUrl: realPgUrl,
          webhookUrl: undefined,
        });
        const wireRiskCtx = await createRiskContext(wireRiskCfg);
        const adminClient = new pgPkg.Client({ connectionString: realPgUrl });
        await adminClient.connect();
        try {
          const initialWireScan = await runRiskScan(wireRiskCtx, Date.now());
          assert.equal(initialWireScan.monitor_degraded, false);

          // Real PostgreSQL pg_terminate_backend against every other client connected to 'postgres'
          await adminClient.query(
            `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
             WHERE datname = 'postgres' AND pid <> pg_backend_pid()`
          );

          const scanAfterKill = await runRiskScan(wireRiskCtx, Date.now());
          assert.equal(scanAfterKill.monitor_degraded, false);
          assert.equal(scanAfterKill.chain_head_block !== null, true);
        } finally {
          await adminClient.end();
          await wireRiskCtx.db.close();
        }
      } finally {
        await epg.stop();
        fs.rmSync(epgDir, { recursive: true, force: true });
      }
      console.log('PASS Scenario (i): Real PostgreSQL pg_terminate_backend & recovery verified.');

      // Scenario (j): Read-only PGlite & wrapped queryable statement_timeout enforcement
      const { db: pgliteRoDb } = await openReadOnlyDatabase('memory://', false, { statementTimeoutMs: 60 });
      try {
        const fastRes = await pgliteRoDb.query<{ one: number; st: string }>(
          "SELECT 1 AS one, current_setting('statement_timeout') AS st"
        );
        assert.equal(fastRes.rows[0].one, 1);
        assert.equal(fastRes.rows[0].st, '60ms', 'PGlite read-only TX must apply SET LOCAL statement_timeout');
      } finally {
        await pgliteRoDb.close();
      }
      const slowQueryable = {
        async query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
          if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return { rows: [] };
          }
          await new Promise((r) => setTimeout(r, 250));
          return { rows: [] };
        },
      };
      const timedRo = wrapQueryableAsReadOnly(slowQueryable, { statementTimeoutMs: 40 });
      await assert.rejects(
        () => timedRo.query('SELECT * FROM assets'),
        /statement_timeout/i,
        'Read-only adapter must abort queries exceeding statement_timeout'
      );
      console.log('PASS Scenario (j): Read-only PGlite & adapter statement_timeout enforcement verified.');

      console.log('\nALL WS2.4 RISK MONITOR BASE MAINNET FORK INTEGRATION TESTS PASSED.');
    } finally {
      await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
      await idxCtx.db.close();
    }
  } finally {
    anvilProc.kill('SIGKILL');
    fs.rmSync(path.join(CONTRACTS_DIR, 'broadcast'), { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('\nRISK FORK TEST FAILED:', err);
  process.exit(1);
});
