import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { createSessionStore } from './session-store.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [store] = useState(createSessionStore);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    store.refresh();
    const recover = () => {
      if (document.visibilityState === 'visible') store.refresh({ background: true });
    };
    window.addEventListener('focus', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      store.cancelRead();
      window.removeEventListener('focus', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [store]);
  return <AuthContext.Provider value={{ ...state, refresh: store.refresh, mutate: store.mutate }}>{children}</AuthContext.Provider>;
}

export function useAuth() { return useContext(AuthContext); }
