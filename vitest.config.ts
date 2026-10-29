import { defineConfig } from 'vitest/config';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: { include: ['tests/**/*.test.{ts,tsx}'], environment: 'node' }, // UI tests opt into jsdom with a file-level pragma
});
