import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/wallet-core/**/*.test.ts', 'tests/mobile/**/*.test.ts'],
    environment: 'node',
  },
});
