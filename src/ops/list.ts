// `list` — the GENERIC registry dispatcher (§11). It owns no domain knowledge: it
// enumerates the registries the active plugins expose (`Plugin.listRegistries`, §5-L2),
// routes a `list {registry}` call to the owning plugin's `list(registry)`, and projects
// the proof-carrying entries. A framework plugin contributes registries by implementing
// the two optional `Plugin` members — NO edit to this op (the react / react-query tracks
// plug in the same way). `requires: []` — the op is always in the catalogue; a registry
// that no active plugin owns returns the honest available-list, never a guess (§3.6).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Plugin } from '../core/plugin.ts';
import type { ListEntry, ListView } from '../core/list.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

/** Display form of a composite key (`['todos', <dynamic>]` → `todos / <dyn>`) or a plain
 *  name. A dynamic segment is shown as `<dyn>`, never a guessed literal (§3.3). */
function keyDisplay(entry: {
  name?: string;
  segments?: readonly { value?: string; dynamic: boolean }[];
}): string {
  if (entry.name !== undefined) return entry.name;
  const segs = entry.segments ?? [];
  return `[${segs.map((s) => (s.dynamic ? '<dyn>' : (s.value ?? '?'))).join(', ')}]`;
}

/** Compact provenance display, e.g. `heuristic:react`. */
function provDisplay(p: { kind: string; by?: string }): string {
  return p.by !== undefined ? `${p.kind}:${p.by}` : p.kind;
}

/** A JsonValue-safe projection of one `ListEntry` (the core contract carries optional
 *  fields whose `undefined` is not a `JsonValue` — omitted via conditional spread). */
function serializeEntry(e: ListEntry): JsonValue {
  return {
    key: keyDisplay(e),
    kind: e.kind,
    confidence: e.confidence,
    provenance: provDisplay(e.provenance),
    file: e.span.file,
    line: e.span.line,
    col: e.span.col,
    ...(e.name !== undefined ? { name: e.name } : {}),
    ...(e.segments !== undefined
      ? {
          segments: e.segments.map((s) => ({
            dynamic: s.dynamic,
            ...(s.value !== undefined ? { value: s.value } : {}),
          })),
        }
      : {}),
    ...(e.detail !== undefined ? { detail: e.detail } : {}),
    proof: { ...e.span },
  };
}

interface ListRow {
  key: string;
  kind: string;
  name?: string;
  file: string;
  line: number;
  col: number;
  confidence: string;
  provenance: string;
  detail?: string;
}

const listTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'key', type: 'text' },
    { name: 'kind', type: 'text' },
    { name: 'name', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'col', type: 'int' },
    { name: 'confidence', type: 'text' },
    { name: 'provenance', type: 'text' },
    { name: 'detail', type: 'text' },
  ],
  rows(data) {
    const entries = (data as { entries?: ListRow[] }).entries ?? [];
    return entries.map((e): readonly Cell[] => [
      e.key,
      e.kind,
      e.name ?? null,
      e.file,
      e.line,
      e.col,
      e.confidence,
      e.provenance,
      e.detail ?? null,
    ]);
  },
  notes(data) {
    const d = data as { found?: boolean; registry?: string; available?: string[]; note?: string };
    if (d.found === false) {
      const avail = (d.available ?? []).join(', ') || '(none — no registry-owning plugin active)';
      return [`no such registry '${d.registry ?? ''}' — available: ${avail}`];
    }
    return d.note !== undefined ? [d.note] : [];
  },
};

const argsSchema = z.strictObject({ registry: z.string() });

/** Discover every registry the active plugins own → a `registry → owner` map (first-wins;
 *  a duplicate claim is recorded so a collision is reported, never silently shadowed). */
function discover(
  ids: readonly string[],
  get: (id: string) => Plugin,
): {
  owners: Map<string, Plugin>;
  conflicts: string[];
} {
  const owners = new Map<string, Plugin>();
  const conflicts: string[] = [];
  for (const id of ids) {
    const plugin = get(id);
    for (const reg of plugin.listRegistries?.() ?? []) {
      const prior = owners.get(reg);
      if (prior === undefined) owners.set(reg, plugin);
      else
        conflicts.push(
          `registry '${reg}' claimed by both '${prior.id}' and '${id}' — using '${prior.id}'`,
        );
    }
  }
  return { owners, conflicts };
}

export const listOp = defineOp({
  name: 'list',
  summary:
    'List a named registry (components, hooks, dialogs, routes, queries, …) — routed to the owning plugin',
  mutating: false,
  requires: [],
  argsSchema,
  argsHint: '{ registry: string }',
  example: { args: { registry: 'components' } },
  notes: [
    'GENERIC dispatcher: the available registries depend on which plugins are active (a framework plugin contributes its own); `status` is not pre-loaded with them.',
    'an unknown or inactive registry returns the honest available-list, never a guessed result (§3.6).',
    'entries are proof-carrying (file:line + span); a framework-convention inference carries provenance `heuristic:<plugin>` and a confidence that reflects the underlying fact (a computed value reads `dynamic`, never asserted certain).',
  ],
  table: listTable,
  async run(ctx, args) {
    try {
      const { owners, conflicts } = discover(ctx.plugins.ids, (id) => ctx.plugins.get<Plugin>(id));
      const available = [...owners.keys()].sort();
      const owner = owners.get(args.registry);
      if (owner === undefined || owner.list === undefined) {
        return ok({
          registry: args.registry,
          found: false,
          available,
          entries: [],
          ...(conflicts.length > 0 ? { conflicts } : {}),
        });
      }
      const view: ListView = owner.list(args.registry);
      return ok(
        {
          registry: args.registry,
          found: true,
          owner: owner.id,
          available,
          entries: view.entries.map(serializeEntry),
          ...(view.note !== undefined ? { note: view.note } : {}),
          ...(conflicts.length > 0 ? { conflicts } : {}),
        },
        // Surface a plugin-reported cap on the canonical §3.4 envelope field, so the renderer
        // shows it and a sql producer marks its table `partial` — silent truncation reads as
        // completeness.
        view.truncation !== undefined ? { truncated: { ...view.truncation } } : undefined,
      );
    } catch (thrown) {
      return failFromThrown('list', thrown);
    }
  },
});
