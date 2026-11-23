import { defineConfig } from 'vitest/config';

// npx vitest run --config scripts/measure.config.ts  (PARTIES=30 par défaut)
export default defineConfig({
  test: { include: ['scripts/measure-cards.test.ts'], testTimeout: 0, hookTimeout: 0 },
});
