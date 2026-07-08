// Target analysis for `discrimination_sites` (§5-L2): given the union TYPE T the agent named,
// compute its DISCRIMINANT properties + their literal domain, and the IDENTITY gate a switch/if
// scrutinee's object type must pass. Pure classification over the live checker — no scanning; the
// walk stays in discrimination-sites.ts.
//
// IDENTITY, not structural assignability (the crux — §3.1 never-lie). A union is assignable to a
// structural supertype (`FieldType` → `{ kind: string }`), so a structural relation would flag
// EVERY `.kind` switch in the repo as discriminating on EVERY kind-union — a false-`certain` flood.
// So the scrutinee object's type must BE T by identity (checker reference-equality OR shared
// aliasSymbol, after stripping `| undefined`), never merely assignable to/from it. Structural
// supertypes are dropped from v1 as honest, documented under-coverage.
//
// DISCRIMINANT = a property present on EVERY constituent whose type is a literal/unit in each (so a
// `value: string | number | boolean` field — primitives, not literals — is correctly NOT a
// discriminant), with ≥2 distinct literal values across constituents (a same-in-all `tag` does not
// discriminate). Its domain is the union of those literals — the "stay exhaustive" yardstick.

import ts from 'typescript';

/** A literal value in a canonical form: `key` for set membership (covers/missing diff), `display`
 *  for the rendered answer. */
export type LitVal = { key: string; display: string };

/** A discriminant property of the union T + its literal domain. */
export type Discriminant = { name: string; domain: LitVal[] };

const UNIT_FLAGS =
  ts.TypeFlags.StringLiteral |
  ts.TypeFlags.NumberLiteral |
  ts.TypeFlags.BooleanLiteral |
  ts.TypeFlags.EnumLiteral |
  ts.TypeFlags.BigIntLiteral;

/** The literal value of a unit type in canonical `{ key, display }` form, or `undefined` when the
 *  type is not a single literal/unit (a primitive, an object, a non-literal union). */
export function litOf(t: ts.Type): LitVal | undefined {
  if ((t.flags & ts.TypeFlags.StringLiteral) !== 0) {
    const v = (t as ts.StringLiteralType).value;
    return { key: `s:${v}`, display: `'${v}'` };
  }
  if ((t.flags & (ts.TypeFlags.NumberLiteral | ts.TypeFlags.EnumLiteral)) !== 0) {
    const v = (t as ts.NumberLiteralType).value;
    return { key: `n:${String(v)}`, display: String(v) };
  }
  if ((t.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
    const name = (t as ts.Type & { intrinsicName?: string }).intrinsicName ?? 'boolean';
    return { key: `b:${name}`, display: name };
  }
  if ((t.flags & ts.TypeFlags.BigIntLiteral) !== 0) {
    const v = (t as ts.BigIntLiteralType).value;
    const s = `${v.negative ? '-' : ''}${v.base10Value}n`;
    return { key: `g:${s}`, display: s };
  }
  return undefined;
}

/** Literal values of a type that is a literal OR a union of literals — `undefined` if any arm is
 *  non-literal (the property is then not a clean discriminant in that constituent). The intrinsic
 *  `boolean` is INTERNALLY the union `true | false` (`isUnion()` true), so it must be rejected FIRST
 *  or a uniform `on: boolean` field would masquerade as a `{true,false}` discriminant (a false-certain
 *  flood); a genuine literal `on: true` (a `BooleanLiteral`, not the `Boolean` intrinsic) still passes. */
function unitValues(checker: ts.TypeChecker, t: ts.Type): LitVal[] | undefined {
  if ((t.flags & ts.TypeFlags.Boolean) !== 0) return undefined; // the `boolean` primitive, not a literal
  if (t.isUnion()) {
    const out: LitVal[] = [];
    for (const arm of t.types) {
      const v = litOf(arm);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if ((t.flags & UNIT_FLAGS) !== 0) {
    const v = litOf(t);
    return v === undefined ? undefined : [v];
  }
  return undefined;
}

/** The discriminant properties of union T (empty if T is not a union, or has none). */
export function discriminantsOf(checker: ts.TypeChecker, target: ts.Type): Discriminant[] {
  if (!target.isUnion()) return [];
  const consts = target.types;
  if (consts.length === 0) return [];
  const out: Discriminant[] = [];
  for (const prop of consts[0]?.getProperties() ?? []) {
    const name = prop.getName();
    const perConst = consts.map((c) => {
      const p = c.getProperty(name);
      return p === undefined ? undefined : unitValues(checker, checker.getTypeOfSymbol(p));
    });
    if (perConst.some((v) => v === undefined)) continue; // absent or non-literal in some constituent
    const keys = new Set<string>();
    const domain: LitVal[] = [];
    for (const vals of perConst) {
      for (const v of vals ?? []) {
        if (!keys.has(v.key)) {
          keys.add(v.key);
          domain.push(v);
        }
      }
    }
    if (consts.length >= 2 && keys.size < 2) continue; // same literal in all arms — not discriminating
    out.push({ name, domain });
  }
  return out;
}

/** T itself as a bare literal-union domain (`'a' | 'b' | 'c'`), for a `switch(x)` on the value —
 *  `undefined` when T is not a union of pure literals. */
export function bareLiteralDomain(checker: ts.TypeChecker, target: ts.Type): LitVal[] | undefined {
  if (!target.isUnion()) return undefined;
  return unitValues(checker, target);
}

/** Identity gate: does `objType` denote T itself (not merely a structural super/subtype)?
 *  Reference-equality OR shared aliasSymbol, after stripping `| null | undefined`. */
export function isTargetIdentity(
  checker: ts.TypeChecker,
  objType: ts.Type,
  target: ts.Type,
): boolean {
  const nn = checker.getNonNullableType(objType);
  if (nn === target) return true;
  const a = nn.aliasSymbol;
  return a !== undefined && a === target.aliasSymbol;
}
