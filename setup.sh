#!/usr/bin/env bash
# setup.sh — spin up a 1 Opus orchestrator + 3 DeepSeek worker Claude Code fleet.
#
# Usage:
#   ./setup.sh /path/to/your/project/repo
#
#   Set DEEPSEEK_API_KEY via shell env, .env file, or .env.local.
#   A .env.example is provided — copy to .env.local and fill in your key.
#
# What it does:
#   1. Creates a coordination dir ($FLEET_DIR) with BOARD.md, tasks/, comms.log, bin/msg
#   2. Creates 3 git worktrees (branches w1/w2/w3) for the workers
#   3. Starts 4 tmux sessions and launches Claude Code in each
#        - orchestrator: Opus (your normal Claude Code auth), on `main`
#        - worker1/2/3 : DeepSeek via the Anthropic-compatible endpoint
#
# Attach to any session in its own terminal window with:  tmux attach -t worker1
set -euo pipefail

# ---- config (override via env) --------------------------------------------
REPO="${1:-$(pwd)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"  # this fleet kit's dir

# Source .env files (lowest priority — explicit shell exports override).
# .env.local overrides .env; fleet-kit dir overrides cwd.
for env_file in "$PWD/.env" "$PWD/.env.local" "$HERE/.env" "$HERE/.env.local"; do
  # shellcheck disable=SC1090
  [[ -f "$env_file" ]] && source "$env_file"
done

WORKER_MODEL="${WORKER_MODEL:-deepseek-v4-pro}"       # set to DeepSeek's current coding model
DEEPSEEK_BASE="${DEEPSEEK_BASE:-https://api.deepseek.com/anthropic}"
# ---------------------------------------------------------------------------

command -v tmux  >/dev/null || { echo "tmux not found"; exit 1; }
command -v claude >/dev/null || { echo "claude (Claude Code) not found"; exit 1; }
command -v git   >/dev/null || { echo "git not found"; exit 1; }
: "${DEEPSEEK_API_KEY:?set DEEPSEEK_API_KEY in your environment or .env file}"

REPO="$(cd "$REPO" && pwd)"
git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { echo "$REPO is not a git repo"; exit 1; }

# ---- coordination dir ------------------------------------------------------
FLEET_DIR="$REPO/.fleet"
mkdir -p "$FLEET_DIR/tasks" "$FLEET_DIR/bin"
cp "$HERE/bin/msg" "$FLEET_DIR/bin/msg"
chmod +x "$FLEET_DIR/bin/msg"
# Persist comms.log across runs (matching BOARD.md behavior) for audit trail.
touch "$FLEET_DIR/comms.log"
if [[ ! -f "$FLEET_DIR/BOARD.md" ]]; then
  cat > "$FLEET_DIR/BOARD.md" <<'EOF'
# Task Board  (owned by the orchestrator)
# id     state    assignee  notes
# ------ -------- --------- -----------------------------
EOF
fi
# keep coordination noise and secrets out of the project's own history
grep -qxF '.fleet/' "$REPO/.gitignore" 2>/dev/null || echo '.fleet/' >> "$REPO/.gitignore"
grep -qxF '.env.local' "$REPO/.gitignore" 2>/dev/null || echo '.env.local' >> "$REPO/.gitignore"
# ---- worktrees for workers -------------------------------------------------
WT_ROOT="$REPO/../$(basename "$REPO")-worktrees"
mkdir -p "$WT_ROOT"
DEFAULT_BRANCH="$(git -C "$REPO" symbolic-ref --short HEAD)"
for i in 1 2 3; do
  wt="$WT_ROOT/worker$i"
  if [[ -d "$wt" ]]; then
    continue                                   # worktree already present
  elif git -C "$REPO" show-ref --quiet "refs/heads/w$i"; then
    git -C "$REPO" worktree add "$wt" "w$i"     # branch exists (e.g. after teardown), reuse it
  else
    git -C "$REPO" worktree add -b "w$i" "$wt" "$DEFAULT_BRANCH"
  fi
done

# ---- launch helper ---------------------------------------------------------
# Starts a detached tmux session, exports the shared env, then runs claude with
# the given role prompt appended to its system prompt.
start_session () {
  local name="$1" dir="$2" prompt_file="$3"; shift 3
  local extra_env=("$@")   # KEY=VALUE strings to export before launching claude
  tmux kill-session -t "$name" 2>/dev/null || true
  tmux new-session -d -s "$name" -c "$dir"
  tmux send-keys -t "$name" "export FLEET_DIR='$FLEET_DIR'" Enter
  tmux send-keys -t "$name" "export PATH='$FLEET_DIR/bin':\"\$PATH\"" Enter
  for kv in "${extra_env[@]:-}"; do
    tmux send-keys -t "$name" "export $kv" Enter
  done
  # Orchestrator must always use Opus, never DeepSeek. If the calling shell
  # has ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL set (e.g.
  # from a prior DeepSeek session), unset them so claude uses default auth.
  if [[ "$name" == "orchestrator" ]]; then
    tmux send-keys -t "$name" \
      "unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL" Enter
  fi
  tmux send-keys -t "$name" \
    "claude --append-system-prompt \"\$(cat '$prompt_file')\"" Enter
}

# Orchestrator: your normal Claude Code auth (Opus). No DeepSeek env.
start_session orchestrator "$REPO" "$HERE/prompts/ORCHESTRATOR.md"

# Workers: DeepSeek via the Anthropic-compatible endpoint.
for i in 1 2 3; do
  start_session "worker$i" "$WT_ROOT/worker$i" "$HERE/prompts/WORKER.md" \
    "ANTHROPIC_BASE_URL=$DEEPSEEK_BASE" \
    "ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY" \
    "ANTHROPIC_MODEL=$WORKER_MODEL" \
    "CLAUDE_CODE_EFFORT_LEVEL=max"
done

cat <<EOF

Fleet is up.
  coordination dir : $FLEET_DIR
  worktrees        : $WT_ROOT/worker{1,2,3}   (branches w1/w2/w3)
  workers on model : $WORKER_MODEL

Open four terminal windows and attach one session in each:
  tmux attach -t orchestrator
  tmux attach -t worker1
  tmux attach -t worker2
  tmux attach -t worker3

Then paste your project goal into the orchestrator (see README kickoff prompt).
Tear down later with:  ./teardown.sh $REPO
EOF
