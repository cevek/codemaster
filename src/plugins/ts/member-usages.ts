// The `member_usages` seam (§5-L2): given a TYPE T (addressed by symbolId / name / file:line:col)
// and a MEMBER name, the reference sites of THAT member — `x.timeout`, `const {timeout}=x`,
// `x['timeout']`, `x.timeout = …` — each classified read / write / destructure.
//
// IDENTITY BY CONSTRUCTION (§3.1). The member is resolved through the live checker
// (`getApparentType(T).getProperty(member)` — so an inherited / intersection member flattens in) and
// references run on THAT member symbol's declaration. So a same-named `.timeout` on an UNRELATED type
// is never matched — no separate identity gate is needed (unlike discrimination_sites), the symbol IS
// the gate. Delegates the site discovery + read/write/destructure classification to the shared
// `scanMemberRefs` core (member-refs.ts), the same primitive `find_usages` / `field-render-sites` ride.
//
// HONESTY FLOOR (§3.4): member-level references do NOT see a computed `x[expr]` access (a variable
// key the checker can't resolve to one member) nor a destructured local's DOWNSTREAM reads — the
// former is a documented v1 scope limit (the op catalogue note), the latter is flagged per-site
// (`kind:'destructure'`) and disclosed when present. Undiscovered sibling programs demote `complete`.

import ts from 'typescript';
import type { Span } from '../../core/span.ts';
import { elideString } from '../../common/truncate/elide-string.ts';
import { passesPathFilter } from '../../common/glob/path-filter.ts';
import type { TsProjectHost } from './ls-host.ts';
import { nodeAt } from './ast-node.ts';
import { typeAtNode } from './type-at-node.ts';
import { spanFromRange } from './spans.ts';
import { memberNameNode } from './first-param-members.ts';
import {
  scanMemberRefs,
  type MemberRef,
  type MemberRefsScan,
  type MemberRefEncloser,
  type MemberRefKind,
} from './member-refs.ts';

const TYPE_NAME_CAP = 120;

export type MemberUsagesOptions = {
  pathInclude?: string[] | undefined;
  pathExclude?: string[] | undefined;
  /** Display cap on the emitted site list (dispositions/total still count every matched site). */
  limit?: number | undefined;
};

/** One member-access site. All emitted sites are certain-identity (the LS resolved the exact member
 *  symbol); uncertainty (computed access) is disclosed as a note, never a fabricated site. */
export type MemberUsageSite = {
  span: Span;
  kind: MemberRefKind;
  enclosing?: MemberRefEncloser;
  /** Populated only in a multi-program repo (Task G). */
  program?: string;
};

export type MemberUsagesView = {
  /** The resolved member — its owning type, name, and declaration proof span. */
  member: { type: string; name: string; span: Span };
  sites: MemberUsageSite[];
  /** Per-disposition counts over every MATCHED site (before the display `limit`). */
  dispositions: { read: number; write: number; destructure: number };
  /** Matched sites (read+write+destructure), before the display limit; a count, never display. */
  total: number;
  /** Sites dropped by YOUR pathInclude/pathExclude — reported so a filter never reads as completeness. */
  excluded?: number;
  /** Reference set hit the §19 cap — the result is a lower bound. */
  truncated?: { shown: number; total: number };
  /** Sibling tsconfigs NOT searched (a member access living only under one would be missed). */
  undiscoveredPrograms?: string[];
  /** Situational disclosures: destructure floor present, cap, undiscovered programs. */
  notes: string[];
  /** True only when nothing knowable limits the set (no undiscovered program, no cap). */
  complete: boolean;
};

/** Resolve the member of the type at `offset`, then scan its reference sites. A `string` is an honest
 *  miss (type has no such member / no locatable declaration); `undefined` mirrors the no-type/no-symbol
 *  contract (→ the caller's `undefinedMsg`). */
export function scanMemberUsages(
  host: TsProjectHost,
  abs: string,
  offset: number,
  member: string,
  options: MemberUsagesOptions,
): MemberUsagesView | string | undefined {
  const program = host.service.getProgram();
  const sourceFile = program?.getSourceFile(abs);
  if (program === undefined || sourceFile === undefined) return undefined;
  const node = nodeAt(sourceFile, offset);
  if (node === undefined) return undefined;
  const checker = program.getTypeChecker();
  const type = typeAtNode(checker, node);
  if (type === undefined) return undefined;
  const typeName = typeNameOf(checker, type);

  const memberSym = checker.getApparentType(type).getProperty(member);
  if (memberSym === undefined) {
    return `type '${typeName}' has no member '${member}'${memberHint(checker, type)}`;
  }
  // A member on a UNION target (`A | B`) is a SYNTHESIZED property whose `getDeclarations()` carries
  // the OWN declaration of every constituent (`A.member`, `B.member` — distinct symbols). Anchoring on
  // `[0]` alone would find only one constituent's accesses and lie `complete` (§3.4). So scan EVERY
  // declaration and merge+dedup (a plain member's overload/merged decls collapse to one set — dedup is
  // a no-op there). `decl` (the proof span) is the first.
  const decls = memberSym.getDeclarations() ?? [];
  const decl = decls[0];
  if (decl === undefined) {
    return `member '${member}' of '${typeName}' has no locatable declaration to anchor references on`;
  }
  const declSf = decl.getSourceFile();
  const nameNode = memberNameNode(decl);
  const memberSpan = spanFromRange(
    declSf,
    host.relOf(declSf.fileName),
    nameNode.getStart(declSf),
    nameNode.getEnd(),
  );

  const merged = mergeScans(host, decls);
  if (merged === undefined) return undefined;
  return assemble(host, { type: typeName, name: member, span: memberSpan }, merged, options);
}

/** Scan the reference sites of EVERY declaration of a (possibly union-synthesized) member and
 *  merge+dedup by `rel:start`. `undefined` only when no declaration resolved a source at all. */
function mergeScans(
  host: TsProjectHost,
  decls: readonly ts.Declaration[],
): MemberRefsScan | undefined {
  const seen = new Set<string>();
  const refs: MemberRef[] = [];
  let total = 0;
  let capped: MemberRefsScan['truncated'] | undefined;
  let anyResolved = false;
  for (const d of decls) {
    const sf = d.getSourceFile();
    const scan = scanMemberRefs(host, sf.fileName, memberNameNode(d).getStart(sf));
    if (scan === undefined) continue;
    anyResolved = true;
    total += scan.total;
    if (scan.truncated !== undefined) {
      capped = { shown: (capped?.shown ?? 0) + scan.truncated.shown, total };
    }
    for (const ref of scan.refs) {
      const key = `${ref.rel}:${ref.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  if (!anyResolved) return undefined;
  return { refs, ...(capped !== undefined ? { truncated: capped } : {}), total };
}

function assemble(
  host: TsProjectHost,
  memberInfo: MemberUsagesView['member'],
  scan: NonNullable<ReturnType<typeof scanMemberRefs>>,
  options: MemberUsagesOptions,
): MemberUsagesView {
  let excluded = 0;
  const matched = scan.refs.filter((r) => {
    const pass = passesPathFilter(r.rel, {
      pathInclude: options.pathInclude,
      pathExclude: options.pathExclude,
    });
    if (!pass) excluded++;
    return pass;
  });
  const dispositions = { read: 0, write: 0, destructure: 0 };
  for (const r of matched) dispositions[r.kind]++;
  const sites: MemberUsageSite[] = matched.slice(0, options.limit).map((r) => ({
    span: r.span,
    kind: r.kind,
    ...(r.enclosing !== undefined ? { enclosing: r.enclosing } : {}),
    ...(r.program !== undefined ? { program: r.program } : {}),
  }));
  // Two distinct truncations: the SITE_CAP is a KNOWLEDGE cap (unseen refs exist → demotes `complete`);
  // the user `limit` is a DISPLAY cap over a fully-analyzed set (`total` is exact, `complete` stays).
  // Both must carry an explicit "N more" marker (§12) — never a silently short list.
  const displayLimited = matched.length > sites.length;

  const undiscovered = [...host.undiscoveredProgramLabels()];
  const notes: string[] = [];
  if (dispositions.destructure > 0) {
    notes.push(
      `${dispositions.destructure} destructure binding(s) — downstream reads of the bound local are not traced (member references stop at the binding).`,
    );
  }
  if (scan.truncated !== undefined) {
    notes.push(
      `reference set capped at ${scan.truncated.shown} of ${scan.truncated.total} — a lower bound; narrow with pathInclude/pathExclude.`,
    );
  } else if (displayLimited) {
    notes.push(
      `showing ${sites.length} of ${matched.length} sites — raise limit or narrow with pathInclude/pathExclude for the rest.`,
    );
  }
  if (undiscovered.length > 0) {
    notes.push(
      `!! LOWER BOUND — not searched: ${undiscovered.join(', ')} (a member access living only under one of these is not counted).`,
    );
  }
  // `truncated` (the honesty envelope) surfaces EITHER cap; `complete` reflects ONLY the knowledge cap.
  const truncated =
    scan.truncated ?? (displayLimited ? { shown: sites.length, total: matched.length } : undefined);
  const complete = undiscovered.length === 0 && scan.truncated === undefined;
  return {
    member: memberInfo,
    sites,
    dispositions,
    total: matched.length,
    ...(excluded > 0 ? { excluded } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
    ...(undiscovered.length > 0 ? { undiscoveredPrograms: undiscovered } : {}),
    notes,
    complete,
  };
}

function typeNameOf(checker: ts.TypeChecker, type: ts.Type): string {
  const name = type.getSymbol()?.getName() ?? type.aliasSymbol?.getName();
  if (name !== undefined && name !== '__type') return name;
  const s = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  // Base char-elide only (bare `…`, no recovery marker): this is a short type-NAME hint, not a full
  // type render — a `verbosity:full` recovery would be a lie (there is no full-type mode here). It is
  // DELIBERATELY excluded from `elideType` (t-487095); it routes the `slice+…` mechanism through the
  // chokepoint (`common/truncate`) to satisfy the deny-by-default guard, output byte-identical.
  return elideString(s, TYPE_NAME_CAP).text;
}

/** A short hint listing the type's apparent members when the requested one is absent (a typo aid). */
function memberHint(checker: ts.TypeChecker, type: ts.Type): string {
  const names = checker
    .getApparentType(type)
    .getProperties()
    .map((p) => p.getName());
  if (names.length === 0) return '';
  const shown = names.slice(0, 12);
  return ` (members: ${shown.join(', ')}${names.length > shown.length ? ', …' : ''})`;
}
