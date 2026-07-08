// Type expansion (§3.3): the LS quick-info (`about`/`type`/`doc`) PLUS a structural view
// — object members, or union/intersection constituents — so `expand_type` on an interface
// returns its fields, not just `interface X`. Semantic answers come from the live LS's
// checker — the only oracle (§3.1). All `typeToString` runs with NoTruncation and our own
// explicit per-string cap; a silent `…` from the checker would be a §3.4 lie.

import ts from 'typescript';
import { spanFromRange } from './spans.ts';
import { nodeAt } from './ast-node.ts';
import { typeAtNode } from './type-at-node.ts';
import type { ExpandOptions, MemberView, TypeView } from './query-types.ts';
import type { TsProjectHost } from './ls-host.ts';

const MEMBER_TYPE_CAP = 200;

export function expandTypeAt(
  host: TsProjectHost,
  abs: string,
  offset: number,
  options: ExpandOptions = { depth: 1, memberLimit: 40 },
): TypeView | undefined {
  // Route the quick-info AND the checker to the type-authority program for `abs`: in a no-root repo
  // `host.service` is the fallback primary, whose whole-repo glob pollutes a member src symbol's type
  // with augmentation strays (t-593802). typeAuthorityFor returns the member's own-options program.
  const authority = host.typeAuthorityFor(abs);
  const info = authority.service.getQuickInfoAtPosition(abs, offset);
  if (info === undefined) return undefined;
  const program = authority.getProgram();
  const sourceFile = program?.getSourceFile(abs);
  const rel = host.relOf(abs);
  const doc = (info.documentation ?? [])
    .map((d) => d.text)
    .join('\n')
    .trim();
  const full = (info.displayParts ?? []).map((p) => p.text).join('');
  const about = full.split('\n')[0] ?? '';
  const base: TypeView = {
    // EITHER `about` (a single-line decl — the quick-info IS the whole type) OR the full multi-line
    // `type`. They are mutually exclusive: `about` is `type`'s first line verbatim, so emitting both
    // prints the same line twice (the head) — noise. The structural `constituents`/`members` below
    // carry the breakdown, never repeating the head. (field feedback; output-density audit.)
    ...(full !== about ? { type: full } : { about }),
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

  // Structural expansion needs the checker + the node at the offset. Without them, the
  // quick-info view is still a complete (if shallow) honest answer.
  if (program === undefined || sourceFile === undefined) return base;
  const node = nodeAt(sourceFile, offset);
  if (node === undefined) return base;
  const checker = program.getTypeChecker();
  const type = typeAtNode(checker, node);
  if (type === undefined) return base;

  const notes: string[] = [];

  // Enum BEFORE union: a non-const enum's declared type IS a union of its member literals,
  // so a union-first path would render arms instead of the named members (§3.3).
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Enum) !== 0) {
    return { ...base, members: enumMembers(checker, symbol, node) };
  }

  // Dispatch union / intersection BEFORE object-like: a union of objects HAS apparent
  // properties, so a getProperties-first path would merge them instead of listing arms.
  if (type.isUnion() || type.isIntersection()) {
    const constituents = type.types.map((t) => typeStr(checker, t));
    // `about`/`type` (mutually exclusive) already carries the head; for a small union it shows
    // every arm VERBATIM, so `constituents` would repeat them (`ShapeTag`: 33 arms twice). Drop
    // it ONLY when the head is complete (not TS-truncated) AND literally contains each arm — a
    // big/elided union keeps `constituents` (the NoTruncation, load-bearing list). (§3.4 / density.)
    const head = base.type ?? base.about ?? '';
    const truncated = head.includes('...') || head.includes('…');
    const covered = constituents.every((c) => head.includes(c));
    return !truncated && covered ? base : { ...base, constituents };
  }

  // Callable type (function / overloaded function / fn+namespace merge): list EVERY call signature.
  // Quick-info shows only the first + `(+N overload)`, dropping the rest, and the object-member
  // headline path (below) truncates a multi-line return type after the colon — both lose real type
  // facts (§3.4). `getSignaturesOfType(…, Call)` returns the OVERLOAD signatures (not the impl), so
  // a 2-overload set yields 2, matching the `(+1 overload)` count.
  const callSigs = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const signatures =
    callSigs.length > 0 ? callSigs.map((s) => signatureStr(checker, s)) : undefined;

  // Optional members inject ` | undefined` into their type — but `?` already implies it, so the
  // pair `id?: number | undefined` prints the undefined twice. Strip it on optional members,
  // EXCEPT under exactOptionalPropertyTypes, where an explicit `| undefined` is a DISTINCT type
  // (assignable `undefined` vs merely absent) and dropping it would be a lie (§3 / density audit).
  const stripOptUndefined = program.getCompilerOptions().exactOptionalPropertyTypes !== true;
  // Top-level overflow is captured structurally (→ `Result.truncated`), not as a soft note; the
  // recursion still soft-notes NESTED (depth>1) caps (see `top` param on expandMembers).
  const overflow: { members?: { shown: number; total: number } } = {};
  const members = expandMembers(
    checker,
    type,
    node,
    options.depth,
    options.memberLimit,
    new Set(),
    notes,
    stripOptUndefined,
    overflow,
    true,
  );
  if (members === undefined) {
    // A pure function / overload set has no object members — quick-info describes one signature;
    // `signatures` adds the rest. Keep `about`/`type` (the first signature + count, still honest).
    const withSigs = signatures !== undefined ? { ...base, signatures } : base;
    return notes.length > 0 ? { ...withSigs, notes } : withSigs;
  }
  // An object type's `members` list IS its field set — for a `type X = {…}` alias the LS quick-info
  // ALSO carries the whole body as `type`, so emitting both prints all N fields twice (the field
  // feedback that started the density audit). Drop the body, keep a one-line `about` headline. For a
  // type alias that is the decl line trimmed of a dangling `= {`; for a fn+namespace MERGE (callable
  // AND has members) the first line is the function head with a dangling return-type `{` — the alias
  // trim would chop it off after the colon, so cut at the first `(` to a clean `function box` head
  // and let `signatures` carry the call shape verbatim. An interface already has a single-line
  // `about` here, so this is a no-op for it. (§3.4 / density.)
  const headline =
    signatures !== undefined ? headOfCallable(about) : about.replace(/\s*=?\s*\{$/, '');
  const {
    type: _body,
    about: _head,
    ...rest
  } = base as TypeView & { type?: string; about?: string };
  return {
    about: headline,
    ...rest,
    ...(signatures !== undefined ? { signatures } : {}),
    members,
    ...(notes.length > 0 ? { notes } : {}),
    ...(overflow.members !== undefined ? { membersTruncated: overflow.members } : {}),
  };
}

/** A callable's headline: the quick-info first line cut at the first `(` (`function box(label:
 *  string): {` → `function box`) — the params/return live in `signatures`, NoTruncation, so the
 *  head never carries a dangling/truncated return type. A first line with no `(` is kept whole. */
function headOfCallable(about: string): string {
  const paren = about.indexOf('(');
  return (paren > 0 ? about.slice(0, paren) : about).trim();
}

/** `signatureToString` with NoTruncation, then OUR explicit cap (the checker's silent `...` would
 *  read as completeness, §3.4) — the per-signature analogue of `typeStr`. */
function signatureStr(checker: ts.TypeChecker, sig: ts.Signature): string {
  const s = checker.signatureToString(sig, undefined, ts.TypeFormatFlags.NoTruncation);
  return s.length > MEMBER_TYPE_CAP ? `${s.slice(0, MEMBER_TYPE_CAP)}… (signature elided)` : s;
}

/** Object-like members of `type`, or `undefined` when it has none to show (a function /
 *  primitive — quick-info already describes it). Recurses into anonymous object-literal
 *  members while `depth > 1`, guarding cycles with a seen-set of types. */
function expandMembers(
  checker: ts.TypeChecker,
  type: ts.Type,
  node: ts.Node,
  depth: number,
  memberLimit: number,
  seen: Set<ts.Type>,
  notes: string[],
  stripOptUndefined: boolean,
  overflow: { members?: { shown: number; total: number } },
  top: boolean,
): MemberView[] | undefined {
  const apparent = checker.getApparentType(type);
  const props = apparent.getProperties();
  if (props.length === 0) return undefined;
  const ownDecls = new Set(type.getSymbol()?.declarations ?? []);
  // `inherited` is meaningful ONLY when the type actually pulls foreign members in via a heritage
  // clause (class `extends`/`implements`, interface `extends`) — that is the sole way a member's
  // decl lands OUTSIDE the type's own decl nodes. A type WITHOUT heritage cannot inherit: a
  // mapped/utility result (`Pick`/`Omit`/`Partial`/`Required` — own decl is the lib `MappedType`
  // node, members synthesized from the source interface) or an intersection (`A & B` — no declaring
  // symbol) would otherwise flag EVERY member inherited, since the synthesized member decls sit in
  // the source type, not the mapped/intersection node — a claim we cannot prove (§3). So gate the
  // flag on heritage; without it every member is own (base-class + namespace-merge stay correct —
  // the former HAS heritage, the latter's members are lexically contained regardless).
  const canFlagInherited = hasHeritageClause(ownDecls);
  const shown = props.slice(0, memberLimit);
  if (props.length > shown.length) {
    // Top-level cap → structured (the op lifts it onto `Result.truncated`); nested cap → soft note
    // (§3.4: a single `Truncation` can't carry multiple nested overflows — a deliberate gap).
    if (top) overflow.members = { shown: shown.length, total: props.length };
    else notes.push(`… ${props.length - shown.length} more nested member(s) (raise memberLimit)`);
  }
  return shown.map((prop) => {
    const propType = checker.getTypeOfSymbolAtLocation(prop, node);
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    const member: MemberView = {
      name: prop.getName(),
      optional,
      // `?` already implies undefined — strip the redundant arm (non-EOPT only; see caller).
      type: stripOptionalUndefined(typeStr(checker, propType), optional && stripOptUndefined),
    };
    if (canFlagInherited && isInherited(prop, ownDecls)) member.inherited = true;
    if (depth > 1 && isAnonymousObject(propType) && !seen.has(propType)) {
      seen.add(propType);
      const nested = expandMembers(
        checker,
        propType,
        node,
        depth - 1,
        memberLimit,
        seen,
        notes,
        stripOptUndefined,
        overflow,
        false,
      );
      if (nested !== undefined) member.members = nested;
    } else if (depth === 1 && isAnonymousObject(propType)) {
      notes.push(`${member.name}: nested object — expand with depth:2`);
    }
    return member;
  });
}

/** Enum members, in declaration order: each member's literal type (e.g. `Color.Red`).
 *  Not `optional` — an enum member always exists. */
function enumMembers(checker: ts.TypeChecker, enumSymbol: ts.Symbol, node: ts.Node): MemberView[] {
  const out: MemberView[] = [];
  enumSymbol.exports?.forEach((member) => {
    out.push({
      name: member.getName(),
      optional: false,
      type: typeStr(checker, checker.getTypeOfSymbolAtLocation(member, node)),
    });
  });
  return out;
}

/** True when any of the type's own declarations is a class/interface carrying a heritage clause
 *  (`extends` / `implements`) — the only shape that can bring a member in from OUTSIDE the type's
 *  own decl nodes, so the only shape for which the `inherited` containment test is meaningful. A
 *  mapped/utility/intersection type has none, so its synthesized members are all own (§3). */
function hasHeritageClause(ownDecls: ReadonlySet<ts.Declaration>): boolean {
  for (const d of ownDecls) {
    if ((ts.isClassLike(d) || ts.isInterfaceDeclaration(d)) && d.heritageClauses !== undefined) {
      return true;
    }
  }
  return false;
}

/** A member is inherited when NONE of its declarations sit lexically inside one of the queried
 *  type's own declaration nodes (§3.3). We walk each member decl's parent chain and test
 *  containment in `ownDecls` rather than comparing only the immediate parent: a fn/namespace-merge
 *  export lives several nodes deep inside the merged `ModuleDeclaration` (which IS an own decl of
 *  the merged symbol) — so it is OWN, not inherited; the immediate-parent check flagged it wrongly.
 *  A base-class member's declaration sits inside the BASE `ClassDeclaration` (never an own decl) →
 *  still correctly inherited. The walk is bounded — it terminates at the SourceFile root. */
function isInherited(prop: ts.Symbol, ownDecls: ReadonlySet<ts.Declaration>): boolean {
  const decls = prop.declarations;
  if (decls === undefined || decls.length === 0) return false;
  return !decls.some((d) => isContainedIn(d, ownDecls));
}

/** True when `node` or any of its ancestors is one of `ownDecls`. */
function isContainedIn(node: ts.Node, ownDecls: ReadonlySet<ts.Declaration>): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (ownDecls.has(cur as ts.Declaration)) return true;
  }
  return false;
}

function isAnonymousObject(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  return (
    symbol !== undefined &&
    (symbol.flags & ts.SymbolFlags.TypeLiteral) !== 0 &&
    type.getProperties().length > 0
  );
}

/** Drop the trailing ` | undefined` an optional member injects (the checker always appends it
 *  last). Only when `enabled` (optional member, non-EOPT — see caller). A no-op when the type
 *  was capped (`… (type elided)`) since the suffix is already gone. */
function stripOptionalUndefined(type: string, enabled: boolean): string {
  const suffix = ' | undefined';
  return enabled && type.endsWith(suffix) ? type.slice(0, -suffix.length) : type;
}

/** `typeToString` with NoTruncation, then OUR own explicit cap — the checker's silent
 *  `...` would read as completeness (§3.4). */
function typeStr(checker: ts.TypeChecker, type: ts.Type): string {
  const s = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  return s.length > MEMBER_TYPE_CAP ? `${s.slice(0, MEMBER_TYPE_CAP)}… (type elided)` : s;
}
