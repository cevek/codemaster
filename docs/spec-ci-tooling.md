# Spec: operational hardening — CI gate + pinned tooling

Status: **proposed** (task brief for an implementing agent). Read ARCHITECTURE.md §16 (the
invariants CI must gate), CONTRIBUTING.md (the `fix-and-check` gate), and `docs/spec-core-consolidation.md`
before starting.

## 1. Problem

The core-consolidation task hardened the honesty harness (cold==warm, resilience, span-validity,
edit-safety) so it _can_ gate CI (§16). But **there is no CI**, and the local gate is partial:

- **No `.github/workflows`** — the remote exists (`github.com:cevek/codemaster`), but nothing runs
  `fix-and-check` or `npm test` on push/PR. The harness runs only when a human remembers.
- **husky pre-commit runs only `lint-staged`** (eslint --fix + prettier on staged files) — **not**
  `tsc`, **not** `npm test`, **not** `knip`. A commit with failing types/tests/dead-code passes the
  local hook silently.
- **`ripgrep` is unpinned.** The `find_usages` distinctness oracle (`test/helpers/ripgrep.ts`)
  honest-skips when `rg` is absent — correct for local dev, but it means on any box (or CI image)
  without ripgrep the entire semantic-≠-grep half of the harness **silently no-ops to green**. The
  oracle is one missing binary away from proving nothing, with nothing pinning it.

"Functionally done, operationally half" — the harness is only as good as the thing that runs it.

## 2. Fixed decisions

- **GitHub Actions is the gate** (the remote exists). On `push` and `pull_request`: `npm ci` →
  `npm run fix-and-check` → `npm test`. Pin the Node version (the repo needs Node ≥ 22 for native
  TS type-stripping — match `package.json` `engines` / the `.nvmrc` if present, else pin 22.x).
  Cache `~/.npm` keyed on the lockfile.
- **ripgrep must be present AND the distinctness oracle must fail-loud in CI.** Two parts:
  (a) install ripgrep in the CI job (it ships on `ubuntu-latest` runners, but pin/verify it —
  `rg --version` as a step, fail if absent); (b) make `ripgrep.ts` **fail loud, not honest-skip,
  when a CI env flag is set** (e.g. `CODEMASTER_REQUIRE_RG=1`): locally `rgSites` returns
  `undefined` (skip) when `rg` is missing, but under the flag a missing `rg` throws so the
  distinctness assertions can never silently vanish in the gate. Set the flag in the CI workflow.
  (Pinning `@vscode/ripgrep` as a dev dep is an alternative to system `rg` — pick one; the
  fail-loud-in-CI behavior is the load-bearing half regardless.)
- **Optional local pre-push hook** (husky): run `npm test` on `git push` so a red suite never
  reaches the remote — cheap insurance for a solo workflow. Keep it `--no-verify`-skippable. This is
  optional; the CI gate is the contract, the pre-push is convenience.
- **Sequencing with the kitchensink integration spec.** That spec (`spec-kitchensink-integration.md`)
  may legitimately **quarantine** tests (`test.skip` with a FINDINGS reason) for real port bugs it
  surfaces. CI gates the **green-or-honestly-quarantined** state — a quarantined `skip` is green to
  the runner. Do **not** add a "no skipped tests" gate, and land CI after (or alongside) that spec
  so the gate doesn't go red on its in-flight findings.

## 3. Stages

**Definition of done per stage** (CONTRIBUTING): `fix-and-check` green · the gate demonstrably bites
(a deliberately-broken test / type error / lint error makes CI red — prove it once, then revert) ·
docs at present state.

### Stage 1 — GitHub Actions workflow

- **Build.** `.github/workflows/ci.yml`: trigger on push + PR; `actions/checkout`; `actions/setup-node`
  pinned to the project's Node major with npm cache; `npm ci`; `npm run fix-and-check`; `npm test`.
  (`fix-and-check` runs `eslint --fix` + `prettier --write` — in CI run the **check** form: either a
  `--check`/`--no-fix` variant, or `git diff --exit-code` after it, so CI fails on unformatted code
  rather than silently "fixing" it in a throwaway runner. Add a `lint-check`/`format-check` script if
  needed.)
- **Oracle.** Push a branch with (a) a type error, (b) a failing test, (c) an unformatted file — each
  must turn the run red; then a clean branch is green. Record the proof in the PR, revert the breakage.
- **Exit.** CI green on `main`; the gate proven to bite on tsc / test / format / lint / knip.

### Stage 2 — ripgrep fail-loud-in-CI + pin

- **Build.** Add a `CODEMASTER_REQUIRE_RG` (or equivalent) gate in `test/helpers/ripgrep.ts`: missing
  `rg` → `undefined` (skip) locally, but → throw a clear error when the flag is set. Install/verify
  `rg` in the CI job and set the flag there. (Or pin `@vscode/ripgrep` + resolve its binary path; if
  so, remove it from `knip.jsonc` ignore once imported.)
- **Oracle.** A unit/meta test asserts: with the flag set and `rg` resolvable, `rgSites` returns
  sites; the CI step `rg --version` succeeds. (Locally, absence still skips — assert that path stays.)
- **Exit.** The distinctness oracle can no longer silently no-op in the gate.

### Stage 3 (optional) — pre-push test hook

- **Build.** `.husky/pre-push` running `npm test` (skippable with `--no-verify`). Document it in
  CONTRIBUTING as the local fast gate; the CI workflow is the authoritative one.
- **Exit.** Green; documented; clearly optional.

## 4. Review protocol

**doc-sync-reviewer** — CONTRIBUTING describes the CI gate + (optional) pre-push as present;
`knip.jsonc` updated if a dep was pinned. **bug-reviewer** — the fail-loud flag actually fails (not a
no-op); the CI check-form of `fix-and-check` fails on unformatted code rather than auto-fixing in the
runner. The objective gate is the CI run going red on the deliberate breakage and green on `main`.
