// The flow-navigation primitive behind `trace_type_widening` (§5-L2, Phase 6): given a VALUE
// (a variable / parameter), find the immediate FORWARD flow-sinks it reaches in ONE step — the
// places it is rebound with a possibly-wider declared type — and the per-sink widening verdict.
// AST + checker live HERE (the op never touches the LS — §5-L3); the op-level walk drives the
// recursion (depth / visited / node-cap) over the `next` positions this returns.
//
// CROSS-PROGRAM (t-467009). The step fans across EVERY loaded program containing the value's file
// (`selectScanFanout` — the same program selection, authority-first with the no-config fallback
// demoted, that the type-anchored scans use), because a sink living only in a SIBLING program
// (a `test/**` file under `tsconfig.test.json`, another package's app program) is invisible to one
// program's `getReferencesAtPosition` — and the trace then reads as "the type never widens" where
// the truth is "we looked in one program" (§3.6). Three invariants make the fan sound:
//   · the value's type is RE-RESOLVED in each program and each program's references are judged by
//     its OWN checker — a widening verdict is invalid across checkers;
//   · a reference two programs both surface is CLAIMED by the first in fan order, so the checked
//     surface is the UNION, not the sum;
//   · the endpoint (`view.node` and its `typeText`) comes from the AUTHORITY alone. Not cosmetic:
//     the op's walk keys its `visited` set off that label, so two programs printing one value's type
//     differently would expand it twice and double-count `widenings`. A sink judged by a non-
//     authority program carries that program's label instead.
// Bounded (§1/§19): ONE `REF_SCAN_CAP` budget across the whole fan, spent ROUND-ROBIN so a large
// primary cannot starve a sibling to zero, plus a `Deadline` poll at the program and reference
// boundary. The scope is reported POSITIVELY, per program (`coverage`) — a bare `examined:` count
// with no denominator is what let a one-package scan read as a repo scan (t-919920).
//
// THE CONTEXTUAL-TYPING TRAP (a silent-zero-hops bug avoided BY DESIGN, not exercised by a test):
// the source type is read at the value's OWN declaration (`getTypeOfSymbolAtLocation(symbol, decl)`),
// NEVER at a use site — at a call-arg slot `getTypeAtLocation` returns the CONTEXTUAL (already-widened)
// param type, so a fresh inline literal would look "already string" and no widening would be reported.
// For this op's input domain (NAMED value / parameter targets) the declaration-site and use-site types
// coincide, so the choice is sound by construction; the §16 fixtures discriminate the classifier, not
// this trap. The sink type is the sink declaration's own type; the comparison is src-at-its-decl vs
// sink-at-its-decl.

import type ts from 'typescript';
import type { Deadline } from '../../common/async/deadline.ts';
import { roundRobin } from '../../common/iter/round-robin.ts';
import { nodeAt } from './ast-node.ts';
import type { TsProjectHost } from './ls-host.ts';
import { selectScanFanout } from './program/scan-fanout.ts';
import { resolveSink, spanOf, typeStr } from './type-widening-sink.ts';
import type {
  SkippedWideningProgram,
  WideningEndpoint,
  WideningProgramCoverage,
  WideningSink,
  WideningSinksView,
} from './type-widening-view.ts';

const REF_SCAN_CAP = 50; // forward references examined per step across the WHOLE fan (§1)

/** One program that resolved the value — its checker, its own source type, its label. */
interface ResolvedProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  srcType: ts.Type;
  /** How this program types the value — compared against the authority's to disclose a divergence. */
  srcText: string;
  label: string;
}

/** One forward reference, bound to the program that surfaced it (and will judge it). */
interface RefCandidate {
  fileName: string;
  start: number;
  slot: number;
}

/** One forward step from the value at `{abs, offset}`: its own type, and every immediate flow-sink
 *  with a widening verdict, fanned across the programs containing `abs`. A `string` when no program
 *  in the fan resolves a value there (an honest "couldn't", never an empty answer shaped like a
 *  proven absence — §3.6). */
export function collectWideningSinks(
  host: TsProjectHost,
  abs: string,
  offset: number,
  deadline?: Deadline,
): WideningSinksView | string {
  const fanout = selectScanFanout(host, abs);
  const resolved: ResolvedProgram[] = [];
  const per: WideningProgramCoverage[] = [];
  const skipped: SkippedWideningProgram[] = [];
  const queues: RefCandidate[][] = [];
  const claimed = new Set<string>();
  let endpoint: WideningEndpoint | undefined;

  for (const entry of fanout.fan) {
    // §19 loop boundary #1 — the PROGRAM loop: `getProgram()` warms a checker, so without this poll
    // the first deadline check would come only after every program in the fan was built. A fan cut
    // short is a DIFFERENT fact from a reference set cut short, so it is recorded as its own reason.
    if (deadline?.expired() === true) {
      skipped.push({ label: entry.label, reason: 'deadline' });
      continue;
    }
    const program = entry.getProgram();
    const sf = program?.getSourceFile(abs);
    if (program === undefined || sf === undefined) {
      skipped.push({ label: entry.label, reason: 'program-unavailable' });
      continue;
    }
    const checker = program.getTypeChecker();
    const node = nodeAt(sf, offset);
    const symbol = node === undefined ? undefined : checker.getSymbolAtLocation(node);
    if (node === undefined || symbol === undefined) {
      // No value at this position under THAT program's own options. Skipping is right — judging its
      // references against a type the value does not have there would lie; claiming completeness
      // afterwards would too, so the skip is disclosed and demotes the answer.
      skipped.push({ label: entry.label, reason: 'no-value-here' });
      continue;
    }
    const srcType = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration ?? node);
    const srcText = typeStr(checker, srcType);
    endpoint ??= { span: spanOf(host, node), label: symbol.getName(), typeText: srcText };
    const slot = resolved.length;
    resolved.push({ program, checker, srcType, srcText, label: entry.label });
    const queue = claimRefs(entry.service, abs, offset, slot, claimed);
    per.push({ label: entry.label, refs: queue.length, examined: 0 });
    queues.push(queue);
  }

  if (endpoint === undefined || resolved.length === 0) {
    // A deadline-emptied fan establishes NOTHING about the value — reporting "no value here" would
    // convert a "couldn't" into a finding (§3.6), so the two misses carry different messages and
    // both are failures, never an `ok` shaped like a proven absence.
    return skipped.some((s) => s.reason === 'deadline')
      ? 'the wall-clock budget expired before any program in the fan could be consulted — nothing about this value was established'
      : 'no symbol at the resolved position — point at a value (variable / parameter)';
  }

  const sinks: WideningSink[] = [];
  const authorityLabel = resolved[0]?.label;
  let examined = 0;
  let capped = false;
  let deadlineHit = false;
  for (const candidate of roundRobin(queues)) {
    // §19 loop boundary #2: the sinks found ARE real data, so an overrun degrades to a disclosed
    // partial step, never a spin and never a failure that throws them away.
    if (deadline?.expired() === true) {
      deadlineHit = true;
      break;
    }
    if (examined >= REF_SCAN_CAP) {
      capped = true;
      break;
    }
    const owner = resolved[candidate.slot];
    const tally = per[candidate.slot];
    if (owner === undefined || tally === undefined) continue;
    examined++;
    tally.examined++;
    const refSf = owner.program.getSourceFile(candidate.fileName);
    const refNode = refSf === undefined ? undefined : nodeAt(refSf, candidate.start);
    if (refNode === undefined) continue;
    const sink = resolveSink(host, owner.checker, refNode, owner.srcType);
    if (sink === undefined) continue;
    sinks.push(
      owner.label === authorityLabel
        ? sink
        : {
            ...sink,
            program: owner.label,
            // Disclosed only on a real divergence: this program's own view of the SOURCE type is
            // what the verdict compared, so where two configs type one value differently the hop
            // must not print the authority's label as though it were the compared type.
            ...(owner.srcText === endpoint.typeText ? {} : { srcTypeText: owner.srcText }),
          },
    );
  }

  return {
    node: endpoint,
    sinks,
    ...(capped
      ? {
          truncated: {
            shown: examined,
            total: claimed.size,
            // The denominator counts only the programs we consulted, so an unconsulted program
            // makes it a floor — rendered `≥N`, never as an exact total (§12).
            ...(skipped.length > 0 ? { totalIsLowerBound: true as const } : {}),
          },
        }
      : {}),
    coverage: {
      programs: per,
      refs: claimed.size,
      examined,
      limit: REF_SCAN_CAP,
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(fanout.fallbackOnly ? { fallbackOnly: true as const } : {}),
      ...(fanout.excludedFallback !== undefined ? { fallbackExcluded: true as const } : {}),
      ...(deadlineHit ? { deadlineHit: true as const } : {}),
    },
  };
}

/** This program's forward references to the value, minus its own declaration site and anything a
 *  program earlier in the fan already claimed — so the checked surface is the UNION of the fan's
 *  reference sets, and the expensive per-reference analysis runs once per site. */
function claimRefs(
  service: ts.LanguageService,
  abs: string,
  offset: number,
  slot: number,
  claimed: Set<string>,
): RefCandidate[] {
  const queue: RefCandidate[] = [];
  for (const ref of service.getReferencesAtPosition(abs, offset) ?? []) {
    if (ref.fileName === abs && ref.textSpan.start === offset) continue; // the value's own decl
    if (ref.fileName.includes('/node_modules/')) continue;
    const key = `${ref.fileName}|${ref.textSpan.start}`;
    if (claimed.has(key)) continue;
    claimed.add(key);
    queue.push({ fileName: ref.fileName, start: ref.textSpan.start, slot });
  }
  return queue;
}
