import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vite's defaults are relied on for the dev and preview ports, the dist/ output and the single bundle.
// Vitest globals stay off, so src/test/setup.ts registers React Testing Library's cleanup itself.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
