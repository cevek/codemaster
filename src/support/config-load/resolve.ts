// Where a `codemaster.config.*` lives (§10) — the basename precedence + on-disk
// resolution, shared by the loader (`load.ts`) and the request-entry change fingerprint
// (`fingerprint.ts`). One responsibility: resolve which config file is in effect, so the
// two callers can never disagree on precedence (a higher-precedence basename appearing
// must shift BOTH the loaded config and the drift signal in lockstep).

import { existsSync } from 'node:fs';
import * as path from 'node:path';

const CONFIG_BASENAMES = [
  'codemaster.config.ts',
  'codemaster.config.mts',
  'codemaster.config.cts',
  'codemaster.config.js',
  'codemaster.config.cjs',
  'codemaster.config.mjs',
] as const;

/** The first existing config basename at `canonRoot` in precedence order, or `undefined`
 *  when the repo runs on pure defaults (a valid state — §10). */
export function resolveConfigBasename(canonRoot: string): string | undefined {
  for (const basename of CONFIG_BASENAMES) {
    if (existsSync(path.join(canonRoot, basename))) return basename;
  }
  return undefined;
}

/** The absolute path of the in-effect config file, or `undefined` on pure defaults. */
export function findConfigFile(canonRoot: string): string | undefined {
  const basename = resolveConfigBasename(canonRoot);
  return basename === undefined ? undefined : path.join(canonRoot, basename);
}
