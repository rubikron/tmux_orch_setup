#!/usr/bin/env bash
# teardown.sh — kill the fleet's tmux sessions and remove worker worktrees.
# Usage: ./teardown.sh /path/to/your/project/repo
# Branches w1/w2/w3 are kept so you don't lose unmerged work; delete manually if desired.
set -euo pipefail
REPO="$(cd "${1:-$(pwd)}" && pwd)"
WT_ROOT="$REPO/../$(basename "$REPO")-worktrees"

for s in orchestrator worker1 worker2 worker3; do
  tmux kill-session -t "$s" 2>/dev/null && echo "killed session $s" || true
done

for i in 1 2 3; do
  wt="$WT_ROOT/worker$i"
  [[ -d "$wt" ]] && git -C "$REPO" worktree remove --force "$wt" && echo "removed worktree $wt" || true
done

echo "Done. Worker branches w1/w2/w3 kept. Coordination dir left at $REPO/.fleet"
