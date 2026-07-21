# Orchestrator Fleet — Logic Review Findings

Review of the full kit (`setup.sh`, `teardown.sh`, `bin/msg`, `prompts/ORCHESTRATOR.md`,
`prompts/WORKER.md`, `README.md`) as of 2026-07-21. Findings are ranked by how much damage
they could do on a real run, not by file. Each entry has a file:line pointer, the failure
scenario, and a suggested fix. None of these have been applied yet — this file is a handoff
for a future session to work through.

Already fixed in a prior session (for reference, not re-open):
- `bins/` renamed to `bin/` (setup.sh referenced `$HERE/bin/msg`, dir was `bins/`).
- `setup.sh`, `teardown.sh`, `bin/msg` given execute bits (were `-rw-r--r--`).

---

## Critical — likely to break a real run

### 1. No sync/rebase step anywhere in the loop
**Where:** `setup.sh:52-62` (worktrees branched off `main` once, at setup time, never
updated) + `prompts/ORCHESTRATOR.md:135-151` (main loop) + `prompts/WORKER.md:63-73`
(RECEIVE step).

**Problem:** The decision tree's "sequential dependency" case
(`ORCHESTRATOR.md:82-84`, "assign A now, hold B until A merges") assumes worker B will see
A's merged changes once it starts. But nothing tells worker B to `git pull`/`rebase main`
before implementing — its worktree still reflects the pre-merge snapshot. Same problem
recurs any time one worker's branch is merged and another worker is later given a new task:
its worktree is stale relative to `main` unless someone explicitly tells it to sync.

**Fix:** Add an explicit sync step — either the orchestrator runs
`git -C <worktree> merge main` (or rebase) before sending a `TASK` message for any task
that depends on previously-merged work, or add it as step 0 of the worker's RECEIVE loop
("before implementing, rebase your branch onto `main`").

---

### 2. `teardown.sh:15` force-discards uncommitted work
**Where:** `teardown.sh:15` — `git -C "$REPO" worktree remove --force "$wt"`.

**Problem:** Silently blows away any uncommitted changes sitting in a worker's worktree
at teardown time. The whole point of worktrees here is "don't lose a worker's in-progress
work" — `--force` defeats that.

**Fix:** Drop `--force`. On failure, print a warning and leave the worktree in place
("worktree has uncommitted changes — commit/stash inside it, or re-run with
`git worktree remove --force <path>` if you're sure").

---

### 3. Orchestrator session isn't hardened against DeepSeek env leakage
**Where:** `setup.sh:67-79` (`start_session` function) + `setup.sh:82` (orchestrator launch).

**Problem:** `tmux new-session` inherits the calling shell's environment. Nothing unsets
`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` for the `orchestrator`
session. If you'd previously exported those DeepSeek vars in the terminal you run
`setup.sh` from (easy to do, since testing workers requires exactly that), the "Opus"
orchestrator silently comes up on DeepSeek instead — with no error, just wrong behavior.

**Fix:** In `start_session`, explicitly `unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN
ANTHROPIC_MODEL` before launching the orchestrator session specifically (workers set them
explicitly anyway via `extra_env`, so this only needs to guard the orchestrator branch).

---

## High — will cause confusing failures under coordination load

### 4. No merge-conflict procedure
**Where:** `prompts/ORCHESTRATOR.md:144-147` (REVIEW step).

**Problem:** Step 5 says `git merge --no-ff w<n>` and stops there. Combined with #1
(stale branches), conflicts are likely, not an edge case. No instruction covers what the
orchestrator does when the merge fails, and its "never write code" hard rule
(`ORCHESTRATOR.md:13-18`) doesn't clarify whether resolving a conflict counts as writing
code.

**Fix:** Add an explicit rule: don't resolve conflicts yourself — send the worker a
`REVISE` telling it to rebase onto `main` and resolve, then re-submit `DONE`.

---

### 5. Same-file contention is vigilance-only, no tracking structure
**Where:** `prompts/ORCHESTRATOR.md:86-88` (decision tree item 4) + `BOARD.md` format
(`ORCHESTRATOR.md:32-34`).

**Problem:** The orchestrator is told to notice file overlap by inspection before
assigning, but `BOARD.md` has no "files claimed by ACTIVE tasks" field to check against.
Easy to miss once more than one or two tasks are in flight.

**Fix:** Add a claimed-files column/section to `BOARD.md` so the orchestrator can check
mechanically instead of relying on memory.

---

### 6. Filesystem isolation is convention, not enforcement
**Where:** `prompts/WORKER.md:49-51` ("Stay in your lane") is the *only* thing preventing
cross-worker file access.

**Problem:** Git worktrees give branch isolation, not process/filesystem isolation. Any
worker's Bash tool can `cd`/read/write into another worker's worktree, another worker's
uncommitted changes, or even the main repo — nothing sandboxes tool calls to a directory.
The original design explicitly flagged DeepSeek workers as needing tighter guardrails than
Opus, but enforcement here is prompt-only.

**Fix:** Low-effort mitigation: no automatic fix without real sandboxing (e.g. containers
per worktree), so at minimum call this out as an accepted risk, or consider OS-level
permission restrictions per worktree if this becomes a real project (not just a test).

---

### 7. `bin/msg` doesn't guarantee the "one atomic line" property it depends on
**Where:** `bin/msg:19-24`.

**Problem, two parts:**
- (a) If `$*` ever contains an embedded newline (e.g. someone pastes a multi-line snippet
  into a `msg` call instead of putting it in a task file), `tmux send-keys -l` types the
  literal newline, which submits a partial line as its own Enter-terminated input in the
  target session — silently breaking the one-message-one-line invariant everything else
  assumes.
- (b) The send is two separate commands (`send-keys -l "$line"` then `send-keys Enter`,
  lines 23-24). There's a window between them where a second concurrent sender to the same
  target can inject text in between and mangle the line. The original design brainstorm
  names this exact risk ("two agents send-keys-ing the same target at once can mangle a
  line") but the script never implements a fix.

**Fix:**
- Strip or reject embedded newlines in `$*` before sending (e.g. `line="${line//$'\n'/ }"`
  or fail loudly if a newline is present).
- Wrap the two `send-keys` calls in a `flock` on a per-target lockfile (e.g.
  `flock "$coord/.lock.$target" -c '...'`) to make the send atomic across concurrent
  senders.

---

## Medium

### 8. `comms.log` resets on every `setup.sh` run, `BOARD.md` doesn't
**Where:** `setup.sh:38` (`: > "$FLEET_DIR/comms.log"`, unconditional truncate) vs.
`setup.sh:39-45` (`BOARD.md` only created if missing, otherwise preserved).

**Problem:** Tear down and set up again and you get a `BOARD.md` claiming tasks are
ACTIVE/MERGED with zero matching history in `comms.log` to explain how it got there —
confusing for a fresh orchestrator session reading its own board on restart.

**Fix:** Make both persist across runs, or both reset — pick one. Persisting both (never
truncate `comms.log`, just append) is probably more useful for audit purposes.

---

### 9. No independent build/test gate before merge
**Where:** `prompts/ORCHESTRATOR.md:144-147` (REVIEW step) vs. `prompts/WORKER.md:67-68`
(worker self-reports running tests before committing).

**Problem:** The orchestrator's REVIEW step merges purely off reading `git diff` — it
never independently re-runs the build/tests on the worker's branch. Trust is entirely in
the worker's self-report.

**Fix:** Add a step: orchestrator runs the project's test/build command against `w<n>`
before merging, not just after all tasks are done.

---

### 10. No liveness/timeout handling for workers
**Where:** Entire protocol (`ORCHESTRATOR.md` main loop) is purely reactive.

**Problem:** If a worker session dies (crash, bad API key, rate limit), the orchestrator
just waits indefinitely for a `DONE`/`ASK`/`BLOCKED` that isn't coming — a dead worker is
indistinguishable from a slow one.

**Fix:** Add guidance: if a worker hasn't responded in some N minutes, run
`tmux capture-pane -t workerN -p` to check it's actually alive before continuing to wait.

---

### 11. No circuit breaker on REVISE loops or cost
**Where:** `prompts/ORCHESTRATOR.md` main loop / stop condition section.

**Problem:** Nothing caps repeated REVISE cycles on the same task, or tells the
orchestrator to stop and ask the human after N failed review rounds. Given Opus
(orchestrator) is the expensive model, a stuck REVISE loop burns cost with no circuit
breaker.

**Fix:** Add a rule: after N (e.g. 3) REVISE rounds on the same task without resolution,
stop and escalate to the human instead of continuing to iterate.

---

## Worth knowing, not yet actionable

### 12. The core "input queues while busy" mechanism is still unverified
**Where:** Design assumption underlying the whole `msg`/send-keys approach (see README).

**Problem:** The entire "send-keys sidesteps polling" architecture rests on Claude Code
queuing input typed mid-turn rather than dropping or garbling it. This was flagged as
untested in the original design conversation and nothing in the kit has verified it since.
It's the highest-uncertainty assumption the whole system stands on.

**Fix:** Before a real multi-task run, do a small smoke test: start a session, give it a
long-running task, `msg` it mid-task, and confirm the message queues and arrives cleanly
rather than being dropped or interleaved into whatever's mid-render.

---

## Suggested order of attack for the next session

1. Fix #1 (sync/rebase step) and #3 (env leak) — cheap, high blast-radius-if-ignored.
2. Fix #2 (`--force` removal) — one-line change, prevents silent data loss.
3. Fix #7 (msg atomicity/newline handling) — contained to `bin/msg`.
4. Add #4 (conflict procedure) and #11 (REVISE circuit breaker) to `ORCHESTRATOR.md`.
5. Do the smoke test in #12 before trusting the system with real work.
6. #5, #6, #8, #9, #10 are process/design improvements — worth doing but lower urgency.
