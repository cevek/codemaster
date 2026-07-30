// The process-mode child's heap ceiling (t-811950, §9): config verbatim, else half the box within
// [4096, 8192] MB.
//
// The ORACLE is not another codemaster answer but a measurement + the arithmetic it forces. Measured
// on a 6.1k-file pnpm monorepo (32 GB box, node 22): a checker-backed `find_usages` needs ~5.2 GB
// live heap — it DIES at a 5120 MB flag (V8 limit 5168) and ANSWERS at 5632 (limit 5680). The old
// fixed default (4096 → limit 4144) is Node's OWN default on such a box, i.e. it raised nothing. So
// the properties asserted here are the ones that decide whether that repo can be answered at all:
// the derived ceiling clears ~5.2 GB on the common 16/32 GB dev box, and never drops below the
// historical 4096 on a small one (no regression, and a stated cap rather than an accident).
//
// Also asserted: a stated config number is passed through UNCLAMPED (the bounds are the default's
// policy, not a validity rule), and the resolution is a pure function of (config, box) — the reason
// it takes total RAM rather than free RAM is that a ceiling varying between two spawns of the same
// repo would let the identical call refuse under load and answer when idle (§3.6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boxMemoryBytes,
  CEILING_MAX_MB,
  CEILING_MIN_MB,
  describeCeiling,
  resolveChildHeapMB,
} from '../../src/daemon/heap-ceiling.ts';
import type { CodemasterConfig } from '../../src/config/config.ts';

const GB = 1024 * 1024 * 1024;
const NO_CONFIG: CodemasterConfig = {};

/** A REAL Linux `os.totalmem()` reading (a 16 GB box: `sysinfo.totalram` = physical minus
 *  kernel-reserved, so NOT a multiple of 1 MiB). Every `n * GB` fixture halves to a whole MB by
 *  construction, so only a value like this exercises the floor — and the floor is load-bearing:
 *  `--max-old-space-size=7960.0546875` makes node refuse to start ("illegal value … of type size_t"),
 *  which for an AUTO escalation degrades silently to in-process, i.e. the whole defence is lost with
 *  nothing red. */
const LINUX_16GB_BYTES = 16_694_120_448;

/** The measured live-heap need of the 6.1k-file monorepo this ceiling exists for, plus the GC
 *  headroom the measurement showed is required: it OOM'd at a 5120 MB ceiling and answered at 5632. */
const MEASURED_NEED_MB = 5632;

test('an explicit config ceiling is used verbatim — never clamped into the default policy band', () => {
  for (const mb of [512, 4096, 5632, 65_536]) {
    assert.equal(
      resolveChildHeapMB({ daemon: { maxOldSpaceMB: mb } }, 32 * GB).maxOldSpaceMB,
      mb,
      `a stated ${mb} MB must be honored as stated`,
    );
  }
});

test('the derived default clears the measured need on the common dev boxes (16 GB and up)', () => {
  for (const gb of [16, 32, 64, 128]) {
    const mb = resolveChildHeapMB(NO_CONFIG, gb * GB).maxOldSpaceMB;
    assert.ok(
      mb >= MEASURED_NEED_MB,
      `a ${gb} GB box must clear the measured ${MEASURED_NEED_MB} MB need, got ${mb}`,
    );
  }
});

test('no regression on a small box: the ceiling never drops below the historical 4096 default', () => {
  // Half of an 8 GB box is exactly the floor; anything smaller would derive LESS than today's
  // default, which would take capability away from machines that never had this problem.
  for (const bytes of [0, 512 * 1024 * 1024, 2 * GB, 4 * GB, 8 * GB]) {
    assert.equal(resolveChildHeapMB(NO_CONFIG, bytes).maxOldSpaceMB, CEILING_MIN_MB);
  }
  // An unmeasurable box is the floor too — never a fabricated size (NaN/Infinity from a hostile
  // `os.totalmem()` reading, which would otherwise produce a NaN flag the child cannot parse).
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(resolveChildHeapMB(NO_CONFIG, bad).maxOldSpaceMB, CEILING_MIN_MB);
  }
});

test('the anti-thrash cap binds a big box, and the band is never left', () => {
  assert.equal(resolveChildHeapMB(NO_CONFIG, 1024 * GB).maxOldSpaceMB, CEILING_MAX_MB);
  for (let gb = 1; gb <= 96; gb += 1) {
    const mb = resolveChildHeapMB(NO_CONFIG, gb * GB).maxOldSpaceMB;
    assert.ok(mb >= CEILING_MIN_MB && mb <= CEILING_MAX_MB, `${gb} GB → ${mb} MB out of band`);
    assert.ok(Number.isInteger(mb), `${gb} GB → ${mb} is not an integer MB flag value`);
  }
});

test('the ceiling is in MB and monotone in box size — a bytes/MB slip would show as both', () => {
  // 12 GB sits strictly inside the band, so it pins the UNIT: half of 12 GB is 6144 MB. A
  // bytes-vs-MB confusion here yields 6_442_450_944 or 6, both of which this equality rejects.
  assert.equal(resolveChildHeapMB(NO_CONFIG, 12 * GB).maxOldSpaceMB, 6144);
  let prev = 0;
  for (let gb = 1; gb <= 64; gb += 1) {
    const mb = resolveChildHeapMB(NO_CONFIG, gb * GB).maxOldSpaceMB;
    assert.ok(mb >= prev, `not monotone at ${gb} GB: ${mb} < ${prev}`);
    prev = mb;
  }
});

test('a real (non-MiB-multiple) Linux box reading yields a WHOLE-MB flag value', () => {
  // The flag is a `size_t`: node exits 9 on a fractional value, and for an AUTO escalation that
  // silent startup death degrades to in-process — the defence gone with nothing failing. A `n * GB`
  // fixture cannot catch it (it halves to a whole MB regardless), so this asserts the real shape.
  const mb = resolveChildHeapMB(NO_CONFIG, LINUX_16GB_BYTES).maxOldSpaceMB;
  assert.ok(Number.isInteger(mb), `${mb} is not a whole MB — node would refuse the flag`);
  assert.equal(mb, 7960); // the truncated half (7960.0546875), in band: neither floor nor cap decides
  // And it survives the round-trip into the flag text the fork appends.
  assert.equal(`--max-old-space-size=${mb}`, '--max-old-space-size=7960');
  // Under a cgroup, the same non-multiple shape must stay whole too.
  const constrained = resolveChildHeapMB(
    NO_CONFIG,
    boxMemoryBytes(64 * GB, 12_884_901_889),
  ).maxOldSpaceMB;
  assert.ok(Number.isInteger(constrained), `${constrained} is not a whole MB`);
});

test('a cgroup limit is the box, not the host RAM behind it', () => {
  // `os.totalmem()` reports the HOST inside a memory-limited container, so deriving from it alone
  // hands the child a ceiling the kernel will not honor: it gets SIGKILLed instead of hitting V8's
  // own limit, and a kernel kill can only be reported as `crash`, never the recognizable `oom`.
  assert.equal(boxMemoryBytes(64 * GB, 2 * GB), 2 * GB);
  assert.equal(
    resolveChildHeapMB(NO_CONFIG, boxMemoryBytes(64 * GB, 2 * GB)).maxOldSpaceMB,
    CEILING_MIN_MB,
  );
  // Non-positive / absent / non-finite means UNCONSTRAINED (that is `constrainedMemory()`'s
  // contract), never "no memory" — reading it as a limit would floor every normal machine.
  for (const reading of [0, -1, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(boxMemoryBytes(32 * GB, reading), 32 * GB, `reading ${String(reading)}`);
  }
  // A constraint LARGER than the host reading cannot raise the box.
  assert.equal(boxMemoryBytes(8 * GB, 64 * GB), 8 * GB);
});

test('the cause carried with the ceiling names who decided it', () => {
  // The cause is not decoration: it selects the remedy an OOM failure states (`describeCeiling`), so
  // a wrong cause misdirects the agent — "raise your config" for a number the config never set.
  assert.equal(
    resolveChildHeapMB({ daemon: { maxOldSpaceMB: 2048 } }, 32 * GB).cause,
    'configured',
  );
  assert.equal(resolveChildHeapMB(NO_CONFIG, 32 * GB).cause, 'cap');
  assert.equal(resolveChildHeapMB(NO_CONFIG, 12 * GB).cause, 'box');
  assert.equal(resolveChildHeapMB(NO_CONFIG, 4 * GB).cause, 'floor');
  for (const ceiling of [
    resolveChildHeapMB({ daemon: { maxOldSpaceMB: 2048 } }, 32 * GB),
    resolveChildHeapMB(NO_CONFIG, 32 * GB),
    resolveChildHeapMB(NO_CONFIG, 4 * GB),
  ]) {
    const text = describeCeiling(ceiling);
    assert.match(text, new RegExp(`heap ceiling ${ceiling.maxOldSpaceMB} MB`));
    // Every cause states a way to move the ceiling — a cause that only names itself leaves the agent
    // with a number and no next step (§3.6).
    assert.match(text, /daemon\.maxOldSpaceMB/);
  }
});
