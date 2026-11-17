// Native recursive `fs.watch` adapter (§8, §19): ONE watch per root. On macOS (FSEvents) and Windows
// (ReadDirectoryChangesW) it costs a constant handful of descriptors whatever the tree size, where a
// per-file watcher holds one descriptor per file — and past ~10240 open descriptors (macOS
// `OPEN_MAX`) every `child_process.spawn` of the process throws `EBADF`, git included (t-142288).
// Linux keeps chokidar (`platform.ts`): Node's recursive watch there has no ignore and walks
// `node_modules`, while inotify watches cost no descriptors.

import { watch as fsWatch } from 'node:fs';
import * as path from 'node:path';
import type { Clock } from '../../common/async/clock.ts';
import { debounce } from '../../common/async/debounce.ts';
import { isIgnoredWatchPath } from './ignored-event.ts';
import type { Watcher, WatcherHandle } from './seam.ts';

const WATCH_DEBOUNCE_MS = 120;

/** The slice of `fs.FSWatcher` the adapter drives — a fake implements it in unit tests. */
export interface RecursiveWatchHandle {
  on(event: 'error', cb: (error: unknown) => void): unknown;
  close(): void;
}

export type RecursiveWatchFn = (
  root: string,
  onEvent: (filename: string | null) => void,
) => RecursiveWatchHandle;

const nodeRecursiveWatch: RecursiveWatchFn = (root, onEvent) =>
  fsWatch(root, { recursive: true, persistent: false }, (_event, filename) => {
    onEvent(filename === null ? null : String(filename));
  });

const noopHandle: WatcherHandle = { close: () => Promise.resolve() };

export function createNativeRecursiveWatcher(
  clock: Clock,
  watchFn: RecursiveWatchFn = nodeRecursiveWatch,
): Watcher {
  return {
    watch(root, events): WatcherHandle {
      const pending = new Set<string>();
      const flush = debounce(clock, WATCH_DEBOUNCE_MS, () => {
        if (pending.size === 0) return;
        const batch = [...pending];
        pending.clear();
        events.onChanged(batch);
      });
      let degraded = false;
      let handle: RecursiveWatchHandle | undefined;
      const degrade = (error: unknown): void => {
        if (degraded) return;
        degraded = true;
        flush.cancel();
        try {
          handle?.close();
        } catch {
          /* already gone — degrading is the outcome either way */
        }
        events.onDegraded(error instanceof Error ? error.message : String(error));
      };

      try {
        handle = watchFn(root, (filename) => {
          // No name (the platform did not say which entry changed): nothing to patch — the
          // read-time freshness check covers it (§3.5).
          if (degraded || filename === null || isIgnoredWatchPath(filename)) return;
          pending.add(path.join(root, filename));
          flush.trigger();
        });
        handle.on('error', degrade);
      } catch (thrown) {
        // A handle, not `undefined`: `undefined` reads as "does not watch" (`watcher=off`) and
        // would overwrite the degraded state just reported.
        degrade(thrown);
        return noopHandle;
      }

      return {
        close() {
          flush.cancel();
          if (!degraded) {
            degraded = true;
            try {
              handle?.close();
            } catch {
              /* already gone */
            }
          }
          return Promise.resolve();
        },
      };
    },
  };
}
