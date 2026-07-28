// `find_unused_scss_classes` — the cross-tier compound op (§5-L3): scss class
// declarations minus the usages the ts plugin observed. The op IS the join — no
// shared store. Dynamic access in an importer demotes that module's claims to
// `partial` (§3.3: dynamic is flagged, never bridged).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { fail, failFromThrown, ok } from '../common/result/construct.ts';
import { semanticFanoutRefusal } from './guard/semantic-fanout-guard.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { SECTIONED_KEY } from '../format/render/shapes/meta-keys.ts';
import type { ScssPluginApi, UnusedClassView } from '../plugins/scss/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

/** Project unused-class rows (§3). A class whose importer used computed access is
 *  demoted to `partial` with a `note`, never dropped; modules excluded wholesale by
 *  dynamic access surface as an envelope note so the SQL answer never reads as complete. */
const findUnusedScssClassesTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'name', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'col', type: 'int' },
    { name: 'confidence', type: 'text' },
    { name: 'note', type: 'text' },
  ],
  rows(data) {
    const unused = (data as { unused?: UnusedClassView[] }).unused ?? [];
    return unused.map((c): readonly Cell[] => [
      c.name,
      c.file,
      c.span.line,
      c.span.col,
      c.confidence,
      c.note ?? null,
    ]);
  },
  notes(data) {
    const out: string[] = [];
    const dynamicModules = (data as { dynamicModules?: string[] }).dynamicModules ?? [];
    if (dynamicModules.length > 0) {
      out.push(
        `${dynamicModules.length} module(s) with computed class access — their classes cannot be proven unused: ${dynamicModules.join(', ')}`,
      );
    }
    const globalModules = (data as { globalModules?: string[] }).globalModules ?? [];
    if (globalModules.length > 0) {
      out.push(
        `${globalModules.length} global (non-.module.*) stylesheet(s) with class(es) not found in any JSX className/clsx literal — may be applied via HTML/DOM/dynamic string, cannot be proven unused: ${globalModules.join(', ')}`,
      );
    }
    return out;
  },
};

export const findUnusedScssClassesOp = defineOp({
  name: 'find_unused_scss_classes',
  summary:
    'SCSS/CSS classes with no usage observed in TS/TSX (css-module `s.foo` + global string `className`/clsx literals); dynamic access + unmatched global classes demote to partial',
  mutating: false,
  requires: ['ts', 'scss'],
  argsSchema: z.strictObject({
    pathInclude: z.array(z.string()).optional(),
    pathExclude: z.array(z.string()).optional(),
    /** Bypass the in-process semantic-fanout size guard (t-679091) and warm anyway. */
    force: z.boolean().optional(),
  }),
  argsHint: '{ pathInclude?: string[], pathExclude?: string[] }',
  example: { args: { pathInclude: ['src/features/**'] } },
  notes: [
    'the reachability join reads TS-side imports + member accesses through the ts plugin, so it warms the checker over the whole program: on an oversized IN-PROCESS repo (> `ts.searchWarmMaxFiles`, default 4000 source files) this op REFUSES to warm (it would OOM and can kill the daemon) and says WHY the repo was not auto-escalated into a killable child (t-754922) plus the one remedy for that cause. `force:true` does NOT override it (forcing killed the daemon in production). No refusal in an escalated / configured process-mode child.',
    'a class reached only via dynamic access (styles[expr]) demotes to partial — flagged "could not prove dead", never reported as definitely unused.',
    'only css-MODULE sheets (`.module.scss`/`.module.css`/`.module.sass`, accessed as `s.foo`) can read `certain` unused. A flat/global `.scss`/`.css`/`.sass` is applied via string `className="foo"` (resolved: JSX className + clsx/classnames literals); a class matched there is dropped, but one NOT matched stays partial ("may be applied via HTML/DOM/dynamic string, cannot prove dead") — never certain.',
    'pathInclude/pathExclude (globs over the .scss path) scope which stylesheets are REPORTED on (the whole-repo answer caps fast — narrow it); scanned.modules/classes reflect the scope. Cross-sheet composes: reachability is still resolved over every sheet, so scoping never invents a dead class an excluded sheet keeps alive.',
  ],
  table: findUnusedScssClassesTable,
  async run(ctx, args) {
    const scss = ctx.plugins.get<ScssPluginApi>('scss');
    // STOPGAP (t-820448) — the t-679091 pre-warm guard on an op that was left ungated. The op is
    // scss-FACING but ts-BACKED: the class-reachability join asks the ts plugin for imports + member
    // accesses repo-wide, which warms the checker over the whole program (measured: OOMs a 1 GB
    // engine on a ~6.1k-file repo) and in-process that kills the daemon uncatchably. `requires`
    // already names ts, so the plugin is always active here — no ownership predicate needed (unlike
    // `list`). Stated lifetime: this call goes away (or is re-derived) once the auto-escalate-
    // oversized-repo-to-process-mode path lands and the guard's "refuse in-process" semantics become
    // "route to a killable child".
    const refusal = semanticFanoutRefusal(ctx, ctx.plugins.get<TsPluginApi>('ts'), args.force, {
      op: 'find_unused_scss_classes',
      args,
    });
    if (refusal !== undefined) return fail(refusal);
    try {
      const view = scss.unusedClasses({
        ...(args.pathInclude !== undefined ? { pathInclude: args.pathInclude } : {}),
        ...(args.pathExclude !== undefined ? { pathExclude: args.pathExclude } : {}),
      });
      const failures = [...scss.parseFailures()].map(([file, message]) => ({ file, message }));
      // A class whose module is named in the dynamicModules/globalModules section carries a per-row
      // note that merely restates that section — mark it `~sectioned` so the renderer drops the echo
      // (the note stays in data: json/sql unchanged).
      const sectioned = new Set<string>([...view.dynamicModules, ...view.globalModules]);
      return ok({
        unused: view.unused.map((c) =>
          tag('scss-class', sectioned.has(c.file) ? { ...c, [SECTIONED_KEY]: true } : c),
        ),
        scanned: { modules: view.scannedModules, classes: view.scannedClasses },
        ...(view.dynamicModules.length > 0 ? { dynamicModules: view.dynamicModules } : {}),
        ...(view.globalModules.length > 0 ? { globalModules: view.globalModules } : {}),
        ...(failures.length > 0
          ? { parseFailures: failures.map((f) => tag('parse-failure', f)) }
          : {}),
      });
    } catch (thrown) {
      return failFromThrown('scss', thrown);
    }
  },
});
