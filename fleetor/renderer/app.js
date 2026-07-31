// fleetor — app.js — top-bar wiring skeleton
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

// --- State ---
let selectedRepoPath = null;
let port = null;

// --- Module handles ---
let mapHandle = null;
let chatHandle = null;
let termHandle = null;

// --- Button: Open directory picker ---
btnOpen.addEventListener('click', async () => {
  const path = await window.fleet.pickDirectory();
  if (path) {
    selectedRepoPath = path;
    repoPathEl.textContent = path;
    btnSpawn.disabled = false;
  }
});

// --- Settings popover toggle ---
btnSettings.addEventListener('click', () => {
  settingsPopover.classList.toggle('hidden');
});

// --- Prove the imports resolve and modules can be instantiated ---
console.log('[fleetor] app.js loaded — imports resolved: map, chat, terminal');
console.log('[fleetor] window.fleet methods:', Object.keys(window.fleet));
