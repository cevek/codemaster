// Read the resolved TYPE of a top-level symbol under a trial OVERLAY vs its BASELINE — the primitive
// behind `impact_type_error`'s clean widen-to-`any` masking guard (Case B). A trial edit can collapse
// the edited symbol's OWN inferred type to `any` with NO intra-file error (an explicit `: any`, or an
// inference that goes to `any`). `any` is assignable everywhere, so it produces FEWER downstream
// errors — the diff-of-diagnostics ("introduced errors vs baseline") fundamentally CANNOT see the
// masked break. Only the overlay TYPE reveals it, and `gateAcross` (diagnostics only) never exposes
// it. This reads that type.
//
// SOUNDNESS (the trap): the baseline (no overlay) and overlay types come from two DIFFERENT program
// versions → two DIFFERENT `TypeChecker`s → `isTypeAssignableTo` across them is INVALID (a checker can
// only relate types it minted). So the collapse is detected by testing `TypeFlags.Any`/`Unknown` on
// each type INDEPENDENTLY (a per-state bit, never a cross-checker relation). The any/unknown-ness is a
// pure type FACT (§5-L2); the OP decides whether a collapse means the downstream blast is
// untrustworthy (§5-L3).
//
// CONSERVATIVE (§3): `undefined` whenever the symbol can't be resolved to a SINGLE top-level
// declaration in a state (removed / renamed / ambiguous) — the op then makes NO widen claim. A false
// NEGATIVE is the status quo (no regression); a false POSITIVE would be a new lie. Wrapped so a probe
// hiccup returns `undefined` (no claim) rather than sinking the blast-radius answer, and the overlay
// is ALWAYS cleared (try/finally) so it never leaks into a later read (§2.4).

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { TsProjectHost } from './ls-host.ts';
import { typeAtNode } from './type-at-node.ts';

/** A whole-type collapse to a precision-erasing top type — the masking-relevant FACT (§3). */
export type TypeCollapse = 'any' | 'unknown';

export interface SymbolTypeState {
  text: string;
  /** Present only when the type IS `any`/`unknown` (the collapse); absent for a precise type. */
  collapse?: TypeCollapse;
}

export interface OverlaySymbolType {
  baseline: SymbolTypeState;
  overlay: SymbolTypeState;
}

const TYPE_CAP = 200; // mirror type-widening.ts: a silent checker `…` would read as completeness (§3.4)

/** The resolved type of the top-level symbol `name` in `declFile`, BEFORE and under `overlay` — read
 *  IDENTICALLY on both sides (same node, same checker idiom) so a diff is the edit's effect, not a
 *  methodology skew. `undefined` when the symbol can't be resolved unambiguously in either state. */
export function overlaySymbolType(
  host: TsProjectHost,
  declFile: RepoRelPath,
  name: string,
  overlay: readonly { path: RepoRelPath; content: string }[],
): OverlaySymbolType | undefined {
  try {
    const abs = host.absOf(declFile);
    const baseline = readTopLevelType(host, abs, name);
    if (baseline === undefined) return undefined;
    const over = withOverlay(host, overlay, () => readTopLevelType(host, abs, name));
    if (over === undefined) return undefined;
    return { baseline, overlay: over };
  } catch {
    // A probe hiccup must never sink the (good) blast-radius answer — make no widen claim (§3.6).
    return undefined;
  }
}

/** Set the primary-program overlay, run `fn`, ALWAYS clear it (the overlay must never leak, §2.4) —
 *  `setOverlay` INSIDE the try so a throw there still hits `clearOverlay` (the `typecheckOverlay`
 *  house pattern). */
function withOverlay<T>(
  host: TsProjectHost,
  overlay: readonly { path: RepoRelPath; content: string }[],
  fn: () => T,
): T {
  try {
    host.setOverlay(overlay.map((f) => ({ abs: host.absOf(f.path), content: f.content })));
    return fn();
  } finally {
    host.clearOverlay();
  }
}

/** The type of the SINGLE top-level declaration named `name` in the file at `abs`, via the shared
 *  `typeAtNode` "what type does this node stand for" oracle (declared type for a type/interface/class/
 *  enum name, value type otherwise). `undefined` when the name matches zero or several top-level
 *  declarations (ambiguous → conservative, never a guessed type).
 *
 *  PRIMARY program ONLY (`host.service`): the trial overlay lives on the primary (`host.setOverlay`),
 *  so a type read must come from the primary to reflect it — reading a SIBLING program (which never
 *  saw the overlay) would return the stale-disk type and read the edit as a no-op. So a declFile NOT
 *  in the primary program (a sibling/test-only decl) → `undefined` here → the op makes no widen claim.
 *  This is a KNOWN gap, but not reachable today: `impact_type_error` resolves its target via
 *  `findDefinition`, which currently FAILS to resolve a sibling-only declaration before the probe is
 *  ever reached — tracked in the backlog (fan the overlay to the owning program, or disclose, WHEN
 *  sibling-decl resolution lands). */
function readTopLevelType(
  host: TsProjectHost,
  abs: string,
  name: string,
): SymbolTypeState | undefined {
  const program = host.service.getProgram();
  const sf = program?.getSourceFile(abs);
  if (program === undefined || sf === undefined) return undefined;
  const nameNode = uniqueTopLevelName(sf, name);
  if (nameNode === undefined) return undefined;
  const checker = program.getTypeChecker();
  const type = typeAtNode(checker, nameNode);
  if (type === undefined) return undefined;
  const collapse = collapseOf(checker, type);
  return { text: typeStr(checker, type), ...(collapse !== undefined ? { collapse } : {}) };
}

/** The lone top-level declaration-name node matching `name`, or `undefined` when zero/several match.
 *  Covers the declaration kinds an edited symbol takes: var/const/let, function, class, interface,
 *  type alias, enum. */
function uniqueTopLevelName(sf: ts.SourceFile, name: string): ts.Identifier | undefined {
  const matches: ts.Identifier[] = [];
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) matches.push(d.name);
      }
    } else if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt)) &&
      stmt.name !== undefined &&
      ts.isIdentifier(stmt.name) &&
      stmt.name.text === name
    ) {
      matches.push(stmt.name);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** `any`/`unknown` per the type's OWN flags, else — for a CALLABLE (function / method / arrow) — the
 *  collapse of its RETURN type. A function's masking vector is its return collapsing to `any` (consumers
 *  see the return: `fn().x` becomes `any` and is silenced), NOT the whole `() => any` value, which never
 *  carries the `Any` flag — so a flag-only check would miss every function-return widen (the claimed
 *  `function` scope). Flags are read INDEPENDENTLY on each state (never a cross-checker assignability
 *  relation, which is invalid between two program versions). A deeper collapse in a MEMBER position (a
 *  `const` whose type is `{ cb: any }`, an index signature) is NOT detected here — a tracked backlog
 *  residual. */
function collapseOf(checker: ts.TypeChecker, type: ts.Type): TypeCollapse | undefined {
  const whole = flagCollapse(type);
  if (whole !== undefined) return whole;
  const sigs = type.getCallSignatures();
  if (sigs.length === 0) return undefined;
  // A callable collapses only when EVERY call signature's return does — a mixed overload is not a
  // clean whole-return collapse, so we never fabricate a widen from a partial one (§3, conservative).
  const returns = sigs.map((s) => flagCollapse(checker.getReturnTypeOfSignature(s)));
  if (returns.every((r) => r === 'any')) return 'any';
  if (returns.every((r) => r === 'unknown')) return 'unknown';
  return undefined;
}

/** The type's OWN `any`/`unknown` flag — a per-state bit, never a cross-checker relation. */
function flagCollapse(type: ts.Type): TypeCollapse | undefined {
  if ((type.flags & ts.TypeFlags.Any) !== 0) return 'any';
  if ((type.flags & ts.TypeFlags.Unknown) !== 0) return 'unknown';
  return undefined;
}

/** `typeToString` with NoTruncation then OUR explicit cap (a silent checker `…` reads as
 *  completeness, §3.4) — the `type-widening` idiom, local to keep this primitive self-contained. */
function typeStr(checker: ts.TypeChecker, type: ts.Type): string {
  const s = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  return s.length > TYPE_CAP ? `${s.slice(0, TYPE_CAP)}… (type elided)` : s;
}
