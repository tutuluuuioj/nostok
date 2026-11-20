/// <reference path="./ambient.d.ts" />
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
  encodeAbiParameters,
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
  ORDER_SETTLEMENT_DOMAIN_NAME,
  ORDER_SETTLEMENT_DOMAIN_VERSION,
  OracleState,
  assetRegistryAbi,
  collateralEscrowAbi,
  eligibilityGateAbi,
  erc20Abi,
  liquidationAuctionAbi,
  loanCoreAbi,
  oracleRouterAbi,
  orderSettlementAbi,
  positionNftAbi,
  setFrontendConfigOverrides,
} from '../src/lib/contracts.js';
import {
  evaluateAssetOriginationStatus,
  fetchLiveProtocolContractState,
  formatAssetOraclePrice,
  formatOracleUnitValue,
} from '../src/lib/marketsApi.js';
import {
  approveUsdcForLend,
  executeLoanClaim,
  executeLoanRepay,
  executeLoanTopUp,
  setCollateralAllowanceForBorrow,
} from '../src/lib/web3.js';
import {
  BASE_MAINNET_SMOKE_ASSETS,
  TIMELOCK_MIN_DELAY_SECS,
} from '../scripts/ws4_7_smoke_lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'contracts');
const FOUNDRY_BIN_DIR = process.env.FOUNDRY_BIN_DIR ?? `${process.env.HOME}/.foundry/bin`;
const ANVIL_PORT = Number(process.env.TEST_WS4_6_ANVIL_PORT ?? 18552);
const LOCAL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const BASE_USDC_WHALE: Address = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
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
    : ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://1rpc.io/base'];

  for (const forkUrl of candidates) {
    console.log(`[M3.3_WARGAMES] Starting Anvil Base fork against ${forkUrl} on port ${ANVIL_PORT}...`);
    const proc = spawn(
      `${FOUNDRY_BIN_DIR}/anvil`,
      ['--fork-url', forkUrl, '--port', String(ANVIL_PORT), '--chain-id', '8453', '--silent'],
      { env: getShellEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await waitForRpcReady(LOCAL_RPC_URL, 35_000);
      console.log('[M3.3_WARGAMES] Anvil Base Mainnet fork ready (chainId=8453)');
      return proc;
    } catch (err) {
      proc.kill('SIGKILL');
      console.warn(`[M3.3_WARGAMES] Fork RPC ${forkUrl} failed: ${(err as Error).message}`);
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
  console.log('[M3.3_WARGAMES] Deploying NOSTOK protocol via DeployNostok.s.sol...');
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
  return encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [expiry, sig]);
}

async function advanceForkToTimestamp(targetTs: bigint): Promise<void> {
  await rpcCall('evm_setNextBlockTimestamp', [Number(targetTs)]);
  await rpcCall('evm_mine', []);
}

async function advanceForkBySeconds(deltaSecs: number): Promise<void> {
  await rpcCall('evm_increaseTime', [deltaSecs]);
  await rpcCall('evm_mine', []);
}

async function findNextSaturdayAndMondayOpen(
  publicClient: ReturnType<typeof createPublicClient>,
  oracleRouterAddr: Address,
  currentTs: bigint
): Promise<{ saturdayTs: bigint; mondayOpenTs: bigint }> {
  const isHolidayAbi = parseAbi([
    'function isHoliday(uint256) view returns (bool)',
    'function isHalfDay(uint256) view returns (bool)',
  ]);
  const startDay = currentTs / 86_400n + 1n;
  let satDay = 0n;
  for (let d = startDay; d < startDay + 21n; d++) {
    const dow = (d + 4n) % 7n;
    if (dow === 6n) {
      satDay = d;
      break;
    }
  }
  assert.ok(satDay > 0n, 'Must locate next Saturday epoch day');

  let monDay = 0n;
  for (let d = satDay + 2n; d < satDay + 28n; d++) {
    const dow = (d + 4n) % 7n;
    if (dow !== 1n) continue;
    const [holiday, halfDay] = await Promise.all([
      publicClient.readContract({ address: oracleRouterAddr, abi: isHolidayAbi, functionName: 'isHoliday', args: [d] }),
      publicClient.readContract({ address: oracleRouterAddr, abi: isHolidayAbi, functionName: 'isHalfDay', args: [d] }),
    ]);
    if (!holiday && !halfDay) {
      monDay = d;
      break;
    }
  }
  assert.ok(monDay > satDay, 'Must locate next non-holiday NYSE Monday epoch day');

  // 16:00 UTC Saturday is always weekend closed; 15:00 UTC Monday = 10:00 EST / 11:00 EDT (inside NYSE regular session year-round)
  return {
    saturdayTs: satDay * 86_400n + 16n * 3_600n,
    mondayOpenTs: monDay * 86_400n + 15n * 3_600n,
  };
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

    const ownerSafe = await deployCanonicalSafeProxy(
      publicClient,
      deployerClient,
      [ADDRESSES.safeSignerA, ADDRESSES.safeSignerB],
      2n,
      46001n
    );
    const guardianSafe = await deployCanonicalSafeProxy(
      publicClient,
      deployerClient,
      [ADDRESSES.guardianSignerA, ADDRESSES.guardianSignerB],
      2n,
      46002n
    );
    await rpcCall('anvil_setBalance', [ownerSafe, '0x56bc75e2d63100000']);
    await rpcCall('anvil_setBalance', [guardianSafe, '0x56bc75e2d63100000']);

    const deployed = deployProtocolWithForge(ownerSafe, guardianSafe);
    const deployBlock = await publicClient.getBlockNumber();

    const mockB20Artifact = loadFoundryArtifact('MockB20Token.sol/MockB20Token.json');
    const mockAggArtifact = loadFoundryArtifact('MockAggregator.sol/MockAggregator.json');
    const mockSeqArtifact = loadFoundryArtifact('MockSequencer.sol/MockSequencer.json');
    const deployContract = async (abi: readonly unknown[], bytecode: Hex, args: unknown[]) => {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.deployContract({ abi, bytecode, args }),
      });
      return getAddress(receipt.contractAddress!);
    };

    const initMult = 1_000500000000000000n;
    // Match real Base Mainnet B20 decimals (8 decimals) plus an 18-decimal chaos asset for multi-decimal coverage
    const aaplc = await deployContract(mockB20Artifact.abi, mockB20Artifact.bytecode, [
      'Apple Tokenized Chaos',
      'AAPLc',
      8,
      initMult,
    ]);
    const tslac = await deployContract(mockB20Artifact.abi, mockB20Artifact.bytecode, [
      'Tesla Tokenized Chaos',
      'TSLAc',
      18,
      initMult,
    ]);
    const aaplFeed = await deployContract(mockAggArtifact.abi, mockAggArtifact.bytecode, [8, 200_00000000n]);
    const tslaFeed = await deployContract(mockAggArtifact.abi, mockAggArtifact.bytecode, [8, 250_00000000n]);
    const mockSeq = await deployContract(mockSeqArtifact.abi, mockSeqArtifact.bytecode, [0n]);

    // Real Base Mainnet NVDAc / METAc token + Chainlink feed tuple verification
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

    const chaosCfg = (feed: Address, maxStaleOpenSecs = 21_600) => ({
      feed,
      feedDecimals: 8,
      tier: 0,
      maxInitLtvBps: 6000,
      marginCallLtvBps: 7000,
      liqLtvBps: 7800,
      badDebtLtvBps: 9000,
      maxDiscountBps: 600,
      closedMarketHaircutBps: 500,
      perLoanCap: 10_000_000_000n,
      assetCap: 20_000_000_000n,
      maxStaleOpenSecs,
      status: 0, // Active
      restricted: false,
    });

    // Execute real 48h NostokTimelock batch from Owner Safe configuring global cap, real Base B20 NVDAc, and chaos assets
    const targets: Address[] = [
      deployed.loanCore,
      deployed.oracleRouter,
      deployed.assetRegistry,
      deployed.assetRegistry,
      deployed.assetRegistry,
    ];
    const values: bigint[] = [0n, 0n, 0n, 0n, 0n];
    const payloads: Hex[] = [
      encodeFunctionData({
        abi: parseAbi(['function setGlobalCap(uint128 newCap)']),
        functionName: 'setGlobalCap',
        args: [25_000_000_000n],
      }),
      encodeFunctionData({
        abi: parseAbi(['function setMarketSession(bool isOpen, bool isManual)']),
        functionName: 'setMarketSession',
        args: [true, true],
      }),
      encodeFunctionData({
        abi: setAssetConfigAbi,
        functionName: 'setAssetConfig',
        args: [BASE_MAINNET_SMOKE_ASSETS.NVDAc.token as Address, chaosCfg(BASE_MAINNET_SMOKE_ASSETS.NVDAc.feed as Address, 86_400)],
      }),
      encodeFunctionData({
        abi: setAssetConfigAbi,
        functionName: 'setAssetConfig',
        args: [aaplc, chaosCfg(aaplFeed, 21_600)],
      }),
      encodeFunctionData({
        abi: setAssetConfigAbi,
        functionName: 'setAssetConfig',
        args: [tslac, chaosCfg(tslaFeed, 21_600)],
      }),
    ];
    const salt = keccak256(stringToBytes('M3_3_WARGAMES_INIT'));
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
          args: [targets, values, payloads, zeroHash, salt, TIMELOCK_MIN_DELAY_SECS],
        }),
      }),
    });
    await advanceForkBySeconds(Number(TIMELOCK_MIN_DELAY_SECS) + 5);

    const setPriceAbi = parseAbi(['function setPrice(int256 price)']);
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: aaplFeed,
        data: encodeFunctionData({ abi: setPriceAbi, functionName: 'setPrice', args: [200_00000000n] }),
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: tslaFeed,
        data: encodeFunctionData({ abi: setPriceAbi, functionName: 'setPrice', args: [250_00000000n] }),
      }),
    });

    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: ownerSafe,
        to: deployed.nostokTimelock,
        data: encodeFunctionData({
          abi: timelockAbi,
          functionName: 'executeBatch',
          args: [targets, values, payloads, zeroHash, salt],
        }),
      }),
    });

    for (const tok of [BASE_MAINNET_SMOKE_ASSETS.NVDAc.token as Address, aaplc, tslac]) {
      await publicClient.waitForTransactionReceipt({
        hash: await keeperClient.sendTransaction({
          to: deployed.oracleRouter,
          data: encodeFunctionData({ abi: parseAbi(['function syncMultiplier(address)']), functionName: 'syncMultiplier', args: [tok] }),
        }),
      });
    }

    // Verify real live Base Mainnet NVDAc (8 dec) + Coinbase NVDA feed reads cleanly via OracleRouter & frontend loader
    const [nvdaPriceTuple, nvdaValTuple] = await Promise.all([
      publicClient.readContract({
        address: deployed.oracleRouter,
        abi: oracleRouterAbi,
        functionName: 'getPrice',
        args: [BASE_MAINNET_SMOKE_ASSETS.NVDAc.token as Address],
      }),
      publicClient.readContract({
        address: deployed.oracleRouter,
        abi: oracleRouterAbi,
        functionName: 'getValue',
        args: [BASE_MAINNET_SMOKE_ASSETS.NVDAc.token as Address, 10_00000000n], // 10 NVDAc (8 decimals)
      }),
    ]);
    assert.ok(nvdaPriceTuple[0] > 0n, 'Real Base Mainnet Coinbase NVDA feed must read non-zero on fork');
    assert.ok(nvdaValTuple[0] > 0n, 'Real Base Mainnet NVDAc (8 dec) getValue must compute non-zero USDC value');

    const cfg = {
      chainId: BASE_CHAIN_ID,
      rpcUrl: LOCAL_RPC_URL,
      apiUrl: '',
      usdcAddress: BASE_USDC_ADDRESS,
      deployBlock: deployBlock.toString(),
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

    const liveRealInit = await fetchLiveProtocolContractState({
      cfg,
      tokenAddresses: [BASE_MAINNET_SMOKE_ASSETS.NVDAc.token as Address, aaplc, tslac],
      includeLogDiscovery: false,
    });
    assert.equal(liveRealInit.ok, true);
    const liveNvda = liveRealInit.assets.find((a) => a.symbol === 'NVDAc');
    assert.ok(liveNvda && liveNvda.decimals === 8 && liveNvda.onchain_verified);
    console.log(
      `PASS Setup + Real Base Mainnet NVDAc (0xb200...08C, 8 dec) & Coinbase NVDA feed price=$${(Number(nvdaPriceTuple[0]) / 1e8).toFixed(2)} verified.`
    );

    // Allowlist borrower, lender, liquidator on EligibilityGate
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: ownerSafe,
        to: deployed.eligibilityGate,
        data: encodeFunctionData({
          abi: parseAbi(['function setAllowlistBatch(address[],bool)']),
          functionName: 'setAllowlistBatch',
          args: [[ADDRESSES.borrower, ADDRESSES.lender, ADDRESSES.liquidator], true],
        }),
      }),
    });

    // Fund accounts (USDC + chaos B20 tokens)
    await rpcCall('anvil_impersonateAccount', [BASE_USDC_WHALE]);
    await rpcCall('anvil_setBalance', [BASE_USDC_WHALE, '0x56bc75e2d63100000']);
    const transferUsdcAbi = parseAbi(['function transfer(address to, uint256 value) returns (bool)']);
    for (const [to, amt] of [
      [ADDRESSES.borrower, 30_000_000_000n],
      [ADDRESSES.lender, 50_000_000_000n],
      [ADDRESSES.liquidator, 30_000_000_000n],
    ] as const) {
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: BASE_USDC_WHALE,
          to: BASE_USDC_ADDRESS,
          data: encodeFunctionData({ abi: transferUsdcAbi, functionName: 'transfer', args: [to, amt] }),
        }),
      });
    }
    const mintAbi = parseAbi(['function mint(address to, uint256 amount)']);
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: aaplc,
        data: encodeFunctionData({ abi: mintAbi, functionName: 'mint', args: [ADDRESSES.borrower, 500_00000000n] }),
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: tslac,
        data: encodeFunctionData({ abi: mintAbi, functionName: 'mint', args: [ADDRESSES.borrower, 100n * 10n ** 18n] }),
      }),
    });

    const walletProvider = createMockEip1193Provider(KEYS.borrower);
    const settlementDomain = {
      name: ORDER_SETTLEMENT_DOMAIN_NAME,
      version: ORDER_SETTLEMENT_DOMAIN_VERSION,
      chainId: BASE_CHAIN_ID,
      verifyingContract: deployed.orderSettlement,
    };
    const mintBorrowLoan = async (token: Address, collateralRaw: bigint, principalRaw: bigint) => {
      const blk = await publicClient.getBlock({ blockTag: 'latest' });
      const exp = BigInt(blk.timestamp) + 50n * 86_400n;
      const [bAtt, lAtt, makerNonce] = await Promise.all([
        mintAttestationViaContract(publicClient, deployed.eligibilityGate, ADDRESSES.borrower, exp),
        mintAttestationViaContract(publicClient, deployed.eligibilityGate, ADDRESSES.lender, exp),
        publicClient.readContract({
          address: deployed.orderSettlement,
          abi: orderSettlementAbi,
          functionName: 'getMakerNonce',
          args: [ADDRESSES.borrower],
        }),
      ]);
      const order = {
        borrower: ADDRESSES.borrower,
        collateralToken: token,
        collateralAmount: collateralRaw,
        minUsdc: principalRaw,
        maxRateBps: 900,
        termDays: 30,
        maxLtvBps: 6000,
        minFill: 500_000_000n,
        expiry: exp,
        nonce: BigInt(makerNonce as bigint),
        yieldMode: 0,
        allowInKindSettlement: false,
      };
      // Increment nonce via bump or reuse unique salt? Note fillBorrowOrder doesn't bump makerNonce; expiry+nonce tuple is hashed cleanly if unique collateral/nonce, or bumpNonce on settlement!
      const sig = await privateKeyToAccount(KEYS.borrower).signTypedData({
        domain: settlementDomain,
        types: BORROW_ORDER_EIP712_TYPES,
        primaryType: 'BorrowOrder',
        message: order,
      });
      walletProvider.setAccount(KEYS.borrower);
      await setCollateralAllowanceForBorrow({
        address: ADDRESSES.borrower,
        collateralToken: token,
        targetAllowanceRaw: collateralRaw * 2n,
        provider: walletProvider,
        cfg,
      });
      walletProvider.setAccount(KEYS.lender);
      await approveUsdcForLend({
        address: ADDRESSES.lender,
        requiredUsdcRaw: principalRaw,
        provider: walletProvider,
        cfg,
      });
      const prevNextId = BigInt(
        (await publicClient.readContract({ address: deployed.loanCore, abi: loanCoreAbi, functionName: 'nextLoanId' })) as bigint
      );
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: deployed.orderSettlement,
          abi: orderSettlementAbi,
          functionName: 'fillBorrowOrderWithAttestations',
          args: [order, sig, principalRaw, bAtt, lAtt],
        }),
      });
      return prevNextId;
    };

    const refreshFeeds = async (aaplUsd8 = 200_00000000n, tslaUsd8 = 250_00000000n) => {
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.sendTransaction({
          to: aaplFeed,
          data: encodeFunctionData({ abi: setPriceAbi, functionName: 'setPrice', args: [aaplUsd8] }),
        }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.sendTransaction({
          to: tslaFeed,
          data: encodeFunctionData({ abi: setPriceAbi, functionName: 'setPrice', args: [tslaUsd8] }),
        }),
      });
    };

    // =========================================================================
    // WAR GAME 1: Flash-Crash Recovery Auto-Cancel & Extreme Bad-Debt Solvency
    // =========================================================================
    // Loan #1: 100 AAPLc ($200 -> $20,000), $10,000 USDC principal (50% LTV)
    const loanId1 = await mintBorrowLoan(aaplc, 100_00000000n, 10_000_000_000n);
    // Loan #2: 20 TSLAc ($250 -> $5,000), $2,500 USDC principal (50% LTV)
    const loanId2 = await mintBorrowLoan(tslac, 20n * 10n ** 18n, 2_500_000_000n);

    // 1A: AAPLc flash crash $200 -> $120 (~83.3% LTV in [78%, 90%)): 50% collateral enters auction -> price recovers $200 -> restartOrCancelAuction cancels & restores Active
    await refreshFeeds(120_00000000n, 250_00000000n);
    await publicClient.waitForTransactionReceipt({
      hash: await keeperClient.sendTransaction({
        to: deployed.loanCore,
        data: encodeFunctionData({ abi: parseAbi(['function startLiquidation(uint256)']), functionName: 'startLiquidation', args: [loanId1] }),
      }),
    });
    const aucId1 = (await publicClient.readContract({
      address: deployed.loanCore,
      abi: loanCoreAbi,
      functionName: 'loanActiveAuction',
      args: [loanId1],
    })) as bigint;
    assert.equal(await publicClient.readContract({ address: deployed.positionNFT, abi: positionNftAbi, functionName: 'isAuctionLocked', args: [loanId1] }), true);

    await refreshFeeds(200_00000000n, 250_00000000n);
    await advanceForkBySeconds(1805);
    await refreshFeeds(200_00000000n, 250_00000000n);
    await publicClient.waitForTransactionReceipt({
      hash: await keeperClient.sendTransaction({
        to: deployed.liquidationAuction,
        data: encodeFunctionData({ abi: parseAbi(['function restartOrCancelAuction(uint256)']), functionName: 'restartOrCancelAuction', args: [aucId1] }),
      }),
    });
    const loan1AfterRecovery = (await publicClient.readContract({ address: deployed.loanCore, abi: loanCoreAbi, functionName: 'getLoan', args: [loanId1] })) as {
      status: number;
    };
    assert.equal(Number(loan1AfterRecovery.status), 0, 'Recovered flash-crash price must cancel auction & restore LoanStatus.Active (0)');
    assert.equal(await publicClient.readContract({ address: deployed.positionNFT, abi: positionNftAbi, functionName: 'isAuctionLocked', args: [loanId1] }), false);
    assert.equal(await publicClient.readContract({ address: deployed.loanCore, abi: loanCoreAbi, functionName: 'loanActiveAuction', args: [loanId1] }), 0n);

    // 1B: TSLAc catastrophic crash $250 -> $80 ($1,600 collateral < $2,500 debt => BadDebtRecorded on full buyout)
    await refreshFeeds(200_00000000n, 80_00000000n);
    await publicClient.waitForTransactionReceipt({
      hash: await keeperClient.sendTransaction({
        to: deployed.loanCore,
        data: encodeFunctionData({ abi: parseAbi(['function startLiquidation(uint256)']), functionName: 'startLiquidation', args: [loanId2] }),
      }),
    });
    const aucId2 = (await publicClient.readContract({
      address: deployed.loanCore,
      abi: loanCoreAbi,
      functionName: 'loanActiveAuction',
      args: [loanId2],
    })) as bigint;
    const maxPayTsla = 2_000_000_000n;
    await publicClient.waitForTransactionReceipt({
      hash: await liquidatorClient.sendTransaction({
        to: BASE_USDC_ADDRESS,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [deployed.liquidationAuction, maxPayTsla] }),
      }),
    });
    const buyTx2 = await publicClient.waitForTransactionReceipt({
      hash: await liquidatorClient.sendTransaction({
        to: deployed.liquidationAuction,
        data: encodeFunctionData({
          abi: parseAbi(['function buy(uint256,uint128,uint128) returns (uint128)']),
          functionName: 'buy',
          args: [aucId2, 20n * 10n ** 18n, maxPayTsla],
        }),
      }),
    });
    const badDebtTopic = keccak256(stringToBytes('BadDebtRecorded(uint256,uint128)'));
    assert.ok(buyTx2.logs.some((l) => l.topics[0] === badDebtTopic), 'Underwater auction buy must emit BadDebtRecorded');
    assert.equal(
      await publicClient.readContract({ address: deployed.loanCore, abi: loanCoreAbi, functionName: 'assetOutstandingPrincipal', args: [tslac] }),
      0n,
      'Settled bad debt must decrement assetOutstandingPrincipal cleanly to 0'
    );
    assert.equal(
      await publicClient.readContract({ address: deployed.loanCore, abi: loanCoreAbi, functionName: 'totalOutstandingPrincipal' }),
      10_000_000_000n,
      'Total outstanding principal must equal only Loan #1 ($10,000)'
    );
    assert.equal(
      await publicClient.readContract({ address: tslac, abi: erc20Abi, functionName: 'balanceOf', args: [deployed.collateralEscrow] }),
      0n
    );
    await assert.rejects(
      () => publicClient.readContract({ address: deployed.positionNFT, abi: positionNftAbi, functionName: 'ownerOf', args: [loanId2] }),
      /ERC721NonexistentToken/i
    );
    // Lender claims recovered underwater proceeds
    walletProvider.setAccount(KEYS.lender);
    const badDebtClaim = await executeLoanClaim({ address: ADDRESSES.lender, recipient: ADDRESSES.lender, provider: walletProvider, cfg });
    assert.ok(BigInt(badDebtClaim.claimedAmountRaw) > 0n);

    const liveAfterCrash = await fetchLiveProtocolContractState({
      cfg,
      tokenAddresses: [aaplc, tslac],
      includeLogDiscovery: false,
    });
    assert.equal(liveAfterCrash.protocol?.totalOutstandingPrincipal?.raw, '10000000000');
    console.log('PASS WAR GAME 1: Flash-crash recovery auto-cancel & underwater BadDebtRecorded accounting + frontend sync verified.');

    // =========================================================================
    // WAR GAME 2: Weekend / Closed-Market Gap & Monday Open Re-Validation
    // =========================================================================
    // Impersonate nostokTimelock only after initial 48h batch already proved, to switch OracleRouter calendar/sequencer deterministically in chaos drills
    await rpcCall('anvil_impersonateAccount', [deployed.nostokTimelock]);
    await rpcCall('anvil_setBalance', [deployed.nostokTimelock, '0x56bc75e2d63100000']);
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: deployed.nostokTimelock,
        to: deployed.oracleRouter,
        data: encodeFunctionData({ abi: parseAbi(['function setMarketSession(bool,bool)']), functionName: 'setMarketSession', args: [false, false] }),
      }),
    });

    const latestBlk = await publicClient.getBlock({ blockTag: 'latest' });
    const { saturdayTs, mondayOpenTs } = await findNextSaturdayAndMondayOpen(
      publicClient,
      deployed.oracleRouter,
      BigInt(latestBlk.timestamp)
    );
    await advanceForkToTimestamp(saturdayTs);
    await refreshFeeds(115_00000000n, 250_00000000n); // Weekend crash to $115 (~86.9% LTV)

    const satValTuple = (await publicClient.readContract({
      address: deployed.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'getValue',
      args: [aaplc, 100_00000000n],
    })) as [bigint, bigint, number];
    assert.equal(satValTuple[2], OracleState.VALID_CLOSED, 'Saturday UTC must report OracleState.VALID_CLOSED (1)');
    assert.equal(
      satValTuple[1],
      (satValTuple[0] * 9500n) / 10_000n,
      'Closed market must enforce exact 500 bps closedMarketHaircutBps on effectiveValueUsdc'
    );
    assert.equal(
      await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'isMarketOpen' }),
      false
    );
    const liveSat = await fetchLiveProtocolContractState({ cfg, tokenAddresses: [aaplc], includeLogDiscovery: false });
    const liveAaplSat = liveSat.assets.find((a) => a.symbol === 'AAPLc')!;
    const satOrigStatus = evaluateAssetOriginationStatus(liveAaplSat, liveSat.protocol);
    assert.equal(satOrigStatus.canOriginate, true);
    assert.equal(satOrigStatus.severity, 'hint');
    assert.match(satOrigStatus.message, /VALID_CLOSED.*closed-market haircut/i);

    // Sniping weekend gap liquidation must REVERT cleanly
    await assert.rejects(
      () =>
        keeperClient.writeContract({
          address: deployed.loanCore,
          abi: parseAbi(['function startLiquidation(uint256)']),
          functionName: 'startLiquidation',
          args: [loanId1],
        }),
      /OracleInvalidForAction|0x/i
    );

    // Advance into Monday regular NYSE open BEFORE monday feed updates -> stale age > 21,600s -> STALE_FEED (blocks snipe before fresh open print)
    await advanceForkToTimestamp(mondayOpenTs);
    assert.equal(
      await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'isMarketOpen' }),
      true
    );
    const staleOnOpenState = await publicClient.readContract({
      address: deployed.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'getOracleState',
      args: [aaplc],
    });
    assert.equal(Number(staleOnOpenState), OracleState.STALE_FEED);

    const liveStaleOpen = await fetchLiveProtocolContractState({ cfg, tokenAddresses: [aaplc], includeLogDiscovery: false });
    const liveAaplStale = liveStaleOpen.assets.find((a) => a.symbol === 'AAPLc')!;
    assert.equal(evaluateAssetOriginationStatus(liveAaplStale, liveStaleOpen.protocol).canOriginate, false);
    assert.match(formatAssetOraclePrice(liveAaplStale.oracle), /\(stale\)/);

    // Push Monday regular open print (and restore $200 -> keep Loan #1 healthy before next drills!)
    await refreshFeeds(115_00000000n, 250_00000000n);
    assert.equal(
      Number(await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'getOracleState', args: [aaplc] })),
      OracleState.VALID_OPEN
    );
    // Verify liquidation now executes on Monday open when price opens gapped down ($115), then recover price to $200 & cancel for downstream drills
    await publicClient.waitForTransactionReceipt({
      hash: await keeperClient.sendTransaction({
        to: deployed.loanCore,
        data: encodeFunctionData({ abi: parseAbi(['function startLiquidation(uint256)']), functionName: 'startLiquidation', args: [loanId1] }),
      }),
    });
    const monAucId = (await publicClient.readContract({
      address: deployed.loanCore,
      abi: loanCoreAbi,
      functionName: 'loanActiveAuction',
      args: [loanId1],
    })) as bigint;
    await advanceForkBySeconds(1805);
    await refreshFeeds(200_00000000n, 250_00000000n);
    await publicClient.waitForTransactionReceipt({
      hash: await keeperClient.sendTransaction({
        to: deployed.liquidationAuction,
        data: encodeFunctionData({ abi: parseAbi(['function restartOrCancelAuction(uint256)']), functionName: 'restartOrCancelAuction', args: [monAucId] }),
      }),
    });
    console.log('PASS WAR GAME 2: Weekend NYSE closed haircut (500 bps), blocked gap snipe, Monday stale-before-open block & reopen execution verified.');

    // Switch back to controlled manual open session + MockSequencer for deterministic sequencer & split timing drills
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: deployed.nostokTimelock,
        to: deployed.oracleRouter,
        data: encodeFunctionData({ abi: parseAbi(['function setMarketSession(bool,bool)']), functionName: 'setMarketSession', args: [true, true] }),
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: deployed.nostokTimelock,
        to: deployed.oracleRouter,
        data: encodeFunctionData({
          abi: parseAbi(['function setSequencerUptimeFeed(address,uint256)']),
          functionName: 'setSequencerUptimeFeed',
          args: [mockSeq, 3600n],
        }),
      }),
    });
    const seqPreBlk = await publicClient.getBlock({ blockTag: 'latest' });
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: mockSeq,
        data: encodeFunctionData({ abi: parseAbi(['function setStatus(int256,uint256)']), functionName: 'setStatus', args: [0n, BigInt(seqPreBlk.timestamp) - 7200n] }),
      }),
    });
    await refreshFeeds(200_00000000n, 250_00000000n);

    // =========================================================================
    // WAR GAME 3: Base L2 Sequencer Downtime & 1-Hour Grace Recovery (WS4.6)
    // =========================================================================
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: mockSeq,
        data: encodeFunctionData({ abi: parseAbi(['function setStatus(int256,uint256)']), functionName: 'setStatus', args: [1n, BigInt(seqPreBlk.timestamp)] }),
      }),
    });
    assert.equal(await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'isSequencerValid' }), false);
    assert.equal(
      Number(await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'getOracleState', args: [aaplc] })),
      OracleState.INVALID_SEQUENCER
    );

    const liveSeqDown = await fetchLiveProtocolContractState({ cfg, tokenAddresses: [aaplc], includeLogDiscovery: false });
    const aaplSeqDown = liveSeqDown.assets.find((a) => a.symbol === 'AAPLc')!;
    assert.equal(evaluateAssetOriginationStatus(aaplSeqDown, liveSeqDown.protocol).canOriginate, false);
    assert.equal(formatAssetOraclePrice(aaplSeqDown.oracle), 'n/a');
    assert.equal(formatOracleUnitValue(aaplSeqDown.oracle_unit_value, aaplSeqDown.oracle), 'n/a');

    // New loans must REVERT while sequencer down
    await assert.rejects(() => mintBorrowLoan(aaplc, 10_00000000n, 1_000_000_000n));
    // Exit & defensive topUp/repay remain OPEN during sequencer outage!
    walletProvider.setAccount(KEYS.borrower);
    await executeLoanTopUp({
      address: ADDRESSES.borrower,
      loanId: loanId1,
      additionalCollateralRaw: 5_00000000n,
      existingOpenCollateralRaw: 0n,
      autoApprove: true,
      provider: walletProvider,
      cfg,
    });
    await executeLoanRepay({
      address: ADDRESSES.borrower,
      loanId: loanId1,
      principalRepayRaw: 1_000_000_000n,
      existingOpenSumRaw: 0n,
      autoApprove: true,
      provider: walletProvider,
      cfg,
    });

    // Sequencer recovers at seqRecoverBlk.timestamp -> within 1h grace window (still INVALID_SEQUENCER!), then recovers at +3601s
    const seqRecoverBlk = await publicClient.getBlock({ blockTag: 'latest' });
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: mockSeq,
        data: encodeFunctionData({ abi: parseAbi(['function setStatus(int256,uint256)']), functionName: 'setStatus', args: [0n, BigInt(seqRecoverBlk.timestamp)] }),
      }),
    });
    await advanceForkBySeconds(1800);
    await refreshFeeds(200_00000000n, 250_00000000n);
    assert.equal(await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'isSequencerValid' }), false);

    await advanceForkBySeconds(1805);
    await refreshFeeds(200_00000000n, 250_00000000n);
    assert.equal(await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'isSequencerValid' }), true);
    assert.equal(
      Number(await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'getOracleState', args: [aaplc] })),
      OracleState.VALID_OPEN
    );
    console.log('PASS WAR GAME 3: Base L2 sequencer downtime, 1h grace window block, unblocked topUp/partialRepay, and recovery verified.');

    // =========================================================================
    // WAR GAME 4: B20 Corporate-Action Split Freeze (>=5%) vs Dividend Drift (<5%)
    // =========================================================================
    const setMultAbi = parseAbi(['function setUIMultiplier(uint256)']);
    // 4A: <5% dividend drift (+200 bps) remains VALID_OPEN & permissionless syncMultiplier succeeds
    const divDriftMult = (initMult * 10_200n) / 10_000n;
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: aaplc,
        data: encodeFunctionData({ abi: setMultAbi, functionName: 'setUIMultiplier', args: [divDriftMult] }),
      }),
    });
    assert.equal(
      Number(await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'getOracleState', args: [aaplc] })),
      OracleState.VALID_OPEN
    );
    await publicClient.waitForTransactionReceipt({
      hash: await keeperClient.sendTransaction({
        to: deployed.oracleRouter,
        data: encodeFunctionData({ abi: parseAbi(['function syncMultiplier(address)']), functionName: 'syncMultiplier', args: [aaplc] }),
      }),
    });
    assert.equal(
      await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'recordedMultiplier', args: [aaplc] }),
      divDriftMult
    );

    // 4B: >=5% split freeze (+500 bps / 2x) triggers FROZEN_CORPORATE_ACTION & blocks unprivileged syncMultiplier
    const splitMult = divDriftMult * 2n;
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: aaplc,
        data: encodeFunctionData({ abi: setMultAbi, functionName: 'setUIMultiplier', args: [splitMult] }),
      }),
    });
    assert.equal(
      Number(await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'getOracleState', args: [aaplc] })),
      OracleState.FROZEN_CORPORATE_ACTION
    );
    await assert.rejects(
      () =>
        keeperClient.writeContract({
          address: deployed.oracleRouter,
          abi: parseAbi(['function syncMultiplier(address)']),
          functionName: 'syncMultiplier',
          args: [aaplc],
        }),
      /CorporateActionSplitPending|0x/i
    );
    const liveSplitFreeze = await fetchLiveProtocolContractState({ cfg, tokenAddresses: [aaplc], includeLogDiscovery: false });
    const aaplFrozen = liveSplitFreeze.assets.find((a) => a.symbol === 'AAPLc')!;
    assert.equal(evaluateAssetOriginationStatus(aaplFrozen, liveSplitFreeze.protocol).canOriginate, false);
    assert.equal(formatAssetOraclePrice(aaplFrozen.oracle), 'n/a');

    // Repay stays open during corporate action freeze!
    await executeLoanRepay({
      address: ADDRESSES.borrower,
      loanId: loanId1,
      principalRepayRaw: 1_000_000_000n,
      existingOpenSumRaw: 0n,
      autoApprove: true,
      provider: walletProvider,
      cfg,
    });

    // 4C: Guardian Safe calls syncMultiplier to ratify post-split multiplier and cleanly restore VALID_OPEN
    await rpcCall('anvil_impersonateAccount', [guardianSafe]);
    await publicClient.waitForTransactionReceipt({
      hash: await rawWalletClient.sendTransaction({
        account: guardianSafe,
        to: deployed.oracleRouter,
        data: encodeFunctionData({ abi: parseAbi(['function syncMultiplier(address)']), functionName: 'syncMultiplier', args: [aaplc] }),
      }),
    });
    assert.equal(
      Number(await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'getOracleState', args: [aaplc] })),
      OracleState.VALID_OPEN
    );
    console.log('PASS WAR GAME 4: B20 dividend drift (<5%), split freeze (>=5%), CorporateActionSplitPending, open repay & Guardian unfreeze verified.');

    // =========================================================================
    // WAR GAME 5 & 6: Stale-Feed Floor Buy, Restart Cap, Guardian Pause & Cooldown Drills
    // =========================================================================
    // Set up Loan #3 (50 AAPLc @ $200, $5,000 USDC), drop price to $105 (~95% LTV -> 100% collateral auction)
    const loanId3 = await mintBorrowLoan(aaplc, 50_00000000n, 5_000_000_000n);
    // Wait a tiny beat and drop price with exact multiplier accounted (~$105 -> LTV <90%? Wait: mult ~= 2.001x! Keep nominal raw price scaled!).
    // Note OracleRouter.getValue for MockB20Token divides/multiplies? Check getValue:
    // Actually we saw price * raw * multiplier OR price only (getValue uses Chainlink price directly! Let's read getValue on-chain to target exact LTV).
    const curValAt200 = (await publicClient.readContract({
      address: deployed.oracleRouter,
      abi: oracleRouterAbi,
      functionName: 'getValue',
      args: [aaplc, 50_00000000n],
    })) as [bigint, bigint, number];
    assert.ok(curValAt200[0] > 5_000_000_000n);
    // Drop AAPLc price to $105 ($5,250 gross for $5,000 loan => 95.2% LTV >= 90% badDebtLtvBps)
    await refreshFeeds(105_00000000n, 250_00000000n);
    const expectRevert = async (
      account: Address,
      to: Address,
      abi: readonly unknown[],
      functionName: string,
      args: readonly unknown[],
      pattern: RegExp
    ) => {
      await assert.rejects(
        () =>
          publicClient.simulateContract({
            account,
            address: to,
            abi,
            functionName,
            args,
          }),
        pattern
      );
    };

    const sendRawChecked = async (
      account: Address,
      to: Address,
      abi: readonly unknown[],
      functionName: string,
      args: readonly unknown[]
    ) => {
      const data = encodeFunctionData({ abi, functionName, args });
      const hash =
        account.toLowerCase() === ADDRESSES.keeper.toLowerCase()
          ? await keeperClient.sendTransaction({ to, data })
          : account.toLowerCase() === ADDRESSES.liquidator.toLowerCase()
            ? await liquidatorClient.sendTransaction({ to, data })
            : await rawWalletClient.sendTransaction({ account, to, data });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success', `Expected tx ${functionName} to succeed on ${to}`);
      return receipt;
    };

    await sendRawChecked(
      ADDRESSES.keeper,
      deployed.loanCore,
      parseAbi(['function startLiquidation(uint256)']),
      'startLiquidation',
      [loanId3]
    );
    const aucId3 = (await publicClient.readContract({
      address: deployed.loanCore,
      abi: loanCoreAbi,
      functionName: 'loanActiveAuction',
      args: [loanId3],
    })) as bigint;
    assert.ok(aucId3 > 0n, 'startLiquidation must assign non-zero aucId3');

    // Healthy VALID_OPEN emergencyCancelAuction MUST REVERT (OracleNotStaleOrFrozen)
    const emergencyCancelAbi = [
      ...liquidationAuctionAbi,
      { type: 'function', name: 'emergencyCancelAuction', stateMutability: 'nonpayable', inputs: [{ name: 'auctionId', type: 'uint256' }], outputs: [] },
    ] as const;
    await expectRevert(
      guardianSafe,
      deployed.liquidationAuction,
      emergencyCancelAbi,
      'emergencyCancelAuction',
      [aucId3],
      /OracleNotStaleOrFrozen|0x/i
    );

    // Advance 22,000s (> maxStaleOpenSecs=21,600 and > duration=1,800s, < maxFeedAge=43,200s):
    // 5A: STALE_FEED expired auction allows partial buy at floorPrice without reverting AuctionExpired!
    await advanceForkBySeconds(22_000);
    assert.equal(
      Number(await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'getOracleState', args: [aaplc] })),
      OracleState.STALE_FEED
    );
    const aucSnapStale = (await publicClient.readContract({
      address: deployed.liquidationAuction,
      abi: liquidationAuctionAbi,
      functionName: 'getAuction',
      args: [aucId3],
    })) as { floorPrice: bigint; startTime: bigint };
    const staleCurPrice = (await publicClient.readContract({
      address: deployed.liquidationAuction,
      abi: liquidationAuctionAbi,
      functionName: 'getCurrentPrice',
      args: [aucId3],
    })) as bigint;
    assert.equal(staleCurPrice, aucSnapStale.floorPrice);

    await sendRawChecked(
      ADDRESSES.liquidator,
      BASE_USDC_ADDRESS,
      erc20Abi,
      'approve',
      [deployed.liquidationAuction, 1_000_000_000n]
    );
    await sendRawChecked(
      ADDRESSES.liquidator,
      deployed.liquidationAuction,
      parseAbi(['function buy(uint256,uint128,uint128) returns (uint128)']),
      'buy',
      [aucId3, 5_00000000n, 1_000_000_000n] // Floor buy of stale expired auction
    );

    // 5B: restartOrCancelAuction within maxFeedAge (22,000s < 43,200s) restarts startTime
    await sendRawChecked(
      ADDRESSES.keeper,
      deployed.liquidationAuction,
      parseAbi(['function restartOrCancelAuction(uint256)']),
      'restartOrCancelAuction',
      [aucId3]
    );
    const aucAfterRestart = (await publicClient.readContract({
      address: deployed.liquidationAuction,
      abi: liquidationAuctionAbi,
      functionName: 'getAuction',
      args: [aucId3],
    })) as { startTime: bigint };
    assert.ok(aucAfterRestart.startTime > aucSnapStale.startTime, 'Within maxFeedAge, stale auction restart must succeed');

    // 5C: Advance another 22,500s (total feed age ~44,500s > maxFeedAge=43,200s): restartOrCancelAuction refuses restart (no-op)!
    await advanceForkBySeconds(22_500);
    await sendRawChecked(
      ADDRESSES.keeper,
      deployed.liquidationAuction,
      parseAbi(['function restartOrCancelAuction(uint256)']),
      'restartOrCancelAuction',
      [aucId3]
    );
    const aucBlockedCap = (await publicClient.readContract({
      address: deployed.liquidationAuction,
      abi: liquidationAuctionAbi,
      functionName: 'getAuction',
      args: [aucId3],
    })) as { startTime: bigint; status: number };
    assert.equal(aucBlockedCap.startTime, aucAfterRestart.startTime, 'Past maxFeedAge (2x maxStaleOpenSecs), restartOrCancelAuction must NOT restart');
    assert.equal(Number(aucBlockedCap.status), 0);

    // 6A: Guardian first emergencyCancelAuction while STALE_FEED succeeds; unauthorized caller reverts
    await expectRevert(
      ADDRESSES.keeper,
      deployed.liquidationAuction,
      emergencyCancelAbi,
      'emergencyCancelAuction',
      [aucId3],
      /UnauthorizedCaller|0x/i
    );
    await sendRawChecked(
      guardianSafe,
      deployed.liquidationAuction,
      emergencyCancelAbi,
      'emergencyCancelAuction',
      [aucId3]
    );
    assert.equal(await publicClient.readContract({ address: deployed.positionNFT, abi: positionNftAbi, functionName: 'isAuctionLocked', args: [loanId3] }), false);

    // 6B: Re-trigger liquidation on remaining Loan #3 (<3600s), Guardian freezes asset (3) & verifies GuardianCanOnlyTighten (cannot loosen to 0),
    // then immediate emergencyCancelAuction hits 1h cooldown; after +3601s, second emergencyCancelAuction succeeds!
    await refreshFeeds(105_00000000n, 250_00000000n);
    await sendRawChecked(
      ADDRESSES.keeper,
      deployed.loanCore,
      parseAbi(['function startLiquidation(uint256)']),
      'startLiquidation',
      [loanId3]
    );
    const aucId4 = (await publicClient.readContract({
      address: deployed.loanCore,
      abi: loanCoreAbi,
      functionName: 'loanActiveAuction',
      args: [loanId3],
    })) as bigint;
    assert.ok(aucId4 > 0n);

    // Guardian freezes AAPLc (status=3 Frozen); Guardian trying to loosen back to Active (0) MUST REVERT GuardianCanOnlyTighten!
    const setStatusAbi = [
      ...assetRegistryAbi,
      { type: 'function', name: 'setAssetStatus', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'status', type: 'uint8' }], outputs: [] },
    ] as const;
    await sendRawChecked(
      guardianSafe,
      deployed.assetRegistry,
      setStatusAbi,
      'setAssetStatus',
      [aaplc, 3]
    );
    await expectRevert(
      guardianSafe,
      deployed.assetRegistry,
      setStatusAbi,
      'setAssetStatus',
      [aaplc, 0],
      /GuardianCanOnlyTighten|0x/i
    );

    await expectRevert(
      guardianSafe,
      deployed.liquidationAuction,
      emergencyCancelAbi,
      'emergencyCancelAuction',
      [aucId4],
      /EmergencyCancelCooldownActive|0x/i
    );
    await advanceForkBySeconds(3605);
    await sendRawChecked(
      guardianSafe,
      deployed.liquidationAuction,
      emergencyCancelAbi,
      'emergencyCancelAuction',
      [aucId4]
    );

    // 6C: Guardian pauses LoanCore (`setPaused(true)`): new loans revert ProtocolPaused, frontend blocks origination,
    // while borrower full `repay()` on Loan #1 and Loan #3 + lender `claim()` succeed cleanly to exact zero balances!
    await sendRawChecked(
      guardianSafe,
      deployed.loanCore,
      parseAbi(['function setPaused(bool)']),
      'setPaused',
      [true]
    );
    const livePaused = await fetchLiveProtocolContractState({ cfg, tokenAddresses: [aaplc], includeLogDiscovery: false });
    assert.equal(livePaused.protocol?.paused, true);
    assert.equal(evaluateAssetOriginationStatus(livePaused.assets[0], livePaused.protocol).canOriginate, false);

    await assert.rejects(() => mintBorrowLoan(aaplc, 10_00000000n, 1_000_000_000n));

    walletProvider.setAccount(KEYS.borrower);
    await executeLoanRepay({
      address: ADDRESSES.borrower,
      loanId: loanId1,
      existingOpenSumRaw: 0n,
      autoApprove: true,
      provider: walletProvider,
      cfg,
    });
    await executeLoanRepay({
      address: ADDRESSES.borrower,
      loanId: loanId3,
      existingOpenSumRaw: 0n,
      autoApprove: true,
      provider: walletProvider,
      cfg,
    });

    walletProvider.setAccount(KEYS.lender);
    const finalClaim = await executeLoanClaim({
      address: ADDRESSES.lender,
      recipient: ADDRESSES.lender,
      provider: walletProvider,
      cfg,
    });
    assert.equal(finalClaim.remainingClaimableRaw, '0');

    // Verify clean global zero state after chaos termination
    assert.equal(
      await publicClient.readContract({ address: deployed.loanCore, abi: loanCoreAbi, functionName: 'totalOutstandingPrincipal' }),
      0n
    );
    assert.equal(
      await publicClient.readContract({ address: aaplc, abi: erc20Abi, functionName: 'balanceOf', args: [deployed.collateralEscrow] }),
      0n
    );
    assert.equal(
      await publicClient.readContract({ address: tslac, abi: erc20Abi, functionName: 'balanceOf', args: [deployed.collateralEscrow] }),
      0n
    );
    assert.equal(
      await publicClient.readContract({ address: deployed.collateralEscrow, abi: collateralEscrowAbi, functionName: 'getBalance', args: [aaplc] }),
      0n
    );
    assert.equal(
      await publicClient.readContract({ address: deployed.positionNFT, abi: positionNftAbi, functionName: 'balanceOf', args: [ADDRESSES.lender] }),
      0n
    );

    void assetRegistryAbi;

    console.log('PASS WAR GAMES 5 & 6: Stale-feed floor buy, maxFeedAge restart cap, Guardian pause/freeze/tightening, 1h emergencyCancelAuction cooldown & full exit verified.');
    console.log('\nALL M3.3 + WS4.6 MAINNET-FORK CHAOS & WAR-GAME SCENARIOS PASSED.');
  } finally {
    anvilProc.kill('SIGKILL');
  }
}

runTests().catch((err) => {
  console.error('\n[M3.3_WARGAMES] FAILED:', err);
  process.exit(1);
});
