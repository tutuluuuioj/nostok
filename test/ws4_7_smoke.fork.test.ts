/// <reference path="./ambient.d.ts" />
import assert from 'node:assert/strict';
import { execSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
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
  keccak256,
  parseAbi,
  stringToBytes,
  zeroAddress,
  zeroHash,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  BORROW_ORDER_EIP712_TYPES,
  LEND_OFFER_EIP712_TYPES,
  ORDER_SETTLEMENT_DOMAIN_NAME,
  ORDER_SETTLEMENT_DOMAIN_VERSION,
  erc20Abi,
  eligibilityGateAbi,
  feeCollectorAbi,
  liquidationAuctionAbi,
  loanCoreAbi,
  oracleRouterAbi,
  orderSettlementAbi,
  positionNftAbi,
  setFrontendConfigOverrides,
} from '../src/lib/contracts.js';
import {
  approveUsdcForLend,
  executeLoanClaim,
  executeLoanExtend,
  executeLoanRepay,
  executeLoanTopUp,
  fetchWalletPositionsAndClaimable,
  setCollateralAllowanceForBorrow,
  signLoanExtension,
} from '../src/lib/web3.js';
import {
  BASE_MAINNET_SMOKE_ASSETS,
  DEFAULT_INITIALIZER_GLOBAL_CAP_RAW,
  RECOMMENDED_MAX_STALE_OPEN_SECS,
  TIMELOCK_MIN_DELAY_SECS,
  evaluateSafeSnapshot,
  runGuardedSmokePreflight,
  sanitizeRpcErrorMessage,
  validateGlobalSmokeCap,
  validateSmokeAssetConfig,
  verifyForkRpcNode,
} from '../scripts/ws4_7_smoke_lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'contracts');
const FOUNDRY_BIN_DIR = process.env.FOUNDRY_BIN_DIR ?? `${process.env.HOME}/.foundry/bin`;
const ANVIL_PORT = Number(process.env.TEST_WS4_7_ANVIL_PORT ?? 18551);
const LOCAL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const BASE_USDC_WHALE: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';

// Canonical Base Mainnet Safe v1.3.0 factory & singleton contracts for genuine Safe proxy deployment on fork.
const BASE_SAFE_PROXY_FACTORY_V1_3: Address = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2';
const BASE_GNOSIS_SAFE_L2_V1_3: Address = '0x3E5c63644E683549055b9Be8653de26E0B4CD36E';

const KEYS = {
  deployer: generatePrivateKey(),
  safeSignerA: generatePrivateKey(),
  safeSignerB: generatePrivateKey(),
  guardianSignerA: generatePrivateKey(),
  guardianSignerB: generatePrivateKey(),
  borrower: generatePrivateKey(),
  lender: generatePrivateKey(),
  liquidator: generatePrivateKey(),
  keeper: generatePrivateKey(),
  treasury: generatePrivateKey(),
  reserve: generatePrivateKey(),
  attestationSigner: generatePrivateKey(),
};

const ADDRESSES = {
  deployer: privateKeyToAccount(KEYS.deployer).address,
  safeSignerA: privateKeyToAccount(KEYS.safeSignerA).address,
  safeSignerB: privateKeyToAccount(KEYS.safeSignerB).address,
  guardianSignerA: privateKeyToAccount(KEYS.guardianSignerA).address,
  guardianSignerB: privateKeyToAccount(KEYS.guardianSignerB).address,
  borrower: privateKeyToAccount(KEYS.borrower).address,
  lender: privateKeyToAccount(KEYS.lender).address,
  liquidator: privateKeyToAccount(KEYS.liquidator).address,
  keeper: privateKeyToAccount(KEYS.keeper).address,
  treasury: privateKeyToAccount(KEYS.treasury).address,
  reserve: privateKeyToAccount(KEYS.reserve).address,
  attestationSigner: privateKeyToAccount(KEYS.attestationSigner).address,
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
    console.log(`[WS4.7_SMOKE] Starting Anvil Base fork against ${forkUrl} on port ${ANVIL_PORT}...`);
    const proc = spawn(
      `${FOUNDRY_BIN_DIR}/anvil`,
      ['--fork-url', forkUrl, '--port', String(ANVIL_PORT), '--chain-id', '8453', '--silent'],
      { env: getShellEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await waitForRpcReady(LOCAL_RPC_URL, 25_000);
      console.log('[WS4.7_SMOKE] Anvil Base Mainnet fork ready (chainId=8453)');
      return proc;
    } catch (err) {
      proc.kill('SIGKILL');
      console.warn(`[WS4.7_SMOKE] Fork RPC ${forkUrl} failed: ${(err as Error).message}`);
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

function deployProtocolWithForge(ownerSafe: Address, guardianSafe: Address) {
  console.log('[WS4.7_SMOKE] Deploying NOSTOK protocol via DeployNostok.s.sol...');
  const stdout = execSync(
    `forge script script/DeployNostok.s.sol --rpc-url ${LOCAL_RPC_URL} --broadcast`,
    {
      cwd: CONTRACTS_DIR,
      env: {
        ...getShellEnv(),
        DEPLOYER_PRIVATE_KEY: KEYS.deployer,
        OWNER_ADDRESS: ownerSafe,
        GUARDIAN_ADDRESS: guardianSafe,
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

function createMockEip1193Provider(initialKey: Hex) {
  let account = privateKeyToAccount(initialKey);
  const chain = defineChain({
    ...base,
    id: BASE_CHAIN_ID,
    rpcUrls: { default: { http: [LOCAL_RPC_URL] } },
  });
  return {
    setAccount(nextKey: Hex) {
      account = privateKeyToAccount(nextKey);
    },
    async request({ method, params = [] }: { method: string; params?: unknown[] }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        return [account.address];
      }
      if (method === 'eth_chainId') {
        return '0x2105';
      }
      if (method === 'eth_signTypedData_v4') {
        const [, rawTyped] = params as [string, string];
        const typed = JSON.parse(rawTyped) as Parameters<typeof account.signTypedData>[0];
        return account.signTypedData(typed);
      }
      if (method === 'personal_sign') {
        const [rawMsg] = params as [Hex, string];
        return account.signMessage({ message: { raw: rawMsg } });
      }
      if (method === 'eth_sendTransaction') {
        const tx = params[0] as { from?: Address; to: Address; data?: Hex; value?: Hex };
        const wc = createWalletClient({
          account,
          chain,
          transport: viemHttp(LOCAL_RPC_URL),
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

async function runCliAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function validateDeploymentAndSmokeRunbooks(): void {
  const deployRunbook = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'DEPLOYMENT_RUNBOOK.md'), 'utf8');
  const smokeRunbook = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'WS4_7_MAINNET_SMOKE_RUNBOOK.md'), 'utf8');
  const deploySol = fs.readFileSync(path.join(REPO_ROOT, 'contracts', 'script', 'DeployNostok.s.sol'), 'utf8');
  const assetRegistrySol = fs.readFileSync(
    path.join(REPO_ROOT, 'contracts', 'src', 'interfaces', 'IAssetRegistry.sol'),
    'utf8'
  );
  const indexerDbTs = fs.readFileSync(path.join(REPO_ROOT, 'indexer', 'src', 'db.ts'), 'utf8');
  const notifDbTs = fs.readFileSync(path.join(REPO_ROOT, 'notifications', 'src', 'db.ts'), 'utf8');
  const rootEnvEx = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');

  // Verify every env var read by DeployNostok.s.sol is covered in DEPLOYMENT_RUNBOOK.md
  for (const envVar of [
    'DEPLOYER_PRIVATE_KEY',
    'OWNER_ADDRESS',
    'GUARDIAN_ADDRESS',
    'TREASURY_ADDRESS',
    'RESERVE_ADDRESS',
    'ATTESTATION_SIGNER',
    'USDC_ADDRESS',
    'SEQUENCER_FEED',
  ]) {
    assert.ok(deploySol.includes(`"${envVar}"`), `DeployNostok.s.sol missing expected env var ${envVar}`);
    assert.ok(deployRunbook.includes(envVar), `docs/DEPLOYMENT_RUNBOOK.md must document ${envVar}`);
  }

  // Verify exact AssetConfig struct fields extracted from IAssetRegistry.sol appear in setAssetConfig section
  const assetCfgStruct = assetRegistrySol.match(/struct\s+AssetConfig\s*\{([\s\S]*?)\}/);
  assert.ok(assetCfgStruct, 'IAssetRegistry.sol must declare struct AssetConfig');
  const assetConfigFields = assetCfgStruct[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .map((decl) => decl.match(/^\S+\s+([A-Za-z_][A-Za-z0-9_]*)\s*;$/)?.[1])
    .filter((name): name is string => Boolean(name));
  assert.ok(assetConfigFields.length >= 14, `Expected >=14 AssetConfig fields in IAssetRegistry.sol, got ${assetConfigFields.length}`);
  const assetCfgSection =
    deployRunbook.match(/AssetRegistry\.setAssetConfig\(token,\s*cfg\)([\s\S]*?)-\s*Confirm\s+`OracleRouter\.recordedMultiplier/)?.[1] ?? '';
  assert.ok(assetCfgSection.length > 0, 'docs/DEPLOYMENT_RUNBOOK.md must contain AssetRegistry.setAssetConfig section');
  for (const field of assetConfigFields) {
    assert.ok(
      assetCfgSection.includes(field),
      `docs/DEPLOYMENT_RUNBOOK.md setAssetConfig section must document IAssetRegistry.AssetConfig field "${field}"`
    );
  }
  assert.ok(!assetCfgSection.includes('minInterestDays'), 'AssetConfig section must not list minInterestDays');
  assert.ok(!assetCfgSection.includes('maxStaleClosedSecs'), 'AssetConfig section must not list maxStaleClosedSecs');

  // Verify every table created by indexer/src/db.ts & notifications/src/db.ts appears in DEPLOYMENT_RUNBOOK.md DB provisioning SQL
  const indexerTables = Array.from(indexerDbTs.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/g), (m) => m[1]);
  const notifTables = Array.from(notifDbTs.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/g), (m) => m[1]);
  assert.ok(indexerTables.length >= 11, `Expected >=11 tables in indexer/src/db.ts, got ${indexerTables.length}`);
  assert.ok(notifTables.length >= 12, `Expected >=12 tables in notifications/src/db.ts, got ${notifTables.length}`);
  for (const table of indexerTables) {
    assert.ok(deployRunbook.includes(table), `docs/DEPLOYMENT_RUNBOOK.md must list indexer table "${table}"`);
  }
  for (const table of notifTables) {
    assert.ok(deployRunbook.includes(table), `docs/DEPLOYMENT_RUNBOOK.md must list notifications table "${table}"`);
  }

  // Verify ETHERSCAN_API_KEY env var usage (never --etherscan-api-key CLI flag), GRANT SQL, and rollback controls
  assert.ok(!deployRunbook.includes('--etherscan-api-key'), 'Runbook must not pass --etherscan-api-key on CLI');
  assert.ok(deployRunbook.includes('ETHERSCAN_API_KEY'), 'Runbook must use ETHERSCAN_API_KEY env var');
  for (const sqlAndRollbackTerm of [
    'GRANT SELECT',
    'ALTER DEFAULT PRIVILEGES',
    'GRANT USAGE, CREATE ON SCHEMA',
    'initNotifSchema',
    'hashOperationBatch',
    'cancel(',
  ]) {
    assert.ok(deployRunbook.includes(sqlAndRollbackTerm), `docs/DEPLOYMENT_RUNBOOK.md must document ${sqlAndRollbackTerm}`);
  }

  // Verify pinned Base Mainnet USDC, Sequencer feed, and B20/Chainlink addresses match across runbooks & code
  assert.ok(deploySol.includes(BASE_USDC_ADDRESS), 'DeployNostok.s.sol must pin Base USDC');
  for (const text of [deployRunbook, smokeRunbook]) {
    assert.ok(text.includes(BASE_USDC_ADDRESS), 'Runbook must reference Base USDC');
    assert.ok(text.includes('0xBCF85224fc0756B9Fa45aA7892530B47e10b6433'), 'Runbook must reference Base Sequencer Uptime feed');
    for (const pinned of Object.values(BASE_MAINNET_SMOKE_ASSETS)) {
      assert.ok(text.includes(pinned.token), `Runbook must reference pinned ${pinned.symbol} token`);
      assert.ok(text.includes(pinned.feed), `Runbook must reference pinned ${pinned.symbol} Chainlink feed`);
    }
    assert.ok(text.includes('scripts/ws4_7_smoke_lib.mjs'), 'Runbook must reference preflight CLI');
  }

  // Verify all frontend VITE_* build variables & backend fail-closed requirements are documented
  for (const viteKey of [
    'VITE_CHAIN_ID',
    'VITE_IS_FORK',
    'VITE_RPC_URL',
    'VITE_API_URL',
    'VITE_NOTIFICATIONS_URL',
    'VITE_RISK_URL',
    'VITE_SIWE_DOMAIN',
    'VITE_SIWE_ORIGIN',
    'VITE_USDC_ADDRESS',
    'VITE_LOAN_CORE_ADDRESS',
    'VITE_ORDER_SETTLEMENT_ADDRESS',
    'VITE_LIQUIDATION_AUCTION_ADDRESS',
    'VITE_POSITION_NFT_ADDRESS',
    'VITE_COLLATERAL_ESCROW_ADDRESS',
    'VITE_ASSET_REGISTRY_ADDRESS',
    'VITE_ORACLE_ROUTER_ADDRESS',
    'VITE_ELIGIBILITY_GATE_ADDRESS',
    'VITE_DEPLOY_BLOCK',
  ]) {
    assert.ok(rootEnvEx.includes(`${viteKey}=`), `.env.example missing ${viteKey}`);
    assert.ok(deployRunbook.includes(viteKey), `docs/DEPLOYMENT_RUNBOOK.md must document ${viteKey}`);
  }

  for (const reqTerm of ['nostok_indexer', 'nostok_ro', 'nostok_notif', 'FORK=false', 'TRUST_PROXY', 'GEO_REQUIRE_HEADER', 'TRUSTED_PROXY_CIDRS', 'DRY_RUN=true', 'DRY_RUN=false']) {
    assert.ok(deployRunbook.includes(reqTerm), `docs/DEPLOYMENT_RUNBOOK.md must document ${reqTerm}`);
  }
}

async function testPurePreflightValidators() {
  // Out-of-band Safe validation checks (WS4.6): reject EOAs, EIP-7702 delegated EOAs, duplicates, deployer reuse
  const eoaCheck = evaluateSafeSnapshot('OWNER_SAFE', ADDRESSES.deployer, {
    code: '0x',
    owners: [],
    threshold: 0n,
  });
  assert.equal(eoaCheck.ok, false);

  const eip7702Check = evaluateSafeSnapshot('GUARDIAN_SAFE', '0x1111111111111111111111111111111111111111', {
    code: '0xef01002222222222222222222222222222222222222222',
    owners: [ADDRESSES.guardianSignerA, ADDRESSES.guardianSignerB],
    threshold: 2n,
  });
  assert.equal(eip7702Check.ok, false);
  assert.match(eip7702Check.detail, /EIP-7702 delegation/i);

  const validSafe = evaluateSafeSnapshot('OWNER_SAFE', '0x3333333333333333333333333333333333333333', {
    code: '0x6080604052',
    owners: [ADDRESSES.safeSignerA, ADDRESSES.safeSignerB],
    threshold: 2n,
    minOwners: 2,
    minThreshold: 2,
    deployer: ADDRESSES.deployer,
    attestationSigner: ADDRESSES.attestationSigner,
  });
  assert.equal(validSafe.ok, true);

  // Global cap initializer trap check: 250,000 USDC default must fail before LoanCore.setGlobalCap() lowers it
  const unloweredCap = validateGlobalSmokeCap(DEFAULT_INITIALIZER_GLOBAL_CAP_RAW, 0n);
  assert.equal(unloweredCap.ok, false);
  assert.match(unloweredCap.detail, /250,000 USDC/);
  assert.equal(validateGlobalSmokeCap(10_000_000_000n, 0n).ok, true);

  // Anti-mock safeguard: production disallowMocks=true must fail on MockB20Token / MockAggregator descriptions
  const mockRejection = validateSmokeAssetConfig(
    {
      symbol: 'NVDAc',
      tokenName: 'MockB20Token',
      tokenAddress: '0x4444444444444444444444444444444444444444',
      tokenDecimals: 8,
      feedDecimalsOnChain: 8,
      feedDescription: 'MockAggregator',
      supported: true,
      config: {
        feed: '0x5555555555555555555555555555555555555555',
        feedDecimals: 8,
        status: 0,
        perLoanCap: 1_000_000_000n,
        assetCap: 5_000_000_000n,
        maxStaleOpenSecs: 21_600,
        maxInitLtvBps: 6000,
        marginCallLtvBps: 7000,
        liqLtvBps: 7800,
        badDebtLtvBps: 9000,
      },
      recordedMultiplier: 1_000_000_000_000_000_000n,
      oraclePrice: 140_00000000n,
      oracleState: 0,
    },
    { disallowMocks: true }
  );
  assert.equal(mockRejection.ok, false);
  assert.ok(mockRejection.errors.some((e) => /mock token/i.test(e)));
  assert.ok(mockRejection.errors.some((e) => /mock price feed/i.test(e)));

  const reduceOnlyRejection = validateSmokeAssetConfig(
    {
      symbol: 'NVDAc',
      tokenName: 'NVIDIA Tokenized',
      tokenAddress: '0x4444444444444444444444444444444444444444',
      tokenDecimals: 8,
      feedDecimalsOnChain: 8,
      feedDescription: 'NVDA / USD',
      supported: true,
      config: {
        feed: '0x5555555555555555555555555555555555555555',
        feedDecimals: 8,
        status: 1, // ReduceOnly
        perLoanCap: 1_000_000_000n,
        assetCap: 5_000_000_000n,
        maxStaleOpenSecs: 21_600,
        maxInitLtvBps: 6000,
        marginCallLtvBps: 7000,
        liqLtvBps: 7800,
        badDebtLtvBps: 9000,
      },
      recordedMultiplier: 1_000_000_000_000_000_000n,
      oraclePrice: 140_00000000n,
      oracleState: 0,
    },
    { disallowMocks: true }
  );
  assert.equal(reduceOnlyRejection.ok, false);
  assert.ok(reduceOnlyRejection.errors.some((e) => /ReduceOnly/.test(e)));

  // Low 1 (510140d) + hardened redaction: strip hostname secrets, IPv6 URLs, JSON-escaped & URL-encoded URLs
  for (const leaked of [
    'HTTP request failed for https://base-mainnet.g.alchemy.com/v2/TOP_SECRET_API_KEY?auth=secret123',
    'RPC error at https://SECRET_HOST_TOKEN.quiknode.pro/path_secret/v1',
    'Connect failed http://[::1]:8545/v2/IPV6_SECRET',
    '{"url":"https:\\/\\/base-mainnet.g.alchemy.com\\/v2\\/JSON_ESC_SECRET"}',
    'proxy=https%3A%2F%2Fbase-mainnet.g.alchemy.com%2Fv2%2FURL_ENC_SECRET',
  ]) {
    const cleanErr = sanitizeRpcErrorMessage({ message: leaked });
    assert.ok(!/SECRET|secret123/.test(cleanErr), `Secret leaked in sanitized output: ${cleanErr}`);
    assert.ok(cleanErr.includes('[REDACTED_URL]'), `URL not redacted in output: ${cleanErr}`);
  }

  const cliSecretRes = spawnSync(
    'node',
    ['scripts/ws4_7_smoke_lib.mjs', '--rpc-url', 'http://127.0.0.1:1/v2/SUPER_SECRET_CI_KEY'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  assert.notEqual(cliSecretRes.status, 0);
  assert.ok(
    !`${cliSecretRes.stdout}\n${cliSecretRes.stderr}`.includes('SUPER_SECRET_CI_KEY'),
    'CLI error output must redact RPC URL API key on RPC failure'
  );

  // Info 1 (510140d) + Low 1 (38616f5): pin Base Mainnet NVDAc/METAc token + feed addresses and fail on wrong/missing decimals
  const spoofedPinRejection = validateSmokeAssetConfig(
    {
      symbol: 'NVDAc',
      tokenName: 'NVIDIA Corporation',
      tokenAddress: '0x4444444444444444444444444444444444444444',
      tokenDecimals: 8,
      feedDecimalsOnChain: 8,
      feedDescription: 'Coinbase NVDA',
      supported: true,
      config: {
        feed: BASE_MAINNET_SMOKE_ASSETS.NVDAc.feed,
        feedDecimals: 8,
        status: 0,
        perLoanCap: 1_000_000_000n,
        assetCap: 5_000_000_000n,
        maxStaleOpenSecs: 21_600,
        maxInitLtvBps: 6000,
        marginCallLtvBps: 7000,
        liqLtvBps: 7800,
        badDebtLtvBps: 9000,
      },
      recordedMultiplier: 1_000537939576369481n,
      oraclePrice: 140_00000000n,
      oracleState: 0,
    },
    { disallowMocks: true }
  );
  assert.equal(spoofedPinRejection.ok, false);
  assert.ok(spoofedPinRejection.errors.some((e) => /does not match pinned Base NVDAc/i.test(e)));

  // Wrong AssetRegistry.feedDecimals (6 instead of pinned 8 = 100x valuation distortion) must fail
  const wrongFeedDecRejection = validateSmokeAssetConfig(
    {
      symbol: 'NVDAc',
      tokenName: 'NVIDIA Corporation',
      tokenAddress: BASE_MAINNET_SMOKE_ASSETS.NVDAc.token,
      tokenDecimals: 8,
      feedDecimalsOnChain: 8,
      feedDescription: 'Coinbase NVDA',
      supported: true,
      config: {
        feed: BASE_MAINNET_SMOKE_ASSETS.NVDAc.feed,
        feedDecimals: 6,
        status: 0,
        perLoanCap: 1_000_000_000n,
        assetCap: 5_000_000_000n,
        maxStaleOpenSecs: 21_600,
        maxInitLtvBps: 6000,
        marginCallLtvBps: 7000,
        liqLtvBps: 7800,
        badDebtLtvBps: 9000,
      },
      recordedMultiplier: 1_000537939576369481n,
      oraclePrice: 140_00000000n,
      oracleState: 0,
    },
    { disallowMocks: true }
  );
  assert.equal(wrongFeedDecRejection.ok, false);
  assert.ok(wrongFeedDecRejection.errors.some((e) => /feedDecimals/i.test(e)));

  // Failed token/feed decimals read (null) must fail instead of skipping
  const failedDecimalsReadRejection = validateSmokeAssetConfig(
    {
      symbol: 'NVDAc',
      tokenName: 'NVIDIA Corporation',
      tokenAddress: BASE_MAINNET_SMOKE_ASSETS.NVDAc.token,
      tokenDecimals: null,
      feedDecimalsOnChain: null,
      feedDescription: 'Coinbase NVDA',
      supported: true,
      config: {
        feed: BASE_MAINNET_SMOKE_ASSETS.NVDAc.feed,
        feedDecimals: 8,
        status: 0,
        perLoanCap: 1_000_000_000n,
        assetCap: 5_000_000_000n,
        maxStaleOpenSecs: 21_600,
        maxInitLtvBps: 6000,
        marginCallLtvBps: 7000,
        liqLtvBps: 7800,
        badDebtLtvBps: 9000,
      },
      recordedMultiplier: 1_000537939576369481n,
      oraclePrice: 140_00000000n,
      oracleState: 0,
    },
    { disallowMocks: false }
  );
  assert.equal(failedDecimalsReadRejection.ok, false);
  assert.ok(failedDecimalsReadRejection.errors.some((e) => /ERC20\.decimals\(\) read failed/i.test(e)));
  assert.ok(failedDecimalsReadRejection.errors.some((e) => /Aggregator\.decimals\(\) read failed/i.test(e)));

  const pinnedAccepted = validateSmokeAssetConfig(
    {
      symbol: 'NVDAc',
      tokenName: 'NVIDIA Corporation',
      tokenAddress: BASE_MAINNET_SMOKE_ASSETS.NVDAc.token,
      tokenDecimals: 8,
      feedDecimalsOnChain: 8,
      feedDescription: 'Coinbase NVDA',
      supported: true,
      config: {
        feed: BASE_MAINNET_SMOKE_ASSETS.NVDAc.feed,
        feedDecimals: 8,
        status: 0,
        perLoanCap: 1_000_000_000n,
        assetCap: 5_000_000_000n,
        maxStaleOpenSecs: 21_600,
        maxInitLtvBps: 6000,
        marginCallLtvBps: 7000,
        liqLtvBps: 7800,
        badDebtLtvBps: 9000,
      },
      recordedMultiplier: 1_000537939576369481n,
      oraclePrice: 140_00000000n,
      oracleState: 0,
    },
    { disallowMocks: true }
  );
  assert.equal(pinnedAccepted.ok, true);

  // Info 2 (510140d): non-loopback RPC refuses --allow-mocks / --allow-1of1-safe without --allow-remote-fork (offline URL check, zero mainnet traffic),
  // verifyForkRpcNode rejects empty {} from anvil_nodeInfo/hardhat_metadata, and CLI rejects a local non-fork HTTP server even with --allow-remote-fork.
  const remoteRelaxRes = spawnSync(
    'node',
    ['scripts/ws4_7_smoke_lib.mjs', '--rpc-url', 'https://remote-node.invalid:8545', '--allow-mocks'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  assert.notEqual(remoteRelaxRes.status, 0);
  assert.match(remoteRelaxRes.stderr, /Refusing --allow-mocks/i);

  const emptyObjProbe = await verifyForkRpcNode({
    async request({ method }: { method: string }) {
      if (method === 'web3_clientVersion') return 'op-geth/v1.101411.0-linux-amd64/go1.22';
      if (method === 'anvil_nodeInfo' || method === 'hardhat_metadata') return {};
      throw new Error(`Unexpected method: ${method}`);
    },
  });
  assert.equal(emptyObjProbe.isFork, false, 'Empty {} from anvil_nodeInfo/hardhat_metadata must NOT pass fork probe');

  const validAnvilProbe = await verifyForkRpcNode({
    async request({ method }: { method: string }) {
      if (method === 'web3_clientVersion') return 'Geth-proxy';
      if (method === 'anvil_nodeInfo') return { currentBlockNumber: '0x1', forkConfig: { forkUrl: 'http://127.0.0.1:8545' } };
      return null;
    },
  });
  assert.equal(validAnvilProbe.isFork, true, 'Real anvil_nodeInfo metadata fields must pass fork probe');

  const fakeNonForkServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      const rpc = JSON.parse(body || '{}') as { id?: unknown; method?: string };
      res.setHeader('Content-Type', 'application/json');
      if (rpc.method === 'web3_clientVersion') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: 'op-geth/v1.101411.0-linux-amd64/go1.22' }));
      } else if (rpc.method === 'anvil_nodeInfo') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }));
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }));
      }
    });
  });
  await new Promise<void>((r) => fakeNonForkServer.listen(0, '127.0.0.1', r));
  try {
    const fakePort = (fakeNonForkServer.address() as net.AddressInfo).port;
    const localNonForkRes = await runCliAsync([
      'scripts/ws4_7_smoke_lib.mjs',
      '--rpc-url',
      `http://127.0.0.1:${fakePort}`,
      '--allow-mocks',
      '--allow-remote-fork',
    ]);
    assert.notEqual(localNonForkRes.status, 0);
    assert.match(localNonForkRes.stderr, /Anvil\/Hardhat\/Foundry fork/i);
  } finally {
    await new Promise<void>((r) => fakeNonForkServer.close(() => r()));
  }

  validateDeploymentAndSmokeRunbooks();

  console.log('PASS Pure WS4.7 preflight validators (EIP-7702, 250k cap trap, decimals/pinning checks, local fork probe, hardened URL redaction, runbooks validated).');
}

async function deployCanonicalSafeProxy(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  owners: Address[],
  threshold: bigint,
  saltNonce: bigint
): Promise<Address> {
  const safeSetupData = encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'setup',
        stateMutability: 'nonpayable',
        inputs: [
          { name: '_owners', type: 'address[]' },
          { name: '_threshold', type: 'uint256' },
          { name: 'to', type: 'address' },
          { name: 'data', type: 'bytes' },
          { name: 'fallbackHandler', type: 'address' },
          { name: 'paymentToken', type: 'address' },
          { name: 'payment', type: 'uint256' },
          { name: 'paymentReceiver', type: 'address' },
        ],
        outputs: [],
      },
    ],
    functionName: 'setup',
    args: [owners, threshold, zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress],
  });

  const factoryAbi = [
    {
      type: 'function',
      name: 'createProxyWithNonce',
      stateMutability: 'nonpayable',
      inputs: [
        { name: '_singleton', type: 'address' },
        { name: 'initializer', type: 'bytes' },
        { name: 'saltNonce', type: 'uint256' },
      ],
      outputs: [{ name: 'proxy', type: 'address' }],
    },
    {
      type: 'event',
      name: 'ProxyCreation',
      inputs: [
        { name: 'proxy', type: 'address', indexed: false },
        { name: 'singleton', type: 'address', indexed: false },
      ],
    },
  ] as const;

  const { result: predictedProxy } = await publicClient.simulateContract({
    account: walletClient.account!,
    address: BASE_SAFE_PROXY_FACTORY_V1_3,
    abi: factoryAbi,
    functionName: 'createProxyWithNonce',
    args: [BASE_GNOSIS_SAFE_L2_V1_3, safeSetupData, saltNonce],
  });

  await publicClient.waitForTransactionReceipt({
    hash: await walletClient.writeContract({
      address: BASE_SAFE_PROXY_FACTORY_V1_3,
      abi: factoryAbi,
      functionName: 'createProxyWithNonce',
      args: [BASE_GNOSIS_SAFE_L2_V1_3, safeSetupData, saltNonce],
    }),
  });
  return getAddress(predictedProxy);
}

async function signAttestation(
  gateAddress: Address,
  account: Address,
  nonce: bigint,
  expiry: bigint
): Promise<Hex> {
  const attAccount = privateKeyToAccount(KEYS.attestationSigner);
  const digest = keccak256(
    new Uint8Array(
      Buffer.from(
        encodeFunctionData({
          abi: parseAbi([
            'function pack(uint256,address,address,uint256,uint256)',
          ]),
          functionName: 'pack',
          args: [BigInt(BASE_CHAIN_ID), gateAddress, account, nonce, expiry],
        }).slice(10),
        'hex'
      )
    )
  );
  // Read canonical EIP-191 digest straight from EligibilityGate to guarantee zero encoding drift
  void digest;
  throw new Error('Use on-chain getAttestationDigest');
}
void signAttestation;

async function mintAttestationViaContract(
  publicClient: ReturnType<typeof createPublicClient>,
  gateAddress: Address,
  user: Address,
  expiry: bigint
): Promise<Hex> {
  const attAccount = privateKeyToAccount(KEYS.attestationSigner);
  const nonce = BigInt(
    await publicClient.readContract({
      address: gateAddress,
      abi: eligibilityGateAbi,
      functionName: 'userNonce',
      args: [user],
    })
  );
  const digest = (await publicClient.readContract({
    address: gateAddress,
    abi: eligibilityGateAbi,
    functionName: 'getAttestationDigest',
    args: [user, nonce, expiry],
  })) as Hex;
  const sig = await attAccount.signMessage({ message: { raw: digest } });
  // Encode abi.encode(uint256 expiry, bytes signature)
  const { encodeAbiParameters } = await import('viem');
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bytes' }],
    [expiry, sig]
  );
}

async function runTests(): Promise<void> {
  await testPurePreflightValidators();

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
    const borrowerClient = createWalletClient({
      account: privateKeyToAccount(KEYS.borrower),
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
    const keeperClient = createWalletClient({
      account: privateKeyToAccount(KEYS.keeper),
      chain: forkChain,
      transport: viemHttp(LOCAL_RPC_URL),
    });
    const rawWalletClient = createWalletClient({ chain: forkChain, transport: viemHttp(LOCAL_RPC_URL) });

    for (const addr of Object.values(ADDRESSES)) {
      await rpcCall('anvil_setBalance', [addr, '0x56bc75e2d63100000']);
    }

    // Verify canonical SafeProxyFactory v1.3.0 exists on Base fork and deploy real 2-of-2 Safe multisig proxies
    const safeFactoryCode = await publicClient.getCode({ address: BASE_SAFE_PROXY_FACTORY_V1_3 });
    assert.ok(safeFactoryCode && safeFactoryCode !== '0x', 'Canonical Base SafeProxyFactory v1.3.0 must exist on Base fork');
    const ownerSafe = await deployCanonicalSafeProxy(
      publicClient,
      deployerClient,
      [ADDRESSES.safeSignerA, ADDRESSES.safeSignerB],
      2n,
      47001n
    );
    const guardianSafe = await deployCanonicalSafeProxy(
      publicClient,
      deployerClient,
      [ADDRESSES.guardianSignerA, ADDRESSES.guardianSignerB],
      2n,
      47002n
    );
    console.log(`[WS4.7_SMOKE] Deployed canonical GnosisSafeL2 2/2 proxies: ownerSafe=${ownerSafe}, guardianSafe=${guardianSafe}`);

    await rpcCall('anvil_setBalance', [ownerSafe, '0x56bc75e2d63100000']);
    await rpcCall('anvil_setBalance', [guardianSafe, '0x56bc75e2d63100000']);

    const deployed = deployProtocolWithForge(ownerSafe, guardianSafe);

    // Deploy B20-shaped NVDAc (18 dec) & METAc (18 dec) collateral + Chainlink feeds on fork
    const mockB20Artifact = loadFoundryArtifact('MockB20Token.sol/MockB20Token.json');
    const mockAggArtifact = loadFoundryArtifact('MockAggregator.sol/MockAggregator.json');
    const initialMult = 1_000537939576369481n;

    const deployContract = async (abi: readonly unknown[], bytecode: Hex, args: unknown[]) => {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.deployContract({ abi, bytecode, args }),
      });
      return getAddress(receipt.contractAddress!);
    };

    const nvdac = await deployContract(mockB20Artifact.abi, mockB20Artifact.bytecode, [
      'NVIDIA Tokenized',
      'NVDAc',
      18,
      initialMult,
    ]);
    const metac = await deployContract(mockB20Artifact.abi, mockB20Artifact.bytecode, [
      'Meta Platforms Tokenized',
      'METAc',
      18,
      initialMult,
    ]);
    const nvdaFeed = await deployContract(mockAggArtifact.abi, mockAggArtifact.bytecode, [8, 140_00000000n]);
    const metaFeed = await deployContract(mockAggArtifact.abi, mockAggArtifact.bytecode, [8, 500_00000000n]);

    // Before governance batch: verify preflight catches unlowered 250,000 USDC globalCap + missing assets + empty allowlist
    const preGovReport = await runGuardedSmokePreflight({
      publicClient,
      contracts: {
        loanCore: deployed.loanCore,
        orderSettlement: deployed.orderSettlement,
        liquidationAuction: deployed.liquidationAuction,
        positionNft: deployed.positionNFT,
        collateralEscrow: deployed.collateralEscrow,
        assetRegistry: deployed.assetRegistry,
        oracleRouter: deployed.oracleRouter,
        eligibilityGate: deployed.eligibilityGate,
        feeCollector: deployed.feeCollector,
        nostokTimelock: deployed.nostokTimelock,
      },
      ownerSafe,
      guardianSafe,
      deployer: ADDRESSES.deployer,
      assets: [
        { symbol: 'NVDAc', address: nvdac },
        { symbol: 'METAc', address: metac },
      ],
      allowlistWallets: [ADDRESSES.borrower, ADDRESSES.lender, ADDRESSES.liquidator],
      minSafeOwners: 2,
      minSafeThreshold: 2,
      disallowMocks: false,
    });
    assert.equal(preGovReport.ok, false);
    assert.ok(preGovReport.failures.some((f) => f.id === 'loancore.global_cap'));
    assert.ok(preGovReport.failures.some((f) => f.id === 'eligibility.allowlist'));
    assert.ok(preGovReport.failures.some((f) => f.id === 'asset.NVDAc'));
    console.log('PASS Pre-governance preflight caught unlowered 250k globalCap, unallowlisted wallets, and unlisted assets.');

    // Schedule and execute real 48-hour NostokTimelock batch from Owner Safe
    const setAssetConfigAbi = [
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

    const smokeAssetConfig = (feed: Address) => ({
      feed,
      feedDecimals: 8,
      tier: 0, // Tier A
      maxInitLtvBps: 6000,
      marginCallLtvBps: 7000,
      liqLtvBps: 7800,
      badDebtLtvBps: 9000,
      maxDiscountBps: 600,
      closedMarketHaircutBps: 500,
      perLoanCap: 1_000_000_000n, // $1,000 guarded micro-cap
      assetCap: 5_000_000_000n, // $5,000 guarded asset cap
      maxStaleOpenSecs: RECOMMENDED_MAX_STALE_OPEN_SECS, // 21,600s (6h)
      status: 0, // Active
      restricted: false,
    });

    const targets: Address[] = [
      deployed.loanCore,
      deployed.oracleRouter,
      deployed.assetRegistry,
      deployed.assetRegistry,
    ];
    const values: bigint[] = [0n, 0n, 0n, 0n];
    const payloads: Hex[] = [
      encodeFunctionData({
        abi: parseAbi(['function setGlobalCap(uint128 newCap)']),
        functionName: 'setGlobalCap',
        args: [10_000_000_000n], // $10,000 guarded smoke global cap
      }),
      encodeFunctionData({
        abi: parseAbi(['function setMarketSession(bool isOpen, bool isManual)']),
        functionName: 'setMarketSession',
        args: [true, true],
      }),
      encodeFunctionData({
        abi: setAssetConfigAbi,
        functionName: 'setAssetConfig',
        args: [nvdac, smokeAssetConfig(nvdaFeed)],
      }),
      encodeFunctionData({
        abi: setAssetConfigAbi,
        functionName: 'setAssetConfig',
        args: [metac, smokeAssetConfig(metaFeed)],
      }),
    ];
    const batchSalt = keccak256(stringToBytes('WS4_7_GUARDED_LAUNCH_CAPS'));
    const timelockAbi = parseAbi([
      'function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)',
      'function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)',
    ]);

    await rpcCall('anvil_impersonateAccount', [ownerSafe]);
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: ownerSafe,
        to: deployed.nostokTimelock,
        data: encodeFunctionData({
          abi: timelockAbi,
          functionName: 'scheduleBatch',
          args: [targets, values, payloads, zeroHash, batchSalt, TIMELOCK_MIN_DELAY_SECS],
        }),
      }),
    });

    await rpcCall('evm_increaseTime', [Number(TIMELOCK_MIN_DELAY_SECS) + 5]);
    await rpcCall('evm_mine', []);

    // Refresh oracle feed updatedAt timestamps after 48h timelock wait
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: nvdaFeed,
        data: encodeFunctionData({ abi: parseAbi(['function setPrice(int256 price)']), functionName: 'setPrice', args: [140_00000000n] }),
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: metaFeed,
        data: encodeFunctionData({ abi: parseAbi(['function setPrice(int256 price)']), functionName: 'setPrice', args: [500_00000000n] }),
      }),
    });

    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: ownerSafe,
        to: deployed.nostokTimelock,
        data: encodeFunctionData({
          abi: timelockAbi,
          functionName: 'executeBatch',
          args: [targets, values, payloads, zeroHash, batchSalt],
        }),
      }),
    });

    // Sync baseline B20 multipliers on OracleRouter & allowlist internal wallets via Owner Safe on EligibilityGate
    for (const tok of [nvdac, metac]) {
      await publicClient.waitForTransactionReceipt({
        hash: await keeperClient.sendTransaction({
          to: deployed.oracleRouter,
          data: encodeFunctionData({
            abi: parseAbi(['function syncMultiplier(address token)']),
            functionName: 'syncMultiplier',
            args: [tok],
          }),
        }),
      });
    }
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: ownerSafe,
        to: deployed.eligibilityGate,
        data: encodeFunctionData({
          abi: parseAbi(['function setAllowlistBatch(address[] accounts, bool isAllowed)']),
          functionName: 'setAllowlistBatch',
          args: [[ADDRESSES.borrower, ADDRESSES.lender, ADDRESSES.liquidator], true],
        }),
      }),
    });

    // Verify Guardian emergency pause drill works BEFORE running live trades
    await rpcCall('anvil_impersonateAccount', [guardianSafe]);
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: guardianSafe,
        to: deployed.loanCore,
        data: encodeFunctionData({ abi: parseAbi(['function setPaused(bool isPaused)']), functionName: 'setPaused', args: [true] }),
      }),
    });
    const pausedPreflight = await runGuardedSmokePreflight({
      publicClient,
      contracts: {
        loanCore: deployed.loanCore,
        orderSettlement: deployed.orderSettlement,
        liquidationAuction: deployed.liquidationAuction,
        positionNft: deployed.positionNFT,
        collateralEscrow: deployed.collateralEscrow,
        assetRegistry: deployed.assetRegistry,
        oracleRouter: deployed.oracleRouter,
        eligibilityGate: deployed.eligibilityGate,
        feeCollector: deployed.feeCollector,
        nostokTimelock: deployed.nostokTimelock,
      },
      ownerSafe,
      guardianSafe,
      deployer: ADDRESSES.deployer,
      assets: [
        { symbol: 'NVDAc', address: nvdac },
        { symbol: 'METAc', address: metac },
      ],
      allowlistWallets: [ADDRESSES.borrower, ADDRESSES.lender, ADDRESSES.liquidator],
      minSafeOwners: 2,
      minSafeThreshold: 2,
      disallowMocks: false,
    });
    assert.equal(pausedPreflight.ok, false);
    assert.ok(pausedPreflight.failures.some((f) => f.id === 'loancore.unpaused'));

    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: guardianSafe,
        to: deployed.loanCore,
        data: encodeFunctionData({ abi: parseAbi(['function setPaused(bool isPaused)']), functionName: 'setPaused', args: [false] }),
      }),
    });

    // Run complete preflight with fork test allowlist & 2-of-2 Safes
    const readyPreflight = await runGuardedSmokePreflight({
      publicClient,
      contracts: {
        loanCore: deployed.loanCore,
        orderSettlement: deployed.orderSettlement,
        liquidationAuction: deployed.liquidationAuction,
        positionNft: deployed.positionNFT,
        collateralEscrow: deployed.collateralEscrow,
        assetRegistry: deployed.assetRegistry,
        oracleRouter: deployed.oracleRouter,
        eligibilityGate: deployed.eligibilityGate,
        feeCollector: deployed.feeCollector,
        nostokTimelock: deployed.nostokTimelock,
      },
      ownerSafe,
      guardianSafe,
      deployer: ADDRESSES.deployer,
      assets: [
        { symbol: 'NVDAc', address: nvdac },
        { symbol: 'METAc', address: metac },
      ],
      allowlistWallets: [ADDRESSES.borrower, ADDRESSES.lender, ADDRESSES.liquidator],
      minSafeOwners: 2,
      minSafeThreshold: 2,
      disallowMocks: false,
    });
    assert.equal(readyPreflight.ok, true, `Preflight failed unexpectedly: ${JSON.stringify(readyPreflight.failures)}`);
    console.log(`PASS ${readyPreflight.summary}`);

    // Explicitly verify anti-mock check rejects MockAggregator on production flags (--production without --allow-mocks)
    const prodMockPreflight = await runGuardedSmokePreflight({
      publicClient,
      contracts: {
        loanCore: deployed.loanCore,
        orderSettlement: deployed.orderSettlement,
        liquidationAuction: deployed.liquidationAuction,
        positionNft: deployed.positionNFT,
        collateralEscrow: deployed.collateralEscrow,
        assetRegistry: deployed.assetRegistry,
        oracleRouter: deployed.oracleRouter,
        eligibilityGate: deployed.eligibilityGate,
        feeCollector: deployed.feeCollector,
        nostokTimelock: deployed.nostokTimelock,
      },
      ownerSafe,
      guardianSafe,
      deployer: ADDRESSES.deployer,
      assets: [{ symbol: 'NVDAc', address: nvdac }],
      minSafeOwners: 2,
      minSafeThreshold: 2,
      disallowMocks: true,
    });
    assert.equal(prodMockPreflight.ok, false);
    assert.ok(prodMockPreflight.failures.some((f) => f.id === 'asset.NVDAc' && /mock/i.test(f.detail)));
    assert.ok(
      prodMockPreflight.failures.some((f) => f.id === 'assets.pinned_set' && /METAc/i.test(f.detail)),
      'Production WS4.7 preflight must require both pinned NVDAc and METAc'
    );

    // Fund borrower (NVDAc & METAc + USDC for interest/repay) and lender/liquidator (USDC)
    await rpcCall('anvil_impersonateAccount', [BASE_USDC_WHALE]);
    await rpcCall('anvil_setBalance', [BASE_USDC_WHALE, '0x56bc75e2d63100000']);
    const transferUsdc = async (to: Address, rawAmount: bigint) => {
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: BASE_USDC_WHALE,
          to: BASE_USDC_ADDRESS,
          data: encodeFunctionData({
            abi: parseAbi(['function transfer(address to, uint256 value) returns (bool)']),
            functionName: 'transfer',
            args: [to, rawAmount],
          }),
        }),
      });
    };
    await transferUsdc(ADDRESSES.borrower, 5_000_000_000n);
    await transferUsdc(ADDRESSES.lender, 5_000_000_000n);
    await transferUsdc(ADDRESSES.liquidator, 5_000_000_000n);

    const mintCollateral = async (token: Address, to: Address, amount: bigint) => {
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.sendTransaction({
          to: token,
          data: encodeFunctionData({ abi: parseAbi(['function mint(address to, uint256 amount)']), functionName: 'mint', args: [to, amount] }),
        }),
      });
    };
    await mintCollateral(nvdac, ADDRESSES.borrower, 30n * 10n ** 18n);
    await mintCollateral(metac, ADDRESSES.borrower, 10n * 10n ** 18n);

    // Wire frontend config helpers to Anvil fork deployment for WS4.7 execution helpers
    const cfg = {
      chainId: BASE_CHAIN_ID,
      rpcUrl: LOCAL_RPC_URL,
      apiUrl: '',
      usdcAddress: BASE_USDC_ADDRESS,
      contracts: {
        loanCore: deployed.loanCore,
        orderSettlement: deployed.orderSettlement,
        liquidationAuction: deployed.liquidationAuction,
        positionNft: deployed.positionNFT,
        collateralEscrow: deployed.collateralEscrow,
        assetRegistry: deployed.assetRegistry,
        oracleRouter: deployed.oracleRouter,
        eligibilityGate: deployed.eligibilityGate,
        feeCollector: deployed.feeCollector,
      },
    };
    setFrontendConfigOverrides(cfg);

    const walletProvider = createMockEip1193Provider(KEYS.borrower);
    const nowBlock = await publicClient.getBlock({ blockTag: 'latest' });
    const attExpiry = BigInt(nowBlock.timestamp) + 86_400n;
    const borrowerAtt = await mintAttestationViaContract(publicClient, deployed.eligibilityGate, ADDRESSES.borrower, attExpiry);
    const lenderAtt = await mintAttestationViaContract(publicClient, deployed.eligibilityGate, ADDRESSES.lender, attExpiry);
    const orderExpiry = BigInt(nowBlock.timestamp) + 7_200n;
    const settlementDomain = {
      name: ORDER_SETTLEMENT_DOMAIN_NAME,
      version: ORDER_SETTLEMENT_DOMAIN_VERSION,
      chainId: BASE_CHAIN_ID,
      verifyingContract: deployed.orderSettlement,
    };

    // =========================================================================
    // WS4.7 Step 1: Originate guarded loans on NVDAc ($600) and METAc ($750)
    // =========================================================================
    const nvdacLoanCollateralRaw = 10n * 10n ** 18n; // 10 NVDAc @ $140 = $1,400 (~42.8% LTV <= 60%)
    const nvdacTopUpRaw = 1n * 10n ** 18n;
    const nvdacPrincipalRaw = 600_000_000n; // $600 USDC

    walletProvider.setAccount(KEYS.borrower);
    await setCollateralAllowanceForBorrow({
      address: ADDRESSES.borrower,
      collateralToken: nvdac,
      targetAllowanceRaw: nvdacLoanCollateralRaw + nvdacTopUpRaw,
      provider: walletProvider,
      cfg,
    });
    const borrowOrder1 = {
      borrower: ADDRESSES.borrower,
      collateralToken: nvdac,
      collateralAmount: nvdacLoanCollateralRaw,
      minUsdc: nvdacPrincipalRaw,
      maxRateBps: 900,
      termDays: 7,
      maxLtvBps: 6000,
      minFill: 500_000_000n,
      expiry: orderExpiry,
      nonce: 0n,
      yieldMode: 0,
      allowInKindSettlement: false,
    };
    const borrowSig1 = await privateKeyToAccount(KEYS.borrower).signTypedData({
      domain: settlementDomain,
      types: BORROW_ORDER_EIP712_TYPES,
      primaryType: 'BorrowOrder',
      message: borrowOrder1,
    });

    walletProvider.setAccount(KEYS.lender);
    await approveUsdcForLend({
      address: ADDRESSES.lender,
      requiredUsdcRaw: nvdacPrincipalRaw,
      provider: walletProvider,
      cfg,
    });
    const treasuryBefore1 = BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.treasury] }));
    const reserveBefore1 = BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.reserve] }));

    await publicClient.waitForTransactionReceipt({
      hash: await lenderClient.writeContract({
        address: deployed.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'fillBorrowOrderWithAttestations',
        args: [borrowOrder1, borrowSig1, nvdacPrincipalRaw, borrowerAtt, lenderAtt],
      }),
    });
    assert.equal(
      await publicClient.readContract({ address: deployed.loanCore, abi: loanCoreAbi, functionName: 'nextLoanId' }),
      2n
    );

    // Verify CollateralEscrow custody, PositionNFT ownership & fee split
    assert.equal(
      await publicClient.readContract({ address: nvdac, abi: erc20Abi, functionName: 'balanceOf', args: [deployed.collateralEscrow] }),
      nvdacLoanCollateralRaw
    );
    assert.equal(
      getAddress((await publicClient.readContract({ address: deployed.positionNFT, abi: positionNftAbi, functionName: 'ownerOf', args: [1n] })) as Address),
      getAddress(ADDRESSES.lender)
    );
    const origFee1 = (nvdacPrincipalRaw * 10n) / 10_000n; // 0.10% = 0.60 USDC
    const origReserve1 = (origFee1 * 2000n) / 10_000n; // 20% safety reserve
    const origTreasury1 = origFee1 - origReserve1;
    assert.equal(
      BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.treasury] })) - treasuryBefore1,
      origTreasury1
    );
    assert.equal(
      BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.reserve] })) - reserveBefore1,
      origReserve1
    );

    // Originate Loan #2 on METAc ($750 USDC vs 4 METAc @ $500 = $2,000 -> 37.5% LTV) via LendOffer
    const metacCollateralRaw = 4n * 10n ** 18n;
    const metacPrincipalRaw = 750_000_000n;
    walletProvider.setAccount(KEYS.lender);
    await approveUsdcForLend({
      address: ADDRESSES.lender,
      requiredUsdcRaw: metacPrincipalRaw,
      provider: walletProvider,
      cfg,
    });
    const lendOffer2 = {
      lender: ADDRESSES.lender,
      usdcAmount: metacPrincipalRaw,
      minRateBps: 800,
      termDays: 7,
      allowedCollateral: metac,
      maxLtvBps: 6000,
      minFill: 500_000_000n,
      expiry: orderExpiry,
      nonce: 0n,
      yieldMode: 0,
    };
    const lendSig2 = await privateKeyToAccount(KEYS.lender).signTypedData({
      domain: settlementDomain,
      types: LEND_OFFER_EIP712_TYPES,
      primaryType: 'LendOffer',
      message: lendOffer2,
    });
    walletProvider.setAccount(KEYS.borrower);
    await setCollateralAllowanceForBorrow({
      address: ADDRESSES.borrower,
      collateralToken: metac,
      targetAllowanceRaw: metacCollateralRaw,
      provider: walletProvider,
      cfg,
    });
    await publicClient.waitForTransactionReceipt({
      hash: await borrowerClient.writeContract({
        address: deployed.orderSettlement,
        abi: orderSettlementAbi,
        functionName: 'fillLendOfferWithAttestations',
        args: [lendOffer2, lendSig2, metac, metacCollateralRaw, metacPrincipalRaw, borrowerAtt, lenderAtt],
      }),
    });
    assert.equal(
      await publicClient.readContract({ address: deployed.loanCore, abi: loanCoreAbi, functionName: 'nextLoanId' }),
      3n
    );
    assert.equal(
      await publicClient.readContract({ address: metac, abi: erc20Abi, functionName: 'balanceOf', args: [deployed.collateralEscrow] }),
      metacCollateralRaw
    );
    assert.equal(
      await publicClient.readContract({ address: deployed.loanCore, abi: loanCoreAbi, functionName: 'totalOutstandingPrincipal' }),
      nvdacPrincipalRaw + metacPrincipalRaw
    );
    console.log('PASS WS4.7 Step 1: NVDAc (#1, $600) and METAc (#2, $750) originated with verified CollateralEscrow custody & PositionNFT minting.');

    // =========================================================================
    // WS4.7 Step 2: topUp -> partialRepay -> extend -> full repay -> claim on Loan #1
    // =========================================================================
    walletProvider.setAccount(KEYS.borrower);
    await executeLoanTopUp({
      address: ADDRESSES.borrower,
      loanId: 1n,
      additionalCollateralRaw: nvdacTopUpRaw,
      existingOpenCollateralRaw: 0n,
      autoApprove: true,
      provider: walletProvider,
      cfg,
    });
    assert.equal(
      await publicClient.readContract({ address: nvdac, abi: erc20Abi, functionName: 'balanceOf', args: [deployed.collateralEscrow] }),
      nvdacLoanCollateralRaw + nvdacTopUpRaw
    );

    // Advance 2 days and keep Chainlink prices updated inside 21,600s heartbeat
    await rpcCall('evm_increaseTime', [2 * 86_400]);
    await rpcCall('evm_mine', []);
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: nvdaFeed,
        data: encodeFunctionData({ abi: parseAbi(['function setPrice(int256 price)']), functionName: 'setPrice', args: [140_00000000n] }),
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: metaFeed,
        data: encodeFunctionData({ abi: parseAbi(['function setPrice(int256 price)']), functionName: 'setPrice', args: [500_00000000n] }),
      }),
    });

    const borrowerNvdaBeforePartial = BigInt(
      await publicClient.readContract({ address: nvdac, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.borrower] })
    );
    const treasuryBeforePartial = BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.treasury] }));
    const reserveBeforePartial = BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.reserve] }));
    const partialRes = await executeLoanRepay({
      address: ADDRESSES.borrower,
      loanId: 1n,
      principalRepayRaw: 200_000_000n,
      existingOpenSumRaw: 0n,
      autoApprove: true,
      provider: walletProvider,
      cfg,
    });
    const partialNvdaReleased =
      BigInt(await publicClient.readContract({ address: nvdac, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.borrower] })) -
      borrowerNvdaBeforePartial;
    assert.ok(partialNvdaReleased > 0n, 'partialRepay must release pro-rata collateral to borrower');
    assert.equal(partialNvdaReleased, BigInt(partialRes.collateralReleasedRaw));
    const loan1PostPartial = (await publicClient.readContract({
      address: deployed.loanCore,
      abi: loanCoreAbi,
      functionName: 'getLoan',
      args: [1n],
    })) as { principal: bigint; principalRepaid: bigint; maturity: bigint };
    assert.equal(BigInt(loan1PostPartial.principal) - BigInt(loan1PostPartial.principalRepaid), 400_000_000n);
    const partialInterestFeeDelta =
      BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.treasury] })) -
      treasuryBeforePartial +
      (BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.reserve] })) -
        reserveBeforePartial);
    const claimableAfterPartial = BigInt(
      await publicClient.readContract({ address: deployed.loanCore, abi: loanCoreAbi, functionName: 'getClaimable', args: [ADDRESSES.lender] })
    );
    assert.equal(
      claimableAfterPartial + partialInterestFeeDelta,
      BigInt(partialRes.totalPaidRaw),
      'Partial repay USDC must conserve exact 100% split between lender claimable and FeeCollector'
    );

    // Extend Loan #1 maturity by +7 days at 850 bps
    const postPartialBlock = await publicClient.getBlock({ blockTag: 'latest' });
    const newMaturity = BigInt(loan1PostPartial.maturity) + 7n * 86_400n;
    const extDeadline = BigInt(postPartialBlock.timestamp) + 3_600n;
    walletProvider.setAccount(KEYS.lender);
    const signedExt = await signLoanExtension({
      address: ADDRESSES.lender,
      loanId: 1n,
      newMaturity,
      newRateBps: 850,
      deadline: extDeadline,
      provider: walletProvider,
      cfg,
    });
    walletProvider.setAccount(KEYS.borrower);
    await executeLoanExtend({
      address: ADDRESSES.borrower,
      loanId: 1n,
      newMaturity: signedExt.extendOrder.newMaturity,
      newRateBps: signedExt.extendOrder.newRateBps,
      deadline: signedExt.extendOrder.deadline,
      signature: signedExt.signature,
      provider: walletProvider,
      cfg,
    });
    const loan1AfterExt = (await publicClient.readContract({ address: deployed.loanCore, abi: loanCoreAbi, functionName: 'getLoan', args: [1n] })) as {
      maturity: bigint;
      rateBps: number;
    };
    assert.equal(BigInt(loan1AfterExt.maturity), newMaturity);
    assert.equal(Number(loan1AfterExt.rateBps), 850);

    // Advance 1 day (3 days elapsed from origination) -> full repay Loan #1
    await rpcCall('evm_increaseTime', [86_400]);
    await rpcCall('evm_mine', []);
    const borrowerNvdaBeforeRepay = BigInt(
      await publicClient.readContract({ address: nvdac, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.borrower] })
    );
    const fullRepayRes = await executeLoanRepay({
      address: ADDRESSES.borrower,
      loanId: 1n,
      existingOpenSumRaw: 0n,
      autoApprove: true,
      provider: walletProvider,
      cfg,
    });
    assert.ok(BigInt(fullRepayRes.totalPaidRaw) >= 400_000_000n);
    assert.equal(
      await publicClient.readContract({ address: nvdac, abi: erc20Abi, functionName: 'balanceOf', args: [deployed.collateralEscrow] }),
      0n,
      'CollateralEscrow must release 100% NVDAc on full repay'
    );
    assert.equal(
      partialNvdaReleased +
        (BigInt(await publicClient.readContract({ address: nvdac, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.borrower] })) -
          borrowerNvdaBeforeRepay),
      nvdacLoanCollateralRaw + nvdacTopUpRaw
    );
    await assert.rejects(
      () => publicClient.readContract({ address: deployed.positionNFT, abi: positionNftAbi, functionName: 'ownerOf', args: [1n] }),
      /ERC721NonexistentToken/i
    );

    // Lender claims Loan #1 proceeds on LoanCore.claim()
    walletProvider.setAccount(KEYS.lender);
    const lenderUsdcBeforeClaim1 = BigInt(
      await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.lender] })
    );
    const claimRes1 = await executeLoanClaim({
      address: ADDRESSES.lender,
      recipient: ADDRESSES.lender,
      provider: walletProvider,
      cfg,
    });
    assert.equal(claimRes1.remainingClaimableRaw, '0');
    assert.equal(
      BigInt(claimRes1.recipientUsdcBalanceRaw),
      lenderUsdcBeforeClaim1 + BigInt(claimRes1.claimedAmountRaw)
    );
    console.log('PASS WS4.7 Step 2: topUp -> partialRepay -> extend -> repay -> claim conserved USDC and released 100% NVDAc.');

    // =========================================================================
    // WS4.7 Step 3: Controlled Liquidation Auction on Loan #2 METAc
    // =========================================================================
    // Loan #2 has 4 METAc collateral, $750 principal (+ ~3d interest ~= $0.50).
    // Move METAc feed to $207 -> 4 * $207 = $828 gross value => LTV ~= 90.6% (>= 90% badDebtLtvBps),
    // auctioning 100% (4 METAc) starting at $207 while collateral value ($828) still exceeds debt + 1% liq fee.
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: metaFeed,
        data: encodeFunctionData({ abi: parseAbi(['function setPrice(int256 price)']), functionName: 'setPrice', args: [207_00000000n] }),
      }),
    });

    const keeperUsdcBefore = BigInt(
      await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.keeper] })
    );
    const treasuryBeforeLiq = BigInt(
      await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.treasury] })
    );
    const reserveBeforeLiq = BigInt(
      await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.reserve] })
    );
    const borrowerUsdcBeforeLiq = BigInt(
      await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.borrower] })
    );
    const borrowerMetacBeforeLiq = BigInt(
      await publicClient.readContract({ address: metac, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.borrower] })
    );
    const liquidatorUsdcBeforeLiq = BigInt(
      await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.liquidator] })
    );

    await publicClient.waitForTransactionReceipt({
      hash: await keeperClient.sendTransaction({
        to: deployed.loanCore,
        data: encodeFunctionData({
          abi: parseAbi(['function startLiquidation(uint256 loanId) returns (uint256)']),
          functionName: 'startLiquidation',
          args: [2n],
        }),
      }),
    });

    const auctionId2 = (await publicClient.readContract({
      address: deployed.loanCore,
      abi: loanCoreAbi,
      functionName: 'loanActiveAuction',
      args: [2n],
    })) as bigint;
    assert.equal(auctionId2, 1n);
    assert.equal(
      await publicClient.readContract({ address: deployed.positionNFT, abi: positionNftAbi, functionName: 'isAuctionLocked', args: [2n] }),
      true
    );

    // Liquidator purchases 3.7 METAc (worth ~$765.90 at ~$207, net after 1% fee ~$758.24 > ~$750.50 debt),
    // leaving 0.3 METAc leftover collateral + borrower USDC surplus all returned cleanly to borrower!
    const buyCollateralAmount = (37n * 10n ** 18n) / 10n; // 3.7 METAc
    const maxPaymentUsdc = 800_000_000n;
    await publicClient.waitForTransactionReceipt({
      hash: await liquidatorClient.sendTransaction({
        to: BASE_USDC_ADDRESS,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [deployed.liquidationAuction, maxPaymentUsdc] }),
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await liquidatorClient.sendTransaction({
        to: deployed.liquidationAuction,
        data: encodeFunctionData({
          abi: parseAbi(['function buy(uint256 auctionId, uint128 collateralAmount, uint128 maxUsdcPayment) returns (uint128)']),
          functionName: 'buy',
          args: [auctionId2, buyCollateralAmount, maxPaymentUsdc],
        }),
      }),
    });

    // Verify liquidation settlement, borrower leftover collateral + USDC surplus, keeper reward & fee distribution
    const borrowerMetacLeftover =
      BigInt(await publicClient.readContract({ address: metac, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.borrower] })) -
      borrowerMetacBeforeLiq;
    const liquidatorMetacBought = BigInt(
      await publicClient.readContract({ address: metac, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.liquidator] })
    );
    assert.equal(liquidatorMetacBought, buyCollateralAmount);
    assert.equal(borrowerMetacLeftover, metacCollateralRaw - buyCollateralAmount, 'Leftover METAc must return to borrower');
    assert.equal(
      await publicClient.readContract({ address: metac, abi: erc20Abi, functionName: 'balanceOf', args: [deployed.collateralEscrow] }),
      0n
    );

    const borrowerUsdcSurplus =
      BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.borrower] })) -
      borrowerUsdcBeforeLiq;
    const keeperReward =
      BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.keeper] })) -
      keeperUsdcBefore;
    const protocolLiqAndIntFee =
      BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.treasury] })) -
      treasuryBeforeLiq +
      (BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.reserve] })) -
        reserveBeforeLiq);
    assert.ok(borrowerUsdcSurplus > 0n, 'Controlled over-debt auction buy must refund USDC surplus to borrower');
    assert.ok(keeperReward > 0n, 'Keeper must receive liquidation reward');
    assert.ok(protocolLiqAndIntFee > 0n, 'Treasury/SafetyReserve must receive liquidation & interest fees');

    const liquidatorSpent =
      liquidatorUsdcBeforeLiq -
      BigInt(await publicClient.readContract({ address: BASE_USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESSES.liquidator] }));

    // Lender claims liquidation settlement proceeds from LoanCore
    walletProvider.setAccount(KEYS.lender);
    const claimRes2 = await executeLoanClaim({
      address: ADDRESSES.lender,
      recipient: ADDRESSES.lender,
      provider: walletProvider,
      cfg,
    });
    assert.equal(claimRes2.remainingClaimableRaw, '0');
    assert.equal(
      BigInt(claimRes2.claimedAmountRaw) + borrowerUsdcSurplus + keeperReward + protocolLiqAndIntFee,
      liquidatorSpent,
      'Exact 100% USDC waterfall conservation: lenderClaimed + borrowerSurplus + keeperReward + protocolFees == liquidatorUsdcSpent'
    );

    // Final system invariants after smoke execution
    assert.equal(
      await publicClient.readContract({ address: deployed.loanCore, abi: loanCoreAbi, functionName: 'totalOutstandingPrincipal' }),
      0n
    );
    await assert.rejects(
      () => publicClient.readContract({ address: deployed.positionNFT, abi: positionNftAbi, functionName: 'ownerOf', args: [2n] }),
      /ERC721NonexistentToken/i
    );
    const postSmokePositions = await fetchWalletPositionsAndClaimable({ address: ADDRESSES.lender, cfg });
    assert.equal(postSmokePositions.nftBalanceCount, 0);
    assert.equal(postSmokePositions.claimableRaw, '0');

    void feeCollectorAbi;
    void oracleRouterAbi;
    void orderSettlementAbi;
    void liquidationAuctionAbi;

    console.log(
      `PASS WS4.7 Step 3: Controlled liquidation conserved 100% USDC (paid=${liquidatorSpent}, lenderClaim=${claimRes2.claimedAmountRaw}, borrowerSurplus=${borrowerUsdcSurplus}, keeperReward=${keeperReward}, protocolFees=${protocolLiqAndIntFee}) and released leftover ${borrowerMetacLeftover} METAc to borrower.`
    );
    console.log('\nALL WS4.7 GUARDED MAINNET SMOKE PREP HARNESS CHECKS PASSED.');
  } finally {
    anvilProc.kill('SIGKILL');
  }
}

runTests().catch((err) => {
  console.error('\n[WS4.7_SMOKE] FAILED:', err);
  process.exit(1);
});
