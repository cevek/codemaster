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
// truncation is honest, never a silent undercount (§3.4). Primary program only (matches
// construction_sites — no cross-program fan-out); that limit is disclosed in the op's static note.

import * as path from 'node:path';
import ts from 'typescript';
import type { Confidence, Span } from '../../core/span.ts';
import { nodeAt } from './ast-node.ts';
import { typeAtNode } from './type-at-node.ts';
import { describeTarget } from './construction-target.ts';
import { pathScopePredicate } from './path-scope.ts';
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
  truncated?: { examined: number; candidates: number };
  notes?: string[];
};

export interface DiscriminationSitesOptions {
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
  /** Hard cap on switch/if-head statements examined (the compute bound, §1/§19). */
  limit?: number | undefined;
}

const DEFAULT_SCAN_CAP = 2000;

export function findDiscriminationSites(
  host: TsProjectHost,
  abs: string,
  offset: number,
  options: DiscriminationSitesOptions,
): DiscriminationSitesView | string {
  // Target union-type resolution + the discriminating-scrutinee scan run in ONE program routed to
  // the type-authority for `abs` (t-593802): in a no-root repo `host.service` is the fallback primary
  // whose whole-repo glob pollutes the union type with augmentation strays. typeAuthorityFor returns
  // the target's own-options program — the union type is honest and the (single-program, per this op's
  // disclosed contract) scan stays sound.
  const program = host.typeAuthorityFor(abs).getProgram();
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

  return scan(host, program, checker, targetType, targetView, {
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
  program: ts.Program,
  checker: ts.TypeChecker,
  targetType: ts.Type,
  targetView: DiscriminationTargetView,
  ctx: ScanCtx,
): DiscriminationSitesView {
  const discByName = new Map(ctx.discriminants.map((d) => [d.name, d.domain]));
  const inScope = pathScopePredicate(ctx.options.pathInclude, ctx.options.pathExclude);
  const cap = ctx.options.limit ?? DEFAULT_SCAN_CAP;
  const sites: DiscriminationSite[] = [];
  let examined = 0;
  let candidates = 0;
  let scannedFiles = 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes('/node_modules/') || sourceFile.isDeclarationFile) continue;
    const rel = host.relOf(sourceFile.fileName);
    if (path.isAbsolute(String(rel))) continue; // path-mapped spillover — not ours to scan
    if (!inScope(rel)) continue;
    scannedFiles++;

    const visit = (n: ts.Node): void => {
      const raw = rawSiteOf(sourceFile, n);
      if (raw !== undefined) {
        candidates++;
        if (examined < cap) {
          examined++;
          const site = gate(
            host,
            checker,
            sourceFile,
            rel,
            targetType,
            raw,
            discByName,
            ctx.bareDomain,
          );
          if (site !== undefined) sites.push(site);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sourceFile);
  }

  const truncated = candidates > examined;
  const empty = emptyNote(sites.length, targetView.name, truncated);
  return {
    target: targetView,
    sites,
    scannedStatements: examined,
    scannedFiles,
    ...(truncated ? { truncated: { examined, candidates } } : {}),
    ...(empty !== undefined ? { notes: [empty] } : {}),
  };
}

/** A 0-site answer must not read as "none exist" (§3.4). When the cap was hit, MORE statements were
 *  left unscanned — say so, never assert non-existence. Only a complete scan may state "none in scope". */
function emptyNote(siteCount: number, name: string, truncated: boolean): string | undefined {
  if (siteCount > 0) return undefined;
  if (truncated) {
    return `no discriminating switch/if-chain among the examined statements — but the cap was hit and MORE are unscanned; raise limit or narrow pathInclude before concluding nothing switches on ${name}`;
  }
  return `no switch/if-chain in scope discriminates on ${name} (identity-gated on a value of type ${name}) — a switch on an unrelated union, a structural supertype, or a non-discriminant property is correctly excluded; widen pathInclude if you scoped it`;
}

/** A `switch` statement or an `if`-chain HEAD → its RawSite; `undefined` for any other node. */
function rawSiteOf(sf: ts.SourceFile, n: ts.Node): RawSite | undefined {
  if (ts.isSwitchStatement(n)) return analyzeSwitch(sf, n);
  if (ts.isIfStatement(n) && isIfChainHead(n)) return analyzeIfChain(sf, n);
  return undefined;
}
