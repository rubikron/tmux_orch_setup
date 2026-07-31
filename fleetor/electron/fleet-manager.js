const { dialog, app } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const KIT = '/Users/bubblyducks/cc_opus_deepseek_tmuxLoop';

// Tracked children: { [key: string]: ChildProcess }
const children = {};

// Live dashboard port (null when not running)
let dashboardPort = null;

// --- helpers ---

function redactLine(text, key) {
  if (!key || !text) return text;
  return text.split(key).join('[REDACTED]');
}

function killAllTracked() {
  for (const [childKey, child] of Object.entries(children)) {
    try {
      child.kill();
    } catch (_) {
      // child may have already exited
    }
    delete children[childKey];
  }
  dashboardPort = null;
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

// --- register ---

function register(ipcMain, getWindow) {
  // --- fleet:pickDirectory ---
  ipcMain.handle('fleet:pickDirectory', async () => {
    const win = getWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select a fleet repo',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // --- fleet:getDashboardPort ---
  ipcMain.handle('fleet:getDashboardPort', () => {
    return dashboardPort;
  });

  // --- fleet:spawn ---
  ipcMain.handle('fleet:spawn', async (_event, repoPath, opts) => {
    if (dashboardPort !== null) {
      return { ok: false, error: 'A dashboard is already running. Stop it first.' };
    }

    const deepseekKey = opts?.deepseekKey || process.env.DEEPSEEK_API_KEY || '';

    const env = { ...process.env };
    if (deepseekKey) {
      env.DEEPSEEK_API_KEY = deepseekKey;
    }

    // 1. Spawn setup.sh
    const setupChild = spawn('bash', [`${KIT}/setup.sh`, repoPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.setup = setupChild;

    // Stream stdout/stderr line-wise, redacting the key
    const sendLog = (stream, text) => {
      const safe = redactLine(text, deepseekKey);
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('fleet:spawnLog', { stream, text: safe });
      }
    };

    setupChild.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.length > 0) sendLog('stdout', line);
      }
    });

    setupChild.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.length > 0) sendLog('stderr', line);
      }
    });

    // 2. Poll for supervisor.json (setup.sh waits for it internally too)
    const supervisorJson = path.join(repoPath, '.fleet', 'supervisor.json');
    const startTime = Date.now();
    const POLL_TIMEOUT = 120_000;
    const POLL_INTERVAL = 500;
    let setupExited = false;
    let setupExitCode = null;

    setupChild.on('close', (code) => {
      setupExited = true;
      setupExitCode = code;
    });

    let supervisorReady = false;
    while (Date.now() - startTime < POLL_TIMEOUT) {
      if (setupExited && setupExitCode !== 0) {
        delete children.setup;
        return { ok: false, error: `setup.sh exited with code ${setupExitCode}` };
      }

      try {
        if (fs.existsSync(supervisorJson)) {
          supervisorReady = true;
          break;
        }
      } catch (_) {
        // stat may fail transiently; ignore and retry
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }

    delete children.setup;

    if (!supervisorReady) {
      return { ok: false, error: 'supervisor did not come up' };
    }

    // 3. Start dashboard on a dynamic free port
    const MAX_RETRIES = 5;
    let dashSpawned = false;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const port = await pickFreePort();

      const dashEnv = {
        ...process.env,
        FLEET_DIR: path.join(repoPath, '.fleet'),
      };

      const dashChild = spawn('python3', [`${KIT}/bin/dashboard`, '--port', String(port)], {
        env: dashEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Wait briefly to detect immediate crash (e.g. EADDRINUSE)
      const dashResult = await new Promise((resolve) => {
        let settled = false;

        dashChild.on('error', (err) => {
          if (!settled) { settled = true; resolve({ error: err }); }
        });

        dashChild.on('close', (code) => {
          if (!settled) { settled = true; resolve({ exitCode: code }); }
        });

        setTimeout(() => {
          if (!settled) { settled = true; resolve({ running: true }); }
        }, 500);
      });

      if (dashResult.running) {
        children.dashboard = dashChild;
        dashboardPort = port;

        // Clean up tracking when dashboard exits on its own
        dashChild.on('close', () => {
          delete children.dashboard;
          if (dashboardPort === port) {
            dashboardPort = null;
          }
        });

        dashSpawned = true;
        break;
      }

      if (dashResult.error) {
        return { ok: false, error: `Failed to start dashboard: ${dashResult.error.message}` };
      }
      // dashResult.exitCode !== undefined → exited immediately, retry with a fresh port
    }

    if (!dashSpawned) {
      return { ok: false, error: 'Failed to start dashboard after multiple attempts' };
    }

    return { ok: true };
  });

  // --- fleet:stop ---
  ipcMain.handle('fleet:stop', async (_event, repoPath) => {
    const env = { ...process.env };

    try {
      await new Promise((resolve, reject) => {
        const teardownChild = spawn('bash', [`${KIT}/teardown.sh`, repoPath], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        teardownChild.stdout.on('data', (chunk) => { output += chunk.toString(); });
        teardownChild.stderr.on('data', (chunk) => { output += chunk.toString(); });

        teardownChild.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`teardown.sh exited with code ${code}: ${output.slice(-500)}`));
          }
        });

        teardownChild.on('error', reject);
      });

      // Kill ONLY the tracked dashboard child
      if (children.dashboard) {
        try {
          children.dashboard.kill();
        } catch (_) {
          // may already be dead
        }
        delete children.dashboard;
      }

      dashboardPort = null;

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- Cleanup on quit: kill only tracked children, never pkill ---
  app.on('will-quit', () => {
    killAllTracked();
  });
}

module.exports = { register };
