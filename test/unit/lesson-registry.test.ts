// The lesson registry (§12 prose folding) is the facade's whole knowledge of what may fold, so it
// must be complete and unambiguous. Completeness is checked against the SOURCE: every module that
// calls `defineLesson` is imported and every Lesson it exports must be registered — a lesson missing
// from the list would simply never fold, silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LESSONS } from '../../src/mcp/lessons.ts';
import type { Lesson } from '../../src/common/lesson/lesson.ts';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

function isLesson(v: unknown): v is Lesson {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Lesson).id === 'string' &&
    typeof (v as Lesson).full === 'string' &&
    typeof (v as Lesson).short === 'string'
  );
}

function lessonsIn(v: unknown, depth = 0): Lesson[] {
  if (isLesson(v)) return [v];
  if (depth > 1 || typeof v !== 'object' || v === null) return [];
  return Object.values(v).flatMap((x) => lessonsIn(x, depth + 1));
}

test('every exported lesson of every defining module is registered', async () => {
  const registered = new Set(LESSONS);
  const definers = walk(SRC).filter(
    (f) =>
      !f.endsWith('common/lesson/lesson.ts') && readFileSync(f, 'utf8').includes('defineLesson('),
  );
  assert.ok(definers.length >= 10, `found ${definers.length} defining modules`);
  for (const file of definers) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const exported = Object.values(mod).flatMap((v) => lessonsIn(v));
    const rel = relative(SRC, file);
    assert.ok(exported.length > 0, `${rel} defines lessons but exports none`);
    for (const l of exported) assert.ok(registered.has(l), `${rel}: '${l.id}' is not registered`);
  }
});

test('ids are unique, texts long enough to be unambiguous, and no full text contains another', () => {
  const ids = LESSONS.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate id');
  for (const l of LESSONS) {
    assert.match(l.id, /^[a-z][a-z-]*$/, l.id);
    assert.ok(l.full.length >= 40, `${l.id}: a short full text could match data`);
    assert.ok(l.short.length < l.full.length, `${l.id}: short is not shorter`);
    for (const o of LESSONS) {
      if (o !== l) assert.ok(!o.full.includes(l.full), `'${o.id}' contains '${l.id}'`);
    }
  }
});
