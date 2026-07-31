const os = require('os');
const pty = require('node-pty');
const { app } = require('electron');

/** @type {Object.<string, import('node-pty').IPty>} */
const sessions = {};

function killAll() {
  for (const id of Object.keys(sessions)) {
    try {
      sessions[id].kill();
    } catch (_) {
      // already dead
    }
    delete sessions[id];
  }
}

function register(ipcMain, getWindow) {
  // --- pty:start ---
  ipcMain.handle('pty:start', async (_event, opts) => {
    try {
      const { id, cwd } = opts;
      const shell = process.env.SHELL || '/bin/zsh';
      const env = { ...process.env };
      env.PATH = os.homedir() + '/.local/bin:' + env.PATH;
      env.FLEET_DIR = cwd + '/.fleet';
      env.FLEET_AGENT = 'human';

      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd,
        env,
      });

      ptyProcess.onData((data) => {
        const win = getWindow();
        if (win) win.webContents.send('pty:data', { id, data });
      });

      ptyProcess.onExit(({ exitCode }) => {
        const win = getWindow();
        if (win) win.webContents.send('pty:exit', { id, exitCode });
        delete sessions[id];
      });

      sessions[id] = ptyProcess;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- pty:write ---
  ipcMain.on('pty:write', (_event, id, data) => {
    sessions[id]?.write(data);
  });

  // --- pty:resize ---
  ipcMain.on('pty:resize', (_event, id, cols, rows) => {
    sessions[id]?.resize(cols, rows);
  });

  // --- pty:kill ---
  ipcMain.on('pty:kill', (_event, id) => {
    try {
      sessions[id]?.kill();
    } catch (_) {
      // already dead
    }
    delete sessions[id];
  });

  // --- quit cleanup: kill only tracked ptys, nothing else ---
  app.on('will-quit', killAll);
}

module.exports = { register };
