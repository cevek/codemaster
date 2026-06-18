// postcss and node fs embed the ABSOLUTE on-disk path in their error messages (postcss
// resolves a relative `from` against cwd; readFileSync echoes the joined path). Surfacing
// that to the agent leaks a machine-specific path AND breaks golden stability across
// machines (§12). We parse with an absolute `from` = `<root>/<rel>` (an accurate location,
// not a cwd-relative guess) and strip the `<root>/` prefix here so the message carries the
// repo-relative path the rest of codemaster speaks in.

import * as path from 'node:path';

/** Strip every occurrence of the leading `<root>/` from a tool/parse failure message. */
export function scrubRoot(root: string, message: string): string {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return message.split(prefix).join('');
}
