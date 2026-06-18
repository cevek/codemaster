// `find_usages mergeDeclarations` (DX feedback): in this repo nearly every plugin-API method is a
// TsPluginApi interface-decl + a TsProjectHost-decl + an impl, so `find_usages {name}` almost always
// fails on the 3-way ambiguity. This unions the reference sets of ALL same-named declarations into
// one answer — but keeps PER-SITE provenance (`UsageView.decls`): a site found via two unrelated
// same-named symbols is honestly attributed to both, never silently presented as one set (§3.3).
// Semantic answers still come only from the live LS — this just unions across declarations.

import type { SymbolView, UsageOptions, UsagesView } from './query-types.ts';
import type { TsProjectHost } from './ls-host.ts';
import type { ResolvedDeclaration } from './resolve-target.ts';
import { findReferencesAcross } from './cross-program.ts';
import { assembleView, type SourceRef } from './usages.ts';

/** Union the usages of every resolved declaration, deduped by file+offset with per-site decl
 *  attribution, then run the shared `assembleView` pipeline. `mergedDeclarations` is the legend the
 *  per-site `decls` indices point into. `undefined` when NO declaration resolves any references. */
export function findUsagesMerged(
  host: TsProjectHost,
  decls: readonly ResolvedDeclaration[],
  options: UsageOptions,
): UsagesView | undefined {
  const mergedDeclarations: SymbolView[] = decls.map((d) => d.view);
  const sourceRefs: SourceRef[] = [];
  const byKey = new Map<string, SourceRef>(); // `rel|start` — a site two decls both reach merges
  let anyRefs = false;

  decls.forEach((d, index) => {
    const cross = findReferencesAcross(host, d.abs, d.offset);
    if (cross === undefined) return;
    anyRefs = true;
    for (const ref of cross.refs) {
      const key = `${ref.rel}|${ref.start}`;
      const existing = byKey.get(key);
      if (existing !== undefined) {
        // Same site reached via another declaration — record the extra provenance, don't double-list.
        if (existing.declIndices !== undefined && !existing.declIndices.includes(index)) {
          existing.declIndices.push(index);
        }
        continue;
      }
      const sourceRef: SourceRef = {
        rel: ref.rel,
        sourceFile: ref.sourceFile,
        start: ref.start,
        length: ref.length,
        isDefinition: ref.isDefinition,
        isWriteAccess: ref.isWriteAccess,
        program: ref.program,
        declIndices: [index],
      };
      byKey.set(key, sourceRef);
      sourceRefs.push(sourceRef);
    }
  });

  if (!anyRefs) return undefined;
  return assembleView(host, sourceRefs, options, { mergedDeclarations });
}
