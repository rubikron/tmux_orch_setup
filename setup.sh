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
#   1. Creates a coordination dir ($FLEET_DIR) with board.json, tasks/, comms.log, bin/msg
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
# Permission mode each session launches Claude Code with. Both default to auto:
# workers run unattended in isolated worktrees, and the orchestrator drives the
# fleet in a long loop that stalls on approval prompts when you step away.
# Set either to "default" to get per-action approval prompts back, or to the
# empty string to launch claude with no --permission-mode flag at all.
# (No colon in the expansions below, so an explicit empty value is honoured.)
ORCHESTRATOR_PERMISSION_MODE="${ORCHESTRATOR_PERMISSION_MODE-auto}"
WORKER_PERMISSION_MODE="${WORKER_PERMISSION_MODE-auto}"
# Transport: "supervisor" (default, tmux-free headless stream-json) or "tmux"
# (legacy). See docs/transport-supervisor.md.
FLEET_TRANSPORT="${FLEET_TRANSPORT:-supervisor}"
# Headless agents can't answer permission prompts, so supervisor mode launches
# them non-interactively. Override per-fleet if you want a stricter mode.
SUPERVISOR_PERMISSION_MODE="${SUPERVISOR_PERMISSION_MODE:-bypassPermissions}"
# ---------------------------------------------------------------------------

command -v claude >/dev/null || { echo "claude (Claude Code) not found"; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found (needed by the supervisor + dashboard)"; exit 1; }
if [[ "$FLEET_TRANSPORT" == "tmux" ]]; then
  command -v tmux >/dev/null || { echo "tmux not found (FLEET_TRANSPORT=tmux)"; exit 1; }
fi
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
cp "$HERE/bin/board" "$FLEET_DIR/bin/board"
cp "$HERE/bin/supervisor" "$FLEET_DIR/bin/supervisor"
chmod +x "$FLEET_DIR/bin/msg" "$FLEET_DIR/bin/status" "$FLEET_DIR/bin/learn" \
         "$FLEET_DIR/bin/claim" "$FLEET_DIR/bin/submit" "$FLEET_DIR/bin/land" \
         "$FLEET_DIR/bin/board" "$FLEET_DIR/bin/supervisor"

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
ln -sf "$HERE/bin/board"  "$LOCAL_BIN/fleet-board"
# fleet-dashboard serves the live web control panel at http://127.0.0.1:7373.
ln -sf "$HERE/bin/dashboard" "$LOCAL_BIN/fleet-dashboard"
# fleet-supervisor runs the tmux-free headless transport (FLEET_TRANSPORT=supervisor).
ln -sf "$HERE/bin/supervisor" "$LOCAL_BIN/fleet-supervisor"
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
# Task board is JSON now (queried via fleet-board), so the orchestrator reads
# one task or a filtered slice instead of a growing markdown table.
if ! command -v jq >/dev/null 2>&1; then
  echo "warning: jq not found — fleet-board (the task board) needs it." \
       "Install with 'brew install jq'." >&2
fi
if [[ ! -f "$FLEET_DIR/board.json" ]]; then
  printf '{"tasks":[],"reflections":[]}\n' > "$FLEET_DIR/board.json"
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

# ---- launch ----------------------------------------------------------------
if [[ "$FLEET_TRANSPORT" == "supervisor" ]]; then
  # -- supervisor transport (default): tmux-free headless stream-json --------
  # Build the agent manifest with python (clean JSON escaping of keys/paths).
  # Values are exported so the heredoc reads them from the environment.
  export _SUP_REPO="$REPO" _SUP_WT="$WT_ROOT" _SUP_HERE="$HERE" \
         _SUP_PERM="$SUPERVISOR_PERMISSION_MODE" \
         _SUP_ORCH_MODEL="$ORCHESTRATOR_MODEL" \
         _SUP_WORKER_MODEL="$WORKER_MODEL" _SUP_UI_MODEL="$UI_TESTER_MODEL" \
         _SUP_DEEPSEEK_BASE="$DEEPSEEK_BASE" _SUP_DEEPSEEK_KEY="$DEEPSEEK_API_KEY"
  python3 - "$FLEET_DIR/agents.json" <<'PY'
import json, os, sys
here = os.environ["_SUP_HERE"]; repo = os.environ["_SUP_REPO"]
wt = os.environ["_SUP_WT"]; perm = os.environ["_SUP_PERM"]
# Orchestrator + UI tester carry NO DeepSeek env; the supervisor strips inherited
# ANTHROPIC_* so their model/auth comes only from these manifest entries.
agents = [
    {"name": "orchestrator", "cwd": repo,
     "prompt_file": f"{here}/prompts/ORCHESTRATOR.md", "permission_mode": perm,
     "env": {"ANTHROPIC_MODEL": os.environ["_SUP_ORCH_MODEL"]}},
]
for i in (1, 2, 3):
    agents.append({"name": f"worker{i}", "cwd": f"{wt}/worker{i}",
                   "prompt_file": f"{here}/prompts/WORKER.md", "permission_mode": perm,
                   "env": {"ANTHROPIC_BASE_URL": os.environ["_SUP_DEEPSEEK_BASE"],
                           "ANTHROPIC_AUTH_TOKEN": os.environ["_SUP_DEEPSEEK_KEY"],
                           "ANTHROPIC_MODEL": os.environ["_SUP_WORKER_MODEL"],
                           "CLAUDE_CODE_EFFORT_LEVEL": "max"}})
agents.append({"name": "worker4", "cwd": f"{wt}/worker4",
               "prompt_file": f"{here}/prompts/UI_TESTER.md", "permission_mode": perm,
               "env": {"ANTHROPIC_MODEL": os.environ["_SUP_UI_MODEL"],
                       "CLAUDE_CODE_EFFORT_LEVEL": "max"}})
with open(sys.argv[1], "w") as f:
    json.dump({"agents": agents}, f, indent=2)
PY
  unset _SUP_REPO _SUP_WT _SUP_HERE _SUP_PERM _SUP_ORCH_MODEL _SUP_WORKER_MODEL \
        _SUP_UI_MODEL _SUP_DEEPSEEK_BASE _SUP_DEEPSEEK_KEY

  # Launch the supervisor detached. It spawns all agents, holds their pipes, and
  # serves the control endpoint on an OS-assigned port (advertised in supervisor.json).
  rm -f "$FLEET_DIR/supervisor.json"
  FLEET_DIR="$FLEET_DIR" nohup "$FLEET_DIR/bin/supervisor" --fleet-dir "$FLEET_DIR" \
    >"$FLEET_DIR/supervisor.out" 2>&1 &
  disown 2>/dev/null || true
  for _ in $(seq 1 25); do [[ -f "$FLEET_DIR/supervisor.json" ]] && break; sleep 0.2; done

  if [[ ! -f "$FLEET_DIR/supervisor.json" ]]; then
    echo "supervisor failed to start — see $FLEET_DIR/supervisor.out" >&2
    exit 1
  fi
  sup_port="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["port"])' "$FLEET_DIR/supervisor.json")"

  cat <<EOF

Fleet is up (supervisor transport — no tmux).
  coordination dir : $FLEET_DIR
  worktrees        : $WT_ROOT/worker{1,2,3,4}   (branches w1/w2/w3/w4)
  workers 1-3 on   : $WORKER_MODEL
  worker4 on       : $UI_TESTER_MODEL  (UI testing specialist)
  supervisor       : http://127.0.0.1:$sup_port   (pid in supervisor.json)
  permission mode  : $SUPERVISOR_PERMISSION_MODE (all agents)
  fleet commands   : fleet-msg / fleet-status / fleet-dashboard  (symlinked into $LOCAL_BIN)

Watch the fleet:
  fleet-dashboard --open          # live web control panel
  fleet-status                    # terminal snapshot

Kick off your project goal (no tmux pane to paste into):
  fleet-msg orchestrator "GOAL: <describe your project goal here>"

Tear down later with:  ./teardown.sh $REPO
EOF

else
  # -- tmux transport (legacy) ----------------------------------------------
  # Starts a detached tmux session, exports the shared env, then runs claude with
  # the given role prompt appended to its system prompt.
  start_session () {
    local name="$1" dir="$2" prompt_file="$3"; shift 3
    local extra_env=("$@")   # KEY=VALUE strings to export before launching claude
    tmux kill-session -t "$name" 2>/dev/null || true
    tmux new-session -d -s "$name" -c "$dir"
    tmux send-keys -t "$name" "export FLEET_DIR='$FLEET_DIR'" Enter
    tmux send-keys -t "$name" "export PATH='$FLEET_DIR/bin':\"\$PATH\"" Enter
    # Also set FLEET_AGENT so fleet-msg/submit derive identity the same way the
    # supervisor transport does.
    tmux send-keys -t "$name" "export FLEET_AGENT='$name'" Enter
    # Orchestrator and UI tester must use real Anthropic auth, never DeepSeek.
    if [[ "$name" == "orchestrator" || "$name" == "worker4" ]]; then
      tmux send-keys -t "$name" \
        "unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL" Enter
    fi
    for kv in "${extra_env[@]:-}"; do
      tmux send-keys -t "$name" "export $kv" Enter
    done
    # Permission mode per role. Empty = launch claude with no --permission-mode flag.
    local mode="$WORKER_PERMISSION_MODE"
    if [[ "$name" == "orchestrator" ]]; then
      mode="$ORCHESTRATOR_PERMISSION_MODE"
    fi
    local perm_flag=""
    if [[ -n "$mode" ]]; then
      perm_flag=" --permission-mode $mode"
    fi
    tmux send-keys -t "$name" \
      "claude$perm_flag --append-system-prompt \"\$(cat '$prompt_file')\"" Enter
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

Fleet is up (tmux transport).
  coordination dir : $FLEET_DIR
  worktrees        : $WT_ROOT/worker{1,2,3,4}   (branches w1/w2/w3/w4)
  workers 1-3 on   : $WORKER_MODEL
  worker4 on       : $UI_TESTER_MODEL  (UI testing specialist)
  permission mode  : orchestrator=${ORCHESTRATOR_PERMISSION_MODE:-<claude default>}, workers=${WORKER_PERMISSION_MODE:-<claude default>}
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
fi
