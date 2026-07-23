import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `.claude/worktrees/**` holds full checkouts (CLAUDE.md tells concurrent sessions to make one),
    // so without it vitest collects every suite twice AND tries to run the worktree's Playwright
    // specs — reddening the husky gate from the main checkout whenever a worktree merely exists
    // (tkt-17d81c74b662). The bare `e2e/**` above only covers this checkout's own.
    exclude: ['e2e/**', 'node_modules/**', '.claude/worktrees/**'],
    coverage: {
      provider: 'v8',
      // Scope coverage to the testable logic layers (per CLAUDE.md's testing
      // table). React components and transport entrypoints carry no
      // unit-testable logic; the agent module is still under phased
      // construction and not yet in the testing table (its own tests run, but
      // it is excluded from the gate for now). So the threshold reflects real,
      // asserted behaviour — not UI glue or in-flight code.
      include: [
        'server/tickets.ts',
        'server/index.ts',
        'server/events.ts',
        'server/stream.ts',
        'server/ticketWatcher.ts',
        'server/lib/**/*.ts',
        'server/middleware/**/*.ts',
        'server/schemas/**/*.ts',
        'mcp/handlers.ts',
        'shared/constants.ts',
        'src/lib/**/*.ts',
      ],
      reporter: ['text', 'html'],
      // Enterprise-floor gate: catches a regression in coverage discipline
      // without pinning the suite to its current high-water mark (~97%/94%).
      // A floor, not a target — see CLAUDE.md testing guidance.
      thresholds: {
        // perFile so an untested new function can't hide behind the aggregate
        // (~97%) average — each included layer must independently clear the floor.
        perFile: true,
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
