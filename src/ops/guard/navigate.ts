// t-959904 — the single home of "what answers the SAME question when the heavy path cannot run
// HERE". Every refusal/failure surface that declines a semantic fan-out renders from this table;
// none of them writes its own redirect prose, so one claim has one home (the repeated-note defect
// class, t-034392).
//
// The rule the table exists to enforce: a refusal must name a CALL THE AGENT CAN MAKE RIGHT NOW,
// in this same session, against this same repo. Codemaster's primary audience for these messages is
// an agent working inside SOMEONE ELSE'S repository: it cannot restart a machine-global daemon
// (other clients' warm state lives there), cannot write `codemaster.config` into a repo it does not
// own, and has no codemaster sources. An advice it cannot execute is not a lesser answer — it is a
// dead end with a view of a solution. So config / isolation / restart remedies are never the
// headline here; another op with different args is.
//
// Where the knowledge comes from: STRUCTURE, not measurement. Every call named below is safe by
// construction, not by having been observed to work once —
//   * `symbols_overview` / `search_symbol {syntactic:true}` parse the git source surface with
//     `ts.createSourceFile` and NEVER build a program or warm the LS (ARCHITECTURE.md §5-L2), and no
//     guard gates them;
//   * a FILE-PINNED `find_definition` is single-program-exact and never reaches the repo-wide navto
//     fan (`isFanCapableTarget`), so the fan-out guard does not apply to it.
// A live run verifies the table; it is not what the table knows.
//
// And the honesty that makes it a redirect rather than a substitute (§3.6): several questions have
// NO cheaper in-tool path. Those get `fallback` — "codemaster cannot answer THIS here" plus the
// orientation calls that still work — never an invented near-equivalent presented as the answer.
// The point an agent must come away with is that the REPO is not dead, only one op is.

/** One paste-able call plus what it actually returns. `gives` states the answer's real extent,
 *  including what it is NOT, so a redirect can never read as an equivalent of the refused op. */
export type CheapCall = { readonly call: string; readonly gives: string };

/** The target fields a redirect can interpolate. Read defensively off the op's own (already
 *  validated) args — a shape mismatch degrades to a subject-less redirect, never a throw. */
type NavArgs = { readonly name?: string; readonly file?: string };

function str(bag: Record<string, unknown>, key: string): string | undefined {
  const v = bag[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The SYMBOL the refused call was about. `module` is deliberately NOT read: it is a path, and
 *  pasting a path into a name-matching `query` would produce a call that silently finds nothing —
 *  a redirect that fails quietly is worse than one that admits it has no subject. */
function readArgs(args: unknown): NavArgs {
  if (typeof args !== 'object' || args === null) return {};
  const bag = args as Record<string, unknown>;
  const name = str(bag, 'name') ?? str(bag, 'query');
  const file = str(bag, 'file');
  return { ...(name !== undefined ? { name } : {}), ...(file !== undefined ? { file } : {}) };
}

const j = (v: string) => JSON.stringify(v);

/** The two calls that answer on ANY repo, however large: no program build, no LS warm, no guard. */
function orientation(name: string | undefined): CheapCall[] {
  if (name === undefined) {
    return [
      {
        call: 'symbols_overview {}',
        gives: "the repo's declared symbol names per tsconfig — pick one, then search_symbol on it",
      },
    ];
  }
  return [
    {
      call: `symbols_overview {query:${j(name)}}`,
      gives: `declared names matching ${j(name)}, per tsconfig`,
    },
    {
      call: `search_symbol {query:${j(name)},syntactic:true}`,
      gives: `where ${j(name)} is declared, AST-only (no type-check)`,
    },
  ];
}

/** "who uses X" — the one question with a partial in-tool answer, and the partial must say so.
 *  The syntactic scan returns declarations plus every import/re-export specifier of the name, which
 *  is a FILE-level "who imports it", not the per-site usage set the refused op would have given. */
function usageAlternatives(name: string | undefined): CheapCall[] {
  if (name === undefined) return [];
  return [
    {
      call: `search_symbol {query:${j(name)},syntactic:true}`,
      gives: `declarations + every import/re-export of ${j(name)} (file-level who-imports-it), NOT the per-site usage set`,
    },
  ];
}

/** "where is X declared" — the syntactic scan locates it, and the file it reports turns the refused
 *  bare-name lookup into a file-pinned one, which is single-program-exact and never fans. The
 *  pinned call is emitted with a REAL file only when the refused call carried one; otherwise it is
 *  explicitly a second step off the first call's output. A bare `find_definition {name}` is itself
 *  fan-capable, so naming one would redirect the agent straight back into this guard. */
function definitionAlternatives(nav: NavArgs): CheapCall[] {
  const { name, file } = nav;
  if (name === undefined) return [];
  if (file !== undefined) {
    return [
      {
        call: `find_definition {name:${j(name)},file:${j(file)}}`,
        gives: 'the type-verified declaration — a file pin is single-program-exact and never fans',
      },
    ];
  }
  return [
    {
      call: `search_symbol {query:${j(name)},syntactic:true}`,
      gives: `the file(s) declaring ${j(name)}`,
    },
    {
      call: `find_definition {name:${j(name)},file:"<file from the call above>"}`,
      gives: 'the type-verified declaration — a file pin is single-program-exact and never fans',
    },
  ];
}

/** Per-op cheap paths. An op absent from this map, or one whose entry yields nothing for the args
 *  at hand, falls through to the honest no-substitute arm — never a fabricated near-equivalent. */
const BY_OP: Record<string, (nav: NavArgs) => CheapCall[]> = {
  find_usages: (nav) => usageAlternatives(nav.name),
  member_usages: (nav) => usageAlternatives(nav.name),
  find_definition: definitionAlternatives,
  trace_prop_through_tree: definitionAlternatives,
  trace_type_widening: definitionAlternatives,
  search_symbol: (nav) =>
    nav.name === undefined
      ? []
      : [
          {
            call: `search_symbol {query:${j(nav.name)},syntactic:true}`,
            gives:
              'the same fuzzy name search over the AST alone — no program build, no LS warm; noisier (import/re-export sites included, declarations ranked first)',
          },
          ...orientation(nav.name).slice(0, 1),
        ],
  list: (nav) => [
    {
      call:
        nav.name === undefined ? 'symbols_overview {}' : `symbols_overview {query:${j(nav.name)}}`,
      gives:
        "the repo's declared symbol names per tsconfig — a NAME catalogue, not this registry's typed entries",
    },
  ],
};

/** The calls a refusal should offer for `op` called with `args`, and whether any of them addresses
 *  the question that was actually asked. `substitute:false` means the honest answer is "not here" —
 *  the caller must say so rather than let the orientation calls read as the answer. */
export function cheapCallsFor(
  op: string,
  args: unknown,
): { readonly calls: readonly CheapCall[]; readonly substitute: boolean } {
  const nav = readArgs(args);
  const specific = BY_OP[op]?.(nav) ?? [];
  if (specific.length > 0) return { calls: specific, substitute: true };
  return { calls: orientation(nav.name), substitute: false };
}

/** Render the redirect as ONE dense clause (§12 — a refusal that buries its own next step in prose
 *  is the failure this table exists to fix). Verdict first: what to run, then what it returns. */
export function navigationFor(op: string, args: unknown): string {
  const { calls, substitute } = cheapCallsFor(op, args);
  const body = calls.map((c) => `${c.call} → ${c.gives}`).join(' · ');
  const lead = substitute
    ? 'RUN INSTEAD (no program build, no fan)'
    : `NO cheaper in-tool path to this question (${op} is what answers it); still runs here`;
  return `${lead}: ${body}.`;
}
