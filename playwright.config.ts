import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:5173', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
    // Point the drafting model at a dead port so the intake health check reports
    // "down" — the create modal then falls to the manual form deterministically,
    // independent of whether a local LLM (LM Studio etc.) happens to be running.
    // (This is the CI reality too: no model available.)
    env: { ...process.env, LLM_BASE_URL: 'http://127.0.0.1:9', EMBED_BASE_URL: 'http://127.0.0.1:9' },
  },
});
