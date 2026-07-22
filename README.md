# Claude Code Fleet — 1 Opus orchestrator + 3 DeepSeek workers

Spin up four Claude Code sessions that work a project in parallel: an **Opus
tech lead** that architects and delegates (never codes), and **three DeepSeek
workers** that implement. They coordinate through short tmux messages and a
shared coordination directory. Reusable for any git project.

```
                 ┌───────────────────────────┐
                 │   orchestrator  (Opus)     │  plans, delegates,
                 │   main repo, branch main   │  reviews, merges
                 └───────────┬───────────────┘
          TASK / ANS / REVISE│  DONE / ASK / BLOCKED
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │ worker1  │◄─ASK──►│ worker2  │◄─ASK──►│ worker3  │   DeepSeek,
   │ wt / w1  │  FYI   │ wt / w2  │  FYI   │ wt / w3  │   own worktrees
   └──────────┘        └──────────┘        └──────────┘
        all traffic mirrored to $FLEET_DIR/comms.log
```

## How it works

- **Two planes.** Control plane = tmux `send-keys` (short one-line signals via the
  `msg` command). Data plane = files: task specs in `$FLEET_DIR/tasks/`, results
  as git branches, state in `$FLEET_DIR/BOARD.md`, an audit trail in
  `$FLEET_DIR/comms.log`.
- **Isolation via git worktrees.** Each worker has its own working tree on its own
  branch, so they can't clobber each other. The orchestrator reviews `git diff`
  and merges to `main`.
- **Messaging protocol.** A small fixed vocabulary — `TASK ASK ANS DONE BLOCKED
  REVISE FYI`. No bare acknowledgments. Peers may ask each other directly but
  escalate to the lead after 2 unresolved round-trips.
- **Assignment logic.** One worker by default; fan out only for genuinely
  independent, non-trivial parallel work; serialize same-file steps; hold
  dependent steps until their inputs merge.

## Prerequisites

- `tmux`, `git`, and `claude` (Claude Code) on your PATH.
- Your normal Claude Code auth for the Opus orchestrator.
- A DeepSeek API key for the workers: `export DEEPSEEK_API_KEY=sk-...`
  (workers use DeepSeek's Anthropic-compatible endpoint, so real Claude Code —
  no Anthropic API needed).
- Confirm the worker model name is current (`WORKER_MODEL`, default
  `deepseek-v4-pro`) — DeepSeek's model names change; check their docs.

## Spin up

```bash
export DEEPSEEK_API_KEY=sk-...
./setup.sh /path/to/your/project        # defaults to the current dir
```

Then open four terminal windows and attach one session in each:

```bash
tmux attach -t orchestrator
tmux attach -t worker1
tmux attach -t worker2
tmux attach -t worker3
```

Tear down with `./teardown.sh /path/to/your/project` (keeps worker branches).

## Kick it off

Paste your goal into the **orchestrator** window. It will plan first (no coding),
show you a task breakdown, then start delegating. A template:

```
PROJECT GOAL
------------
<one or two paragraphs: what to build, constraints, definition of done>

Follow your operating manual:
- Plan first. Read the codebase, restate the goal, produce an architecture
  sketch and an ordered task breakdown, write BOARD.md, and show me the plan
  before assigning anything.
- Then run your loop. Default to a single worker for small/simple work; fan
  out only for genuinely independent, non-trivial parallel parts.
- Assign via task spec files + one-line `msg` pointers. Review every branch
  before merging. Keep BOARD.md current.
- Stop and ask me if the goal is ambiguous or a task keeps failing review.

Start by giving me the plan.
```

## Files

```
fleet/
├── setup.sh              spin up worktrees + tmux + 5 Claude Code sessions
├── teardown.sh           kill sessions, remove worker worktrees
├── bin/
│   ├── msg               one-line inter-agent messenger (send-keys + comms.log)
│   ├── status            live fleet dashboard (sessions, tasks, traffic)
│   └── learn             post-run analysis (metrics → learnings.md)
├── prompts/
│   ├── ORCHESTRATOR.md   Opus tech-lead operating manual
│   ├── WORKER.md         DeepSeek implementer operating manual
│   └── UI_TESTER.md      Sonnet UI testing specialist manual
└── README.md             this file
```

## Observability

The fleet records structured metrics and supports live monitoring:

| Command | Description |
|---------|-------------|
| `bin/status` | Live dashboard: session health, task board, recent traffic, worker stats |
| `bin/learn` | Post-run analysis: REVISE rates, worker utilization, task-size patterns, suggestions |

**Metrics:** The orchestrator appends one JSON line per task to `.fleet/metrics.jsonl`.
After teardown, run `bin/learn` to analyze the run and append findings to
`.fleet/learnings.md`. The orchestrator reads prior learnings on startup and
incorporates them into its planning.

**Prompt versions:** Each prompt file carries a version header (`<!-- version: X.Y.Z -->`).
When you edit a prompt, bump the version so `bin/learn` can correlate changes with outcomes.

## Tuning notes

- **Step size is where quality lives.** Too big and DeepSeek workers flail; too
  small and coordination is slower than doing it directly. The orchestrator
  manual biases toward one-file / one-function steps with exact signatures.
- **Watch `comms.log`** in a fifth pane (`tail -f $FLEET_DIR/comms.log`) to see
  the whole team's traffic at a glance.
- **Busy workers queue input.** A message sent to a worker mid-task lands in its
  input queue and is picked up when it finishes the current turn.
```
