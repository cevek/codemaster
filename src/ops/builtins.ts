// The built-in op catalogue — the single source of truth for which ops ship by default.
// The CLI entry (`bin.ts`), the test harness (`test/helpers/project.ts`), and the
// anti-drift test (§1.1) all import this one list, so a newly added op can never silently
// skip the catalogue or the example-validation check.

import type { AnyOpDefinition } from './registry.ts';
import { searchSymbolOp } from './search-symbol.ts';
import { findDefinitionOp } from './find-definition.ts';
import { findUsagesOp } from './find-usages.ts';
import { expandTypeOp } from './expand-type.ts';
import { constructionSitesOp } from './construction-sites.ts';
import { discriminationSitesOp } from './discrimination-sites.ts';
import { memberUsagesOp } from './member-usages.ts';
import { sourceOp } from './source.ts';
import { scssClassesOp } from './scss-classes.ts';
import { cssCascadeOp } from './css-cascade.ts';
import { importersOfOp } from './importers-of.ts';
import { findUnusedExportsOp } from './find-unused-exports.ts';
import { findUnusedPropsOp } from './find-unused-props.ts';
import { findUnusedScssClassesOp } from './find-unused-scss-classes.ts';
import { i18nLookupOp } from './i18n-lookup.ts';
import { findUnusedI18nKeysOp } from './find-unused-i18n-keys.ts';
import { findMissingI18nKeysOp } from './find-missing-i18n-keys.ts';
import { listEndpointsOp } from './list-endpoints.ts';
import { listOp } from './list.ts';
import { listSymbolsOp } from './list-symbols.ts';
import { renameSymbolOp } from './rename-symbol.ts';
import { moveFileOp } from './move-file.ts';
import { moveSymbolOp } from './move-symbol.ts';
import { extractSymbolOp } from './extract-symbol.ts';
import { changeSignatureOp } from './change-signature.ts';
import { codemodOp } from './codemod.ts';
import { transactionOp } from './transaction.ts';
import { impactOp } from './impact.ts';
import { impactTypeErrorOp } from './impact-type-error.ts';
import { affectedOp } from './affected.ts';
import { invalidationsForOp } from './react-query-invalidations-for.ts';
import { traceInvalidationOp } from './trace-invalidation.ts';
import { traceTypeWideningOp } from './trace-type-widening.ts';
import { tracePropThroughTreeOp } from './trace-prop-through-tree.ts';
import { traceFieldToRenderOp } from './trace-field-to-render.ts';
import { feedbackOp } from './feedback.ts';

export function builtinOps(): readonly AnyOpDefinition[] {
  return [
    searchSymbolOp,
    findDefinitionOp,
    findUsagesOp,
    expandTypeOp,
    constructionSitesOp,
    discriminationSitesOp,
    memberUsagesOp,
    sourceOp,
    importersOfOp,
    findUnusedExportsOp,
    findUnusedPropsOp,
    scssClassesOp,
    cssCascadeOp,
    findUnusedScssClassesOp,
    i18nLookupOp,
    findUnusedI18nKeysOp,
    findMissingI18nKeysOp,
    listEndpointsOp,
    listOp,
    listSymbolsOp,
    renameSymbolOp,
    moveFileOp,
    moveSymbolOp,
    extractSymbolOp,
    changeSignatureOp,
    codemodOp,
    transactionOp,
    impactOp,
    impactTypeErrorOp,
    affectedOp,
    invalidationsForOp,
    traceInvalidationOp,
    traceTypeWideningOp,
    tracePropThroughTreeOp,
    traceFieldToRenderOp,
    feedbackOp,
  ];
}
