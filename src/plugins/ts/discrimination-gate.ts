// The IDENTITY + discriminant gate for `discrimination_sites` (§5-L2): a syntactic `RawSite` →
// a proof-carrying `DiscriminationSite`, or `undefined` when the scrutinee does not discriminate on
// the target union T. Split from discrimination-sites.ts (300-line cap). The precision lives here:
// the scrutinee object's type must BE T (identity, not structural — discrimination-target.ts), and
// the accessed property must be a DISCRIMINANT of T, so a non-discriminant `f.value` is excluded.

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence } from '../../core/span.ts';
import { spanFromRange } from './spans.ts';
import { enclosingConstruction } from './construction-encloser.ts';
import { encloserView, moduleEncloser, type EncloserView } from './encloser-view.ts';
import { isTargetIdentity, litOf, type LitVal } from './discrimination-target.ts';
import type { RawSite } from './discrimination-analyze.ts';
import type { DiscriminationSite } from './discrimination-sites.ts';
import type { TsProjectHost } from './ls-host.ts';

export function gate(
  host: TsProjectHost,
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  rel: RepoRelPath,
  targetType: ts.Type,
  raw: RawSite,
  discByName: Map<string, LitVal[]>,
  bareDomain: LitVal[] | undefined,
): DiscriminationSite | undefined {
  const resolved = resolveDomain(checker, targetType, raw, discByName, bareDomain);
  if (resolved === undefined) return undefined;

  const coverKeys = new Set<string>();
  const coverDisplay: string[] = [];
  let unreadable = raw.unreadableCase;
  for (const expr of raw.caseExprs) {
    const lit = litOf(checker.getTypeAtLocation(expr));
    if (lit === undefined) {
      unreadable = true;
      continue;
    }
    if (!coverKeys.has(lit.key)) {
      coverKeys.add(lit.key);
      coverDisplay.push(lit.display);
    }
  }
  const missing = resolved.domain.filter((d) => !coverKeys.has(d.key)).map((d) => d.display);
  const confidence: Confidence = raw.kind === 'switch' && !unreadable ? 'certain' : 'partial';
  const note = noteFor(raw, unreadable);
  const start = raw.keyword.getStart(sf);

  return {
    kind: raw.kind,
    span: spanFromRange(sf, rel, start, start + keywordLen(raw)),
    scrutinee: raw.scrutineeText,
    discriminant: resolved.label,
    confidence,
    ...(note !== undefined ? { note } : {}),
    covers: coverDisplay,
    missing,
    hasDefault: raw.hasDefault,
    encloser: encloserOf(host, sf, rel, raw.keyword),
  };
}

/** Resolve the discriminant label + domain a RawSite discriminates on, applying the IDENTITY gate;
 *  `undefined` when the scrutinee object is not T, or the accessed property is not a discriminant. */
function resolveDomain(
  checker: ts.TypeChecker,
  targetType: ts.Type,
  raw: RawSite,
  discByName: Map<string, LitVal[]>,
  bareDomain: LitVal[] | undefined,
): { label: string; domain: LitVal[] } | undefined {
  if (raw.scrutineeObj !== undefined && raw.discriminant !== undefined) {
    const objType = checker.getTypeAtLocation(raw.scrutineeObj);
    if (!isTargetIdentity(checker, objType, targetType)) return undefined;
    const domain = discByName.get(raw.discriminant);
    if (domain === undefined) return undefined; // accessed property is not a discriminant of T
    return { label: raw.discriminant, domain };
  }
  if (raw.bareScrutinee !== undefined && bareDomain !== undefined) {
    const exprType = checker.getTypeAtLocation(raw.bareScrutinee);
    if (!isTargetIdentity(checker, exprType, targetType)) return undefined;
    return { label: '(value)', domain: bareDomain };
  }
  return undefined;
}

function noteFor(raw: RawSite, unreadable: boolean): string | undefined {
  if (raw.kind === 'if-chain') {
    return unreadable
      ? 'if-chain (=== heuristic): a !==/in/type-guard/compound branch is not counted, so covers may under-report — verify the missing set'
      : 'if-chain (=== heuristic): only `scrutinee === literal` branches are counted';
  }
  if (unreadable)
    return 'a case value could not be read as a literal (computed) — covers may under-report';
  return undefined;
}

/** The keyword span length — `switch` / `if`. */
function keywordLen(raw: RawSite): number {
  return raw.kind === 'switch' ? 'switch'.length : 'if'.length;
}

function encloserOf(
  host: TsProjectHost,
  sf: ts.SourceFile,
  rel: RepoRelPath,
  from: ts.Node,
): EncloserView {
  const enc = enclosingConstruction(from);
  return enc !== undefined ? encloserView(host, sf, rel, enc) : moduleEncloser(host, rel);
}
