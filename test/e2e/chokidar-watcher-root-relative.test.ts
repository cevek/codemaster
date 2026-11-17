// The chokidar adapter (production on Linux) on a real tree whose ROOT sits under a `build/`
// ancestor: source changes reach onChanged, an ignored dir inside the root does not. Runs on every
// OS — chokidar works everywhere, only its descriptor cost differs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { systemClock } from '../../src/common/async/clock.ts';
import { createChokidarWatcher } from '../../src/support/watch/chokidar.ts';

const EVENT_DEADLINE_MS = 10_000;
const QUIET_MS = 600;

test('chokidar: a root under a build/ ancestor still reports source, not node_modules', async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cm-chok-')));
  const root = path.join(base, 'build', 'proj');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  const src = path.join(root, 'src', 'a.ts');
  const dep = path.join(root, 'node_modules', 'pkg', 'index.js');
  writeFileSync(src, '');
  writeFileSync(dep, '');
  const seen = new Set<string>();
  const handle = createChokidarWatcher(systemClock).watch(root, {
    onChanged: (paths) => {
      for (const p of paths) seen.add(p);
    },
    onDegraded: (reason) => assert.fail(`watcher degraded: ${reason}`),
  });
  try {
    const deadline = Date.now() + EVENT_DEADLINE_MS;
    while (!seen.has(src)) {
      assert.ok(Date.now() < deadline, `no event for ${src} in ${EVENT_DEADLINE_MS} ms`);
      writeFileSync(dep, `${Date.now()}`);
      writeFileSync(src, `export const v = ${Date.now()};\n`);
      await new Promise((r) => setTimeout(r, 250));
    }
    writeFileSync(dep, 'last');
    await new Promise((r) => setTimeout(r, QUIET_MS));
    assert.equal(seen.has(dep), false, 'node_modules change reached onChanged');
  } finally {
    await handle?.close();
    rmSync(base, { recursive: true, force: true });
  }
});
