import {
  decodeErrorResult,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  recoverAddress,
  stringToBytes,
  toHex,
  zeroAddress,
} from 'viem';
import {
  BASE_CHAIN_ID,
  BORROW_ORDER_EIP712_TYPES,
  DEFAULT_B20_DECIMALS,
  ETH_DECIMALS,
  LEND_OFFER_EIP712_TYPES,
  ORDER_SETTLEMENT_DOMAIN_NAME,
  ORDER_SETTLEMENT_DOMAIN_VERSION,
  PROTOCOL_ERROR_ABI,
  USDC_DECIMALS,
  createProtocolPublicClient,
  eligibilityGateAbi,
  erc20Abi,
  getFrontendConfig,
  getMissingContractAddresses,
  loanCoreAbi,
  orderSettlementAbi,
  positionNftAbi,
} from './contracts.js';

export const DEFAULT_COLLATERAL_BUFFER_BPS = 500; // +5.00% default buffer for partial fills & price ticks
export const MAX_COLLATERAL_BUFFER_BPS = 5000;
export const SIGNED_BORROW_ORDERS_STORAGE_KEY = 'nostok-signed-borrow-orders-v1';
export const SIGNED_LEND_OFFERS_STORAGE_KEY = 'nostok-signed-lend-offers-v1';

const REVERT_EXPLANATIONS = {
  Unauthorized: 'Caller is not authorized to perform this order action.',
  UnauthorizedCaller: 'Caller is not authorized to call this protocol contract.',
  ZeroAddress: 'Unexpected zero address parameter.',
  OrderExpired: 'Order expiry timestamp has already passed on-chain.',
  OrderCancelledAlready: 'Order has already been cancelled on-chain.',
  InvalidNonce: 'Order nonce is stale — maker called bumpNonce() to invalidate earlier orders.',
  InvalidSignature: 'EIP-712 signature does not match the order maker address.',
  FillAmountTooLow: 'Requested fill USDC is below the order minFill threshold (unless filling remaining).',
  OrderExceeded: 'Requested fill USDC exceeds the remaining unfilled amount on this order.',
  IneligibleCounterparty: 'Borrower or lender failed on-chain EligibilityGate verification.',
  CollateralMismatch: 'Selected collateral token is not accepted by this LendOffer.',
  ProtocolPaused: 'LoanCore protocol is currently paused.',
  GlobalCapExceeded: 'Fill would exceed protocol global USDC origination cap.',
  PerLoanCapExceeded: 'Fill would exceed the per-loan USDC cap for this collateral asset.',
  AssetCapExceeded: 'Fill would exceed the asset total USDC origination cap.',
  AssetNotActive: 'Collateral asset status is not Active for new loans.',
  OracleInvalidForAction: 'Oracle price feed state disallows this action (closed market, frozen, stale, or disputed).',
  LtvExceeded: 'Initial LTV exceeds maximum allowed LTV at current oracle price and collateral amount.',
  InvalidLoanTerms: 'Requested loan terms (rate, duration, or principal < $500 minimum) violate LoanCore rules.',
  InsufficientPayment: 'Payment or USDC transfer amount is insufficient.',
  ERC20InsufficientAllowance: 'Token allowance granted to the protocol contract is below the required amount.',
  ERC20InsufficientBalance: 'Wallet token balance is below the required amount.',
  ECDSAInvalidSignature: 'Malformed ECDSA signature.',
  ECDSAInvalidSignatureLength: 'Invalid ECDSA signature length.',
  ECDSAInvalidSignatureS: 'Invalid ECDSA signature s value.',
};

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

const ERROR_SELECTOR_BY_HASH = new Map(
  PROTOCOL_ERROR_ABI.map((item) => {
    const sig = `${item.name}(${(item.inputs ?? []).map((i) => i.type).join(',')})`;
    const selector = keccak256(stringToBytes(sig)).slice(0, 10).toLowerCase();
    return [selector, item.name];
  })
);

function extractRevertHexData(err) {
  const seen = new Set();
  const stack = [err];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);

    for (const candidate of [cur.data, cur.raw, cur.revertData]) {
      if (typeof candidate === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(candidate)) {
        return candidate;
      }
      if (candidate && typeof candidate === 'object') {
        stack.push(candidate);
      }
    }

    for (const textField of [cur.details, cur.shortMessage, cur.message]) {
      if (typeof textField !== 'string') continue;
      // Viem formats custom errors with arguments as: "custom error 0x<8hex>: <argsHex>"
      const customPair = textField.match(/custom error\s+(0x[0-9a-fA-F]{8}):\s*([0-9a-fA-F]+)/i);
      if (customPair) {
        return `${customPair[1]}${customPair[2]}`;
      }
      // Match 4-byte selectors (10 chars) or longer ABI-encoded error payloads, ignoring 32-byte tx hashes (66 chars).
      const matches = textField.match(/0x[0-9a-fA-F]{8,}/g) ?? [];
      for (const hex of matches) {
        if (hex.length !== 66) return hex;
      }
    }

    if (cur.cause) stack.push(cur.cause);
  }
  return null;
}

export function decodeContractRevert(err) {
  const hexData = extractRevertHexData(err);
  if (!hexData) return null;
  const selector = hexData.slice(0, 10).toLowerCase();
  try {
    const decoded = decodeErrorResult({
      abi: PROTOCOL_ERROR_ABI,
      data: /** @type {`0x${string}`} */ (hexData),
    });
    const detail = REVERT_EXPLANATIONS[decoded.errorName] || '';
    const argsStr =
      decoded.args && decoded.args.length > 0
        ? `(${decoded.args.map((a) => String(a)).join(', ')})`
        : '()';
    return {
      errorName: decoded.errorName,
      args: decoded.args ?? [],
      selector,
      message: detail ? `${decoded.errorName}${argsStr}: ${detail}` : `${decoded.errorName}${argsStr}`,
    };
  } catch {
    const fallbackName = ERROR_SELECTOR_BY_HASH.get(selector);
    if (!fallbackName) return null;
    const detail = REVERT_EXPLANATIONS[fallbackName] || '';
    return {
      errorName: fallbackName,
      args: [],
      selector,
      message: detail ? `${fallbackName}(): ${detail}` : `${fallbackName}()`,
    };
  }
}

export function formatWeb3Error(err) {
  if (!err) return 'Unknown error';
  const obj = typeof err === 'object' ? err : { message: String(err) };
  if (obj.code === 4001 || /user rejected|rejected the request|user denied/i.test(String(obj.message ?? ''))) {
    return 'Request rejected in wallet.';
  }
  const decoded = decodeContractRevert(err);
  if (decoded) {
    return decoded.message;
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

export async function fetchJsonStrict(url, options = {}, timeoutMs = 8000, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...options, signal: controller.signal });
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

/**
 * @param {string} baseUrl
 * @param {{
 *   limit?: number,
 *   maxPages?: number,
 *   timeoutMs?: number,
 *   cfg?: any
 * }} [opts]
 */
export async function fetchPaginatedApiRows(
  baseUrl,
  { limit = 100, maxPages = 10, timeoutMs = 8000, cfg = null } = {}
) {
  const resolvedBase =
    baseUrl.startsWith('/') && cfg?.apiUrl ? `${cfg.apiUrl}${baseUrl}` : baseUrl;
  const rows = [];
  let offset = 0;
  let total = null;
  let truncated = false;
  let stale = false;
  let firstJson = null;
  for (let page = 0; page < maxPages; page++) {
    const sep = resolvedBase.includes('?') ? '&' : '?';
    const json = await fetchJsonStrict(`${resolvedBase}${sep}limit=${limit}&offset=${offset}`, {}, timeoutMs);
    if (!firstJson && json && typeof json === 'object') {
      firstJson = json;
    }
    if (json?.stale === true || json?.relay_stale === true) {
      stale = true;
    }
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
  return { rows, total: total ?? rows.length, truncated, fees: firstJson?.fees ?? null, stale };
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

/**
 * @param {{
 *   cfg?: any,
 *   asset: string,
 *   principalRaw?: string | null,
 *   collateralAmountRaw?: string | null,
 *   termDays: number,
 *   aprBps: number,
 *   maxLtvBps?: number | string | null,
 *   borrower?: string | null,
 *   lender?: string | null,
 *   borrowerAttestation?: string | null,
 *   lenderAttestation?: string | null
 * }} opts
 */
export async function fetchLoanQuote({
  cfg = getFrontendConfig(),
  asset,
  principalRaw,
  collateralAmountRaw,
  termDays,
  aprBps,
  maxLtvBps,
  borrower,
  lender,
  borrowerAttestation,
  lenderAttestation,
}) {
  if (!cfg?.apiUrl) {
    throw new Error('VITE_API_URL is not configured.');
  }
  if (!asset || !isAddress(asset)) {
    throw new Error('Select a valid registered collateral asset.');
  }
  if (!principalRaw && !collateralAmountRaw) {
    throw new Error('Enter either a USDC principal amount or a collateral token amount.');
  }

  const params = new URLSearchParams();
  params.set('asset', getAddress(asset));
  if (principalRaw) params.set('principal', String(principalRaw));
  if (collateralAmountRaw) params.set('collateral_amount', String(collateralAmountRaw));
  params.set('term_days', String(termDays));
  params.set('apr_bps', String(aprBps));
  if (maxLtvBps !== undefined && maxLtvBps !== null && maxLtvBps !== '') {
    params.set('max_ltv_bps', String(maxLtvBps));
  }
  if (borrower && isAddress(borrower)) {
    params.set('borrower', getAddress(borrower));
  }
  if (lender && isAddress(lender)) {
    params.set('lender', getAddress(lender));
  }
  if (borrowerAttestation && /^0x([0-9a-fA-F]{2})+$/.test(borrowerAttestation.trim())) {
    params.set('borrower_attestation', borrowerAttestation.trim());
  }
  if (lenderAttestation && /^0x([0-9a-fA-F]{2})+$/.test(lenderAttestation.trim())) {
    params.set('lender_attestation', lenderAttestation.trim());
  }

  return fetchJsonStrict(`${cfg.apiUrl}/quote?${params.toString()}`);
}

/**
 * Extracts exact/rounded-up raw base-unit integer amounts from an api/ quote response.
 * Defaults collateralAmountRaw to bufferedCollateralRaw (+5.00% / 500 bps by default) so
 * partial fills and minor oracle price ticks do not revert LtvExceeded on-chain.
 * Never parses floored UI display strings for transaction or EIP-712 payload values.
 */
/**
 * Computes the ERC-20 allowance required on CollateralEscrow so multi-fill
 * settlement never reverts with ERC20InsufficientAllowance due to per-fill
 * pro-rata collateral ceiling rounding (`ceil(collateralAmount * fillUsdc / minUsdc)`).
 */
export function computeBorrowApprovalAmountRaw(
  collateralAmountRaw,
  principalRaw,
  minFillRaw = null,
  { existingOpenCollateralRaw = 0n, perFillUsdcRawList = null } = {}
) {
  const signedCollateralRaw = BigInt(collateralAmountRaw);
  const totalUsdcRaw = BigInt(principalRaw);
  const existingOpen = BigInt(existingOpenCollateralRaw ?? 0n);
  if (signedCollateralRaw <= 0n || totalUsdcRaw <= 0n || existingOpen < 0n) {
    throw new Error('Collateral and principal raw amounts must be positive.');
  }
  const MIN_PROTOCOL_FILL_USDC = 500_000_000n;
  const hasMinFill =
    minFillRaw !== null && minFillRaw !== undefined && String(minFillRaw).trim() !== '';
  const parsedMinFill = hasMinFill ? BigInt(minFillRaw) : totalUsdcRaw;
  if (parsedMinFill <= 0n) {
    throw new Error('Minimum fill raw amount must be positive.');
  }
  const flooredMinFill =
    parsedMinFill < MIN_PROTOCOL_FILL_USDC ? MIN_PROTOCOL_FILL_USDC : parsedMinFill;
  const effectiveMinFill = flooredMinFill > totalUsdcRaw ? totalUsdcRaw : flooredMinFill;
  const maxFills = (totalUsdcRaw + effectiveMinFill - 1n) / effectiveMinFill;

  let plannedPerFillCollateralSum = 0n;
  if (Array.isArray(perFillUsdcRawList) && perFillUsdcRawList.length > 0) {
    const validChunks = validateLendPartialFillPlan(perFillUsdcRawList, totalUsdcRaw, effectiveMinFill);
    for (const chunk of validChunks) {
      plannedPerFillCollateralSum += computeBorrowCollateralForFill(
        signedCollateralRaw,
        totalUsdcRaw,
        chunk
      );
    }
  }

  const baseOrderRequirement = signedCollateralRaw + maxFills;
  const orderRequirement =
    plannedPerFillCollateralSum > baseOrderRequirement
      ? plannedPerFillCollateralSum
      : baseOrderRequirement;
  const approvalSlackRaw = orderRequirement - signedCollateralRaw;

  return {
    signedCollateralRaw,
    maxFills,
    approvalSlackRaw,
    plannedPerFillCollateralSum,
    existingOpenCollateralRaw: existingOpen,
    requiredApprovalRaw: existingOpen + orderRequirement,
  };
}

export function resolveExactBorrowAmounts(
  quote,
  {
    userCollateralRaw = null,
    bufferBps = DEFAULT_COLLATERAL_BUFFER_BPS,
    minFillRaw = null,
    existingOpenCollateralRaw = 0n,
    perFillUsdcRawList = null,
  } = {}
) {
  if (!quote?.amounts?.principal?.raw || !quote?.amounts?.collateral_required?.raw) {
    throw new Error('Quote response is missing exact raw principal or collateral_required amounts.');
  }
  const cleanBufferBps = Number(bufferBps ?? DEFAULT_COLLATERAL_BUFFER_BPS);
  if (!Number.isInteger(cleanBufferBps) || cleanBufferBps < 0 || cleanBufferBps > MAX_COLLATERAL_BUFFER_BPS) {
    throw new Error(`Collateral buffer must be between 0 and ${MAX_COLLATERAL_BUFFER_BPS} bps (0%–50%).`);
  }

  const principalRaw = BigInt(quote.amounts.principal.raw);
  const minRequiredCollateralRaw = BigInt(quote.amounts.collateral_required.raw);
  const bufferedCollateralRaw =
    (minRequiredCollateralRaw * BigInt(10_000 + cleanBufferBps) + 9999n) / 10_000n;
  let collateralAmountRaw = bufferedCollateralRaw;

  if (userCollateralRaw !== null && userCollateralRaw !== undefined && String(userCollateralRaw).trim() !== '') {
    const provided = BigInt(userCollateralRaw);
    if (provided < minRequiredCollateralRaw) {
      throw new Error(
        `Collateral raw amount (${provided}) is below API rounded-up minimum (${minRequiredCollateralRaw}).`
      );
    }
    collateralAmountRaw = provided;
  }

  const approvalSizing = computeBorrowApprovalAmountRaw(
    collateralAmountRaw,
    principalRaw,
    minFillRaw,
    { existingOpenCollateralRaw, perFillUsdcRawList }
  );

  return {
    principalRaw,
    minRequiredCollateralRaw,
    bufferedCollateralRaw,
    bufferBps: cleanBufferBps,
    collateralAmountRaw,
    maxFills: approvalSizing.maxFills,
    approvalSlackRaw: approvalSizing.approvalSlackRaw,
    existingOpenCollateralRaw: approvalSizing.existingOpenCollateralRaw,
    requiredApprovalRaw: approvalSizing.requiredApprovalRaw,
    originationFeeRaw: BigInt(quote.amounts.origination_fee?.raw ?? 0n),
    netProceedsRaw: BigInt(quote.amounts.net_proceeds?.raw ?? 0n),
    interestMaturityRaw: BigInt(quote.amounts.interest_maturity?.raw ?? 0n),
    totalRepaymentAtMaturityRaw: BigInt(quote.amounts.total_repayment_at_maturity?.raw ?? 0n),
  };
}

async function assertActiveWalletAndChain(provider, expectedAddress, expectedChainId) {
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('No EIP-1193 wallet provider available.');
  }
  if (!expectedAddress || !isAddress(expectedAddress)) {
    throw new Error('Connect a valid wallet address first.');
  }
  const wallet = getAddress(expectedAddress);
  const rawChain = await provider.request({ method: 'eth_chainId' });
  const walletChainId = parseChainIdHex(rawChain);
  if (walletChainId !== expectedChainId) {
    throw new Error(`Switch wallet to Base (${expectedChainId}) before signing or sending transactions.`);
  }
  const accounts = await provider.request({ method: 'eth_accounts' });
  const active =
    Array.isArray(accounts) && accounts[0] && isAddress(accounts[0])
      ? getAddress(accounts[0])
      : null;
  if (!active || active.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error('Active wallet account does not match connected address.');
  }
  return wallet;
}

async function sendWalletTransaction(provider, publicClient, { from, to, data, value = 0n }) {
  const txParams = {
    from,
    to,
    data,
    ...(value > 0n ? { value: toHex(value) } : {}),
  };
  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [txParams],
  });
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error('Wallet returned an invalid transaction hash.');
  }
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    throw new Error(`Transaction ${txHash} reverted on-chain.`);
  }
  return { txHash, receipt };
}

const PROTOCOL_MIN_FILL_USDC_RAW = 500_000_000n;

export function sumRawBigints(values) {
  if (!Array.isArray(values) || values.length === 0) return 0n;
  let total = 0n;
  for (const item of values) {
    if (item === null || item === undefined || String(item).trim() === '') continue;
    const v = BigInt(item);
    if (v <= 0n) {
      throw new Error('Per-fill raw amount must be positive.');
    }
    total += v;
  }
  return total;
}

/**
 * Validates a planned sequence of partial-fill USDC amounts against an order/remaining total
 * and minimum fill rule (`max(minFill, $500)`). Rejects plans whose sum exceeds the total cap,
 * plans with any chunk below `max(minFill, $500)` (`LoanCore` enforces `$500` minimum principal
 * via `PRINCIPAL_BELOW_MINIMUM`), and fill plans whose first entry is not the current fill amount.
 */
export function validateLendPartialFillPlan(
  perFillUsdcRawList,
  maxAllowedTotalRaw,
  minFillRaw = null,
  { expectedFirstFillRaw = null } = {}
) {
  if (!Array.isArray(perFillUsdcRawList)) return [];
  const cleaned = perFillUsdcRawList
    .map((item) => (item === null || item === undefined ? '' : String(item).trim()))
    .filter((s) => s.length > 0);
  if (cleaned.length === 0) return [];

  const maxTotal = BigInt(maxAllowedTotalRaw);
  if (maxTotal <= 0n) {
    throw new Error('Offer or remaining USDC raw amount must be positive.');
  }
  const parsedMinFill = minFillRaw !== null && minFillRaw !== undefined ? BigInt(minFillRaw) : 0n;
  const effectiveMin =
    parsedMinFill > PROTOCOL_MIN_FILL_USDC_RAW ? parsedMinFill : PROTOCOL_MIN_FILL_USDC_RAW;

  const parsed = cleaned.map((raw) => {
    const v = BigInt(raw);
    if (v <= 0n) {
      throw new Error('Per-fill raw amount must be positive.');
    }
    return v;
  });
  if (
    expectedFirstFillRaw !== null &&
    expectedFirstFillRaw !== undefined &&
    parsed[0] !== BigInt(expectedFirstFillRaw)
  ) {
    const expectedFirst = BigInt(expectedFirstFillRaw);
    throw new Error(
      `Partial-fill plan must include the current fill ($${formatTokenUnitsDisplay(expectedFirst, USDC_DECIMALS, 2)}) as its first entry (got $${formatTokenUnitsDisplay(parsed[0], USDC_DECIMALS, 2)}).`
    );
  }
  const sum = parsed.reduce((acc, v) => acc + v, 0n);
  if (sum > maxTotal) {
    throw new Error(
      `Partial-fill plan sum ($${formatTokenUnitsDisplay(sum, USDC_DECIMALS, 2)}) exceeds offer/remaining amount ($${formatTokenUnitsDisplay(maxTotal, USDC_DECIMALS, 2)}).`
    );
  }
  for (let i = 0; i < parsed.length; i += 1) {
    const v = parsed[i];
    if (v < effectiveMin) {
      throw new Error(
        `Planned fill #${i + 1} ($${formatTokenUnitsDisplay(v, USDC_DECIMALS, 2)}) is below minimum fill ($${formatTokenUnitsDisplay(effectiveMin, USDC_DECIMALS, 2)}); LoanCore requires every chunk >= max(minFill, $500.00) (PRINCIPAL_BELOW_MINIMUM).`
      );
    }
  }
  return parsed;
}

/**
 * Computes exact raw USDC allowance needed on LoanCore for signing a LendOffer
 * or executing partial/multi-fill lender transactions. Covers the fill/offer
 * requirement (or validated partial-fill plan sum, which includes the current fill
 * as its first entry when filling an order) plus any open offer total.
 */
export function computeLendApprovalAmountRaw(
  usdcAmountRaw,
  {
    perFillUsdcRawList = null,
    existingOpenSumRaw = 0n,
    minFillRaw = null,
    maxAllowedTotalRaw = null,
    matchCurrentFillFirst = false,
  } = {}
) {
  const orderUsdcRaw = BigInt(usdcAmountRaw);
  const existingSum = BigInt(existingOpenSumRaw ?? 0n);
  if (orderUsdcRaw <= 0n || existingSum < 0n) {
    throw new Error('Lend USDC raw amount must be positive.');
  }
  const maxTotal =
    maxAllowedTotalRaw !== null && maxAllowedTotalRaw !== undefined
      ? BigInt(maxAllowedTotalRaw)
      : orderUsdcRaw;
  if (maxTotal < orderUsdcRaw) {
    throw new Error('Offer or remaining USDC cap cannot be below current fill/order amount.');
  }
  const mustStartWithCurrentFill = matchCurrentFillFirst || maxTotal > orderUsdcRaw;
  const parsedPlan = validateLendPartialFillPlan(perFillUsdcRawList, maxTotal, minFillRaw, {
    expectedFirstFillRaw: mustStartWithCurrentFill ? orderUsdcRaw : null,
  });
  const plannedFillsSum = sumRawBigints(parsedPlan);
  const orderRequirement = plannedFillsSum > orderUsdcRaw ? plannedFillsSum : orderUsdcRaw;
  const remainderAfterPlanRaw =
    plannedFillsSum > 0n && maxTotal > plannedFillsSum ? maxTotal - plannedFillsSum : 0n;
  const remainderWarning =
    remainderAfterPlanRaw > 0n && remainderAfterPlanRaw < PROTOCOL_MIN_FILL_USDC_RAW
      ? `Planned fills leave $${formatTokenUnitsDisplay(remainderAfterPlanRaw, USDC_DECIMALS, 2)} (< $500.00), which is unfillable on-chain (LoanCore PRINCIPAL_BELOW_MINIMUM) and can only be cancelled or expire.`
      : '';
  return {
    orderUsdcRaw,
    plannedFillsSum,
    existingOpenSumRaw: existingSum,
    requiredApprovalRaw: existingSum + orderRequirement,
    remainderAfterPlanRaw,
    remainderWarning,
  };
}

export function resolveExactLendAmounts(
  quote,
  {
    minFillRaw = null,
    perFillUsdcRawList = null,
    existingOpenSumRaw = 0n,
  } = {}
) {
  if (!quote?.amounts?.principal?.raw) {
    throw new Error('Quote response is missing exact raw principal amount.');
  }
  const principalRaw = BigInt(quote.amounts.principal.raw);
  if (principalRaw <= 0n) {
    throw new Error('Lend principal raw amount must be positive.');
  }
  const effectiveMinFill = BigInt(minFillRaw ?? principalRaw);
  const approvalSizing = computeLendApprovalAmountRaw(principalRaw, {
    perFillUsdcRawList,
    existingOpenSumRaw,
    minFillRaw: effectiveMinFill,
    maxAllowedTotalRaw: principalRaw,
  });
  return {
    principalRaw,
    minFillRaw: effectiveMinFill,
    plannedFillsSum: approvalSizing.plannedFillsSum,
    existingOpenSumRaw: approvalSizing.existingOpenSumRaw,
    requiredApprovalRaw: approvalSizing.requiredApprovalRaw,
    originationFeeRaw: BigInt(quote.amounts.origination_fee?.raw ?? 0n),
    netProceedsRaw: BigInt(quote.amounts.net_proceeds?.raw ?? 0n),
    interestMaturityRaw: BigInt(quote.amounts.interest_maturity?.raw ?? 0n),
    protocolInterestCutRaw: BigInt(quote.amounts.protocol_interest_cut?.raw ?? 0n),
    lenderNetInterestRaw: BigInt(quote.amounts.lender_net_interest?.raw ?? 0n),
    totalRepaymentAtMaturityRaw: BigInt(quote.amounts.total_repayment_at_maturity?.raw ?? 0n),
  };
}

async function readEligibilitySummary(publicClient, cfg, wallet, cleanAtt) {
  if (!cfg.contracts.eligibilityGate) return null;
  const gateAddr = getAddress(cfg.contracts.eligibilityGate);
  const [permissionlessMode, isRevoked, allowlisted, isEligible] = await Promise.all([
    publicClient.readContract({ address: gateAddr, abi: eligibilityGateAbi, functionName: 'permissionlessMode' }),
    publicClient.readContract({ address: gateAddr, abi: eligibilityGateAbi, functionName: 'isRevoked', args: [wallet] }),
    publicClient.readContract({ address: gateAddr, abi: eligibilityGateAbi, functionName: 'allowlist', args: [wallet] }),
    publicClient.readContract({
      address: gateAddr,
      abi: eligibilityGateAbi,
      functionName: 'isEligible',
      args: [wallet, cleanAtt],
    }),
  ]);
  return {
    permissionlessMode: Boolean(permissionlessMode),
    isRevoked: Boolean(isRevoked),
    allowlisted: Boolean(allowlisted),
    isEligible: Boolean(isEligible),
  };
}

async function approveErc20Exact({
  address,
  tokenAddress,
  spenderAddress,
  tokenLabel,
  requiredRaw,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  const required = BigInt(requiredRaw);
  if (required <= 0n) {
    throw new Error(`Required ${tokenLabel} raw amount must be positive.`);
  }
  const wallet = await assertActiveWalletAndChain(provider, address, cfg.chainId);
  const token = getAddress(tokenAddress);
  const spender = getAddress(spenderAddress);

  const currentAllowance = BigInt(
    await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet, spender],
    })
  );
  if (currentAllowance >= required) {
    return {
      approved: true,
      alreadyApproved: true,
      txHash: null,
      allowanceRaw: currentAllowance.toString(),
    };
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, required],
  });
  const { txHash } = await sendWalletTransaction(provider, publicClient, {
    from: wallet,
    to: token,
    data,
  });

  const postAllowance = BigInt(
    await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet, spender],
    })
  );
  if (postAllowance < required) {
    throw new Error(
      `Post-approval allowance check failed; allowance still below required ${tokenLabel}.`
    );
  }

  return {
    approved: true,
    alreadyApproved: false,
    txHash,
    allowanceRaw: postAllowance.toString(),
  };
}

export async function readLendAllowanceAndNonce(
  address,
  {
    cfg = getFrontendConfig(),
    publicClient = createProtocolPublicClient(cfg),
    attestationHex = '0x',
  } = {}
) {
  if (!address || !isAddress(address)) {
    throw new Error('Valid wallet address required.');
  }
  if (!cfg.contracts.loanCore || !cfg.contracts.orderSettlement || !cfg.usdcAddress) {
    throw new Error('Missing USDC, LoanCore, or OrderSettlement address in configuration.');
  }
  const wallet = getAddress(address);
  const usdcAddr = getAddress(cfg.usdcAddress);
  const loanCoreAddr = getAddress(cfg.contracts.loanCore);
  const cleanAtt = normalizeAttestationHex(attestationHex);

  const [bal, allowance, dec, sym, nonce, eligibility] = await Promise.all([
    publicClient.readContract({ address: usdcAddr, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
    publicClient.readContract({
      address: usdcAddr,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet, loanCoreAddr],
    }),
    publicClient.readContract({ address: usdcAddr, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({ address: usdcAddr, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({
      address: getAddress(cfg.contracts.orderSettlement),
      abi: orderSettlementAbi,
      functionName: 'getMakerNonce',
      args: [wallet],
    }),
    readEligibilitySummary(publicClient, cfg, wallet, cleanAtt),
  ]);

  const decimals = Number(dec);
  return {
    token: usdcAddr,
    spender: loanCoreAddr,
    symbol: sym,
    decimals,
    balanceRaw: BigInt(bal).toString(),
    balanceFormatted: formatTokenUnitsDisplay(bal, decimals, 2),
    allowanceRaw: BigInt(allowance).toString(),
    allowanceFormatted: formatTokenUnitsDisplay(allowance, decimals, 2),
    makerNonce: BigInt(nonce).toString(),
    eligibility,
  };
}

export async function approveUsdcForLend({
  address,
  requiredUsdcRaw,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!cfg.usdcAddress || !cfg.contracts.loanCore) {
    throw new Error('USDC or LoanCore contract address is not configured.');
  }
  return approveErc20Exact({
    address,
    tokenAddress: cfg.usdcAddress,
    spenderAddress: cfg.contracts.loanCore,
    tokenLabel: 'USDC',
    requiredRaw: requiredUsdcRaw,
    provider,
    cfg,
    publicClient,
  });
}

async function setErc20AllowanceExact({
  address,
  tokenAddress,
  spenderAddress,
  targetAllowanceRaw,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  const target = BigInt(targetAllowanceRaw);
  if (target < 0n) {
    throw new Error('Target allowance raw amount cannot be negative.');
  }
  const wallet = await assertActiveWalletAndChain(provider, address, cfg.chainId);
  const token = getAddress(tokenAddress);
  const spender = getAddress(spenderAddress);

  const currentAllowance = BigInt(
    await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet, spender],
    })
  );
  if (currentAllowance === target) {
    return {
      updated: false,
      unchanged: true,
      txHash: null,
      allowanceRaw: currentAllowance.toString(),
    };
  }

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, target],
  });
  const { txHash } = await sendWalletTransaction(provider, publicClient, {
    from: wallet,
    to: token,
    data,
  });

  const postAllowance = BigInt(
    await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet, spender],
    })
  );
  if (postAllowance !== target) {
    throw new Error(
      `Post-update allowance check failed; expected ${target.toString()}, got ${postAllowance.toString()}.`
    );
  }

  return {
    updated: true,
    unchanged: false,
    txHash,
    allowanceRaw: postAllowance.toString(),
  };
}

/**
 * Explicitly sets LoanCore USDC allowance to `targetAllowanceRaw` (including `0n`),
 * used after cancelling open LendOffers to revoke excess allowance.
 */
export async function setUsdcAllowanceForLend({
  address,
  targetAllowanceRaw,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!cfg.usdcAddress || !cfg.contracts.loanCore) {
    throw new Error('USDC or LoanCore contract address is not configured.');
  }
  return setErc20AllowanceExact({
    address,
    tokenAddress: cfg.usdcAddress,
    spenderAddress: cfg.contracts.loanCore,
    targetAllowanceRaw,
    provider,
    cfg,
    publicClient,
  });
}

/**
 * Explicitly sets CollateralEscrow token allowance to `targetAllowanceRaw` (including `0n`),
 * used after cancelling open BorrowOrders to revoke excess collateral allowance.
 */
export async function setCollateralAllowanceForBorrow({
  address,
  collateralToken,
  targetAllowanceRaw,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!collateralToken || !isAddress(collateralToken)) {
    throw new Error('Valid collateral token address required.');
  }
  if (!cfg.contracts.collateralEscrow) {
    throw new Error('CollateralEscrow contract address is not configured.');
  }
  return setErc20AllowanceExact({
    address,
    tokenAddress: collateralToken,
    spenderAddress: cfg.contracts.collateralEscrow,
    targetAllowanceRaw,
    provider,
    cfg,
    publicClient,
  });
}

function normalizeAttestationHex(raw) {
  return typeof raw === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(raw.trim()) ? raw.trim() : '0x';
}

export async function readBorrowAllowanceAndNonce(
  address,
  collateralToken,
  {
    cfg = getFrontendConfig(),
    publicClient = createProtocolPublicClient(cfg),
    attestationHex = '0x',
  } = {}
) {
  if (!address || !isAddress(address)) {
    throw new Error('Valid wallet address required.');
  }
  if (!collateralToken || !isAddress(collateralToken)) {
    throw new Error('Valid collateral token address required.');
  }
  if (!cfg.contracts.collateralEscrow || !cfg.contracts.orderSettlement) {
    throw new Error('Missing CollateralEscrow or OrderSettlement contract address in configuration.');
  }
  const wallet = getAddress(address);
  const token = getAddress(collateralToken);
  const cleanAtt = normalizeAttestationHex(attestationHex);

  const [bal, allowance, dec, sym, nonce, eligibility] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet, cfg.contracts.collateralEscrow],
    }),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({
      address: cfg.contracts.orderSettlement,
      abi: orderSettlementAbi,
      functionName: 'getMakerNonce',
      args: [wallet],
    }),
    readEligibilitySummary(publicClient, cfg, wallet, cleanAtt),
  ]);

  const decimals = Number(dec);
  return {
    token,
    symbol: sym,
    decimals,
    balanceRaw: bal.toString(),
    balanceFormatted: formatTokenUnitsDisplay(bal, decimals, 6),
    allowanceRaw: allowance.toString(),
    allowanceFormatted: formatTokenUnitsDisplay(allowance, decimals, 6),
    makerNonce: nonce.toString(),
    eligibility,
  };
}

export async function approveCollateralForBorrow({
  address,
  collateralToken,
  requiredCollateralRaw,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!collateralToken || !isAddress(collateralToken)) {
    throw new Error('Valid collateral token address required.');
  }
  if (!cfg.contracts.collateralEscrow) {
    throw new Error('CollateralEscrow contract address is not configured.');
  }
  const required = BigInt(requiredCollateralRaw);
  if (required <= 0n) {
    throw new Error('Required collateral raw amount must be positive.');
  }

  return approveErc20Exact({
    address,
    tokenAddress: collateralToken,
    spenderAddress: cfg.contracts.collateralEscrow,
    tokenLabel: 'collateral',
    requiredRaw: requiredCollateralRaw,
    provider,
    cfg,
    publicClient,
  });
}

export function normalizeBorrowOrderStruct(order) {
  return {
    borrower: getAddress(order.borrower),
    collateralToken: getAddress(order.collateralToken),
    collateralAmount: BigInt(order.collateralAmount),
    minUsdc: BigInt(order.minUsdc),
    maxRateBps: Number(order.maxRateBps),
    termDays: Number(order.termDays),
    maxLtvBps: Number(order.maxLtvBps),
    minFill: BigInt(order.minFill),
    expiry: BigInt(order.expiry),
    nonce: BigInt(order.nonce),
    yieldMode: Number(order.yieldMode ?? 0),
    allowInKindSettlement: Boolean(order.allowInKindSettlement),
  };
}

export function borrowOrderToJson(order) {
  const n = normalizeBorrowOrderStruct(order);
  return {
    borrower: n.borrower,
    collateralToken: n.collateralToken,
    collateralAmount: n.collateralAmount.toString(),
    minUsdc: n.minUsdc.toString(),
    maxRateBps: n.maxRateBps,
    termDays: n.termDays,
    maxLtvBps: n.maxLtvBps,
    minFill: n.minFill.toString(),
    expiry: n.expiry.toString(),
    nonce: n.nonce.toString(),
    yieldMode: n.yieldMode,
    allowInKindSettlement: n.allowInKindSettlement,
  };
}

export function buildBorrowOrderTypedData({ order, cfg = getFrontendConfig() }) {
  if (!cfg?.contracts?.orderSettlement) {
    throw new Error('OrderSettlement contract address is not configured.');
  }
  const message = normalizeBorrowOrderStruct(order);
  return {
    domain: {
      name: ORDER_SETTLEMENT_DOMAIN_NAME,
      version: ORDER_SETTLEMENT_DOMAIN_VERSION,
      chainId: Number(cfg.chainId || BASE_CHAIN_ID),
      verifyingContract: getAddress(cfg.contracts.orderSettlement),
    },
    types: BORROW_ORDER_EIP712_TYPES,
    primaryType: 'BorrowOrder',
    message,
  };
}

function serializeTypedDataForRpc(typedData) {
  return JSON.stringify(
    {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        ...typedData.types,
      },
      primaryType: typedData.primaryType,
      domain: {
        ...typedData.domain,
        chainId: Number(typedData.domain.chainId),
      },
      message: typedData.message,
    },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value)
  );
}

function resolveStorage(explicitStorage) {
  if (explicitStorage) return explicitStorage;
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
    return globalThis.localStorage;
  }
  return null;
}

function loadPersistedOrderList(storageKey, storage = null) {
  const store = resolveStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePersistedOrderRecord(storageKey, record, storage = null) {
  const store = resolveStorage(storage);
  const existing = store ? loadPersistedOrderList(storageKey, store) : [];
  const hashLower = String(record?.orderHash ?? '').toLowerCase();
  const nextRecord = {
    ...record,
    orderHash: record.orderHash,
    updatedAt: new Date().toISOString(),
  };
  const filtered = existing.filter((item) => String(item?.orderHash ?? '').toLowerCase() !== hashLower);
  const nextList = [nextRecord, ...filtered].slice(0, 50);
  if (store) {
    try {
      store.setItem(storageKey, JSON.stringify(nextList));
    } catch {
      // ignore quota/private-mode storage errors
    }
  }
  return nextList;
}

export function loadPersistedSignedOrders(storage = null) {
  return loadPersistedOrderList(SIGNED_BORROW_ORDERS_STORAGE_KEY, storage);
}

export function saveSignedBorrowOrder(record, storage = null) {
  return savePersistedOrderRecord(SIGNED_BORROW_ORDERS_STORAGE_KEY, record, storage);
}

export function loadPersistedSignedLendOffers(storage = null) {
  return loadPersistedOrderList(SIGNED_LEND_OFFERS_STORAGE_KEY, storage);
}

export function saveSignedLendOffer(record, storage = null) {
  return savePersistedOrderRecord(SIGNED_LEND_OFFERS_STORAGE_KEY, record, storage);
}

export function buildLendOfferTypedData({ offer, cfg = getFrontendConfig() }) {
  if (!cfg?.contracts?.orderSettlement) {
    throw new Error('OrderSettlement contract address is not configured.');
  }
  const message = normalizeLendOfferStruct(offer);
  return {
    domain: {
      name: ORDER_SETTLEMENT_DOMAIN_NAME,
      version: ORDER_SETTLEMENT_DOMAIN_VERSION,
      chainId: Number(cfg.chainId || BASE_CHAIN_ID),
      verifyingContract: getAddress(cfg.contracts.orderSettlement),
    },
    types: LEND_OFFER_EIP712_TYPES,
    primaryType: 'LendOffer',
    message,
  };
}

export function parseLendOfferFromJson(rawInput) {
  let parsed = rawInput;
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      throw new Error('Paste LendOffer JSON first.');
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('Invalid JSON format in LendOffer payload.');
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LendOffer payload must be a JSON object.');
  }
  const rawOrder = parsed.order ?? parsed.signed_order ?? parsed;
  const normalized = normalizeLendOfferStruct(rawOrder);
  return {
    order: normalized,
    offerJson: lendOfferToJson(normalized),
    signature: typeof parsed.signature === 'string' ? parsed.signature : null,
    orderHash:
      typeof parsed.orderHash === 'string'
        ? parsed.orderHash
        : typeof parsed.order_hash === 'string'
          ? parsed.order_hash
          : null,
  };
}

export function normalizeLendOfferStruct(offer) {
  return {
    lender: getAddress(offer.lender),
    usdcAmount: BigInt(offer.usdcAmount),
    minRateBps: Number(offer.minRateBps),
    termDays: Number(offer.termDays),
    allowedCollateral: getAddress(offer.allowedCollateral),
    maxLtvBps: Number(offer.maxLtvBps),
    minFill: BigInt(offer.minFill),
    expiry: BigInt(offer.expiry),
    nonce: BigInt(offer.nonce),
    yieldMode: Number(offer.yieldMode ?? 0),
  };
}

export function lendOfferToJson(offer) {
  const n = normalizeLendOfferStruct(offer);
  return {
    lender: n.lender,
    usdcAmount: n.usdcAmount.toString(),
    minRateBps: n.minRateBps,
    termDays: n.termDays,
    allowedCollateral: n.allowedCollateral,
    maxLtvBps: n.maxLtvBps,
    minFill: n.minFill.toString(),
    expiry: n.expiry.toString(),
    nonce: n.nonce.toString(),
    yieldMode: n.yieldMode,
  };
}

export function parseBorrowOrderFromJson(rawInput) {
  let parsed = rawInput;
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      throw new Error('Paste BorrowOrder JSON first.');
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('Invalid JSON format in BorrowOrder payload.');
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('BorrowOrder payload must be a JSON object.');
  }
  const rawOrder = parsed.order ?? parsed.signed_order ?? parsed;
  const normalized = normalizeBorrowOrderStruct(rawOrder);
  return {
    order: normalized,
    orderJson: borrowOrderToJson(normalized),
    signature: typeof parsed.signature === 'string' ? parsed.signature : null,
    orderHash:
      typeof parsed.orderHash === 'string'
        ? parsed.orderHash
        : typeof parsed.order_hash === 'string'
          ? parsed.order_hash
          : null,
  };
}

export async function publishSignedOrderToApi({
  orderType,
  order,
  signature,
  cfg = getFrontendConfig(),
  fetchImpl = globalThis.fetch,
}) {
  if (!cfg?.apiUrl || typeof fetchImpl !== 'function') {
    throw new Error('API URL or fetch implementation unavailable for publishing order.');
  }
  const normalizedOrder =
    orderType === 'borrow' ? borrowOrderToJson(order) : lendOfferToJson(order);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetchImpl(`${cfg.apiUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_type: orderType,
        order: normalizedOrder,
        signature,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      throw new Error(parsed?.error?.message || `HTTP ${res.status} publishing signed order to api/`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshSignedBorrowOrdersState({
  orders,
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!Array.isArray(orders) || orders.length === 0) return [];
  if (!cfg?.contracts?.orderSettlement) return orders;
  const settlementAddr = getAddress(cfg.contracts.orderSettlement);
  const blk = await publicClient.getBlock({ blockTag: 'latest' });

  return Promise.all(
    orders.map(async (item) => {
      try {
        const orderObj = item.orderJson ?? item.order;
        const normalized = normalizeBorrowOrderStruct(orderObj);
        const computedHash = await publicClient.readContract({
          address: settlementAddr,
          abi: orderSettlementAbi,
          functionName: 'hashBorrowOrder',
          args: [normalized],
        });
        const [cancelled, filledRaw, currentMakerNonce] = await Promise.all([
          publicClient.readContract({
            address: settlementAddr,
            abi: orderSettlementAbi,
            functionName: 'isOrderCancelled',
            args: [computedHash],
          }),
          publicClient.readContract({
            address: settlementAddr,
            abi: orderSettlementAbi,
            functionName: 'getOrderFilledAmount',
            args: [computedHash],
          }),
          publicClient.readContract({
            address: settlementAddr,
            abi: orderSettlementAbi,
            functionName: 'getMakerNonce',
            args: [normalized.borrower],
          }),
        ]);

        const totalUsdc = normalized.minUsdc;
        const filled = BigInt(filledRaw);
        const remaining = totalUsdc > filled ? totalUsdc - filled : 0n;
        const expired = normalized.expiry <= blk.timestamp;
        const nonceBumped = BigInt(currentMakerNonce) !== normalized.nonce;
        const onchainStatus = cancelled
          ? 'cancelled'
          : nonceBumped
            ? 'nonce_bumped'
            : remaining === 0n
              ? 'filled'
              : expired
                ? 'expired'
                : filled > 0n
                  ? 'partially_filled'
                  : 'open';

        return {
          ...item,
          orderHash: computedHash,
          orderJson: borrowOrderToJson(normalized),
          filledRaw: filled.toString(),
          remainingRaw: remaining.toString(),
          cancelled: Boolean(cancelled),
          expired,
          nonceBumped,
          currentMakerNonce: BigInt(currentMakerNonce).toString(),
          onchainStatus,
        };
      } catch (err) {
        return {
          ...item,
          onchainStatus: 'unknown',
          stateError: formatWeb3Error(err),
        };
      }
    })
  );
}

function assertExpectedQuoteUnchanged(
  expectedQuote,
  freshQuote,
  { requireExpectedQuote = false } = {}
) {
  if (!expectedQuote) {
    if (requireExpectedQuote) {
      throw new Error(
        'No reviewed on-screen quote found. Click "Quote & Risk Check" and review terms before approving or signing.'
      );
    }
    return;
  }
  const checks = [
    ['principal.raw', expectedQuote?.amounts?.principal?.raw, freshQuote?.amounts?.principal?.raw],
    [
      'collateral_required.raw',
      expectedQuote?.amounts?.collateral_required?.raw,
      freshQuote?.amounts?.collateral_required?.raw,
    ],
    ['net_proceeds.raw', expectedQuote?.amounts?.net_proceeds?.raw, freshQuote?.amounts?.net_proceeds?.raw],
    [
      'total_repayment_at_maturity.raw',
      expectedQuote?.amounts?.total_repayment_at_maturity?.raw,
      freshQuote?.amounts?.total_repayment_at_maturity?.raw,
    ],
    ['oracle_state', expectedQuote?.asset?.oracle_state, freshQuote?.asset?.oracle_state],
  ];
  for (const [label, prevVal, nextVal] of checks) {
    if (prevVal !== undefined && nextVal !== undefined && String(prevVal) !== String(nextVal)) {
      throw new Error(
        `Quote changed before signing (${label}: ${String(prevVal)} -> ${String(nextVal)}). Re-simulate quote and review updated terms.`
      );
    }
  }
}

/**
 * @param {{
 *   address: string,
 *   collateralToken: string,
 *   principalRaw?: string | bigint | null,
 *   collateralAmountRaw?: string | bigint | null,
 *   collateralBufferBps?: number,
 *   expectedQuote?: any,
 *   maxRateBps: number,
 *   termDays: number,
 *   maxLtvBps?: number | null,
 *   minFillRaw?: string | bigint | null,
 *   expiryDays?: number,
 *   expiryTimestamp?: string | bigint | number | null,
 *   yieldMode?: number,
 *   allowInKindSettlement?: boolean,
 *   attestationHex?: string,
 *   autoApprove?: boolean,
 *   publishToApi?: boolean,
 *   fetchImpl?: typeof fetch,
 *   storage?: any,
 *   provider?: any,
 *   cfg?: any,
 *   publicClient?: any
 * }} opts
 */
export async function prepareAndSignBorrowOrder({
  address,
  collateralToken,
  principalRaw = null,
  collateralAmountRaw = null,
  collateralBufferBps = DEFAULT_COLLATERAL_BUFFER_BPS,
  expectedQuote = null,
  requireExpectedQuote = false,
  maxRateBps,
  termDays,
  maxLtvBps = null,
  minFillRaw = null,
  existingOpenCollateralRaw = 0n,
  expiryDays = 2,
  expiryTimestamp = null,
  yieldMode = 0,
  allowInKindSettlement = false,
  attestationHex = '0x',
  autoApprove = true,
  publishToApi = true,
  fetchImpl = globalThis.fetch,
  storage = null,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!cfg.contracts.orderSettlement || !cfg.contracts.collateralEscrow) {
    throw new Error('OrderSettlement or CollateralEscrow address is not configured.');
  }
  const wallet = await assertActiveWalletAndChain(provider, address, cfg.chainId);
  const token = getAddress(collateralToken);

  const walletMeta = await readBorrowAllowanceAndNonce(wallet, token, {
    cfg,
    publicClient,
    attestationHex,
  });
  if (walletMeta.eligibility && !walletMeta.eligibility.isEligible) {
    throw new Error(
      'IneligibleCounterparty: Connected wallet is not eligible on-chain in EligibilityGate.'
    );
  }

  const quote = await fetchLoanQuote({
    cfg,
    asset: token,
    principalRaw: principalRaw ? String(principalRaw) : undefined,
    collateralAmountRaw: collateralAmountRaw ? String(collateralAmountRaw) : undefined,
    termDays: Number(termDays),
    aprBps: Number(maxRateBps),
    maxLtvBps: maxLtvBps !== null && maxLtvBps !== undefined ? Number(maxLtvBps) : undefined,
    borrower: wallet,
    borrowerAttestation: attestationHex,
  });

  if (!quote.accepted) {
    const reasons = (quote.rejection_reasons ?? []).map((r) => `${r.code}: ${r.message}`).join('; ');
    throw new Error(`Quote rejected by on-chain protocol rules: ${reasons || 'Unknown rejection'}`);
  }
  assertExpectedQuoteUnchanged(expectedQuote, quote, { requireExpectedQuote });

  const exact = resolveExactBorrowAmounts(quote, {
    userCollateralRaw: collateralAmountRaw,
    bufferBps: collateralBufferBps,
    minFillRaw: minFillRaw ?? quote.amounts.principal.raw,
    existingOpenCollateralRaw: existingOpenCollateralRaw ?? 0n,
  });
  const minFillBig = BigInt(minFillRaw ?? exact.principalRaw);
  if (minFillBig < 500_000_000n) {
    throw new Error('Minimum fill cannot be below $500.00 (500000000 raw USDC).');
  }
  if (minFillBig > exact.principalRaw) {
    throw new Error('Minimum fill cannot exceed principal amount.');
  }

  if (BigInt(walletMeta.balanceRaw) < exact.requiredApprovalRaw) {
    throw new Error(
      `Insufficient ${walletMeta.symbol} balance: have ${walletMeta.balanceRaw} raw units, need ${exact.requiredApprovalRaw.toString()} raw units (signed collateral + ${exact.approvalSlackRaw.toString()} wei partial-fill slack).`
    );
  }

  let approvalTxHash = null;
  if (BigInt(walletMeta.allowanceRaw) < exact.requiredApprovalRaw) {
    if (!autoApprove) {
      throw new Error(
        `CollateralEscrow allowance is below required ${exact.requiredApprovalRaw.toString()} raw units (signed + ${exact.approvalSlackRaw.toString()} wei fill slack); approve collateral first.`
      );
    }
    const appRes = await approveCollateralForBorrow({
      address: wallet,
      collateralToken: token,
      requiredCollateralRaw: exact.requiredApprovalRaw,
      provider,
      cfg,
      publicClient,
    });
    approvalTxHash = appRes.txHash;
  }

  let expiryBig;
  if (expiryTimestamp !== null && expiryTimestamp !== undefined) {
    expiryBig = BigInt(expiryTimestamp);
  } else {
    const expDaysInt = Number(expiryDays);
    if (!Number.isInteger(expDaysInt) || expDaysInt < 1 || expDaysInt > 30) {
      throw new Error('Order expiry must be between 1 and 30 days.');
    }
    const blk = await publicClient.getBlock();
    expiryBig = blk.timestamp + BigInt(expDaysInt) * 86_400n;
  }

  const effectiveLtv = Number(quote.asset?.allowed_ltv_bps ?? maxLtvBps ?? 6000);
  const order = normalizeBorrowOrderStruct({
    borrower: wallet,
    collateralToken: token,
    collateralAmount: exact.collateralAmountRaw,
    minUsdc: exact.principalRaw,
    maxRateBps: Number(maxRateBps),
    termDays: Number(termDays),
    maxLtvBps: effectiveLtv,
    minFill: minFillBig,
    expiry: expiryBig,
    nonce: BigInt(walletMeta.makerNonce),
    yieldMode: Number(yieldMode ?? 0),
    allowInKindSettlement: Boolean(allowInKindSettlement),
  });

  const typedData = buildBorrowOrderTypedData({ order, cfg });
  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [wallet, serializeTypedDataForRpc(typedData)],
  });
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error('Wallet returned an invalid EIP-712 signature.');
  }

  await assertActiveWalletAndChain(provider, wallet, cfg.chainId);

  const orderHash = await publicClient.readContract({
    address: getAddress(cfg.contracts.orderSettlement),
    abi: orderSettlementAbi,
    functionName: 'hashBorrowOrder',
    args: [order],
  });
  const recovered = await recoverAddress({ hash: orderHash, signature });
  if (recovered.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error(`Signature signer mismatch: recovered ${recovered}, expected ${wallet}.`);
  }

  const orderJson = borrowOrderToJson(order);
  const exactAmounts = {
    principalRaw: exact.principalRaw.toString(),
    minRequiredCollateralRaw: exact.minRequiredCollateralRaw.toString(),
    bufferedCollateralRaw: exact.bufferedCollateralRaw.toString(),
    bufferBps: exact.bufferBps,
    collateralAmountRaw: exact.collateralAmountRaw.toString(),
    maxFills: exact.maxFills.toString(),
    approvalSlackRaw: exact.approvalSlackRaw.toString(),
    existingOpenCollateralRaw: exact.existingOpenCollateralRaw.toString(),
    requiredApprovalRaw: exact.requiredApprovalRaw.toString(),
    originationFeeRaw: exact.originationFeeRaw.toString(),
    netProceedsRaw: exact.netProceedsRaw.toString(),
    totalRepaymentAtMaturityRaw: exact.totalRepaymentAtMaturityRaw.toString(),
  };

  let publishedToApi = false;
  let publishError = '';
  let apiOrder = null;
  if (publishToApi && cfg.apiUrl) {
    try {
      apiOrder = await publishSignedOrderToApi({
        orderType: 'borrow',
        order,
        signature,
        cfg,
        fetchImpl,
      });
      publishedToApi = true;
    } catch (err) {
      publishError = formatWeb3Error(err);
    }
  }

  const createdAt = new Date().toISOString();
  saveSignedBorrowOrder(
    {
      orderHash,
      orderJson,
      signature,
      approvalTxHash,
      cancelledTxHash: null,
      createdAt,
      publishedToApi,
      publishError,
      exactAmounts,
    },
    storage
  );

  return {
    quote,
    order,
    orderJson,
    orderHash,
    signature: /** @type {`0x${string}`} */ (signature),
    approvalTxHash,
    publishedToApi,
    publishError,
    apiOrder,
    exactAmounts,
  };
}

export async function cancelSignedBorrowOrder({
  address,
  order,
  storage = null,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!cfg.contracts.orderSettlement) {
    throw new Error('OrderSettlement contract address is not configured.');
  }
  const wallet = await assertActiveWalletAndChain(provider, address, cfg.chainId);
  const normalized = normalizeBorrowOrderStruct(order);
  if (normalized.borrower.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error('Only the borrow order maker can cancel this order.');
  }
  const settlementAddr = getAddress(cfg.contracts.orderSettlement);
  const orderHash = await publicClient.readContract({
    address: settlementAddr,
    abi: orderSettlementAbi,
    functionName: 'hashBorrowOrder',
    args: [normalized],
  });
  const data = encodeFunctionData({
    abi: orderSettlementAbi,
    functionName: 'cancelBorrowOrder',
    args: [normalized],
  });
  const { txHash, receipt } = await sendWalletTransaction(provider, publicClient, {
    from: wallet,
    to: settlementAddr,
    data,
  });

  // Update persisted order record if present
  const existing = loadPersistedSignedOrders(storage).find(
    (item) => String(item?.orderHash ?? '').toLowerCase() === orderHash.toLowerCase()
  );
  if (existing) {
    saveSignedBorrowOrder(
      {
        ...existing,
        cancelledTxHash: txHash,
        cancelled: true,
        onchainStatus: 'cancelled',
      },
      storage
    );
  }

  return { txHash, receipt, orderHash };
}

export async function bumpMakerNonceOnChain({
  address,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!cfg.contracts.orderSettlement) {
    throw new Error('OrderSettlement contract address is not configured.');
  }
  const wallet = await assertActiveWalletAndChain(provider, address, cfg.chainId);
  const settlementAddr = getAddress(cfg.contracts.orderSettlement);
  const data = encodeFunctionData({
    abi: orderSettlementAbi,
    functionName: 'bumpNonce',
    args: [],
  });
  const { txHash, receipt } = await sendWalletTransaction(provider, publicClient, {
    from: wallet,
    to: settlementAddr,
    data,
  });
  const newNonce = await publicClient.readContract({
    address: settlementAddr,
    abi: orderSettlementAbi,
    functionName: 'getMakerNonce',
    args: [wallet],
  });
  return {
    txHash,
    receipt,
    newNonce: BigInt(newNonce).toString(),
  };
}

/**
 * Full pre-approval verification and eth_call simulation for filling a LendOffer as borrower.
 * Catches expired, cancelled, wrong-nonce, invalid-sig, exceeded, minFill, lender funding,
 * eligibility, and LTV reverts BEFORE asking the user for an ERC-20 approve transaction.
 */
export function computeRemainingBorrowCollateralRequirement(
  totalCollRaw,
  totalUsdcRaw,
  minFillRaw,
  remainingUsdcRaw = null
) {
  const totalColl = BigInt(totalCollRaw ?? 0n);
  const totalUsdc = BigInt(totalUsdcRaw ?? 0n);
  const remaining = BigInt(remainingUsdcRaw ?? totalUsdc);
  if (totalColl <= 0n || totalUsdc <= 0n || remaining <= 0n) return 0n;
  const effMinRaw = minFillRaw && BigInt(minFillRaw) > 500_000_000n ? BigInt(minFillRaw) : 500_000_000n;
  if (remaining >= totalUsdc) {
    return computeBorrowApprovalAmountRaw(totalColl, totalUsdc, effMinRaw).requiredApprovalRaw;
  }
  const remColl = computeBorrowCollateralForFill(totalColl, totalUsdc, remaining);
  const clampedMin = effMinRaw > remaining ? remaining : effMinRaw;
  const remFills = (remaining + clampedMin - 1n) / clampedMin;
  return remColl + remFills;
}

async function resolveOpenBorrowOrdersCollateralSumRaw({
  borrowerAddress,
  collateralToken,
  existingOpenCollateralRaw = null,
  storage = null,
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (existingOpenCollateralRaw !== null && existingOpenCollateralRaw !== undefined) {
    return BigInt(existingOpenCollateralRaw);
  }
  if (!borrowerAddress || !collateralToken) return 0n;
  const targetChecksum = getAddress(borrowerAddress);
  const targetBorrower = targetChecksum.toLowerCase();
  const tokenChecksum = getAddress(collateralToken);
  const tokenLower = tokenChecksum.toLowerCase();
  const seenHashes = new Set();
  let total = 0n;

  const persisted = loadPersistedSignedOrders(storage);
  const mine = persisted.filter((item) => {
    const ord = item?.orderJson ?? item?.order;
    const maker = String(ord?.borrower ?? '').toLowerCase();
    const tok = String(ord?.collateralToken ?? '').toLowerCase();
    return (!maker || maker === targetBorrower) && (!tok || tok === tokenLower);
  });
  if (mine.length > 0) {
    const synced = await refreshSignedBorrowOrdersState({ orders: mine, cfg, publicClient });
    for (const item of synced) {
      const ord = item?.orderJson ?? item?.order ?? {};
      const tok = String(ord?.collateralToken ?? '').toLowerCase();
      const maker = String(ord?.borrower ?? '').toLowerCase();
      if (tok !== tokenLower || (maker && maker !== targetBorrower)) continue;
      const h = String(item?.orderHash ?? '').toLowerCase();
      if (h) seenHashes.add(h);
      if (item?.onchainStatus === 'unknown') {
        throw new Error(
          `Cannot verify open BorrowOrder ${item.orderHash ?? ''} status on-chain (${item.stateError ?? 'unknown'}); supply existingOpenCollateralRaw or retry when RPC recovers.`
        );
      }
      if (item?.onchainStatus === 'open' || item?.onchainStatus === 'partially_filled') {
        total += computeRemainingBorrowCollateralRequirement(
          ord.collateralAmount,
          ord.minUsdc,
          ord.minFill,
          item.remainingRaw ?? ord.minUsdc
        );
      }
    }
  }

  if (cfg?.apiUrl) {
    const relayRes = await fetchPaginatedApiRows(
      `${cfg.apiUrl}/orders?order_type=borrow&maker=${targetChecksum}&asset=${tokenChecksum}`,
      { cfg }
    );
    for (const row of relayRes.rows ?? []) {
      if (String(row?.maker ?? '').toLowerCase() !== targetBorrower) continue;
      if (row?.order_type !== 'borrow' && row?.order_type !== 'BorrowOrder') continue;
      if (!row?.signed_order || !row?.signature) continue;
      const ord = row.signed_order;
      const rowTok = String(row?.collateral_token ?? ord?.collateralToken ?? '').toLowerCase();
      if (rowTok !== tokenLower) continue;
      const h = String(row?.order_hash ?? '').toLowerCase();
      if (h && seenHashes.has(h)) continue;
      if (h) seenHashes.add(h);
      if (row?.status === 'open' || row?.status === 'partially_filled' || row?.status === 'unknown') {
        total += computeRemainingBorrowCollateralRequirement(
          ord?.collateralAmount ?? row?.collateral_amount?.raw,
          ord?.minUsdc ?? row?.min_usdc?.raw,
          ord?.minFill ?? row?.min_fill?.raw,
          row?.remaining_usdc?.raw ?? ord?.minUsdc ?? row?.min_usdc?.raw
        );
      }
    }
  }

  return total;
}

export async function verifyAndPreviewLendOfferFill({
  offer,
  signature,
  collateralToken,
  fillUsdcRaw = null,
  collateralAmountRaw = null,
  collateralBufferBps = DEFAULT_COLLATERAL_BUFFER_BPS,
  existingOpenCollateralRaw = null,
  storage = null,
  borrowerAddress = null,
  borrowerAttestation = '0x',
  lenderAttestation = '0x',
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!cfg?.contracts?.orderSettlement || !cfg?.contracts?.collateralEscrow || !cfg?.contracts?.loanCore) {
    throw new Error('OrderSettlement, CollateralEscrow, or LoanCore address is not configured.');
  }
  if (!collateralToken || !isAddress(collateralToken)) {
    throw new Error('Select a valid collateral token address.');
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(signature.trim())) {
    throw new Error('InvalidSignature: LendOffer signature must be a valid 0x-prefixed hex signature.');
  }

  const normalizedOffer = normalizeLendOfferStruct(offer);
  const sigHex = /** @type {`0x${string}`} */ (signature.trim());
  const token = getAddress(collateralToken);
  const settlementAddr = getAddress(cfg.contracts.orderSettlement);
  const loanCoreAddr = getAddress(cfg.contracts.loanCore);
  const escrowAddr = getAddress(cfg.contracts.collateralEscrow);
  const cleanBorrowerAtt = normalizeAttestationHex(borrowerAttestation);
  const cleanLenderAtt = normalizeAttestationHex(lenderAttestation);

  if (
    normalizedOffer.allowedCollateral !== zeroAddress &&
    normalizedOffer.allowedCollateral.toLowerCase() !== token.toLowerCase()
  ) {
    throw new Error(
      `CollateralMismatch: LendOffer restricts collateral to ${normalizedOffer.allowedCollateral}, not ${token}.`
    );
  }

  const [blk, orderHash] = await Promise.all([
    publicClient.getBlock({ blockTag: 'latest' }),
    publicClient.readContract({
      address: settlementAddr,
      abi: orderSettlementAbi,
      functionName: 'hashLendOffer',
      args: [normalizedOffer],
    }),
  ]);

  let recovered;
  try {
    recovered = await recoverAddress({ hash: orderHash, signature: sigHex });
  } catch {
    throw new Error('InvalidSignature: Malformed EIP-712 LendOffer signature.');
  }
  if (recovered.toLowerCase() !== normalizedOffer.lender.toLowerCase()) {
    throw new Error(
      `InvalidSignature: Signature recovered ${recovered}, expected lender ${normalizedOffer.lender}.`
    );
  }

  if (normalizedOffer.expiry <= blk.timestamp) {
    throw new Error('OrderExpired: This LendOffer has already expired on-chain.');
  }

  const [cancelled, makerNonce, filledRaw, lenderUsdcBalance, lenderUsdcAllowance] = await Promise.all([
    publicClient.readContract({
      address: settlementAddr,
      abi: orderSettlementAbi,
      functionName: 'isOrderCancelled',
      args: [orderHash],
    }),
    publicClient.readContract({
      address: settlementAddr,
      abi: orderSettlementAbi,
      functionName: 'getMakerNonce',
      args: [normalizedOffer.lender],
    }),
    publicClient.readContract({
      address: settlementAddr,
      abi: orderSettlementAbi,
      functionName: 'getOrderFilledAmount',
      args: [orderHash],
    }),
    publicClient.readContract({
      address: getAddress(cfg.usdcAddress),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [normalizedOffer.lender],
    }),
    publicClient.readContract({
      address: getAddress(cfg.usdcAddress),
      abi: erc20Abi,
      functionName: 'allowance',
      args: [normalizedOffer.lender, loanCoreAddr],
    }),
  ]);

  if (cancelled) {
    throw new Error('OrderCancelledAlready: This LendOffer was cancelled on-chain.');
  }
  if (BigInt(makerNonce) !== normalizedOffer.nonce) {
    throw new Error(
      `InvalidNonce: LendOffer nonce (${normalizedOffer.nonce}) no longer matches lender maker nonce (${makerNonce}).`
    );
  }

  const filledBig = BigInt(filledRaw);
  const remainingBig = normalizedOffer.usdcAmount > filledBig ? normalizedOffer.usdcAmount - filledBig : 0n;
  if (remainingBig <= 0n) {
    throw new Error('OrderExceeded: LendOffer is already completely filled.');
  }

  const fillUsdcBig =
    fillUsdcRaw !== null && fillUsdcRaw !== undefined && String(fillUsdcRaw).trim() !== ''
      ? BigInt(fillUsdcRaw)
      : remainingBig;
  if (fillUsdcBig <= 0n) {
    throw new Error('Fill amount must be greater than zero.');
  }
  if (fillUsdcBig > remainingBig) {
    throw new Error(
      `OrderExceeded: Requested fill (${fillUsdcBig.toString()} raw) exceeds remaining capacity (${remainingBig.toString()} raw).`
    );
  }
  if (fillUsdcBig < normalizedOffer.minFill && fillUsdcBig !== remainingBig) {
    throw new Error(
      `FillAmountTooLow: Requested fill (${fillUsdcBig.toString()} raw) is below minFill (${normalizedOffer.minFill.toString()} raw).`
    );
  }
  if (BigInt(lenderUsdcBalance) < fillUsdcBig) {
    throw new Error(
      `ERC20InsufficientBalance: Lender USDC balance (${lenderUsdcBalance}) is below fill amount (${fillUsdcBig}).`
    );
  }
  if (BigInt(lenderUsdcAllowance) < fillUsdcBig) {
    throw new Error(
      `ERC20InsufficientAllowance: Lender LoanCore USDC allowance (${lenderUsdcAllowance}) is below fill amount (${fillUsdcBig}).`
    );
  }

  const borrowerAddr = borrowerAddress && isAddress(borrowerAddress) ? getAddress(borrowerAddress) : null;
  if (borrowerAddr && normalizedOffer.lender.toLowerCase() === borrowerAddr.toLowerCase()) {
    throw new Error('SelfLoanNotAllowed: Lender and borrower cannot be the same wallet address.');
  }
  if (cfg.contracts.eligibilityGate) {
    const gateAddr = getAddress(cfg.contracts.eligibilityGate);
    const lenderEligible = await publicClient.readContract({
      address: gateAddr,
      abi: eligibilityGateAbi,
      functionName: 'isEligible',
      args: [normalizedOffer.lender, cleanLenderAtt],
    });
    if (!lenderEligible) {
      throw new Error('IneligibleCounterparty: Lender is not eligible in EligibilityGate.');
    }
    if (borrowerAddr) {
      const borrowerEligible = await publicClient.readContract({
        address: gateAddr,
        abi: eligibilityGateAbi,
        functionName: 'isEligible',
        args: [borrowerAddr, cleanBorrowerAtt],
      });
      if (!borrowerEligible) {
        throw new Error('IneligibleCounterparty: Borrower is not eligible in EligibilityGate.');
      }
    }
  }

  const quote = await fetchLoanQuote({
    cfg,
    asset: token,
    principalRaw: fillUsdcBig.toString(),
    collateralAmountRaw: collateralAmountRaw ? String(collateralAmountRaw) : undefined,
    termDays: normalizedOffer.termDays,
    aprBps: normalizedOffer.minRateBps,
    maxLtvBps: normalizedOffer.maxLtvBps,
    borrower: borrowerAddr ?? undefined,
    lender: normalizedOffer.lender,
    borrowerAttestation: cleanBorrowerAtt,
    lenderAttestation: cleanLenderAtt,
  });
  if (!quote.accepted) {
    const reasons = (quote.rejection_reasons ?? []).map((r) => `${r.code}: ${r.message}`).join('; ');
    throw new Error(`LendOffer fill quote rejected: ${reasons || 'Unknown rejection'}`);
  }

  const exact = resolveExactBorrowAmounts(quote, {
    userCollateralRaw: collateralAmountRaw,
    bufferBps: collateralBufferBps,
  });

  const warnings = [...(quote.warnings ?? [])];
  const remainderAfterFillRaw = remainingBig - fillUsdcBig;
  if (remainderAfterFillRaw > 0n && remainderAfterFillRaw < PROTOCOL_MIN_FILL_USDC_RAW) {
    warnings.push({
      code: 'PARTIAL_REMAINDER_BELOW_500',
      message: `Filling ${formatTokenUnitsDisplay(fillUsdcBig, USDC_DECIMALS, 2)} USDC leaves ${formatTokenUnitsDisplay(remainderAfterFillRaw, USDC_DECIMALS, 2)} USDC remaining (< $500.00), which is unfillable on-chain (LoanCore PRINCIPAL_BELOW_MINIMUM) and can only be cancelled or expire.`,
    });
  }

  const useAttestations = cleanBorrowerAtt !== '0x' || cleanLenderAtt !== '0x';
  const fillCallData = useAttestations
    ? encodeFunctionData({
        abi: orderSettlementAbi,
        functionName: 'fillLendOfferWithAttestations',
        args: [
          normalizedOffer,
          sigHex,
          token,
          exact.collateralAmountRaw,
          fillUsdcBig,
          cleanBorrowerAtt,
          cleanLenderAtt,
        ],
      })
    : encodeFunctionData({
        abi: orderSettlementAbi,
        functionName: 'fillLendOffer',
        args: [normalizedOffer, sigHex, token, exact.collateralAmountRaw, fillUsdcBig],
      });

  let borrowerBalanceRaw = '0';
  let borrowerAllowanceRaw = '0';
  let existingOpenCollRawBig = BigInt(existingOpenCollateralRaw ?? 0n);
  let requiredApprovalRawBig = existingOpenCollRawBig + exact.collateralAmountRaw;
  let needsApproval = true;
  let simulationVerified = false;

  if (borrowerAddr) {
    existingOpenCollRawBig = await resolveOpenBorrowOrdersCollateralSumRaw({
      borrowerAddress: borrowerAddr,
      collateralToken: token,
      existingOpenCollateralRaw,
      storage,
      cfg,
      publicClient,
    });
    requiredApprovalRawBig = existingOpenCollRawBig + exact.collateralAmountRaw;

    const walletMeta = await readBorrowAllowanceAndNonce(borrowerAddr, token, {
      cfg,
      publicClient,
      attestationHex: cleanBorrowerAtt,
    });
    borrowerBalanceRaw = walletMeta.balanceRaw;
    borrowerAllowanceRaw = walletMeta.allowanceRaw;
    needsApproval = BigInt(borrowerAllowanceRaw) < requiredApprovalRawBig;

    if (BigInt(borrowerBalanceRaw) < exact.collateralAmountRaw) {
      throw new Error(
        `ERC20InsufficientBalance: Insufficient ${walletMeta.symbol} balance (${borrowerBalanceRaw} raw), need ${exact.collateralAmountRaw.toString()} raw.`
      );
    }

    try {
      await publicClient.call({
        account: borrowerAddr,
        to: settlementAddr,
        data: fillCallData,
      });
      simulationVerified = true;
    } catch (simErr) {
      const decoded = decodeContractRevert(simErr);
      if (!needsApproval || !isExpectedPreApprovalError(simErr, escrowAddr)) {
        throw new Error(decoded ? decoded.message : formatWeb3Error(simErr));
      }
      // In OrderSettlement + LoanCore.openLoan, all order/oracle/cap/LTV validations execute BEFORE
      // CollateralEscrow.depositCollateral transfers collateral, so reaching ERC20InsufficientAllowance
      // on CollateralEscrow means every pre-transfer check succeeded.
      simulationVerified = true;
    }
  }

  return {
    offer: normalizedOffer,
    offerJson: lendOfferToJson(normalizedOffer),
    signature: sigHex,
    orderHash,
    collateralToken: token,
    collateralSymbol: quote.asset?.symbol ?? 'B20',
    collateralDecimals: Number(quote.asset?.decimals ?? 18),
    lender: normalizedOffer.lender,
    rateBps: normalizedOffer.minRateBps,
    termDays: normalizedOffer.termDays,
    maxLtvBps: normalizedOffer.maxLtvBps,
    expiry: Number(normalizedOffer.expiry),
    nonce: normalizedOffer.nonce.toString(),
    usdcAmountRaw: normalizedOffer.usdcAmount.toString(),
    filledRaw: filledBig.toString(),
    remainingRaw: remainingBig.toString(),
    minFillRaw: normalizedOffer.minFill.toString(),
    fillAmountRaw: fillUsdcBig.toString(),
    remainderAfterFillRaw: remainderAfterFillRaw.toString(),
    lenderUsdcBalanceRaw: BigInt(lenderUsdcBalance).toString(),
    lenderUsdcAllowanceRaw: BigInt(lenderUsdcAllowance).toString(),
    borrowerBalanceRaw,
    borrowerAllowanceRaw,
    existingOpenCollateralRaw: existingOpenCollRawBig.toString(),
    requiredApprovalRaw: requiredApprovalRawBig.toString(),
    needsApproval,
    simulationVerified,
    warnings,
    quote,
    exact,
    fillCallData,
  };
}

/**
 * @param {{
 *   address: string,
 *   offer: any,
 *   signature: `0x${string}`,
 *   collateralToken: string,
 *   fillUsdcRaw: string | bigint,
 *   collateralAmountRaw?: string | bigint | null,
 *   collateralBufferBps?: number,
 *   existingOpenCollateralRaw?: string | bigint | null,
 *   storage?: any,
 *   expectedPreview?: any,
 *   borrowerAttestation?: string,
 *   lenderAttestation?: string,
 *   autoApprove?: boolean,
 *   provider?: any,
 *   cfg?: any,
 *   publicClient?: any
 * }} opts
 */
export async function fillLendOfferAsBorrower({
  address,
  offer,
  signature,
  collateralToken,
  fillUsdcRaw,
  collateralAmountRaw = null,
  collateralBufferBps = DEFAULT_COLLATERAL_BUFFER_BPS,
  existingOpenCollateralRaw = null,
  storage = null,
  expectedPreview = null,
  borrowerAttestation = '0x',
  lenderAttestation = '0x',
  autoApprove = true,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!cfg.contracts.orderSettlement || !cfg.contracts.collateralEscrow) {
    throw new Error('OrderSettlement or CollateralEscrow address is not configured.');
  }
  const wallet = await assertActiveWalletAndChain(provider, address, cfg.chainId);
  const settlementAddr = getAddress(cfg.contracts.orderSettlement);

  const preview = await verifyAndPreviewLendOfferFill({
    offer,
    signature,
    collateralToken,
    fillUsdcRaw,
    collateralAmountRaw,
    collateralBufferBps,
    existingOpenCollateralRaw,
    storage,
    borrowerAddress: wallet,
    borrowerAttestation,
    lenderAttestation,
    cfg,
    publicClient,
  });

  if (expectedPreview) {
    const expExact = expectedPreview.exact ?? {};
    const curExact = preview.exact;
    if (
      String(expExact.collateralAmountRaw ?? '') !== curExact.collateralAmountRaw.toString() ||
      String(expectedPreview.fillAmountRaw ?? '') !== preview.fillAmountRaw ||
      String(expExact.netProceedsRaw ?? '') !== curExact.netProceedsRaw.toString() ||
      String(expExact.totalRepaymentAtMaturityRaw ?? '') !== curExact.totalRepaymentAtMaturityRaw.toString() ||
      String(expectedPreview.quote?.asset?.oracle_state ?? '') !== String(preview.quote?.asset?.oracle_state ?? '')
    ) {
      throw new Error(
        'Quote or offer fill state changed since preview. Re-verify the LendOffer terms before filling.'
      );
    }
  }

  let approvalTxHash = null;
  if (preview.needsApproval) {
    if (!autoApprove) {
      throw new Error(
        `CollateralEscrow allowance is below required ${preview.requiredApprovalRaw} raw units (covers open BorrowOrders + fill collateral); approve collateral first.`
      );
    }
    const appRes = await approveCollateralForBorrow({
      address: wallet,
      collateralToken: preview.collateralToken,
      requiredCollateralRaw: preview.requiredApprovalRaw,
      provider,
      cfg,
      publicClient,
    });
    approvalTxHash = appRes.txHash;
  }

  // Final eth_call simulation with active allowance before sending fill transaction
  try {
    await publicClient.call({
      account: wallet,
      to: settlementAddr,
      data: preview.fillCallData,
    });
  } catch (simErr) {
    const decoded = decodeContractRevert(simErr);
    throw new Error(decoded ? decoded.message : formatWeb3Error(simErr));
  }

  const { txHash, receipt } = await sendWalletTransaction(provider, publicClient, {
    from: wallet,
    to: settlementAddr,
    data: preview.fillCallData,
  });

  const loanId = decodeOrderFilledLoanId(receipt, settlementAddr);
  if (!loanId) {
    throw new Error('OrderFilled event missing loanId after fillLendOffer transaction.');
  }

  return {
    txHash,
    approvalTxHash,
    receipt,
    loanId,
    quote: preview.quote,
    exact: preview.exact,
    preview,
    collateralAmountRaw: preview.exact.collateralAmountRaw.toString(),
    existingOpenCollateralRaw: preview.existingOpenCollateralRaw,
    requiredApprovalRaw: preview.requiredApprovalRaw,
    fillUsdcRaw: preview.fillAmountRaw,
  };
}

function decodeOrderFilledLoanId(receipt, settlementAddr) {
  for (const log of receipt?.logs ?? []) {
    if (log.address?.toLowerCase() !== settlementAddr.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: orderSettlementAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'OrderFilled' && decoded.args?.loanId !== undefined) {
        return decoded.args.loanId.toString();
      }
    } catch {
      // ignore non-matching logs
    }
  }
  return null;
}

function isExpectedPreApprovalError(simErr, expectedSpender) {
  const decoded = decodeContractRevert(simErr);
  const rawText = [simErr?.details, simErr?.shortMessage, simErr?.message]
    .filter((v) => typeof v === 'string')
    .join(' ');
  return Boolean(
    (decoded?.errorName === 'ERC20InsufficientAllowance' &&
      (!decoded.args?.[0] || String(decoded.args[0]).toLowerCase() === expectedSpender.toLowerCase())) ||
      (!decoded && /(InsufficientAllowance|transfer amount exceeds allowance)/i.test(rawText))
  );
}

export async function refreshSignedLendOffersState({
  offers,
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!Array.isArray(offers) || offers.length === 0) return [];
  if (!cfg?.contracts?.orderSettlement) return offers;
  const settlementAddr = getAddress(cfg.contracts.orderSettlement);
  const blk = await publicClient.getBlock({ blockTag: 'latest' });

  return Promise.all(
    offers.map(async (item) => {
      try {
        const offerObj = item.offerJson ?? item.orderJson ?? item.order;
        const normalized = normalizeLendOfferStruct(offerObj);
        const computedHash = await publicClient.readContract({
          address: settlementAddr,
          abi: orderSettlementAbi,
          functionName: 'hashLendOffer',
          args: [normalized],
        });
        const [cancelled, filledRaw, currentMakerNonce] = await Promise.all([
          publicClient.readContract({
            address: settlementAddr,
            abi: orderSettlementAbi,
            functionName: 'isOrderCancelled',
            args: [computedHash],
          }),
          publicClient.readContract({
            address: settlementAddr,
            abi: orderSettlementAbi,
            functionName: 'getOrderFilledAmount',
            args: [computedHash],
          }),
          publicClient.readContract({
            address: settlementAddr,
            abi: orderSettlementAbi,
            functionName: 'getMakerNonce',
            args: [normalized.lender],
          }),
        ]);

        const totalUsdc = normalized.usdcAmount;
        const filled = BigInt(filledRaw);
        const remaining = totalUsdc > filled ? totalUsdc - filled : 0n;
        const expired = normalized.expiry <= blk.timestamp;
        const nonceBumped = BigInt(currentMakerNonce) !== normalized.nonce;
        const onchainStatus = cancelled
          ? 'cancelled'
          : nonceBumped
            ? 'nonce_bumped'
            : remaining === 0n
              ? 'filled'
              : expired
                ? 'expired'
                : filled > 0n
                  ? 'partially_filled'
                  : 'open';

        return {
          ...item,
          orderHash: computedHash,
          offerJson: lendOfferToJson(normalized),
          filledRaw: filled.toString(),
          remainingRaw: remaining.toString(),
          cancelled: Boolean(cancelled),
          expired,
          nonceBumped,
          currentMakerNonce: BigInt(currentMakerNonce).toString(),
          onchainStatus,
        };
      } catch (err) {
        return {
          ...item,
          onchainStatus: 'unknown',
          stateError: formatWeb3Error(err),
        };
      }
    })
  );
}

/**
 * Computes exact pro-rata collateral required on-chain for a partial/full BorrowOrder fill
 * (`ceil(collateralAmount * fillUsdc / minUsdc)` matching OrderSettlement.sol).
 */
export function computeBorrowCollateralForFill(collateralAmountRaw, totalUsdcRaw, fillUsdcRaw) {
  const collateral = BigInt(collateralAmountRaw);
  const total = BigInt(totalUsdcRaw);
  const fill = BigInt(fillUsdcRaw);
  if (collateral <= 0n || total <= 0n || fill <= 0n) {
    throw new Error('Collateral, principal, and fill raw amounts must be positive.');
  }
  return (collateral * fill + (total - 1n)) / total;
}

export function sumOpenSignedLendOffersRaw(offers, lenderAddress = null, { includeUnknown = true } = {}) {
  if (!Array.isArray(offers) || offers.length === 0) return 0n;
  const targetLender =
    lenderAddress && isAddress(lenderAddress) ? getAddress(lenderAddress).toLowerCase() : null;
  return offers.reduce((acc, item) => {
    const st = item?.onchainStatus ?? item?.status;
    if (st !== 'open' && st !== 'partially_filled' && !(includeUnknown && st === 'unknown')) {
      return acc;
    }
    if (targetLender) {
      const maker = String(
        item?.offer?.lender ?? item?.offerJson?.lender ?? item?.lender ?? item?.maker ?? ''
      ).toLowerCase();
      if (maker && maker !== targetLender) return acc;
    }
    return (
      acc +
      BigInt(
        item?.remainingRaw ??
          item?.remaining_usdc?.raw ??
          item?.offer?.usdcAmount ??
          item?.offerJson?.usdcAmount ??
          item?.min_usdc?.raw ??
          0n
      )
    );
  }, 0n);
}

async function resolveOpenLendOffersSumRaw({
  lenderAddress,
  existingOpenSumRaw = null,
  storage = null,
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (existingOpenSumRaw !== null && existingOpenSumRaw !== undefined) {
    return BigInt(existingOpenSumRaw);
  }
  if (!lenderAddress) return 0n;
  const targetChecksum = getAddress(lenderAddress);
  const targetLender = targetChecksum.toLowerCase();
  const seenHashes = new Set();
  let total = 0n;

  const persisted = loadPersistedSignedLendOffers(storage);
  const mine = persisted.filter((item) => {
    const maker = String(
      item?.offer?.lender ?? item?.offerJson?.lender ?? item?.lender ?? ''
    ).toLowerCase();
    return !maker || maker === targetLender;
  });
  if (mine.length > 0) {
    const synced = await refreshSignedLendOffersState({ offers: mine, cfg, publicClient });
    for (const item of synced) {
      const h = String(item?.orderHash ?? '').toLowerCase();
      if (h) seenHashes.add(h);
      if (item?.onchainStatus === 'unknown') {
        throw new Error(
          `Cannot verify open LendOffer ${item.orderHash ?? ''} status on-chain (${item.stateError ?? 'unknown'}); supply existingOpenSumRaw or retry when RPC recovers.`
        );
      }
      if (item?.onchainStatus === 'open' || item?.onchainStatus === 'partially_filled') {
        total += BigInt(item?.remainingRaw ?? item?.offer?.usdcAmount ?? item?.offerJson?.usdcAmount ?? 0n);
      }
    }
  }

  if (cfg?.apiUrl) {
    const relayRes = await fetchPaginatedApiRows(
      `${cfg.apiUrl}/orders?order_type=lend&maker=${targetChecksum}`,
      { cfg }
    );
    for (const row of relayRes.rows ?? []) {
      if (String(row?.maker ?? '').toLowerCase() !== targetLender) continue;
      if (row?.order_type !== 'lend' && row?.order_type !== 'LendOffer') continue;
      if (!row?.signed_order || !row?.signature) continue;
      const h = String(row?.order_hash ?? '').toLowerCase();
      if (h && seenHashes.has(h)) continue;
      if (h) seenHashes.add(h);
      if (row?.status === 'open' || row?.status === 'partially_filled' || row?.status === 'unknown') {
        total += BigInt(row?.remaining_usdc?.raw ?? row?.min_usdc?.raw ?? 0n);
      }
    }
  }

  return total;
}

async function resolveQuoteAssetForLendOffer({
  allowedCollateral,
  quoteAsset = null,
  cfg = getFrontendConfig(),
  fetchImpl = globalThis.fetch,
}) {
  if (allowedCollateral && allowedCollateral !== zeroAddress) {
    return getAddress(allowedCollateral);
  }
  if (quoteAsset && isAddress(quoteAsset) && quoteAsset !== zeroAddress) {
    return getAddress(quoteAsset);
  }
  if (!cfg?.apiUrl || typeof fetchImpl !== 'function') {
    throw new Error('Configure VITE_API_URL or provide an active registered collateral asset.');
  }
  const assetsRes = await fetchJsonStrict(`${cfg.apiUrl}/assets`, { method: 'GET' }, 8000, fetchImpl);
  const rows = Array.isArray(assetsRes?.data) ? assetsRes.data : [];
  const active = rows.find((a) => Number(a?.status) === 0 && isAddress(a?.token));
  const fallback = rows.find((a) => isAddress(a?.token));
  const chosen = active ?? fallback;
  if (!chosen) {
    throw new Error('No registered collateral assets returned by api/ /assets.');
  }
  return getAddress(chosen.token);
}

export async function prepareAndSignLendOffer({
  address,
  principalRaw,
  allowedCollateral = zeroAddress,
  quoteAsset = null,
  expectedQuote = null,
  requireExpectedQuote = true,
  minRateBps,
  termDays,
  maxLtvBps = 6000,
  minFillRaw = null,
  expiryDays = 2,
  expiryTimestamp = null,
  yieldMode = 0,
  perFillUsdcRawList = null,
  existingOpenUsdcSumRaw = 0n,
  attestationHex = '0x',
  autoApprove = true,
  publishToApi = true,
  fetchImpl = globalThis.fetch,
  storage = null,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!cfg.contracts.orderSettlement || !cfg.contracts.loanCore || !cfg.usdcAddress) {
    throw new Error('OrderSettlement, LoanCore, or USDC address is not configured.');
  }
  const wallet = await assertActiveWalletAndChain(provider, address, cfg.chainId);
  const normalizedAllowed =
    allowedCollateral && allowedCollateral !== zeroAddress ? getAddress(allowedCollateral) : zeroAddress;
  const walletMeta = await readLendAllowanceAndNonce(wallet, {
    cfg,
    publicClient,
    attestationHex,
  });
  if (walletMeta.eligibility && !walletMeta.eligibility.isEligible) {
    throw new Error(
      'IneligibleCounterparty: Connected wallet is not eligible on-chain in EligibilityGate.'
    );
  }

  const assetForQuote = await resolveQuoteAssetForLendOffer({
    allowedCollateral: normalizedAllowed,
    quoteAsset,
    cfg,
    fetchImpl,
  });

  const quote = await fetchLoanQuote({
    cfg,
    asset: assetForQuote,
    principalRaw: BigInt(principalRaw).toString(),
    termDays: Number(termDays),
    aprBps: Number(minRateBps),
    maxLtvBps: maxLtvBps !== null && maxLtvBps !== undefined ? Number(maxLtvBps) : undefined,
    lender: wallet,
    lenderAttestation: attestationHex,
  });

  const minFillBig = BigInt(minFillRaw ?? quote?.amounts?.principal?.raw ?? principalRaw);
  const perLoanCapRaw = BigInt(quote?.caps?.per_loan_cap?.raw ?? 0n);
  const blockingRejections = (quote.rejection_reasons ?? []).filter((r) => {
    if (
      r.code === 'PER_LOAN_CAP_EXCEEDED' &&
      minFillBig >= 500_000_000n &&
      minFillBig < BigInt(quote?.amounts?.principal?.raw ?? 0n) &&
      (perLoanCapRaw === 0n || minFillBig <= perLoanCapRaw)
    ) {
      return false;
    }
    if (r.code === 'LTV_EXCEEDED' && quote?.amounts?.collateral_required?.raw === '0') {
      return false;
    }
    return true;
  });
  if (!quote.accepted && blockingRejections.length > 0) {
    const reasons = blockingRejections.map((r) => `${r.code}: ${r.message}`).join('; ');
    throw new Error(`Quote rejected by on-chain protocol rules: ${reasons}`);
  }
  assertExpectedQuoteUnchanged(expectedQuote, quote, { requireExpectedQuote });

  const exact = resolveExactLendAmounts(quote, {
    minFillRaw: minFillBig,
    perFillUsdcRawList,
    existingOpenSumRaw: existingOpenUsdcSumRaw ?? 0n,
  });
  if (minFillBig < 500_000_000n) {
    throw new Error('Minimum fill cannot be below $500.00 (500000000 raw USDC).');
  }
  if (minFillBig > exact.principalRaw) {
    throw new Error('Minimum fill cannot exceed offered USDC principal.');
  }

  if (BigInt(walletMeta.balanceRaw) < exact.requiredApprovalRaw) {
    throw new Error(
      `Insufficient ${walletMeta.symbol} balance: have ${walletMeta.balanceRaw} raw units, need ${exact.requiredApprovalRaw.toString()} raw units (covering offer/partial fills${exact.existingOpenSumRaw > 0n ? ' plus existing open offers' : ''}).`
    );
  }

  let approvalTxHash = null;
  if (BigInt(walletMeta.allowanceRaw) < exact.requiredApprovalRaw) {
    if (!autoApprove) {
      throw new Error(
        `LoanCore USDC allowance is below required ${exact.requiredApprovalRaw.toString()} raw units; approve USDC to LoanCore first.`
      );
    }
    const appRes = await approveUsdcForLend({
      address: wallet,
      requiredUsdcRaw: exact.requiredApprovalRaw,
      provider,
      cfg,
      publicClient,
    });
    approvalTxHash = appRes.txHash;
  }

  let expiryBig;
  if (expiryTimestamp !== null && expiryTimestamp !== undefined) {
    expiryBig = BigInt(expiryTimestamp);
  } else {
    const expDaysInt = Number(expiryDays);
    if (!Number.isInteger(expDaysInt) || expDaysInt < 1 || expDaysInt > 30) {
      throw new Error('Order expiry must be between 1 and 30 days.');
    }
    const blk = await publicClient.getBlock();
    expiryBig = blk.timestamp + BigInt(expDaysInt) * 86_400n;
  }

  const effectiveLtv = Number(quote.asset?.allowed_ltv_bps ?? maxLtvBps ?? 6000);
  const offer = normalizeLendOfferStruct({
    lender: wallet,
    usdcAmount: exact.principalRaw,
    minRateBps: Number(minRateBps),
    termDays: Number(termDays),
    allowedCollateral: normalizedAllowed,
    maxLtvBps: effectiveLtv,
    minFill: minFillBig,
    expiry: expiryBig,
    nonce: BigInt(walletMeta.makerNonce),
    yieldMode: Number(yieldMode ?? 0),
  });

  const typedData = buildLendOfferTypedData({ offer, cfg });
  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [wallet, serializeTypedDataForRpc(typedData)],
  });
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error('Wallet returned an invalid EIP-712 signature.');
  }

  await assertActiveWalletAndChain(provider, wallet, cfg.chainId);

  const orderHash = await publicClient.readContract({
    address: getAddress(cfg.contracts.orderSettlement),
    abi: orderSettlementAbi,
    functionName: 'hashLendOffer',
    args: [offer],
  });
  const recovered = await recoverAddress({ hash: orderHash, signature });
  if (recovered.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error(`Signature signer mismatch: recovered ${recovered}, expected ${wallet}.`);
  }

  const offerJson = lendOfferToJson(offer);
  const exactAmounts = {
    principalRaw: exact.principalRaw.toString(),
    minFillRaw: exact.minFillRaw.toString(),
    plannedFillsSumRaw: exact.plannedFillsSum.toString(),
    existingOpenSumRaw: exact.existingOpenSumRaw.toString(),
    requiredApprovalRaw: exact.requiredApprovalRaw.toString(),
    originationFeeRaw: exact.originationFeeRaw.toString(),
    netProceedsRaw: exact.netProceedsRaw.toString(),
    interestMaturityRaw: exact.interestMaturityRaw.toString(),
    protocolInterestCutRaw: exact.protocolInterestCutRaw.toString(),
    lenderNetInterestRaw: exact.lenderNetInterestRaw.toString(),
    totalRepaymentAtMaturityRaw: exact.totalRepaymentAtMaturityRaw.toString(),
  };

  let publishedToApi = false;
  let publishError = '';
  let apiOrder = null;
  if (publishToApi && cfg.apiUrl) {
    try {
      apiOrder = await publishSignedOrderToApi({
        orderType: 'lend',
        order: offer,
        signature,
        cfg,
        fetchImpl,
      });
      publishedToApi = true;
    } catch (err) {
      publishError = formatWeb3Error(err);
    }
  }

  saveSignedLendOffer(
    {
      orderHash,
      offerJson,
      signature,
      approvalTxHash,
      cancelledTxHash: null,
      createdAt: new Date().toISOString(),
      publishedToApi,
      publishError,
      exactAmounts,
    },
    storage
  );

  return {
    quote,
    offer,
    offerJson,
    orderHash,
    signature: /** @type {`0x${string}`} */ (signature),
    approvalTxHash,
    publishedToApi,
    publishError,
    apiOrder,
    exactAmounts,
  };
}

export async function cancelSignedLendOffer({
  address,
  offer,
  storage = null,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!cfg.contracts.orderSettlement) {
    throw new Error('OrderSettlement contract address is not configured.');
  }
  const wallet = await assertActiveWalletAndChain(provider, address, cfg.chainId);
  const normalized = normalizeLendOfferStruct(offer);
  if (normalized.lender.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error('Only the lend offer maker can cancel this offer.');
  }
  const settlementAddr = getAddress(cfg.contracts.orderSettlement);
  const orderHash = await publicClient.readContract({
    address: settlementAddr,
    abi: orderSettlementAbi,
    functionName: 'hashLendOffer',
    args: [normalized],
  });
  const data = encodeFunctionData({
    abi: orderSettlementAbi,
    functionName: 'cancelLendOffer',
    args: [normalized],
  });
  const { txHash, receipt } = await sendWalletTransaction(provider, publicClient, {
    from: wallet,
    to: settlementAddr,
    data,
  });

  const existing = loadPersistedSignedLendOffers(storage).find(
    (item) => String(item?.orderHash ?? '').toLowerCase() === orderHash.toLowerCase()
  );
  if (existing) {
    saveSignedLendOffer(
      {
        ...existing,
        cancelledTxHash: txHash,
        cancelled: true,
        onchainStatus: 'cancelled',
      },
      storage
    );
  }

  return { txHash, receipt, orderHash };
}

/**
 * Full pre-approval verification and eth_call simulation for filling a BorrowOrder as lender.
 * Catches expired, cancelled, wrong-nonce, invalid-sig, exceeded, minFill, borrower collateral
 * funding, eligibility, and LTV reverts BEFORE asking the lender for an ERC-20 approve transaction.
 */
export async function verifyAndPreviewBorrowOrderFill({
  order,
  signature,
  fillUsdcRaw = null,
  perFillUsdcRawList = null,
  existingOpenSumRaw = null,
  storage = null,
  lenderAddress = null,
  borrowerAttestation = '0x',
  lenderAttestation = '0x',
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (
    !cfg?.contracts?.orderSettlement ||
    !cfg?.contracts?.collateralEscrow ||
    !cfg?.contracts?.loanCore ||
    !cfg?.usdcAddress
  ) {
    throw new Error('OrderSettlement, CollateralEscrow, LoanCore, or USDC address is not configured.');
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(signature.trim())) {
    throw new Error('InvalidSignature: BorrowOrder signature must be a valid 0x-prefixed hex signature.');
  }

  const normalizedOrder = normalizeBorrowOrderStruct(order);
  const sigHex = /** @type {`0x${string}`} */ (signature.trim());
  const settlementAddr = getAddress(cfg.contracts.orderSettlement);
  const loanCoreAddr = getAddress(cfg.contracts.loanCore);
  const escrowAddr = getAddress(cfg.contracts.collateralEscrow);
  const usdcAddr = getAddress(cfg.usdcAddress);
  const cleanBorrowerAtt = normalizeAttestationHex(borrowerAttestation);
  const cleanLenderAtt = normalizeAttestationHex(lenderAttestation);

  const [blk, orderHash] = await Promise.all([
    publicClient.getBlock({ blockTag: 'latest' }),
    publicClient.readContract({
      address: settlementAddr,
      abi: orderSettlementAbi,
      functionName: 'hashBorrowOrder',
      args: [normalizedOrder],
    }),
  ]);

  let recovered;
  try {
    recovered = await recoverAddress({ hash: orderHash, signature: sigHex });
  } catch {
    throw new Error('InvalidSignature: Malformed EIP-712 BorrowOrder signature.');
  }
  if (recovered.toLowerCase() !== normalizedOrder.borrower.toLowerCase()) {
    throw new Error(
      `InvalidSignature: Signature recovered ${recovered}, expected borrower ${normalizedOrder.borrower}.`
    );
  }

  if (normalizedOrder.expiry <= blk.timestamp) {
    throw new Error('OrderExpired: This BorrowOrder has already expired on-chain.');
  }

  const [cancelled, makerNonce, filledRaw, borrowerCollBalance, borrowerCollAllowance] =
    await Promise.all([
      publicClient.readContract({
        address: settlementAddr,
        abi: orderSettlementAbi,
        functionName: 'isOrderCancelled',
        args: [orderHash],
      }),
      publicClient.readContract({
        address: settlementAddr,
        abi: orderSettlementAbi,
        functionName: 'getMakerNonce',
        args: [normalizedOrder.borrower],
      }),
      publicClient.readContract({
        address: settlementAddr,
        abi: orderSettlementAbi,
        functionName: 'getOrderFilledAmount',
        args: [orderHash],
      }),
      publicClient.readContract({
        address: normalizedOrder.collateralToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [normalizedOrder.borrower],
      }),
      publicClient.readContract({
        address: normalizedOrder.collateralToken,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [normalizedOrder.borrower, escrowAddr],
      }),
    ]);

  if (cancelled) {
    throw new Error('OrderCancelledAlready: This BorrowOrder was cancelled on-chain.');
  }
  if (BigInt(makerNonce) !== normalizedOrder.nonce) {
    throw new Error(
      `InvalidNonce: BorrowOrder nonce (${normalizedOrder.nonce}) no longer matches borrower maker nonce (${makerNonce}).`
    );
  }

  const filledBig = BigInt(filledRaw);
  const remainingBig =
    normalizedOrder.minUsdc > filledBig ? normalizedOrder.minUsdc - filledBig : 0n;
  if (remainingBig <= 0n) {
    throw new Error('OrderExceeded: BorrowOrder is already completely filled.');
  }

  const fillUsdcBig =
    fillUsdcRaw !== null && fillUsdcRaw !== undefined && String(fillUsdcRaw).trim() !== ''
      ? BigInt(fillUsdcRaw)
      : remainingBig;
  if (fillUsdcBig <= 0n) {
    throw new Error('Fill amount must be greater than zero.');
  }
  if (fillUsdcBig > remainingBig) {
    throw new Error(
      `OrderExceeded: Requested fill (${fillUsdcBig.toString()} raw) exceeds remaining capacity (${remainingBig.toString()} raw).`
    );
  }
  if (fillUsdcBig < normalizedOrder.minFill && fillUsdcBig !== remainingBig) {
    throw new Error(
      `FillAmountTooLow: Requested fill (${fillUsdcBig.toString()} raw) is below minFill (${normalizedOrder.minFill.toString()} raw).`
    );
  }

  const collateralForFillBig = computeBorrowCollateralForFill(
    normalizedOrder.collateralAmount,
    normalizedOrder.minUsdc,
    fillUsdcBig
  );

  if (BigInt(borrowerCollBalance) < collateralForFillBig) {
    throw new Error(
      `ERC20InsufficientBalance: Borrower collateral balance (${borrowerCollBalance}) is below pro-rata collateral required (${collateralForFillBig}).`
    );
  }
  if (BigInt(borrowerCollAllowance) < collateralForFillBig) {
    throw new Error(
      `ERC20InsufficientAllowance: Borrower CollateralEscrow allowance (${borrowerCollAllowance}) is below pro-rata collateral required (${collateralForFillBig}).`
    );
  }

  const lenderAddr = lenderAddress && isAddress(lenderAddress) ? getAddress(lenderAddress) : null;
  if (lenderAddr && normalizedOrder.borrower.toLowerCase() === lenderAddr.toLowerCase()) {
    throw new Error('SelfLoanNotAllowed: Lender and borrower cannot be the same wallet address.');
  }
  const resolvedExistingOpenSumRaw = await resolveOpenLendOffersSumRaw({
    lenderAddress: lenderAddr,
    existingOpenSumRaw,
    storage,
    cfg,
    publicClient,
  });
  const approvalSizing = computeLendApprovalAmountRaw(fillUsdcBig, {
    perFillUsdcRawList,
    existingOpenSumRaw: resolvedExistingOpenSumRaw,
    minFillRaw: normalizedOrder.minFill,
    maxAllowedTotalRaw: remainingBig,
    matchCurrentFillFirst: true,
  });
  if (cfg.contracts.eligibilityGate) {
    const gateAddr = getAddress(cfg.contracts.eligibilityGate);
    const borrowerEligible = await publicClient.readContract({
      address: gateAddr,
      abi: eligibilityGateAbi,
      functionName: 'isEligible',
      args: [normalizedOrder.borrower, cleanBorrowerAtt],
    });
    if (!borrowerEligible) {
      throw new Error('IneligibleCounterparty: Borrower is not eligible in EligibilityGate.');
    }
    if (lenderAddr) {
      const lenderEligible = await publicClient.readContract({
        address: gateAddr,
        abi: eligibilityGateAbi,
        functionName: 'isEligible',
        args: [lenderAddr, cleanLenderAtt],
      });
      if (!lenderEligible) {
        throw new Error('IneligibleCounterparty: Connected lender is not eligible in EligibilityGate.');
      }
    }
  }

  const quote = await fetchLoanQuote({
    cfg,
    asset: normalizedOrder.collateralToken,
    principalRaw: fillUsdcBig.toString(),
    collateralAmountRaw: collateralForFillBig.toString(),
    termDays: normalizedOrder.termDays,
    aprBps: normalizedOrder.maxRateBps,
    maxLtvBps: normalizedOrder.maxLtvBps,
    borrower: normalizedOrder.borrower,
    lender: lenderAddr ?? undefined,
    borrowerAttestation: cleanBorrowerAtt,
    lenderAttestation: cleanLenderAtt,
  });
  if (!quote.accepted) {
    const reasons = (quote.rejection_reasons ?? []).map((r) => `${r.code}: ${r.message}`).join('; ');
    throw new Error(`BorrowOrder fill quote rejected: ${reasons || 'Unknown rejection'}`);
  }

  const exact = resolveExactLendAmounts(quote, {
    minFillRaw: normalizedOrder.minFill,
  });
  const warnings = [...(quote.warnings ?? [])];
  const remainderAfterFillRaw = remainingBig - fillUsdcBig;
  if (remainderAfterFillRaw > 0n && remainderAfterFillRaw < PROTOCOL_MIN_FILL_USDC_RAW) {
    warnings.push({
      code: 'PARTIAL_REMAINDER_BELOW_500',
      message: `Filling ${formatTokenUnitsDisplay(fillUsdcBig, USDC_DECIMALS, 2)} USDC leaves ${formatTokenUnitsDisplay(remainderAfterFillRaw, USDC_DECIMALS, 2)} USDC remaining (< $500.00), which is unfillable on-chain (LoanCore PRINCIPAL_BELOW_MINIMUM) and can only be cancelled or expire.`,
    });
  }
  if (approvalSizing.remainderWarning) {
    warnings.push({
      code: 'PLAN_REMAINDER_BELOW_500',
      message: approvalSizing.remainderWarning,
    });
  }

  const useAttestations = cleanBorrowerAtt !== '0x' || cleanLenderAtt !== '0x';
  const fillCallData = useAttestations
    ? encodeFunctionData({
        abi: orderSettlementAbi,
        functionName: 'fillBorrowOrderWithAttestations',
        args: [normalizedOrder, sigHex, fillUsdcBig, cleanBorrowerAtt, cleanLenderAtt],
      })
    : encodeFunctionData({
        abi: orderSettlementAbi,
        functionName: 'fillBorrowOrder',
        args: [normalizedOrder, sigHex, fillUsdcBig],
      });

  let lenderBalanceRaw = '0';
  let lenderAllowanceRaw = '0';
  let needsApproval = true;
  let simulationVerified = false;

  if (lenderAddr) {
    const [bal, allow] = await Promise.all([
      publicClient.readContract({
        address: usdcAddr,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [lenderAddr],
      }),
      publicClient.readContract({
        address: usdcAddr,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [lenderAddr, loanCoreAddr],
      }),
    ]);
    lenderBalanceRaw = BigInt(bal).toString();
    lenderAllowanceRaw = BigInt(allow).toString();
    needsApproval = BigInt(allow) < approvalSizing.requiredApprovalRaw;

    if (BigInt(bal) < fillUsdcBig) {
      throw new Error(
        `ERC20InsufficientBalance: Insufficient USDC balance (${lenderBalanceRaw} raw), need ${fillUsdcBig.toString()} raw.`
      );
    }

    try {
      await publicClient.call({
        account: lenderAddr,
        to: settlementAddr,
        data: fillCallData,
      });
      simulationVerified = true;
    } catch (simErr) {
      const decoded = decodeContractRevert(simErr);
      if (!needsApproval || !isExpectedPreApprovalError(simErr, loanCoreAddr)) {
        throw new Error(decoded ? decoded.message : formatWeb3Error(simErr));
      }
      simulationVerified = true;
    }
  }

  return {
    order: normalizedOrder,
    orderJson: borrowOrderToJson(normalizedOrder),
    signature: sigHex,
    orderHash,
    collateralToken: normalizedOrder.collateralToken,
    collateralSymbol: quote.asset?.symbol ?? 'B20',
    collateralDecimals: Number(quote.asset?.decimals ?? 18),
    borrower: normalizedOrder.borrower,
    rateBps: normalizedOrder.maxRateBps,
    termDays: normalizedOrder.termDays,
    maxLtvBps: normalizedOrder.maxLtvBps,
    expiry: Number(normalizedOrder.expiry),
    nonce: normalizedOrder.nonce.toString(),
    totalUsdcRaw: normalizedOrder.minUsdc.toString(),
    filledRaw: filledBig.toString(),
    remainingRaw: remainingBig.toString(),
    minFillRaw: normalizedOrder.minFill.toString(),
    fillAmountRaw: fillUsdcBig.toString(),
    collateralForFillRaw: collateralForFillBig.toString(),
    remainderAfterFillRaw: remainderAfterFillRaw.toString(),
    borrowerCollateralBalanceRaw: BigInt(borrowerCollBalance).toString(),
    borrowerCollateralAllowanceRaw: BigInt(borrowerCollAllowance).toString(),
    lenderBalanceRaw,
    lenderAllowanceRaw,
    existingOpenSumRaw: approvalSizing.existingOpenSumRaw.toString(),
    plannedFillsSumRaw: approvalSizing.plannedFillsSum.toString(),
    requiredApprovalRaw: approvalSizing.requiredApprovalRaw.toString(),
    needsApproval,
    simulationVerified,
    warnings,
    quote,
    exact: {
      ...exact,
      collateralForFillRaw: collateralForFillBig,
    },
    fillCallData,
  };
}

export async function fillBorrowOrderAsLender({
  address,
  order,
  signature,
  fillUsdcRaw = null,
  perFillUsdcRawList = null,
  existingOpenSumRaw = null,
  storage = null,
  expectedPreview = null,
  borrowerAttestation = '0x',
  lenderAttestation = '0x',
  autoApprove = true,
  provider = getInjectedProvider(),
  cfg = getFrontendConfig(),
  publicClient = createProtocolPublicClient(cfg),
}) {
  if (!cfg.contracts.orderSettlement || !cfg.contracts.loanCore || !cfg.usdcAddress) {
    throw new Error('OrderSettlement, LoanCore, or USDC address is not configured.');
  }
  const wallet = await assertActiveWalletAndChain(provider, address, cfg.chainId);
  const settlementAddr = getAddress(cfg.contracts.orderSettlement);

  const preview = await verifyAndPreviewBorrowOrderFill({
    order,
    signature,
    fillUsdcRaw,
    perFillUsdcRawList,
    existingOpenSumRaw,
    storage,
    lenderAddress: wallet,
    borrowerAttestation,
    lenderAttestation,
    cfg,
    publicClient,
  });

  if (expectedPreview) {
    const expExact = expectedPreview.exact ?? {};
    const curExact = preview.exact;
    if (
      String(expectedPreview.fillAmountRaw ?? '') !== preview.fillAmountRaw ||
      String(expectedPreview.collateralForFillRaw ?? '') !== preview.collateralForFillRaw ||
      String(expExact.lenderNetInterestRaw ?? '') !== curExact.lenderNetInterestRaw.toString() ||
      String(expectedPreview.quote?.asset?.oracle_state ?? '') !==
        String(preview.quote?.asset?.oracle_state ?? '')
    ) {
      throw new Error(
        'Quote or BorrowOrder fill state changed since preview. Re-verify the BorrowOrder terms before filling.'
      );
    }
  }

  const requiredApprovalRaw = BigInt(preview.requiredApprovalRaw);
  let approvalTxHash = null;
  if (BigInt(preview.lenderAllowanceRaw) < requiredApprovalRaw) {
    if (!autoApprove) {
      throw new Error(
        `LoanCore USDC allowance is below required ${requiredApprovalRaw.toString()} raw units (covers open offers + fill); approve USDC first.`
      );
    }
    const appRes = await approveUsdcForLend({
      address: wallet,
      requiredUsdcRaw: requiredApprovalRaw,
      provider,
      cfg,
      publicClient,
    });
    approvalTxHash = appRes.txHash;
  }

  try {
    await publicClient.call({
      account: wallet,
      to: settlementAddr,
      data: preview.fillCallData,
    });
  } catch (simErr) {
    const decoded = decodeContractRevert(simErr);
    throw new Error(decoded ? decoded.message : formatWeb3Error(simErr));
  }

  const { txHash, receipt } = await sendWalletTransaction(provider, publicClient, {
    from: wallet,
    to: settlementAddr,
    data: preview.fillCallData,
  });

  const loanId = decodeOrderFilledLoanId(receipt, settlementAddr);
  let positionTokenId = loanId;
  let positionOwner = null;
  if (loanId !== null && cfg.contracts.positionNft) {
    try {
      positionOwner = await publicClient.readContract({
        address: getAddress(cfg.contracts.positionNft),
        abi: positionNftAbi,
        functionName: 'ownerOf',
        args: [BigInt(loanId)],
      });
    } catch (ownerErr) {
      throw new Error(
        `PositionNFT ownerOf(${loanId}) verification failed after fill: ${formatWeb3Error(ownerErr)}`
      );
    }
    if (!positionOwner || positionOwner.toLowerCase() !== wallet.toLowerCase()) {
      throw new Error(
        `PositionNFT owner mismatch for loan ${loanId}: expected lender ${wallet}, got ${positionOwner ?? 'none'}.`
      );
    }
  }

  return {
    txHash,
    approvalTxHash,
    receipt,
    loanId,
    positionTokenId,
    positionOwner,
    quote: preview.quote,
    exact: preview.exact,
    preview,
    collateralForFillRaw: preview.collateralForFillRaw,
    fillUsdcRaw: preview.fillAmountRaw,
    existingOpenSumRaw: preview.existingOpenSumRaw,
    requiredApprovalRaw: requiredApprovalRaw.toString(),
  };
}
