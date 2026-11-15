import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { freshState, reducer } from './lib/book.js';
import { buildAlerts } from './lib/health.js';

const KEY = 'nostok-preview-v1';
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
    /* seed the book */
  }
  return freshState();
}

export function StoreProvider({ children }) {
  const [state, setState] = useState(init);
  const ref = useRef(state);
  ref.current = state;
  useEffect(() => {
    const { notice, error, ...rest } = state;
    sessionStorage.setItem(KEY, JSON.stringify(rest));
  }, [state]);
  const act = useCallback((action) => {
    const next = reducer(ref.current, action);
    ref.current = next;
    setState(next);
    return next;
  }, []);
  return (
    <StoreContext.Provider value={{ state, act, alerts: buildAlerts(state) }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  return useContext(StoreContext);
}
