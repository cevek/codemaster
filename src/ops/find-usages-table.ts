// The tabular projection of `find_usages` (§3 sql) — split from the op to keep it under
// the line cap. One relation over reference sites from both halves of the answer: the
// semantic refs (`provenance='semantic'`) and, under `text:true`, the textual occurrences
// (`provenance='text'`, NULL role/encloser — role is an AST concept, NULL means "not our
// domain"; `0`/`''` would be a measured claim). New columns are appended at the END so
// existing positions never shift: `provenance`, then the representative reference site
// (`ref_file/ref_line/ref_col`) for a grouped encloser row — the encloser's own
// `file/line/col` is its NAME token, so the ref site (WHERE a reference actually is) is a
// distinct, proof-carrying location. NULL for flat/text rows, whose `file/line/col` already
// IS the reference site.

import type { JsonValue } from '../core/json.ts';
import type { GroupRow, SymbolView, UsageView } from '../plugins/ts/query-types.ts';
import type { Cell, TableSpec } from './registry.ts';

type TextOnlyRow = { span: { file: string; line: number; col: number }; confidence: string };

type Section = {
  symbol: string | null;
  usages?: UsageView[] | undefined;
  enclosers?: GroupRow[] | undefined;
  excludedByFilter?: number | undefined;
  textOnly?: TextOnlyRow[] | undefined;
};

function sectionRows(s: Section): readonly Cell[][] {
  const rows: Cell[][] = [];
  for (const u of s.usages ?? []) {
    rows.push([
      s.symbol,
      u.span.file,
      u.span.line,
      u.span.col,
      u.role,
      null,
      null,
      null,
      null,
      null,
      null,
      u.confidence,
      'semantic',
      null, // ref_file — a flat row's file/line/col already IS the ref site
      null,
      null,
      u.program ?? null, // surfacing program (multi-program only; NULL single-program)
      u.decls !== undefined ? u.decls.join(',') : null, // merged-decl indices (merge mode only)
      destructuresCell(u), // t-409060: consumed return-shape (call-role + opt-in only; NULL otherwise)
    ]);
  }
  for (const g of s.enclosers ?? []) {
    rows.push([
      s.symbol,
      g.file,
      g.line,
      g.col,
      g.roles,
      g.name,
      g.id,
      g.kind,
      g.file,
      g.exported ? 1 : 0,
      g.count,
      g.confidence,
      'semantic',
      // The representative reference site — distinct from the encloser's name token
      // (file/line/col above). Always present for a real grouped ref; NULL-guarded for safety.
      g.site?.file ?? null,
      g.site?.line ?? null,
      g.site?.col ?? null,
      g.programs ?? null, // joined set of surfacing programs (multi-program only)
      g.decls ?? null, // joined set of merged-decl indices (merge mode only)
      null, // destructures — a grouped rollup row is not a per-call-site view (flat mode only)
    ]);
  }
  // Text-only rows: same text, identity unproven — no AST role/encloser to claim.
  for (const t of s.textOnly ?? []) {
    rows.push([
      s.symbol,
      t.span.file,
      t.span.line,
      t.span.col,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      t.confidence,
      'text',
      null,
      null,
      null,
      null, // program — a textual hit has no program provenance
      null, // decls
      null, // destructures — a textual hit is not a semantic call site
    ]);
  }
  return rows;
}

/** The tabular cell for a call site's consumed return-shape: `whole`, a comma-joined prop list
 *  (`*` marks a `...rest`/computed key), `''` for a discarded result, or NULL when not annotated. */
function destructuresCell(u: UsageView): Cell {
  const d = u.destructures;
  if (d === undefined) return null;
  if (d.whole === true) return 'whole';
  const props = d.props ?? [];
  return `${props.join(',')}${d.rest === true ? (props.length > 0 ? ',*' : '*') : ''}`;
}

function sectionsOf(data: JsonValue): Section[] {
  const d = data as {
    targets?: Section[];
    definition?: SymbolView;
    usages?: UsageView[];
    enclosers?: GroupRow[];
    excludedByFilter?: number;
    textOnly?: TextOnlyRow[];
  };
  if (d.targets !== undefined) {
    return d.targets.map((t) => ({
      symbol: t.symbol,
      usages: t.usages,
      enclosers: t.enclosers,
      excludedByFilter: t.excludedByFilter,
      textOnly: t.textOnly,
    }));
  }
  return [
    {
      symbol: d.definition?.name ?? null,
      usages: d.usages,
      enclosers: d.enclosers,
      excludedByFilter: d.excludedByFilter,
      textOnly: d.textOnly,
    },
  ];
}

export const findUsagesTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'symbol', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'col', type: 'int' },
    { name: 'role', type: 'text' },
    { name: 'encloser', type: 'text' },
    { name: 'encloser_id', type: 'text' },
    { name: 'encloser_kind', type: 'text' },
    { name: 'encloser_file', type: 'text' },
    { name: 'is_exported', type: 'int' },
    { name: 'count', type: 'int' },
    { name: 'confidence', type: 'text' },
    { name: 'provenance', type: 'text' },
    { name: 'ref_file', type: 'text' },
    { name: 'ref_line', type: 'int' },
    { name: 'ref_col', type: 'int' },
    // The surfacing TS program (Task G). NULL when a single program is loaded. HONEST ASYMMETRY:
    // a sibling label (`tsconfig.test.json`) means the ref is present ONLY there; the primary label
    // means present in primary, POSSIBLY elsewhere too — the primary-preferred dedup keeps one label
    // and cannot enumerate every containing program (full enumeration would need cross-program.ts).
    { name: 'program', type: 'text' },
    // mergeDeclarations mode: comma-joined indices into `mergedDeclarations` whose ref set surfaced
    // this site — per-site provenance, so unrelated same-named symbols are never conflated. NULL otherwise.
    { name: 'decls', type: 'text' },
    // t-409060 (opt-in `destructures:true`): the return-shape a CALL site consumes — `whole`, a
    // comma-joined prop list (`*` = `...rest`/computed key), `''` = discarded result. NULL when the
    // flag is off, the row is not a call, or it is a grouped/text row.
    { name: 'destructures', type: 'text' },
  ],
  rows(data) {
    return sectionsOf(data).flatMap(sectionRows);
  },
  notes(data) {
    const notes: string[] = [];
    for (const s of sectionsOf(data)) {
      if (s.excludedByFilter !== undefined && s.excludedByFilter > 0) {
        notes.push(
          `${s.symbol ?? '<target>'}: ${s.excludedByFilter} reference(s) excluded by your path/kind filters`,
        );
      }
    }
    const unresolved =
      (data as { unresolved?: { name: string; reason: string }[] }).unresolved ?? [];
    for (const u of unresolved) notes.push(`unresolved symbol '${u.name}': ${u.reason}`);
    return notes;
  },
};
