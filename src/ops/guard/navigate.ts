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
//     fan (`isFanCapableTarget`), so the fan-out guard does not apply to it;
//   * `source {syntactic:true}` reads bodies off that same no-program surface (ARCHITECTURE.md §5-L2),
//     so it too builds no program — which is what lets it survive an engine death, below.
// A live run verifies the table; it is not what the table knows.
//
// And the honesty that makes it a redirect rather than a substitute (§3.6): several questions have
// NO cheaper in-tool path. Those get `fallback` — "codemaster cannot answer THIS here" plus the
// orientation calls that still work — never an invented near-equivalent presented as the answer.
// The point an agent must come away with is that the REPO is not dead, only one op is.

import type { OutOfReach } from '../../core/result.ts';
import { classifyTargetString } from '../intake/smart-string.ts';

/** One paste-able call plus what it actually returns. `gives` states the answer's real extent,
 *  including what it is NOT, so a redirect can never read as an equivalent of the refused op. */
export type CheapCall = {
  readonly call: string;
  readonly gives: string;
  /** True when running this call builds a TS program and warms the checker. Naming such a call is
   *  honest only under a `'this-call'` claim, the one that states a program build is still within
   *  reach — see `OutOfReach` in `core/result.ts`. */
  readonly buildsProgram?: true;
};

/** The target fields a redirect can interpolate. Read defensively — a shape mismatch degrades to a
 *  subject-less redirect, never a throw. */
type NavArgs = {
  readonly name?: string;
  readonly file?: string;
  /** The caller's own args, kept so a re-pinned call can carry them verbatim. */
  readonly bag?: Record<string, unknown>;
};

function str(bag: Record<string, unknown>, key: string): string | undefined {
  const v = bag[key];
  if (typeof v === 'string' && v.length > 0) return v;
  // A list-shaped target (`symbols:[…]`, `targets:[…]`): the first element still names something
  // real, and a redirect about one of them beats a redirect about none. The element may itself be a
  // target OBJECT (`targets:[{name:'X'}]` — `source`'s canonical shape), so its `name` is read too:
  // bare strings alone leave the subject undefined for the one op whose targets are objects.
  const head: unknown = Array.isArray(v) ? (v as readonly unknown[])[0] : undefined;
  if (typeof head === 'string' && head.length > 0) return head;
  const nested: unknown =
    typeof head === 'object' && head !== null
      ? (head as Record<string, unknown>)['name']
      : undefined;
  return typeof nested === 'string' && nested.length > 0 ? nested : undefined;
}

/** Where each op keeps the SYMBOL it was asked about. Not every op calls it `name`: a trace is
 *  addressed by `mutation` / `field`, unused-props by `component`. Reading only `name`/`query`
 *  silently dropped a subject that was sitting right there in the args. */
const SUBJECT_KEYS = [
  'name',
  'query',
  'symbol',
  'mutation',
  'field',
  'component',
  'symbols',
  'targets',
];

/** The SYMBOL the refused call was about. `module` is deliberately NOT read: it is a path, and
 *  pasting a path into a name-matching `query` would produce a call that silently finds nothing —
 *  a redirect that fails quietly is worse than one that admits it has no subject.
 *
 *  Args here may be RAW, pre-intake wire args, not the canonical shape. The two L3 callers run
 *  inside `run()`, below `resolveArgs`, so they see canonical keys — but `daemon/process-host`'s
 *  failure path sits ABOVE the child that normalizes (§7 intake runs in the engine), so it sees
 *  whatever the agent actually sent. Hence both liberal spellings AND the same path-shaped-name
 *  classification the intake layer applies (`classifyTargetString`, reused rather than re-derived):
 *  a `name` that is really `src/x.ts:10:3` must NOT become `query:"src/x.ts:10:3"` — that is exactly
 *  the quiet-miss this function refuses to emit for `module`. */
function readArgs(args: unknown): NavArgs {
  if (typeof args !== 'object' || args === null) return {};
  const bag = args as Record<string, unknown>;
  // Bounded, but NOT elided: a redirect's whole value is that it can be pasted and run, and a
  // subject cut with `…` yields a call that looks runnable and is not. So an implausibly long
  // subject is DROPPED, degrading to the subject-less redirect (still exact, still runnable) rather
  // than emitting a broken one. This is why `common/truncate/elideString` is deliberately not used.
  // `symbol` is the §7 alias of `name`; `target` is the alias of `symbolId` and is deliberately not
  // read (a handle carries no name outside its owning plugin — see t-702879).
  let raw: string | undefined;
  for (const key of SUBJECT_KEYS) raw ??= str(bag, key);
  const classified =
    raw !== undefined && raw.length <= MAX_SUBJECT ? classifyTargetString(raw) : undefined;
  const name = classified?.kind === 'name' ? classified.name : undefined;
  const file = str(bag, 'file') ?? (classified?.kind === 'location' ? classified.file : undefined);
  return {
    bag,
    ...(name !== undefined ? { name } : {}),
    ...(file !== undefined ? { file } : {}),
  };
}

/** Well past any real identifier; a longer "name" is a pasted blob, not a symbol. */
const MAX_SUBJECT = 120;

const j = (v: string) => JSON.stringify(v);

/** The whole-repo name catalogue — the one call that answers on ANY repo, at any size. Named rather
 *  than reached for by position in `orientation`, so a reorder there cannot silently turn another
 *  redirect into a duplicate of its own first entry. */
function symbolsOverviewCall(name: string | undefined): CheapCall {
  if (name === undefined) {
    return {
      call: 'symbols_overview {}',
      gives: "the repo's declared symbol names per tsconfig — pick one, then search_symbol on it",
    };
  }
  return {
    call: `symbols_overview {query:${j(name)}}`,
    gives: `declared names matching ${j(name)}, per tsconfig`,
  };
}

/** The calls that answer on ANY repo, however large: no program build, no LS warm, no guard. */
function orientation(name: string | undefined): CheapCall[] {
  if (name === undefined) return [symbolsOverviewCall(undefined)];
  return [
    symbolsOverviewCall(name),
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
  const pinned: CheapCall = {
    call: `find_definition {name:${j(name)},file:${file === undefined ? '"<file from the call above>"' : j(file)}}`,
    gives: 'the type-verified declaration — a file pin is single-program-exact and never fans',
    buildsProgram: true,
  };
  if (file !== undefined) return [pinned];
  return [
    {
      call: `search_symbol {query:${j(name)},syntactic:true}`,
      gives: `the file(s) declaring ${j(name)}`,
    },
    pinned,
  ];
}

/** The CONDITIONALLY guarded ops (`isFanCapableTarget`): their refusal is about the ADDRESSING, not
 *  the question — a bare name fans across every program, a file pin is single-program-exact and is
 *  never guarded. So the honest redirect is the very same op re-pinned, not a different one that
 *  answers a different question. The re-pinned call carries the caller's OWN remaining args verbatim
 *  (a trace's `prop` / `field` must survive, or the "paste this" promise is false); `symbolId` is
 *  dropped because a handle plus a file pin is a contradictory target. */
function callWith(
  op: string,
  bag: Record<string, unknown>,
  extra: Record<string, unknown>,
): string | undefined {
  const parts = Object.entries({ ...bag, ...extra })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`);
  const call = `${op} {${parts.join(',')}}`;
  return call.length <= MAX_CALL ? call : undefined;
}

function repinnedCall(op: string, bag: Record<string, unknown>, file: string): string | undefined {
  return callWith(op, bag, { symbolId: undefined, file });
}

/** A re-pin is only offered when it can be rendered EXACTLY; an over-long arg bag degrades to the
 *  locate-then-repin two-step rather than a truncated call that cannot be run. */
const MAX_CALL = 300;

function repinAlternatives(op: string, nav: NavArgs): CheapCall[] {
  const { name, file, bag } = nav;
  if (name === undefined || bag === undefined) return [];
  const pinned = file === undefined ? undefined : repinnedCall(op, bag, file);
  if (pinned !== undefined) {
    return [
      {
        call: pinned,
        gives: `the same ${op}, single-program-exact — a file pin never fans`,
        buildsProgram: true,
      },
    ];
  }
  return [
    {
      call: `search_symbol {query:${j(name)},syntactic:true}`,
      gives: `the file(s) declaring ${j(name)}`,
    },
    {
      call: `${op} {…same args…,file:"<file from the call above>"}`,
      gives: `the same ${op} re-addressed — pinning the file makes it single-program-exact, so it never fans`,
      buildsProgram: true,
    },
  ];
}

/** A MODE switch on the same op: the identical question, answered by a path that builds no program
 *  (`source {syntactic:true}` — ARCHITECTURE §5-L2). Unlike a re-pin, this is not about addressing, so
 *  the caller's own args ride along untouched.
 *
 *  Two refusals to emit. If the failing call ALREADY carried the flag, there is no mode left to switch
 *  to and printing it back would hand the agent the very call that just failed — the dead end this
 *  module exists to prevent. And if the arg bag cannot be rendered exactly (an over-long target list),
 *  the mode switch degrades to a subject-only call rather than a truncated one that cannot be run. */
function syntacticModeAlternatives(op: string, nav: NavArgs, gives: string): CheapCall[] {
  const { bag, name } = nav;
  if (bag === undefined || bag['syntactic'] === true) return [];
  const exact = callWith(op, bag, { syntactic: true });
  if (exact !== undefined) return [{ call: exact, gives }];
  if (name === undefined) return [];
  // The exact render did not fit, so the fallback carries ONE target. Say how many it drops: a call that
  // answers about 1 of 20 while its `gives` promises "the same bodies" is a redirect that quietly
  // under-delivers, which is the §3.4 omission in miniature.
  const dropped = droppedTargets(bag);
  return [
    {
      call: `${op} {name:${j(name)},syntactic:true}`,
      gives:
        dropped > 0
          ? `${gives} — this call carries the FIRST target only (${dropped} more: re-request them)`
          : gives,
    },
  ];
}

/** How many targets the one-target fallback leaves behind (0 when the call was single-target anyway). */
function droppedTargets(bag: Record<string, unknown>): number {
  const list = bag['targets'];
  return Array.isArray(list) && list.length > 1 ? list.length - 1 : 0;
}

/** What `source {syntactic:true}` actually returns — stated as a difference, not as an equivalence:
 *  it prints the declaration AT the address, so a caller who addressed a REFERENCE gets an explicit
 *  miss there rather than a body. Naming that up front is what keeps this a redirect and not a claim. */
const SYNTACTIC_SOURCE_GIVES =
  'the same bodies read off the AST — no program build, no LS warm; it prints the declaration AT the address (it does not follow a reference to its definition) and is not type-verified';

/** Per-op cheap paths. An op absent from this map, or one whose entry yields nothing for the args
 *  at hand, falls through to the honest no-substitute arm — never a fabricated near-equivalent.
 *  A `Map`, not an object literal: this is looked up with an op name straight off the wire
 *  (process-host fails a whole batch before any name is validated), and on an object `'toString'` /
 *  `'__proto__'` resolve to INHERITED members — turning an honest `oom` verdict into a TypeError
 *  inside the very path that reports it. `Map.get` has no such shadow. */
const BY_OP = new Map<string, (nav: NavArgs) => CheapCall[]>([
  ['find_usages', (nav: NavArgs) => usageAlternatives(nav.name)],
  ['member_usages', (nav: NavArgs) => usageAlternatives(nav.name)],
  ['find_definition', definitionAlternatives],
  // `source` has a real substitute for its OWN question — the same op, AST-only — so while that mode is
  // still available it must not reach the no-substitute arm, whose orientation calls (symbols_overview /
  // search_symbol) list names and cannot print a body. Once the cheap mode is what failed, there IS no
  // substitute left and the arm is the honest answer.
  ['source', (nav: NavArgs) => syntacticModeAlternatives('source', nav, SYNTACTIC_SOURCE_GIVES)],
  // NOT definitionAlternatives: "where is X declared" is not "where does this prop flow" / "where
  // does this type widen", and offering it under a `RUN INSTEAD` lead would claim an equivalence
  // that does not hold (§3.6). These are addressing refusals — re-pin the same op.
  ['trace_prop_through_tree', (nav: NavArgs) => repinAlternatives('trace_prop_through_tree', nav)],
  ['trace_type_widening', (nav: NavArgs) => repinAlternatives('trace_type_widening', nav)],
  [
    'search_symbol',
    (nav: NavArgs) =>
      nav.name === undefined
        ? []
        : [
            {
              call: `search_symbol {query:${j(nav.name)},syntactic:true}`,
              // How the syntactic path DIFFERS from navto (noisier, declarations ranked first) is
              // the op's static note — restating it here gave one claim two homes, and the two had
              // already drifted ("definitions" vs "declarations"). This says only what the call is.
              gives: 'the same fuzzy name search over the AST alone — no program build, no LS warm',
            },
            symbolsOverviewCall(nav.name),
          ],
  ],
]);

/** The calls a refusal should offer for `op` called with `args`, and whether any of them addresses
 *  the question that was actually asked. `substitute:false` means the honest answer is "not here" —
 *  the caller must say so rather than let the orientation calls read as the answer. */
export function cheapCallsFor(
  op: string,
  args: unknown,
  outOfReach: OutOfReach,
): { readonly calls: readonly CheapCall[]; readonly substitute: boolean } {
  const nav = readArgs(args);
  // The failure's own claim decides this — it is not re-derived here. A program-building call may
  // be named ONLY under the claim that states one is still within reach; both of the others (proven
  // out of reach, and unproven after the engine died) get the conservative treatment, since naming
  // a call we cannot vouch for is the same defect as naming one we know is gone. What remains (or
  // nothing) then decides whether a substitute can honestly be claimed.
  const specific = (BY_OP.get(op)?.(nav) ?? []).filter(
    (c) => outOfReach === 'this-call' || c.buildsProgram !== true,
  );
  if (specific.length > 0) return { calls: specific, substitute: true };
  return { calls: orientation(nav.name), substitute: false };
}

/** Render the redirect as ONE dense clause (§12 — a refusal that buries its own next step in prose
 *  is the failure this table exists to fix). Verdict first: what to run, then what it returns. */
export function navigationFor(op: string, args: unknown, outOfReach: OutOfReach): string {
  const { calls, substitute } = cheapCallsFor(op, args, outOfReach);
  const body = calls.map((c) => `${c.call} → ${c.gives}`).join(' · ');
  // The lead carries NO cost claim: under `'this-call'` some of these calls do build a program (a
  // file pin escapes the guard without being free), so a blanket "no program build" would be false.
  // What each
  // call costs and covers lives in its own `gives`, which is per-call and cannot over-generalise.
  // Nor can the lead take the refused op as its implied subject — under either engine-death claim
  // that op is already gone, so "still runs here" would be a claim about the corpse.
  const lead = substitute
    ? 'RUN INSTEAD'
    : `NO cheaper in-tool path to this question (${op} is what answers it). What still answers here`;
  return `${lead}: ${body}.`;
}
