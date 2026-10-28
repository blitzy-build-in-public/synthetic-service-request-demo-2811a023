import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { AppState, AppStore } from './store';

// Private, so components reach the store only through the hooks below. The `null` default lets a
// hook tell a missing provider apart from a real store instead of failing later on an undefined member.
const StoreContext = createContext<AppStore | null>(null);
StoreContext.displayName = 'StoreContext';

/** Props of `StoreProvider`. */
export interface StoreProviderProps {
  /** The store built by createAppStore. */
  readonly store: AppStore;
  /** The application tree. */
  readonly children: ReactNode;
}

/** Makes `store` available to `useAppState` and `useAppStore` everywhere inside `children`. */
export function StoreProvider({ store, children }: StoreProviderProps) {
  return <StoreContext value={store}>{children}</StoreContext>;
}

// Rendering outside a provider is a programming fault, so it throws rather than returning a result.
function useRequiredStore(hookName: string): AppStore {
  const store = useContext(StoreContext);
  if (store === null) {
    throw new Error(`${hookName} must be used inside a StoreProvider.`);
  }
  return store;
}

/** Returns the current store snapshot and re-renders the caller whenever the store publishes a new one. */
export function useAppState(): AppState {
  const store = useRequiredStore('useAppState');
  // Pass the stable methods directly to avoid resubscribing; `getState` returns the same snapshot until publication.
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** Returns the store itself, for `dispatch`, `setRole`, `resetToSamples` and `clearRefusal`. */
export function useAppStore(): AppStore {
  return useRequiredStore('useAppStore');
}
