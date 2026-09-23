# mutant-hunt

A pricing engine for monster-hunting gear — silvered blades, blessed ammunition, guild ranks,
moon-phase surcharges — with a test suite at 100% line, branch, function and statement coverage,
green CI, and a mutation score of **57.60%**. 53 of 125 valid mutants walk straight through that
suite without a single test noticing. Coverage tells you every line ran. It does not tell you
whether anything checked what that line produced.

The sharpest example: `src/domain/receipt.ts` is **100% covered and scores 0.00% on mutation
testing** — 24 survivors, nothing asserted. One of them is a `UnaryOperator` mutant that flips
`-totals.discount` to `+totals.discount` on the receipt line:

```ts
rows.push(`Guild discount ${formatRate(totals.discountRate)} ${formatCents(-totals.discount)}`);
```

Flip the sign and the customer's discount prints as a surcharge. Every test that touches this
function reads the receipt's _shape_ — right number of rows, right labels — and none of them reads
the number closely enough to catch that it is now positive. The suite runs the line either way.

This repo is both the support material for that argument and a CI template built to be copied
whole: a three-job quality stage with one aggregating gate, a weekly ground-truth mutation run
published to GitHub Pages, and a shields.io badge with a canary that catches the specific way a
mutation gate can go green while being completely broken.

## Two branches, one diff

| branch               | coverage                  | mutation score | `stryker run` exit code          |
| -------------------- | ------------------------- | -------------- | -------------------------------- |
| `act-1/the-tracking` | 100% / 100% / 100% / 100% | 57.60%         | 1 (below `thresholds.break: 80`) |
| `act-2/the-hunt`     | 100% / 100% / 100% / 100% | 100.00%        | 0                                |

```sh
git diff act-1/the-tracking act-2/the-hunt --stat
```

is exactly one file, `test/boundaries.spec.ts` — 34 new tests, written against
`reports/mutation/mutation.json` from act 1, going after the 53 survivors one by one. No line under
`src/` changes between the two acts. See [`docs/walkthrough.md`](docs/walkthrough.md) for how those
tests were built.

## Running it

Node 24 (`>=24.0.0 <25.0.0`), pnpm 11 (`pnpm@11.24.0` pinned in `packageManager`).

```sh
pnpm install

pnpm run check                       # fmt + lint + typecheck, vp's aggregate
pnpm run test                        # vitest
pnpm run test:coverage               # vitest --coverage, 100% required on all four metrics
pnpm run test:mutation               # full Stryker run
pnpm run test:mutation:incremental   # Stryker with its own result cache
```

`check:fix` and `fmt:fix` exist for the write-back variants. There is no `mutation:diff` script —
diff-scoped mutation runs were built, measured and removed; see
[`docs/ci-patterns.md`](docs/ci-patterns.md) for why.

## What it costs

Mutation testing is not free, and quoting one number for it is dishonest. On the reference machine
(4-core i5-1145G7 laptop), `pnpm run test:mutation`:

- three consecutive runs: 90.3-94.6 s, mean 92.2 s
- a fourth run, taken after other Stryker runs had already churned `.stryker-tmp`: 104.8 s

Quote the range, not the mean — the spread between runs (4.3 s to 14.6 s depending on how many runs
came before) is bigger than most of the savings people try to engineer away.

`--incremental` is the real lever: on an unchanged tree, a cold run (100.5 s) drops to 28.0 s —
a 72.6 s, 72.2% saving — because 168 of 200 mutant results are reused. Change one expression in one
file and exactly 2 mutants get re-tested; a comment-only change re-tests nothing at all. That is why
the PR gate runs `test:mutation:incremental` and not a full run.

The TypeScript checker (`checkers: ["typescript"]` in `stryker.config.json`) is the tradeoff nobody
expects: it roughly **doubles** the wall clock (92.2 s → 45.7 s without it, a 2.02x factor) and it
makes the score **lower**, not higher — 57.60% with the checker versus 64.88% without. The 43
mutants the checker rejects as uncompilable are not all noise: run them anyway and 37 of the 43 die
at runtime, while only 6 actually survive. Removing them shrinks both the numerator and the
denominator, and on a codebase this strongly typed with tests this thorough, the net effect is a
worse-looking, more honest number. Keep the checker if you want the survivors list to contain only
mutants a developer could actually have written. Drop it if wall clock is the binding constraint on
the PR gate. There is no free option here — see
[`docs/measurements.md`](docs/measurements.md#what-the-typescript-checker-costs) for the full
per-file breakdown before you decide for your own project.

## Steal this CI

`.github/workflows/quality.yml` runs three jobs on every PR and push to `main`:

- **`check`** — format, lint, types. One job, three steps (not one `vp check` call), because `vp
check` stops at the first failing category and a formatting complaint hiding a type error costs a
  whole round trip.
- **`check-test`** — `test:coverage`, gated at 100% on all four metrics by `vite.config.ts`.
- **`check-mutation`** — `test:mutation:incremental`, restoring the incremental cache that
  `mutation-main.yml` writes on every push to `main` (a PR branch can only restore; only `main`'s
  cache is visible to every other branch). Posts a sticky PR comment with the score, skipped on
  fork PRs where `GITHUB_TOKEN` is read-only.

A fourth job, **`quality`**, `needs` all three and is the _only_ required status check on branch
protection. `skipped` counts as failure there on purpose — a job skipped by a bad `if:` must never
read as a pass. Add a fifth check later by editing this one file's `needs:` list; no repo-settings
click required.

Separately, `mutation-weekly.yml` throws the incremental cache away and runs every mutant from
scratch on a schedule, because Stryker's incremental diff tracks source and test files only — a
dependency bump, an env var change or a snapshot update is invisible to it and would otherwise
replay stale `Killed` verdicts forever. That workflow publishes the full HTML report and a
`badge.json` shields.io endpoint to GitHub Pages.

The canary that matters most: `scripts/mutation-summary.mjs --assert-sane`, run right after every
mutation job, before the report is even rendered. The failure it exists for is real and was
measured on the spike — a version-mismatched test runner (vitest 5 under a Stryker vitest-runner
built for vitest 4) reports **0% mutation score, every mutant survived, and still exits 0**. Without
a canary, that is a green gate. With one, it's a hard failure before anyone trusts the badge.

Badge markdown (owner not decided yet — `OWNER/mutant-hunt` is a placeholder, substitute the real
one):

```markdown
[![mutants slain](https://img.shields.io/endpoint?style=flat&url=https://OWNER.github.io/mutant-hunt/badge.json)](https://OWNER.github.io/mutant-hunt/)
```

Two things a workflow file cannot do for you: GitHub Pages must be switched to source
**"GitHub Actions"** by hand, once, in repo settings — the default ("deploy from a branch") makes
`deploy-pages` fail or silently publish nothing. And the badge 404s until the first successful run
of `mutation-weekly.yml`; trigger it manually rather than waiting for Monday's cron.

## The number that isn't there

Act 2 gets `act-2/the-hunt` to 100.00% and every one of act 1's 53 survivors is genuinely dead —
there is no equivalent mutant left in this domain, because the code exports its whole computed
surface somewhere a test can read it back. But 100% is a statement about the mutants Stryker chose
to generate, and it has a hole you can drive a bug through anyway.

```ts
// src/domain/discounts.ts
export function totalDiscountRate(rank: BasisPoints, bulk: BasisPoints): BasisPoints {
  return Math.min(rank + bulk, percent(25));
}
```

`percent(25)` is the cap, 2,500 basis points. `rank` is one of `{0, 500, 1000, 1500}`, `bulk` is one
of `{0, 500, 1200}`; the 12 combinations produce exactly 9 distinct sums, and the only one that ever
exceeds the cap is 2700. `Math.min` → `Math.max` dies cleanly, because that one case makes them
disagree loudly (2700 vs 2500) — which is why `discounts.ts` sits at 100.00%. But swap the constant
itself, `percent(25)` for `percent(24)` or `percent(26)`, and nothing in the suite would notice: no
reachable order ever lands at 2500, 2499 or 2501, so no test has a reason to construct one, and
Stryker ships no numeric-literal mutator — it never even proposes the mutant. It isn't that the bug
survives; it's that it was never asked about.

A 100% mutation score proves every mutant the tool generated was killable. It says nothing about a
constant, a magic number, or any literal outside the mutator set the tool ships with. Don't let a
talk — or a badge — replace one false metric with another.

## Further reading

- [`docs/measurements.md`](docs/measurements.md) — every number above, with the exact command that
  produced it.
- [`docs/walkthrough.md`](docs/walkthrough.md) — how the 34 boundary tests in
  `test/boundaries.spec.ts` were built from act 1's survivor list.
- [`docs/ci-patterns.md`](docs/ci-patterns.md) — the CI decisions in detail, including why diff-scoped
  mutation runs were built and then removed.
