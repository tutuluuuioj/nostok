import assert from 'node:assert/strict';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
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
  zeroAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { AuctionStatus, LoanStatus, collateralEscrowAbi, liquidationAuctionAbi, loanCoreAbi, positionNftAbi } from '../src/abi.js';
import { loadConfig } from '../src/config.js';
import { toBigInt } from '../src/db.js';
import { createIndexerContext, runIndexerSync } from '../src/indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEXER_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(INDEXER_DIR, '..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'contracts');

const FOUNDRY_BIN_DIR = process.env.FOUNDRY_BIN_DIR ?? `${process.env.HOME}/.foundry/bin`;
const ANVIL_PORT = Number(process.env.TEST_INDEXER_ANVIL_PORT ?? 18546);
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
    console.log(`[INDEXER_TEST] Starting Anvil fork against ${forkUrl} on port ${ANVIL_PORT}...`);
    const proc = spawn(
      `${FOUNDRY_BIN_DIR}/anvil`,
      ['--fork-url', forkUrl, '--port', String(ANVIL_PORT), '--chain-id', '8453', '--silent'],
      { env: getShellEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await waitForRpcReady(LOCAL_RPC_URL, 25_000);
      console.log(`[INDEXER_TEST] Anvil Base Mainnet fork ready (chainId=8453)`);
      return proc;
    } catch (err) {
      proc.kill('SIGKILL');
      console.warn(`[INDEXER_TEST] Fork RPC ${forkUrl} failed: ${(err as Error).message}`);
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
  return m[1] as Address;
}

function deployProtocolWithForge(): DeployedAddresses {
  console.log('[INDEXER_TEST] Running DeployNostok.s.sol on local Base Mainnet fork...');
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

async function assertLoanMatchesOnchain(
  publicClient: ReturnType<typeof createPublicClient>,
  loanCore: Address,
  dbLoanRow: Record<string, unknown>,
  loanId: bigint
) {
  const onchain = await publicClient.readContract({
    address: loanCore,
    abi: loanCoreAbi,
    functionName: 'getLoan',
    args: [loanId],
  });
  const activeAuction = await publicClient.readContract({
    address: loanCore,
    abi: loanCoreAbi,
    functionName: 'loanActiveAuction',
    args: [loanId],
  });

  assert.equal(String(dbLoanRow.borrower).toLowerCase(), onchain.borrower.toLowerCase());
  assert.equal(String(dbLoanRow.collateral_token).toLowerCase(), onchain.collateralToken.toLowerCase());
  assert.equal(toBigInt(dbLoanRow.collateral_raw), onchain.collateralRaw);
  assert.equal(toBigInt(dbLoanRow.principal), onchain.principal);
  assert.equal(toBigInt(dbLoanRow.maturity), onchain.maturity);
  assert.equal(Number(dbLoanRow.rate_bps), onchain.rateBps);
  assert.equal(Number(dbLoanRow.status), onchain.status);
  assert.equal(toBigInt(dbLoanRow.interest_paid), onchain.interestPaid);
  assert.equal(toBigInt(dbLoanRow.principal_repaid), onchain.principalRepaid);
  assert.equal(toBigInt(dbLoanRow.active_auction_id), activeAuction);
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

    // Deploy MockB20Token (NVDAc) & MockAggregator ($140.00)
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

    const feedReceipt = await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.deployContract({
        abi: mockAggArtifact.abi,
        bytecode: mockAggArtifact.bytecode,
        args: [8, 140_00000000n],
      }),
    });
    const nvdaFeed = getAddress(feedReceipt.contractAddress!);

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
              perLoanCap: 50_000_000_000n,
              assetCap: 100_000_000_000n,
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

    // Fund borrower with 20 NVDAc, and borrower/lender/liquidator with real Base Mainnet USDC
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.writeContract({
        address: nvdac,
        abi: mockB20Artifact.abi,
        functionName: 'mint',
        args: [ADDRESSES.borrower, 20n * 10n ** 18n],
      }),
    });

    await rpcCall('anvil_impersonateAccount', [BASE_USDC_WHALE]);
    await rpcCall('anvil_setBalance', [BASE_USDC_WHALE, '0x56bc75e2d63100000']);
    const transferUsdcAbi = parseAbi(['function transfer(address to, uint256 value) returns (bool)']);
    for (const [to, amt] of [
      [ADDRESSES.borrower, 2_000_000_000n],
      [ADDRESSES.lender, 5_000_000_000n],
      [ADDRESSES.liquidator, 5_000_000_000n],
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
    await publicClient.waitForTransactionReceipt({
      hash: await borrowerClient.writeContract({
        address: nvdac,
        abi: approveAbi,
        functionName: 'approve',
        args: [deployed.collateralEscrow, 20n * 10n ** 18n],
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await borrowerClient.writeContract({
        address: BASE_USDC,
        abi: approveAbi,
        functionName: 'approve',
        args: [deployed.loanCore, 2_000_000_000n],
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await lenderClient.writeContract({
        address: BASE_USDC,
        abi: approveAbi,
        functionName: 'approve',
        args: [deployed.loanCore, 5_000_000_000n],
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await liquidatorClient.writeContract({
        address: BASE_USDC,
        abi: approveAbi,
        functionName: 'approve',
        args: [deployed.liquidationAuction, 5_000_000_000n],
      }),
    });

    // Initialize PostgreSQL (PGlite embedded) indexer
    const config = loadConfig({
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
    const ctx = await createIndexerContext(config);

    try {
      // -----------------------------------------------------------------------
      // STEP 1: Open Loan (OrderSettlement.fillBorrowOrder -> Loan #1)
      // -----------------------------------------------------------------------
      console.log('\n=== STEP 1: Open Loan & Sync DB ===');
      const blk = await publicClient.getBlock();
      const order = {
        borrower: ADDRESSES.borrower,
        collateralToken: nvdac,
        collateralAmount: 10n * 10n ** 18n,
        minUsdc: 800_000_000n,
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
        message: order,
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

      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: deployed.orderSettlement,
          abi: fillOrderAbi,
          functionName: 'fillBorrowOrder',
          args: [order, sig, 800_000_000n],
        }),
      });

      const sync1 = await runIndexerSync(ctx);
      console.log('[INDEXER] Open loan sync:', sync1);

      const loanRows1 = await ctx.db.query('SELECT * FROM loans WHERE loan_id = 1');
      assert.equal(loanRows1.rows.length, 1);
      await assertLoanMatchesOnchain(publicClient, deployed.loanCore, loanRows1.rows[0], 1n);

      const orderRows = await ctx.db.query('SELECT * FROM orders');
      const fillRows = await ctx.db.query('SELECT * FROM order_fills WHERE loan_id = 1');
      assert.equal(orderRows.rows.length, 1);
      assert.equal(toBigInt(orderRows.rows[0].filled_usdc), 800_000_000n);
      assert.equal(fillRows.rows.length, 1);

      const posRows1 = await ctx.db.query('SELECT * FROM positions WHERE loan_id = 1');
      assert.equal(String(posRows1.rows[0].owner).toLowerCase(), ADDRESSES.lender.toLowerCase());
      assert.equal(posRows1.rows[0].is_burned, false);

      const escrowInRows = await ctx.db.query(
        `SELECT * FROM loan_events WHERE event_name = 'EscrowTransferIn'`
      );
      assert.equal(escrowInRows.rows.length, 1);
      assert.equal(toBigInt(escrowInRows.rows[0].amount_raw), 10n * 10n ** 18n);
      console.log('PASS STEP 1: Open loan indexed across loans, orders, order_fills, positions, loan_events (B20 Transfer).');

      // -----------------------------------------------------------------------
      // STEP 2: Chain Reorg Rollback Test (anvil_snapshot / anvil_revert)
      // -----------------------------------------------------------------------
      console.log('\n=== STEP 2: Reorg Test (anvil_snapshot / anvil_revert) ===');
      const snapId = await rpcCall<string>('anvil_snapshot', []);

      // Execute a tx that will be orphaned by reorg: topUp(1, 5 NVDAc)
      const reorgedReceipt = await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: deployed.loanCore,
          abi: parseAbi(['function topUp(uint256 loanId, uint128 additionalCollateral)']),
          functionName: 'topUp',
          args: [1n, 5n * 10n ** 18n],
        }),
      });
      assert.equal(reorgedReceipt.status, 'success');
      await runIndexerSync(ctx);

      const beforeReorgLoan = await ctx.db.query('SELECT collateral_raw FROM loans WHERE loan_id = 1');
      const beforeReorgEvents = await ctx.db.query(
        `SELECT COUNT(*)::INT AS cnt FROM loan_events WHERE event_name = 'ToppedUp'`
      );
      assert.equal(toBigInt(beforeReorgLoan.rows[0].collateral_raw), 15n * 10n ** 18n);
      assert.equal(Number(beforeReorgEvents.rows[0].cnt), 1);

      // Revert chain back to snapshot & mine a competing canonical block at the same block height
      const reverted = await rpcCall<boolean>('anvil_revert', [snapId]);
      assert.equal(reverted, true, 'anvil_revert must succeed');
      await rpcCall('evm_mine', []);

      const syncReorg = await runIndexerSync(ctx);
      console.log('[INDEXER] Post-reorg sync:', syncReorg);
      assert.equal(syncReorg.reorgDetected, true, 'Indexer must detect block hash mismatch / reorg');
      assert.equal(syncReorg.rolledBackToBlock, reorgedReceipt.blockNumber - 1n);

      const afterReorgLoan = await ctx.db.query('SELECT * FROM loans WHERE loan_id = 1');
      const afterReorgEvents = await ctx.db.query(
        `SELECT COUNT(*)::INT AS cnt FROM loan_events WHERE event_name = 'ToppedUp'`
      );
      const afterReorgAsset = await ctx.db.query('SELECT escrow_balance_raw FROM assets WHERE token = $1', [nvdac]);

      await assertLoanMatchesOnchain(publicClient, deployed.loanCore, afterReorgLoan.rows[0], 1n);
      assert.equal(toBigInt(afterReorgLoan.rows[0].collateral_raw), 10n * 10n ** 18n);
      assert.equal(Number(afterReorgEvents.rows[0].cnt), 0, 'Orphaned ToppedUp event must be rolled back');
      assert.equal(toBigInt(afterReorgAsset.rows[0].escrow_balance_raw), 10n * 10n ** 18n);
      console.log('PASS STEP 2: DB cleanly rolled back orphaned block & re-synced canonical state.');

      // -----------------------------------------------------------------------
      // STEP 3: Canonical topUp(1, 2 NVDAc)
      // -----------------------------------------------------------------------
      console.log('\n=== STEP 3: Canonical topUp ===');
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: deployed.loanCore,
          abi: parseAbi(['function topUp(uint256 loanId, uint128 additionalCollateral)']),
          functionName: 'topUp',
          args: [1n, 2n * 10n ** 18n],
        }),
      });
      await runIndexerSync(ctx);

      const loanAfterTopUp = await ctx.db.query('SELECT * FROM loans WHERE loan_id = 1');
      await assertLoanMatchesOnchain(publicClient, deployed.loanCore, loanAfterTopUp.rows[0], 1n);
      assert.equal(toBigInt(loanAfterTopUp.rows[0].collateral_raw), 12n * 10n ** 18n);
      console.log('PASS STEP 3: topUp indexed cleanly (collateral_raw=12e18 matches getLoan(1)).');

      // -----------------------------------------------------------------------
      // STEP 4: partialRepay(1, 200 USDC)
      // -----------------------------------------------------------------------
      console.log('\n=== STEP 4: partialRepay ===');
      await publicClient.waitForTransactionReceipt({
        hash: await borrowerClient.writeContract({
          address: deployed.loanCore,
          abi: parseAbi(['function partialRepay(uint256 loanId, uint128 principalRepayAmount) returns (uint128)']),
          functionName: 'partialRepay',
          args: [1n, 200_000_000n],
        }),
      });
      await runIndexerSync(ctx);

      const loanAfterPartial = await ctx.db.query('SELECT * FROM loans WHERE loan_id = 1');
      await assertLoanMatchesOnchain(publicClient, deployed.loanCore, loanAfterPartial.rows[0], 1n);
      assert.equal(toBigInt(loanAfterPartial.rows[0].principal_repaid), 200_000_000n);
      assert.equal(toBigInt(loanAfterPartial.rows[0].collateral_raw), 9n * 10n ** 18n);
      console.log('PASS STEP 4: partialRepay indexed cleanly (principalRepaid=200e6, collateralRaw=9e18).');

      // -----------------------------------------------------------------------
      // STEP 5: Price drop -> startLiquidation(1)
      // -----------------------------------------------------------------------
      console.log('\n=== STEP 5: Price Drop & Liquidation ===');
      // Drop price to $72 (9 NVDAc = $648 => >92% LTV >= 90% badDebtLtvBps => full 9 NVDAc auctioned)
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
      await runIndexerSync(ctx);

      const loanAfterLiq = await ctx.db.query('SELECT * FROM loans WHERE loan_id = 1');
      await assertLoanMatchesOnchain(publicClient, deployed.loanCore, loanAfterLiq.rows[0], 1n);
      assert.equal(Number(loanAfterLiq.rows[0].status), LoanStatus.Auction);

      const posAfterLiq = await ctx.db.query('SELECT * FROM positions WHERE loan_id = 1');
      assert.equal(posAfterLiq.rows[0].auction_locked, true);

      const auctionRows1 = await ctx.db.query('SELECT * FROM auctions WHERE auction_id = 1');
      assert.equal(auctionRows1.rows.length, 1);
      assert.equal(toBigInt(auctionRows1.rows[0].collateral_total), 9n * 10n ** 18n);
      assert.equal(Number(auctionRows1.rows[0].status), AuctionStatus.Active);
      console.log('PASS STEP 5: startLiquidation indexed cleanly (Auction #1 Active, Position #1 locked).');

      // -----------------------------------------------------------------------
      // STEP 6: Auction buy (full liquidation settlement)
      // -----------------------------------------------------------------------
      console.log('\n=== STEP 6: Auction Buy & Settlement ===');
      await publicClient.waitForTransactionReceipt({
        hash: await liquidatorClient.writeContract({
          address: deployed.liquidationAuction,
          abi: parseAbi([
            'function buy(uint256 auctionId, uint128 collateralAmount, uint128 maxUsdcPayment) returns (uint128)',
          ]),
          functionName: 'buy',
          args: [1n, 9n * 10n ** 18n, 800_000_000n],
        }),
      });
      await runIndexerSync(ctx);

      const loanAfterBuy = await ctx.db.query('SELECT * FROM loans WHERE loan_id = 1');
      await assertLoanMatchesOnchain(publicClient, deployed.loanCore, loanAfterBuy.rows[0], 1n);
      assert.equal(Number(loanAfterBuy.rows[0].status), LoanStatus.SettledLiquidated);
      assert.equal(toBigInt(loanAfterBuy.rows[0].collateral_raw), 0n);

      const buyRows = await ctx.db.query('SELECT * FROM auction_buys WHERE auction_id = 1');
      assert.equal(buyRows.rows.length, 1);
      assert.equal(String(buyRows.rows[0].buyer).toLowerCase(), ADDRESSES.liquidator.toLowerCase());
      assert.equal(toBigInt(buyRows.rows[0].collateral_purchased), 9n * 10n ** 18n);

      const auctionAfterBuy = await ctx.db.query('SELECT * FROM auctions WHERE auction_id = 1');
      const onchainAuctionAfter = await publicClient.readContract({
        address: deployed.liquidationAuction,
        abi: liquidationAuctionAbi,
        functionName: 'getAuction',
        args: [1n],
      });
      assert.equal(Number(auctionAfterBuy.rows[0].status), AuctionStatus.Settled);
      assert.equal(toBigInt(auctionAfterBuy.rows[0].collateral_remaining), onchainAuctionAfter.collateralRemaining);

      const posAfterBuy = await ctx.db.query('SELECT * FROM positions WHERE loan_id = 1');
      assert.equal(posAfterBuy.rows[0].is_burned, true);
      assert.equal(String(posAfterBuy.rows[0].owner).toLowerCase(), zeroAddress.toLowerCase());

      const assetAfterBuy = await ctx.db.query('SELECT escrow_balance_raw FROM assets WHERE token = $1', [nvdac]);
      const onchainEscrowBal = await publicClient.readContract({
        address: deployed.collateralEscrow,
        abi: collateralEscrowAbi,
        functionName: 'getBalance',
        args: [nvdac],
      });
      assert.equal(onchainEscrowBal, 0n);
      assert.equal(toBigInt(assetAfterBuy.rows[0].escrow_balance_raw), 0n);
      console.log('PASS STEP 6: Auction buy indexed cleanly (SettledLiquidated, NFT burned, escrow=0).');

      // -----------------------------------------------------------------------
      // STEP 7: Lender claim + confirmations window check
      // -----------------------------------------------------------------------
      console.log('\n=== STEP 7: Lender claim() & confirmation window check ===');
      const claimableBefore = await publicClient.readContract({
        address: deployed.loanCore,
        abi: loanCoreAbi,
        functionName: 'getClaimable',
        args: [ADDRESSES.lender],
      });
      assert.ok(claimableBefore > 0n, 'Lender must have positive claimable balance');

      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: deployed.loanCore,
          abi: parseAbi(['function claim(address to) returns (uint128)']),
          functionName: 'claim',
          args: [ADDRESSES.lender],
        }),
      });

      // Verify confirmations=2 holds uncommitted tip block until 2 additional blocks are mined
      ctx.config.confirmations = 2;
      const syncPendingConf = await runIndexerSync(ctx);
      assert.equal(syncPendingConf.blocksProcessed, 0, 'Confirmations window must hold tip block until N blocks pass');

      await rpcCall('evm_mine', []);
      await rpcCall('evm_mine', []);
      const syncFinal = await runIndexerSync(ctx);
      assert.ok(syncFinal.blocksProcessed >= 1, 'Claim block must index once confirmations are reached');

      const claimRows = await ctx.db.query('SELECT * FROM claims WHERE recipient = $1', [ADDRESSES.lender]);
      assert.equal(claimRows.rows.length, 1);
      assert.equal(toBigInt(claimRows.rows[0].amount), claimableBefore);

      // Verify PositionNFT burned check directly on-chain matches DB
      await assert.rejects(() =>
        publicClient.readContract({ address: deployed.positionNFT, abi: positionNftAbi, functionName: 'ownerOf', args: [1n] })
      );
      console.log(`PASS STEP 7: Lender claim=${claimableBefore} indexed cleanly after 2 confirmations.`);

      // Print compact summary of DB table counts
      const tables = ['loans', 'loan_events', 'orders', 'order_fills', 'auctions', 'auction_buys', 'positions', 'claims', 'assets'];
      const counts: Record<string, number> = {};
      for (const tbl of tables) {
        const res = await ctx.db.query<{ cnt: number }>(`SELECT COUNT(*)::INT AS cnt FROM ${tbl}`);
        counts[tbl] = Number(res.rows[0].cnt);
      }
      console.log('[INDEXER_TEST] Final PostgreSQL row counts:', counts);
      console.log('\nALL INDEXER WS2.1 & WS2.2 BASE MAINNET FORK + REORG TESTS PASSED.');
    } finally {
      await ctx.db.close();
    }
  } finally {
    anvilProc.kill('SIGKILL');
    fs.rmSync(path.join(CONTRACTS_DIR, 'broadcast'), { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('\nINDEXER FORK TEST FAILED:', err);
  process.exit(1);
});
