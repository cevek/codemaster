// `discrimination_sites` machinery (§5-L2): given a union TYPE T, the `switch` statements and
// `if/else-if` chains that DISCRIMINATE on T — including scrutinees reached via property access
// (`switch (spec.type.kind)` where `spec.type: T`), which `find_usages` on T's NAME structurally
// misses (the identifier never appears at the switch). The "what must I update to stay exhaustive
// when I widen T?" query. Semantic answers come from the live LS — the only oracle (§3.1).
//
// IDENTITY, not structural assignability (discrimination-target.ts): the scrutinee object's type
// must BE T, so a `.kind` switch on an unrelated union / structural supertype (`{ kind: string }`)
// is NOT reported. The accessed property must be a DISCRIMINANT of T, so `switch (f.value)` on a
// non-discriminant field is excluded. Both gates together are what keep this from flooding.
//
// Bounded by DESIGN (§19): the walk is O(nodes) AST; the per-statement type work (identity + covers)
// is capped by the NUMBER of switch/if-heads examined — past the cap they are still COUNTED so the
// truncation is honest, never a silent undercount (§3.4).
//
// CROSS-PROGRAM (t-162650, shared with construction_sites via `program/scan-fanout.ts`): a switch
// living in a sibling program (a `test/**` file, a package that imports T) is a real site, so a
// single-program scan would answer `0` about a question whose answer exists. The identity gate is a
// TYPE-identity compare, which is invalid across programs, so the fan re-resolves T in each program
// and judges that program's own files against that program's own T.

import ts from 'typescript';
import type { Confidence, Span } from '../../core/span.ts';
import type { Deadline } from '../../common/async/deadline.ts';
import { nodeAt } from './ast-node.ts';
import { typeAtNode } from './type-at-node.ts';
import { describeTarget } from './construction-target.ts';
import {
  runFanoutScan,
  selectScanFanout,
  type ScanCoverage,
  type ScanFanout,
} from './program/scan-fanout.ts';
import type { EncloserView } from './encloser-view.ts';
import {
  discriminantsOf,
  bareLiteralDomain,
  type Discriminant,
  type LitVal,
} from './discrimination-target.ts';
import {
  analyzeIfChain,
  analyzeSwitch,
  isIfChainHead,
  type RawSite,
} from './discrimination-analyze.ts';
import { gate } from './discrimination-gate.ts';
import type { TsProjectHost } from './ls-host.ts';

export type DiscriminationSite = {
  kind: 'switch' | 'if-chain';
  /** The `switch`/`if` keyword span — proof of WHERE (§3.1). */
  span: Span;
  /** Verbatim scrutinee text (`f.kind`, `spec.type.kind`). */
  scrutinee: string;
  /** The discriminant property, or `(value)` for a bare `switch(x)` on a literal union. */
  discriminant: string;
  confidence: Confidence;
  note?: string;
  /** Literal values the cases/branches cover. */
  covers: string[];
  /** Domain − covers: the discriminant literals NOT handled (the exhaustiveness gap). */
  missing: string[];
  /** A `default` clause / bare trailing `else` is present. */
  hasDefault: boolean;
  encloser: EncloserView;
};

export type DiscriminationTargetView = {
  name: string;
  kind: string;
  span: Span;
  discriminants: { name: string; domain: string[] }[];
};

export type DiscriminationSitesView = {
  target: DiscriminationTargetView;
  sites: DiscriminationSite[];
  scannedStatements: number;
  scannedFiles: number;
  /** The positive per-program scope + every reason the scan may fall short (§3.4). ABSENT when a
   *  target guard fired (T is not a union / has no discriminant) — no scan was attempted, so there
   *  is no scope to report and no emptiness to explain. */
  coverage?: ScanCoverage;
  truncated?: { examined: number; candidates: number };
  notes?: string[];
};

export interface DiscriminationSitesOptions {
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
  /** Hard cap on switch/if-head statements examined (the compute bound, §1/§19). */
  limit?: number | undefined;
  /** The op's cooperative wall-clock budget — polled at the file boundary (§19). */
  deadline?: Deadline | undefined;
}

/** Default cap on switch/if-heads examined — ONE budget for the whole cross-program fan, so N
 *  programs never multiply it. Exported so the op's floor note names the budget the scan spent. */
export const DEFAULT_SCAN_CAP = 2000;

export function findDiscriminationSites(
  host: TsProjectHost,
  abs: string,
  offset: number,
  options: DiscriminationSitesOptions,
): DiscriminationSitesView | string {
  // The type authority answers the TARGET-level questions (T's span, its discriminants, whether it
  // can host the query at all) because a target guard must not depend on which sibling happened to
  // load — in a no-root repo the fallback primary's whole-repo glob would pollute the union type it
  // reports (t-593802). The SCAN then fans (`scan-fanout.ts`), re-resolving T per program.
  const fanout = selectScanFanout(host, abs);
  const program = fanout.fan[0]?.getProgram();
  if (program === undefined) return 'the TS program is unavailable';
  const checker = program.getTypeChecker();
  const targetFile = program.getSourceFile(abs);
  if (targetFile === undefined) return 'the target file is not in the TS project';
  const node = nodeAt(targetFile, offset);
  if (node === undefined) return 'no node at the resolved position';
  const targetType = typeAtNode(checker, node);
  if (targetType === undefined) return 'no type at the resolved position';

  const desc = describeTarget(host, targetFile, node, checker.getSymbolAtLocation(node));
  const discriminants = discriminantsOf(checker, targetType);
  const bareDomain = bareLiteralDomain(checker, targetType);
  const targetView: DiscriminationTargetView = {
    name: desc.name,
    kind: desc.kind,
    span: desc.span,
    discriminants: discriminants.map((d) => ({
      name: d.name,
      domain: d.domain.map((v) => v.display),
    })),
  };

  const guard = targetGuard(desc, targetType, discriminants, bareDomain);
  if (guard !== undefined) {
    return { target: targetView, sites: [], scannedStatements: 0, scannedFiles: 0, notes: [guard] };
  }

  return scan(host, abs, offset, fanout, targetView, {
    discriminants,
    bareDomain,
    options,
  });
}

/** A note when T cannot host a discrimination query — not a union, or a union with no discriminant
 *  and not a bare literal union. Returns `undefined` when the scan should proceed. */
function targetGuard(
  desc: { name: string; kind: string },
  targetType: ts.Type,
  discriminants: Discriminant[],
  bareDomain: LitVal[] | undefined,
): string | undefined {
  if (!targetType.isUnion()) {
    return `target ${desc.kind} ${desc.name} is not a union type — there is no discriminant to switch on; discrimination_sites answers "which switch/if-chains discriminate on a union T"`;
  }
  if (discriminants.length === 0 && bareDomain === undefined) {
    return `union ${desc.name} has no discriminant property (no field is a literal/unit in every constituent) and is not a bare literal union — cannot identify which switches discriminate on it`;
  }
  return undefined;
}

type ScanCtx = {
  discriminants: Discriminant[];
  bareDomain: LitVal[] | undefined;
  options: DiscriminationSitesOptions;
};

function scan(
  host: TsProjectHost,
  abs: string,
  offset: number,
  fanout: ScanFanout,
  targetView: DiscriminationTargetView,
  ctx: ScanCtx,
): DiscriminationSitesView | string {
  const discByName = new Map(ctx.discriminants.map((d) => [d.name, d.domain]));
  const scanned = runFanoutScan(
    host,
    fanout,
    { ...ctx.options, limit: ctx.options.limit ?? DEFAULT_SCAN_CAP },
    {
      // Per-program target resolve: the gate is a TYPE-IDENTITY compare, and a type identity belongs
      // to ONE checker — so T is re-resolved here and each program's sites are judged against its
      // own T. A program where T is no longer a discriminable union under ITS options is skipped
      // rather than judged against a type it does not have.
      resolve: (program, programChecker) => {
        const sf = program.getSourceFile(abs);
        if (sf === undefined) return undefined;
        const at = nodeAt(sf, offset);
        if (at === undefined) return undefined;
        const type = typeAtNode(programChecker, at);
        if (type === undefined || !type.isUnion()) return undefined;
        return { checker: programChecker, type };
      },
      prepare: (n, sourceFile) => rawSiteOf(sourceFile, n),
      evaluate: (raw, resolved, sourceFile, rel) =>
        gate(
          host,
          resolved.checker,
          sourceFile,
          rel,
          resolved.type,
          raw,
          discByName,
          ctx.bareDomain,
        ),
    },
  );
  // No fanned program resolves T to a union — a "couldn't", not an `ok` shaped like 0 sites (§3.6).
  if (scanned === undefined) return 'the target is not a union type in any program containing it';

  const { coverage } = scanned;
  return {
    target: targetView,
    sites: scanned.sites,
    scannedStatements: coverage.examined,
    scannedFiles: coverage.files,
    coverage,
    ...(coverage.candidates > coverage.examined
      ? { truncated: { examined: coverage.examined, candidates: coverage.candidates } }
      : {}),
  };
}

/** The ONLY emptiness wording a COMPLETE scan licenses (§3.4). The incomplete and never-scanned
 *  states are coverage facts with their own remedies, assembled for every scanning op in
 *  `ops/scan-coverage.ts` — and `pathInclude` is deliberately not named here, because a complete
 *  scan is complete whatever the glob was (naming an inert lever is the t-259465 defect). What this
 *  verdict DOES still owe is the identity gate's own under-coverage, which no coverage counter can
 *  express: it is a property of the gate, not of the file set. */
export function completeEmptyVerdict(name: string): string {
  return `no switch/if-chain in the scanned programs discriminates on a scrutinee whose type is EXACTLY ${name} (identity-gated) — the scan was COMPLETE. A switch on an unrelated union, a structural supertype (\`{ kind: string }\`), or a non-discriminant property is correctly excluded; BUT a scrutinee typed as an INTERSECTION (\`${name} & X\`, incl. the distributed form an \`in\`-narrowing yields) or a mapped-type wrapper (\`Readonly<${name}>\`) is honest UNDER-COVERAGE the gate cannot recover (structural matching there would flood every kind-union) — such a site is MISSED, not proven absent.`;
}

/** A `switch` statement or an `if`-chain HEAD → its RawSite; `undefined` for any other node. */
function rawSiteOf(sf: ts.SourceFile, n: ts.Node): RawSite | undefined {
  if (ts.isSwitchStatement(n)) return analyzeSwitch(sf, n);
  if (ts.isIfStatement(n) && isIfChainHead(n)) return analyzeIfChain(sf, n);
  return undefined;
}
