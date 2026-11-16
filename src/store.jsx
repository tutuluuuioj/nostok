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

  const refreshWalletData = useCallback(
    async (targetAddr = connRef.current.address, customAttestation = attestationHex) => {
      if (!targetAddr) {
        setWalletSnapshot({ loading: false, data: null });
        return null;
      }
      const cfg = getFrontendConfig();
      setWalletSnapshot((prev) => ({ loading: true, data: prev.data }));
      const snapshot = await fetchWalletState(targetAddr, { cfg, attestationHex: customAttestation });
      setWalletSnapshot({ loading: false, data: snapshot });

      const activeSess = siweRef.current;
      if (activeSess && activeSess.walletAddress.toLowerCase() === targetAddr.toLowerCase()) {
        try {
          const notifState = await fetchNotificationsSessionState({
            token: activeSess.token,
            cfg,
          });
          setSiweState((prev) => ({
            ...prev,
            subscriptions: notifState.subscriptions,
            preferences: notifState.preferences,
            siweError: '',
          }));
        } catch (err) {
          if (err && typeof err === 'object' && err.status === 401) {
            setSiweState({
              session: null,
              subscriptions: null,
              preferences: null,
              signingIn: false,
              siweError: 'Notifications session expired or revoked. Please sign in again.',
              siweNotice: '',
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
    [attestationHex]
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
      if (!nextAddr || !prevAddr || nextAddr.toLowerCase() !== prevAddr.toLowerCase()) {
        // Always invalidate in-memory SIWE bearer token on account change or disconnect
        setSiweState({
          session: null,
          subscriptions: null,
          preferences: null,
          signingIn: false,
          siweError: '',
          siweNotice: nextAddr ? 'Wallet changed. Sign in with SIWE for this address.' : '',
        });
      }
      setWalletConn((prev) => ({
        ...prev,
        connected: Boolean(nextAddr),
        address: nextAddr,
        walletError: '',
      }));
      if (nextAddr) {
        void refreshWalletData(nextAddr, attestationHex);
      } else {
        setWalletSnapshot({ loading: false, data: null });
      }
    };

    const onChainChanged = (rawChain) => {
      const nextChainId = parseChainIdHex(rawChain);
      const currentCfg = getFrontendConfig();
      const wrong = nextChainId !== currentCfg.chainId;
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
  }, [attestationHex, refreshWalletData]);

  const connect = useCallback(async () => {
    const cfg = getFrontendConfig();
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
      await refreshWalletData(res.address, attestationHex);
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
      let subscriptions = null;
      let preferences = null;
      try {
        const loaded = await fetchNotificationsSessionState({ token: session.token, cfg });
        subscriptions = loaded.subscriptions;
        preferences = loaded.preferences;
      } catch {
        // Non-fatal follow-up read; session itself is established
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
    try {
      if (current?.token) {
        await web3SignOutSiwe({ token: current.token, cfg });
      }
      setSiweState({
        session: null,
        subscriptions: null,
        preferences: null,
        signingIn: false,
        siweError: '',
        siweNotice: 'Signed out and revoked notification session.',
      });
    } catch (err) {
      setSiweState((prev) => ({
        ...prev,
        siweError: formatWeb3Error(err),
      }));
    }
  }, []);

  const disconnect = useCallback(async () => {
    await signOut();
    setWalletConn({
      connected: false,
      address: null,
      chainId: null,
      wrongNetwork: false,
      connecting: false,
      walletError: '',
    });
    setWalletSnapshot({ loading: false, data: null });
    setSiweState((prev) => ({ ...prev, siweNotice: '' }));
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
