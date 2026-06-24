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
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
})
