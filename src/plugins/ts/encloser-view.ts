// The rendered encloser card a whole-program scan op reports beside each site — the nearest named
// declaration holding the site + a chainable SymbolId (→ find_usages / source / rename). Shared by
// `construction_sites` and `discrimination_sites` so the two assemble the view identically; the
// authoritative id mint stays `mintEncloserId`/`mintSymbolId` (one oracle), this is view assembly.

import type { RepoRelPath } from '../../core/brands.ts';
import type ts from 'typescript';
import { mintSymbolId, moduleName } from './symbol-id.ts';
import { mintEncloserId } from './encloser-id.ts';
import type { ConstructionEncloser } from './construction-encloser.ts';
import type { TsProjectHost } from './ls-host.ts';

export type EncloserView = {
  /** Chainable ts: SymbolId of the enclosing declaration (→ find_usages / source / rename). */
  id: string;
  name: string;
  kind: string;
  file: RepoRelPath;
  line: number;
  col: number;
  exported: boolean;
};

/** Build the view for a resolved enclosing declaration — mint on the BARE token (`enc.idName`) so
 *  the handle chains (a class member's display name is `Class.member`, but the id anchors on the
 *  `member` token at line:col, §6 rebind). */
export function encloserView(
  host: TsProjectHost,
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  enc: ConstructionEncloser,
): EncloserView {
  const { id, line, col } = mintEncloserId(
    sourceFile,
    rel,
    enc.idName,
    enc.nameStart,
    host.rootTag,
  );
  return { id, name: enc.name, kind: enc.kind, file: rel, line, col, exported: enc.exported };
}

/** A site at module top level (no enclosing named declaration) rolls up to the file. */
export function moduleEncloser(host: TsProjectHost, rel: RepoRelPath): EncloserView {
  const name = moduleName(rel);
  return {
    id: mintSymbolId(name, rel, 1, 1, host.rootTag),
    name,
    kind: 'module',
    file: rel,
    line: 1,
    col: 1,
    exported: false,
  };
}
