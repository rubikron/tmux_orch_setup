# Finding #12 — Smoke Test: Input-Queue-While-Busy Verification

This is a verification task, not a code change. Run this after all other branches
are merged to `main`.

## The assumption under test

The entire `msg`/send-keys architecture rests on the assumption that Claude Code
**queues input typed mid-turn** rather than dropping or garbling it. This was
flagged as untested in the original design conversation and has never been
verified.

## Smoke test procedure

### Setup

1. Start a fresh Claude Code session (any model, any directory):
   ```bash
   claude
   ```

2. Give it a long-running task that will keep it busy for at least 30-60 seconds.
   Something that requires reading files and thinking:
   ```
   Read every file in this directory recursively and produce a detailed summary
   of what each file does. Take your time and be thorough — I want a paragraph
   per file.
   ```

### Test

3. While Claude Code is mid-turn (actively processing, not waiting for your input),
   open a second terminal and send it a message via `tmux send-keys`:
   ```bash
   # Find the tmux session name (usually something like "claude-<pid>")
   tmux list-sessions

   # Send a test message mid-turn
   tmux send-keys -t <session-name> "What is 2+2? Answer with just the number."
   tmux send-keys -t <session-name> Enter
   ```

4. Observe what happens. There are three possible outcomes:
   - **✅ QUEUED (good):** The message silently queues. After the current turn
     finishes and Claude prints its response, the "What is 2+2?" message appears
     as the next user input, and Claude responds "4" in a fresh turn.
   - **⚠️ GARBLED (bad):** The message text interleaves into the current output
     mid-stream, mangling both the output and the input.
   - **❌ DROPPED (bad):** The message disappears entirely — never appears in
     output and never triggers a response.

### Verify

5. Run the test at least 3 times on different session states:
   - During a long read/analysis turn
   - During a tool execution turn (e.g. while Bash is running)
   - During idle (control: should always work when idle)

### Document

6. Record the results in `SMOKE_TEST_RESULTS.md`:
   - Which model was running (Opus/Sonnet/Haiku/DeepSeek)
   - Claude Code version (`claude --version`)
   - Outcome for each test scenario
   - Any observations (latency, partial rendering, etc.)

## If the test fails

If messages are garbled or dropped, the `msg`/send-keys approach is fundamentally
broken for mid-turn delivery. Mitigations to consider:
- Only send messages when `comms.log` shows the target recently became idle
- Use a file-based polling fallback (worker watches a file for new tasks)
- Switch to a different IPC mechanism (Unix sockets, named pipes)
