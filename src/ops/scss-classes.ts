// `scss_classes` — list class declarations the scss plugin knows (optionally one
// file). Parse failures are reported alongside, never hidden (§3.6).

import { z } from 'zod';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { ScssPluginApi } from '../plugins/scss/plugin.ts';
import { defineOp } from './registry.ts';

const argsSchema = z.strictObject({ file: z.string().optional() });

export const scssClassesOp = defineOp({
  name: 'scss_classes',
  summary: 'SCSS class declarations across the workspace (or one stylesheet)',
  mutating: false,
  requires: ['scss'],
  argsSchema,
  argsHint: '{ file?: string }',
  example: `op({name:'scss_classes', args:{file:'src/button.module.scss'}})`,
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
