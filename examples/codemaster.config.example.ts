import { defineConfig } from 'codemaster';

// Example project config. Drop a `codemaster.config.ts` like this at your repo
// root. Everything is optional — the daemon autodetects sensible defaults — but
// declaring your project's conventions makes the answers sharper.
export default defineConfig({
  ts: {
    include: ['src/**/*.{ts,tsx,js,jsx}'],
    ignore: ['**/*.test.*', '**/*.stories.*', '**/*.gen.ts'],
    tsconfig: 'tsconfig.json',
    // packages: ['packages/app', 'packages/ui'], // monorepo
  },

  i18n: {
    locales: ['src/locales/en.json'],
    functions: ['t', 'i18n.t'],
    // Name the i18n module to match usages by SYMBOL IDENTITY instead of by name: a t('…')
    // counts only when its callee resolves to a function FROM this module (so a same-named t
    // elsewhere no longer fabricates a usage, and a renamed destructure / namespace alias of the
    // real one is caught). Omit to keep the by-name behaviour.
    module: '@/lib/i18n',
    // The hook that returns the function — matches `const { t } = useTranslation()` (and a
    // renamed `{ t: x }`) by identity. Requires `module`.
    hook: 'useTranslation',
    templateLiterals: true,
  },

  scss: {
    modules: ['src/**/*.module.scss'],
    importStyle: 'default',
  },

  schema: {
    entrypoint: 'src/api/schema.d.ts',
    generator: 'openapi-typescript',
  },

  plugins: [
    'react',
    'tanstack-router',
    'react-query',
    'zustand',
    // { id: 'forms', options: { draftBuffering: true } },
  ],

  output: {
    verbosity: 'terse',
    defaultLimit: 50,
  },

  daemon: {
    idleEvictionMinutes: 30,
    pathExistenceSweepSeconds: 60,
  },
});
