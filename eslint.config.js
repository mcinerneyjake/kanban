import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
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
)
