import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Gitignored dirs `eslint .` could still traverse — flat config does not read .gitignore, so
  // each must be listed explicitly (coverage from vitest; test-results + playwright-report from
  // the e2e run, whose HTML report bundles lintable JS). `.night-run/` is the odd one out: not
  // build output but machine-local night-run runtime state, including hand-written one-off
  // launchers written for bare node, whose globals this config does not supply (tkt-e69819938f33).
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.night-run/**', 'test-results/**', 'playwright-report/**', '.claude/worktrees/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  // Pin the root explicitly: a worktree under .claude/worktrees is a second full checkout with its
  // own tsconfig, so typescript-eslint sees multiple candidate roots and fails EVERY file with a
  // parse error — 454 of them, enforcing nothing. CI never sees it (no worktree there), so without
  // this the breakage lands only on whoever followed CLAUDE.md and made one. Same root cause the
  // vitest exclude above fixes for the test runner (tkt-17d81c74b662).
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        // Fail LOUDLY on a TypeScript version typescript-eslint does not support (tkt-fd8f0380f70a).
        //
        // The default is 'warn', and the warning is printed only when a loggerFn was passed or
        // `process.stdout.isTTY` — see typescript-estree's warnAboutTSVersion.js. We pass no logger
        // and CI has no TTY, so on an unsupported TypeScript the default lints every file with a
        // compiler typescript-eslint disclaims, prints nothing at all, and reports the gate GREEN.
        // A rule set that cannot be trusted is worse than one that refuses to run.
        onUnsupportedTypeScriptVersion: 'error',
      },
    },
  },
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
