import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    // The game's rules live in the Python backend (`backend/railroad`), which runs as its own
    // process in development: `uvicorn railroad.app:app --app-dir backend --port 8000`.
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
  build: {
    target: 'es2022',
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
