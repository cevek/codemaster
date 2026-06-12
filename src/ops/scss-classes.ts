// `scss_classes` — list class declarations the scss plugin knows (optionally one
// file). Parse failures are reported alongside, never hidden (§3.6).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { ScssClassView, ScssPluginApi } from '../plugins/scss/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

/** Project class declarations (§3). `confidence` is `partial` for interpolated selectors
 *  (carried verbatim from the plugin — §19), never silently upgraded. */
const scssClassesTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'name', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'col', type: 'int' },
    { name: 'confidence', type: 'text' },
  ],
  rows(data) {
    const classes = (data as { classes?: ScssClassView[] }).classes ?? [];
    return classes.map((c): readonly Cell[] => [
      c.name,
      c.file,
      c.span.line,
      c.span.col,
      c.confidence,
    ]);
  },
};

const argsSchema = z.strictObject({ file: z.string().optional() });

export const scssClassesOp = defineOp({
  name: 'scss_classes',
  summary: 'SCSS class declarations across the workspace (or one stylesheet)',
  mutating: false,
  requires: ['scss'],
  argsSchema,
  argsHint: '{ file?: string }',
  example: { args: { file: 'src/button.module.scss' } },
  table: scssClassesTable,
  async run(ctx, args) {
    const scss = ctx.plugins.get<ScssPluginApi>('scss');
    try {
      const classes = scss.classes(args.file);
      const failures = [...scss.parseFailures()].map(([file, message]) => ({ file, message }));
      return ok({ classes, ...(failures.length > 0 ? { parseFailures: failures } : {}) });
    } catch (thrown) {
      return failFromThrown('postcss-scss', thrown);
    }
  },
});
