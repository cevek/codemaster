// The one "does this watcher event concern project source" predicate, shared by both watcher
// adapters. It reads a REPO-RELATIVE path: an absolute path under a same-named ancestor (a root at
// `/home/me/build/proj`) would match `build` on the root prefix and drop every event of the repo.

import * as path from 'node:path';
import { DEFAULT_IGNORED_FILES, hasIgnoredDirSegment } from '../fs/ignored-paths.ts';

/** `rel` is relative to the watched root, in either separator. A path outside the root (`..`)
 *  concerns no project file of this root. */
export function isIgnoredWatchPath(rel: string): boolean {
  const posix = rel.split(path.sep).join('/');
  if (posix === '..' || posix.startsWith('../')) return true;
  return hasIgnoredDirSegment(`${posix}/`) || DEFAULT_IGNORED_FILES.test(posix);
}
