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
  const info = host.service.getQuickInfoAtPosition(abs, offset);
  if (info === undefined) return undefined;
  const program = host.service.getProgram();
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

  // Optional members inject ` | undefined` into their type — but `?` already implies it, so the
  // pair `id?: number | undefined` prints the undefined twice. Strip it on optional members,
  // EXCEPT under exactOptionalPropertyTypes, where an explicit `| undefined` is a DISTINCT type
  // (assignable `undefined` vs merely absent) and dropping it would be a lie (§3 / density audit).
  const stripOptUndefined = program.getCompilerOptions().exactOptionalPropertyTypes !== true;
  const members = expandMembers(
    checker,
    type,
    node,
    options.depth,
    options.memberLimit,
    new Set(),
    notes,
    stripOptUndefined,
  );
  if (members === undefined) return notes.length > 0 ? { ...base, notes } : base;
  // An object type's `members` list IS its field set — for a `type X = {…}` alias the LS quick-info
  // ALSO carries the whole body as `type`, so emitting both prints all N fields twice (the field
  // feedback that started the density audit). Drop the body, keep a one-line `about` headline (the
  // decl line, trimmed of a dangling `= {`). An interface already has a single-line `about` here, so
  // this is a no-op for it; only the alias-with-inline-body case is de-duplicated. (§3.4 / density.)
  const headline = about.replace(/\s*=?\s*\{$/, '');
  const {
    type: _body,
    about: _head,
    ...rest
  } = base as TypeView & { type?: string; about?: string };
  return { about: headline, ...rest, members, ...(notes.length > 0 ? { notes } : {}) };
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
): MemberView[] | undefined {
  const apparent = checker.getApparentType(type);
  const props = apparent.getProperties();
  if (props.length === 0) return undefined;
  const ownDecls = new Set(type.getSymbol()?.declarations ?? []);
  const shown = props.slice(0, memberLimit);
  if (props.length > shown.length) {
    notes.push(`… ${props.length - shown.length} more member(s) (raise memberLimit)`);
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
    if (isInherited(prop, ownDecls)) member.inherited = true;
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

/** A member is inherited when its declaration sits in a different declaration node than
 *  the queried type's own (§3.3: declaration's parent ≠ this type's symbol). */
function isInherited(prop: ts.Symbol, ownDecls: ReadonlySet<ts.Declaration>): boolean {
  const declParent = prop.declarations?.[0]?.parent;
  return declParent !== undefined && !ownDecls.has(declParent as ts.Declaration);
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
