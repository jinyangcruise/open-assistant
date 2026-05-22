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
});
