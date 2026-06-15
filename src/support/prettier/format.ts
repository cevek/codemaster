// Format one file's content with a resolved prettier, honestly. A file prettier declines
// to handle — `.prettierignore`d, an extension with no inferred parser, OR a project with no
// resolvable prettier config — returns `ok(null)` (a skip, not a failure): the touched file
// is still written, just unformatted. The no-config skip is deliberate: a repo that ships no
// prettier config hasn't opted into prettier's style, so running it (with defaults) would
// restyle the file against the project's intent. A broken `.prettierrc` / bad parser option
// becomes a `ToolFailure` (§3.6), never a throw that could kill a whole batch over one bad
// config (front-renamer's per-file isolation).

import type { Result } from '../../core/result.ts';
import { failFromThrown, ok } from '../../common/result/construct.ts';
import type { PrettierApi } from './resolve.ts';

/** Format `content` for the file at `absPath` using the project's resolved config.
 *  `ok(string)` = formatted source; `ok(null)` = prettier skipped this file; a
 *  `ToolFailure` (tool `'prettier'`) = the formatter errored on this file. Never throws. */
export async function formatContent(
  api: PrettierApi,
  absPath: string,
  content: string,
): Promise<Result<string | null>> {
  try {
    const info = await api.getFileInfo(absPath, { resolveConfig: true });
    if (info.ignored || info.inferredParser === null) return ok(null);
    // No resolvable prettier config → the project hasn't opted into prettier; skip rather
    // than impose prettier's defaults on a file the project never styled with it.
    const config = await api.resolveConfig(absPath);
    if (config === null) return ok(null);
    // `filepath` is load-bearing: prettier picks the parser AND per-file `.prettierrc`
    // overrides from it — without it a `.tsx` could be parsed as plain JS.
    const formatted = await api.format(content, { ...config, filepath: absPath });
    return ok(formatted);
  } catch (thrown) {
    return failFromThrown('prettier', thrown);
  }
}
