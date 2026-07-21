# Parallel Bug-Fix Session Prompts

Each file in this directory is a **self-contained prompt** for one Claude Code
session. Give each session its prompt, and they can all run in parallel with
**zero git merge conflicts** — each session owns a disjoint set of files.

## How to use

### 1. Set up git worktrees (one per session)

```bash
# From the fleet kit repo:
git worktree add ../worktrees/session-a fix/shell-scripts
git worktree add ../worktrees/session-b fix/msg-atomicity
git worktree add ../worktrees/session-c fix/worker-prompt
git worktree add ../worktrees/session-d fix/orchestrator-prompt
```

### 2. Launch one Claude Code session per worktree

```bash
# Terminal 1 — Session A (Shell Scripts)
cd ../worktrees/session-a
claude --append-system-prompt "$(cat prompts/sessions/session-a-shell-scripts.md)"

# Terminal 2 — Session B (Message Atomicity)
cd ../worktrees/session-b
claude --append-system-prompt "$(cat prompts/sessions/session-b-msg-atomicity.md)"

# Terminal 3 — Session C (Worker Prompt)
cd ../worktrees/session-c
claude --append-system-prompt "$(cat prompts/sessions/session-c-worker-prompt.md)"

# Terminal 4 — Session D (Orchestrator Prompt)
cd ../worktrees/session-d
claude --append-system-prompt "$(cat prompts/sessions/session-d-orchestrator-prompt.md)"
```

Or just open each worktree in Claude Code and paste the prompt.

### 3. Merge when all sessions are done

```bash
# Order doesn't matter for conflicts (disjoint files), but logical order:
git merge fix/msg-atomicity          # Session B — foundational
git merge fix/shell-scripts          # Session A — infrastructure
git merge fix/worker-prompt          # Session C — behavior
git merge fix/orchestrator-prompt    # Session D — behavior
```

### 4. Run the smoke test (Finding #12)

See `session-e-smoke-test.md`.

## File ownership map

| Session | Branch | Files owned | Findings |
|---------|--------|-------------|----------|
| A | `fix/shell-scripts` | `setup.sh`, `teardown.sh` | #2, #3, #8 |
| B | `fix/msg-atomicity` | `bin/msg` | #7 |
| C | `fix/worker-prompt` | `prompts/WORKER.md` | #1 (worker half), #6 |
| D | `fix/orchestrator-prompt` | `prompts/ORCHESTRATOR.md` | #1 (orch half), #4, #5, #9, #10, #11 |
| E | (post-merge smoke test) | (none) | #12 |

## No conflicts guarantee

No two sessions touch the same file. Finding #1 is the only one split across
two sessions — it touches WORKER.md (Session C) and ORCHESTRATOR.md (Session D)
with complementary changes that don't conflict.
