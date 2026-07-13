import { defineConfig, devices } from 'playwright/test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The specs create and delete tickets through the UI. Point the dev server at
// throwaway temp dirs so a run never mutates the real tickets/ or events/ dirs
// (by-title cleanup used to leak strays into the real board if the runner died).
// The dirs must exist before webServer starts (its env references them below),
// so they're made here at config load; globalTeardown removes them after the run
// via the paths stashed on process.env.
const e2eTicketsDir = mkdtempSync(path.join(os.tmpdir(), 'kanban-e2e-tickets-'));
const e2eEventsDir = mkdtempSync(path.join(os.tmpdir(), 'kanban-e2e-events-'));
process.env.E2E_TMP_TICKETS_DIR = e2eTicketsDir;
process.env.E2E_TMP_EVENTS_DIR = e2eEventsDir;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  globalTeardown: './e2e/globalTeardown.ts',
  use: { baseURL: 'http://localhost:5173', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    // Never attach to a manually-started dev server — it would be serving the
    // real board, defeating the temp-dir isolation below.
    reuseExistingServer: false,
    timeout: 15_000,
    env: {
      ...process.env,
      // Point the drafting model at a dead port so the intake health check reports
      // "down" — the create modal then falls to the manual form deterministically,
      // independent of whether a local LLM (LM Studio etc.) happens to be running.
      // (This is the CI reality too: no model available.)
      LLM_BASE_URL: 'http://127.0.0.1:9',
      EMBED_BASE_URL: 'http://127.0.0.1:9',
      TICKETS_DIR_OVERRIDE: e2eTicketsDir,
      EVENTS_DIR_OVERRIDE: e2eEventsDir,
    },
  },
});
