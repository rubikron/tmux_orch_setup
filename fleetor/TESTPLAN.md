# fleetor — Manual Test Plan

> Human-run interactive checklist. Derived from `docs/fleetor-plan.md` §Verification (steps 0–6).
> Automated checks (toolchain, static IPC/contract audit, port-safety scan, headless DOM/console
> smoke) already ran as part of t-008 — see the findings report for details. This plan covers what
> only a human eye/hand can confirm: a real Spawn/Stop against a live cluster, live streaming
> markdown, and interactive terminal use.

## Precondition — :7373 coexistence

- [ ] Confirm a developer-owned fleet + dashboard is already running on **:7373** against a
      *different* repo: `curl -s http://127.0.0.1:7373/api/state | head -c 200` should return JSON.
- [ ] Keep it running for the entire test below. **Never** stop, restart, or otherwise touch it —
      fleetor must coexist with it, not manage it.

## 0. Install & launch

- [ ] `cd fleetor && npm install && npm start`
- [ ] App window opens titled "fleetor"; 3-pane shell visible (Operations / Chat / Terminal), all
      empty states shown (no repo selected, **Spawn** disabled, **Stop** disabled).
- [ ] :7373 still responds (repeat the curl above).

## 1. Open a scratch repo

- [ ] Click **Open…** and pick a *separate* scratch repo under `test-projects/` — **not** the repo
      the :7373 dashboard is watching. `test-projects/chess` (kit root) is a pre-built sandbox for
      this: a small Python chess repo currently sitting clean at git tag `sandbox-baseline`. If it's
      dirty or has `.fleet`/`.worktrees` residue from a prior run, reset it first:
      `cd test-projects/chess && git checkout master && git reset --hard sandbox-baseline`.
- [ ] Repo path appears in the top bar; **Spawn** becomes enabled.

## 2. Spawn

- [ ] Ensure `DEEPSEEK_API_KEY` is available (`.env.local` at the kit root), or type it into the
      ⚙ **Settings** popover before spawning.
- [ ] Click **Spawn**. The spawn-log pane appears and streams `setup.sh` stdout/stderr live.
- [ ] Confirm the DeepSeek key **never appears** in the spawn-log text, even if you typed it into
      Settings (it should show as redacted/absent, not plaintext).
- [ ] Status chips flip to "supervisor up" and "N/5 alive" (working toward 5/5) once
      `.fleet/supervisor.json` exists in the scratch repo — may take up to ~2 min.
- [ ] :7373 still responds and is unaffected — the app must be using its **own** dynamically
      chosen port, never 7373 (check the URL a network tab / devtools would show for `/api/state`
      polls, if you want to confirm the exact port).

## 3. Operations pane + Chat backfill

- [ ] Operations pane shows 6 nodes (orchestrator, worker1–4, plus the door/HUMAN marker) with SVG
      wires from orchestrator to each worker and to the merge-queue counter.
- [ ] Chat pane backfills ("No messages yet" is expected on a freshly-spawned repo).
- [ ] **Known issue to confirm:** open the agent dropdown in the Chat pane. If each agent name
      (orchestrator, worker1..4) appears **twice**, that confirms a known duplicate-population bug
      (chat.js appends its own `<option>`s on top of the ones already in `index.html`). Not a
      blocker — just record PASS (5 unique entries) or FAIL (10, duplicated) here.

## 4. Send a GOAL, watch streaming + map animation

- [ ] In the Chat pane (agent = orchestrator), send: `GOAL: <describe a small task>`
- [ ] Reply streams in **token-by-token** (visibly typing in, not pasted in all at once); markdown
      (bold/lists/code/headings, as applicable) renders correctly once streamed.
- [ ] Shortly after the message is sent, the Operations pane animates a flying token from
      orchestrator toward the assigned worker, and the task board / queue counters update.

## 5. Terminal

- [ ] Terminal pane auto-opened right after Spawn succeeded, cwd = the scratch repo.
- [ ] Run `fleet-status` → resolves and prints live fleet state (not "command not found" — confirms
      `~/.local/bin` was correctly prepended to PATH).
- [ ] Run `fleet-board list` → resolves and prints the task board.
- [ ] Resize the app window → terminal reflows cleanly (no clipped or frozen rows).

## 6. Stop

- [ ] Click **Stop**. `teardown.sh` runs; wait for it to finish (spawn/stop controls re-lock while
      stopping).
- [ ] Supervisor + agent processes exit; the scratch repo's worker **worktrees** are removed but the
      worker **branches** themselves are kept (`git branch` inside the scratch repo still lists them).
- [ ] App resets to the pre-spawn empty state: chips clear, all three panes empty, **Stop** disabled,
      **Spawn** re-enabled.
- [ ] :7373 still responds, untouched.

## 7. Repeat-cycle check (Spawn → Stop → Spawn)

- [ ] Press **Spawn** again (same or a different scratch repo) immediately after step 6.
- [ ] Once the second Spawn completes, open Electron DevTools (View → Toggle Developer Tools, or
      Cmd+Option+I) and run in the console: `document.querySelectorAll('#nodes > div').length`.
      Expected `5`. **Known issue to confirm:** if it prints `10`, that confirms map.js re-appends
      node DOM on every Spawn without clearing the previous set (leftover nodes, duplicate
      `id="node-<name>"` attributes). Record PASS/FAIL.
- [ ] :7373 still responds, untouched.

## 8. Quit

- [ ] Quit the app (Cmd+Q or close the window).
- [ ] Confirm no fleetor-spawned child (the dashboard subprocess, any pty shells) is left running —
      e.g. `ps aux | grep '<scratch-repo-name>'` scoped to your own processes, or check that the
      scratch repo's dashboard port no longer responds.
- [ ] :7373 still responds, untouched — this is the final and most important check of the whole plan.

---

## Reference: already verified by automated audit (t-008), no need to re-check by hand

- `npm install` completes; `node-pty` rebuilds cleanly against Electron's ABI (`electron-rebuild -f
  -w node-pty` exits clean, `pty.node` present as a native arm64 binary).
- IPC channel strings match across `preload.js` / `main.js` / `fleet-manager.js` / `pty-manager.js`.
- `window.fleet` exposes all 11 documented methods; every A5 DOM id exists in `index.html`.
- Every `fetch`/`EventSource` call in `map.js`/`chat.js`/`app.js` is `baseUrl`-prefixed — no
  same-origin relative call that would silently fail against `file://`.
- No `7373` / `pkill` / `killall` / `lsof` / `fuser` / port-scan usage anywhere in `fleetor/` source
  (one comment mentioning "never pkill" is the only match, which is safe).
- A window opens headlessly (Playwright `_electron`) with zero renderer console errors.

Full findings, including the two known issues flagged above (chat agent-select duplication, map
node duplication on repeat Spawn, and a third: the `.offline` disconnected-overlay CSS never
actually shows), are in the t-008 report sent to the orchestrator.
