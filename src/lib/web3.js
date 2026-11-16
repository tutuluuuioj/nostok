import { formatUnits, getAddress, isAddress, toHex } from 'viem';
import {
  BASE_CHAIN_ID,
  DEFAULT_B20_DECIMALS,
  ETH_DECIMALS,
  USDC_DECIMALS,
  createProtocolPublicClient,
  eligibilityGateAbi,
  erc20Abi,
  getFrontendConfig,
  loanCoreAbi,
} from './contracts.js';

let injectedProviderOverride = null;

export function setInjectedProvider(provider) {
  injectedProviderOverride = provider ?? null;
}

export function getInjectedProvider() {
  if (injectedProviderOverride) return injectedProviderOverride;
  if (typeof window !== 'undefined' && window.ethereum) {
    return window.ethereum;
  }
  return null;
}

export function shortAddress(addr) {
  if (!addr || !isAddress(addr)) return 'Not connected';
  const c = getAddress(addr);
  return `${c.slice(0, 6)}…${c.slice(-4)}`;
}

export function formatTokenUnitsDisplay(raw, decimals, maxFractionDigits = 4) {
  const str = formatUnits(BigInt(raw ?? 0n), decimals);
  const [whole, frac = ''] = str.split('.');
  const cleanFrac = frac.slice(0, maxFractionDigits).replace(/0+$/, '');
  return cleanFrac ? `${whole}.${cleanFrac}` : whole;
}

export function formatWeb3Error(err) {
  if (!err) return 'Unknown error';
  const obj = typeof err === 'object' ? err : { message: String(err) };
  if (obj.code === 4001 || /user rejected|rejected the request|user denied/i.test(String(obj.message ?? ''))) {
    return 'Request rejected in wallet.';
  }
  if (typeof obj.shortMessage === 'string' && obj.shortMessage.trim().length > 0) {
    return obj.shortMessage.trim();
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function parseChainIdHex(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.startsWith('0x') ? Number.parseInt(trimmed, 16) : Number(trimmed);
  }
  return NaN;
}

export async function switchToBaseChain(provider = getInjectedProvider(), cfg = getFrontendConfig()) {
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('No EIP-1193 wallet provider available to switch network.');
  }
  const hexChainId = `0x${cfg.chainId.toString(16)}`;
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    });
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: hexChainId,
            chainName: 'Base',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [cfg.rpcUrl],
            blockExplorerUrls: ['https://basescan.org'],
          },
        ],
      });
    } else {
      throw new Error(`Unable to switch to Base (${cfg.chainId}): ${formatWeb3Error(err)}`);
    }
  }
  const actualHex = await provider.request({ method: 'eth_chainId' });
  const actualId = parseChainIdHex(actualHex);
  if (actualId !== cfg.chainId) {
    throw new Error(`Wrong network (${actualId}). Switch wallet to Base Mainnet (${cfg.chainId}).`);
  }
  return actualId;
}

export async function connectWallet(provider = getInjectedProvider(), cfg = getFrontendConfig()) {
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('No Ethereum wallet detected. Install Coinbase Wallet, MetaMask, or Rabby.');
  }
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const first = Array.isArray(accounts) && accounts.length > 0 ? accounts[0] : null;
  if (!first || !isAddress(first)) {
    throw new Error('Wallet returned no valid account.');
  }
  const address = getAddress(first);
  const rawChain = await provider.request({ method: 'eth_chainId' });
  let chainId = parseChainIdHex(rawChain);
  let wrongNetwork = chainId !== cfg.chainId;
  let error = '';

  if (wrongNetwork) {
    try {
      chainId = await switchToBaseChain(provider, cfg);
      wrongNetwork = chainId !== cfg.chainId;
    } catch (err) {
      error = formatWeb3Error(err);
    }
  }

  return { address, chainId, wrongNetwork, error };
}

export async function readConnectedAccount(provider = getInjectedProvider(), cfg = getFrontendConfig()) {
  if (!provider || typeof provider.request !== 'function') {
    return null;
  }
  const accounts = await provider.request({ method: 'eth_accounts' });
  const first = Array.isArray(accounts) && accounts.length > 0 ? accounts[0] : null;
  if (!first || !isAddress(first)) return null;
  const rawChain = await provider.request({ method: 'eth_chainId' });
  const chainId = parseChainIdHex(rawChain);
  return {
    address: getAddress(first),
    chainId,
    wrongNetwork: chainId !== cfg.chainId,
  };
}

export function formatSiweMessage(params) {
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    getAddress(params.address),
    '',
    params.statement ?? 'Authenticate with NOSTOK Notifications.',
    '',
    `URI: ${params.uri}`,
    'Version: 1',
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
    `Expiration Time: ${params.expirationTime}`,
  ].join('\n');
}

async function fetchJsonStrict(url, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Invalid JSON from ${url} (HTTP ${res.status})`);
      }
    }
    if (!res.ok) {
      const msg = parsed?.error?.message || parsed?.message || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.code = parsed?.error?.code;
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err && typeof err === 'object' && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function signInWithSiwe({
  address,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
}) {
  if (!address || !isAddress(address)) {
    throw new Error('Connect a wallet before signing in with SIWE.');
  }
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('No EIP-1193 wallet provider available to sign SIWE message.');
  }
  if (!cfg.notificationsUrl) {
    throw new Error('VITE_NOTIFICATIONS_URL is not configured.');
  }
  const rawChain = await provider.request({ method: 'eth_chainId' });
  const walletChainId = parseChainIdHex(rawChain);
  if (walletChainId !== cfg.chainId) {
    throw new Error(`Switch wallet to Base (${cfg.chainId}) before signing in.`);
  }

  const checksummed = getAddress(address);
  const nonceResp = await fetchJsonStrict(`${cfg.notificationsUrl}/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: checksummed }),
  });

  if (!nonceResp.nonce || !nonceResp.domain || !nonceResp.uri || !nonceResp.chain_id || !nonceResp.expires_at) {
    throw new Error('Malformed nonce response from notifications service.');
  }

  const message = formatSiweMessage({
    domain: nonceResp.domain,
    address: checksummed,
    uri: nonceResp.uri,
    chainId: Number(nonceResp.chain_id),
    nonce: nonceResp.nonce,
    issuedAt: new Date().toISOString(),
    expirationTime: nonceResp.expires_at,
  });

  const signature = await provider.request({
    method: 'personal_sign',
    params: [toHex(message), checksummed],
  });
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error('Wallet returned invalid SIWE signature.');
  }

  const verifyResp = await fetchJsonStrict(`${cfg.notificationsUrl}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });

  if (!verifyResp.token || !verifyResp.jti) {
    throw new Error('Notifications auth verify response missing session token.');
  }

  return {
    walletAddress: getAddress(verifyResp.wallet_address ?? checksummed),
    token: verifyResp.token,
    jti: verifyResp.jti,
    expiresAt: verifyResp.expires_at,
  };
}

export async function signOutSiwe({ token, cfg = getFrontendConfig() }) {
  if (!token || !cfg.notificationsUrl) {
    return { revoked: true };
  }
  try {
    await fetchJsonStrict(`${cfg.notificationsUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    return { revoked: true };
  } catch (err) {
    if (err && typeof err === 'object' && err.status === 401) {
      return { revoked: true };
    }
    throw err;
  }
}

export async function fetchNotificationsSessionState({ token, cfg = getFrontendConfig() }) {
  if (!token || !cfg.notificationsUrl) {
    throw new Error('Not signed in to notifications.');
  }
  const headers = { Authorization: `Bearer ${token}` };
  const [subsResp, prefsResp] = await Promise.all([
    fetchJsonStrict(`${cfg.notificationsUrl}/subscriptions`, { headers }),
    fetchJsonStrict(`${cfg.notificationsUrl}/preferences`, { headers }),
  ]);
  return {
    subscriptions: Array.isArray(subsResp.data) ? subsResp.data : [],
    preferences: prefsResp,
  };
}

export async function fetchWalletState(
  address,
  { cfg = getFrontendConfig(), publicClient = createProtocolPublicClient(cfg), attestationHex = '0x' } = {}
) {
  if (!address || !isAddress(address)) {
    return null;
  }
  const wallet = getAddress(address);
  const cleanAttestation =
    typeof attestationHex === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(attestationHex.trim())
      ? attestationHex.trim()
      : '0x';

  let rpcError = '';
  let apiError = '';
  let rpcChainId = null;
  let ethBalanceRaw = null;
  let usdcBalanceRaw = null;
  let claimableUsdcRaw = null;
  let eligibility = null;
  let collateralBalances = [];
  let apiHealth = null;
  let apiAssets = [];
  let borrowerLoans = [];
  let lenderPositions = [];

  // 1. Live API health, asset roster, borrower loans, & lender positions
  try {
    const [healthJson, assetsJson, loansJson, posJson] = await Promise.all([
      fetchJsonStrict(`${cfg.apiUrl}/health`),
      fetchJsonStrict(`${cfg.apiUrl}/assets`),
      fetchJsonStrict(`${cfg.apiUrl}/loans?borrower=${wallet}&limit=50`),
      fetchJsonStrict(`${cfg.apiUrl}/positions?owner=${wallet}&limit=50`),
    ]);
    apiHealth = healthJson;
    apiAssets = Array.isArray(assetsJson?.data) ? assetsJson.data : [];
    borrowerLoans = Array.isArray(loansJson?.data) ? loansJson.data : [];
    lenderPositions = Array.isArray(posJson?.data) ? posJson.data : [];
    if (healthJson?.status !== 'ok' || healthJson?.rpc_ok === false || healthJson?.db_ok === false) {
      apiError = `Indexer API status is ${healthJson?.status ?? 'degraded'} (lag=${healthJson?.lag_blocks ?? '?'} blocks).`;
    }
  } catch (err) {
    apiError = `API read failed: ${formatWeb3Error(err)}`;
  }

  // 2. Live on-chain reads on Base (chainId, ETH, USDC, claimable, EligibilityGate, & B20 balances)
  try {
    rpcChainId = Number(await publicClient.getChainId());
    if (rpcChainId !== cfg.chainId) {
      throw new Error(`RPC chainId mismatch: expected ${cfg.chainId}, got ${rpcChainId}`);
    }

    const reads = [
      publicClient.getBalance({ address: wallet }),
      publicClient.readContract({
        address: cfg.usdcAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet],
      }),
      cfg.contracts.loanCore
        ? publicClient.readContract({
            address: cfg.contracts.loanCore,
            abi: loanCoreAbi,
            functionName: 'getClaimable',
            args: [wallet],
          })
        : Promise.resolve(null),
    ];

    const gateAddr = cfg.contracts.eligibilityGate;
    if (gateAddr) {
      reads.push(
        publicClient.readContract({ address: gateAddr, abi: eligibilityGateAbi, functionName: 'permissionlessMode' }),
        publicClient.readContract({ address: gateAddr, abi: eligibilityGateAbi, functionName: 'isRevoked', args: [wallet] }),
        publicClient.readContract({ address: gateAddr, abi: eligibilityGateAbi, functionName: 'allowlist', args: [wallet] }),
        publicClient.readContract({
          address: gateAddr,
          abi: eligibilityGateAbi,
          functionName: 'isEligible',
          args: [wallet, cleanAttestation],
        })
      );
    }

    const [ethBal, usdcBal, claimBal, permMode, revoked, allowlisted, eligible] = await Promise.all(reads);
    ethBalanceRaw = ethBal;
    usdcBalanceRaw = usdcBal;
    claimableUsdcRaw = claimBal;
    if (gateAddr) {
      eligibility = {
        gateAddress: gateAddr,
        permissionlessMode: Boolean(permMode),
        isRevoked: Boolean(revoked),
        allowlisted: Boolean(allowlisted),
        isEligible: Boolean(eligible),
      };
    }

    if (apiAssets.length > 0) {
      collateralBalances = await Promise.all(
        apiAssets.map(async (asset) => {
          const tokenAddr = getAddress(asset.token);
          const decimals = asset.decimals !== undefined && asset.decimals !== null
            ? Number(asset.decimals)
            : Number(
                await publicClient.readContract({
                  address: tokenAddr,
                  abi: erc20Abi,
                  functionName: 'decimals',
                })
              );
          const rawBal = await publicClient.readContract({
            address: tokenAddr,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [wallet],
          });
          return {
            token: tokenAddr,
            symbol: asset.symbol ?? tokenAddr,
            decimals: Number.isInteger(decimals) ? decimals : DEFAULT_B20_DECIMALS,
            raw: rawBal.toString(),
            formatted: formatTokenUnitsDisplay(rawBal, Number.isInteger(decimals) ? decimals : DEFAULT_B20_DECIMALS, 6),
          };
        })
      );
    }
  } catch (err) {
    rpcError = `On-chain read failed: ${formatWeb3Error(err)}`;
  }

  const openBorrowCount = borrowerLoans.filter((l) => Number(l.status) < 3).length;
  const openLenderCount = lenderPositions.filter((p) => !p.is_burned).length;
  const stale = Boolean(rpcError || apiError || ethBalanceRaw === null);

  return {
    address: wallet,
    expectedChainId: cfg.chainId || BASE_CHAIN_ID,
    rpcChainId,
    stale,
    fetchedAt: new Date().toISOString(),
    rpcError,
    apiError,
    ethBalance: ethBalanceRaw !== null
      ? {
          raw: ethBalanceRaw.toString(),
          decimals: ETH_DECIMALS,
          formatted: formatTokenUnitsDisplay(ethBalanceRaw, ETH_DECIMALS, 6),
        }
      : null,
    usdcBalance: usdcBalanceRaw !== null
      ? {
          raw: usdcBalanceRaw.toString(),
          decimals: USDC_DECIMALS,
          formatted: formatTokenUnitsDisplay(usdcBalanceRaw, USDC_DECIMALS, 2),
        }
      : null,
    claimableUsdc: claimableUsdcRaw !== null
      ? {
          raw: claimableUsdcRaw.toString(),
          decimals: USDC_DECIMALS,
          formatted: formatTokenUnitsDisplay(claimableUsdcRaw, USDC_DECIMALS, 2),
        }
      : null,
    collateralBalances,
    eligibility,
    apiHealth,
    openBorrowCount,
    openLenderCount,
  };
}
