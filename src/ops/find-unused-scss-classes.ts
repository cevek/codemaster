// `find_unused_scss_classes` — the cross-tier compound op (§5-L3): scss class
// declarations minus the usages the ts plugin observed. The op IS the join — no
// shared store. Dynamic access in an importer demotes that module's claims to
// `partial` (§3.3: dynamic is flagged, never bridged).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
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
        `${globalModules.length} global (non-.module.*) stylesheet(s) — string classNames are unchecked, so their classes cannot be proven unused: ${globalModules.join(', ')}`,
      );
    }
    return out;
  },
};

export const findUnusedScssClassesOp = defineOp({
  name: 'find_unused_scss_classes',
  summary:
    'SCSS/CSS classes with no usage observed in TS/TSX (css-modules); dynamic access + global (non-.module.*) sheets demote to partial',
  mutating: false,
  requires: ['ts', 'scss'],
  argsSchema: z.strictObject({
    pathInclude: z.array(z.string()).optional(),
    pathExclude: z.array(z.string()).optional(),
  }),
  argsHint: '{ pathInclude?: string[], pathExclude?: string[] }',
  example: { args: { pathInclude: ['src/features/**'] } },
  notes: [
    'a class reached only via dynamic access (styles[expr]) demotes to partial — flagged "could not prove dead", never reported as definitely unused.',
    'only css-MODULE sheets (`.module.scss`/`.module.css`/`.module.sass`, accessed as `s.foo`) can read `certain` unused. A flat/global `.scss`/`.css`/`.sass` is referenced via string `className="foo"` codemaster cannot resolve, so its classes demote to partial ("global stylesheet — string classNames unchecked").',
    'pathInclude/pathExclude (globs over the .scss path) scope which stylesheets are REPORTED on (the whole-repo answer caps fast — narrow it); scanned.modules/classes reflect the scope. Cross-sheet composes: reachability is still resolved over every sheet, so scoping never invents a dead class an excluded sheet keeps alive.',
  ],
  table: findUnusedScssClassesTable,
  async run(ctx, args) {
    const scss = ctx.plugins.get<ScssPluginApi>('scss');
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
