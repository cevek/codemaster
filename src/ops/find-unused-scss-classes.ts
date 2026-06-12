// `find_unused_scss_classes` — the cross-tier compound op (§5-L3): scss class
// declarations minus the usages the ts plugin observed. The op IS the join — no
// shared store. Dynamic access in an importer demotes that module's claims to
// `partial` (§3.3: dynamic is flagged, never bridged).

import { z } from 'zod';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { ScssPluginApi } from '../plugins/scss/plugin.ts';
import { defineOp } from './registry.ts';

export const findUnusedScssClassesOp = defineOp({
  name: 'find_unused_scss_classes',
  summary:
    'SCSS classes with no usage observed in TS/TSX (css-modules); dynamic access demotes to partial',
  mutating: false,
  requires: ['ts', 'scss'],
  argsSchema: z.strictObject({}),
  argsHint: '{}',
  example: `op({name:'find_unused_scss_classes', args:{}})`,
  async run(ctx, _args) {
    const scss = ctx.plugins.get<ScssPluginApi>('scss');
    try {
      const view = scss.unusedClasses();
      const failures = [...scss.parseFailures()].map(([file, message]) => ({ file, message }));
      return ok({
        unused: view.unused,
        scanned: { modules: view.scannedModules, classes: view.scannedClasses },
        ...(view.dynamicModules.length > 0 ? { dynamicModules: view.dynamicModules } : {}),
        ...(failures.length > 0 ? { parseFailures: failures } : {}),
      });
    } catch (thrown) {
      return failFromThrown('scss', thrown);
    }
  },
});
