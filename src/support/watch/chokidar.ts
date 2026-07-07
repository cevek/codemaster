// chokidar-backed `Watcher` (§8): debounced batches, default ignore set (the same
// dirs the walker skips, plus editor temp churn — §19), and degrade-not-crash: a
// watcher error reports `onDegraded` and closes; the read-time freshness check keeps
// every answer correct without it (§3.5).

import { watch as chokidarWatch } from 'chokidar';
import type { Clock } from '../../common/async/clock.ts';
import { debounce } from '../../common/async/debounce.ts';
import { DEFAULT_IGNORED_DIRS, DEFAULT_IGNORED_FILES } from '../fs/ignored-paths.ts';
import type { Watcher, WatcherHandle } from './seam.ts';

const WATCH_DEBOUNCE_MS = 120;

export function createChokidarWatcher(clock: Clock): Watcher {
  return {
    watch(root, events): WatcherHandle {
      const pending = new Set<string>();
      const flush = debounce(clock, WATCH_DEBOUNCE_MS, () => {
        if (pending.size === 0) return;
        const batch = [...pending];
        pending.clear();
        events.onChanged(batch);
      });

      const ignored = (
        path: string,
        stats?: { isFile(): boolean; isDirectory(): boolean },
      ): boolean => {
        // Sockets / FIFOs / devices are unwatchable (e.g. another daemon's
        // `.codegraph/daemon.sock`) — watching one throws and would needlessly
        // degrade the whole watcher.
        if (stats !== undefined && !stats.isFile() && !stats.isDirectory()) return true;
        const segments = path.split(/[\\/]/);
        return (
          segments.some((s) => DEFAULT_IGNORED_DIRS.has(s)) || DEFAULT_IGNORED_FILES.test(path)
        );
      };

      const watcher = chokidarWatch(root, {
        ignored,
        ignoreInitial: true,
        // Atomic-save renames are treated as modify; short stability window folds
        // the editor's write-rename pair into one event (§19 editor temp churn).
        atomic: true,
      });

      let degraded = false;
      watcher.on('all', (_event, path) => {
        pending.add(path);
        flush.trigger();
      });
      watcher.on('error', (error) => {
        if (degraded) return;
        degraded = true;
        flush.cancel();
        void watcher.close();
        events.onDegraded(error instanceof Error ? error.message : String(error));
      });

      return {
        async close() {
          flush.cancel();
          await watcher.close();
        },
      };
    },
  };
}
