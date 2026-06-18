// Enables the react-query framework plugin over this fixture so `status` lists it and the
// `invalidations_for` op is in the catalogue. Self-contained: the loader only resolves the
// 'codemaster' specifier (support/config-load/load.ts).
import { defineConfig } from 'codemaster';

export default defineConfig({
  ts: { tsconfig: 'tsconfig.json' },
  plugins: ['react-query'],
});
