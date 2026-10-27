// Vitest globals are off, so React Testing Library cannot register its own cleanup and this file does it.
// Vitest also runs this file for `// @vitest-environment node` suites (the domain tests), where `window`
// is undefined; the guard registers no hook there.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

if (typeof window !== 'undefined') {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.location.hash = '';
  });
}
