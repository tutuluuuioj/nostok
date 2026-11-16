import assert from 'node:assert/strict';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http as viemHttp,
  parseAbi,
  parseEther,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { AuctionStatus, LoanStatus, OracleState, loanCoreAbi, liquidationAuctionAbi, oracleRouterAbi } from '../src/abi.js';
import { loadConfig } from '../src/config.js';
import { createKeeperContext, runKeeperCycle, validateChainId } from '../src/keeper.js';
import { executeContractAction } from '../src/tx.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KEEPER_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(KEEPER_DIR, '..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'contracts');

const FOUNDRY_BIN_DIR = process.env.FOUNDRY_BIN_DIR ?? `${process.env.HOME}/.foundry/bin`;
const ANVIL_PORT = Number(process.env.TEST_ANVIL_PORT ?? 18545);
const LOCAL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// Base Mainnet canonical USDC and Whale (Aave v3 Base USDC aToken / pool liquidity)
const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_USDC_WHALE: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';

// Ephemeral random test accounts (generated fresh per run so Base Mainnet EIP-7702 bots cannot interfere)
const KEYS = {
  deployer: generatePrivateKey(),
  owner: generatePrivateKey(),
  borrower: generatePrivateKey(),
  lender: generatePrivateKey(),
  keeper: generatePrivateKey(),
  guardian: generatePrivateKey(),
  treasury: generatePrivateKey(),
  reserve: generatePrivateKey(),
  attestationSigner: generatePrivateKey(),
};

const ADDRESSES = {
  deployer: privateKeyToAccount(KEYS.deployer).address,
  owner: privateKeyToAccount(KEYS.owner).address,
  guardian: privateKeyToAccount(KEYS.guardian).address,
  treasury: privateKeyToAccount(KEYS.treasury).address,
  reserve: privateKeyToAccount(KEYS.reserve).address,
  attestationSigner: privateKeyToAccount(KEYS.attestationSigner).address,
  borrower: privateKeyToAccount(KEYS.borrower).address,
  lender: privateKeyToAccount(KEYS.lender).address,
  keeper: privateKeyToAccount(KEYS.keeper).address,
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

interface ReceivedWebhook {
  type?: string;
  message?: string;
  text?: string;
  details?: Record<string, unknown>;
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

async function startAnvilFork(): Promise<{ proc: ChildProcess; forkUrlUsed: string }> {
  const candidates = process.env.FORK_RPC_URL
    ? [process.env.FORK_RPC_URL]
    : ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];

  for (const forkUrl of candidates) {
    console.log(`[TEST_SETUP] Starting Anvil fork against ${forkUrl} on port ${ANVIL_PORT}...`);
    const proc = spawn(
      `${FOUNDRY_BIN_DIR}/anvil`,
      ['--fork-url', forkUrl, '--port', String(ANVIL_PORT), '--chain-id', '8453', '--silent'],
      { env: getShellEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );

    try {
      await waitForRpcReady(LOCAL_RPC_URL, 25_000);
      console.log(`[TEST_SETUP] Anvil Base Mainnet fork ready (chainId=8453, rpc=${LOCAL_RPC_URL})`);
      return { proc, forkUrlUsed: forkUrl };
    } catch (err) {
      proc.kill('SIGKILL');
      console.warn(`[TEST_SETUP] Fork RPC ${forkUrl} failed: ${(err as Error).message}`);
    }
  }
  throw new Error('Unable to start Anvil fork against any Base Mainnet RPC');
}

function startMockTelegramWebhook(): Promise<{
  server: http.Server;
  url: string;
  received: ReceivedWebhook[];
}> {
  const received: ReceivedWebhook[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          received.push(JSON.parse(body) as ReceivedWebhook);
        } catch {
          received.push({ text: body });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('Unexpected webhook server address');
      }
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}/botTest/sendMessage`,
        received,
      });
    });
  });
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(LOCAL_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) {
    throw new Error(`RPC ${method} failed: ${json.error.message}`);
  }
  return json.result;
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
  if (!m) {
    throw new Error(`Failed to parse address for "${label}" from DeployNostok.s.sol output`);
  }
  return m[1] as Address;
}

function deployProtocolWithForge(): DeployedAddresses {
  console.log('[TEST_SETUP] Running DeployNostok.s.sol against local Base Mainnet fork...');
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

  const deployed: DeployedAddresses = {
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

  console.log('[TEST_SETUP] Deployed addresses:', deployed);
  return deployed;
}

async function runTests(): Promise<void> {
  const webhook = await startMockTelegramWebhook();
  const { proc: anvilProc } = await startAnvilFork();

  try {
    const forkChain = defineChain({
      id: 8453,
      name: 'Base Fork',
      nativeCurrency: base.nativeCurrency,
      rpcUrls: { default: { http: [LOCAL_RPC_URL] } },
    });

    const publicClient = createPublicClient({ chain: forkChain, transport: viemHttp(LOCAL_RPC_URL) });
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

    // Fund freshly generated test accounts with ETH on the local fork
    for (const addr of [
      ADDRESSES.deployer,
      ADDRESSES.owner,
      ADDRESSES.borrower,
      ADDRESSES.lender,
      ADDRESSES.keeper,
      ADDRESSES.guardian,
    ]) {
      await rpcCall('anvil_setBalance', [addr, '0x56bc75e2d63100000']); // 100 ETH
    }

    // Guardian requires code.length > 0 in DeployNostok.s.sol:36
    await rpcCall('anvil_setCode', [ADDRESSES.guardian, '0x600160005500']);

    const deployed = deployProtocolWithForge();

    // Deploy MockB20Token (NVDAc with real Base NVDAc multiplier 1.000537939576369481e18) and MockAggregator ($140)
    const mockB20Artifact = loadFoundryArtifact('MockB20Token.sol/MockB20Token.json');
    const mockAggArtifact = loadFoundryArtifact('MockAggregator.sol/MockAggregator.json');

    const initialMult = 1000537939576369481n;
    const nvdacTxHash = await deployerClient.deployContract({
      abi: mockB20Artifact.abi,
      bytecode: mockB20Artifact.bytecode,
      args: ['Coinbase Wrapped NVDA', 'NVDAc', 18, initialMult],
    });
    const nvdacReceipt = await publicClient.waitForTransactionReceipt({ hash: nvdacTxHash });
    const nvdac = nvdacReceipt.contractAddress!;

    const initialPrice = 140_00000000n; // $140.00 (8 decimals)
    const feedTxHash = await deployerClient.deployContract({
      abi: mockAggArtifact.abi,
      bytecode: mockAggArtifact.bytecode,
      args: [8, initialPrice],
    });
    const feedReceipt = await publicClient.waitForTransactionReceipt({ hash: feedTxHash });
    const nvdaFeed = feedReceipt.contractAddress!;

    console.log(`[TEST_SETUP] Deployed NVDAc=${nvdac}, NVDA/USD feed=${nvdaFeed}`);

    // Impersonate NostokTimelock on local fork to run initial governance config
    await rpcCall('anvil_impersonateAccount', [deployed.nostokTimelock]);
    await rpcCall('anvil_setBalance', [deployed.nostokTimelock, '0x56bc75e2d63100000']); // 100 ETH

    const timelockClient = createWalletClient({
      chain: forkChain,
      transport: viemHttp(LOCAL_RPC_URL),
    });

    // Enable manual open market session on fork so liquidation checks are deterministic 24/7
    const setMarketData = encodeFunctionData({
      abi: parseAbi(['function setMarketSession(bool isOpen, bool isManual)']),
      functionName: 'setMarketSession',
      args: [true, true],
    });
    const setMarketHash = await timelockClient.sendTransaction({
      account: deployed.nostokTimelock,
      to: deployed.oracleRouter,
      data: setMarketData,
    });
    await publicClient.waitForTransactionReceipt({ hash: setMarketHash });

    // Configure NVDAc in AssetRegistry (automatically calls syncMultiplier baseline in OracleRouter)
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

    const cfgData = encodeFunctionData({
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
          perLoanCap: 50_000_000_000n,
          assetCap: 100_000_000_000n,
          maxStaleOpenSecs: 21600,
          status: 0,
          restricted: false,
        },
      ],
    });
    const cfgHash = await timelockClient.sendTransaction({
      account: deployed.nostokTimelock,
      to: deployed.assetRegistry,
      data: cfgData,
    });
    await publicClient.waitForTransactionReceipt({ hash: cfgHash });

    const baselineMult = await publicClient.readContract({
      address: deployed.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'recordedMultiplier',
      args: [nvdac],
    });
    assert.equal(baselineMult, initialMult, 'AssetRegistry.setAssetConfig must record initial baseline');

    // Allowlist borrower and lender in EligibilityGate
    const allowHash = await ownerClient.writeContract({
      address: deployed.eligibilityGate,
      abi: parseAbi(['function setAllowlistBatch(address[] accounts, bool isAllowed)']),
      functionName: 'setAllowlistBatch',
      args: [[ADDRESSES.borrower, ADDRESSES.lender], true],
    });
    await publicClient.waitForTransactionReceipt({ hash: allowHash });

    // Configure process env for loadConfig() verification
    process.env.RPC_URL = LOCAL_RPC_URL;
    process.env.KEEPER_PRIVATE_KEY = KEYS.keeper;
    process.env.ORACLE_ROUTER_ADDRESS = deployed.oracleRouter;
    process.env.ASSET_REGISTRY_ADDRESS = deployed.assetRegistry;
    process.env.LOAN_CORE_ADDRESS = deployed.loanCore;
    process.env.LIQUIDATION_AUCTION_ADDRESS = deployed.liquidationAuction;
    process.env.ASSET_LIST = nvdac;
    process.env.TELEGRAM_WEBHOOK_URL = webhook.url;
    process.env.TELEGRAM_CHAT_ID = 'nostok-ops-alerts';
    delete process.env.DRY_RUN;

    // -------------------------------------------------------------------------
    // TEST 0: Default DRY_RUN=true simulates without broadcasting transactions
    // -------------------------------------------------------------------------
    console.log('\n=== TEST 0: DRY_RUN=true default behavior ===');
    const driftedMult1Pct = 1010543318972133175n; // +1% dividend drift
    const driftTx1 = await deployerClient.writeContract({
      address: nvdac,
      abi: mockB20Artifact.abi,
      functionName: 'setUIMultiplier',
      args: [driftedMult1Pct],
    });
    await publicClient.waitForTransactionReceipt({ hash: driftTx1 });

    const defaultConfig = loadConfig();
    assert.equal(defaultConfig.dryRun, true, 'DRY_RUN must default to true');
    const dryCtx = await createKeeperContext(defaultConfig);
    const drySummary = await runKeeperCycle(dryCtx);
    assert.equal(drySummary.syncMultiplierResults.length, 1);
    assert.equal(drySummary.syncMultiplierResults[0].simulated, true);
    assert.equal(drySummary.syncMultiplierResults[0].executed, false);
    assert.equal(drySummary.syncMultiplierResults[0].skippedDryRun, true);
    const multAfterDry = await publicClient.readContract({
      address: deployed.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'recordedMultiplier',
      args: [nvdac],
    });
    assert.equal(multAfterDry, initialMult, 'DRY_RUN=true must not mutate onchain state');
    console.log('PASS TEST 0: DRY_RUN=true simulated syncMultiplier cleanly with zero transactions sent.');

    // -------------------------------------------------------------------------
    // TEST 0b: Startup chainId verification (requires 8453 or FORK + FORK_CHAIN_ID)
    // -------------------------------------------------------------------------
    console.log('\n=== TEST 0b: Startup chainId verification ===');
    assert.throws(
      () => validateChainId(31337, { isFork: false, forkChainId: 8453 }),
      /Invalid chainId 31337: expected Base Mainnet \(8453\)/,
      'Non-8453 chainId must throw when FORK is false'
    );
    await assert.rejects(
      () => createKeeperContext({ ...defaultConfig, isFork: true, forkChainId: 99999 }),
      /Invalid fork chainId 8453: expected FORK_CHAIN_ID=99999/,
      'Mismatched FORK_CHAIN_ID must reject on startup'
    );
    const validForkCtx = await createKeeperContext({ ...defaultConfig, isFork: true, forkChainId: 8453 });
    assert.equal(validForkCtx.publicClient.chain.id, 8453);
    console.log('PASS TEST 0b: Startup chainId validation accepts 8453 and rejects mismatches cleanly.');

    // -------------------------------------------------------------------------
    // TEST 0c: Zero baseline (recordedMultiplier == 0) permissionless sync
    // -------------------------------------------------------------------------
    console.log('\n=== TEST 0c: Permissionless syncMultiplier on recordedMultiplier == 0 ===');
    const metacInitialMult = 1000313792289598084n; // real Base METAc multiplier scale
    const metacDeployHash = await deployerClient.deployContract({
      abi: mockB20Artifact.abi,
      bytecode: mockB20Artifact.bytecode,
      args: ['Coinbase Wrapped META', 'METAc', 18, metacInitialMult],
    });
    const metacReceipt = await publicClient.waitForTransactionReceipt({ hash: metacDeployHash });
    const metac = metacReceipt.contractAddress!;

    // Temporarily point AssetRegistry.oracleRouter to an EOA so listing METAc leaves recordedMultiplier[metac] == 0
    const setRouterAbi = parseAbi(['function setOracleRouter(address router)']);
    const tmpRouterHash = await timelockClient.sendTransaction({
      account: deployed.nostokTimelock,
      to: deployed.assetRegistry,
      data: encodeFunctionData({ abi: setRouterAbi, functionName: 'setOracleRouter', args: [ADDRESSES.reserve] }),
    });
    await publicClient.waitForTransactionReceipt({ hash: tmpRouterHash });

    const metacCfgHash = await timelockClient.sendTransaction({
      account: deployed.nostokTimelock,
      to: deployed.assetRegistry,
      data: encodeFunctionData({
        abi: setCfgAbi,
        functionName: 'setAssetConfig',
        args: [
          metac,
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
            perLoanCap: 50_000_000_000n,
            assetCap: 100_000_000_000n,
            maxStaleOpenSecs: 21600,
            status: 0,
            restricted: false,
          },
        ],
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash: metacCfgHash });

    const restoreRouterHash = await timelockClient.sendTransaction({
      account: deployed.nostokTimelock,
      to: deployed.assetRegistry,
      data: encodeFunctionData({ abi: setRouterAbi, functionName: 'setOracleRouter', args: [deployed.oracleRouter] }),
    });
    await publicClient.waitForTransactionReceipt({ hash: restoreRouterHash });

    const zeroRecBefore = await publicClient.readContract({
      address: deployed.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'recordedMultiplier',
      args: [metac],
    });
    assert.equal(zeroRecBefore, 0n, 'METAc initial recordedMultiplier should start at 0');

    const initSyncCtx = await createKeeperContext({
      ...defaultConfig,
      dryRun: false,
      assets: [metac],
    });
    const zeroSyncSummary = await runKeeperCycle(initSyncCtx);
    assert.equal(zeroSyncSummary.syncMultiplierResults.length, 1);
    assert.equal(zeroSyncSummary.syncMultiplierResults[0].executed, true);
    assert.equal(
      zeroSyncSummary.alertsEmitted.some((a) => a.type === 'FROZEN_SPLIT'),
      false,
      'Must call permissionless syncMultiplier instead of only alerting FROZEN_SPLIT when recordedMultiplier == 0'
    );
    const metacRecAfter = await publicClient.readContract({
      address: deployed.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'recordedMultiplier',
      args: [metac],
    });
    assert.equal(metacRecAfter, metacInitialMult, 'Keeper must initialize recordedMultiplier permissionlessly');
    console.log(`PASS TEST 0c: Keeper simulated and called syncMultiplier for zero baseline (0 -> ${metacRecAfter})`);

    // -------------------------------------------------------------------------
    // TEST (a): Syncing a small multiplier drift (>0% and <5%)
    // -------------------------------------------------------------------------
    console.log('\n=== TEST (a): Sync small multiplier drift (>0% and <5%) ===');
    process.env.DRY_RUN = 'false';
    const liveConfig = loadConfig();
    assert.equal(liveConfig.dryRun, false);
    const liveCtx = await createKeeperContext(liveConfig);

    const summaryA = await runKeeperCycle(liveCtx);
    assert.equal(summaryA.syncMultiplierResults.length, 1);
    assert.equal(summaryA.syncMultiplierResults[0].executed, true, 'Expected syncMultiplier tx to confirm');

    const multAfterSync = await publicClient.readContract({
      address: deployed.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'recordedMultiplier',
      args: [nvdac],
    });
    assert.equal(multAfterSync, driftedMult1Pct, 'OracleRouter.recordedMultiplier must match drifted value');
    console.log(`PASS TEST (a): Keeper synced 1% drift (${initialMult} -> ${multAfterSync})`);

    // -------------------------------------------------------------------------
    // TEST (b): Alerting and NOT syncing a >= 5% corporate action split jump
    // -------------------------------------------------------------------------
    console.log('\n=== TEST (b): Alert and skip >= 5% multiplier jump (frozen split) ===');
    const splitMult2x = 2021086637944266350n; // +100% jump (2:1 stock split)
    const splitTx = await deployerClient.writeContract({
      address: nvdac,
      abi: mockB20Artifact.abi,
      functionName: 'setUIMultiplier',
      args: [splitMult2x],
    });
    await publicClient.waitForTransactionReceipt({ hash: splitTx });

    const frozenState = await publicClient.readContract({
      address: deployed.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'getOracleState',
      args: [nvdac],
    });
    assert.equal(frozenState, OracleState.FROZEN_CORPORATE_ACTION, 'Oracle should be FROZEN_CORPORATE_ACTION');

    const webhooksBeforeSplit = webhook.received.length;
    const summaryB = await runKeeperCycle(liveCtx);
    assert.equal(summaryB.syncMultiplierResults.length, 0, 'Keeper must NOT call syncMultiplier on >=5% jump');

    const multAfterSplitAttempt = await publicClient.readContract({
      address: deployed.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'recordedMultiplier',
      args: [nvdac],
    });
    assert.equal(
      multAfterSplitAttempt,
      driftedMult1Pct,
      'OracleRouter.recordedMultiplier must remain unchanged on >=5% jump'
    );
    assert.ok(
      summaryB.alertsEmitted.some((a) => a.type === 'FROZEN_SPLIT'),
      'Expected FROZEN_SPLIT alert emitted'
    );
    assert.ok(
      webhook.received.slice(webhooksBeforeSplit).some((w) => w.type === 'FROZEN_SPLIT'),
      'Expected FROZEN_SPLIT delivered to Telegram webhook'
    );
    console.log('PASS TEST (b): Keeper did NOT call syncMultiplier on >=5% jump and delivered FROZEN_SPLIT alert.');

    // Unfreeze via Guardian Safe multisig calling OracleRouter.syncMultiplier(nvdac)
    await rpcCall('anvil_impersonateAccount', [ADDRESSES.guardian]);
    await rpcCall('anvil_setBalance', [ADDRESSES.guardian, '0x56bc75e2d63100000']);
    const guardianUnfreezeHash = await timelockClient.sendTransaction({
      account: ADDRESSES.guardian,
      to: deployed.oracleRouter,
      data: encodeFunctionData({
        abi: oracleRouterAbi,
        functionName: 'syncMultiplier',
        args: [nvdac],
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash: guardianUnfreezeHash });
    const postUnfreezeState = await publicClient.readContract({
      address: deployed.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'getOracleState',
      args: [nvdac],
    });
    assert.equal(postUnfreezeState, OracleState.VALID_OPEN, 'Guardian syncMultiplier unfreezes asset cleanly');

    // -------------------------------------------------------------------------
    // TEST (c): Starting a liquidation after a price drop
    // -------------------------------------------------------------------------
    console.log('\n=== TEST (c): Start liquidation after collateral price drop ===');
    const collateralAmt = 10n * 10n ** 18n; // 10 NVDAc ($1,400 at $140)
    const loanPrincipal = 800_000_000n; // 800 USDC (57.14% initial LTV < 60% maxInitLtv)

    const mintB20Hash = await deployerClient.writeContract({
      address: nvdac,
      abi: mockB20Artifact.abi,
      functionName: 'mint',
      args: [ADDRESSES.borrower, collateralAmt * 3n], // 30 NVDAc total for loan #1 and loan #2
    });
    await publicClient.waitForTransactionReceipt({ hash: mintB20Hash });

    // Fund lender with real Base Mainnet USDC from Aave v3 USDC whale
    await rpcCall('anvil_impersonateAccount', [BASE_USDC_WHALE]);
    await rpcCall('anvil_setBalance', [BASE_USDC_WHALE, '0x56bc75e2d63100000']);
    const fundUsdcHash = await timelockClient.sendTransaction({
      account: BASE_USDC_WHALE,
      to: BASE_USDC,
      data: encodeFunctionData({
        abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']),
        functionName: 'transfer',
        args: [ADDRESSES.lender, 5_000_000_000n],
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash: fundUsdcHash });

    const erc20ApproveAbi = parseAbi(['function approve(address spender, uint256 value) returns (bool)']);
    const bAppHash = await borrowerClient.writeContract({
      address: nvdac,
      abi: erc20ApproveAbi,
      functionName: 'approve',
      args: [deployed.collateralEscrow, collateralAmt * 3n],
    });
    await publicClient.waitForTransactionReceipt({ hash: bAppHash });

    const lAppHash = await lenderClient.writeContract({
      address: BASE_USDC,
      abi: erc20ApproveAbi,
      functionName: 'approve',
      args: [deployed.loanCore, 5_000_000_000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: lAppHash });

    const currentBlock = await publicClient.getBlock();
    const order1 = {
      borrower: ADDRESSES.borrower,
      collateralToken: nvdac,
      collateralAmount: collateralAmt,
      minUsdc: loanPrincipal,
      maxRateBps: 1000,
      termDays: 14,
      maxLtvBps: 6000,
      minFill: 500_000_000n,
      expiry: currentBlock.timestamp + 3600n,
      nonce: 0n,
      yieldMode: 0,
      allowInKindSettlement: false,
    } as const;

    const sig1 = await borrowerAccount.signTypedData({
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
      message: order1,
    });

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

    const fillHash1 = await lenderClient.writeContract({
      address: deployed.orderSettlement,
      abi: fillOrderAbi,
      functionName: 'fillBorrowOrder',
      args: [order1, sig1, loanPrincipal],
    });
    await publicClient.waitForTransactionReceipt({ hash: fillHash1 });

    // Confirm keeper skips healthy loan #1 at $140
    const healthySummary = await runKeeperCycle(liveCtx);
    assert.equal(healthySummary.liquidationResults.length, 0, 'Healthy loan #1 should not be liquidated');

    // Drop NVDA/USD price from $140 -> $100 (10 NVDAc = $1,000 => ~80.06% LTV >= 78% liqLtvBps)
    const dropTx = await deployerClient.writeContract({
      address: nvdaFeed,
      abi: mockAggArtifact.abi,
      functionName: 'setPrice',
      args: [100_00000000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: dropTx });

    const summaryC = await runKeeperCycle(liveCtx);
    assert.equal(summaryC.liquidationResults.length, 1);
    assert.equal(summaryC.liquidationResults[0].action, 'LoanCore.startLiquidation(1)');
    assert.equal(summaryC.liquidationResults[0].executed, true);

    const loan1After = await publicClient.readContract({
      address: deployed.loanCore,
      abi: loanCoreAbi,
      functionName: 'getLoan',
      args: [1n],
    });
    assert.equal(loan1After.status, LoanStatus.Auction, 'Loan #1 status must become Auction (2)');

    const auction1 = await publicClient.readContract({
      address: deployed.liquidationAuction,
      abi: liquidationAuctionAbi,
      functionName: 'getAuction',
      args: [1n],
    });
    assert.equal(auction1.status, AuctionStatus.Active, 'Auction #1 must be Active');
    assert.equal(auction1.startPrice, 99_00000000n, 'Auction #1 startPrice must be $99.00');
    assert.equal(auction1.floorPrice, 94_00000000n, 'Auction #1 floorPrice must be $94.00');
    console.log(
      `PASS TEST (c): Keeper triggered startLiquidation(1) -> Auction #1 Active (startPrice=$99, floorPrice=$94)`
    );

    // -------------------------------------------------------------------------
    // TEST (d): Restarting an expired auction past 30 minutes
    // -------------------------------------------------------------------------
    console.log('\n=== TEST (d): Restart expired auction past 30 minutes ===');
    await rpcCall('evm_increaseTime', [1860]); // 31 minutes > 1800s duration
    await rpcCall('evm_mine', []);

    // Keep feed fresh at $98.00
    const refresh98Tx = await deployerClient.writeContract({
      address: nvdaFeed,
      abi: mockAggArtifact.abi,
      functionName: 'setPrice',
      args: [98_00000000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: refresh98Tx });

    const summaryD = await runKeeperCycle(liveCtx);
    assert.equal(summaryD.expiredAuctionResults.length, 1);
    assert.equal(summaryD.expiredAuctionResults[0].action, 'LiquidationAuction.restartOrCancelAuction(1)');
    assert.equal(summaryD.expiredAuctionResults[0].executed, true);

    const auction1Restarted = await publicClient.readContract({
      address: deployed.liquidationAuction,
      abi: liquidationAuctionAbi,
      functionName: 'getAuction',
      args: [1n],
    });
    assert.equal(auction1Restarted.status, AuctionStatus.Active);
    assert.equal(auction1Restarted.startPrice, 97_02000000n, 'Restarted startPrice must be 99% of $98 = $97.02');
    assert.equal(auction1Restarted.floorPrice, 92_12000000n, 'Restarted floorPrice must be 94% of $98 = $92.12');
    assert.ok(auction1Restarted.startTime > auction1.startTime, 'Auction #1 startTime must advance on restart');
    console.log(
      `PASS TEST (d): Keeper restarted expired Auction #1 (new startTime=${auction1Restarted.startTime}, startPrice=$97.02, floorPrice=$92.12)`
    );

    // -------------------------------------------------------------------------
    // TEST (e): Guardrails — STALE_FEED alert + no-op skip, LOW_ETH_BALANCE alert, and startDefaultAuction
    // -------------------------------------------------------------------------
    console.log('\n=== TEST (e): Stale-feed guard, low ETH balance alert, and startDefaultAuction (maturity + 24h) ===');
    // Bump borrower nonce and open Loan #2 with 20 NVDAc ($1,960 at $98 -> 40.8% LTV, 7-day term)
    const bNonceTx = await borrowerClient.writeContract({
      address: deployed.orderSettlement,
      abi: parseAbi(['function bumpNonce() returns (uint256)']),
      functionName: 'bumpNonce',
    });
    await publicClient.waitForTransactionReceipt({ hash: bNonceTx });

    const block2 = await publicClient.getBlock();
    const order2 = {
      borrower: ADDRESSES.borrower,
      collateralToken: nvdac,
      collateralAmount: collateralAmt * 2n,
      minUsdc: loanPrincipal,
      maxRateBps: 1000,
      termDays: 7,
      maxLtvBps: 6000,
      minFill: 500_000_000n,
      expiry: block2.timestamp + 3600n,
      nonce: 1n,
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
      message: order2,
    });

    const fillHash2 = await lenderClient.writeContract({
      address: deployed.orderSettlement,
      abi: fillOrderAbi,
      functionName: 'fillBorrowOrder',
      args: [order2, sig2, loanPrincipal],
    });
    await publicClient.waitForTransactionReceipt({ hash: fillHash2 });

    // Advance 8 days + 60s without updating the price feed -> feed is > 86,400s stale AND Loan #2 > maturity + 24h
    await rpcCall('evm_increaseTime', [8 * 86_400 + 60]);
    await rpcCall('evm_mine', []);

    const webhooksBeforeStale = webhook.received.length;
    const staleSummary = await runKeeperCycle(liveCtx);
    assert.equal(staleSummary.expiredAuctionResults.length, 0, 'Must skip Auction #1 restart when stale age > maxFeedAge');
    assert.equal(staleSummary.liquidationResults.length, 0, 'Must skip startDefaultAuction when oracle is STALE_FEED');
    assert.ok(
      staleSummary.alertsEmitted.some((a) => a.type === 'STALE_FEED'),
      'Expected STALE_FEED alert'
    );
    assert.ok(
      webhook.received.slice(webhooksBeforeStale).some((w) => w.type === 'STALE_FEED'),
      'Expected STALE_FEED webhook alert'
    );

    // Refresh oracle feed so state returns to VALID_OPEN and trigger default auction + LOW_ETH_BALANCE check
    const refreshTx2 = await deployerClient.writeContract({
      address: nvdaFeed,
      abi: mockAggArtifact.abi,
      functionName: 'setPrice',
      args: [98_00000000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: refreshTx2 });

    const lowEthCtx = await createKeeperContext({
      ...liveConfig,
      minKeeperEthWei: parseEther('100000'),
    });
    const summaryE = await runKeeperCycle(lowEthCtx);
    assert.ok(
      summaryE.alertsEmitted.some((a) => a.type === 'LOW_ETH_BALANCE'),
      'Expected LOW_ETH_BALANCE alert'
    );
    assert.equal(summaryE.liquidationResults.length, 1);
    assert.equal(summaryE.liquidationResults[0].action, 'LoanCore.startDefaultAuction(2)');
    assert.equal(summaryE.liquidationResults[0].executed, true);

    const auction2 = await publicClient.readContract({
      address: deployed.liquidationAuction,
      abi: liquidationAuctionAbi,
      functionName: 'getAuction',
      args: [2n],
    });
    assert.equal(auction2.status, AuctionStatus.Active);
    assert.equal(auction2.isDefaultAuction, true, 'Auction #2 must be flagged as default auction');

    // Verify simulateContract pre-flight guard skips reverting txs and emits FAILED_TX
    const webhooksBeforeFail = webhook.received.length;
    const revRes = await executeContractAction({
      label: 'LoanCore.startLiquidation(999)',
      address: deployed.loanCore,
      abi: loanCoreAbi,
      functionName: 'startLiquidation',
      args: [999n],
      publicClient: liveCtx.publicClient,
      walletClient: liveCtx.walletClient,
      dryRun: false,
      alerts: liveCtx.alerts,
    });
    assert.equal(revRes.simulated, false, 'Reverting simulation must mark simulated=false');
    assert.equal(revRes.executed, false, 'Reverting simulation must not broadcast tx');
    assert.ok(
      webhook.received.slice(webhooksBeforeFail).some((w) => w.type === 'FAILED_TX'),
      'Expected FAILED_TX webhook alert on reverted simulation'
    );

    console.log(
      `PASS TEST (e): STALE_FEED, LOW_ETH_BALANCE, FAILED_TX alerts & webhooks verified; startDefaultAuction(2) started Auction #2 (isDefaultAuction=true).`
    );

    // -------------------------------------------------------------------------
    // TEST (f): MAX_GAS_PRICE_GWEI cap & stuck tx timeout / replacement handling
    // -------------------------------------------------------------------------
    console.log('\n=== TEST (f): MAX_GAS_PRICE_GWEI cap & stuck tx timeout/replacement ===');
    const metacDrift1 = 1005315361251046074n; // +0.5% drift on METAc
    const metacDriftTx1 = await deployerClient.writeContract({
      address: metac,
      abi: mockB20Artifact.abi,
      functionName: 'setUIMultiplier',
      args: [metacDrift1],
    });
    await publicClient.waitForTransactionReceipt({ hash: metacDriftTx1 });

    // Part 1: High gas cap skip + alert
    const webhooksBeforeGasCap = webhook.received.length;
    const highGasCtx = await createKeeperContext({
      ...liveConfig,
      assets: [metac],
      maxGasPriceWei: 1n, // 1 wei forces eth_gasPrice > maxGasPriceWei
    });
    const gasCapSummary = await runKeeperCycle(highGasCtx);
    assert.equal(gasCapSummary.syncMultiplierResults.length, 1);
    assert.equal(gasCapSummary.syncMultiplierResults[0].executed, false);
    assert.equal(gasCapSummary.syncMultiplierResults[0].skippedGasCap, true);
    assert.ok(
      gasCapSummary.alertsEmitted.some((a) => a.type === 'HIGH_GAS_PRICE'),
      'Expected HIGH_GAS_PRICE alert'
    );
    assert.ok(
      webhook.received.slice(webhooksBeforeGasCap).some((w) => w.type === 'HIGH_GAS_PRICE'),
      'Expected HIGH_GAS_PRICE webhook alert'
    );

    // Part 2: Stuck tx timeout -> fee-bumped replacement succeeds without blocking
    let automineDisabled = false;
    try {
      await rpcCall('anvil_setAutomine', [false]);
      automineDisabled = true;

      // Re-enable automine after initial 500ms tx timeout fires so the replacement tx mines inside its wait window
      const timer = setTimeout(() => {
        void (async () => {
          try {
            await rpcCall('anvil_setAutomine', [true]);
            automineDisabled = false;
            await rpcCall('evm_mine', []);
          } catch {
            // handled in finally
          }
        })();
      }, 750);

      const repRes = await executeContractAction({
        label: 'OracleRouter.syncMultiplier(METAc)',
        address: deployed.oracleRouter,
        abi: oracleRouterAbi,
        functionName: 'syncMultiplier',
        args: [metac],
        publicClient: liveCtx.publicClient,
        walletClient: liveCtx.walletClient,
        dryRun: false,
        alerts: liveCtx.alerts,
        maxGasPriceWei: liveConfig.maxGasPriceWei,
        txTimeoutMs: 500,
        txBumpBps: 2500,
      });
      clearTimeout(timer);

      assert.equal(repRes.executed, true, 'Replacement tx should confirm after initial tx times out');
      assert.ok(repRes.replacedTxHash, 'Replacement result must record replacedTxHash');
      assert.notEqual(repRes.txHash, repRes.replacedTxHash, 'Replacement txHash must differ from original stuck tx');
      assert.ok(
        liveCtx.alerts.history.some((a) => a.type === 'STUCK_TX'),
        'Expected STUCK_TX alert on replacement'
      );

      // Part 3: Unmined replacement also times out -> logs/alerts STUCK_TX cleanly without throwing
      const metacDrift2 = 1010341938057301304n; // another +0.5% drift
      if (automineDisabled) {
        await rpcCall('anvil_setAutomine', [true]);
        automineDisabled = false;
      }
      const metacDriftTx2 = await deployerClient.writeContract({
        address: metac,
        abi: mockB20Artifact.abi,
        functionName: 'setUIMultiplier',
        args: [metacDrift2],
      });
      await publicClient.waitForTransactionReceipt({ hash: metacDriftTx2 });

      await rpcCall('anvil_setAutomine', [false]);
      automineDisabled = true;

      const stuckAlertBefore = liveCtx.alerts.history.length;
      const stuckFailRes = await executeContractAction({
        label: 'OracleRouter.syncMultiplier(METAc-stuck)',
        address: deployed.oracleRouter,
        abi: oracleRouterAbi,
        functionName: 'syncMultiplier',
        args: [metac],
        publicClient: liveCtx.publicClient,
        walletClient: liveCtx.walletClient,
        dryRun: false,
        alerts: liveCtx.alerts,
        maxGasPriceWei: liveConfig.maxGasPriceWei,
        txTimeoutMs: 250,
        txBumpBps: 2500,
      });
      assert.equal(stuckFailRes.executed, false, 'Timed out replacement must not hang or throw');
      assert.ok(
        liveCtx.alerts.history.slice(stuckAlertBefore).some((a) => a.type === 'STUCK_TX'),
        'Expected STUCK_TX alert when replacement also times out'
      );
    } finally {
      if (automineDisabled) {
        await rpcCall('anvil_setAutomine', [true]);
        await rpcCall('evm_mine', []);
      }
    }
    console.log('PASS TEST (f): MAX_GAS_PRICE_GWEI skip/alert and STUCK_TX timeout/replacement verified.');

    // -------------------------------------------------------------------------
    // TEST (g): Isolate failures per loan and per job without halting the round
    // -------------------------------------------------------------------------
    console.log('\n=== TEST (g): Failure isolation (faulty loan read + faulty job) ===');
    // Reset METAc drift by syncing remaining drift cleanly, then ensure fresh NVDAc supply for Loans #3 and #4
    const resyncMetac = await executeContractAction({
      label: 'OracleRouter.syncMultiplier(METAc)',
      address: deployed.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'syncMultiplier',
      args: [metac],
      publicClient: liveCtx.publicClient,
      walletClient: liveCtx.walletClient,
      dryRun: false,
      alerts: liveCtx.alerts,
      maxGasPriceWei: liveConfig.maxGasPriceWei,
    });
    assert.equal(resyncMetac.executed, true);

    const extraMintHash = await deployerClient.writeContract({
      address: nvdac,
      abi: mockB20Artifact.abi,
      functionName: 'mint',
      args: [ADDRESSES.borrower, 30n * 10n ** 18n],
    });
    await publicClient.waitForTransactionReceipt({ hash: extraMintHash });

    const extraAppHash = await borrowerClient.writeContract({
      address: nvdac,
      abi: erc20ApproveAbi,
      functionName: 'approve',
      args: [deployed.collateralEscrow, 100n * 10n ** 18n],
    });
    await publicClient.waitForTransactionReceipt({ hash: extraAppHash });

    const bNonceTx2 = await borrowerClient.writeContract({
      address: deployed.orderSettlement,
      abi: parseAbi(['function bumpNonce() returns (uint256)']),
      functionName: 'bumpNonce',
    });
    await publicClient.waitForTransactionReceipt({ hash: bNonceTx2 });

    const block3 = await publicClient.getBlock();
    const order3 = {
      borrower: ADDRESSES.borrower,
      collateralToken: nvdac,
      collateralAmount: 20n * 10n ** 18n, // 20 NVDAc @ $98 = $1,960 total (10 NVDAc per 550 USDC fill)
      minUsdc: 1_100_000_000n, // 1,100 USDC total (56.12% LTV <= 60%)
      maxRateBps: 1000,
      termDays: 14,
      maxLtvBps: 6000,
      minFill: 500_000_000n,
      expiry: block3.timestamp + 3600n,
      nonce: 2n,
      yieldMode: 0,
      allowInKindSettlement: false,
    } as const;

    const sig3 = await borrowerAccount.signTypedData({
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
      message: order3,
    });

    // Open Loan #3 (550 USDC / 10 NVDAc) and Loan #4 (550 USDC / 10 NVDAc)
    const fillHash3 = await lenderClient.writeContract({
      address: deployed.orderSettlement,
      abi: fillOrderAbi,
      functionName: 'fillBorrowOrder',
      args: [order3, sig3, 550_000_000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: fillHash3 });

    const fillHash4 = await lenderClient.writeContract({
      address: deployed.orderSettlement,
      abi: fillOrderAbi,
      functionName: 'fillBorrowOrder',
      args: [order3, sig3, 550_000_000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: fillHash4 });

    // Drop NVDA/USD price from $98 -> $65 (10 NVDAc = $650 => LTV ~84.62% >= 78% liqLtvBps)
    const drop65Tx = await deployerClient.writeContract({
      address: nvdaFeed,
      abi: mockAggArtifact.abi,
      functionName: 'setPrice',
      args: [65_00000000n],
    });
    await publicClient.waitForTransactionReceipt({ hash: drop65Tx });

    // Sub-test g1: Inject an RPC failure specifically on Loan #3's getLoan read; Loan #4 MUST still be liquidated
    const origReadContract = liveCtx.publicClient.readContract.bind(liveCtx.publicClient);
    const faultyLoanClient = {
      ...liveCtx.publicClient,
      readContract: (async (parameters: Parameters<typeof liveCtx.publicClient.readContract>[0]) => {
        if (
          parameters.functionName === 'getLoan' &&
          Array.isArray(parameters.args) &&
          parameters.args[0] === 3n
        ) {
          throw new Error('Injected RPC failure reading Loan #3');
        }
        return origReadContract(parameters);
      }) as typeof liveCtx.publicClient.readContract,
    };

    const g1Ctx = { ...liveCtx, publicClient: faultyLoanClient };
    const summaryG1 = await runKeeperCycle(g1Ctx);

    assert.ok(
      summaryG1.alertsEmitted.some(
        (a) => a.type === 'RPC_ERROR' && a.details.loanId === '3'
      ),
      'Expected RPC_ERROR alert for failing Loan #3'
    );
    assert.ok(
      summaryG1.liquidationResults.some(
        (r) => r.action === 'LoanCore.startLiquidation(4)' && r.executed === true
      ),
      'Expected Loan #4 to still be liquidated despite Loan #3 RPC read throwing'
    );

    const loan3Check = await publicClient.readContract({
      address: deployed.loanCore,
      abi: loanCoreAbi,
      functionName: 'getLoan',
      args: [3n],
    });
    const loan4Check = await publicClient.readContract({
      address: deployed.loanCore,
      abi: loanCoreAbi,
      functionName: 'getLoan',
      args: [4n],
    });
    assert.equal(loan3Check.status, LoanStatus.Active, 'Loan #3 was skipped after its RPC read threw');
    assert.equal(loan4Check.status, LoanStatus.Auction, 'Loan #4 must be liquidated in the same round');

    // Sub-test g2: Job-level failure isolation — expiredAuction job throws on nextAuctionId, liquidation still runs Loan #3
    const faultyJobClient = {
      ...liveCtx.publicClient,
      readContract: (async (parameters: Parameters<typeof liveCtx.publicClient.readContract>[0]) => {
        if (parameters.functionName === 'nextAuctionId') {
          throw new Error('Injected RPC failure in expiredAuction job');
        }
        return origReadContract(parameters);
      }) as typeof liveCtx.publicClient.readContract,
    };
    const g2Ctx = { ...liveCtx, publicClient: faultyJobClient };
    const summaryG2 = await runKeeperCycle(g2Ctx);

    assert.ok(
      summaryG2.alertsEmitted.some(
        (a) => a.type === 'RPC_ERROR' && a.details.job === 'expiredAuction'
      ),
      'Expected RPC_ERROR alert for failing expiredAuction job'
    );
    assert.ok(
      summaryG2.liquidationResults.some(
        (r) => r.action === 'LoanCore.startLiquidation(3)' && r.executed === true
      ),
      'Expected liquidation job to liquidate Loan #3 cleanly even when expiredAuction job fails'
    );

    console.log(
      'PASS TEST (g): Faulty loan #3 logged + alerted RPC_ERROR while loan #4 was liquidated in the same round; faulty expiredAuction job did not crash round.'
    );

    console.log('\nALL KEEPER BASE MAINNET FORK INTEGRATION TESTS PASSED.');
  } finally {
    anvilProc.kill('SIGKILL');
    await new Promise<void>((resolve) => webhook.server.close(() => resolve()));
    fs.rmSync(path.join(CONTRACTS_DIR, 'broadcast'), { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('\nFORK TEST FAILED:', err);
  process.exit(1);
});
