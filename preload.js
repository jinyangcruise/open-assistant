/**
 * Preload script - Secure bridge between main and renderer processes
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Config management
  getConfig: () => ipcRenderer.invoke('get-config'),
  updateConfig: (updates) => ipcRenderer.invoke('update-config', updates),
  
  // Logs
  getLogs: () => ipcRenderer.invoke('get-logs'),
  
  // Prompt management
  getPrompts: () => ipcRenderer.invoke('get-prompts'),
  savePrompt: (data) => ipcRenderer.invoke('save-prompt', data),
  deletePrompt: (id) => ipcRenderer.invoke('delete-prompt', id),
  selectPrompt: (id) => ipcRenderer.invoke('select-prompt', id),
  updateDefaultPrompt: (text) => ipcRenderer.invoke('update-default-prompt', text),
  resetDefaultPrompt: () => ipcRenderer.invoke('reset-default-prompt'),

  // Agent management
  getAgents: () => ipcRenderer.invoke('get-agents'),
  toggleAgent: (id) => ipcRenderer.invoke('toggle-agent', id),
  testAgentConnection: (id) => ipcRenderer.invoke('test-agent-connection', id),
  updateAgentConfig: (agentId, updates) => ipcRenderer.invoke('update-agent-config', agentId, updates),
  detectInstallPath: (agentId) => ipcRenderer.invoke('detect-install-path', agentId),
  savePromptShortcut: (agentId, promptId, shortcut) => ipcRenderer.invoke('save-prompt-shortcut', agentId, promptId, shortcut),
  setPromptEnabled: (agentId, promptId, enabled) => ipcRenderer.invoke('set-prompt-enabled', agentId, promptId, enabled),
  checkShortcut: (shortcut) => ipcRenderer.invoke('check-shortcut', shortcut),
  suspendShortcuts: () => ipcRenderer.invoke('suspend-shortcuts'),
  resumeShortcuts: () => ipcRenderer.invoke('resume-shortcuts'),
  
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
  },

  // Utilities
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});

// Suppress link navigation inside the Electron window
document.addEventListener('click', (e) => {
  const link = e.target.closest('a');
  if (link && link.href && (link.href.startsWith('http://') || link.href.startsWith('https://'))) {
    e.preventDefault();
    ipcRenderer.invoke('open-external', link.href);
  }
});
