# Lean testing and agent process: plan

**Status:** proposal, approved in direction by ApisMellow on 2026-10-24. No code changes yet.
**Branch:** `docs/lean-testing-plan`, cut from `main` at `2514079`.
**Hand-off:** a later session merges this plan with the privacy-spec branch, which is being written in parallel, and then carries out the changes below in one pass.

## 1. Why

The tutorial build (24 PRs, about 21K lines) used up two full usage windows. Measured from the session logs:

- **Most of the cost came from agent count times context size.** There were 66 subagents and 2,823 calls, carrying about 223K tokens of context per call on average. Agents started about 73K tokens heavy before doing any work.
- **Big docs were re-read about 200 times:**
  - `AGENTS.md`: 57 times (662 lines)
  - `docs/tutorial-plan.md`: 49 times
  - `docs/tutorial-design.md`: 43 times
- **The full gate ran far more than needed.** There were 51 full `scripts/ci.sh` runs, about 9 of them after edits of 0 to 6 lines. The same gate also ran on GitHub for every PR into the feature branch, and again on push.
- **The tests were slow, not wrong:**
  - Go `internal/game` takes 30 to 68 s per run and `internal/server` about 40 s, mostly from whole-game seed loops.
  - Every tutorial e2e spec walks all five lessons, at 25 to 50 s each.
  - The repeated failures were brittle tests (a layout check at one size, a lesson 5 timeout, a timestamp compare). None were real bugs.
  - No true flakes were found.

Review gates (19 reviewer agents) and one git agent per merge (28) made up most of the rest.

## 2. Decisions (ApisMellow, 2026-10-24)

1. **No testing after every line.** While building, run only the test file for the code you touched, at natural stopping points.
2. **The full suite runs once, when the feature is done.** That is the PR `gate` on GitHub. No local full `ci.sh` by default.
3. **Logic changes get unit tests with assertions.** Don't replay hundreds of games to prove a rule.
4. **Changes with no visual effect run no Playwright.**
5. **No "privacy" or strict tier.** The threat model is honest players, not attackers. The one requirement is that a player never sees the opponent's cards on screen. That is an ordinary display check, covered by normal tests and playtests.
6. **Subtle hints are gameplay issues.** For example, #93's counter pause hints that the opponent holds a 2. Handle these as normal gameplay work, without a special tier.
7. **Dev agents work from the brief alone.** The brief carries everything the task needs. Agents don't read `AGENTS.md` or the long plan and design docs.
8. **`AGENTS.md` shrinks to about 100 to 150 lines.** ApisMellow reviews the new file before it merges.
9. **Dev agents run inside the repo folder,** as a headless `claude` run there, not from an unrelated workspace.
10. **Agents stay small and short-lived, with tight briefs.** Long-running agents degrade as their context grows. An agent is continued only for a quick fix to its own fresh work.

## 3. Proposals

### 3.1 Process docs

- **`AGENTS.md`:** rewrite to about 100 to 150 lines. Keep:
  - what the project is
  - the repo layout
  - the commands (quick check, single-test commands, full gate)
  - the testing rules in §2
  - the few hard rules (no machine-local paths; attribution to ApisMellow; the opponent's cards never on screen)
  - the small-fix lane (§3.2)

  Delete, don't move, the overnight-loop ceremony: red-evidence records, mutation protocol, round logs, brief-boundary rules and pasted gate tables. Most of it repeats `docs/SPEC.md` or `docs/loop-workflow.md`.
- **`.claude/agents/cuttle-reviewer.md`:** the reviewer is opt-in, used only for large or risky features. It reads the PR gate result and never re-runs `ci.sh`. Remove the mutation protocol (per-mutant rsync, `npm ci`).
- **`.claude/agents/cuttle-svelte-dev.md`, `cuttle-bridge-dev.md`:** use the testing rules from §2. Remove "done = `ci.sh` 9/9", and remove "bridge work is strict by default" (`cuttle-bridge-dev.md:24`).
- **`docs/loop-workflow.md` §4.5:** replace the strict and light tiers with the §2 rules. Drop the screenshot fit check and the playtest judge for every UI-visible item; keep the judge for new visual surfaces only, one pass, with no re-check round unless something blocks.
- **`docs/SPEC.md` §gate (around lines 1775–1789):** the nine commands are the PR gate. Locally, the quick check is the norm.
- **`docs/tutorial-plan.md:304`:** drop "every item ends with … `ci.sh` at 9/9".
- **`docs/requirements.yaml`:** update once per feature, at merge, with a one-line evidence pointer (the PR number) instead of a pasted gate table.

### 3.2 The small-fix lane (new)

This is for a bug fix or tweak of about 100 lines or less:

- **Who:** one developer, Sonnet, with a short brief. It runs headless in the repo folder.
- **Tests:** write a regression test with the fix; no red-first record and no mutant. Run only the touched tests (`npx vitest run <file>`, `go test ./internal/<pkg>/ -run <Name>`).
- **Not needed:** no reviewer, no local full gate, no ledger edit, no screenshot judge.
- **Shipping:** one git-agent pass per fix: branch, PR, wait for `gate`, merge.

### 3.3 Feature work

- **Commits:** developers commit on the feature branch, with no PR per work item into it. One PR to `main` at the end, and one git-agent pass to ship it.
- **Agents:** one small developer agent per work item, each with its own brief that quotes the design excerpts it needs.
- **The full gate:** runs once, on that final PR.

### 3.4 Go tests

Whole-game seed loops are replaced by a few fixed games, each asserting specific outcomes. Target: `go test ./...` under about 10 s.

| File | Loop today | Proposal |
|---|---|---|
| `internal/server/ws_privacy_sweep_test.go` (`TestW9_WirePrivacySweep`) | 240 seeds (35 with `-short`); the only Go failure seen (a known stall, #72/#74) | **Decided by the privacy-spec branch.** Recommendation: out of the default run; available by hand behind an env var or build tag |
| `internal/game/discard_redaction_test.go:227` | 160 seeds | 3 to 5 fixed scenarios with exact asserts |
| `internal/game/drawn_test.go:206` | 160 seeds | 3 to 5 fixed scenarios |
| `internal/game/session_test.go` (lines 137, 166, 251, 406, 641, 859+) | 30 to 120 games each | 3 to 5 games each; merge overlapping loops |
| `internal/game/bridge_test.go:180, :586` | 60 and 30 | 5 each |
| `internal/game/target_test.go:429` | 60 | 5 |
| `internal/game/golden_test.go:147` | 64 golden seeds | keep a handful; it already asserts exact output |
| `internal/server/ws_test.go:301` | 60 | 5 |

### 3.5 Browser tests (Playwright)

- **Walkthrough:** keep one full tutorial walkthrough (`tutorial-walkthrough.spec.ts`), at one viewport, 393×852.
- **Single-lesson checks:** shrink `tutorial-reduced-motion.spec.ts` (three variants, about 40 s each) and `tutorial-keyboard.spec.ts` to a single lesson.
- **Keyboard test:** `tutorial-keyboard.spec.ts:68` compares the saved game byte for byte, including `savedAt`. Compare game state only.
- **Geometry test:** `tutorial-geometry.spec.ts` runs at one viewport with fewer steps. Lesson 3 at 393×660 failed every time; lesson 5 timed out at 2 min.
- **Retries:** cut from 2 to 0 in `web/playwright.config.ts`. A broken test fails once instead of three times.
- **Online home:** look at `online-home.spec.ts:66` (create flow) for a timing race only if it fails again.

### 3.6 CI and scripts

- **`scripts/ci.sh` quick mode:** the default locally. It runs Go build, vet and `test -short`, `svelte-check`, lint, and `vitest --changed`. `FULL=1` runs all nine steps and is what GitHub uses.
- **`test:smoke` (`web/package.json`):** drop the second wasm build and reuse the one `ci.sh` already made.
- **`.github/workflows/ci.yml`:** run `gate` on `pull_request` only. Drop the push triggers on `main` and `feat/**`, which re-run a gate the PR already passed. Cache the Playwright browser download.
- **`pages.yml`:** unchanged; it runs no tests.

## 4. Order of work for the hand-off session

1. Merge this branch and the privacy-spec branch, and settle §3.4's sweep row against that spec.
2. Make the process doc changes (§3.1), with the `AGENTS.md` rewrite shown to ApisMellow before merge.
3. Make the test cuts (§3.4, §3.5) and the CI and script changes (§3.6).
4. Run quick mode once locally. Then one PR; the `gate` (FULL) must pass on GitHub.
5. Check that a merge to `main` runs no second gate (only Pages).
6. Send the next small fix (#93 or #77) through the §3.2 lane, and record its time and token cost as the benchmark.

## 5. Success measures

- Local quick check: about 1 to 2 minutes.
- PR gate: noticeably shorter than today's (the Go and e2e cuts are the bulk).
- A small fix: one developer plus one git pass, with no review round.
