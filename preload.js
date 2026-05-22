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

  // Agent management
  getAgents: () => ipcRenderer.invoke('get-agents'),
  selectAgent: (id) => ipcRenderer.invoke('select-agent', id),
  testAgentConnection: (id) => ipcRenderer.invoke('test-agent-connection', id),
  
  // Event listeners
  onAnalysisResult: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('analysis-result', handler);
    // Return cleanup function
    return () => ipcRenderer.removeListener('analysis-result', handler);
  },
  onError: (callback) => {
    const handler = (event, error) => callback(error);
    ipcRenderer.on('error', handler);
    return () => ipcRenderer.removeListener('error', handler);
  },
  onConfigUpdated: (callback) => {
    const handler = (event, newConfig) => callback(newConfig);
    ipcRenderer.on('config-updated', handler);
    return () => ipcRenderer.removeListener('config-updated', handler);
  }
});
