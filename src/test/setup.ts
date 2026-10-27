// Vitest globals are off, so React Testing Library cannot register its own cleanup and this file does it.
// Vitest also runs this file for `// @vitest-environment node` suites (the domain tests), where `window`
// is undefined; the guard registers no hook there.
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

if (typeof window !== 'undefined') {
  // Browsers implement scrollIntoView, which ActionPanel calls on its note form, but jsdom does not.
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = vi.fn();
  }
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.location.hash = '';
  });
}
