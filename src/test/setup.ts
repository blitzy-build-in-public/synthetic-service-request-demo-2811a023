// Vitest globals are off, so React Testing Library cannot register its own cleanup and this file does it.
// Vitest also runs this file for `// @vitest-environment node` suites (the domain tests), where `window`
// is undefined; the guard registers no hook there.
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

if (typeof window !== 'undefined') {
  // jsdom lays nothing out and leaves scrollIntoView unimplemented, yet the app shell calls it on every
  // route change and ActionPanel on its note form. A mock stands in, and its calls are cleared after each
  // test, because vi.spyOn returns this same mock and a test asserting on its calls must see only its own.
  const scrollIntoView = vi.fn();
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = scrollIntoView;
  }
  afterEach(() => {
    scrollIntoView.mockClear();
    cleanup();
    window.localStorage.clear();
    window.location.hash = '';
  });
}
