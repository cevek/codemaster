// The production watcher's descriptor cost does not grow with the tree (t-142288): on macOS a
// process past ~10240 open descriptors can no longer spawn anything (`spawn EBADF`), git included,
// and a per-file watcher reaches that on a few warm repos. Real fs on purpose — the cost lives in
// the OS watch primitive, which no fake reproduces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { systemClock } from '../../src/common/async/clock.ts';
import { createPlatformWatcher } from '../../src/support/watch/platform.ts';

const FILES = 2_000;
const MAX_FD_GROWTH = 100;
const EVENT_DEADLINE_MS = 10_000;

const openFds = (): number => readdirSync('/dev/fd').length;

test(
  'the platform watcher holds a bounded number of descriptors on a large tree',
  {
    skip:
      process.platform !== 'darwin'
        ? 'macOS only: Linux keeps chokidar (inotify watches are not descriptors)'
        : false,
  },
  async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cm-watch-fd-')));
    try {
      for (let d = 0; d < 20; d++) {
        mkdirSync(path.join(root, `d${d}`));
        for (let i = 0; i < FILES / 20; i++) {
          writeFileSync(path.join(root, `d${d}`, `f${i}.ts`), '');
        }
      }
      const target = path.join(root, 'd7', 'f3.ts');
      const before = openFds();
      const seen = new Set<string>();
      let wake: (() => void) | undefined;
      const handle = createPlatformWatcher(systemClock).watch(root, {
        onChanged: (paths) => {
          for (const p of paths) seen.add(p);
          wake?.();
        },
        onDegraded: (reason) => assert.fail(`watcher degraded: ${reason}`),
      });
      try {
        // The change is observed first, so the descriptors are counted on a watcher that is live.
        const deadline = Date.now() + EVENT_DEADLINE_MS;
        while (!seen.has(target)) {
          assert.ok(Date.now() < deadline, `no event for ${target} in ${EVENT_DEADLINE_MS} ms`);
          writeFileSync(target, `export const v = ${Date.now()};\n`);
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 250);
          });
        }
        const growth = openFds() - before;
        assert.ok(
          growth < MAX_FD_GROWTH,
          `watching ${FILES} files grew open descriptors by ${growth} (bound ${MAX_FD_GROWTH})`,
        );
      } finally {
        await handle?.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
