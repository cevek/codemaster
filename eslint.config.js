// @ts-check
import tseslint from 'typescript-eslint';

// Minimal, high-signal ESLint for an agent-built, long-lived codebase.
// Rule of admission: a rule earns its place only if it prevents real damage or
// enforces an architectural invariant. No style bikeshedding — that is the
// formatter's job, not the linter's.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'examples/', 'test/fixtures/'] },

  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Type-aware linting — required by the `any`-leak and promise rules below.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      // ── File size — agents love growing a file to thousands of lines ─────────
      // 300 lines of real code; comments and blank lines do not count.
      'max-lines': ['error', { max: 300, skipComments: true, skipBlankLines: true }],

      // ── No `any`, explicit or leaked, anywhere it surfaces ───────────────────
      // (Implicit `any` at a declaration is caught by tsconfig `noImplicitAny`;
      //  these catch `any` that enters from an untyped boundary and flows on.)
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // ── Async safety — this is a long-lived daemon ───────────────────────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // ── Honesty & dead code ──────────────────────────────────────────────────
      // No `!`. With `noUncheckedIndexedAccess` on, handle `undefined` — don't
      // assert it away. This is the "never lie" north star applied to the code
      // itself: be honest about absence.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // ── stdout is the agent-facing payload ───────────────────────────────────
      // A stray console.* corrupts the MCP/CLI output stream. Route everything
      // through the debug subsystem (ARCHITECTURE §13) or the one stdout writer;
      // opt out with an explicit eslint-disable there.
      'no-console': 'error',

      // ── Discriminated unions must be handled exhaustively ────────────────────
      // The contracts have several (Confidence, HandleRebind, OpResult, plus each
      // plugin's internal kinds); a forgotten case when a new variant is added is a
      // silent bug.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // ── Cheap, zero-noise hygiene ────────────────────────────────────────────
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-debugger': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
