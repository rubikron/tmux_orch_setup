// fleetor — terminal.js — xterm.js terminal wired to pty
import { Terminal } from './vendor/xterm.js';
import { FitAddon } from './vendor/addon-fit.js';

let cssInjected = false;

/**
 * Inject xterm CSS into the document head exactly once.
 * Guards against double-injection so index.html stays untouched.
 */
function injectCSS() {
  if (cssInjected) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = './vendor/xterm.css';
  document.head.appendChild(link);
  cssInjected = true;
}

/**
 * Mount a live terminal in `el` backed by a pty session identified by `id`,
 * starting in directory `cwd`.
 *
 * @param {{ el: HTMLElement, id: string, cwd: string }} opts
 * @returns {{ fit: () => void, focus: () => void, dispose: () => void }}
 */
export function initTerminal({ el, id, cwd }) {
  injectCSS();

  // --- Create terminal with dark theme matching fleetor palette ---
  const term = new Terminal({
    theme: {
      background: '#0a0c10',
      foreground: '#d4d4d4',
      cursor: '#c0c0c0',
      cursorAccent: '#0a0c10',
      selectionBackground: '#264f78',
      black: '#1a1a1a',
      red: '#cd3131',
      green: '#0dbc79',
      yellow: '#e5e510',
      blue: '#2472c8',
      magenta: '#bc3fbc',
      cyan: '#11a8cd',
      white: '#e5e5e5',
      brightBlack: '#666666',
      brightRed: '#f14c4c',
      brightGreen: '#23d18b',
      brightYellow: '#f5f543',
      brightBlue: '#3b8eea',
      brightMagenta: '#d670d6',
      brightCyan: '#29b8db',
      brightWhite: '#ffffff',
    },
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
  });

  // --- Fit addon ---
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  // Mount terminal into DOM
  term.open(el);
  fitAddon.fit();

  // Start the pty session (fire-and-forget — pty data flows when ready)
  window.fleet.ptyStart({ id, cwd });

  // --- Wire data: pty → terminal ---
  const unsubPtyData = window.fleet.onPtyData(({ id: sessionId, data }) => {
    if (sessionId === id) term.write(data);
  });

  // --- Wire data: terminal → pty ---
  term.onData((data) => {
    window.fleet.ptyWrite(id, data);
  });

  // --- Resize: container resize → fit terminal + propagate cols/rows to pty ---
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    window.fleet.ptyResize(id, term.cols, term.rows);
  });
  resizeObserver.observe(el);

  // --- Return terminal handle ---
  return {
    fit() {
      fitAddon.fit();
    },
    focus() {
      term.focus();
    },
    dispose() {
      unsubPtyData();
      resizeObserver.disconnect();
      window.fleet.ptyKill(id);
      term.dispose();
    },
  };
}
