// The built-in op catalogue — the single source of truth for which ops ship by default.
// The CLI entry (`bin.ts`), the test harness (`test/helpers/project.ts`), and the
// anti-drift test (§1.1) all import this one list, so a newly added op can never silently
// skip the catalogue or the example-validation check.

import type { AnyOpDefinition } from './registry.ts';
import { searchSymbolOp } from './search-symbol.ts';
import { findDefinitionOp } from './find-definition.ts';
import { findUsagesOp } from './find-usages.ts';
import { expandTypeOp } from './expand-type.ts';
import { scssClassesOp } from './scss-classes.ts';
import { importersOfOp } from './importers-of.ts';
import { findUnusedScssClassesOp } from './find-unused-scss-classes.ts';

export function builtinOps(): readonly AnyOpDefinition[] {
  return [
    searchSymbolOp,
    findDefinitionOp,
    findUsagesOp,
    expandTypeOp,
    importersOfOp,
    scssClassesOp,
    findUnusedScssClassesOp,
  ];
}
