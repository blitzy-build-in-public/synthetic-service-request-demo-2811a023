import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StoreProvider } from './state/StoreContext';
import { createAppStore } from './state/store';
import { createLocalStorageAdapter } from './storage/localStore';
import './styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  // A missing mount point is a programming fault in index.html, the one startup failure that may throw.
  throw new Error('Service Request Demo cannot start: index.html has no element with id "root".');
}

// A getter rather than the object: reading `window.localStorage` itself throws a SecurityError when
// storage is blocked, and the adapter calls the getter inside `try` on every load and save.
const storage = createLocalStorageAdapter(() => window.localStorage);

// The browser clock is injected here and nowhere else, so the domain and store stay deterministic in tests.
// Building the store only reads storage; nothing is written until a change succeeds or a reset is confirmed.
const store = createAppStore({ storage, now: () => new Date().toISOString() });

createRoot(rootElement).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
