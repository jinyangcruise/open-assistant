/**
 * Preload script for the overlay (floating status bar) window.
 * Provides a minimal IPC bridge for overlay-specific communication.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /** Tell main process to abort the current AI analysis */
  cancelProcessing: () => ipcRenderer.send('cancel-processing'),

  /** Enable or disable mouse event forwarding on the overlay window */
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('set-ignore-mouse-events', ignore),

  /** Start window drag — records base position + mouse origin in main process */
  startDrag: (mouseX, mouseY, winScreenX, winScreenY) => ipcRenderer.send('overlay-drag-start', mouseX, mouseY, winScreenX, winScreenY),

  /** Continue window drag — main process computes delta and repositions */
  dragMove: (mouseX, mouseY) => ipcRenderer.send('overlay-drag-move', mouseX, mouseY),

  /** End window drag — clears drag state in main process */
  endDrag: () => ipcRenderer.send('overlay-drag-end'),

  /** Forward a debug log message to the main process terminal (--dev only) */
  debugLog: (...args) => ipcRenderer.send('overlay-debug-log', ...args),

  /** Get window position from main process (BrowserWindow.getPosition) */
  getWindowPosition: () => ipcRenderer.invoke('overlay-get-position'),

  /** Send renderer position/size to main process for debug logging */
  sendDebugPos: (screenX, screenY, innerW, innerH) => ipcRenderer.send('overlay-debug-pos', screenX, screenY, innerW, innerH),
});
