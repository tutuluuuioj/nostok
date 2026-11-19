import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getAddress, isAddress } from 'viem';
import { freshState, reducer } from './lib/book.js';
import {
  ELIGIBILITY_DECLARATION_STATEMENT_HASH,
  RESTRICTED_JURISDICTIONS,
  getFrontendConfig,
} from './lib/contracts.js';
import { buildAlerts } from './lib/health.js';
import {
  bumpEligibilityNonce as web3BumpEligibilityNonce,
  connectWallet as web3ConnectWallet,
  fetchEligibilityScreening,
  fetchNotificationsSessionState,
  fetchWalletState,
  formatWeb3Error,
  getInjectedProvider,
  normalizeJurisdictionCode,
  parseChainIdHex,
  readConnectedAccount,
  readEligibilityStatus,
  signEligibilityDeclaration as web3SignEligibilityDeclaration,
  signInWithSiwe as web3SignInWithSiwe,
  signOutSiwe as web3SignOutSiwe,
  submitEligibilityDeclaration,
  switchToBaseChain,
} from './lib/web3.js';

const KEY = 'nostok-store-v1';
const DECLARATION_KEY = 'nostok-eligibility-declaration-v1';
const StoreContext = createContext(null);

export const HARD_RESTRICTION_CODES = new Set([
  'GEO_RESTRICTED',
  'GEO_TOR_BLOCKED',
  'GEO_UNVERIFIED',
  'GEO_UNTRUSTED_PROXY',
  'GEO_HEADER_MALFORMED',
  'WALLET_SANCTIONED',
  'WALLET_REVOKED',
]);

export function isHardRestrictionScreening(screeningData, walletEligibility = null) {
  if (walletEligibility?.isRevoked === true) return true;
  if (!screeningData || typeof screeningData !== 'object') return false;
  if (screeningData.geo?.allowed === false) return true;
  if (screeningData.wallet?.sanctioned === true) return true;
  if (screeningData.onchain?.is_revoked === true) return true;
  const reasons = Array.isArray(screeningData.rejection_reasons) ? screeningData.rejection_reasons : [];
  return reasons.some((r) => HARD_RESTRICTION_CODES.has(String(r?.code ?? '')));
}

export function loadPersistedDeclaration() {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(DECLARATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.declarationJson || typeof parsed.signature !== 'string') return null;
    // Low 1: Never trust persisted serverVerification flags from sessionStorage.
    return {
      account: parsed.account ?? null,
      chainId: parsed.chainId ?? null,
      gateAddress: parsed.gateAddress ?? null,
      declarationJson: parsed.declarationJson,
      signature: parsed.signature,
      digest: parsed.digest ?? null,
      serverVerification: null,
    };
  } catch {
    return null;
  }
}

export function savePersistedDeclaration(decl) {
  if (typeof sessionStorage === 'undefined') return;
  try {
    if (!decl) {
      sessionStorage.removeItem(DECLARATION_KEY);
    } else {
      const { serverVerification: _dropProof, verifiedAt: _dropVerifiedAt, ...storable } = decl;
      sessionStorage.setItem(DECLARATION_KEY, JSON.stringify(storable));
    }
  } catch {
    /* ignore storage quota failures */
  }
}

function validateDeclarationBindings(declaration, { address = null, config = getFrontendConfig(), screeningData = null } = {}) {
  if (!declaration || typeof declaration !== 'object') {
    return {
      ok: false,
      result: {
        valid: false,
        code: 'DECLARATION_MISSING',
        reason: 'Sign an EIP-712 Regulation S declaration for your connected wallet.',
        expiresAt: null,
        jurisdiction: null,
      },
    };
  }

  const declJson =
    declaration.declarationJson && typeof declaration.declarationJson === 'object'
      ? declaration.declarationJson
      : declaration;
  const sig = typeof declaration.signature === 'string' ? declaration.signature.trim() : '';

  if (!/^0x[0-9a-fA-F]{130,}$/.test(sig) || sig.length % 2 !== 0) {
    return {
      ok: false,
      result: {
        valid: false,
        code: 'DECLARATION_INVALID',
        reason: 'Stored eligibility declaration signature is malformed.',
        expiresAt: null,
        jurisdiction: null,
      },
    };
  }
  if (!declJson.account || !isAddress(declJson.account)) {
    return {
      ok: false,
      result: {
        valid: false,
        code: 'DECLARATION_INVALID',
        reason: 'Eligibility declaration has an invalid account address.',
        expiresAt: null,
        jurisdiction: null,
      },
    };
  }
  const declAccount = getAddress(declJson.account);

  const expectedChainId = Number(config?.chainId);
  const storedChainId = Number(declaration.chainId);
  if (!Number.isInteger(storedChainId) || storedChainId !== expectedChainId) {
    return {
      ok: false,
      result: {
        valid: false,
        code: 'DECLARATION_CHAIN_MISMATCH',
        reason: `Declaration chainId (${String(declaration.chainId ?? '?')}) does not match Base (${expectedChainId}).`,
        expiresAt: null,
        jurisdiction: null,
      },
    };
  }

  const expectedGate = config?.contracts?.eligibilityGate;
  if (
    !expectedGate ||
    !isAddress(expectedGate) ||
    !declaration.gateAddress ||
    !isAddress(declaration.gateAddress) ||
    getAddress(declaration.gateAddress).toLowerCase() !== getAddress(expectedGate).toLowerCase()
  ) {
    return {
      ok: false,
      result: {
        valid: false,
        code: 'DECLARATION_GATE_MISMATCH',
        reason: 'Declaration verifying EligibilityGate address does not match active deployment.',
        expiresAt: null,
        jurisdiction: null,
      },
    };
  }

  if (!address || !isAddress(address)) {
    return {
      ok: false,
      result: {
        valid: false,
        code: 'WALLET_NOT_CONNECTED',
        reason: 'Connect a Base wallet to validate your EIP-712 Regulation S declaration.',
        expiresAt: null,
        jurisdiction: null,
      },
    };
  }
  const activeAccount = getAddress(address);
  if (activeAccount.toLowerCase() !== declAccount.toLowerCase()) {
    return {
      ok: false,
      result: {
        valid: false,
        code: 'DECLARATION_ACCOUNT_MISMATCH',
        reason: `Declaration was signed for ${declAccount}, not active wallet ${activeAccount}.`,
        expiresAt: null,
        jurisdiction: null,
      },
    };
  }

  const nonceStr = declJson.nonce !== undefined && declJson.nonce !== null ? String(declJson.nonce).trim() : '';
  const issuedStr =
    declJson.issuedAt !== undefined && declJson.issuedAt !== null ? String(declJson.issuedAt).trim() : '';
  const expiresStr =
    declJson.expiresAt !== undefined && declJson.expiresAt !== null ? String(declJson.expiresAt).trim() : '';
  if (!/^\d+$/.test(nonceStr) || !/^\d+$/.test(issuedStr) || !/^\d+$/.test(expiresStr)) {
    return {
      ok: false,
      result: {
        valid: false,
        code: 'DECLARATION_INVALID',
        reason: 'Declaration nonce or timestamp bounds are invalid.',
        expiresAt: null,
        jurisdiction: null,
      },
    };
  }

  const statementHash = typeof declJson.statementHash === 'string' ? declJson.statementHash.trim().toLowerCase() : '';
  if (statementHash !== ELIGIBILITY_DECLARATION_STATEMENT_HASH.toLowerCase()) {
    return {
      ok: false,
      result: {
        valid: false,
        code: 'DECLARATION_STATEMENT_MISMATCH',
        reason: 'Declaration statement hash does not match the canonical Regulation S statement.',
        expiresAt: expiresStr,
        jurisdiction: null,
      },
    };
  }

  const restrictedList = Array.isArray(screeningData?.declaration_params?.restricted_countries)
    ? screeningData.declaration_params.restricted_countries
    : RESTRICTED_JURISDICTIONS;
  let normalizedJurisdiction;
  try {
    normalizedJurisdiction = normalizeJurisdictionCode(declJson.jurisdiction, { restrictedList });
  } catch (err) {
    return {
      ok: false,
      result: {
        valid: false,
        code: 'DECLARATION_JURISDICTION_RESTRICTED',
        reason: err instanceof Error ? err.message : 'Declared jurisdiction is restricted.',
        expiresAt: expiresStr,
        jurisdiction: null,
      },
    };
  }

  return {
    ok: true,
    declJson,
    signature: sig,
    activeAccount,
    nonceStr,
    issuedStr,
    expiresStr,
    normalizedJurisdiction,
  };
}

export function evaluateEligibilityDeclaration(
  declaration,
  {
    address = null,
    config = getFrontendConfig(),
    walletEligibility = null,
    screeningData = null,
    nowSeconds = null,
  } = {}
) {
  const bound = validateDeclarationBindings(declaration, { address, config, screeningData });
  if (!bound.ok) return bound.result;

  const {
    activeAccount,
    nonceStr,
    issuedStr,
    expiresStr,
    normalizedJurisdiction,
  } = bound;

  if (declaration.serverVerification?.verified !== true) {
    return {
      valid: false,
      code: 'DECLARATION_UNVERIFIED',
      reason: 'Declaration has not been verified by api/ POST /eligibility/verify in this session.',
      expiresAt: expiresStr,
      jurisdiction: normalizedJurisdiction,
    };
  }

  if (
    declaration.digest &&
    declaration.serverVerification?.declaration_digest &&
    String(declaration.serverVerification.declaration_digest).toLowerCase() !== String(declaration.digest).toLowerCase()
  ) {
    return {
      valid: false,
      code: 'DECLARATION_UNVERIFIED',
      reason: 'Server declaration digest does not match stored declaration.',
      expiresAt: expiresStr,
      jurisdiction: normalizedJurisdiction,
    };
  }

  const verifiedWalletAcct = declaration.serverVerification?.wallet?.account;
  if (
    verifiedWalletAcct &&
    isAddress(verifiedWalletAcct) &&
    getAddress(verifiedWalletAcct).toLowerCase() !== activeAccount.toLowerCase()
  ) {
    return {
      valid: false,
      code: 'DECLARATION_ACCOUNT_MISMATCH',
      reason: 'Server verification record belongs to a different wallet address.',
      expiresAt: expiresStr,
      jurisdiction: normalizedJurisdiction,
    };
  }

  if (screeningData && typeof screeningData === 'object' && screeningData.allowed !== true) {
    const msg = screeningData.rejection_reasons?.[0]?.message || 'Blocked by API eligibility screening.';
    return {
      valid: false,
      code: 'SCREENING_REJECTED',
      reason: msg,
      expiresAt: expiresStr,
      jurisdiction: normalizedJurisdiction,
    };
  }

  if (walletEligibility?.isRevoked || screeningData?.onchain?.is_revoked) {
    return {
      valid: false,
      code: 'WALLET_REVOKED',
      reason: 'Connected wallet is revoked on EligibilityGate.',
      expiresAt: expiresStr,
      jurisdiction: normalizedJurisdiction,
    };
  }

  // Low 1: Missing live userNonce data MUST be treated as not valid.
  const walletNonce =
    walletEligibility?.userNonce !== undefined && walletEligibility?.userNonce !== null
      ? walletEligibility.userNonce
      : null;
  const screeningNonce =
    screeningData?.onchain?.user_nonce !== undefined && screeningData?.onchain?.user_nonce !== null
      ? screeningData.onchain.user_nonce
      : null;
  const liveNonce = walletNonce ?? screeningNonce;
  if (liveNonce === null) {
    return {
      valid: false,
      code: 'DECLARATION_NONCE_UNAVAILABLE',
      reason: 'Awaiting live on-chain EligibilityGate userNonce check.',
      expiresAt: expiresStr,
      jurisdiction: normalizedJurisdiction,
    };
  }

  if (
    String(liveNonce) !== nonceStr ||
    (walletNonce !== null && String(walletNonce) !== nonceStr) ||
    (screeningNonce !== null && String(screeningNonce) !== nonceStr)
  ) {
    return {
      valid: false,
      code: 'DECLARATION_NONCE_STALE',
      reason: `EligibilityGate userNonce is now ${String(walletNonce ?? screeningNonce)} (signed nonce ${nonceStr}); re-sign declaration.`,
      expiresAt: expiresStr,
      jurisdiction: normalizedJurisdiction,
    };
  }

  if (
    screeningData?.geo?.verified &&
    screeningData?.geo?.country_code &&
    normalizedJurisdiction !== String(screeningData.geo.country_code).trim().toUpperCase()
  ) {
    return {
      valid: false,
      code: 'DECLARATION_GEO_MISMATCH',
      reason: `Declared jurisdiction (${normalizedJurisdiction}) does not match verified IP country (${screeningData.geo.country_code}); re-sign declaration.`,
      expiresAt: expiresStr,
      jurisdiction: normalizedJurisdiction,
    };
  }

  const refNow = walletEligibility?.blockTimestamp
    ? BigInt(walletEligibility.blockTimestamp)
    : screeningData?.onchain?.block_timestamp
      ? BigInt(screeningData.onchain.block_timestamp)
      : BigInt(Math.floor(nowSeconds ?? Date.now() / 1000));
  const issuedBig = BigInt(issuedStr);
  const expiresBig = BigInt(expiresStr);
  if (issuedBig > refNow + 300n) {
    return {
      valid: false,
      code: 'DECLARATION_FUTURE_TIMESTAMP',
      reason: 'Declaration issuedAt timestamp is in the future relative to Base chain time.',
      expiresAt: expiresStr,
      jurisdiction: normalizedJurisdiction,
    };
  }
  if (expiresBig <= refNow) {
    return {
      valid: false,
      code: 'DECLARATION_EXPIRED',
      reason: 'EIP-712 Regulation S declaration has expired (24h max window); sign a fresh declaration.',
      expiresAt: expiresStr,
      jurisdiction: normalizedJurisdiction,
    };
  }

  return {
    valid: true,
    code: 'VERIFIED',
    reason: 'EIP-712 Regulation S declaration verified.',
    expiresAt: expiresStr,
    jurisdiction: normalizedJurisdiction,
  };
}

export async function verifyStoredDeclarationOnServer({
  declaration,
  address,
  attestationHex = '0x',
  cfg = getFrontendConfig(),
  screeningData = null,
  submitImpl = submitEligibilityDeclaration,
  readStatusImpl = readEligibilityStatus,
}) {
  const bound = validateDeclarationBindings(declaration, { address, config: cfg, screeningData });
  if (!bound.ok) {
    throw new Error(bound.result.reason);
  }
  const { declJson, signature, activeAccount, nonceStr, normalizedJurisdiction } = bound;

  const [liveStatus, serverVerification] = await Promise.all([
    readStatusImpl(activeAccount, { attestationHex, cfg }),
    submitImpl({
      declaration: declJson,
      signature,
      attestationHex,
      cfg,
    }),
  ]);

  if (!serverVerification?.verified) {
    throw new Error('Eligibility declaration verification failed on api/ POST /eligibility/verify.');
  }
  if (liveStatus?.isRevoked) {
    throw new Error(`Wallet ${activeAccount} is revoked on EligibilityGate.`);
  }
  if (String(liveStatus?.userNonce) !== nonceStr) {
    throw new Error(
      `EligibilityGate userNonce (${String(liveStatus?.userNonce)}) does not match declaration nonce (${nonceStr}).`
    );
  }
  if (
    serverVerification?.onchain?.user_nonce !== undefined &&
    String(serverVerification.onchain.user_nonce) !== nonceStr
  ) {
    throw new Error('Server EligibilityGate userNonce does not match declaration nonce.');
  }
  if (
    serverVerification?.geo?.verified &&
    serverVerification.geo.country_code &&
    normalizedJurisdiction !== String(serverVerification.geo.country_code).trim().toUpperCase()
  ) {
    throw new Error(
      `Declared jurisdiction (${normalizedJurisdiction}) does not match current verified IP country (${serverVerification.geo.country_code}).`
    );
  }

  const record = {
    account: declJson.account,
    chainId: Number(cfg.chainId),
    gateAddress: cfg.contracts.eligibilityGate,
    declarationJson: declJson,
    signature,
    digest: serverVerification.declaration_digest ?? declaration.digest ?? null,
    verifiedAt: new Date().toISOString(),
    serverVerification,
  };

  return {
    verified: true,
    record,
    liveStatus,
    serverVerification,
  };
}

function init() {
  if (typeof sessionStorage === 'undefined') return freshState();
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved?.v === 2 && Array.isArray(saved.loans) && Array.isArray(saved.orders)) {
        return { ...freshState(), ...saved, notice: '', error: '' };
      }
    }
  } catch {
    /* initialize store */
  }
  return freshState();
}

export function createWalletEventsHandler({
  connRef,
  siweRef,
  snapshotSeqRef,
  updateWalletConn,
  setWalletSnapshot,
  clearLocalSiweState,
  refreshWalletData,
  getConfig = getFrontendConfig,
  signOutImpl = web3SignOutSiwe,
  getAttestation = () => '0x',
  onComplianceContextReset = () => {},
}) {
  const onAccountsChanged = (accounts) => {
    const nextRaw = Array.isArray(accounts) && accounts.length > 0 ? accounts[0] : null;
    const nextAddr = nextRaw ? getAddress(nextRaw) : null;
    const prevAddr = connRef.current.address;
    const prevSess = siweRef.current;
    ++snapshotSeqRef.current;
    setWalletSnapshot({ loading: false, data: null });

    if (!nextAddr || !prevAddr || nextAddr.toLowerCase() !== prevAddr.toLowerCase()) {
      if (prevSess?.token) {
        void signOutImpl({ token: prevSess.token, cfg: getConfig() }).catch(() => {});
      }
      clearLocalSiweState({
        siweNotice: nextAddr ? 'Wallet changed. Sign in with SIWE for this address.' : '',
      });
      onComplianceContextReset({
        accountChanged: true,
        clearScreening: true,
        nextAddress: nextAddr,
        wrongNetwork: connRef.current.wrongNetwork,
      });
    }
    const nextConn = updateWalletConn((prev) => ({
      ...prev,
      connected: Boolean(nextAddr),
      address: nextAddr,
      walletError: prev.wrongNetwork && nextAddr ? prev.walletError : '',
    }));
    if (nextConn.address && !nextConn.wrongNetwork) {
      void refreshWalletData(nextConn.address, getAttestation(), {
        wrongNetwork: nextConn.wrongNetwork,
      });
    }
  };

  const onChainChanged = (rawChain) => {
    const nextChainId = parseChainIdHex(rawChain);
    const currentCfg = getConfig();
    const wrong = nextChainId !== currentCfg.chainId;
    ++snapshotSeqRef.current;
    setWalletSnapshot({ loading: false, data: null });

    if (wrong && siweRef.current) {
      const prevSess = siweRef.current;
      if (prevSess?.token) {
        void signOutImpl({ token: prevSess.token, cfg: currentCfg }).catch(() => {});
      }
      clearLocalSiweState({
        siweNotice: `Network changed away from Base (${currentCfg.chainId}); SIWE session cleared.`,
      });
    }
    onComplianceContextReset({ accountChanged: false, wrongNetwork: wrong });

    const nextConn = updateWalletConn((prev) => ({
      ...prev,
      chainId: Number.isNaN(nextChainId) ? prev.chainId : nextChainId,
      wrongNetwork: wrong,
      walletError: wrong
        ? `Wrong network (chainId ${nextChainId}). Switch to Base (${currentCfg.chainId}).`
        : '',
    }));
    if (!nextConn.wrongNetwork && nextConn.address) {
      void refreshWalletData(nextConn.address, getAttestation(), {
        wrongNetwork: false,
      });
    }
  };

  return { onAccountsChanged, onChainChanged };
}

export function StoreProvider({ children }) {
  const [state, setState] = useState(init);
  const ref = useRef(state);
  ref.current = state;

  useEffect(() => {
    if (typeof sessionStorage === 'undefined') return;
    const { notice, error, ...rest } = state;
    sessionStorage.setItem(KEY, JSON.stringify(rest));
  }, [state]);

  const act = useCallback((action) => {
    const next = reducer(ref.current, action);
    ref.current = next;
    setState(next);
    return next;
  }, []);

  const [walletConn, setWalletConn] = useState({
    connected: false,
    address: null,
    chainId: null,
    wrongNetwork: false,
    connecting: false,
    walletError: '',
  });
  const [siweState, setSiweState] = useState({
    session: null, // { walletAddress, token, jti, expiresAt }
    subscriptions: null,
    preferences: null,
    signingIn: false,
    siweError: '',
    siweNotice: '',
  });
  const [attestationHex, setAttestationHex] = useState('0x');
  const [walletSnapshot, setWalletSnapshot] = useState({
    loading: false,
    data: null,
  });
  const [eligibilityScreening, setEligibilityScreening] = useState({
    loading: false,
    checkedOnce: false,
    data: null,
    error: '',
  });
  const [eligibilityDeclaration, setEligibilityDeclaration] = useState(loadPersistedDeclaration);
  const [declActionState, setDeclActionState] = useState({
    signing: false,
    verifying: false,
    bumpingNonce: false,
    error: '',
    notice: '',
  });

  const siweRef = useRef(siweState.session);
  siweRef.current = siweState.session;
  const connRef = useRef(walletConn);
  connRef.current = walletConn;
  const attestationRef = useRef(attestationHex);
  attestationRef.current = attestationHex;
  const declRef = useRef(eligibilityDeclaration);
  declRef.current = eligibilityDeclaration;
  const snapshotSeqRef = useRef(0);
  const screeningSeqRef = useRef(0);
  const declSeqRef = useRef(0);
  const prevScreeningTargetRef = useRef(undefined);
  const reverifyAttemptedKeyRef = useRef(null);

  const updateWalletConn = useCallback((nextOrUpdater) => {
    const next =
      typeof nextOrUpdater === 'function' ? nextOrUpdater(connRef.current) : nextOrUpdater;
    connRef.current = next;
    setWalletConn(next);
    return next;
  }, []);

  const clearLocalSiweState = useCallback((opts = {}) => {
    siweRef.current = null;
    setSiweState({
      session: null,
      subscriptions: null,
      preferences: null,
      signingIn: false,
      siweError: opts.siweError ?? '',
      siweNotice: opts.siweNotice ?? '',
    });
  }, []);

  const clearEligibilityDeclaration = useCallback((opts = {}) => {
    ++declSeqRef.current;
    reverifyAttemptedKeyRef.current = null;
    savePersistedDeclaration(null);
    declRef.current = null;
    setEligibilityDeclaration(null);
    setDeclActionState({
      signing: false,
      verifying: false,
      bumpingNonce: false,
      error: opts.error ?? '',
      notice: opts.notice ?? '',
    });
  }, []);

  const refreshEligibilityScreening = useCallback(
    async (
      targetAddr = undefined,
      customAttestation = attestationRef.current,
      opts = {}
    ) => {
      const requestId = ++screeningSeqRef.current;
      const resolvedAccount =
        targetAddr === undefined
          ? connRef.current.connected && connRef.current.address && !connRef.current.wrongNetwork
            ? getAddress(connRef.current.address)
            : null
          : targetAddr
            ? getAddress(targetAddr)
            : null;
      const cfg = getFrontendConfig();

      setEligibilityScreening((prev) => ({
        loading: true,
        checkedOnce: opts.clearData ? false : prev.checkedOnce,
        data: opts.clearData ? null : prev.data,
        error: '',
      }));

      try {
        const data = await fetchEligibilityScreening({
          account: resolvedAccount,
          attestationHex: customAttestation,
          cfg,
        });
        const currentExpected =
          connRef.current.connected && connRef.current.address && !connRef.current.wrongNetwork
            ? getAddress(connRef.current.address)
            : null;
        if (requestId !== screeningSeqRef.current || currentExpected !== resolvedAccount) {
          return null;
        }
        setEligibilityScreening({
          loading: false,
          checkedOnce: true,
          data,
          error: '',
        });
        const hard = isHardRestrictionScreening(data, null);
        if (hard && ref.current.gate !== 'restricted') {
          act({ type: 'restrict' });
        } else if (
          !hard &&
          data?.allowed === true &&
          opts.allowRecoverFromRestriction &&
          ref.current.gate === 'restricted'
        ) {
          act({ type: 'reset-gate' });
        }
        return data;
      } catch (err) {
        if (requestId !== screeningSeqRef.current) {
          return null;
        }
        setEligibilityScreening({
          loading: false,
          checkedOnce: true,
          data: null,
          error: formatWeb3Error(err),
        });
        return null;
      }
    },
    [act]
  );

  const refreshWalletData = useCallback(
    async (
      targetAddr = connRef.current.address,
      customAttestation = attestationRef.current,
      opts = {}
    ) => {
      const requestId = ++snapshotSeqRef.current;
      const isWrongNetwork =
        typeof opts.wrongNetwork === 'boolean' ? opts.wrongNetwork : connRef.current.wrongNetwork;
      if (!targetAddr || isWrongNetwork) {
        setWalletSnapshot({ loading: false, data: null });
        return null;
      }
      const checksumTarget = getAddress(targetAddr);
      const cfg = getFrontendConfig();
      setWalletSnapshot((prev) => ({
        loading: true,
        data: prev.data && prev.data.address === checksumTarget ? prev.data : null,
      }));
      const snapshot = await fetchWalletState(checksumTarget, {
        cfg,
        attestationHex: customAttestation,
        requestId,
      });

      // Drop out-of-order or stale responses after account change, chain change, wrong network, or disconnect
      const activeAddr = connRef.current.address;
      if (
        requestId !== snapshotSeqRef.current ||
        !connRef.current.connected ||
        connRef.current.wrongNetwork ||
        !activeAddr ||
        activeAddr.toLowerCase() !== checksumTarget.toLowerCase()
      ) {
        return null;
      }
      setWalletSnapshot({ loading: false, data: snapshot });

      const activeSess = siweRef.current;
      if (activeSess && activeSess.walletAddress.toLowerCase() === checksumTarget.toLowerCase()) {
        const expectedToken = activeSess.token;
        try {
          const notifState = await fetchNotificationsSessionState({
            token: expectedToken,
            cfg,
          });
          if (
            requestId !== snapshotSeqRef.current ||
            siweRef.current?.token !== expectedToken ||
            connRef.current.address?.toLowerCase() !== checksumTarget.toLowerCase()
          ) {
            return snapshot;
          }
          setSiweState((prev) => ({
            ...prev,
            subscriptions: notifState.subscriptions,
            preferences: notifState.preferences,
            siweError: '',
          }));
        } catch (err) {
          if (requestId !== snapshotSeqRef.current || siweRef.current?.token !== expectedToken) {
            return snapshot;
          }
          if (err && typeof err === 'object' && err.status === 401) {
            clearLocalSiweState({
              siweError: 'Notifications session expired or revoked. Please sign in again.',
            });
          } else {
            setSiweState((prev) => ({
              ...prev,
              siweError: formatWeb3Error(err),
            }));
          }
        }
      }
      return snapshot;
    },
    [clearLocalSiweState]
  );

  // Sync existing authorized account + subscribe to EIP-1193 accountsChanged / chainChanged
  useEffect(() => {
    const provider = getInjectedProvider();
    const cfg = getFrontendConfig();
    let mounted = true;

    readConnectedAccount(provider, cfg)
      .then((acc) => {
        if (!mounted || !acc) return;
        updateWalletConn({
          connected: true,
          address: acc.address,
          chainId: acc.chainId,
          wrongNetwork: acc.wrongNetwork,
          connecting: false,
          walletError: acc.wrongNetwork
            ? `Wrong network (chainId ${acc.chainId}). Switch to Base (${cfg.chainId}).`
            : '',
        });
        if (!acc.wrongNetwork) {
          void refreshWalletData(acc.address, attestationRef.current, { wrongNetwork: false });
        } else {
          ++snapshotSeqRef.current;
          setWalletSnapshot({ loading: false, data: null });
        }
      })
      .catch(() => {});

    if (!provider || typeof provider.on !== 'function') {
      return () => {
        mounted = false;
      };
    }

    const { onAccountsChanged, onChainChanged } = createWalletEventsHandler({
      connRef,
      siweRef,
      snapshotSeqRef,
      updateWalletConn,
      setWalletSnapshot,
      clearLocalSiweState,
      refreshWalletData,
      getConfig: getFrontendConfig,
      signOutImpl: web3SignOutSiwe,
      getAttestation: () => attestationRef.current,
      onComplianceContextReset: ({ clearScreening, nextAddress } = {}) => {
        ++declSeqRef.current;
        reverifyAttemptedKeyRef.current = null;
        setDeclActionState({ signing: false, verifying: false, bumpingNonce: false, error: '', notice: '' });
        if (clearScreening) {
          ++screeningSeqRef.current;
          setEligibilityScreening({ loading: Boolean(nextAddress), checkedOnce: false, data: null, error: '' });
        }
      },
    });

    provider.on('accountsChanged', onAccountsChanged);
    provider.on('chainChanged', onChainChanged);
    return () => {
      mounted = false;
      if (typeof provider.removeListener === 'function') {
        provider.removeListener('accountsChanged', onAccountsChanged);
        provider.removeListener('chainChanged', onChainChanged);
      }
    };
  }, [clearLocalSiweState, refreshWalletData, updateWalletConn]);

  const firstAttestationMount = useRef(true);
  useEffect(() => {
    if (firstAttestationMount.current) {
      firstAttestationMount.current = false;
      return;
    }
    if (connRef.current.connected && connRef.current.address && !connRef.current.wrongNetwork) {
      void refreshWalletData(connRef.current.address, attestationHex, { wrongNetwork: false });
    }
  }, [attestationHex, refreshWalletData]);

  // Run GET /eligibility screening on initial mount and whenever wallet/network/attestation context changes
  const activeScreeningTarget =
    walletConn.connected && walletConn.address && !walletConn.wrongNetwork
      ? getAddress(walletConn.address)
      : null;
  useEffect(() => {
    const prevTarget = prevScreeningTargetRef.current;
    prevScreeningTargetRef.current = activeScreeningTarget;
    const accountChanged = prevTarget !== undefined && prevTarget !== activeScreeningTarget;
    if (accountChanged) {
      // Info 1: clear prior wallet screening immediately while the new wallet request is in flight.
      ++screeningSeqRef.current;
      setEligibilityScreening({ loading: true, checkedOnce: false, data: null, error: '' });
    }
    void refreshEligibilityScreening(activeScreeningTarget, attestationHex, {
      allowRecoverFromRestriction: accountChanged,
      clearData: accountChanged,
    });
  }, [activeScreeningTarget, attestationHex, refreshEligibilityScreening]);

  // Low 1: On load / wallet change, automatically re-verify any unverified sessionStorage declaration via POST /eligibility/verify.
  useEffect(() => {
    const addr = walletConn.connected && !walletConn.wrongNetwork ? walletConn.address : null;
    const decl = eligibilityDeclaration;
    if (!addr || !decl || decl.serverVerification?.verified === true) {
      return;
    }
    const cfg = getFrontendConfig();
    const attemptKey = `${addr.toLowerCase()}:${cfg.chainId}:${String(cfg.contracts?.eligibilityGate ?? '')}:${decl.signature}:${attestationHex}`;
    if (reverifyAttemptedKeyRef.current === attemptKey) {
      return;
    }

    const boundCheck = validateDeclarationBindings(decl, { address: addr, config: cfg });
    if (!boundCheck.ok) {
      return;
    }

    reverifyAttemptedKeyRef.current = attemptKey;
    const requestId = ++declSeqRef.current;
    setDeclActionState((prev) => ({ ...prev, verifying: true, error: '' }));

    void verifyStoredDeclarationOnServer({
      declaration: decl,
      address: addr,
      attestationHex,
      cfg,
    })
      .then((verified) => {
        if (
          requestId !== declSeqRef.current ||
          !connRef.current.connected ||
          connRef.current.wrongNetwork ||
          !connRef.current.address ||
          connRef.current.address.toLowerCase() !== addr.toLowerCase()
        ) {
          return;
        }
        declRef.current = verified.record;
        setEligibilityDeclaration(verified.record);
        setDeclActionState((prev) => ({ ...prev, verifying: false, error: '' }));
      })
      .catch((err) => {
        if (requestId !== declSeqRef.current) return;
        const msg = formatWeb3Error(err);
        const status = err && typeof err === 'object' ? err.status : null;
        if (status === 400 || status === 403) {
          savePersistedDeclaration(null);
          declRef.current = null;
          setEligibilityDeclaration(null);
        }
        setDeclActionState((prev) => ({ ...prev, verifying: false, error: msg, notice: '' }));
      });
  }, [
    attestationHex,
    eligibilityDeclaration,
    walletConn.address,
    walletConn.connected,
    walletConn.wrongNetwork,
  ]);

  // If live on-chain EligibilityGate reports wallet revoked, lock UI to Restricted immediately
  useEffect(() => {
    if (
      walletSnapshot.data &&
      walletConn.address &&
      walletSnapshot.data.address === walletConn.address &&
      walletSnapshot.data.eligibility?.isRevoked === true &&
      ref.current.gate !== 'restricted'
    ) {
      act({ type: 'restrict' });
    }
  }, [act, walletConn.address, walletSnapshot.data]);

  const connect = useCallback(async () => {
    const cfg = getFrontendConfig();
    ++snapshotSeqRef.current;
    setWalletSnapshot({ loading: false, data: null });
    updateWalletConn((prev) => ({ ...prev, connecting: true, walletError: '' }));
    try {
      const res = await web3ConnectWallet(getInjectedProvider(), cfg);
      updateWalletConn({
        connected: true,
        address: res.address,
        chainId: res.chainId,
        wrongNetwork: res.wrongNetwork,
        connecting: false,
        walletError: res.error || '',
      });
      if (!res.wrongNetwork) {
        await refreshWalletData(res.address, attestationRef.current, { wrongNetwork: false });
      }
      return res;
    } catch (err) {
      const msg = formatWeb3Error(err);
      updateWalletConn((prev) => ({ ...prev, connecting: false, walletError: msg }));
      return null;
    }
  }, [refreshWalletData, updateWalletConn]);

  const switchNetwork = useCallback(async () => {
    const cfg = getFrontendConfig();
    try {
      const nextChainId = await switchToBaseChain(getInjectedProvider(), cfg);
      const nextConn = updateWalletConn((prev) => ({
        ...prev,
        chainId: nextChainId,
        wrongNetwork: false,
        walletError: '',
      }));
      if (nextConn.address) {
        await refreshWalletData(nextConn.address, attestationRef.current, { wrongNetwork: false });
      }
      return true;
    } catch (err) {
      updateWalletConn((prev) => ({ ...prev, walletError: formatWeb3Error(err) }));
      return false;
    }
  }, [refreshWalletData, updateWalletConn]);

  const signIn = useCallback(async () => {
    const cfg = getFrontendConfig();
    const addr = connRef.current.address;
    if (!addr) {
      setSiweState((prev) => ({
        ...prev,
        siweError: 'Connect your wallet before signing in with SIWE.',
      }));
      return null;
    }
    setSiweState((prev) => ({ ...prev, signingIn: true, siweError: '', siweNotice: '' }));
    try {
      const session = await web3SignInWithSiwe({
        address: addr,
        provider: getInjectedProvider(),
        cfg,
      });
      if (!connRef.current.address || connRef.current.address.toLowerCase() !== addr.toLowerCase()) {
        void web3SignOutSiwe({ token: session.token, cfg }).catch(() => {});
        throw new Error('Wallet account changed during SIWE signing; sign-in aborted.');
      }
      let subscriptions = null;
      let preferences = null;
      try {
        const loaded = await fetchNotificationsSessionState({ token: session.token, cfg });
        subscriptions = loaded.subscriptions;
        preferences = loaded.preferences;
      } catch {
        // Non-fatal follow-up read; session itself is established
      }
      if (!connRef.current.address || connRef.current.address.toLowerCase() !== addr.toLowerCase()) {
        void web3SignOutSiwe({ token: session.token, cfg }).catch(() => {});
        return null;
      }
      siweRef.current = session;
      setSiweState({
        session,
        subscriptions,
        preferences,
        signingIn: false,
        siweError: '',
        siweNotice: 'Signed in via SIWE (EIP-4361).',
      });
      return session;
    } catch (err) {
      setSiweState((prev) => ({
        ...prev,
        signingIn: false,
        siweError: formatWeb3Error(err),
      }));
      return null;
    }
  }, []);

  const signOut = useCallback(async () => {
    const cfg = getFrontendConfig();
    const current = siweRef.current;
    if (!current?.token) {
      clearLocalSiweState({ siweNotice: 'Signed out and revoked notification session.' });
      return;
    }
    try {
      await web3SignOutSiwe({ token: current.token, cfg });
      clearLocalSiweState({ siweNotice: 'Signed out and revoked notification session.' });
    } catch {
      clearLocalSiweState({
        siweError: `Server revocation failed; token expires at ${current.expiresAt ?? 'unknown'}`,
      });
    }
  }, [clearLocalSiweState]);

  const signAndVerifyDeclaration = useCallback(
    async ({ jurisdiction = null, ttlSeconds } = {}) => {
      const cfg = getFrontendConfig();
      const addr = connRef.current.address;
      if (!connRef.current.connected || !addr || connRef.current.wrongNetwork) {
        const msg = connRef.current.wrongNetwork
          ? `Switch wallet to Base (${cfg.chainId}) before signing an eligibility declaration.`
          : 'Connect your wallet before signing an eligibility declaration.';
        setDeclActionState((prev) => ({ ...prev, error: msg, notice: '' }));
        throw new Error(msg);
      }

      const requestId = ++declSeqRef.current;
      setDeclActionState({ signing: true, verifying: false, bumpingNonce: false, error: '', notice: '' });
      try {
        const signed = await web3SignEligibilityDeclaration({
          address: addr,
          jurisdiction,
          ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
          requireServerScreening: true,
          submitToApi: true,
          attestationHex: attestationRef.current,
          provider: getInjectedProvider(),
          cfg,
        });
        if (
          requestId !== declSeqRef.current ||
          !connRef.current.address ||
          connRef.current.address.toLowerCase() !== addr.toLowerCase() ||
          connRef.current.wrongNetwork
        ) {
          throw new Error('Wallet account or network changed during declaration signing; aborted.');
        }
        const record = {
          account: signed.declarationJson.account,
          chainId: Number(cfg.chainId),
          gateAddress: cfg.contracts.eligibilityGate,
          declarationJson: signed.declarationJson,
          signature: signed.signature,
          digest: signed.digest,
          verifiedAt: new Date().toISOString(),
          serverVerification: signed.serverVerification,
        };
        savePersistedDeclaration(record);
        declRef.current = record;
        setEligibilityDeclaration(record);
        if (signed.screening) {
          setEligibilityScreening({
            loading: false,
            checkedOnce: true,
            data: signed.screening,
            error: '',
          });
        }
        setDeclActionState({
          signing: false,
          verifying: false,
          bumpingNonce: false,
          error: '',
          notice: `Signed & verified EIP-712 Regulation S declaration (${record.declarationJson.jurisdiction}, nonce ${record.declarationJson.nonce}).`,
        });
        void refreshWalletData(addr, attestationRef.current, { wrongNetwork: false });
        return record;
      } catch (err) {
        const msg = formatWeb3Error(err);
        if (requestId === declSeqRef.current) {
          setDeclActionState({ signing: false, verifying: false, bumpingNonce: false, error: msg, notice: '' });
        }
        throw err;
      }
    },
    [refreshWalletData]
  );

  const ensureDeclarationVerifiedForTx = useCallback(async () => {
    const cfg = getFrontendConfig();
    const addr = connRef.current.address;
    if (!connRef.current.connected || !addr || connRef.current.wrongNetwork) {
      throw new Error(
        connRef.current.wrongNetwork
          ? `Switch wallet to Base (${cfg.chainId}) before submitting transactions.`
          : 'Connect your wallet on Base before submitting transactions.'
      );
    }

    const requestId = declSeqRef.current;
    setDeclActionState((prev) => ({ ...prev, verifying: true, error: '' }));
    try {
      const verified = await verifyStoredDeclarationOnServer({
        declaration: declRef.current,
        address: addr,
        attestationHex: attestationRef.current,
        cfg,
      });
      if (
        requestId !== declSeqRef.current ||
        !connRef.current.connected ||
        !connRef.current.address ||
        connRef.current.address.toLowerCase() !== addr.toLowerCase() ||
        connRef.current.wrongNetwork
      ) {
        throw new Error('Wallet account or network changed during declaration verification; transaction cancelled.');
      }
      declRef.current = verified.record;
      setEligibilityDeclaration(verified.record);
      setDeclActionState((prev) => ({ ...prev, verifying: false, error: '' }));
      return verified;
    } catch (err) {
      const msg = formatWeb3Error(err);
      const status = err && typeof err === 'object' ? err.status : null;
      if (requestId === declSeqRef.current) {
        if (status === 400 || status === 403) {
          savePersistedDeclaration(null);
          declRef.current = null;
          setEligibilityDeclaration(null);
        } else {
          setEligibilityDeclaration((prev) => (prev ? { ...prev, serverVerification: null } : null));
        }
        setDeclActionState((prev) => ({ ...prev, verifying: false, error: msg }));
      }
      throw err;
    }
  }, []);

  const bumpMyEligibilityNonce = useCallback(async () => {
    const cfg = getFrontendConfig();
    const addr = connRef.current.address;
    if (!connRef.current.connected || !addr || connRef.current.wrongNetwork) {
      const msg = 'Connect your wallet on Base before bumping EligibilityGate nonce.';
      setDeclActionState((prev) => ({ ...prev, error: msg, notice: '' }));
      throw new Error(msg);
    }
    const requestId = ++declSeqRef.current;
    setDeclActionState({ signing: false, verifying: false, bumpingNonce: true, error: '', notice: '' });
    try {
      const res = await web3BumpEligibilityNonce({
        address: addr,
        provider: getInjectedProvider(),
        cfg,
      });
      if (requestId !== declSeqRef.current) return res;
      savePersistedDeclaration(null);
      declRef.current = null;
      reverifyAttemptedKeyRef.current = null;
      setEligibilityDeclaration(null);
      setDeclActionState({
        signing: false,
        verifying: false,
        bumpingNonce: false,
        error: '',
        notice: `Bumped EligibilityGate userNonce to ${res.newNonce} (tx ${res.txHash}); prior declarations invalidated.`,
      });
      await Promise.all([
        refreshWalletData(addr, attestationRef.current, { wrongNetwork: false }),
        refreshEligibilityScreening(addr, attestationRef.current, { allowRecoverFromRestriction: false }),
      ]);
      return res;
    } catch (err) {
      const msg = formatWeb3Error(err);
      if (requestId === declSeqRef.current) {
        setDeclActionState({ signing: false, verifying: false, bumpingNonce: false, error: msg, notice: '' });
      }
      throw err;
    }
  }, [refreshEligibilityScreening, refreshWalletData]);

  const disconnect = useCallback(async () => {
    ++snapshotSeqRef.current;
    ++screeningSeqRef.current;
    clearEligibilityDeclaration();
    setWalletSnapshot({ loading: false, data: null });
    setEligibilityScreening({ loading: true, checkedOnce: false, data: null, error: '' });
    updateWalletConn({
      connected: false,
      address: null,
      chainId: null,
      wrongNetwork: false,
      connecting: false,
      walletError: '',
    });
    await signOut();
  }, [clearEligibilityDeclaration, signOut, updateWalletConn]);

  const matchingWalletEligibility =
    walletSnapshot.data && walletConn.address && walletSnapshot.data.address === walletConn.address
      ? walletSnapshot.data.eligibility
      : null;

  const hardRestricted = isHardRestrictionScreening(
    eligibilityScreening.data,
    matchingWalletEligibility
  );

  const eligibilityDeclarationStatus = useMemo(
    () =>
      evaluateEligibilityDeclaration(eligibilityDeclaration, {
        address: walletConn.address,
        config: getFrontendConfig(),
        walletEligibility: matchingWalletEligibility,
        screeningData: eligibilityScreening.data,
      }),
    [eligibilityDeclaration, eligibilityScreening.data, matchingWalletEligibility, walletConn.address]
  );

  const web3 = useMemo(
    () => ({
      config: getFrontendConfig(),
      ...walletConn,
      siweSession: siweState.session,
      siweSubscriptions: siweState.subscriptions,
      siwePreferences: siweState.preferences,
      signingIn: siweState.signingIn,
      siweError: siweState.siweError,
      siweNotice: siweState.siweNotice,
      attestationHex,
      setAttestationHex,
      loadingState: walletSnapshot.loading,
      walletState: walletSnapshot.data,
      eligibilityScreening,
      hardRestricted,
      eligibilityDeclaration,
      eligibilityDeclarationStatus,
      eligibilityDeclarationValid: eligibilityDeclarationStatus.valid,
      signingDeclaration: declActionState.signing,
      verifyingDeclaration: declActionState.verifying,
      bumpingEligibilityNonce: declActionState.bumpingNonce,
      declarationError: declActionState.error,
      declarationNotice: declActionState.notice,
      connect,
      disconnect,
      switchNetwork,
      signIn,
      signOut,
      refreshEligibilityScreening: (opts = {}) =>
        refreshEligibilityScreening(undefined, attestationRef.current, opts),
      signAndVerifyDeclaration,
      ensureDeclarationVerifiedForTx,
      bumpMyEligibilityNonce,
      clearEligibilityDeclaration,
      refresh: () =>
        Promise.all([
          refreshWalletData(connRef.current.address, attestationRef.current, {
            wrongNetwork: connRef.current.wrongNetwork,
          }),
          refreshEligibilityScreening(undefined, attestationRef.current),
        ]),
    }),
    [
      walletConn,
      siweState,
      attestationHex,
      walletSnapshot,
      eligibilityScreening,
      hardRestricted,
      eligibilityDeclaration,
      eligibilityDeclarationStatus,
      declActionState,
      connect,
      disconnect,
      switchNetwork,
      signIn,
      signOut,
      refreshEligibilityScreening,
      signAndVerifyDeclaration,
      ensureDeclarationVerifiedForTx,
      bumpMyEligibilityNonce,
      clearEligibilityDeclaration,
      refreshWalletData,
    ]
  );

  return (
    <StoreContext.Provider value={{ state, act, alerts: buildAlerts(state), web3 }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  return useContext(StoreContext);
}
