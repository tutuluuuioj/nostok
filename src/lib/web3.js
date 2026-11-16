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
} from './contracts.js';

export const DEFAULT_COLLATERAL_BUFFER_BPS = 500; // +5.00% default buffer for partial fills & price ticks
export const MAX_COLLATERAL_BUFFER_BPS = 5000;
export const SIGNED_BORROW_ORDERS_STORAGE_KEY = 'nostok-signed-borrow-orders-v1';

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
  let firstJson = null;
  for (let page = 0; page < maxPages; page++) {
    const sep = resolvedBase.includes('?') ? '&' : '?';
    const json = await fetchJsonStrict(`${resolvedBase}${sep}limit=${limit}&offset=${offset}`, {}, timeoutMs);
    if (!firstJson && json && typeof json === 'object') {
      firstJson = json;
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
  return { rows, total: total ?? rows.length, truncated, fees: firstJson?.fees ?? null };
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
  minFillRaw = null
) {
  const signedCollateralRaw = BigInt(collateralAmountRaw);
  const totalUsdcRaw = BigInt(principalRaw);
  if (signedCollateralRaw <= 0n || totalUsdcRaw <= 0n) {
    throw new Error('Collateral and principal raw amounts must be positive.');
  }
  const hasMinFill =
    minFillRaw !== null && minFillRaw !== undefined && String(minFillRaw).trim() !== '';
  const rawMinFill = hasMinFill ? BigInt(minFillRaw) : totalUsdcRaw;
  if (rawMinFill <= 0n) {
    throw new Error('Minimum fill raw amount must be positive.');
  }
  const effectiveMinFill = rawMinFill > totalUsdcRaw ? totalUsdcRaw : rawMinFill;
  const maxFills = (totalUsdcRaw + effectiveMinFill - 1n) / effectiveMinFill;
  const approvalSlackRaw = maxFills;
  return {
    signedCollateralRaw,
    maxFills,
    approvalSlackRaw,
    requiredApprovalRaw: signedCollateralRaw + approvalSlackRaw,
  };
}

export function resolveExactBorrowAmounts(
  quote,
  {
    userCollateralRaw = null,
    bufferBps = DEFAULT_COLLATERAL_BUFFER_BPS,
    minFillRaw = null,
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
    minFillRaw
  );

  return {
    principalRaw,
    minRequiredCollateralRaw,
    bufferedCollateralRaw,
    bufferBps: cleanBufferBps,
    collateralAmountRaw,
    maxFills: approvalSizing.maxFills,
    approvalSlackRaw: approvalSizing.approvalSlackRaw,
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

  const [bal, allowance, dec, sym, nonce] = await Promise.all([
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
  ]);

  let eligibility = null;
  if (cfg.contracts.eligibilityGate) {
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
    eligibility = {
      permissionlessMode: Boolean(permissionlessMode),
      isRevoked: Boolean(isRevoked),
      allowlisted: Boolean(allowlisted),
      isEligible: Boolean(isEligible),
    };
  }

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

  const wallet = await assertActiveWalletAndChain(provider, address, cfg.chainId);
  const token = getAddress(collateralToken);
  const escrow = getAddress(cfg.contracts.collateralEscrow);

  const currentAllowance = BigInt(
    await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet, escrow],
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
    args: [escrow, required],
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
      args: [wallet, escrow],
    })
  );
  if (postAllowance < required) {
    throw new Error('Post-approval allowance check failed; allowance still below required collateral.');
  }

  return {
    approved: true,
    alreadyApproved: false,
    txHash,
    allowanceRaw: postAllowance.toString(),
  };
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

export function loadPersistedSignedOrders(storage = null) {
  const store = resolveStorage(storage);
  if (!store) return [];
  try {
    const raw = store.getItem(SIGNED_BORROW_ORDERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSignedBorrowOrder(record, storage = null) {
  const store = resolveStorage(storage);
  const existing = store ? loadPersistedSignedOrders(store) : [];
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
      store.setItem(SIGNED_BORROW_ORDERS_STORAGE_KEY, JSON.stringify(nextList));
    } catch {
      // ignore quota/private-mode storage errors
    }
  }
  return nextList;
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

function assertExpectedQuoteUnchanged(expectedQuote, freshQuote) {
  if (!expectedQuote) return;
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
  maxRateBps,
  termDays,
  maxLtvBps = null,
  minFillRaw = null,
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
  assertExpectedQuoteUnchanged(expectedQuote, quote);

  const exact = resolveExactBorrowAmounts(quote, {
    userCollateralRaw: collateralAmountRaw,
    bufferBps: collateralBufferBps,
    minFillRaw: minFillRaw ?? quote.amounts.principal.raw,
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
export async function verifyAndPreviewLendOfferFill({
  offer,
  signature,
  collateralToken,
  fillUsdcRaw = null,
  collateralAmountRaw = null,
  collateralBufferBps = DEFAULT_COLLATERAL_BUFFER_BPS,
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
  if (remainderAfterFillRaw > 0n && remainderAfterFillRaw < 500_000_000n) {
    warnings.push({
      code: 'PARTIAL_REMAINDER_BELOW_500',
      message: `Filling ${formatTokenUnitsDisplay(fillUsdcBig, USDC_DECIMALS, 2)} USDC leaves ${formatTokenUnitsDisplay(remainderAfterFillRaw, USDC_DECIMALS, 2)} USDC remaining (< $500); that remainder can only be filled in full or expired.`,
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
  let needsApproval = true;
  let simulationVerified = false;

  if (borrowerAddr) {
    const walletMeta = await readBorrowAllowanceAndNonce(borrowerAddr, token, {
      cfg,
      publicClient,
      attestationHex: cleanBorrowerAtt,
    });
    borrowerBalanceRaw = walletMeta.balanceRaw;
    borrowerAllowanceRaw = walletMeta.allowanceRaw;
    needsApproval = BigInt(borrowerAllowanceRaw) < exact.collateralAmountRaw;

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
      const isExpectedPreApprovalAllowanceErr =
        needsApproval &&
        ((decoded?.errorName === 'ERC20InsufficientAllowance' &&
          (!decoded.args?.[0] || String(decoded.args[0]).toLowerCase() === escrowAddr.toLowerCase())) ||
          (!decoded && /InsufficientAllowance/i.test(String(simErr?.message ?? ''))));

      if (!isExpectedPreApprovalAllowanceErr) {
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
      throw new Error('CollateralEscrow allowance is below required collateral; approve exact collateral first.');
    }
    const appRes = await approveCollateralForBorrow({
      address: wallet,
      collateralToken: preview.collateralToken,
      requiredCollateralRaw: preview.exact.collateralAmountRaw,
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

  let loanId = null;
  for (const log of receipt.logs ?? []) {
    if (log.address?.toLowerCase() !== settlementAddr.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: orderSettlementAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'OrderFilled' && decoded.args?.loanId !== undefined) {
        loanId = decoded.args.loanId.toString();
        break;
      }
    } catch {
      // ignore non-matching logs
    }
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
    fillUsdcRaw: preview.fillAmountRaw,
  };
}
