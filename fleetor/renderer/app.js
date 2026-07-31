// fleetor — app.js — top-bar glue: Spawn/Stop, status chips, port→panes init
import { initMap } from './map.js';
import { initChat } from './chat.js';
import { initTerminal } from './terminal.js';

// --- DOM refs ---
const repoPathEl = document.getElementById('repo-path');
const btnOpen = document.getElementById('btn-open');
const btnSpawn = document.getElementById('btn-spawn');
const btnStop = document.getElementById('btn-stop');
const btnSettings = document.getElementById('btn-settings');
const settingsPopover = document.getElementById('settings-popover');
const deepseekKeyInput = document.getElementById('deepseek-key');
const spawnLog = document.getElementById('spawn-log');
const statusChips = document.getElementById('status-chips');
const termMount = document.getElementById('term-mount');

// --- State ---
let selectedRepoPath = null;
let port = null;
let isSpawning = false;
let pollInterval = null;

// --- Module handles ---
let mapHandle = null;
let chatHandle = null;
let termHandle = null;

// --- Port resolution with retries ---
async function resolvePort(maxRetries = 15, delayMs = 500) {
  for (let i = 0; i < maxRetries; i++) {
    const p = await window.fleet.getDashboardPort();
    if (p != null) return p;
    await new Promise(function (r) { return setTimeout(r, delayMs); });
  }
  throw new Error('Dashboard port not available after ' + maxRetries + ' retries');
}

// --- Status chips ---
function renderStatusChips(state) {
  if (!state) {
    statusChips.innerHTML = '<span class="chip chip-dim">no data</span>';
    return;
  }

  var sessions = state.sessions || {};
  var supervisorUp = !!(sessions.orchestrator && sessions.orchestrator.alive);
  var aliveCount = Object.values(sessions).filter(function (s) { return s && s.alive; }).length;
  var cost = typeof state.totalCost === 'number' ? state.totalCost : 0;
  var counts = state.counts || {};

  var chips = [
    '<span class="chip ' + (supervisorUp ? 'chip-ok' : 'chip-down') + '">' +
      (supervisorUp ? 'supervisor up' : 'supervisor down') + '</span>',
    '<span class="chip chip-info">' + aliveCount + '/5 alive</span>',
    '<span class="chip chip-info">$' + cost.toFixed(2) + '</span>',
    '<span class="chip chip-info">queued:' + (counts.queued || 0) + '</span>',
    '<span class="chip chip-info">active:' + (counts.active || 0) + '</span>',
    '<span class="chip chip-info">blocked:' + (counts.blocked || 0) + '</span>',
    '<span class="chip chip-info">merged:' + (counts.merged || 0) + '</span>',
  ];

  statusChips.innerHTML = chips.join('');
}

function startStatusPoll(baseUrl) {
  stopStatusPoll();

  function poll() {
    fetch(baseUrl + '/api/state')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (state) { renderStatusChips(state); })
      .catch(function () {
        statusChips.innerHTML = '<span class="chip chip-warn">disconnected</span>';
      });
  }

  poll();
  pollInterval = setInterval(poll, 1200);
}

function stopStatusPoll() {
  if (pollInterval != null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// --- Teardown all panes ---
function teardownPanes() {
  if (mapHandle) {
    try { mapHandle.destroy(); } catch (e) { /* ignore */ }
    mapHandle = null;
  }
  if (chatHandle) {
    try { chatHandle.destroy(); } catch (e) { /* ignore */ }
    chatHandle = null;
  }
  if (termHandle) {
    try { termHandle.dispose(); } catch (e) { /* ignore */ }
    termHandle = null;
  }
}

// --- Reset UI to pre-spawn empty state ---
function resetToEmpty() {
  stopStatusPoll();
  port = null;
  isSpawning = false;
  spawnLog.classList.add('hidden');
  spawnLog.textContent = '';
  statusChips.innerHTML = '<span class="chip chip-dim">—</span>';
  btnSpawn.disabled = !selectedRepoPath;
  btnSpawn.textContent = 'Spawn';
  btnStop.disabled = true;
  btnStop.textContent = 'Stop';
}

// --- Button: Open directory picker ---
btnOpen.addEventListener('click', async function () {
  try {
    var path = await window.fleet.pickDirectory();
    if (path) {
      selectedRepoPath = path;
      repoPathEl.textContent = path;
      if (port === null && !isSpawning) {
        btnSpawn.disabled = false;
      }
    }
  } catch (err) {
    console.error('[fleetor] pickDirectory error:', err);
  }
});

// --- Button: Spawn ---
btnSpawn.addEventListener('click', async function () {
  if (!selectedRepoPath || port !== null || isSpawning) return;

  isSpawning = true;
  btnSpawn.disabled = true;
  btnSpawn.textContent = 'Spawning…';
  spawnLog.classList.remove('hidden');
  spawnLog.textContent = '';

  var deepseekKey = deepseekKeyInput.value.trim() || undefined;
  var unsub = null;

  try {
    unsub = window.fleet.onSpawnLog(function (_a) {
      var stream = _a.stream;
      var text = _a.text;
      var span = document.createElement('span');
      span.className = 'log-' + (stream === 'stderr' ? 'stderr' : 'stdout');
      span.textContent = text + '\n';
      spawnLog.appendChild(span);
      spawnLog.scrollTop = spawnLog.scrollHeight;
    });

    var result = await window.fleet.spawn(selectedRepoPath, { deepseekKey: deepseekKey });
    unsub();
    unsub = null;

    if (!result.ok) {
      throw new Error(result.error || 'Spawn failed');
    }

    port = await resolvePort();
    var baseUrl = 'http://127.0.0.1:' + port;

    // Initialize all three panes
    mapHandle = initMap({ baseUrl: baseUrl });
    mapHandle.start();

    chatHandle = initChat({ baseUrl: baseUrl });
    chatHandle.open();

    termHandle = initTerminal({
      el: termMount,
      id: 'main',
      cwd: selectedRepoPath,
    });
    termHandle.focus();

    // Start status chip polling
    startStatusPoll(baseUrl);

    // Final button state: cluster running
    btnStop.disabled = false;
    btnSpawn.textContent = 'Spawn';
    isSpawning = false;
  } catch (err) {
    var errorSpan = document.createElement('span');
    errorSpan.className = 'log-error';
    errorSpan.textContent = 'ERROR: ' + (err.message || 'Unknown error') + '\n';
    spawnLog.appendChild(errorSpan);
    spawnLog.scrollTop = spawnLog.scrollHeight;

    isSpawning = false;
    btnSpawn.disabled = false;
    btnSpawn.textContent = 'Spawn';
  } finally {
    if (unsub) unsub();
  }
});

// --- Button: Stop ---
btnStop.addEventListener('click', async function () {
  if (port === null) return;

  btnStop.disabled = true;
  btnStop.textContent = 'Stopping…';
  btnSpawn.disabled = true;

  try {
    await window.fleet.stop(selectedRepoPath);
  } catch (err) {
    console.error('[fleetor] stop error:', err);
  }

  teardownPanes();
  resetToEmpty();
});

// --- Settings popover toggle ---
btnSettings.addEventListener('click', function () {
  settingsPopover.classList.toggle('hidden');
});

// --- Prove the imports resolve and modules can be instantiated ---
console.log('[fleetor] app.js loaded — imports resolved: map, chat, terminal');
console.log('[fleetor] window.fleet methods:', Object.keys(window.fleet));
