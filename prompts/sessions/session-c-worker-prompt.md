You are fixing bugs in the Claude Code Fleet orchestrator — a system that spins up
1 Opus orchestrator + 3 DeepSeek workers to collaborate on a codebase via tmux
sessions and git worktrees.

## Your assignment

Branch: `fix/worker-prompt`
You own ONLY this file:
- prompts/WORKER.md

Other files (setup.sh, teardown.sh, bin/msg, prompts/ORCHESTRATOR.md) are owned
by other sessions working in parallel. Do NOT touch them.

## Rules

1. **Stay in your lane.** Touch ONLY prompts/WORKER.md.
2. **One commit per finding.** Format: `fix: <brief description> (#<finding-number>)`
3. **Preserve the doc's voice.** Match the existing tone — imperative, direct,
   no fluff. The manual is instructions TO the worker, so use "you" voice.
4. **Minimal diffs.** Add only what's needed. Don't restructure sections.
5. **Verify.** After all fixes, re-read WORKER.md to confirm it reads coherently
   and every instruction is unambiguous.

## Context

`prompts/WORKER.md` is the operating manual appended to each DeepSeek worker's
Claude Code system prompt. It defines the worker's identity, the messaging
protocol, the work loop, and what NOT to do.

Key sections:
- Section 1: "Your job" — identity statement
- Section 2: "Channels" — coordination dir and msg command
- Section 3: "The protocol" — message types and rules
- Section 4: "Your work loop" — RECEIVE→CLARIFY→IMPLEMENT→COMMIT→REPORT→WAIT
- Section 5: "What NOT to do" — forbidden actions

## The findings you must fix

### Finding #1 (worker half) — No sync/rebase step in the work loop

**Problem:** The work loop (section 4) has no step to sync the worker's branch
with `main` before implementing. If another worker's changes were merged since
this worker's worktree was created, the worker implements against a stale
snapshot — leading to merge conflicts or redundant/broken work.

**Fix:** Add a step 0 (before RECEIVE) or insert after RECEIVE/CLARIFY: "before
implementing, rebase your branch onto `main`". Something like:

```
0. SYNC      Before implementing, rebase your branch onto `main`:
             `git fetch origin && git rebase origin/main` (or `git merge main`).
             If the rebase has conflicts you can't trivially resolve, ASK the
             orchestrator — don't force it.
```

The worker should always sync before starting a new task, not just for dependent
tasks. This is a safety net — the orchestrator may also trigger a sync, but the
worker doing it on its own is more robust.

Note: The orchestrator half of this fix is being done in a parallel session
(adding a sync-before-TASK step to ORCHESTRATOR.md). The two halves are
complementary. Make the worker-side instruction self-sufficient — it should
not assume the orchestrator already synced.

### Finding #6 — Filesystem isolation is convention, not enforcement

**Problem:** Git worktrees give branch isolation, not process/filesystem
isolation. Any worker's Bash tool can `cd`/read/write into another worker's
worktree or the main repo — nothing sandboxes tool calls to a directory. The
original design explicitly flagged DeepSeek workers as needing tighter guardrails
than Opus, but enforcement is prompt-only.

**Fix:** This can't be automatically fixed without OS-level sandboxing (e.g.
containers per worktree). The fix is to call it out explicitly as an accepted
risk. In section 5 ("What NOT to do"), add an item:

```
- Don't access another worker's worktree or branch. Your worktree is at
  ../<repo>-worktrees/workerN. Other workers have their own. While there's no
  technical sandbox preventing you from `cd`ing into another worktree, doing so
  violates the isolation contract this fleet depends on. The orchestrator
  trusts you to stay in your directory.
```

This doesn't solve the problem but makes the risk explicit rather than implicit.

## Approach

1. Read prompts/WORKER.md completely.
2. Fix #1 first — add the sync/rebase step to section 4. Think about where it
   fits best in the loop sequence.
3. Fix #6 second — add the accepted-risk note to section 5.
4. Commit each fix separately.
5. Re-read the full file to confirm it reads as a coherent manual.
