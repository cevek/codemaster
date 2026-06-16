// Emit a new module specifier from an importer's CURRENT directory to a target node's
// CURRENT path, preserving the original alias-vs-relative form and extension policy. This is
// the EMIT side — the inverse of resolution, which `ts.resolveModuleName` can't give us — so
// it consumes the shared alias map (`alias-paths.ts`, derived from `compilerOptions.paths`/
// `baseUrl`). That is emit-only and not a second forward resolver. An alias we can't re-form
// falls back to a relative specifier (a noisier diff, never wrong). Key insight (§2.2): an
// alias specifier is independent of the importer's location — it changes only when the TARGET moves.

import * as path from 'node:path';
import type { FsNode } from '../tree/node.ts';
import type { AliasPrefix } from '../../alias-paths.ts';

function posixRelative(fromDir: string, toPath: string): string {
  const rel = path.posix.relative(fromDir === '' ? '.' : fromDir, toPath);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** The strippable module extension of a filename — `.d.ts`/`.d.mts`/`.d.cts` as ONE unit (so
 *  a strip doesn't leave a broken `foo.d`), else `path.extname`. */
function moduleExtOf(name: string): string {
  const dts = /\.d\.[mc]?ts$/.exec(name);
  return dts !== null ? dts[0] : path.extname(name);
}

export function emitSpecifier(
  originalSpec: string,
  importerCurrentDir: string,
  targetNode: FsNode,
  aliasPrefixes: readonly AliasPrefix[],
): string {
  const targetCurrent = String(targetNode.currentPath());
  const wasAlias = !originalSpec.startsWith('.');
  // The strip decision uses the target's CURRENT extension, not its initial one: extract can
  // coerce `.ts`→`.tsx` (JSX body), so a node whose initialName is `Foo.ts` now lives at
  // `Foo.tsx`. Deriving the ext from initialName would make the `endsWith` strip below fail and
  // emit a spurious `./Foo.tsx` where the importer omitted the extension.
  const targetExt = moduleExtOf(path.posix.basename(targetCurrent));
  const includedExt = /\.(tsx?|jsx?|module\.scss|module\.css|scss|css)$/.test(originalSpec);
  // Symmetric with the importer filter (rewrite.ts): .mts/.cts/.mjs/.cjs are TS/JS modules too;
  // `.d.ts` is stripped as one unit by moduleExtOf (else a naive `.ts` strip leaves `foo.d`).
  const isTsModule = /^(\.d\.[mc]?ts|\.(tsx?|jsx?|mts|cts|mjs|cjs))$/.test(targetExt);

  let target = targetCurrent;
  // Strip the extension when the original omitted it and the target is a TS/JS module
  // (bundler resolution lets you drop `.tsx`/`.ts`, but never `.json`/`.scss`).
  if (!includedExt && isTsModule && target.endsWith(targetExt)) {
    target = target.slice(0, -targetExt.length);
  }

  if (wasAlias) {
    for (const { wildcard, aliasPrefix, relPrefix } of aliasPrefixes) {
      if (wildcard) {
        if (target === relPrefix.slice(0, -1) || target.startsWith(relPrefix)) {
          return aliasPrefix + target.slice(relPrefix.length);
        }
      } else if (target === relPrefix) {
        return aliasPrefix; // exact non-wildcard mapping — never a prefix over-match
      }
    }
    // Alias couldn't be re-formed for this target → fall back to a relative specifier.
  }
  return posixRelative(importerCurrentDir, target);
}
