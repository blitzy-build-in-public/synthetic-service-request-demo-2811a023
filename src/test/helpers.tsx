import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { App } from '../App';
import type { CreateFields, Role } from '../domain/model';
import { StoreProvider } from '../state/StoreContext';
import { createAppStore } from '../state/store';
import type { AppStore } from '../state/store';
import { createLocalStorageAdapter } from '../storage/localStore';

/** Options for `createMemoryStorage`: raw seed values and an optional `setItem` failure mode. */
export interface MemoryStorageOptions {
  /** Raw strings present before first use, such as corrupt JSON or a version 2 envelope. */
  initial?: Record<string, string>;
  /** Makes every `setItem` throw before storing, as a full (`quota`) or blocked (`unavailable`) storage does. */
  failOnSet?: 'quota' | 'unavailable';
}

/** An in-memory `Storage` over a `Map`; its methods are own properties, so suites can `vi.spyOn` them. */
export function createMemoryStorage(options: MemoryStorageOptions = {}): Storage {
  const { initial = {}, failOnSet } = options;
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    get length(): number {
      return entries.size;
    },
    clear(): void {
      entries.clear();
    },
    getItem(key: string): string | null {
      return entries.get(key) ?? null;
    },
    key(index: number): string | null {
      return [...entries.keys()][index] ?? null;
    },
    removeItem(key: string): void {
      entries.delete(key);
    },
    setItem(key: string, value: string): void {
      // Thrown before storing, as browsers do, so a failed write leaves any earlier value in place.
      if (failOnSet === 'quota') {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      if (failOnSet === 'unavailable') {
        throw new DOMException('Storage is unavailable', 'SecurityError');
      }
      entries.set(key, String(value));
    },
  };
}

/** A `getStorage` that throws `SecurityError` on every call, standing in for a blocked `window.localStorage`. */
export const unavailableStorageGetter = (): Storage => {
  throw new DOMException('Storage is blocked', 'SecurityError');
};

/**
 * Returns a clock whose first call gives `start` and each later call `stepMs` more, as ISO 8601 strings.
 * The store calls `now()` on every dispatch, including refused and failed ones, so compare timestamps
 * with store state rather than hard-coding a tick count.
 */
export function createFixedClock(start = '2026-02-01T09:00:00.000Z', stepMs = 60000): () => string {
  const startMs = Date.parse(start);
  // Only the canonical `toISOString` form is accepted: the first value must equal `start` exactly, and
  // the storage parser rejects any other timestamp shape when a reload reads the saved data back.
  if (Number.isNaN(startMs) || new Date(startMs).toISOString() !== start) {
    throw new Error(
      `createFixedClock needs a canonical ISO 8601 start such as 2026-02-01T09:00:00.000Z, got "${start}".`,
    );
  }
  if (!Number.isFinite(stepMs)) {
    throw new Error(`createFixedClock needs a finite stepMs, got ${stepMs}.`);
  }
  let ticks = 0;
  return () => {
    const timestamp = new Date(startMs + ticks * stepMs).toISOString();
    ticks += 1;
    return timestamp;
  };
}

/** Recursively freezes every object and array reachable from `value` and returns `value` itself. */
export function deepFreeze<T>(value: T): T {
  freezeReachable(value, new WeakSet());
  return value;
}

// The visited set ends cycles while still descending into objects that were already frozen shallowly,
// such as a store snapshot whose requests are not frozen.
function freezeReachable(value: unknown, visited: WeakSet<object>): void {
  if (typeof value !== 'object' || value === null || visited.has(value)) {
    return;
  }
  visited.add(value);
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    freezeReachable(Reflect.get(value, key), visited);
  }
}

/** What `renderApp` injects; anything omitted falls back to jsdom's `window.localStorage`, a fresh fixed clock and `#/`. */
export interface RenderAppOptions {
  /** Storage used for every load and save; ignored when `getStorage` is given. */
  storage?: Storage;
  /** Replaces the storage lookup itself, for example with `unavailableStorageGetter`. */
  getStorage?: () => Storage;
  /** The store's clock; defaults to `createFixedClock()`. */
  now?: () => string;
  /** The location hash set before the first render; defaults to `#/`. */
  hash?: string;
}

/** The rendered app's store, for direct dispatches and state reads, and React Testing Library's `unmount`. */
export interface RenderAppResult {
  /** The store the rendered tree reads and dispatches through. */
  store: AppStore;
  /** Unmounts the rendered tree; storage keeps whatever was saved. */
  unmount: () => void;
}

/**
 * Builds the adapter and store as `src/main.tsx` does, with test doubles injected, and renders the app.
 * Each call builds a new store from whatever the storage then holds, so `unmount` followed by another
 * call over the same storage simulates a page reload.
 */
export function renderApp(options: RenderAppOptions = {}): RenderAppResult {
  const { storage, getStorage, now, hash } = options;
  // A getter, as in main.tsx, so the adapter looks the storage up afresh on every load and save.
  const adapter = createLocalStorageAdapter(getStorage ?? (() => storage ?? window.localStorage));
  const store = createAppStore({ storage: adapter, now: now ?? createFixedClock() });
  // Set before rendering, so `useHashRoute` reads the intended route on the first render.
  window.location.hash = hash ?? '#/';
  // The tree main.tsx renders, without StrictMode: its development-only double renders and effect runs
  // are not behaviour these suites check.
  const { unmount } = render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  return { store, unmount };
}

/** Moves to `hash` and dispatches `hashchange` synchronously inside `act`, so the routed view has switched on return. */
export function goToHash(hash: string): void {
  act(() => {
    const oldURL = window.location.href;
    window.location.hash = hash;
    // jsdom fires its own `hashchange` on a later task. This one switches the view now; the native one
    // then finds the hash snapshot unchanged and renders nothing.
    window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
  });
}

/** Reads every body row of `table` as cell strings: a cell's `<time>` `dateTime` when it has one, else its trimmed text. */
export function readTableRows(table: HTMLElement): string[][] {
  if (!(table instanceof HTMLTableElement)) {
    throw new Error(`readTableRows needs a <table> element, got <${table.tagName.toLowerCase()}>.`);
  }
  return Array.from(table.tBodies).flatMap((body) =>
    Array.from(body.rows, (row) => Array.from(row.cells, readCell)),
  );
}

// Dates are read as their ISO `dateTime`, never as locale-formatted text, which varies by machine.
function readCell(cell: HTMLTableCellElement): string {
  const time = cell.querySelector('time');
  return time === null ? cell.textContent.trim() : time.dateTime;
}

/** Returns the `<dd>` after the one `<dt>` whose trimmed text is `label`; throws when there is none or more than one. */
export function getDetailsValue(label: string): HTMLElement {
  const terms = Array.from(document.querySelectorAll('dt')).filter(
    (term) => term.textContent.trim() === label,
  );
  const term = terms[0];
  if (term === undefined) {
    throw new Error(`No details row is labelled "${label}".`);
  }
  if (terms.length > 1) {
    throw new Error(`${terms.length} details rows are labelled "${label}"; expected exactly one.`);
  }
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement) || value.tagName !== 'DD') {
    throw new Error(`The details row labelled "${label}" has no <dd> after its <dt>.`);
  }
  return value;
}

/** The accessible name of the header's role select. */
export const ROLE_LABEL = 'Role (demo simulation, not authentication)';

/** Switches the simulated role through the header's role select. */
export function switchRole(role: Role): void {
  fireEvent.change(screen.getByLabelText(ROLE_LABEL), { target: { value: role } });
}

/** Opens the list view's inline create form through its `New request` button. */
export function openCreateForm(): void {
  fireEvent.click(screen.getByRole('button', { name: 'New request' }));
}

/** Types `fields` into the open create form and clicks `Create draft`. */
export function fillCreateForm(fields: CreateFields): void {
  fireEvent.change(screen.getByLabelText('Requester name'), { target: { value: fields.requesterName } });
  fireEvent.change(screen.getByLabelText('Request type'), { target: { value: fields.requestType } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: fields.description } });
  fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
}

/** Opens the list view's create form, enters `fields` and creates the draft; the list view must be showing, and on success the app shows the new request's details view. */
export function createRequest(fields: CreateFields): void {
  openCreateForm();
  fillCreateForm(fields);
}

/** Clicks the button named `name` inside the details view's Actions region, so only offered actions can be clicked. */
export function clickAction(name: string): void {
  fireEvent.click(within(screen.getByRole('region', { name: 'Actions' })).getByRole('button', { name }));
}

/** Returns the trimmed text of the details row labelled `label`. */
export function detailsText(label: string): string {
  return getDetailsValue(label).textContent.trim();
}
