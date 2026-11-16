import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getAddress } from 'viem';
import { freshState, reducer } from './lib/book.js';
import { getFrontendConfig } from './lib/contracts.js';
import { buildAlerts } from './lib/health.js';
import {
  connectWallet as web3ConnectWallet,
  fetchNotificationsSessionState,
  fetchWalletState,
  formatWeb3Error,
  getInjectedProvider,
  parseChainIdHex,
  readConnectedAccount,
  signInWithSiwe as web3SignInWithSiwe,
  signOutSiwe as web3SignOutSiwe,
  switchToBaseChain,
} from './lib/web3.js';

const KEY = 'nostok-store-v1';
const StoreContext = createContext(null);

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

  const siweRef = useRef(siweState.session);
  siweRef.current = siweState.session;
  const connRef = useRef(walletConn);
  connRef.current = walletConn;
  const snapshotSeqRef = useRef(0);

  const clearLocalSiweState = useCallback((opts = {}) => {
    setSiweState({
      session: null,
      subscriptions: null,
      preferences: null,
      signingIn: false,
      siweError: opts.siweError ?? '',
      siweNotice: opts.siweNotice ?? '',
    });
  }, []);

  const refreshWalletData = useCallback(
    async (targetAddr = connRef.current.address, customAttestation = attestationHex) => {
      const requestId = ++snapshotSeqRef.current;
      if (!targetAddr || connRef.current.wrongNetwork) {
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
    [attestationHex, clearLocalSiweState]
  );

  // Sync existing authorized account + subscribe to EIP-1193 accountsChanged / chainChanged
  useEffect(() => {
    const provider = getInjectedProvider();
    const cfg = getFrontendConfig();
    let mounted = true;

    readConnectedAccount(provider, cfg)
      .then((acc) => {
        if (!mounted || !acc) return;
        setWalletConn({
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
          void refreshWalletData(acc.address, attestationHex);
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

    const onAccountsChanged = (accounts) => {
      const nextRaw = Array.isArray(accounts) && accounts.length > 0 ? accounts[0] : null;
      const nextAddr = nextRaw ? getAddress(nextRaw) : null;
      const prevAddr = connRef.current.address;
      const prevSess = siweRef.current;
      ++snapshotSeqRef.current;
      setWalletSnapshot({ loading: false, data: null });

      if (!nextAddr || !prevAddr || nextAddr.toLowerCase() !== prevAddr.toLowerCase()) {
        if (prevSess?.token) {
          void web3SignOutSiwe({ token: prevSess.token, cfg: getFrontendConfig() }).catch(() => {});
        }
        clearLocalSiweState({
          siweNotice: nextAddr ? 'Wallet changed. Sign in with SIWE for this address.' : '',
        });
      }
      setWalletConn((prev) => ({
        ...prev,
        connected: Boolean(nextAddr),
        address: nextAddr,
        walletError: prev.wrongNetwork && nextAddr ? prev.walletError : '',
      }));
      if (nextAddr && !connRef.current.wrongNetwork) {
        void refreshWalletData(nextAddr, attestationHex);
      }
    };

    const onChainChanged = (rawChain) => {
      const nextChainId = parseChainIdHex(rawChain);
      const currentCfg = getFrontendConfig();
      const wrong = nextChainId !== currentCfg.chainId;
      ++snapshotSeqRef.current;
      setWalletSnapshot({ loading: false, data: null });

      if (wrong && siweRef.current) {
        const prevSess = siweRef.current;
        if (prevSess?.token) {
          void web3SignOutSiwe({ token: prevSess.token, cfg: currentCfg }).catch(() => {});
        }
        clearLocalSiweState({
          siweNotice: `Network changed away from Base (${currentCfg.chainId}); SIWE session cleared.`,
        });
      }

      setWalletConn((prev) => ({
        ...prev,
        chainId: Number.isNaN(nextChainId) ? prev.chainId : nextChainId,
        wrongNetwork: wrong,
        walletError: wrong
          ? `Wrong network (chainId ${nextChainId}). Switch to Base (${currentCfg.chainId}).`
          : '',
      }));
      if (!wrong && connRef.current.address) {
        void refreshWalletData(connRef.current.address, attestationHex);
      }
    };

    provider.on('accountsChanged', onAccountsChanged);
    provider.on('chainChanged', onChainChanged);
    return () => {
      mounted = false;
      if (typeof provider.removeListener === 'function') {
        provider.removeListener('accountsChanged', onAccountsChanged);
        provider.removeListener('chainChanged', onChainChanged);
      }
    };
  }, [attestationHex, clearLocalSiweState, refreshWalletData]);

  const connect = useCallback(async () => {
    const cfg = getFrontendConfig();
    ++snapshotSeqRef.current;
    setWalletSnapshot({ loading: false, data: null });
    setWalletConn((prev) => ({ ...prev, connecting: true, walletError: '' }));
    try {
      const res = await web3ConnectWallet(getInjectedProvider(), cfg);
      setWalletConn({
        connected: true,
        address: res.address,
        chainId: res.chainId,
        wrongNetwork: res.wrongNetwork,
        connecting: false,
        walletError: res.error || '',
      });
      if (!res.wrongNetwork) {
        await refreshWalletData(res.address, attestationHex);
      }
      return res;
    } catch (err) {
      const msg = formatWeb3Error(err);
      setWalletConn((prev) => ({ ...prev, connecting: false, walletError: msg }));
      return null;
    }
  }, [attestationHex, refreshWalletData]);

  const switchNetwork = useCallback(async () => {
    const cfg = getFrontendConfig();
    try {
      const nextChainId = await switchToBaseChain(getInjectedProvider(), cfg);
      setWalletConn((prev) => ({
        ...prev,
        chainId: nextChainId,
        wrongNetwork: false,
        walletError: '',
      }));
      if (connRef.current.address) {
        await refreshWalletData(connRef.current.address, attestationHex);
      }
      return true;
    } catch (err) {
      setWalletConn((prev) => ({ ...prev, walletError: formatWeb3Error(err) }));
      return false;
    }
  }, [attestationHex, refreshWalletData]);

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

  const disconnect = useCallback(async () => {
    ++snapshotSeqRef.current;
    setWalletSnapshot({ loading: false, data: null });
    setWalletConn({
      connected: false,
      address: null,
      chainId: null,
      wrongNetwork: false,
      connecting: false,
      walletError: '',
    });
    await signOut();
  }, [signOut]);

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
      connect,
      disconnect,
      switchNetwork,
      signIn,
      signOut,
      refresh: () => refreshWalletData(connRef.current.address, attestationHex),
    }),
    [
      walletConn,
      siweState,
      attestationHex,
      walletSnapshot,
      connect,
      disconnect,
      switchNetwork,
      signIn,
      signOut,
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
