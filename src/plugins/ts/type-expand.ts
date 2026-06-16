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
    about,
    // `type` repeats `about` for single-line named declarations — omit it then (two
    // identical lines are noise, not information; field feedback). Kept whenever the
    // resolved text adds anything beyond the first line.
    ...(full !== about ? { type: full } : {}),
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
    return { ...base, constituents: type.types.map((t) => typeStr(checker, t)) };
  }

  const members = expandMembers(
    checker,
    type,
    node,
    options.depth,
    options.memberLimit,
    new Set(),
    notes,
  );
  if (members === undefined) return notes.length > 0 ? { ...base, notes } : base;
  return { ...base, members, ...(notes.length > 0 ? { notes } : {}) };
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
    const member: MemberView = {
      name: prop.getName(),
      optional: (prop.flags & ts.SymbolFlags.Optional) !== 0,
      type: typeStr(checker, propType),
    };
    if (isInherited(prop, ownDecls)) member.inherited = true;
    if (depth > 1 && isAnonymousObject(propType) && !seen.has(propType)) {
      seen.add(propType);
      const nested = expandMembers(checker, propType, node, depth - 1, memberLimit, seen, notes);
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

/** `typeToString` with NoTruncation, then OUR own explicit cap — the checker's silent
 *  `...` would read as completeness (§3.4). */
function typeStr(checker: ts.TypeChecker, type: ts.Type): string {
  const s = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  return s.length > MEMBER_TYPE_CAP ? `${s.slice(0, MEMBER_TYPE_CAP)}… (type elided)` : s;
}
