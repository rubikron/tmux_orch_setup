const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fleet', {
  // --- fleet: channels (invoke/handle) ---
  pickDirectory: () => ipcRenderer.invoke('fleet:pickDirectory'),
  spawn: (repoPath, opts) => ipcRenderer.invoke('fleet:spawn', repoPath, opts),
  stop: (repoPath) => ipcRenderer.invoke('fleet:stop', repoPath),
  getDashboardPort: () => ipcRenderer.invoke('fleet:getDashboardPort'),

  // --- fleet:spawnLog (main→renderer event) ---
  onSpawnLog: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on('fleet:spawnLog', handler);
    return () => ipcRenderer.removeListener('fleet:spawnLog', handler);
  },

  // --- pty: channels (invoke/handle) ---
  ptyStart: (opts) => ipcRenderer.invoke('pty:start', opts),

  // --- pty: channels (send — fire-and-forget) ---
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyKill: (id) => ipcRenderer.send('pty:kill', id),

  // --- pty: events (main→renderer) ---
  onPtyData: (cb) => {
    const handler = (_event, m) => cb(m);
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
  },
  onPtyExit: (cb) => {
    const handler = (_event, m) => cb(m);
    ipcRenderer.on('pty:exit', handler);
    return () => ipcRenderer.removeListener('pty:exit', handler);
  },
});
