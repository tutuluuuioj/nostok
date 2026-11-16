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
  getMissingContractAddresses,
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
  const big = BigInt(raw ?? 0n);
  const abs = big < 0n ? -big : big;
  const str = formatUnits(abs, decimals);
  const [whole, frac = ''] = str.split('.');
  const cleanFrac = frac.slice(0, maxFractionDigits).replace(/0+$/, '');
  if (abs > 0n && whole === '0' && cleanFrac === '') {
    const threshold =
      maxFractionDigits > 0 ? `0.${'0'.repeat(maxFractionDigits - 1)}1` : '1';
    return big < 0n ? `>-${threshold}` : `<${threshold}`;
  }
  const formatted = cleanFrac ? `${whole}.${cleanFrac}` : whole;
  return big < 0n ? `-${formatted}` : formatted;
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

export async function fetchJsonStrict(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const msg = parsed?.error?.message || `HTTP ${res.status} from ${url}`;
      const err = new Error(msg);
      err.status = res.status;
      err.code = parsed?.error?.code;
      throw err;
    }
    if (parsed === null) {
      throw new Error(`Invalid JSON response from ${url}`);
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

export function verifySiweChallengeParams(nonceResp, cfg, browserWindow) {
  const win =
    browserWindow !== undefined
      ? browserWindow
      : typeof window !== 'undefined' && window.location
        ? window
        : null;

  const expectedChainId = Number(cfg?.chainId ?? BASE_CHAIN_ID);
  if (Number(nonceResp.chain_id) !== expectedChainId) {
    throw new Error(
      `SIWE challenge chain_id mismatch: expected ${expectedChainId}, received ${nonceResp.chain_id}.`
    );
  }

  let parsedUri;
  try {
    parsedUri = new URL(nonceResp.uri);
  } catch {
    throw new Error('Malformed URI in SIWE nonce response.');
  }

  const expectedDomain = win?.location?.host || cfg?.siweDomain;
  if (expectedDomain && nonceResp.domain !== expectedDomain) {
    throw new Error(
      `SIWE domain mismatch: expected "${expectedDomain}", received "${nonceResp.domain}".`
    );
  }
  if (win?.location?.host && cfg?.siweDomain && cfg.siweDomain !== win.location.host) {
    throw new Error(
      `Configured VITE_SIWE_DOMAIN "${cfg.siweDomain}" does not match current host "${win.location.host}".`
    );
  }

  const expectedOrigin = win?.location?.origin || cfg?.siweOrigin;
  if (expectedOrigin && parsedUri.origin !== expectedOrigin) {
    throw new Error(
      `SIWE URI origin mismatch: expected "${expectedOrigin}", received "${parsedUri.origin}".`
    );
  }
}

/**
 * @param {{
 *   address: string,
 *   provider?: any,
 *   cfg?: any,
 *   browserWindow?: { location?: { host?: string, origin?: string } } | null
 * }} opts
 */
export async function signInWithSiwe({
  address,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  browserWindow = undefined,
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

  verifySiweChallengeParams(nonceResp, cfg, browserWindow);

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

  // Re-verify active wallet account & chain after signing in case the user switched accounts mid-prompt
  const postSignAccounts = await provider.request({ method: 'eth_accounts' });
  const activeAfterSign =
    Array.isArray(postSignAccounts) && postSignAccounts[0] && isAddress(postSignAccounts[0])
      ? getAddress(postSignAccounts[0])
      : null;
  if (!activeAfterSign || activeAfterSign.toLowerCase() !== checksummed.toLowerCase()) {
    throw new Error('Wallet account changed during SIWE signing; sign-in aborted.');
  }

  const verifyResp = await fetchJsonStrict(`${cfg.notificationsUrl}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });

  if (!verifyResp.token || !verifyResp.jti) {
    throw new Error('Notifications auth verify response missing session token.');
  }
  const verifiedAddr = getAddress(verifyResp.wallet_address ?? checksummed);
  if (verifiedAddr.toLowerCase() !== checksummed.toLowerCase()) {
    throw new Error('Verified SIWE session address mismatch; session discarded.');
  }

  return {
    walletAddress: verifiedAddr,
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

export async function fetchPaginatedApiRows(baseUrl, { limit = 100, maxPages = 10, timeoutMs = 8000 } = {}) {
  const rows = [];
  let offset = 0;
  let total = null;
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const json = await fetchJsonStrict(`${baseUrl}${sep}limit=${limit}&offset=${offset}`, {}, timeoutMs);
    const pageData = Array.isArray(json?.data) ? json.data : [];
    rows.push(...pageData);
    if (typeof json?.pagination?.total === 'number') {
      total = json.pagination.total;
    }
    const hasMore = Boolean(json?.pagination?.has_more);
    if (!hasMore || pageData.length === 0) {
      truncated = false;
      break;
    }
    if (page === maxPages - 1) {
      truncated = true;
      break;
    }
    offset =
      json.pagination?.next_cursor !== null && json.pagination?.next_cursor !== undefined
        ? Number(json.pagination.next_cursor)
        : offset + pageData.length;
  }
  return { rows, total: total ?? rows.length, truncated };
}

/**
 * @param {string} address
 * @param {{
 *   cfg?: any,
 *   publicClient?: any,
 *   attestationHex?: string,
 *   requestId?: number | null
 * }} [opts]
 */
export async function fetchWalletState(
  address,
  { cfg = getFrontendConfig(), publicClient = createProtocolPublicClient(cfg), attestationHex = '0x', requestId = null } = {}
) {
  if (!address || !isAddress(address)) {
    return null;
  }
  const wallet = getAddress(address);
  const cleanAttestation =
    typeof attestationHex === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(attestationHex.trim())
      ? attestationHex.trim()
      : '0x';

  const missingContracts = getMissingContractAddresses(cfg);
  let rpcError =
    missingContracts.length > 0
      ? `Missing required protocol contract address(es): ${missingContracts.join(', ')}`
      : '';
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
  let borrowTruncated = false;
  let lenderTruncated = false;

  // 1. Live API health, asset roster, paginated borrower loans, & paginated lender positions
  try {
    const [healthJson, assetsRes, loansRes, posRes] = await Promise.all([
      fetchJsonStrict(`${cfg.apiUrl}/health`),
      fetchPaginatedApiRows(`${cfg.apiUrl}/assets`, { limit: 100, maxPages: 5 }),
      fetchPaginatedApiRows(`${cfg.apiUrl}/loans?borrower=${wallet}`, { limit: 100, maxPages: 10 }),
      fetchPaginatedApiRows(`${cfg.apiUrl}/positions?owner=${wallet}`, { limit: 100, maxPages: 10 }),
    ]);
    apiHealth = healthJson;
    apiAssets = assetsRes.rows;
    borrowerLoans = loansRes.rows;
    lenderPositions = posRes.rows;
    borrowTruncated = loansRes.truncated;
    lenderTruncated = posRes.truncated;
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
    const readMsg = `On-chain read failed: ${formatWeb3Error(err)}`;
    rpcError = rpcError ? `${rpcError}; ${readMsg}` : readMsg;
  }

  const openBorrowCount = borrowerLoans.filter((l) => Number(l.status) < 3).length;
  const openLenderCount = lenderPositions.filter((p) => !p.is_burned).length;
  const openBorrowDisplay = borrowTruncated ? `${openBorrowCount}+` : String(openBorrowCount);
  const openLenderDisplay = lenderTruncated ? `${openLenderCount}+` : String(openLenderCount);
  const stale = Boolean(missingContracts.length > 0 || rpcError || apiError || ethBalanceRaw === null);

  return {
    requestId,
    address: wallet,
    expectedChainId: cfg.chainId || BASE_CHAIN_ID,
    rpcChainId,
    missingContracts,
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
    openBorrowDisplay,
    openLenderDisplay,
  };
}
