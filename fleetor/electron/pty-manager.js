function register(ipcMain, getWindow) {
  // --- pty:start — stub ---
  ipcMain.handle('pty:start', async (_event, opts) => {
    return { ok: false, error: 'not implemented' };
  });

  // --- pty:write — no-op stub ---
  ipcMain.on('pty:write', (_event, id, data) => {
    // t-003 fills
  });

  // --- pty:resize — no-op stub ---
  ipcMain.on('pty:resize', (_event, id, cols, rows) => {
    // t-003 fills
  });

  // --- pty:kill — no-op stub ---
  ipcMain.on('pty:kill', (_event, id) => {
    // t-003 fills
  });
}

module.exports = { register };
