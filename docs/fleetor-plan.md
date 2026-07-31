# fleetor — Desktop app for the Claude Code Fleet

> Implementation plan. Approved 2026-07-30. To be built by a follow-up session on
> branch `feat/fleetor-desktop`. Nothing here is implemented yet — this doc is the spec.

## Context

Today, launching a fleet is a multi-step CLI ritual: `export DEEPSEEK_API_KEY`, run
`./setup.sh /path/to/repo` (spawns a detached supervisor + 5 headless `claude` agents),
then separately run `fleet-dashboard --open` (a browser tab) to watch, and open a
terminal to type `fleet-*` commands or `fleet-msg orchestrator "GOAL: ..."`. The pieces
are all decoupled and file/HTTP-based, but the user experience is scattered across a
shell, a browser, and terminal windows.

**Goal:** wrap all of this into one modern desktop app ("meta harness") where a user
picks a target directory and spawns a cluster with a button, then sees three cohesive
regions in a single window:
1. **Operations map** — the whole orchestrator/worker/ticket/merge-queue view (what the
   web dashboard shows today).
2. **Orchestrator chat** — talk to the orchestrator with live streaming replies (what the
   dashboard's side panel does).
3. **Terminal** — a real shell inside the app, cwd = target repo, so users never leave.

First milestone: a **runnable-in-dev** Electron app that does everything the current
dashboard does, presented cohesively, plus the embedded terminal and one-button spawn.

## Key facts the design relies on (verified during planning)

- `setup.sh <repo>` is the single spawn entry point (positional arg = target repo; reads
  `DEEPSEEK_API_KEY` from env/`.env`/`.env.local`). `teardown.sh <repo>` stops it.
- Spawn launches a **detached supervisor** (`bin/supervisor`, Python stdlib) that owns 5
  `claude -p --input-format stream-json ...` subprocesses and advertises a loopback HTTP
  endpoint + token in `<repo>/.fleet/supervisor.json`.
- `bin/dashboard` (Python `http.server`, default :7373) is a **read-only JSON/SSE API over
  `.fleet/`** plus a self-contained HTML page. Endpoints we reuse:
  - `GET /api/state` — full snapshot (sessions/liveness, tasks, messages w/ `seq`, inbox,
    claims, merge queue, counts). Poll ~1.2s.
  - `GET /api/chat?agent=<name>&since=<n>` — chat backfill `{messages,total}`.
  - `GET /api/chat/stream?agent=<name>&since=<n>` — **SSE** tail of `events/<agent>.jsonl`
    (raw Claude stream-json lines for live token typing).
  - `POST /api/chat {to,text}` — forwards to the supervisor's `/msg` (token-authed);
    reply arrives asynchronously via the SSE tail.
- The map + streaming chat in `bin/dashboard` are **vanilla JS with no libraries** (SVG map;
  hand-rolled stream-json parser `handleStreamEvent` + markdown `renderRichText`). "Rebuild
  natively" = **port this vanilla JS into modular renderer files under a new cohesive layout**,
  not a from-scratch reimplementation.

## Approach

**Electron app in a new `fleetor/` subdirectory. Reuse the Python backend unchanged** —
the app orchestrates `setup.sh`/`teardown.sh` and runs `bin/dashboard` headless as its
JSON/SSE API. The renderer is a fresh, cohesive 3-pane UI that ports the existing map/chat
JS and adds an xterm.js terminal wired to node-pty.

Nothing in `bin/`, `setup.sh`, `teardown.sh`, or the supervisor changes (one optional tiny
tweak below). The app is a pure wrapper — keeps the backend reusable from CLI too.

### File layout (all new, under `fleetor/`)

```
fleetor/
├── package.json              # electron, node-pty, @electron/rebuild; scripts: start
├── electron/
│   ├── main.js               # app/window lifecycle, IPC wiring
│   ├── preload.js            # contextBridge: safe renderer API (no nodeIntegration)
│   ├── fleet-manager.js      # run setup.sh/teardown.sh; own the dashboard server subprocess; pick free port; report state
│   └── pty-manager.js        # node-pty sessions keyed by id; data/exit events over IPC
└── renderer/
    ├── index.html            # 3-region shell
    ├── styles.css            # cohesive modern dark theme (design tokens)
    ├── app.js                # top bar (dir picker, Spawn/Stop, status chips); /api/state polling; layout
    ├── map.js                # ops map: SVG nodes + animated message tokens + task board + merge queue + activity log  (PORT of bin/dashboard map JS)
    ├── chat.js               # orchestrator chat: backfill + SSE stream-json render + markdown  (PORT of handleStreamEvent/renderRichText)
    ├── terminal.js           # xterm.js <-> pty-manager over IPC
    └── vendor/               # xterm.js + xterm.css, bundled locally (offline, matches project's zero-CDN norm)
```

### Main process (`electron/`)

- **fleet-manager.js**
  - `pickDirectory()` → native `dialog.showOpenDialog` (directories only).
  - `spawn(repoPath, {deepseekKey})` → `child_process.spawn('bash', [<kit>/setup.sh, repoPath], {env})`
    with `DEEPSEEK_API_KEY` injected (from a settings field, else inherited/.env). Stream stdout/stderr
    to the renderer as a spawn log. Poll for `<repoPath>/.fleet/supervisor.json` (mirrors setup.sh's own
    wait) to confirm up. **Never log the key.**
  - On success, start the dashboard API: `spawn('python3', [<kit>/bin/dashboard, '--port', <freePort>], {env:{FLEET_DIR:<repo>/.fleet}})`.
    **Always pick a free `<freePort>` dynamically** by binding a `net.Server` to port 0, reading the
    assigned port, closing it, then passing that port to `bin/dashboard`. **Never hard-code or assume a
    port, and explicitly never use 7373** (see the port-safety rule below). Retry on a fresh free port if
    the spawn fails with an address-in-use error. Expose the chosen port to the renderer.
  - `stop(repoPath)` → run `teardown.sh <repoPath>`, then kill **only the dashboard subprocess this app
    started** (tracked by its child-process handle/PID).
  - Kill only the child processes this app spawned, on app quit. See the port-safety rule below.

- **Port safety (CRITICAL — the developer runs their own fleet on :7373 during dev):**
  - The app **must never bind, probe-to-kill, or shut down port 7373**, and must never kill any process
    it did not itself spawn. A separate, already-working orchestrator + `fleet-dashboard` is expected to
    be running on :7373 throughout development — leave it completely untouched.
  - Track every child process (`setup.sh`, `teardown.sh`, the dashboard server, ptys) by its own handle.
    Stop/quit only ever terminates those tracked handles — never a `pkill`/port-scan-and-kill.
  - The app's dashboard server always runs on its own dynamically-assigned free port (0-bind), so it can
    coexist with the :7373 instance without any conflict.
- **pty-manager.js** — `node-pty.spawn(shell, [], {cwd: repoPath, env})` where env prepends
  `~/.local/bin` to PATH and sets `FLEET_DIR=<repo>/.fleet`, `FLEET_AGENT=human` so the `fleet-*`
  commands resolve exactly as documented. Forward `onData`→renderer and renderer input→`pty.write`;
  handle resize (`pty.resize`) and exit.
- **main.js / preload.js** — `contextBridge.exposeInMainWorld('fleet', {...})` exposing:
  `pickDirectory, spawn, stop, onSpawnLog, getDashboardPort, ptyStart/Write/Resize/onData/onExit`.
  Keep `contextIsolation: true`, `nodeIntegration: false`.

### Renderer (`renderer/`) — cohesive 3-region layout

- **Top bar:** app title, target repo path + **Open…** picker, **Spawn**/**Stop** buttons, and
  live status chips derived from `/api/state`: supervisor up/down, `N/5` agents alive, total cost,
  and queued/active/blocked/merged counts. A settings popover for the DeepSeek key (optional; falls
  back to `.env.local`).
- **Operations pane (main):** port the `bin/dashboard` map JS — orchestrator + worker1-4 + HUMAN as
  status nodes, SVG wiring, new `comms.log` messages animating as tokens (seq-based dedup), task board,
  merge queue, and the activity log. Data from `GET /api/state` on the dashboard port (poll ~1.2s).
- **Chat pane:** port the dashboard chat — agent selector (default `orchestrator`), streaming markdown
  transcript, input box. On open: `GET /api/chat?...&since=0` backfill, then `EventSource(/api/chat/stream?...)`
  for live token typing (`stream_event` deltas → live markdown via ported `renderRichText`). Send:
  `POST /api/chat {to,text}`; reply streams back through the SSE tail. `EventSource`/`fetch` work
  directly in the renderer against `127.0.0.1:<dashboardPort>`.
- **Terminal pane (collapsible/tabbed):** xterm.js instance wired through `pty-manager`. First terminal
  auto-opens with cwd = target repo once a cluster is up.
- Layout is resizable panes; modern dark theme with shared design tokens (`styles.css`). Empty states
  before a cluster is spawned (e.g. "Pick a repo and press Spawn").

### Reuse (do not reimplement)

- Backend entirely: `setup.sh`, `teardown.sh`, `bin/supervisor`, `bin/dashboard`, all `fleet-*` tools.
- Map algorithm + chat stream-json parsing + markdown renderer: **copy the vanilla JS** from
  `bin/dashboard`'s `PAGE` string (`build_state` consumer, `handleStreamEvent`, `onBlockStart/Delta`,
  `renderRichText`, `mdInline`) into `map.js` / `chat.js`, then restyle. This is the crux of "rebuild
  natively" while guaranteeing feature parity.

### Optional tiny backend tweak (only if convenient)

`bin/dashboard` binds `127.0.0.1` and default :7373. We pass `--port <free>` (already supported), so no
change is required. If we want to suppress its HTML page entirely we could add an `--api-only` flag, but
it's unnecessary — the renderer simply ignores `/`.

## Risks / notes

- **node-pty is a native module** — must be rebuilt against Electron's ABI (`@electron/rebuild` in a
  `postinstall`, or use electron-forge). Budget time for this; it's the one non-trivial toolchain step.
- **Prereqs:** Node/npm (new to this repo), plus the existing `python3`/`git`/`claude` and
  `DEEPSEEK_API_KEY`. `~/.local/bin` must be on the terminal PATH for `fleet-*` (setup.sh already warns).
- **Secret hygiene:** the DeepSeek key is passed as an env var to `setup.sh` and never written to logs,
  the spawn-log pane, or committed files. `.gitignore` the app's local state.
- Orchestrator is event-driven (won't self-wake without a message) — existing behavior, unchanged.
- Single active cluster for the first milestone; the dashboard-port/free-port design already leaves room
  for a multi-cluster switcher later.

## Verification (end-to-end)

0. **Coexistence precondition:** assume a developer-owned fleet + `fleet-dashboard` is already running on
   **:7373** against a different repo. It must remain fully up and untouched through the entire test — the
   app must never bind, probe, or kill 7373. Confirm the app picks its own free port (not 7373) and that
   7373 is still serving after every Spawn/Stop/quit.
1. `cd fleetor && npm install && npm start` → app window opens with empty states.
2. **Open…** → pick a *separate* scratch repo (e.g. `test-projects/…`), not the :7373 dev repo.
3. Ensure `DEEPSEEK_API_KEY` is available (`.env.local` exists in the kit root) → press **Spawn**.
   Spawn log streams `setup.sh` output; status chips flip to "supervisor up, 5/5 alive" once
   `.fleet/supervisor.json` appears.
4. **Operations pane** shows the 6 nodes; **chat pane** backfills. Send
   `GOAL: <small task>` to the orchestrator → verify streaming markdown reply renders token-by-token
   and the map animates message tokens / task board updates.
5. **Terminal pane:** run `fleet-status` and `fleet-board list` → confirm they resolve and show live state.
6. Press **Stop** → `teardown.sh` runs, supervisor/agents exit, dashboard subprocess is killed, worktrees
   removed (worker branches kept). Quitting the app also cleans up child processes.
