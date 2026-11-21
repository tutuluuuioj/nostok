/// <reference path="./ambient.d.ts" />
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
  zeroAddress,
  zeroHash,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { loadApiConfig } from '../api/src/config.js';
import { wrapQueryableAsReadOnly as wrapApiReadOnly } from '../api/src/db.js';
import { createApiContext, createApiServer } from '../api/src/server.js';
import { loadConfig as loadIndexerConfig } from '../indexer/src/config.js';
import { createIndexerContext, runIndexerSync } from '../indexer/src/indexer.js';
import { loadConfig as loadKeeperConfig } from '../keeper/src/config.js';
import { createKeeperContext, runKeeperCycle } from '../keeper/src/keeper.js';
import { loadNotificationsConfig } from '../notifications/src/config.js';
import { wrapIndexerQueryableAsReadOnly as wrapNotifReadOnly } from '../notifications/src/db.js';
import type { NotificationOutboundMessage } from '../notifications/src/channels.js';
import { createNotificationsContext, runNotificationsCycle } from '../notifications/src/engine.js';
import { createNotificationsServer } from '../notifications/src/server.js';
import { formatSiweMessage } from '../notifications/src/siwe.js';
import { loadRiskConfig } from '../risk/src/config.js';
import { wrapQueryableAsReadOnly as wrapRiskReadOnly } from '../risk/src/db.js';
import { createRiskContext, runRiskScan } from '../risk/src/monitor.js';
import { createRiskServer } from '../risk/src/server.js';
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  BORROW_ORDER_EIP712_TYPES,
  ORDER_SETTLEMENT_DOMAIN_NAME,
  ORDER_SETTLEMENT_DOMAIN_VERSION,
  OracleState,
  PROTOCOL_ERROR_ABI,
  collateralEscrowAbi,
  eligibilityGateAbi,
  erc20Abi,
  loanCoreAbi,
  oracleRouterAbi,
  orderSettlementAbi,
  positionNftAbi,
  setFrontendConfigOverrides,
} from '../src/lib/contracts.js';
import {
  evaluateAssetOriginationStatus,
  fetchMarketSnapshot,
  fetchMarketsAndLiveContracts,
  fetchRiskSummaryOptional,
  formatAssetOraclePrice,
} from '../src/lib/marketsApi.js';
import {
  approveUsdcForLend,
  executeLoanClaim,
  executeLoanRepay,
  fetchWalletPositionsAndClaimable,
  setCollateralAllowanceForBorrow,
} from '../src/lib/web3.js';
import { TIMELOCK_MIN_DELAY_SECS } from '../scripts/ws4_7_smoke_lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'contracts');
const FOUNDRY_BIN_DIR = process.env.FOUNDRY_BIN_DIR ?? `${process.env.HOME}/.foundry/bin`;
const ANVIL_PORT = Number(process.env.TEST_M3_3_FULLSTACK_ANVIL_PORT ?? 18553);
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

async function waitForRpcReady(rpcUrl: string, timeoutMs = 35_000): Promise<void> {
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
    console.log(`[M3.3_FULLSTACK] Starting Anvil Base fork against ${forkUrl} on port ${ANVIL_PORT}...`);
    const proc = spawn(
      `${FOUNDRY_BIN_DIR}/anvil`,
      ['--fork-url', forkUrl, '--port', String(ANVIL_PORT), '--chain-id', '8453', '--silent'],
      { env: getShellEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await waitForRpcReady(LOCAL_RPC_URL, 35_000);
      console.log('[M3.3_FULLSTACK] Anvil Base Mainnet fork ready (chainId=8453)');
      return proc;
    } catch (err) {
      proc.kill('SIGKILL');
      console.warn(`[M3.3_FULLSTACK] Fork RPC ${forkUrl} failed: ${(err as Error).message}`);
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
  console.log('[M3.3_FULLSTACK] Deploying NOSTOK protocol via DeployNostok.s.sol...');
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

async function execRealMultisigSafeTx(
  publicClient: ReturnType<typeof createPublicClient>,
  senderClient: ReturnType<typeof createWalletClient>,
  safeAddr: Address,
  signerKeys: [Hex, Hex],
  to: Address,
  data: Hex
) {
  const safeExecAbi = parseAbi([
    'function nonce() view returns (uint256)',
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
  ]);
  const nonce = (await publicClient.readContract({
    address: safeAddr,
    abi: safeExecAbi,
    functionName: 'nonce',
  })) as bigint;
  const domain = { chainId: BASE_CHAIN_ID, verifyingContract: safeAddr };
  const types = {
    SafeTx: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
  } as const;
  const msg = {
    to,
    value: 0n,
    data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce,
  } as const;
  const accounts = signerKeys
    .map((k) => privateKeyToAccount(k))
    .sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  const sigs = `0x${(
    await Promise.all(
      accounts.map((acc) =>
        acc.signTypedData({
          domain,
          types,
          primaryType: 'SafeTx',
          message: msg,
        }).then((s) => s.slice(2))
      )
    )
  ).join('')}` as Hex;

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: await senderClient.writeContract({
      address: safeAddr,
      abi: safeExecAbi,
      functionName: 'execTransaction',
      args: [
        msg.to,
        msg.value,
        msg.data,
        msg.operation,
        msg.safeTxGas,
        msg.baseGas,
        msg.gasPrice,
        msg.gasToken,
        msg.refundReceiver,
        sigs,
      ],
    }),
  });
  assert.equal(receipt.status, 'success', `2/2 Safe execTransaction to ${to} must succeed`);
  return receipt;
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
      53001n
    );
    const guardianSafe = await deployCanonicalSafeProxy(
      publicClient,
      deployerClient,
      [ADDRESSES.guardianSignerA, ADDRESSES.guardianSignerB],
      2n,
      53002n
    );

    const deployed = deployProtocolWithForge(ownerSafe, guardianSafe);
    const startBlock = await publicClient.getBlockNumber();

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
    const nvdac = await deployContract(mockB20Artifact.abi, mockB20Artifact.bytecode, [
      'NVIDIA Fullstack Chaos',
      'NVDAc',
      8,
      initMult,
    ]);
    const nvdaFeed = await deployContract(mockAggArtifact.abi, mockAggArtifact.bytecode, [8, 200_00000000n]);
    const mockSeq = await deployContract(mockSeqArtifact.abi, mockSeqArtifact.bytecode, [0n]);

    // Real 48h NostokTimelock batch signed by 2/2 Owner Safe via execTransaction (zero impersonation for Owner Safe!)
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
    const targets: Address[] = [
      deployed.loanCore,
      deployed.oracleRouter,
      deployed.oracleRouter,
      deployed.assetRegistry,
    ];
    const values: bigint[] = [0n, 0n, 0n, 0n];
    const payloads: Hex[] = [
      encodeFunctionData({
        abi: parseAbi(['function setGlobalCap(uint128)']),
        functionName: 'setGlobalCap',
        args: [20_000_000_000n],
      }),
      encodeFunctionData({
        abi: parseAbi(['function setMarketSession(bool,bool)']),
        functionName: 'setMarketSession',
        args: [true, true],
      }),
      encodeFunctionData({
        abi: parseAbi(['function setSequencerUptimeFeed(address,uint256)']),
        functionName: 'setSequencerUptimeFeed',
        args: [mockSeq, 3600n],
      }),
      encodeFunctionData({
        abi: setAssetConfigAbi,
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
            perLoanCap: 10_000_000_000n,
            assetCap: 20_000_000_000n,
            maxStaleOpenSecs: 21_600,
            status: 0,
            restricted: false,
          },
        ],
      }),
    ];
    const salt = keccak256(stringToBytes('M3_3_FULLSTACK_INIT'));
    const timelockAbi = parseAbi([
      'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
      'function executeBatch(address[],uint256[],bytes[],bytes32,bytes32)',
    ]);

    await execRealMultisigSafeTx(
      publicClient,
      keeperClient,
      ownerSafe,
      [KEYS.safeSignerA, KEYS.safeSignerB],
      deployed.nostokTimelock,
      encodeFunctionData({
        abi: timelockAbi,
        functionName: 'scheduleBatch',
        args: [targets, values, payloads, zeroHash, salt, TIMELOCK_MIN_DELAY_SECS],
      })
    );
    await rpcCall('evm_increaseTime', [Number(TIMELOCK_MIN_DELAY_SECS) + 5]);
    await rpcCall('evm_mine', []);

    const setPriceAbi = parseAbi(['function setPrice(int256)']);
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: nvdaFeed,
        data: encodeFunctionData({ abi: setPriceAbi, functionName: 'setPrice', args: [200_00000000n] }),
      }),
    });
    const postTimelockBlk = await publicClient.getBlock({ blockTag: 'latest' });
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: mockSeq,
        data: encodeFunctionData({
          abi: parseAbi(['function setStatus(int256,uint256)']),
          functionName: 'setStatus',
          args: [0n, BigInt(postTimelockBlk.timestamp) - 7200n],
        }),
      }),
    });

    await execRealMultisigSafeTx(
      publicClient,
      keeperClient,
      ownerSafe,
      [KEYS.safeSignerA, KEYS.safeSignerB],
      deployed.nostokTimelock,
      encodeFunctionData({
        abi: timelockAbi,
        functionName: 'executeBatch',
        args: [targets, values, payloads, zeroHash, salt],
      })
    );

    // Sync baseline multiplier & allowlist internal wallets via real 2/2 Owner Safe execTransaction
    await publicClient.waitForTransactionReceipt({
      hash: await keeperClient.sendTransaction({
        to: deployed.oracleRouter,
        data: encodeFunctionData({ abi: parseAbi(['function syncMultiplier(address)']), functionName: 'syncMultiplier', args: [nvdac] }),
      }),
    });
    await execRealMultisigSafeTx(
      publicClient,
      keeperClient,
      ownerSafe,
      [KEYS.safeSignerA, KEYS.safeSignerB],
      deployed.eligibilityGate,
      encodeFunctionData({
        abi: parseAbi(['function setAllowlistBatch(address[],bool)']),
        functionName: 'setAllowlistBatch',
        args: [[ADDRESSES.borrower, ADDRESSES.lender, ADDRESSES.liquidator], true],
      })
    );

    // Fund accounts
    await rpcCall('anvil_impersonateAccount', [BASE_USDC_WHALE]);
    await rpcCall('anvil_setBalance', [BASE_USDC_WHALE, '0x56bc75e2d63100000']);
    const transferUsdcAbi = parseAbi(['function transfer(address,uint256) returns (bool)']);
    for (const [to, amt] of [
      [ADDRESSES.borrower, 20_000_000_000n],
      [ADDRESSES.lender, 30_000_000_000n],
      [ADDRESSES.liquidator, 20_000_000_000n],
    ] as const) {
      await publicClient.waitForTransactionReceipt({
        hash: await rawWalletClient.sendTransaction({
          account: BASE_USDC_WHALE,
          to: BASE_USDC_ADDRESS,
          data: encodeFunctionData({ abi: transferUsdcAbi, functionName: 'transfer', args: [to, amt] }),
        }),
      });
    }
    await publicClient.waitForTransactionReceipt({
      hash: await deployerClient.sendTransaction({
        to: nvdac,
        data: encodeFunctionData({ abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [ADDRESSES.borrower, 200_00000000n] }),
      }),
    });

    // Boot ALL 5 off-chain services: indexer, api, risk, keeper, notifications
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
      rateLimitMax: 5000,
      rateLimitWindowMs: 60_000,
      maxBodyBytes: 8192,
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
      usdc: BASE_USDC_ADDRESS,
    });
    const apiCtx = await createApiContext(apiCfg, wrapApiReadOnly(idxCtx.db));
    const apiServer = createApiServer(apiCtx);
    await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
    const apiUrl = `http://127.0.0.1:${(apiServer.address() as net.AddressInfo).port}`;

    const riskCfg = loadRiskConfig({
      rpcUrl: LOCAL_RPC_URL,
      isFork: true,
      forkChainId: BASE_CHAIN_ID,
      databaseUrl: 'memory://',
      alertCooldownMs: 0,
      alertMinActiveMs: 0,
      loanCore: deployed.loanCore,
      liquidationAuction: deployed.liquidationAuction,
      collateralEscrow: deployed.collateralEscrow,
      assetRegistry: deployed.assetRegistry,
      oracleRouter: deployed.oracleRouter,
    });
    const riskCtx = await createRiskContext(
      riskCfg,
      wrapRiskReadOnly({
        query: (sql, params) => idxCtx.db.query(sql, params),
        async close() {},
      }),
    );
    const riskServer = createRiskServer(riskCtx);
    await new Promise<void>((r) => riskServer.listen(0, '127.0.0.1', r));
    const riskUrl = `http://127.0.0.1:${(riskServer.address() as net.AddressInfo).port}`;

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
      riskApiUrl: riskUrl,
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
    const capturedNotifications: NotificationOutboundMessage[] = [];
    const notifCtx = await createNotificationsContext(notifCfg, {
      indexerDbOverride: wrapNotifReadOnly({
        query: (sql, params) => idxCtx.db.query(sql, params),
        async close() {},
      }),
      transportsOverride: {
        async sendEmail(msg) { capturedNotifications.push(msg); },
        async sendTelegram(msg) { capturedNotifications.push(msg); },
        async sendWebhook(msg) { capturedNotifications.push(msg); },
      },
    });
    const notifServer = createNotificationsServer(notifCtx);
    await new Promise<void>((r) => notifServer.listen(0, '127.0.0.1', r));
    const notifUrl = `http://127.0.0.1:${(notifServer.address() as net.AddressInfo).port}`;

    const keeperCfg = loadKeeperConfig({
      rpcUrl: LOCAL_RPC_URL,
      keeperPrivateKey: KEYS.keeper,
      oracleRouter: deployed.oracleRouter,
      assetRegistry: deployed.assetRegistry,
      loanCore: deployed.loanCore,
      liquidationAuction: deployed.liquidationAuction,
      assets: [nvdac],
      dryRun: false,
      isFork: true,
      forkChainId: BASE_CHAIN_ID,
    });
    const keeperCtx = await createKeeperContext(keeperCfg);

    try {
      const cfg = {
        isProd: false,
        isFork: true,
        chainId: BASE_CHAIN_ID,
        rpcUrl: LOCAL_RPC_URL,
        apiUrl,
        riskUrl,
        notificationsUrl: notifUrl,
        siweDomain: 'app.nostok.xyz',
        siweOrigin: 'https://app.nostok.xyz',
        usdcAddress: BASE_USDC_ADDRESS,
        deployBlock: startBlock.toString(),
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

      // Register & confirm a real Telegram alert subscription for the borrower via SIWE
      const borrowerAcct = privateKeyToAccount(KEYS.borrower);
      const nonceRes = await fetch(`${notifUrl}/auth/nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: ADDRESSES.borrower }),
      });
      assert.equal(nonceRes.status, 200);
      const nonceJson = (await nonceRes.json()) as {
        nonce: string;
        domain: string;
        uri: string;
        chain_id: number;
      };
      const siweMessage = formatSiweMessage({
        domain: nonceJson.domain,
        address: ADDRESSES.borrower,
        uri: nonceJson.uri,
        chainId: nonceJson.chain_id,
        nonce: nonceJson.nonce,
        issuedAt: new Date().toISOString(),
        expirationTime: new Date(Date.now() + 600_000).toISOString(),
      });
      const siweSig = await borrowerAcct.signMessage({ message: siweMessage });
      const verifyRes = await fetch(`${notifUrl}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: siweMessage, signature: siweSig }),
      });
      assert.equal(verifyRes.status, 200);
      const { token: notifJwt } = (await verifyRes.json()) as { token: string };
      const subRes = await fetch(`${notifUrl}/subscriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${notifJwt}`,
        },
        body: JSON.stringify({ channel: 'telegram', target: '9988776655' }),
      });
      assert.equal(subRes.status, 201);
      const verifyMsg = capturedNotifications.find(
        (m) => m.alertType === 'subscription_verification' && m.wallet?.toLowerCase() === ADDRESSES.borrower.toLowerCase()
      );
      assert.ok(
        verifyMsg?.payload?.confirm_token,
        `Notifications verification message must be dispatched and captured (captured=${capturedNotifications.length})`
      );
      const confirmRes = await fetch(`${notifUrl}/subscriptions/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: String(verifyMsg.payload.confirm_token) }),
      });
      assert.equal(confirmRes.status, 200);
      const confirmJson = (await confirmRes.json()) as { verified: boolean; enabled: boolean };
      assert.equal(confirmJson.verified, true);
      assert.equal(confirmJson.enabled, true);

      let scanTimeMs = Date.now();
      const syncAllServices = async () => {
        await runIndexerSync(idxCtx);
        scanTimeMs += 3000;
        const riskSummary = await runRiskScan(riskCtx, scanTimeMs);
        await runNotificationsCycle(notifCtx, scanTimeMs);
        const [reconciled, riskHttp, riskLoansRes, marketSnap] = await Promise.all([
          fetchMarketsAndLiveContracts({ cfg }),
          fetchRiskSummaryOptional(cfg),
          fetch(`${riskUrl}/risk/loans`),
          fetchMarketSnapshot({ cfg }),
        ]);
        assert.equal(riskLoansRes.ok, true, `GET /risk/loans failed: ${riskLoansRes.status}`);
        const riskLoans = (await riskLoansRes.json()) as {
          data: Array<{ loan_id: string; loan_status: number | null; loan_status_name: string }>;
        };
        return { riskSummary, reconciled, riskHttp, riskLoans, marketSnap };
      };

      const assertZeroFrontendDesync = (reconciled: Awaited<ReturnType<typeof fetchMarketsAndLiveContracts>>) => {
        assert.equal(Boolean(reconciled.market.error), false, `API market fetch failed: ${reconciled.market.error}`);
        assert.equal(reconciled.market.stale, false, 'API market snapshot must not be stale');
        assert.equal(reconciled.market.degraded, false, 'API market snapshot must not be degraded');
        assert.equal(reconciled.onChain.ok, true, `On-chain snapshot failed: ${reconciled.onChain.error}`);
        assert.equal(reconciled.usingOnChainAssets, true, 'Frontend must verify live on-chain assets against API');
        assert.ok(
          reconciled.market.assets.some(
            (a) => a.token?.toLowerCase() === nvdac.toLowerCase() && String(a.symbol).toUpperCase() === 'NVDAC'
          ),
          `API /assets must include NVDAc (${nvdac}) instead of empty outage fallback`
        );
        assert.ok(
          reconciled.assets.some(
            (a) => a.token?.toLowerCase() === nvdac.toLowerCase() && !a.unavailable && a.source !== 'api_only'
          ),
          'Reconciled NVDAc asset must be live-verified on-chain'
        );
        assert.equal(reconciled.discrepancies.length, 0, `Frontend/API discrepancies detected: ${JSON.stringify(reconciled.discrepancies)}`);
      };

      const walletProvider = createMockEip1193Provider(KEYS.borrower);
      const settlementDomain = {
        name: ORDER_SETTLEMENT_DOMAIN_NAME,
        version: ORDER_SETTLEMENT_DOMAIN_VERSION,
        chainId: BASE_CHAIN_ID,
        verifyingContract: deployed.orderSettlement,
      };
      const origBlk = await publicClient.getBlock({ blockTag: 'latest' });
      const exp = BigInt(origBlk.timestamp) + 40n * 86_400n;
      const [bAtt, lAtt] = await Promise.all([
        mintAttestationViaContract(publicClient, deployed.eligibilityGate, ADDRESSES.borrower, exp),
        mintAttestationViaContract(publicClient, deployed.eligibilityGate, ADDRESSES.lender, exp),
      ]);
      const order = {
        borrower: ADDRESSES.borrower,
        collateralToken: nvdac,
        collateralAmount: 50_00000000n, // 50 NVDAc @ $200 = $10,000
        minUsdc: 5_000_000_000n, // $5,000 (50% LTV)
        maxRateBps: 900,
        termDays: 30,
        maxLtvBps: 6000,
        minFill: 500_000_000n,
        expiry: exp,
        nonce: 0n,
        yieldMode: 0,
        allowInKindSettlement: false,
      };
      const borrowSig = await privateKeyToAccount(KEYS.borrower).signTypedData({
        domain: settlementDomain,
        types: BORROW_ORDER_EIP712_TYPES,
        primaryType: 'BorrowOrder',
        message: order,
      });
      walletProvider.setAccount(KEYS.borrower);
      await setCollateralAllowanceForBorrow({
        address: ADDRESSES.borrower,
        collateralToken: nvdac,
        targetAllowanceRaw: 100_00000000n,
        provider: walletProvider,
        cfg,
      });
      walletProvider.setAccount(KEYS.lender);
      await approveUsdcForLend({
        address: ADDRESSES.lender,
        requiredUsdcRaw: 10_000_000_000n,
        provider: walletProvider,
        cfg,
      });
      await publicClient.waitForTransactionReceipt({
        hash: await lenderClient.writeContract({
          address: deployed.orderSettlement,
          abi: [...orderSettlementAbi, ...PROTOCOL_ERROR_ABI],
          functionName: 'fillBorrowOrderWithAttestations',
          args: [order, borrowSig, 5_000_000_000n, bAtt, lAtt],
        }),
      });
      const loanId = 1n;

      const initSync = await syncAllServices();
      assertZeroFrontendDesync(initSync.reconciled);
      assert.equal(initSync.riskSummary.loan_counts.healthy, 1);
      assert.equal(initSync.riskHttp?.data?.loan_counts?.healthy, 1);

      // =======================================================================
      // FULLSTACK WAR GAME A: Autonomous Keeper Dividend Sync vs Split Freeze
      // =======================================================================
      const setMultAbi = parseAbi(['function setUIMultiplier(uint256)']);
      const driftMult = (initMult * 10_200n) / 10_000n; // +2% (<5% permissionless sync)
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.sendTransaction({
          to: nvdac,
          data: encodeFunctionData({ abi: setMultAbi, functionName: 'setUIMultiplier', args: [driftMult] }),
        }),
      });
      await runKeeperCycle(keeperCtx);
      assert.equal(
        await publicClient.readContract({ address: deployed.oracleRouter, abi: oracleRouterAbi, functionName: 'recordedMultiplier', args: [nvdac] }),
        driftMult,
        'Autonomous keeper must sync <5% dividend drift on-chain'
      );
      const afterDrift = await syncAllServices();
      assertZeroFrontendDesync(afterDrift.reconciled);
      assert.equal(afterDrift.reconciled.assets[0].oracle?.state, OracleState.VALID_OPEN);

      // Jump multiplier 2x (>=5% split): keeper must emit FROZEN_SPLIT alert without crashing; API/Risk/UI align on FROZEN_CORPORATE_ACTION
      const splitMult = driftMult * 2n;
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.sendTransaction({
          to: nvdac,
          data: encodeFunctionData({ abi: setMultAbi, functionName: 'setUIMultiplier', args: [splitMult] }),
        }),
      });
      const splitKeeperSummary = await runKeeperCycle(keeperCtx);
      assert.ok(splitKeeperSummary.alertsEmitted.some((a) => a.type === 'FROZEN_SPLIT'));
      const duringSplit = await syncAllServices();
      assertZeroFrontendDesync(duringSplit.reconciled);
      const nvdaSplitUi = duringSplit.reconciled.assets[0];
      assert.equal(nvdaSplitUi.oracle?.state, OracleState.FROZEN_CORPORATE_ACTION);
      assert.equal(formatAssetOraclePrice(nvdaSplitUi.oracle), 'n/a');
      assert.equal(evaluateAssetOriginationStatus(nvdaSplitUi, duringSplit.reconciled.onChain.protocol).canOriginate, false);
      assert.ok(
        capturedNotifications.some(
          (m) =>
            m.alertType === 'asset_frozen_or_corporate_action' &&
            m.channel === 'telegram' &&
            m.wallet?.toLowerCase() === ADDRESSES.borrower.toLowerCase()
        ),
        'Notifications must dispatch asset_frozen_or_corporate_action Telegram alert on >=5% split'
      );

      // Real 2/2 Guardian Safe unfreeze via execTransaction
      await execRealMultisigSafeTx(
        publicClient,
        keeperClient,
        guardianSafe,
        [KEYS.guardianSignerA, KEYS.guardianSignerB],
        deployed.oracleRouter,
        encodeFunctionData({ abi: parseAbi(['function syncMultiplier(address)']), functionName: 'syncMultiplier', args: [nvdac] })
      );
      await runKeeperCycle(keeperCtx);
      const postSplitRecovery = await syncAllServices();
      assertZeroFrontendDesync(postSplitRecovery.reconciled);
      assert.equal(postSplitRecovery.reconciled.assets[0].oracle?.state, OracleState.VALID_OPEN);
      console.log('PASS FULLSTACK WAR GAME A: Autonomous keeper dividend sync, >=5% split freeze alert, Guardian 2/2 Safe unfreeze & 0 UI/API discrepancies verified.');

      // =======================================================================
      // FULLSTACK WAR GAME B: Flash Crash -> Autonomous Keeper startLiquidation & Recovery Cancel -> Positions/API/Risk Sync
      // =======================================================================
      const refreshFeed = async (usd8: bigint) => {
        await publicClient.waitForTransactionReceipt({
          hash: await deployerClient.sendTransaction({
            to: nvdaFeed,
            data: encodeFunctionData({ abi: setPriceAbi, functionName: 'setPrice', args: [usd8] }),
          }),
        });
      };

      await refreshFeed(120_00000000n); // $120 => 83.3% LTV (>=78% liqLtvBps, <90% badDebtLtvBps)
      const crashKeeperRun = await runKeeperCycle(keeperCtx);
      assert.ok(
        crashKeeperRun.liquidationResults.some((r) => /startLiquidation/i.test(r.action) && r.executed && r.receipt?.status === 'success'),
        'Keeper must auto-liquidate breached loan'
      );

      const duringAuctionSync = await syncAllServices();
      assertZeroFrontendDesync(duringAuctionSync.reconciled);
      assert.equal(duringAuctionSync.marketSnap.auctions.filter((a) => Number(a.status) === 0).length, 1);
      const riskLoanAuction = duringAuctionSync.riskLoans.data.find((l) => String(l.loan_id) === '1');
      assert.equal(riskLoanAuction?.loan_status, 2, 'Risk /risk/loans must report Loan #1 in Auction (2)');
      assert.equal(riskLoanAuction?.loan_status_name, 'Auction');
      assert.ok(
        capturedNotifications.some(
          (m) =>
            m.alertType === 'liquidation_started' &&
            m.channel === 'telegram' &&
            m.wallet?.toLowerCase() === ADDRESSES.borrower.toLowerCase()
        ),
        'Notifications must dispatch liquidation_started Telegram alert when Auction #1 starts'
      );
      const lenderPosAuction = await fetchWalletPositionsAndClaimable({ address: ADDRESSES.lender, cfg });
      assert.equal(lenderPosAuction.positions.length, 1);
      assert.equal(lenderPosAuction.positions[0].auctionLocked, true);
      assert.equal(lenderPosAuction.positions[0].statusName, 'Auction');

      // Price bounces back to $200 + 1805s auction expiry -> autonomous keeper calls restartOrCancelAuction & restores Active
      await refreshFeed(200_00000000n);
      await rpcCall('evm_increaseTime', [1805]);
      await rpcCall('evm_mine', []);
      await refreshFeed(200_00000000n);
      const recoveryKeeperRun = await runKeeperCycle(keeperCtx);
      assert.ok(
        recoveryKeeperRun.expiredAuctionResults.some(
          (r) => /restartOrCancelAuction/i.test(r.action) && r.executed && r.receipt?.status === 'success'
        )
      );

      const postCancelSync = await syncAllServices();
      assertZeroFrontendDesync(postCancelSync.reconciled);
      assert.equal(postCancelSync.marketSnap.auctions.filter((a) => Number(a.status) === 0).length, 0);
      const riskLoanRestored = postCancelSync.riskLoans.data.find((l) => String(l.loan_id) === '1');
      assert.equal(riskLoanRestored?.loan_status, 0, 'Risk /risk/loans must restore Loan #1 to Active (0) after auction cancel');
      assert.equal(riskLoanRestored?.loan_status_name, 'Active');
      assert.ok(
        capturedNotifications.some(
          (m) =>
            m.alertType === 'auction_cancelled' &&
            m.channel === 'telegram' &&
            m.wallet?.toLowerCase() === ADDRESSES.borrower.toLowerCase()
        ),
        'Notifications must dispatch auction_cancelled Telegram alert after recovery cancel'
      );
      const lenderPosRestored = await fetchWalletPositionsAndClaimable({ address: ADDRESSES.lender, cfg });
      assert.equal(lenderPosRestored.positions[0].auctionLocked, false);
      assert.equal(lenderPosRestored.positions[0].statusName, 'Active');
      console.log('PASS FULLSTACK WAR GAME B: Keeper auto-liquidation, live Positions/API/Risk/Notifications Auction lock, recovery cancel & unlock parity verified.');

      // =======================================================================
      // FULLSTACK WAR GAME C: Sequencer Outage + Stale Feed Restart/Cap Across Full Stack
      // =======================================================================
      const seqPreBlk = await publicClient.getBlock({ blockTag: 'latest' });
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.sendTransaction({
          to: mockSeq,
          data: encodeFunctionData({ abi: parseAbi(['function setStatus(int256,uint256)']), functionName: 'setStatus', args: [1n, BigInt(seqPreBlk.timestamp)] }),
        }),
      });
      await runKeeperCycle(keeperCtx);
      const seqDownSync = await syncAllServices();
      assertZeroFrontendDesync(seqDownSync.reconciled);
      assert.equal(seqDownSync.reconciled.assets[0].oracle?.state, OracleState.INVALID_SEQUENCER);
      assert.equal(seqDownSync.reconciled.onChain.protocol?.sequencerValid, false);

      // Quote API also rejects origination while sequencer is down
      const seqQuoteRes = await fetch(`${apiUrl}/quote?asset=${nvdac}&principal=${5_000_000_000}&term_days=30&apr_bps=800`);
      const seqQuoteBody = (await seqQuoteRes.json()) as { accepted: boolean; rejection_reasons?: Array<{ code: string }> };
      assert.equal(seqQuoteBody.accepted, false);
      assert.ok(seqQuoteBody.rejection_reasons?.some((r) => r.code === 'ORACLE_INVALID'));

      // Restore sequencer + advance past 1h grace window, then drop price ($105 -> 95% LTV), keeper starts Auction #2
      const recBlk = await publicClient.getBlock({ blockTag: 'latest' });
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.sendTransaction({
          to: mockSeq,
          data: encodeFunctionData({ abi: parseAbi(['function setStatus(int256,uint256)']), functionName: 'setStatus', args: [0n, BigInt(recBlk.timestamp)] }),
        }),
      });
      await rpcCall('evm_increaseTime', [3605]);
      await rpcCall('evm_mine', []);
      await refreshFeed(105_00000000n);
      const crash2KeeperRun = await runKeeperCycle(keeperCtx);
      assert.ok(
        crash2KeeperRun.liquidationResults.some((r) => /startLiquidation/i.test(r.action) && r.executed && r.receipt?.status === 'success'),
        'Keeper must start Auction #2 after $105 price drop'
      );
      const auc2Sync = await syncAllServices();
      assertZeroFrontendDesync(auc2Sync.reconciled);
      assert.ok(
        auc2Sync.marketSnap.auctions.some((a) => String(a.auction_id) === '2' && Number(a.status) === 0),
        'API /auctions must report Auction #2 active (0)'
      );
      assert.equal(auc2Sync.riskLoans.data.find((l) => String(l.loan_id) === '1')?.loan_status, 2);

      // Let feed become STALE_FEED (22,000s > 21,600s) & expired auction (>1,800s): floor buy allowed while keeper restarts & emits STALE_FEED alert!
      await rpcCall('evm_increaseTime', [22_000]);
      await rpcCall('evm_mine', []);
      const staleKeeperRun = await runKeeperCycle(keeperCtx);
      assert.ok(staleKeeperRun.alertsEmitted.some((a) => a.type === 'STALE_FEED'));
      assert.ok(
        staleKeeperRun.expiredAuctionResults.some(
          (r) => /restartOrCancelAuction/i.test(r.action) && r.executed && r.receipt?.status === 'success'
        )
      );

      // Advance past maxFeedAge (>43,200s total age): keeper must NOT submit futile restartOrCancelAuction
      await rpcCall('evm_increaseTime', [22_500]);
      await rpcCall('evm_mine', []);
      const capKeeperRun = await runKeeperCycle(keeperCtx);
      assert.equal(
        capKeeperRun.expiredAuctionResults.some((r) => /restartOrCancelAuction/i.test(r.action)),
        false
      );
      console.log('PASS FULLSTACK WAR GAME C: Sequencer outage /quote rejection, stale keeper alerts & maxFeedAge cap verified.');

      // =======================================================================
      // FULLSTACK WAR GAME D: Real 2/2 Guardian Safe Pause & Complete Unwind Convergence
      // =======================================================================
      await execRealMultisigSafeTx(
        publicClient,
        keeperClient,
        guardianSafe,
        [KEYS.guardianSignerA, KEYS.guardianSignerB],
        deployed.loanCore,
        encodeFunctionData({ abi: parseAbi(['function setPaused(bool)']), functionName: 'setPaused', args: [true] })
      );
      await syncAllServices();

      // Guardian cancels stale active auction via real 2/2 Safe execTransaction -> Loan #1 restores Active/Grace while paused
      await execRealMultisigSafeTx(
        publicClient,
        keeperClient,
        guardianSafe,
        [KEYS.guardianSignerA, KEYS.guardianSignerB],
        deployed.liquidationAuction,
        encodeFunctionData({ abi: parseAbi(['function emergencyCancelAuction(uint256)']), functionName: 'emergencyCancelAuction', args: [2n] })
      );

      // Full repay & claim while LoanCore is paused
      walletProvider.setAccount(KEYS.borrower);
      await executeLoanRepay({
        address: ADDRESSES.borrower,
        loanId,
        existingOpenSumRaw: 0n,
        autoApprove: true,
        provider: walletProvider,
        cfg,
      });
      walletProvider.setAccount(KEYS.lender);
      const claimFinal = await executeLoanClaim({
        address: ADDRESSES.lender,
        recipient: ADDRESSES.lender,
        provider: walletProvider,
        cfg,
      });
      assert.equal(claimFinal.remainingClaimableRaw, '0');

      const finalSync = await syncAllServices();
      assertZeroFrontendDesync(finalSync.reconciled);
      assert.equal(finalSync.reconciled.onChain.protocol?.paused, true);
      assert.equal(finalSync.riskSummary.protocol_paused, true);
      assert.equal(finalSync.reconciled.onChain.protocol?.totalOutstandingPrincipal?.raw, '0');
      assert.equal(finalSync.marketSnap.loans.filter((l) => Number(l.status) <= 2).length, 0, 'Zero Active/Grace/Auction loans remain after full unwind');
      assert.equal(Number(finalSync.marketSnap.loans.find((l) => String(l.loan_id) === '1')?.status), 3, 'Loan #1 status must be Repaid (3)');
      assert.equal(finalSync.marketSnap.auctions.filter((a) => Number(a.status) === 0).length, 0);
      assert.equal(
        await publicClient.readContract({ address: deployed.collateralEscrow, abi: collateralEscrowAbi, functionName: 'getBalance', args: [nvdac] }),
        0n
      );
      const finalPositions = await fetchWalletPositionsAndClaimable({ address: ADDRESSES.lender, cfg });
      assert.equal(finalPositions.nftBalanceCount, 0);
      assert.equal(finalPositions.positions.length, 0);
      assert.equal(finalPositions.claimableRaw, '0');
      void liquidatorClient;

      console.log('PASS FULLSTACK WAR GAME D: 2/2 Guardian Safe pause/emergencyCancel, paused repay/claim unwind & zero final desync across Indexer/API/Risk/Keeper/Notifications/Frontend verified.');
      console.log('\nALL M3.3 PIECE 2 FULL-STACK CHAOS & WAR-GAME SCENARIOS PASSED.');
    } finally {
      await new Promise<void>((r) => notifServer.close(() => r()));
      await new Promise<void>((r) => riskServer.close(() => r()));
      await new Promise<void>((r) => apiServer.close(() => r()));
      await notifCtx.notifDb.close();
      await notifCtx.indexerDb.close();
      await riskCtx.db.close();
      await idxCtx.db.close();
    }
  } finally {
    anvilProc.kill('SIGKILL');
  }
}

runTests().catch((err) => {
  console.error('\n[M3.3_FULLSTACK] FAILED:', err);
  process.exit(1);
});
