// `expand_type` — the LS's resolved type + docs at a symbol, PLUS a structural view:
// object members (name/optional/type/inherited) or union/intersection constituents, so
// expanding an interface returns its fields rather than just `interface X` (§3.3).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { tsTargetShape, requireTarget, tsTargetIntake } from './ts-target.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { MemberView } from '../plugins/ts/query-types.ts';
import { defineOp } from './registry.ts';
import { TS_TARGET_HINT } from './ts-target.ts';

/** Tag each expanded member 'type-member', recursing into nested members (depth>1) so a member
 *  WITH sub-members collapses too instead of exploding into a key=value block. */
function tagMembers(members: readonly MemberView[]): JsonValue[] {
  return members.map((m) =>
    tag('type-member', {
      ...m,
      ...(m.members !== undefined ? { members: tagMembers(m.members) } : {}),
    }),
  );
}

const argsSchema = z
  .strictObject({
    ...tsTargetShape,
    /** How deep to expand anonymous object-literal members (1 = top level only). */
    depth: z.number().int().min(1).max(3).optional(),
    /** Max members listed per object before the rest are summarized honestly. */
    memberLimit: z.number().int().positive().max(200).optional(),
  })
  .refine(requireTarget.predicate, { message: requireTarget.message });

export const expandTypeOp = defineOp({
  name: 'expand_type',
  summary:
    'Resolved type + docs of a symbol, with structural members / constituents (deep, from the live checker)',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: `${TS_TARGET_HINT} — plus { depth?: 1-3 (default 1), memberLimit?: number (default 40; uncapped at verbosity:full) }`,
  intake: tsTargetIntake,
  example: {
    args: { symbolId: 'ts:Engine@src/daemon/engine.ts:70:7' },
    flags: { verbosity: 'full' },
  },
  notes: [
    'object types list members (name/optional/type, inherited flagged); unions/intersections list constituents; enums list members.',
    'depth (1-3) expands nested anonymous object literals; verbosity:full lists ALL members (the default 40-cap is lifted) AND lifts the per-signature/member-type length cap; an explicit memberLimit caps the list and the overflow rides the truncated channel, never silently dropped.',
    'a signature/member-type longer than the per-string cap is cut with an explicit `… (signature|type elided: N chars — verbosity:full[, or expand_type the param type])` marker reporting the full length + recovery (never a silent `…`, §3.4); verbosity:full lifts the cap (bounded, so the marker still fires before the render cap on a pathological type).',
  ],
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      // `full` means COMPLETE (§3.4): lift the default 40-cap so no member is dropped — the
      // RENDER_CHAR_CAP `!! OUTPUT CAPPED` is the honest size backstop, and enumeration is finite
      // (bounded by the type). An EXPLICIT `memberLimit` is a deliberate cap and always wins, even
      // at full — its overflow then rides `Result.truncated` (below), never a soft note.
      const full = ctx.flags.verbosity === 'full';
      const memberLimit = args.memberLimit ?? (full ? Number.POSITIVE_INFINITY : 40);
      // The per-string length cap is selected by verbosity inside the `expand-type-*` CapId
      // descriptors (common/truncate): the default cap, lifted at `full` to a large FINITE bound
      // (never Infinity — §1/§12: the per-item `(… elided)` marker must fire before the blunt
      // RENDER_CHAR_CAP so a pathological type stays bounded and keeps its precise marker).
      const outcome = ts.expandType(args, {
        depth: args.depth ?? 1,
        memberLimit,
        verbosity: ctx.flags.verbosity ?? 'normal',
      });
      if (typeof outcome === 'string') return fail({ tool: 'ts-ls', message: outcome });
      if ('unresolved' in outcome) {
        // §6: the held handle's symbol is gone — state it structurally on `handle`.
        return fail({ tool: 'ts-ls', message: outcome.unresolved }, { handle: outcome.rebind });
      }
      const view = outcome.view;
      // The name-token `span` is a LOCATION, not a proof body (the type text / signatures / members
      // carry the proof). Left as a raw top-level Span it passes verbatim at `full` (§12 raw-span
      // passthrough) and render-dense explodes it into a `file=/line=/col=` block — pure water for a
      // single-symbol lookup. Project it to a clickable `at` loc IN PLACE (so insertion order — the
      // §12 verdict-before-bulk contract — is preserved: `about`/`type` lead, `members` stays bulk-
      // last), tagging members where they sit; everything else untouched.
      const out: Record<string, JsonValue> = {};
      for (const [k, val] of Object.entries(view)) {
        if (k === 'span') {
          if (view.span !== undefined)
            out['at'] = `${view.span.file}:${view.span.line}:${view.span.col}`;
        } else if (k === 'members') {
          if (view.members !== undefined) out['members'] = tagMembers(view.members);
        } else if (k === 'membersTruncated') {
          // Rides the envelope's `Result.truncated` channel (below), not `data` — so a count-only
          // consumer sees the incompleteness; drop it from the projected data.
        } else {
          out[k] = val as JsonValue;
        }
      }
      // The member-list cap is the honest truncation channel (§3.4), never a soft `notes` line: a
      // structured `{shown,total}` that renders into the reserved tail AND survives `format:'json'`.
      const cap = view.membersTruncated;
      const truncated =
        cap !== undefined
          ? {
              shown: cap.shown,
              total: cap.total,
              hint: full
                ? 'raise memberLimit for the complete member list'
                : 'raise memberLimit or use verbosity:full for the complete member list',
            }
          : undefined;
      return ok(out, {
        ...(outcome.rebind !== undefined ? { handle: outcome.rebind } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
      });
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
