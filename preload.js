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
  
  // Prompt management
  getPrompts: () => ipcRenderer.invoke('get-prompts'),
  savePrompt: (data) => ipcRenderer.invoke('save-prompt', data),
  deletePrompt: (id) => ipcRenderer.invoke('delete-prompt', id),
  selectPrompt: (id) => ipcRenderer.invoke('select-prompt', id),
  
  // Event listeners
  onAnalysisResult: (callback) => {
    ipcRenderer.on('analysis-result', (event, data) => callback(data));
  },
  onError: (callback) => {
    ipcRenderer.on('error', (event, error) => callback(error));
  }
});
