You are fixing bugs in the Claude Code Fleet orchestrator — a system that spins up
1 Opus orchestrator + 3 DeepSeek workers to collaborate on a codebase via tmux
sessions and git worktrees.

## Your assignment

Branch: `fix/shell-scripts`
You own ONLY these files:
- setup.sh
- teardown.sh

Other files (bin/msg, prompts/ORCHESTRATOR.md, prompts/WORKER.md) are owned by
other sessions working in parallel. Do NOT touch them.

## Rules

1. **Stay in your lane.** Touch ONLY setup.sh and teardown.sh.
2. **One commit per finding.** Format: `fix: <brief description> (#<finding-number>)`
3. **Minimal diffs.** Don't refactor or "improve" unrelated code.
4. **ShellCheck.** Run `shellcheck setup.sh teardown.sh` before committing.
5. **Verify.** After all fixes, re-read both files to confirm coherence.

## Context

- `setup.sh`: Creates coordination dir (.fleet/), 3 git worktrees at
  ../<repo>-worktrees/worker{1,2,3}, 4 tmux sessions with Claude Code.
  The `start_session` function (lines 67-79) launches each session.
- `teardown.sh`: Kills the 4 tmux sessions, removes the 3 worktrees.

## The findings you must fix

### Finding #2 — teardown.sh:15 force-discards uncommitted work

**Problem:** `git -C "$REPO" worktree remove --force "$wt"` silently blows away
any uncommitted changes in a worker's worktree at teardown time. The whole point
of worktrees is "don't lose a worker's in-progress work" — `--force` defeats that.

**Fix:** Drop `--force`. On failure (the `git worktree remove` returns non-zero),
print a warning and leave the worktree in place. Something like:
"worktree <path> has uncommitted changes — commit/stash inside it, or re-run with
`git worktree remove --force <path>` if you're sure."

The `|| true` on the line should change to handle the exit code properly (only
print "removed" on success, print warning on failure).

### Finding #3 — Orchestrator session not hardened against DeepSeek env leakage

**Where:** `setup.sh:67-79` (start_session function) + `setup.sh:82` (orchestrator launch).

**Problem:** `tmux new-session` inherits the calling shell's environment. Nothing
unsets `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` for the
`orchestrator` session. If you'd previously exported those DeepSeek vars in the
terminal you run `setup.sh` from, the Opus orchestrator silently runs on DeepSeek.

**Fix:** In `start_session`, explicitly unset those three env vars before
launching the orchestrator session. Workers set them explicitly via `extra_env`,
so this only needs to guard the orchestrator path. Options:
- (a) Add `unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL` via
  `tmux send-keys` before the claude launch line, but ONLY for the orchestrator
  (not workers).
- (b) Add a parameter to `start_session` to control this.
- (c) Add the unset commands inline on line 82 before calling start_session.

Pick the cleanest approach. The orchestrator call is on line 82 — you can send
the unset commands before the claude launch line for that session specifically.

### Finding #8 — comms.log resets on every setup, BOARD.md doesn't

**Where:** `setup.sh:38` (`: > "$FLEET_DIR/comms.log"`, unconditional truncate)
vs. `setup.sh:39-45` (`BOARD.md` only created if missing).

**Problem:** Tear down and set up again, and you get a `BOARD.md` claiming tasks
are ACTIVE/MERGED with zero matching history in `comms.log` — confusing for a
fresh orchestrator session.

**Fix:** Make both persist across runs, or both reset — pick one. Persisting both
(never truncate `comms.log`, just append) is more useful for audit purposes.
Change line 38 from `: > "$FLEET_DIR/comms.log"` to `touch "$FLEET_DIR/comms.log"`
(only create if missing, don't truncate). If you prefer the "both reset" approach,
also truncate BOARD.md on setup. Document the choice in a comment.

## Approach

1. Read setup.sh and teardown.sh completely.
2. Fix #2 first (one-line change, simplest).
3. Fix #3 next (contained to start_session / orchestrator launch).
4. Fix #8 last (one-line change, but think about consistency).
5. Run `shellcheck setup.sh teardown.sh`.
6. Commit each fix separately.
7. Do a final read of both files.
