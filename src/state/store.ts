import type { Role, ServiceRequest } from '../domain/model';
import { applyCommand } from '../domain/transitions';
import type { Command, CommandResult } from '../domain/transitions';
import type { LoadResult, SaveResult, StorageAdapter } from '../storage/localStore';
import { createSampleRequests } from '../storage/sampleData';

/** Why stored data could not be used at startup; the notice offering reset shows while one is set. */
export type LoadIssue = 'unreadable' | 'wrongVersion';

/** One immutable store snapshot: a new frozen object is published for every change, and none in between. */
export interface AppState {
  /** Every request in creation order, which is also ascending ID order and display order. */
  readonly requests: readonly ServiceRequest[];
  /** The simulated role commands run as; a demo aid, not authentication. */
  readonly role: Role;
  /** True when storage was unavailable at startup or the latest save attempt failed. */
  readonly storageWarning: boolean;
  /** Set when stored data could not be used; cleared only once a save has replaced it. */
  readonly loadIssue: LoadIssue | null;
  /** Message of the last refused or not-found command; cleared by a success, a role switch or `clearRefusal`. */
  readonly refusal: string | null;
}

/** Called after each published snapshot; reads the new state through `getState`. */
export type StoreListener = () => void;

/** What the composition root or a test injects: the persistence port and the clock. */
export interface AppStoreOptions {
  /** `load` runs once at startup; `save` runs after each accepted command and each confirmed reset. */
  readonly storage: StorageAdapter;
  /** Returns the current time as an ISO 8601 string. */
  readonly now: () => string;
}

/** The single application store; every member is a plain function that stays correct when detached. */
export interface AppStore {
  /** Returns the current snapshot, the same reference until the next change. */
  readonly getState: () => AppState;
  /** Registers `listener` and returns a function removing that registration; calling it again does nothing. */
  readonly subscribe: (listener: StoreListener) => () => void;
  /** Runs `command` through the domain as the current role, saving then publishing on success, and returns the domain's result unchanged. */
  readonly dispatch: (command: Command) => CommandResult;
  /** Switches the simulated role and clears any refusal; never saves. */
  readonly setRole: (role: Role) => void;
  /** Replaces every request with fresh samples, saves them, then publishes; call only after the user confirms. */
  readonly resetToSamples: () => void;
  /** Clears the refusal message; publishes nothing when there is none. */
  readonly clearRefusal: () => void;
}

type StartupData = Pick<AppState, 'requests' | 'storageWarning' | 'loadIssue'>;

// A missing key or blocked storage starts from the samples so a working demo shows at once.
// Unusable stored data starts empty instead: showing samples would misrepresent what is stored.
function startupData(loaded: LoadResult): StartupData {
  switch (loaded.kind) {
    case 'ok':
      return { requests: loaded.requests, storageWarning: false, loadIssue: null };
    case 'empty':
      return { requests: createSampleRequests(), storageWarning: false, loadIssue: null };
    case 'unavailable':
      return { requests: createSampleRequests(), storageWarning: true, loadIssue: null };
    case 'unreadable':
    case 'wrongVersion':
      return { requests: [], storageWarning: false, loadIssue: loaded.kind };
    default: {
      const unreachable: never = loaded;
      return unreachable;
    }
  }
}

// The warning follows the latest save attempt, so a successful retry clears it. A load issue stays
// until a save has actually replaced the unusable stored value, so a failed save keeps its notice.
function savedState(
  state: AppState,
  requests: readonly ServiceRequest[],
  saved: SaveResult,
): AppState {
  return {
    ...state,
    requests,
    storageWarning: !saved.ok,
    loadIssue: saved.ok ? null : state.loadIssue,
    refusal: null,
  };
}

interface Subscription {
  readonly listener: StoreListener;
}

/** Builds the store from what `storage.load()` finds, never writing at startup, with the role starting as Requester. */
export function createAppStore({ storage, now }: AppStoreOptions): AppStore {
  // Startup only reads: whatever load found, the stored value is replaced only by a later accepted
  // command or confirmed reset. The role is never persisted, so every start opens as Requester.
  const initial: AppState = {
    ...startupData(storage.load()),
    role: 'Requester',
    refusal: null,
  };
  let state = Object.freeze(initial);
  // One record per call to `subscribe`, so a callback registered twice (as a strict-mode remount does when
  // it resubscribes) is removed only by its own unsubscribe, and a repeated unsubscribe touches nothing else.
  const subscriptions = new Set<Subscription>();

  function publish(next: AppState): void {
    state = Object.freeze(next);
    // A copy, so a listener that subscribes or unsubscribes during notification cannot disturb the loop.
    for (const { listener } of [...subscriptions]) {
      listener();
    }
  }

  // Persistence comes before notification, so subscribers never render a change that was not yet saved.
  function persist(requests: readonly ServiceRequest[]): void {
    const saved = storage.save(requests);
    publish(savedState(state, requests, saved));
  }

  function getState(): AppState {
    return state;
  }

  function subscribe(listener: StoreListener): () => void {
    const subscription: Subscription = { listener };
    subscriptions.add(subscription);
    return () => {
      subscriptions.delete(subscription);
    };
  }

  function dispatch(command: Command): CommandResult {
    const result = applyCommand(state.requests, command, state.role, now());
    if (result.ok) {
      persist(result.requests);
      return result;
    }
    const { error } = result;
    switch (error.kind) {
      case 'validation':
        // Nothing changed: the calling form shows the field errors, and the snapshot stays the same reference.
        return result;
      case 'refused':
      case 'notFound':
        publish({ ...state, refusal: error.message });
        return result;
      default: {
        const unreachable: never = error;
        return unreachable;
      }
    }
  }

  function setRole(role: Role): void {
    if (role === state.role && state.refusal === null) {
      return;
    }
    publish({ ...state, role, refusal: null });
  }

  function resetToSamples(): void {
    persist(createSampleRequests());
  }

  // Called on every route change, so it publishes only when there is a refusal to clear.
  function clearRefusal(): void {
    if (state.refusal === null) {
      return;
    }
    publish({ ...state, refusal: null });
  }

  return { getState, subscribe, dispatch, setRole, resetToSamples, clearRefusal };
}
