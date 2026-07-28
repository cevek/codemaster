// t-615758 — the one place a NAVIGATIONAL refusal is assembled, so the failure's machine-readable
// claim and its prose cannot disagree.
//
// A refusal carries two statements about the same thing: `ToolFailure.outOfReach` (what the caller
// may still try) and the redirect inside `message` (what to run instead). Built independently they
// drift, and the drift is not cosmetic — that is exactly how a refusal came to print the caller the
// very call that had just died. Here the redirect is rendered FROM the failure's own `outOfReach`,
// which makes agreement structural rather than something a test has to keep checking.
//
// Message shape is fixed: `<head> <redirect> <tail>`. `head` is the verdict (§12 verdict-first),
// the redirect is the only part the agent can act on, and `tail` is the producer's own remaining
// clause — the CAUSE (needs access the caller may not have) or the one escape specific to that
// producer ("narrow the query", "force:true"). The redirect never carries a producer's remedy: it
// names calls, and only calls (navigate.ts).
//
// Two entry points, because there are two authorities for "which op is refusing", and neither may
// be a parameter the other could fill wrongly (t-166631):
//   * `opRefusal` — inside an op's `run()`: the name comes ONLY from `ctx.opName`, stamped by the
//     dispatcher off the `OpDefinition` it dispatched. No op-name parameter exists to mistype.
//   * `wireRefusal` — the daemon failing requests whose op never ran (`process-host`): there is no
//     OpDefinition on that path, and the name of the request being failed is the only authority.

import type { OutOfReach, ToolFailure } from '../../core/result.ts';
import type { OpContext } from '../registry.ts';
import { navigationFor } from './navigate.ts';

/** The producer-supplied parts. `head` ends with its own terminator; `tail` is appended after the
 *  redirect and may be empty. */
export interface RefusalText {
  /** Which internal tool / gate is refusing, e.g. 'size-guard', 'oom', 'timeout'. */
  readonly tool: string;
  /** What this failure puts beyond reach — and, by that, which calls the redirect may name. */
  readonly outOfReach: OutOfReach;
  /** The op's args, so the redirect can be addressed to the question actually asked. */
  readonly args: unknown;
  /** Verdict clause, first (§12): what happened and why. Includes its own terminating period. */
  readonly head: string;
  /** Trailing clause: the cause, or the producer's own escape. Empty when it has neither. */
  readonly tail?: string;
}

function assemble(op: string, text: RefusalText): ToolFailure {
  // The claim is fixed FIRST; the prose is then derived from it. Not two reads of the producer's
  // input — one field, and a message that can only ever describe that field.
  const claim: Required<Pick<ToolFailure, 'tool' | 'outOfReach'>> = {
    tool: text.tool,
    outOfReach: text.outOfReach,
  };
  const tail = text.tail === undefined || text.tail === '' ? '' : ` ${text.tail}`;
  return {
    ...claim,
    message: `${text.head} ${navigationFor(op, text.args, claim.outOfReach)}${tail}`,
  };
}

/** A refusal from inside an op. The refusing op is `ctx.opName` and cannot be anything else. */
export function opRefusal(ctx: Pick<OpContext, 'opName'>, text: RefusalText): ToolFailure {
  return assemble(ctx.opName, text);
}

/** A refusal for a request the daemon is failing before/without the op running — the op name comes
 *  off the wire request being failed, the only thing that identifies it there. */
export function wireRefusal(requestName: string, text: RefusalText): ToolFailure {
  return assemble(requestName, text);
}
