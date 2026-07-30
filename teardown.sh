#!/usr/bin/env bash
# teardown.sh — kill the fleet's tmux sessions and remove worker worktrees.
# Usage: ./teardown.sh /path/to/your/project/repo
# Branches w1/w2/w3/w4 are kept so you don't lose unmerged work; delete manually if desired.
set -euo pipefail
REPO="$(cd "${1:-$(pwd)}" && pwd)"
WT_ROOT="$REPO/.worktrees"
FLEET_DIR="$REPO/.fleet"

# Supervisor transport: stop the supervisor process (it closes every agent's
# stdin and terminates the children on SIGTERM).
if [[ -f "$FLEET_DIR/supervisor.json" ]] && command -v python3 >/dev/null 2>&1; then
  pid="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("pid",""))' "$FLEET_DIR/supervisor.json" 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null && echo "stopping supervisor (pid $pid)..." || true
    # Wait for it to fully exit — its shutdown reaps the agent processes and
    # removes supervisor.json. Returning early would race a subsequent setup.sh
    # (the old supervisor could delete the new one's supervisor.json).
    for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
      echo "force-killed supervisor (pid $pid)"
    else
      echo "supervisor stopped (pid $pid)"
    fi
  fi
fi

# tmux transport (legacy): kill any fleet sessions.
for s in orchestrator worker1 worker2 worker3 worker4; do
  tmux kill-session -t "$s" 2>/dev/null && echo "killed session $s" || true
done

for i in 1 2 3 4; do
  wt="$WT_ROOT/worker$i"
  if [[ -d "$wt" ]]; then
    if git -C "$REPO" worktree remove "$wt"; then
      echo "removed worktree $wt"
    else
      echo "warning: worktree $wt could not be removed — it may have uncommitted changes or its branch may be active elsewhere. Commit/stash inside it, or re-run with 'git worktree remove --force $wt' if you're sure." >&2
    fi
  fi
done

# Remove the global CLI symlinks setup.sh installed into ~/.local/bin.
# Only unlink real symlinks (never a file someone else put there); the fleet's
# session names are fixed, so one fleet runs per machine and this is safe.
LOCAL_BIN="$HOME/.local/bin"
for t in fleet-msg fleet-status fleet-learn fleet-claim fleet-release \
         fleet-claims fleet-submit fleet-land fleet-board fleet-dashboard \
         fleet-supervisor; do
  f="$LOCAL_BIN/$t"
  [[ -L "$f" ]] && rm -f "$f" && echo "removed CLI symlink $f" || true
done

echo "Done. Worker branches w1/w2/w3/w4 kept. Coordination dir left at $REPO/.fleet"
