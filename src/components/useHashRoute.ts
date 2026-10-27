import { useMemo, useSyncExternalStore } from 'react';

/** The view a location hash selects: the request list, one request's details, or an unrecognised hash. */
export type Route =
  | { kind: 'list' }
  | { kind: 'details'; id: string }
  | { kind: 'notFound' };

const LIST_HASHES: readonly string[] = ['', '#', '#/'];
const DETAILS_PREFIX = '#/requests/';

/** Maps a location hash to its route; only `#/` and `#/requests/:id` are recognised. */
export function parseHash(hash: string): Route {
  if (LIST_HASHES.includes(hash)) {
    return { kind: 'list' };
  }
  if (!hash.startsWith(DETAILS_PREFIX)) {
    return { kind: 'notFound' };
  }
  const segment = hash.slice(DETAILS_PREFIX.length);
  if (segment === '' || segment.includes('/')) {
    return { kind: 'notFound' };
  }
  try {
    // An unknown id is still a details route; the details view reports it as not found.
    return { kind: 'details', id: decodeURIComponent(segment) };
  } catch {
    // A malformed percent escape throws URIError and cannot name any request.
    return { kind: 'notFound' };
  }
}

/** Returns the hash of the request list. */
export function hrefForList(): string {
  return '#/';
}

/** Returns the hash of one request's details view; round-trips through `parseHash`. */
export function hrefForRequest(id: string): string {
  return `#/requests/${encodeURIComponent(id)}`;
}

// Subscribers notified synchronously by `navigate`, in addition to the browser's `hashchange`.
const listeners = new Set<() => void>();

// Module-level so its identity is stable: `useSyncExternalStore` re-subscribes whenever it changes.
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('hashchange', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('hashchange', listener);
  };
}

// The hash string itself is the snapshot, so it compares equal until the hash actually changes.
function getHashSnapshot(): string {
  return window.location.hash;
}

/** Moves to `href` and re-renders every subscribed route at once, ahead of the asynchronous `hashchange`. */
export function navigate(href: string): void {
  window.location.hash = href;
  // `hashchange` fires on a later task; notifying now switches the view within the current event.
  // The later event finds an unchanged snapshot, so it causes no second render.
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Returns the current route, keeping the same object while the hash is unchanged. */
export function useHashRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHashSnapshot);
  return useMemo(() => parseHash(hash), [hash]);
}
