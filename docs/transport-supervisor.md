# Supervisor Transport (Option A) — replacing tmux with headless stream-json

**Status:** design + reference for the `feat/supervisor-transport` branch.
**Goal:** run the orchestrator + DeepSeek workers without tmux, so multiple
fleets can run in different repos at once without clashing, and the monitoring
dashboard becomes easier to build and extend.

---

## 1. Why

The fleet drives five interactive Claude Code REPLs. tmux is used to (a) host a
PTY for each REPL and (b) simulate a human typing a "user turn" into a running
REPL (`tmux send-keys`). That coupling causes three problems:

1. **Fragile transport.** `bin/msg` types into another session's input line. It
   has to special-case a leading `/`, reject embedded newlines, and `flock`
   around two `send-keys` calls so concurrent senders don't interleave.
2. **Global names.** tmux session names (`orchestrator`, `worker1`…) live in one
   tmux server, so two fleets in two repos collide.
3. **REPL-shaped observability.** Liveness is `tmux has-session`; deep inspection
   is `tmux capture-pane` screen-scraping.

Crucially, **the dashboard is already file-based** — `bin/dashboard` parses
`board.json`, `comms.log`, `inbox/`, `claims.tsv`, `merge-queue`,
`metrics.jsonl`, and a `topology` file. It only touches tmux for liveness, and
it *already* understands a non-tmux `native` mode. So this change is about the
**transport and the launcher**, not the monitoring layer.

### What tmux actually does here

| Job | Where | Replacement |
| --- | --- | --- |
| Host a PTY so the interactive REPL runs detached | `setup.sh` `new-session` | Headless `claude -p` subprocess (no PTY needed) |
| Deliver a user turn into a *running* agent | `bin/msg` `send-keys` | Write one JSON line to the agent's stdin (held by the supervisor) |
| Liveness check | `bin/status`, `bin/dashboard` | `live.json` written by the supervisor |
| Manual deep inspection | orchestrator prompt `capture-pane` | `events/<agent>.jsonl` + dashboard |

Why an inbox file alone did **not** work (the earlier `inbox-transport` attempt):
an agent sitting in a REPL cannot poll an inbox — it only acts when handed a
turn, and only tmux could hand it one. The fix is to stop using the interactive
REPL entirely and run each agent in **headless streaming mode**, where handing it
a turn is just writing to a pipe.

---

## 2. Approach: headless stream-json + a per-repo supervisor

Each agent runs as:

```
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --permission-mode bypassPermissions \
  --append-system-prompt "<role prompt>"
```

`--input-format stream-json` is **realtime streaming input**: the process stays
alive while stdin is open, and every newline-delimited JSON user message becomes
one turn. This is the exact `send-keys` replacement, minus the fragility.

A single **supervisor** process per repo owns all the agents:

```
                         ┌──────────────────────────────────────────┐
                         │            bin/supervisor  (1 per repo)   │
                         │                                           │
  fleet-msg  ──POST /msg─▶  control HTTP (127.0.0.1:<auto port>)     │
                         │        │                                  │
                         │        ▼   write stdin line               │
                         │   ┌────────┐  ┌────────┐  ┌────────┐ ...  │
                         │   │ orch   │  │worker1 │  │worker4 │      │
                         │   │claude -p│ │claude -p│ │claude -p│     │
                         │   └───┬────┘  └───┬────┘  └───┬────┘      │
                         │       │ stdout(json events)   │          │
                         │       ▼           ▼           ▼          │
                         │   reader threads → events/<agent>.jsonl  │
                         │                  → comms.log (on deliver)│
                         │                  → live.json (heartbeat) │
                         └──────────────────────────────────────────┘
                                         │ files
                                         ▼
                           bin/dashboard / bin/status  (read-only)
```

- **Delivering a turn** = supervisor writes a stream-json `user` line to the
  target agent's stdin. No PTY, no typing, no `/`-handling, no newline hazard.
- **Observing** = reader threads already receive every `assistant` / `tool_use`
  / `result` event on stdout; they persist them and update liveness. Richer than
  scraping a pane.
- **Naming** = the supervisor addresses agents by name *inside its own process*.
  There are no global handles, so two repos never collide.

---

## 3. Wire protocol

### 3.1 Agent stdin (supervisor → agent), one JSON object per line

```json
{"type":"user","message":{"role":"user","content":"[orchestrator -> worker1] TASK t-014: read .fleet/tasks/t-014.md"}}
```

The `content` string is the same human-readable line the fleet already uses, so
the agent-facing protocol (TASK/DONE/BLOCKED/…) is unchanged.

### 3.2 Agent stdout (agent → supervisor), stream-json events

Confirmed empirically. Types the supervisor cares about:

| `type` | meaning | supervisor action |
| --- | --- | --- |
| `system` / `init` | session id, model, cwd | record session id |
| `assistant` | `message.content: [{type:"text",text}｜{type:"tool_use",name,input}]` | append to `events/<agent>.jsonl`, update "last activity" |
| `result` / `success` | turn finished: `result` text, `is_error`, `usage`, `total_cost_usd`, `num_turns` | mark agent idle, roll up usage |
| `rate_limit_event` | throttling | surface on dashboard |

### 3.3 Control channel (fleet tools → supervisor), HTTP on loopback

The supervisor writes `$FLEET_DIR/supervisor.json` on startup:

```json
{"host":"127.0.0.1","port":54123,"pid":8842,"token":"<random>","agents":["orchestrator","worker1","worker2","worker3","worker4"]}
```

- `POST /msg`  `{"from":"worker1","to":"orchestrator","text":"DONE t-014"}`
  → validates `to`, writes the stdin line, appends to `comms.log`, returns
  `{"ok":true}`. Requires header `X-Fleet-Token`.
- `GET /state` → per-agent `{alive,pid,idle,last_activity,session_id,turns,cost}`.
- `GET /events?agent=&since=` → recent parsed events (optional; dashboard convenience).

The token is a loopback-only guard so a stray process can't inject turns.

---

## 4. Files & contracts (all under `$FLEET_DIR`)

| File | Writer | Reader | Purpose |
| --- | --- | --- | --- |
| `supervisor.json` | supervisor | msg, status, dashboard | control endpoint + agent roster |
| `agents.json` | setup.sh | supervisor | launch manifest (name, cwd, prompt, env, model, permission mode) |
| `live.json` | supervisor (heartbeat) | status, dashboard | `{name:{alive,pid,idle,last_activity}}` liveness |
| `topology` | setup.sh | dashboard | `name=supervisor` per agent (existing `native`-style contract) |
| `comms.log` | supervisor (on each delivered `/msg`) | dashboard, status | **unchanged format** `<ts> [from -> to] body` |
| `events/<agent>.jsonl` | supervisor reader threads | dashboard (optional) | full per-agent activity stream |
| `board.json`, `claims.tsv`, `merge-queue`, `metrics.jsonl` | agents (via `bin/board` etc.) | dashboard, status | **unchanged** |

The only *new* files are `supervisor.json`, `agents.json`, `live.json`, and
`events/`. Everything the dashboard already reads keeps its format, so the
monitoring layer needs only its liveness source swapped.

---

## 5. Identity

`bin/msg` and `bin/submit` derive the sender from `tmux display-message -p '#S'`.
In supervisor mode each agent subprocess is launched with `FLEET_AGENT=<name>` in
its env, so the tools read `${FLEET_AGENT:-human}` instead. No tmux call.

---

## 6. Multi-repo isolation (the clash fix)

Nothing is global. Each repo's `setup.sh` starts its own supervisor, which:

- binds to an **OS-assigned free port** (`port 0`) and advertises it in that
  repo's `$FLEET_DIR/supervisor.json`;
- addresses its agents by name only within its own process — no shared registry;
- serves its dashboard on its own auto/assigned port.

Run ten fleets in ten repos simultaneously: ten supervisors, ten sets of pipes,
zero name collisions. `fleet-msg` always resolves the *local* `$FLEET_DIR`, so a
message can only ever reach the fleet it belongs to.

---

## 7. Behavioral differences from the tmux model (read before running)

1. **Turns are event-driven, not self-looping.** A headless agent runs one turn
   per delivered message, then goes idle until the next message. This matches how
   the fleet already works (workers act on `TASK`, the orchestrator acts on
   `DONE`/`BLOCKED`), but an orchestrator that wants to "keep making progress"
   with no inbound message will *not* spontaneously wake. If we need periodic
   nudges, the supervisor can inject a `tick` message to an idle agent that still
   owns open work. **MVP is purely event-driven**; heartbeat nudging is a
   documented follow-on.
2. **No `tmux attach` hand-steering.** You observe and steer through the
   dashboard (and `events/<agent>.jsonl`) instead of attaching a terminal. A
   "send message" box on the dashboard replaces typing into a pane. (The MVP
   ships the read path; the send box is a small follow-on that just calls
   `POST /msg`.)
3. **Permissions must be non-interactive.** Headless agents can't answer prompts,
   so workers run `--permission-mode bypassPermissions`. They already run
   unattended in isolated worktrees; this is the headless equivalent of the
   current `--permission-mode auto`. Configurable per role via `agents.json`.
4. **Session persistence is implicit.** Each agent is one long-lived process =
   one conversation for the life of the fleet. No `--resume` juggling. If a
   process dies, the supervisor marks it not-alive and can respawn (respawn =
   follow-on; MVP reports death).

---

## 8. Migration & backward compatibility

The branch keeps the tmux path working so the two can be compared side by side:

- `setup.sh` gains `FLEET_TRANSPORT=supervisor|tmux` (default `supervisor` on
  this branch). tmux mode is the old code path, untouched.
- `bin/msg`, `bin/submit`, `bin/status`, `bin/dashboard` **auto-detect**: if
  `$FLEET_DIR/supervisor.json` exists they use the supervisor; otherwise they
  fall back to tmux. No agent-facing command changes — `fleet-msg`,
  `fleet-submit`, `fleet-status` are identical to type.

`teardown.sh` stops the supervisor (SIGTERM → it closes every agent's stdin and
terminates the children) in supervisor mode, and kills tmux sessions in tmux
mode.

---

## 9. Out of scope for the MVP (follow-ons)

- Heartbeat / idle-nudge injection for autonomous orchestrator progress.
- Dashboard "send message" box and live event stream over SSE/WebSocket.
- Automatic respawn of a dead agent.
- The full **Agent SDK** rewrite (Option B): fold orchestrator + workers into one
  host app with an in-memory event bus. The supervisor speaks the same
  stream-json events, so A → B is an incremental migration later.
