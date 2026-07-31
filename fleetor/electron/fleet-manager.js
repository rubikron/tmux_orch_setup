const { dialog } = require('electron');

// Tracked children: { [key: string]: ChildProcess }
const children = {};

function register(ipcMain, getWindow) {
  // --- fleet:pickDirectory — real implementation ---
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

  // --- fleet:getDashboardPort — returns null for now ---
  ipcMain.handle('fleet:getDashboardPort', () => {
    return null;
  });

  // --- fleet:spawn — stub ---
  ipcMain.handle('fleet:spawn', async (_event, repoPath, _opts) => {
    return { ok: false, error: 'not implemented' };
  });

  // --- fleet:stop — stub ---
  ipcMain.handle('fleet:stop', async (_event, repoPath) => {
    return { ok: false, error: 'not implemented' };
  });
}

module.exports = { register };
