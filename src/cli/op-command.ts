// argv → dispatchable request for the one-shot `codemaster op <name> …` path. Split out of
// `bin.ts` so the entry point stays a composition root, and so this surface's flags, its usage
// line, and its rejections are stated once, together.
//
// Every rejection here is LOUD (§3): an unrecognized flag, a known flag without a value, a stray
// positional, an out-of-enum value. Nothing is coerced to a default the caller never asked for,
// because a command that quietly runs on a different shape than it was given is the silent-swallow
// the intake contract forbids.

import type { OpRequest } from '../ops/contracts.ts';
import type { Verbosity } from '../core/result.ts';
import { enumFlag, flagIssue, flagValue, hasFlag } from './flags.ts';
import { nonOpSurfaceMessage } from './compose.ts';

export const OP_USAGE =
  "usage: codemaster op <name> [json-args] [--root <dir>] [--format text|json] [--apply] [--summaryOnly] [--verbosity terse|normal|full] [--sql '<SELECT>'] [--return sql|all]\n";

const OP_VALUE_FLAGS = ['--root', '--format', '--verbosity', '--sql', '--return'];

export type OpCommandParse =
  | {
      ok: true;
      request: OpRequest;
      verbosity: Verbosity;
      format: 'text' | 'json' | undefined;
      /** Single-op sql sugar (§11), identical to the MCP per-op `sql` param: a read-only SELECT
       *  over this op's table aliased `t`. The producer runs UNCAPPED under it — that property
       *  belongs to the engine's sql path, which this only routes into. */
      sql: string | undefined;
      returnMode: 'sql' | 'all' | undefined;
    }
  | { ok: false; message: string };

export function parseOpCommand(args: string[]): OpCommandParse {
  const name = args.shift();
  if (name === undefined) return { ok: false, message: OP_USAGE };
  // `batch`/`status` are not ops — they are dispatched on their own (t-141874). "unknown op
  // 'batch'" would be true about this route and FALSE about the tool (§3.6), so name the form that
  // works here instead of listing the op catalogue.
  const nonOp = nonOpSurfaceMessage(name);
  if (nonOp !== undefined) return { ok: false, message: `${nonOp}\n` };

  const verbosity = enumFlag(flagValue(args, '--verbosity'), ['terse', 'normal', 'full']);
  if (verbosity === null) return bad("--verbosity must be 'terse', 'normal' or 'full'");
  // `--format json` mirrors the MCP `format` flag: json routes the envelope through the SAME
  // `renderResultJson` the MCP path uses (byte parity, no parallel serializer).
  const format = enumFlag(flagValue(args, '--format'), ['text', 'json']);
  if (format === null) return bad("--format must be 'text' or 'json'");
  // Mutating-op flags (§7): without these a CLI `op` could only ever dry-run, so a mutating op
  // can't be dogfooded from the CLI. Parsed (and spliced) BEFORE the positional JSON-args find.
  const apply = hasFlag(args, '--apply');
  const summaryOnly = hasFlag(args, '--summaryOnly');
  const sql = flagValue(args, '--sql');
  const returnMode = enumFlag(flagValue(args, '--return'), ['sql', 'all']);
  if (returnMode === null) return bad("--return must be 'sql' or 'all'");
  if (returnMode !== undefined && sql === undefined) return bad('--return applies only with --sql');

  // Every KNOWN flag is now spliced out; any residual `--`-token is unread input → reject before
  // the op runs, so a typo'd flag never yields a misleading "success" over unintended defaults.
  const issue = flagIssue(args, OP_VALUE_FLAGS);
  if (issue !== undefined) return bad(issue);
  // …so `args` holds only positionals. The op takes at most ONE (the JSON args); a second bareword
  // is stray input → reject LOUDLY, never drop it (§3, positional half — t-865108).
  if (args.length > 1) return bad(`unexpected argument(s): ${args.slice(1).join(', ')}`);
  let opArgs: unknown = {};
  const rawArgs = args[0];
  if (rawArgs !== undefined) {
    try {
      opArgs = JSON.parse(rawArgs);
    } catch {
      return { ok: false, message: `args is not valid JSON: ${rawArgs}\n` };
    }
  }
  const v = verbosity ?? 'terse';
  return {
    ok: true,
    // Verbosity rides the REQUEST, not just the render, so an op that shapes its DATA by density —
    // expand_type lifts its member cap at full (§3.4 completeness) — sees it in `ctx.flags`.
    request: {
      name,
      args: opArgs as never,
      apply,
      summaryOnly,
      verbosity: v,
      ...(format !== undefined ? { format } : {}),
    },
    verbosity: v,
    format,
    sql,
    returnMode,
  };
}

function bad(message: string): OpCommandParse {
  return { ok: false, message: `${message}\n${OP_USAGE}` };
}
