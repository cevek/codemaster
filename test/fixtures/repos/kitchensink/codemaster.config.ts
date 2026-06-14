// Enables ts + scss + i18n over the kitchensink fixture so `status` lists all three
// plugins and the full op catalogue (spec §5, §6 gate 2). Self-contained: the loader
// only resolves the `'codemaster'` specifier (support/config-load/load.ts).
import { defineConfig } from 'codemaster';

export default defineConfig({
  ts: { tsconfig: 'tsconfig.json' },
  scss: {},
  i18n: { locales: ['locales/en.json', 'locales/ru.json'], functions: ['t'] },
});
