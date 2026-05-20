/**
 * Preload script - Secure bridge between main and renderer processes
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Config management
  getConfig: () => ipcRenderer.invoke('get-config'),
  updateConfig: (updates) => ipcRenderer.invoke('update-config', updates),
  
  // Assistant control
  triggerAssistant: () => ipcRenderer.invoke('trigger-assistant'),
  
  // Logs
  getLogs: () => ipcRenderer.invoke('get-logs'),
  
  // Event listeners
  onAnalysisResult: (callback) => {
    ipcRenderer.on('analysis-result', (event, data) => callback(data));
  },
  onError: (callback) => {
    ipcRenderer.on('error', (event, error) => callback(error));
  }
});
