// Type expansion: the LS's resolved type + docs at a position (quick-info depth). Spans
// are built in ./spans.ts from the same SourceFiles the LS answered from. Semantic
// answers come from the live LS — the only oracle (§3.1).

import { spanFromRange } from './spans.ts';
import type { TypeView } from './query-types.ts';
import type { TsProjectHost } from './ls-host.ts';

export function expandTypeAt(
  host: TsProjectHost,
  abs: string,
  offset: number,
): TypeView | undefined {
  const info = host.service.getQuickInfoAtPosition(abs, offset);
  if (info === undefined) return undefined;
  const sourceFile = host.service.getProgram()?.getSourceFile(abs);
  const rel = host.relOf(abs);
  const doc = (info.documentation ?? [])
    .map((d) => d.text)
    .join('\n')
    .trim();
  return {
    about:
      (info.displayParts ?? [])
        .map((p) => p.text)
        .join('')
        .split('\n')[0] ?? '',
    type: (info.displayParts ?? []).map((p) => p.text).join(''),
    ...(doc.length > 0 ? { doc } : {}),
    ...(sourceFile !== undefined
      ? {
          span: spanFromRange(
            sourceFile,
            rel,
            info.textSpan.start,
            info.textSpan.start + info.textSpan.length,
          ),
        }
      : {}),
  };
}
