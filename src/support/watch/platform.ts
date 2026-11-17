// The production watcher choice (§8, §19): one recursive native watch where the OS provides it
// cheaply (macOS FSEvents, Windows), chokidar elsewhere (Linux inotify — see native-recursive.ts).

import type { Clock } from '../../common/async/clock.ts';
import { createChokidarWatcher } from './chokidar.ts';
import { createNativeRecursiveWatcher } from './native-recursive.ts';
import type { Watcher } from './seam.ts';

export function createPlatformWatcher(
  clock: Clock,
  platform: NodeJS.Platform = process.platform,
): Watcher {
  return platform === 'darwin' || platform === 'win32'
    ? createNativeRecursiveWatcher(clock)
    : createChokidarWatcher(clock);
}
