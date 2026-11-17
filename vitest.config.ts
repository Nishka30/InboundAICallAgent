import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Co-located unit tests under src/**. Excluded from the production build via
    // tsconfig.build.json; NODE_ENV=test silences the logger.
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Force provider secrets empty in tests so nothing ever touches the network
    // and the logger stays silent; tests inject keys/clients explicitly.
    env: { NODE_ENV: 'test', RETELL_API_KEY: '', GUIDED_BOOST_API_KEY: '' },
    clearMocks: true,
  },
});
