// Enables react-query + react over this fixture so `trace_invalidation` is in the catalogue: the
// op walks mutation → invalidate-key → useQuery (react-query) → host component → mount sites
// (react). Self-contained: the loader only resolves the 'codemaster' specifier.
import { defineConfig } from 'codemaster';

export default defineConfig({
  ts: { tsconfig: 'tsconfig.json' },
  plugins: ['react-query', 'react'],
});
