#!/usr/bin/env bash
# setup.sh — spin up a 1 Opus orchestrator + 3 DeepSeek workers + 1 Sonnet UI tester fleet.
#
# Usage:
#   ./setup.sh /path/to/your/project/repo
#
#   Set DEEPSEEK_API_KEY via shell env, .env file, or .env.local.
#   A .env.example is provided — copy to .env.local and fill in your key.
#
# What it does:
#   1. Creates a coordination dir ($FLEET_DIR) with BOARD.md, tasks/, comms.log, bin/msg
#   2. Creates 4 git worktrees (branches w1/w2/w3/w4) for the workers
#   3. Starts 5 tmux sessions and launches Claude Code in each
#        - orchestrator: Opus (your normal Claude Code auth), on `main`
#        - worker1/2/3 : DeepSeek via the Anthropic-compatible endpoint
#        - worker4      : Sonnet (your normal Claude Code auth), UI testing specialist
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
ORCHESTRATOR_MODEL="${ORCHESTRATOR_MODEL:-claude-opus-4-8}"
UI_TESTER_MODEL="${UI_TESTER_MODEL:-claude-sonnet-5}"
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
WT_ROOT="$REPO/.worktrees"   # defined early: the env manifest below references it
mkdir -p "$FLEET_DIR/tasks" "$FLEET_DIR/bin"
cp "$HERE/bin/msg" "$FLEET_DIR/bin/msg"
cp "$HERE/bin/status" "$FLEET_DIR/bin/status"
cp "$HERE/bin/learn" "$FLEET_DIR/bin/learn"
cp "$HERE/bin/claim" "$FLEET_DIR/bin/claim"
cp "$HERE/bin/submit" "$FLEET_DIR/bin/submit"
cp "$HERE/bin/land" "$FLEET_DIR/bin/land"
chmod +x "$FLEET_DIR/bin/msg" "$FLEET_DIR/bin/status" "$FLEET_DIR/bin/learn" \
         "$FLEET_DIR/bin/claim" "$FLEET_DIR/bin/submit" "$FLEET_DIR/bin/land"

# ---- global CLI install ----------------------------------------------------
# Why: the tmux panes add $FLEET_DIR/bin to PATH, so the tools resolve when a
# human types them. But Claude Code's Bash tool (used by the orchestrator)
# sources a shell snapshot that REBUILDS PATH from your rc files before every
# command, dropping $FLEET_DIR/bin — so bare tools there fail with exit 127
# ("command not found"). Fix: symlink the tools into ~/.local/bin, which is
# already on that snapshot PATH, under repo-specific names so they can't shadow
# generic commands. The scripts read $FLEET_DIR from the env at runtime, so a
# single install serves whichever fleet is running. teardown.sh removes them.
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"
ln -sf "$HERE/bin/msg"    "$LOCAL_BIN/fleet-msg"
ln -sf "$HERE/bin/status" "$LOCAL_BIN/fleet-status"
ln -sf "$HERE/bin/learn"  "$LOCAL_BIN/fleet-learn"
# claim is one script dispatched by invocation name → three symlinks.
ln -sf "$HERE/bin/claim"  "$LOCAL_BIN/fleet-claim"
ln -sf "$HERE/bin/claim"  "$LOCAL_BIN/fleet-release"
ln -sf "$HERE/bin/claim"  "$LOCAL_BIN/fleet-claims"
ln -sf "$HERE/bin/submit" "$LOCAL_BIN/fleet-submit"
ln -sf "$HERE/bin/land"   "$LOCAL_BIN/fleet-land"
case ":$PATH:" in
  *":$LOCAL_BIN:"*) : ;;  # already on PATH — good
  *) echo "warning: $LOCAL_BIN is not on your PATH. Add it (e.g. in ~/.zshrc:" \
          "export PATH=\"\$HOME/.local/bin:\$PATH\") or fleet-msg/status/learn" \
          "won't resolve." >&2 ;;
esac
# Persist comms.log and metrics.jsonl across runs for audit trail.
touch "$FLEET_DIR/comms.log"
if [[ ! -f "$FLEET_DIR/metrics.jsonl" ]]; then
  touch "$FLEET_DIR/metrics.jsonl"
fi
if [[ ! -f "$FLEET_DIR/BOARD.md" ]]; then
  cat > "$FLEET_DIR/BOARD.md" <<'EOF'
# Task Board  (owned by the orchestrator)
# id     state    assignee  notes
# ------ -------- --------- -----------------------------
EOF
fi
# ---- environment manifest (so the orchestrator doesn't waste tool calls) -----
# Dump everything the orchestrator would probe with bash into one file.
# It reads this once on startup instead of running 3+ bash commands.
cat > "$FLEET_DIR/env.md" <<ENVEOF
# Fleet Environment Snapshot
<!-- generated by setup.sh at $(date -u '+%Y-%m-%dT%H:%M:%SZ') -->

## Repo
- **Path:** $REPO
- **Branch:** $(git -C "$REPO" symbolic-ref --short HEAD)
- **Last commit:** $(git -C "$REPO" log --oneline -1 2>/dev/null || echo '(no commits yet)')
$(echo '```'; git -C "$REPO" status --short 2>/dev/null || echo '(clean)'; echo '```')

## Files (top-level)
$(echo '```'; ls -la "$REPO" 2>/dev/null; echo '```')

## Tools
- **node:** $(node -v 2>/dev/null || echo 'not found')
- **npm:**  $(npm -v 2>/dev/null || echo 'not found')
- **pnpm:** $(pnpm -v 2>/dev/null || echo 'not found')
$(if command -v python3 >/dev/null 2>&1; then echo "- **python:** $(python3 --version 2>&1)"; elif command -v python >/dev/null 2>&1; then echo "- **python:** $(python --version 2>&1)"; fi)
$(if command -v cargo >/dev/null 2>&1; then echo "- **rust:** $(cargo --version 2>&1 | head -1)"; fi)
$(if command -v go >/dev/null 2>&1; then echo "- **go:** $(go version 2>&1)"; fi)

## Fleet layout
- **FLEET_DIR:** $FLEET_DIR
- **Sessions:** orchestrator, worker1, worker2, worker3, worker4
- **Worker models:** worker1-3 = $WORKER_MODEL, worker4 = $UI_TESTER_MODEL, orchestrator = $ORCHESTRATOR_MODEL
- **Worktrees:** $WT_ROOT/worker{1,2,3,4}
ENVEOF

# keep coordination noise and secrets out of the project's own history
grep -qxF '.fleet/' "$REPO/.gitignore" 2>/dev/null || echo '.fleet/' >> "$REPO/.gitignore"
grep -qxF '.worktrees/' "$REPO/.gitignore" 2>/dev/null || echo '.worktrees/' >> "$REPO/.gitignore"
grep -qxF '.env.local' "$REPO/.gitignore" 2>/dev/null || echo '.env.local' >> "$REPO/.gitignore"
# ---- worktrees for workers -------------------------------------------------
mkdir -p "$WT_ROOT"
DEFAULT_BRANCH="$(git -C "$REPO" symbolic-ref --short HEAD)"
for i in 1 2 3 4; do
  wt="$WT_ROOT/worker$i"
  if [[ -d "$wt" ]]; then
    continue                                   # worktree already present
  elif git -C "$REPO" show-ref --quiet "refs/heads/w$i"; then
    git -C "$REPO" worktree add "$wt" "w$i"     # branch exists (e.g. after teardown), reuse it
  else
    git -C "$REPO" worktree add -b "w$i" "$wt" "$DEFAULT_BRANCH"
  fi
done

# ---- integration tooling: state + config -----------------------------------
# Ledger (claimed files) and the merge queue used by fleet-claim / fleet-land.
touch "$FLEET_DIR/claims.tsv" "$FLEET_DIR/merge-queue"

# Detect the project's test command once so fleet-submit and fleet-land can test
# the merged tree. Written only if fleet.conf is absent, so manual edits survive
# re-runs. Empty TEST_CMD = skip auto-testing.
detect_test_cmd() {
  if [[ -f "$REPO/package.json" ]] && grep -q '"test"[[:space:]]*:' "$REPO/package.json"; then
    if [[ -f "$REPO/pnpm-lock.yaml" ]]; then echo "pnpm test"; else echo "npm test"; fi
  elif { [[ -f "$REPO/pyproject.toml" || -f "$REPO/setup.py" || -d "$REPO/tests" ]]; } && command -v pytest >/dev/null 2>&1; then
    echo "pytest -q"
  elif [[ -f "$REPO/Cargo.toml" ]]; then echo "cargo test"
  elif [[ -f "$REPO/go.mod" ]]; then echo "go test ./..."
  elif [[ -f "$REPO/Makefile" ]] && grep -qE '^test:' "$REPO/Makefile"; then echo "make test"
  else echo ""
  fi
}

if [[ ! -f "$FLEET_DIR/fleet.conf" ]]; then
  TEST_CMD_DETECTED="$(detect_test_cmd)"
  cat > "$FLEET_DIR/fleet.conf" <<CONFEOF
# Fleet integration config — sourced by fleet-submit and fleet-land.
# Edit freely; re-running setup.sh will NOT overwrite this file.
MAIN_BRANCH="$DEFAULT_BRANCH"
# Command that verifies a branch (locally, in fleet-submit) and the merged tree
# (on land, in fleet-land). Empty = skip auto-testing and test manually.
TEST_CMD="$TEST_CMD_DETECTED"
CONFEOF
  if [[ -n "$TEST_CMD_DETECTED" ]]; then
    echo "detected test command: $TEST_CMD_DETECTED   (edit $FLEET_DIR/fleet.conf to change)"
  else
    echo "no test command detected — set TEST_CMD in $FLEET_DIR/fleet.conf to enable merged-tree testing"
  fi
fi

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
  # Orchestrator and UI tester must use real Anthropic auth, never DeepSeek.
  # If the calling shell has DeepSeek vars set (from a prior session), unset them
  # BEFORE the extra_env loop so that extra_env can override (e.g. worker4 sets
  # ANTHROPIC_MODEL=claude-sonnet-5 after the blanket unset).
  if [[ "$name" == "orchestrator" || "$name" == "worker4" ]]; then
    tmux send-keys -t "$name" \
      "unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL" Enter
  fi
  for kv in "${extra_env[@]:-}"; do
    tmux send-keys -t "$name" "export $kv" Enter
  done
  # Worker sessions run unattended in isolated worktrees, so they launch in auto
  # permission mode — no manual approval per session. The orchestrator is driven
  # interactively (you paste the goal into it), so it keeps prompts on.
  local auto=""
  if [[ "$name" == worker* ]]; then
    auto=" --permission-mode auto"
  fi
  tmux send-keys -t "$name" \
    "claude$auto --append-system-prompt \"\$(cat '$prompt_file')\"" Enter
}

# Orchestrator: Opus via real Anthropic auth. No DeepSeek env.
start_session orchestrator "$REPO" "$HERE/prompts/ORCHESTRATOR.md" \
  "ANTHROPIC_MODEL=$ORCHESTRATOR_MODEL"

# Workers 1-3: DeepSeek via the Anthropic-compatible endpoint.
for i in 1 2 3; do
  start_session "worker$i" "$WT_ROOT/worker$i" "$HERE/prompts/WORKER.md" \
    "ANTHROPIC_BASE_URL=$DEEPSEEK_BASE" \
    "ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY" \
    "ANTHROPIC_MODEL=$WORKER_MODEL" \
    "CLAUDE_CODE_EFFORT_LEVEL=max"
done

# Worker 4: Sonnet UI tester — uses real Anthropic auth, not DeepSeek.
start_session "worker4" "$WT_ROOT/worker4" "$HERE/prompts/UI_TESTER.md" \
  "ANTHROPIC_MODEL=$UI_TESTER_MODEL" \
  "CLAUDE_CODE_EFFORT_LEVEL=max"

cat <<EOF

Fleet is up.
  coordination dir : $FLEET_DIR
  worktrees        : $WT_ROOT/worker{1,2,3,4}   (branches w1/w2/w3/w4)
  workers 1-3 on   : $WORKER_MODEL
  worker4 on       : $UI_TESTER_MODEL  (UI testing specialist)
  fleet commands   : fleet-msg / fleet-status / fleet-learn  (symlinked into $LOCAL_BIN)

Open five terminal windows and attach one session in each:
  tmux attach -t orchestrator
  tmux attach -t worker1
  tmux attach -t worker2
  tmux attach -t worker3
  tmux attach -t worker4

Then paste your project goal into the orchestrator (see README kickoff prompt).
Tear down later with:  ./teardown.sh $REPO
EOF
