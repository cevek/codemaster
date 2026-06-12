// `feedback` — agents file bugs / wishes / friction in-band (spec-feedback-channel). The
// channel is an OP, not a "write a wish file" instruction: it travels with the MCP server
// into whatever repo the agent is in, and the daemon attaches context no instruction-
// following agent could assemble. One global, append-only markdown inbox on the user's
// machine; a human/triage agent reads it. Not mutating in the §7 sense — it never touches
// the inspected repo's tree; recording IS the action, so there is no `apply` flag.

import { z } from 'zod';
import * as path from 'node:path';
import type { JsonValue } from '../core/json.ts';
import type { Result } from '../core/result.ts';
import { fail, ok } from '../common/result/construct.ts';
import { jsonValueSchema } from '../common/json/value-schema.ts';
import { appendTextFile } from '../support/fs/append-file.ts';
import { defineOp } from './registry.ts';
import type { DaemonInfo } from './registry.ts';

const argsSchema = z.strictObject({
  kind: z.enum(['bug', 'wish', 'friction']),
  title: z.string().min(1).max(120, { message: 'title ≤ 120 chars — put specifics in detail' }),
  detail: z
    .string()
    .min(1)
    .max(4000, { message: "detail ≤ 4000 chars — summarize, don't paste a transcript" }),
  /** The call that failed, or the call you wish existed. */
  example: jsonValueSchema.optional(),
});

type FeedbackArgs = z.infer<typeof argsSchema>;

function inboxEntry(args: FeedbackArgs, d: DaemonInfo): string {
  const when = new Date(d.nowMs).toISOString();
  const plugins =
    d.plugins.length > 0 ? d.plugins.map((p) => `${p.id}@${p.version}`).join(',') : 'none';
  const example =
    args.example === undefined
      ? ''
      : `\n\`\`\`json example\n${JSON.stringify(args.example, null, 2)}\n\`\`\`\n`;
  const ops = d.opNames.length > 0 ? d.opNames.join(',') : 'none';
  // Leading blank line keeps blocks separated under append-only writes. `ops=` is the
  // catalogue at filing time — a "wish: op X" is triaged against what existed (§2).
  return (
    `\n## [${args.kind}] ${args.title} — ${when}\n\n` +
    `repo=${d.root} · cm=${d.version} · plugins=${plugins}\n` +
    `ops=${ops}\n\n` +
    `${args.detail}\n${example}`
  );
}

export const feedbackOp = defineOp({
  name: 'feedback',
  summary: 'File a bug / wish / friction note — recorded to the global codemaster inbox',
  mutating: false,
  requires: [],
  argsSchema,
  argsHint:
    "{ kind: 'bug'|'wish'|'friction', title: string, detail: string, example?: <any json> }",
  example: {
    args: {
      kind: 'wish',
      title: 'find_usages should accept a regex name',
      detail: 'wanted to match Use* hooks in one call; had to enumerate names instead.',
    },
  },
  notes: [
    'file it the moment you hit a bug, a missing capability, or a call that took several tries — that knowledge evaporates with the session otherwise.',
    'the daemon attaches timestamp/version/repo/plugins automatically; you supply only kind/title/detail (+ optional example call). Nothing else leaves the machine.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const d = ctx.daemon;
    if (d === undefined) {
      // The engine always supplies daemon context; its absence is an internal fault, not
      // something to fabricate around (§3.6).
      return fail({ tool: 'codemaster', message: 'feedback: no daemon context available' });
    }
    const inbox = path.join(d.stateDir, 'feedback', 'inbox.md');
    const written = appendTextFile(inbox, inboxEntry(args, d));
    if (!written.ok) return written;
    return ok({ recorded: true, at: inbox });
  },
});
