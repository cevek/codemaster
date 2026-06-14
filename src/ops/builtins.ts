// The built-in op catalogue — the single source of truth for which ops ship by default.
// The CLI entry (`bin.ts`), the test harness (`test/helpers/project.ts`), and the
// anti-drift test (§1.1) all import this one list, so a newly added op can never silently
// skip the catalogue or the example-validation check.

import type { AnyOpDefinition } from './registry.ts';
import { searchSymbolOp } from './search-symbol.ts';
import { findDefinitionOp } from './find-definition.ts';
import { findUsagesOp } from './find-usages.ts';
import { expandTypeOp } from './expand-type.ts';
import { sourceOp } from './source.ts';
import { scssClassesOp } from './scss-classes.ts';
import { importersOfOp } from './importers-of.ts';
import { findUnusedScssClassesOp } from './find-unused-scss-classes.ts';
import { i18nLookupOp } from './i18n-lookup.ts';
import { findUnusedI18nKeysOp } from './find-unused-i18n-keys.ts';
import { findMissingI18nKeysOp } from './find-missing-i18n-keys.ts';
import { renameSymbolOp } from './rename-symbol.ts';
import { moveFileOp } from './move-file.ts';
import { extractSymbolOp } from './extract-symbol.ts';
import { changeSignatureOp } from './change-signature.ts';
import { codemodOp } from './codemod.ts';
import { feedbackOp } from './feedback.ts';

export function builtinOps(): readonly AnyOpDefinition[] {
  return [
    searchSymbolOp,
    findDefinitionOp,
    findUsagesOp,
    expandTypeOp,
    sourceOp,
    importersOfOp,
    scssClassesOp,
    findUnusedScssClassesOp,
    i18nLookupOp,
    findUnusedI18nKeysOp,
    findMissingI18nKeysOp,
    renameSymbolOp,
    moveFileOp,
    extractSymbolOp,
    changeSignatureOp,
    codemodOp,
    feedbackOp,
  ];
}
