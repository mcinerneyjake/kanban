import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Generated/build output — gitignored, but flat config does not read
  // .gitignore, so every generated dir `eslint .` could traverse must be listed
  // here explicitly (coverage from vitest; test-results + playwright-report from
  // the e2e run, whose HTML report bundles lintable JS).
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**', '.claude/worktrees/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  // Pin the root explicitly: a worktree under .claude/worktrees is a second full checkout with its
  // own tsconfig, so typescript-eslint sees multiple candidate roots and fails EVERY file with a
  // parse error — 454 of them, enforcing nothing. CI never sees it (no worktree there), so without
  // this the breakage lands only on whoever followed CLAUDE.md and made one. Same root cause the
  // vitest exclude above fixes for the test runner (tkt-17d81c74b662).
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'semi': ['error', 'always'],
      // Enforce the CLAUDE.md TypeScript conventions in lint, not just prose:
      // no `as` casts, no non-null `!`, no `any`. `as const` is exempt below.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
    },
  },
  {
    files: ['src/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['server/**', 'mcp/**', 'shared/**', 'agent/**'],
    languageOptions: { globals: globals.node },
  },
  // Node tooling outside the app dirs: build/test config, one-off scripts, the
  // Claude Code git-guard hook, and any root-level helper (the CLAUDE.md
  // "Temporary scripts" convention writes one-off scripts to the project root).
  // All run under Node (ESM); `*.{js,mjs,ts,cjs}` is depth-1 so it never shadows
  // the browser globals on src/**.
  {
    files: ['scripts/**/*.{js,mjs}', 'analysis/**/*.{js,mjs}', '.claude/**/*.{js,mjs}', '**/*.config.{js,ts,mjs}', '*.{js,mjs,ts,cjs}'],
    languageOptions: { globals: globals.node },
  },
  // Playwright e2e specs drive a browser from a Node process, so they touch both.
  {
    files: ['e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
