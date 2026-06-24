import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      // Scope coverage to the testable logic layers (per CLAUDE.md's testing
      // table). React components, transport entrypoints, and the agent
      // placeholder carry no unit-testable logic and are deliberately omitted
      // so the threshold reflects real, asserted behaviour — not UI glue.
      include: [
        'server/tickets.ts',
        'server/index.ts',
        'mcp/handlers.ts',
        'shared/constants.ts',
        'src/lib/**/*.ts',
      ],
      reporter: ['text', 'html'],
      // Enterprise-floor gate: catches a regression in coverage discipline
      // without pinning the suite to its current high-water mark (~97%/94%).
      // A floor, not a target — see CLAUDE.md testing guidance.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
})
