You are fixing bugs in the Claude Code Fleet orchestrator — a system that spins up
1 Opus orchestrator + 3 DeepSeek workers to collaborate on a codebase via tmux
sessions and git worktrees.

## Your assignment

Branch: `fix/msg-atomicity`
You own ONLY this file:
- bin/msg

Other files (setup.sh, teardown.sh, prompts/ORCHESTRATOR.md, prompts/WORKER.md)
are owned by other sessions working in parallel. Do NOT touch them.

## Rules

1. **Stay in your lane.** Touch ONLY bin/msg.
2. **One commit per sub-fix.** Two commits total for finding #7.
3. **Minimal diffs.** Don't refactor or "improve" unrelated code.
4. **ShellCheck.** Run `shellcheck bin/msg` before committing.
5. **Verify.** After all fixes, re-read bin/msg to confirm coherence.

## Context

`bin/msg` is the inter-agent messenger. It takes a target tmux session name and
a message, types it into the target session via `tmux send-keys -l`, presses
Enter to submit, and appends a timestamped line to `$FLEET_DIR/comms.log`.

The script is invoked as: `msg <target-session> <message...>`

Key lines:
- Line 19: `line="[$sender -> $target] $*"`
- Line 23: `tmux send-keys -t "$target" -l "$line"`
- Line 24: `tmux send-keys -t "$target" Enter`
- Line 29: `printf '%s %s\n' "$(date '+%H:%M:%S')" "$line" >> "$coord/comms.log"`

## The finding you must fix

### Finding #7 — bin/msg doesn't guarantee the "one atomic line" property

**Two sub-problems:**

**(a) Embedded newlines break the one-message-one-line invariant.**
If `$*` contains an embedded newline (e.g. someone pastes a multi-line snippet
into a `msg` call), `tmux send-keys -l` types the literal newline, which submits
a partial line as its own Enter-terminated input in the target session. This
silently breaks the protocol.

**Fix (a):** Strip or reject embedded newlines before sending. Options:
- Replace newlines with spaces: `line="${line//$'\n'/ }"` after line 19
- Or fail loudly: if `$line` contains a newline, print error to stderr and exit 1

Pick the approach that's safest for protocol integrity. Stripping is more
forgiving; rejecting is stricter. For an inter-agent protocol, rejecting
(making it a hard error) is probably better — multiline content belongs in
task files, not messages.

**(b) Concurrent senders can mangle each other's lines.**
The send is two separate `tmux send-keys` commands (line 23: type the line,
line 24: press Enter). There's a window between them where a second concurrent
sender to the same target can inject text and mangle the line. The original
design brainstorm flagged this exact risk but never implemented a fix.

**Fix (b):** Wrap the two `send-keys` calls in a `flock` on a per-target
lockfile to make the send atomic across concurrent senders:
```bash
lockfile="$coord/.lock.$target"
exec {lock_fd}>"$lockfile" 2>/dev/null || true
flock -w 2 "$lock_fd" -c "tmux send-keys -t '$target' -l '$line'; tmux send-keys -t '$target' Enter" 2>/dev/null || {
  tmux send-keys -t "$target" -l "$line"
  tmux send-keys -t "$target" Enter
}
```
The fallback (if flock fails) preserves the existing behavior as a graceful
degradation. Keep it simple — `flock` is standard on Linux/macOS.

## Approach

1. Read bin/msg completely.
2. Fix (a) first — add newline detection/rejection after line 19.
3. Fix (b) second — add flock around lines 23-24.
4. Run `shellcheck bin/msg`.
5. Commit each sub-fix separately with messages like:
   - `fix: reject embedded newlines in msg payload (#7a)`
   - `fix: add flock to make msg send atomic per target (#7b)`
6. Do a final read of bin/msg.
