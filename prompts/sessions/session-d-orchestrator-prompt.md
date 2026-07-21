You are fixing bugs in the Claude Code Fleet orchestrator — a system that spins up
1 Opus orchestrator + 3 DeepSeek workers to collaborate on a codebase via tmux
sessions and git worktrees.

## Your assignment

Branch: `fix/orchestrator-prompt`
You own ONLY this file:
- prompts/ORCHESTRATOR.md

Other files (setup.sh, teardown.sh, bin/msg, prompts/WORKER.md) are owned by
other sessions working in parallel. Do NOT touch them.

## Rules

1. **Stay in your lane.** Touch ONLY prompts/ORCHESTRATOR.md.
2. **One commit per finding.** Format: `fix: <brief description> (#<finding-number>)`
3. **Preserve the doc's voice.** Match the existing tone — imperative, direct,
   no fluff. The manual is instructions TO the orchestrator.
4. **Minimal diffs.** Add only what's needed. Don't restructure sections.
5. **Verify.** After all fixes, re-read ORCHESTRATOR.md to confirm it reads
   coherently and every instruction is unambiguous.

## Context

`prompts/ORCHESTRATOR.md` is the operating manual appended to the Opus
orchestrator's Claude Code system prompt. It defines the orchestrator's identity,
the team structure, the messaging protocol, the assignment decision tree, the
task spec format, the main loop, idle-worker policy, and stop condition.

Key sections:
- Section 1: "Identity & the one hard rule" — never write code
- Section 2: "The team & the channels" — sessions, BOARD.md, tasks/, comms.log
- Section 3: "The messaging protocol" — message types and rules
- Section 4: "Assignment decision tree" — when to fan out vs serialize
- Section 5: "Task spec format" — tasks/<id>.md template
- Section 6: "The main loop" — UNDERSTAND→RECORD→ASSIGN→SUPPORT→REVIEW→ADVANCE→REPEAT
- Section 7: "Idle-worker decision point" — standby/review/tests/prep
- Section 8: "Stop condition" — when the project is done
- Section 9: "First move" — startup instructions

## The findings you must fix (6 findings, all in this file)

### Finding #1 (orchestrator half) — No sync/rebase step before assigning dependent tasks

**Where:** Section 4 (decision tree) item 3, and/or section 6 (main loop) ASSIGN step.

**Problem:** The decision tree's "sequential dependency" case says "assign A now,
hold B until A merges" — implying worker B will see A's merged changes. But the
worker's worktree was created at setup time and never updated. It still reflects
the pre-merge snapshot.

**Fix:** Add a sync step. In the ASSIGN step of the main loop (section 6) or in
the decision tree (section 4), add: before sending a TASK for any task whose
dependencies were recently merged, run `git -C <worker-worktree-path> merge main`
(or rebase) to bring the worker's branch up to date. Something like:

In the ASSIGN step (section 6, step 3):
"If the task depends on work that was merged since the worker's branch was last
synced, sync first: `git -C <worker-worktree-path> merge main` (or rebase).
Only then send the TASK message."

Note: The worker half of this fix is being done in a parallel session (adding a
rebase step to WORKER.md's work loop). The two halves are complementary. The
orchestrator-side sync is the proactive trigger; the worker-side rebase is the
safety net.

### Finding #4 — No merge-conflict procedure

**Where:** Section 6, step 5 (REVIEW).

**Problem:** Step 5 says `git merge --no-ff w<n>` and stops there. Combined with
stale branches (#1), conflicts are likely. No instruction covers what the
orchestrator does when merge fails, and the "never write code" hard rule doesn't
clarify whether resolving a conflict counts as writing code.

**Fix:** Add to the REVIEW step (step 5): if the merge fails with conflicts,
do NOT resolve them yourself (that counts as writing code). Instead, send the
worker a REVISE telling it to rebase onto `main` and resolve the conflicts:

```
If `git merge --no-ff w<n>` fails with conflicts:
  - Do NOT resolve conflicts yourself.
  - Abort the merge: `git merge --abort`
  - Send: msg workerN "REVISE <id>: merge conflict — rebase onto main,
    resolve, and re-submit DONE. Read tasks/<id>.md ## Review for details."
  - Append the conflict details to the task spec under ## Review.
```

### Finding #5 — Same-file contention is vigilance-only, no tracking structure

**Where:** Section 2 (BOARD.md format) and section 4 (decision tree item 4).

**Problem:** The orchestrator is told in section 4 to notice file overlap by
inspection, but BOARD.md has no "files claimed by ACTIVE tasks" field to check
against. Easy to miss with more than one or two tasks in flight.

**Fix:** Add a claimed-files column/section to the BOARD.md template in section 2.
The template currently shows: `# id | state | assignee | notes`. Add a `files`
column:

```
# id     state    assignee  files                    notes
# ------ -------- --------- ------------------------ -----------------------------
```

And update section 4's decision tree (item 4) to reference this: "Before
assigning, check BOARD.md's `files` column — if any ACTIVE task already claims
a file you're about to assign, serialize onto that same worker."

### Finding #9 — No independent build/test gate before merge

**Where:** Section 6, step 5 (REVIEW).

**Problem:** The orchestrator merges purely off reading `git diff` — it never
independently re-runs the build/tests on the worker's branch. Trust is entirely
in the worker's self-report.

**Fix:** Add a step to the REVIEW phase: before merging, the orchestrator checks
out the worker's branch and runs the project's build/test command:

```
Before merging, verify the branch passes tests independently:
  git checkout w<n>
  <run the project's test/build command>
  git checkout main
If tests fail, REVISE instead of merging.
```

Note that this requires the orchestrator to know the project's test command.
Add guidance: "Ask the human for the test command on first use, or detect it
from package.json / Makefile / etc."

### Finding #10 — No liveness/timeout handling for workers

**Where:** Section 6 (main loop) — it's purely reactive.

**Problem:** If a worker session dies (crash, bad API key, rate limit), the
orchestrator just waits indefinitely for a DONE/ASK/BLOCKED that isn't coming.
A dead worker is indistinguishable from a slow one.

**Fix:** Add guidance to the main loop (section 6) or as a new sub-section.
If a worker hasn't responded in some N minutes (suggest 10-15), run:
`tmux capture-pane -t workerN -p | tail -20`
to check it's actually alive before continuing to wait. If the pane shows an
error or the session is dead, escalate to the human.

Add something like:

```
## Worker health check

Workers may crash, hit rate limits, or get stuck. If a worker hasn't sent any
message in ~10 minutes:

  tmux capture-pane -t <workerN> -p | tail -20

If the output shows an error, a crash, or the session is gone:
  - Mark the worker's ACTIVE task as BLOCKED with note "worker unresponsive"
  - Tell the human: "workerN appears dead — check its tmux session"
  - Reassign the task to another worker if available
```

### Finding #11 — No circuit breaker on REVISE loops

**Where:** Section 6 (main loop) or section 8 (stop condition).

**Problem:** Nothing caps repeated REVISE cycles on the same task. Given Opus
(orchestrator) is the expensive model, a stuck REVISE loop burns cost.

**Fix:** Add a rule: after N (suggest 3) REVISE rounds on the same task without
resolution, stop and escalate to the human. Add to section 6 or section 8:

```
If a task goes through 3 REVISE cycles without passing review, stop the loop:
  - Mark the task BLOCKED with note "failing review after 3 rounds"
  - Tell the human: "<id> has failed review 3 times — here's what's wrong:
    <summary>. How should we proceed?"
  - Do NOT send a 4th REVISE without human direction.
```

Track REVISE count per task in BOARD.md (add a `revises` column or note it in
the notes field).

## Approach

1. Read prompts/ORCHESTRATOR.md completely.
2. Work through findings in order: #1(orchestrator half), #4, #5, #9, #10, #11.
   This order builds on itself — earlier fixes establish patterns later ones
   reference.
3. For each finding, find the exact section/paragraph to modify, make the minimal
   addition, and commit.
4. After all 6 fixes, re-read the full file to confirm it reads as a coherent
   manual — make sure the new sections don't contradict each other.
5. Pay special attention to consistency: the BOARD.md format (#5) should
   accommodate the REVISE count tracking (#11) if possible.
