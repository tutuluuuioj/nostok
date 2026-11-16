import assert from 'node:assert/strict';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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
  encodeFunctionData,
  getAddress,
  http as viemHttp,
  parseAbi,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { loadConfig as loadIndexerConfig } from '../../indexer/src/config.js';
import { createIndexerContext, runIndexerSync } from '../../indexer/src/indexer.js';
import { type RiskAlert } from '../src/alerts.js';
import { loadRiskConfig } from '../src/config.js';
import { assertReadOnlySql, openReadOnlyDatabase, wrapQueryableAsReadOnly } from '../src/db.js';
import {
  type LoanRiskSnapshot,
  type RiskSummarySnapshot,
  createRiskContext,
  runRiskScan,
} from '../src/monitor.js';
import { createRiskServer } from '../src/server.js';

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
      assert.doesNotThrow(() => assertReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x'));
      await assert.rejects(() => riskCtx.db.query('UPDATE loans SET status = 0'), /SELECT/i);
      console.log('PASS TEST 1: Strict read-only enforcement verified.');

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

      // Price sweep comparing monitor liquidatable classification vs LoanCore.startLiquidation simulation
      const reportedLiqPrice = BigInt(riskCtx.state.latestLoans[0].liquidation_price.raw);
      for (const offset of [-100_000n, -1_000n, 1_000n, 100_000n]) {
        const probePrice = reportedLiqPrice + offset;
        await setNvdaPrice(probePrice);
        t += 5_000;
        await runRiskScan(riskCtx, t);
        const monitorLiq: boolean = riskCtx.state.latestLoans[0].risk_status === 'liquidatable';
        const chainLiq: boolean = await canStartLiquidationOnchain(1n);
        assert.equal(
          monitorLiq,
          chainLiq,
          `Monitor liquidatable (${monitorLiq}) must match startLiquidation (${chainLiq}) at price=${probePrice} (reportedLiqPrice=${reportedLiqPrice})`
        );
      }

      // Binary search exact on-chain trigger price and check delta against reported liquidation_price
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
      const liqPriceDiff =
        reportedLiqPrice >= exactTriggerPrice
          ? reportedLiqPrice - exactTriggerPrice
          : exactTriggerPrice - reportedLiqPrice;
      assert.ok(
        liqPriceDiff <= 10n,
        `Monitor liquidation_price (${reportedLiqPrice}) diverged from contract trigger (${exactTriggerPrice}) by ${liqPriceDiff}`
      );

      // Restore $140.00 -> healthy + resolve loan/deviation alerts (advance slightly to stabilize previousPrices)
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
        `PASS Scenario (a): healthy -> margin_call -> near_liquidation -> liquidatable + startLiquidation parity verified (liqPrice=${reportedLiqPrice} vs exact=${exactTriggerPrice}, diff=${liqPriceDiff}).`
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

      // Escrow mismatch warning (surplus) -> critical (shortfall) -> resolve (exact match)
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
      assert.equal(summary.assets[0].escrow_matches_open_loans, false);
      assert.ok(
        riskCtx.alerts
          .getActiveAlerts()
          .some((a) => a.dedup_key === `escrow_mismatch:${nvdac.toLowerCase()}` && a.severity === 'warning')
      );

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
      await runRiskScan(riskCtx, t);
      assert.ok(
        riskCtx.alerts
          .getActiveAlerts()
          .some((a) => a.dedup_key === `escrow_mismatch:${nvdac.toLowerCase()}` && a.severity === 'critical')
      );

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
      console.log('PASS Scenario (f): Caps, escrow mismatch (warning + critical + auto-resolve), and protocol pause verified.');

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
      const escEvt = webhookEvents
        .slice(preEscLen)
        .find((e) => e.action === 'escalate' && e.alert.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`);
      assert.ok(escEvt, 'Escalation must fire webhook immediately even within cooldown');
      assert.equal(escEvt.alert.severity, 'critical');

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
      const resEvt = webhookEvents
        .slice(preResLen)
        .find((e) => e.action === 'resolve' && e.alert.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`);
      assert.ok(resEvt, 'Clearing condition must emit resolve webhook');
      assert.equal(resEvt.alert.status, 'resolved');
      assert.ok(resEvt.alert.resolved_at !== null);
      assert.equal(summary.status, 'healthy');
      console.log(`PASS Scenario (g): Alert lifecycle & ${webhookEvents.length} webhook transitions verified.`);

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
      // Scenario (h): RPC failure resilience -> monitor_degraded + 503 + recovery
      // -----------------------------------------------------------------------
      console.log('\n=== Scenario (h): RPC failure degraded mode & recovery ===');
      // Trigger a warning alert BEFORE RPC dies to verify degraded scans preserve prior alerts
      await setNvdacCapAndStatus(900_000_000n, 0);
      t += 5_000;
      await runRiskScan(riskCtx, t);
      assert.ok(riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`));

      const deadRpcClient = new Proxy(publicClient, {
        get(target, prop, receiver) {
          if (prop === 'getBlockNumber' || prop === 'getBlock' || prop === 'multicall' || prop === 'readContract') {
            return async () => {
              throw new Error('ECONNREFUSED 127.0.0.1:9999');
            };
          }
          const val = Reflect.get(target, prop, receiver);
          return typeof val === 'function' ? val.bind(target) : val;
        },
      });
      const degradedCtx = { ...riskCtx, publicClient: deadRpcClient };
      t += 5_000;
      const degradedSum = await runRiskScan(degradedCtx, t);
      assert.equal(degradedSum.monitor_degraded, true);
      assert.equal(degradedSum.status, 'degraded');
      assert.ok(degradedSum.rpc_errors_total >= 1);
      assert.ok(riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === 'monitor:degraded'));
      assert.ok(
        riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === `asset_cap_util:${nvdac.toLowerCase()}`),
        'Pre-existing alert must be preserved during RPC outage'
      );

      const degSrv = createRiskServer(degradedCtx);
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

      // Restore healthy RPC & clear cap alert
      await setNvdacCapAndStatus(2_500_000_000n, 0);
      t += 5_000;
      const recovered = await runRiskScan(riskCtx, t);
      assert.equal(recovered.monitor_degraded, false);
      assert.equal(recovered.status, 'healthy');
      assert.equal(riskCtx.alerts.getActiveAlerts().some((a) => a.dedup_key === 'monitor:degraded'), false);
      console.log('PASS Scenario (h): Degraded RPC handling, alert preservation, 503 + metrics, and recovery verified.');

      // -----------------------------------------------------------------------
      // Scenario (i): DB connection drop resilience via PGLiteSocketServer (postgres:// wire)
      // -----------------------------------------------------------------------
      console.log('\n=== Scenario (i): PostgreSQL connection drop & pool error recovery ===');
      const pgPort = await getFreePort();
      const pgPglite = idxCtx.db as unknown as { db?: PGlite };
      const wirePglite = new PGlite();
      await wirePglite.waitReady;
      // Copy minimal schema & row data or use wirePglite? Check if idxCtx.db exposes PGlite:
      const activePglite = pgPglite.db ?? wirePglite;
      if (!pgPglite.db) {
        await wirePglite.exec(
          `CREATE TABLE indexer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL);
           CREATE TABLE assets (token TEXT PRIMARY KEY, symbol TEXT, decimals INTEGER, feed TEXT, feed_decimals INTEGER, status INTEGER);
           CREATE TABLE loans (loan_id TEXT PRIMARY KEY, collateral_token TEXT NOT NULL, collateral_raw TEXT NOT NULL, principal TEXT NOT NULL, principal_repaid TEXT NOT NULL, status INTEGER NOT NULL);
           CREATE TABLE auctions (auction_id TEXT PRIMARY KEY, loan_id TEXT NOT NULL, status INTEGER NOT NULL, start_time TEXT NOT NULL, duration TEXT NOT NULL);
           CREATE TABLE loan_events (id SERIAL PRIMARY KEY, event_name TEXT NOT NULL, block_number BIGINT NOT NULL, block_timestamp BIGINT NOT NULL);`
        );
      }

      const socketServer = new PGLiteSocketServer({
        db: activePglite,
        host: '127.0.0.1',
        port: pgPort,
        maxConnections: 5,
      });
      await socketServer.start();
      const wireDbUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/postgres`;
      try {
        const wireRiskCfg = loadRiskConfig({
          ...riskCfg,
          isFork: false, // also exercises postgres:// acceptance when FORK=false
          forkChainId: 8453,
          databaseUrl: wireDbUrl,
        });
        const wireRiskCtx = await createRiskContext(wireRiskCfg);
        try {
          const pool = (
            wireRiskCtx.db as unknown as {
              pool: {
                emit: (ev: string, err: Error) => void;
                _clients?: Array<{ connection?: { stream?: { destroy: () => void } } }>;
              };
            }
          ).pool;
          // Emit pool error ('57P01') + tear down underlying TCP stream
          pool.emit(
            'error',
            Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })
          );
          const stream = pool._clients?.[0]?.connection?.stream;
          if (stream) stream.destroy();

          const scanAfterDrop = await runRiskScan(wireRiskCtx, Date.now());
          assert.equal(scanAfterDrop.monitor_degraded, false);
          assert.equal(scanAfterDrop.chain_head_block !== null, true);
        } finally {
          await wireRiskCtx.db.close();
        }
      } finally {
        await socketServer.stop();
        await wirePglite.close();
      }
      console.log('PASS Scenario (i): ReadOnlyPostgresPool connection drop recovery verified.');

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
