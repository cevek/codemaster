// @ts-check
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';

// Minimal, high-signal ESLint for an agent-built, long-lived codebase.
// Rule of admission: a rule earns its place only if it prevents real damage or
// enforces an architectural invariant. No style bikeshedding — that is the
// formatter's job, not the linter's.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'examples/', 'test/fixtures/'] },

  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Type-aware linting — required by the `any`-leak and promise rules below.
        // tsconfig.test.json covers src + test (tests typecheck without a build).
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin, 'unused-imports': unusedImports },
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
      // Unused-vars is split so the mechanical, fully-autofixable case is removed for free:
      //   • `unused-imports/no-unused-imports` (autofixable) strips an unused import on
      //     `eslint --fix`, so an agent never burns tokens hand-deleting a dead import.
      //   • `unused-imports/no-unused-vars` keeps the *non-import* dead-binding error (same
      //     `^_` escape hatch as before) — it is NOT autofixable, by design: deleting a dead
      //     value can change behavior, so the agent stays in the loop on those.
      // The base `@typescript-eslint/no-unused-vars` must be off, or it double-reports the
      // imports the plugin already owns (the plugin's documented setup).
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
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

  {
    // ── Truncation deny-by-default (§3.4, t-188210) ──────────────────────────
    // The recurring silent-truncation class was the copy-pasted string-elide idiom
    // `s.length > CAP ? `${s.slice(0, CAP)}…` : s` — a bare `…` with no length/recovery, re-spelled
    // at ~15 sites so a fix to one never reached its siblings. Ban that exact shape everywhere but the
    // `common/truncate/` chokepoint, which owns it: a new string truncation MUST route through
    // `elideString` / `elideType` (which co-produce the §3.4 marker by construction). This is the
    // "realistic mirror" of the `~shape` Record precedent; the GENUINE compile mirror is the exhaustive
    // `Record<CapId, …>` registry. SCOPE (honest, §3.6): this catches the string-elide TERNARY idiom,
    // NOT list-cap truncation — a display-list `.slice` deny-by-default rests on routing through
    // `capList` + review, not this lint (a runtime `limit` cap has no fixed shape to match).
    files: ['src/**/*.ts'],
    ignores: ['src/common/truncate/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ConditionalExpression[test.operator=">"][consequent.type="TemplateLiteral"]:has(CallExpression[callee.property.name="slice"]):has(MemberExpression[property.name="length"])',
          message:
            'Ad-hoc string truncation (`x.length > CAP ? `${x.slice(0,CAP)}…` : x`) — route through common/truncate: elideString for a bare `…`, or elideType (CapId) for a type/signature marker. A silent/bare `…` reads as completeness (§3.4).',
        },
      ],
    },
  },

  {
    // node:test's top-level `test()` returns a promise that the runner itself awaits;
    // forcing `void test(...)` on every case is pure noise.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', name: 'test', package: 'node:test' }] },
      ],
    },
  },
);
