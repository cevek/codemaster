import { defineConfig } from 'codemaster';

// Example project config. Drop a `codemaster.config.ts` like this at your repo
// root. Everything is optional — the daemon autodetects sensible defaults — but
// declaring your project's conventions makes the answers sharper.
export default defineConfig({
  index: {
    include: ['src/**/*.{ts,tsx,js,jsx}'],
    ignore: ['**/*.test.*', '**/*.stories.*', '**/*.gen.ts'],
    tsconfig: 'tsconfig.json',
    // packages: ['packages/app', 'packages/ui'], // monorepo
  },

  i18n: {
    locales: ['src/locales/en.json'],
    functions: ['t', 'i18n.t'],
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

  adapters: [
    'tanstack-router',
    'react-query',
    'zustand',
    // { name: 'forms', options: { draftBuffering: true } },
  ],

  output: {
    verbosity: 'terse',
    defaultLimit: 50,
  },

  daemon: {
    idleEvictionMinutes: 30,
  },
});
