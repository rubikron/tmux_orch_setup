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

- **Two planes.** Control plane = a per-repo **supervisor** that runs each agent
  headless (`claude -p --input-format stream-json`) and delivers a one-line signal
  by writing to the target agent's stdin (via the `fleet-msg` command) — no tmux,
  and multiple fleets can run in different repos without clashing. Data plane =
  files: task specs in `$FLEET_DIR/tasks/`, results as git branches, state in
  `$FLEET_DIR/board.json`, an audit trail in `$FLEET_DIR/comms.log`. The legacy
  tmux transport is still available with `FLEET_TRANSPORT=tmux`. See
  [docs/transport-supervisor.md](docs/transport-supervisor.md).
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

- `git`, `python3`, and `claude` (Claude Code) on your PATH. (`tmux` only for the
  legacy `FLEET_TRANSPORT=tmux` mode.)
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

The agents run headless under the supervisor — there are no terminals to attach.
Watch the fleet through the dashboard or a status snapshot:

```bash
fleet-dashboard --open       # live web control panel
fleet-status                 # terminal snapshot
```

(For the legacy tmux transport, run `FLEET_TRANSPORT=tmux ./setup.sh ...` and
attach with `tmux attach -t orchestrator` / `worker1` …)

Tear down with `./teardown.sh /path/to/your/project` (keeps worker branches).

**Permission mode:** every session — orchestrator included — launches in auto
permission mode, so the fleet keeps moving while you're away instead of parking
on approval prompts. Only run it on a repo you're happy to have edited
unattended. To get per-action prompts back:

```bash
ORCHESTRATOR_PERMISSION_MODE=default ./setup.sh /path/to/your/project
```

`WORKER_PERMISSION_MODE` does the same for worker1-4.

## Kick it off

Send your goal to the **orchestrator** with `fleet-msg` (or the dashboard). It
will plan first (no coding), show a task breakdown, then start delegating:

```bash
fleet-msg orchestrator "GOAL: <one or two paragraphs — what to build, constraints, definition of done>. Follow your operating manual: plan first, then run your loop."
```

A fuller template:

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
- Assign via task spec files + one-line `fleet-msg` pointers. Review every branch
  before merging. Keep BOARD.md current.
- Stop and ask me if the goal is ambiguous or a task keeps failing review.

Start by giving me the plan.
```

## Files

```
fleet/
├── setup.sh              spin up worktrees + supervisor (or tmux) + 5 Claude Code agents
├── teardown.sh           kill sessions, remove worker worktrees
├── bin/
│   ├── msg               one-line inter-agent messenger — installed as `fleet-msg`
│   ├── status            live text dashboard — installed as `fleet-status`
│   ├── dashboard         live web control panel — installed as `fleet-dashboard`
│   └── learn             post-run analysis — installed as `fleet-learn`
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
| `fleet-status` | Live text dashboard: session health, task board, recent traffic, worker stats |
| `fleet-dashboard` | Live web control panel — a top-down operations map: the orchestrator and workers as status nodes wired together, each new message animating as a token gliding from sender to recipient, inbox queues, the task board, the merge queue, and a scannable activity log. Read-only; safe to run anytime. |
| `fleet-learn` | Post-run analysis: REVISE rates, worker utilization, task-size patterns, suggestions |

**Live web control panel:** `fleet-dashboard` serves an animated operations
map at `http://127.0.0.1:7373` (Ctrl-C to stop; `--port` to change, `--open`
to launch a browser). It polls the same coordination files `fleet-status`
reads — `board.json`, `comms.log`, `inbox/`, `claims.tsv`, `merge-queue` — so
every new message animates as a token gliding from sender to recipient, a
working agent's status dot goes green, a blocked one red, and undrained mail
stacks in each node's inbox. Pure Python stdlib, no dependencies, no build step.

**Metrics:** The orchestrator appends one JSON line per task to `.fleet/metrics.jsonl`.
After teardown, run `fleet-learn` to analyze the run and append findings to
`.fleet/learnings.md`. The orchestrator reads prior learnings on startup and
incorporates them into its planning.

**Prompt versions:** Each prompt file carries a version header (`<!-- version: X.Y.Z -->`).
When you edit a prompt, bump the version so `fleet-learn` can correlate changes with outcomes.

## Tuning notes

- **Step size is where quality lives.** Too big and DeepSeek workers flail; too
  small and coordination is slower than doing it directly. The orchestrator
  manual biases toward one-file / one-function steps with exact signatures.
- **Watch `comms.log`** in a fifth pane (`tail -f $FLEET_DIR/comms.log`) to see
  the whole team's traffic at a glance.
- **Busy workers queue input.** A message sent to a worker mid-task lands in its
  input queue and is picked up when it finishes the current turn.
```
