// Render-only META keys — `~`-prefixed, like `~shape`. An op stamps one on a row to pass the dense
// TEXT renderer a hint that suppresses a redundant echo a section/header already states. json/sql
// stay byte-identical: stripShapeTags drops every `~`-key from the json copy and the sql projector
// reads only explicit columns — so the dedup lives in the renderer, never at the cost of the row's
// data (the field stays; only its echo is hidden). Ops import from format (downward) to stamp these;
// the matching renderer reads them.

/** css_cascade: the cascade TARGET (class/selector subject, no leading dot). The decl-ref renderer
 *  shows a selector SUFFIX only when it differs from `.${subject}` (`:hover`, `.active`), never a
 *  redundant `.target =` on every winner/loser line. */
export const SUBJECT_KEY = '~subject';

/** find_unused_scss_classes: this class's module is already named in the `dynamicModules` /
 *  `globalModules` envelope section, so its per-row note duplicates that — hidden in text. */
export const SECTIONED_KEY = '~sectioned';

/** find_missing_i18n_keys: every usage misses the SAME locale set, hoisted to a header note — so
 *  the per-row `· missing in […]` is hidden in text. */
export const HIDE_MISSING_KEY = '~hideMissing';

/** find_unused_i18n_keys: a global demote already states every claim is `partial` (envelope note),
 *  so the per-row `· partial` confidence tail is hidden in text. */
export const HIDE_CONF_KEY = '~hideConf';
