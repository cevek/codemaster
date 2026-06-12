// Definition resolution: a SymbolId/position → its definition site(s), proof-carrying.
// Semantic answers come from the live LS — the only oracle (§3.1). Spans are built in
// ./spans.ts from the same SourceFiles the LS answered from.

import { spanFromRange } from './spans.ts';
import { mintSymbolId } from './symbol-id.ts';
import type { SymbolView } from './query-types.ts';
import type { TsProjectHost } from './ls-host.ts';

export function findDefinitions(
  host: TsProjectHost,
  abs: string,
  offset: number,
): SymbolView[] | undefined {
  const defs = host.service.getDefinitionAtPosition(abs, offset);
  if (defs === undefined) return undefined;
  const views: SymbolView[] = [];
  for (const def of defs) {
    const sourceFile = host.service.getProgram()?.getSourceFile(def.fileName);
    if (sourceFile === undefined) continue;
    const rel = host.relOf(def.fileName);
    const span = spanFromRange(
      sourceFile,
      rel,
      def.textSpan.start,
      def.textSpan.start + def.textSpan.length,
    );
    views.push({
      id: mintSymbolId(def.name, rel, span.line, span.col),
      name: def.name,
      kind: def.kind,
      span,
      ...(def.containerName !== undefined && def.containerName !== ''
        ? { container: def.containerName }
        : {}),
    });
  }
  return views;
}
