import { useLayoutEffect, useRef } from 'react';
import { DemoBanner } from './components/DemoBanner';
import { RoleSwitch } from './components/RoleSwitch';
import { ResetControl } from './components/ResetControl';
import { StorageNotice } from './components/StorageNotice';
import { ListView } from './components/ListView';
import { DetailsView, NotFound } from './components/DetailsView';
import { hrefForList, useHashRoute } from './components/useHashRoute';
import type { Route } from './components/useHashRoute';
import { useAppState, useAppStore } from './state/StoreContext';

function renderRoute(route: Route) {
  switch (route.kind) {
    case 'list':
      return <ListView />;
    case 'details':
      // The key remounts the view for each request, so edit mode and open forms never carry over.
      return <DetailsView key={route.id} id={route.id} />;
    case 'notFound':
      // An unknown request ID is a details route; DetailsView reports that one with its own message.
      return <NotFound message="Page not found." />;
    default: {
      const unreachable: never = route;
      return unreachable;
    }
  }
}

// Compares routes by value, so an equal route parsed again never counts as a change.
function routeKeyOf(route: Route): string {
  return route.kind === 'details' ? `details:${route.id}` : route.kind;
}

/** The shell framing every view: demo banner, header controls, storage and refusal notices, then the routed view. */
export function App() {
  const { refusal } = useAppState();
  const store = useAppStore();
  const route = useHashRoute();
  const routeKey = routeKeyOf(route);
  const previousRouteKey = useRef(routeKey);
  const shellRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  // A refusal belongs to the view it was raised on, so leaving that view clears it. Comparing against the
  // previous key skips the first mount and StrictMode's repeated effect run; success and role-switch
  // clearing happen in the store. A hash change keeps the old view's scroll offset, which on a narrow
  // screen hides the banner, role switch and reset, so the new view opens at the top of the shell. The
  // control that navigated usually unmounts with the old view, which drops focus to the page body, so
  // focus moves to the new view instead (WCAG 2.4.3); preventScroll keeps that top position, as a plain
  // focus() scrolls a tall view's end into sight. A layout effect does both before the browser paints,
  // so no frame shows the new view at the old offset or under the old view's refusal.
  useLayoutEffect(() => {
    if (previousRouteKey.current !== routeKey) {
      previousRouteKey.current = routeKey;
      store.clearRefusal();
      shellRef.current?.scrollIntoView({ block: 'start' });
      mainRef.current?.focus({ preventScroll: true });
    }
  }, [routeKey, store]);

  return (
    <div ref={shellRef} className="app-shell">
      {/* The URL hash is the route, so a fragment link such as href="#main" would show "Page not found.".
          The skip link is therefore a button that moves focus to the main region instead; the next Tab
          then scrolls the view's first control into sight. */}
      <button
        type="button"
        className="skip-link"
        onClick={() => {
          mainRef.current?.focus({ preventScroll: true });
        }}
      >
        Skip to main content
      </button>
      <DemoBanner />
      {/* Each view renders its own h1, so the title is a link home rather than a heading. */}
      <header className="app-header">
        <a className="app-title" href={hrefForList()}>
          Service Request Demo
        </a>
        <div className="header-controls">
          <RoleSwitch />
          {/* Keyed by route, so an open reset prompt closes with the view it was opened on. */}
          <ResetControl key={routeKey} />
        </div>
      </header>
      <StorageNotice />
      {refusal !== null && (
        <p role="alert" className="notice notice--alert">
          {refusal}
        </p>
      )}
      <main ref={mainRef} className="view" tabIndex={-1}>
        {renderRoute(route)}
      </main>
    </div>
  );
}
