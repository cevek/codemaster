// codemaster's own package version — the one source of the version literal (`package.json`). Read
// once per process from the package root this module sits under (src/support/build-id/ → ../../..).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

let cached: string | undefined;

/** `package.json` `version`; `'unknown'` when the file cannot be read or carries none. */
export function packageVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const parsed = JSON.parse(readFileSync(`${PACKAGE_ROOT}package.json`, 'utf8')) as unknown;
    const v =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    cached = typeof v === 'string' && v.length > 0 ? v : 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
