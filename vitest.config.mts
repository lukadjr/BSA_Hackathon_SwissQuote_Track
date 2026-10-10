import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/wallet-core/**/*.test.ts'],
    environment: 'node',
  },
});
