/**
 * Renderer Process - UI Logic
 */

// State
let config = {};
let isProcessing = false;

// DOM Elements
const triggerBtn = document.getElementById('triggerBtn');
const configForm = document.getElementById('configForm');
const resetBtn = document.getElementById('resetBtn');
const shortcutDisplay = document.getElementById('shortcutDisplay');
const statusIndicator = document.getElementById('statusIndicator');
const resultContainer = document.getElementById('resultContainer');
const logContainer = document.getElementById('logContainer');

// Initialize
async function init() {
  // Load config
  config = await window.electronAPI.getConfig();
  populateForm(config);
  
  // Setup event listeners
  setupEventListeners();
  
  // Setup IPC listeners
  window.electronAPI.onAnalysisResult(handleAnalysisResult);
  window.electronAPI.onError(handleError);
  
  addLog('Application initialized', 'info');
}

function setupEventListeners() {
  // Trigger button
  triggerBtn.addEventListener('click', async () => {
    await triggerAssistant();
  });
  
  // Config form
  configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveConfig();
  });
  
  // Reset button
  resetBtn.addEventListener('click', async () => {
    if (confirm('Reset all settings to defaults?')) {
      config = await window.electronAPI.getConfig();
      populateForm(config);
      addLog('Settings reset to defaults', 'info');
    }
  });
}

async function triggerAssistant() {
  if (isProcessing) {
    addLog('Already processing, please wait', 'warning');
    return;
  }
  
  isProcessing = true;
  triggerBtn.disabled = true;
  triggerBtn.textContent = 'Processing...';
  updateStatus('processing', 'Processing...');
  
  try {
    addLog('Triggering assistant...', 'info');
    await window.electronAPI.triggerAssistant();
  } catch (error) {
    addLog(`Error: ${error.message}`, 'error');
  } finally {
    isProcessing = false;
    triggerBtn.disabled = false;
    triggerBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>
      Trigger Assistant
    `;
    updateStatus('ready', 'Ready');
  }
}

async function saveConfig() {
  const formData = new FormData(configForm);
  const updates = {};
  
  for (const [key, value] of formData.entries()) {
    if (key === 'auto_insert' || key === 'show_notifications') {
      updates[key] = formData.get(key) === 'on';
    } else if (key === 'timeout_seconds') {
      updates[key] = parseInt(value, 10);
    } else {
      updates[key] = value;
    }
  }
  
  try {
    config = await window.electronAPI.updateConfig(updates);
    shortcutDisplay.textContent = config.shortcut.replace('Control', 'Ctrl');
    addLog('Configuration saved', 'success');
    alert('Configuration saved successfully!');
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, 'error');
    alert('Failed to save configuration');
  }
}

function populateForm(config) {
  document.getElementById('shortcut').value = config.shortcut || 'Control+Space';
  document.getElementById('cdpEndpoint').value = config.doubao_cdp_endpoint || 'http://127.0.0.1:9225';
  document.getElementById('timeout').value = config.timeout_seconds || 30;
  document.getElementById('autoInsert').checked = config.auto_insert !== false;
  document.getElementById('showNotifications').checked = config.show_notifications !== false;
  document.getElementById('logLevel').value = config.log_level || 'info';
  
  shortcutDisplay.textContent = (config.shortcut || 'Control+Space').replace('Control', 'Ctrl');
}

function handleAnalysisResult(result) {
  addLog('Analysis complete', 'success');
  displayResult(result);
}

function handleError(error) {
  addLog(`Error: ${error}`, 'error');
}

function displayResult(result) {
  const resultCard = document.createElement('div');
  resultCard.className = 'result-card';
  
  const typeLabel = result.type === 'code' ? '💻 Code' : '📄 Document';
  const typeClass = result.type;
  
  resultCard.innerHTML = `
    <div class="result-type ${typeClass}">${typeLabel}</div>
    <div class="result-text">${escapeHtml(result.text || 'No content')}</div>
    <div style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--text-secondary);">
      Generated at ${new Date(result.timestamp).toLocaleString()}
    </div>
  `;
  
  // Clear placeholder
  if (resultContainer.querySelector('.placeholder')) {
    resultContainer.innerHTML = '';
  }
  
  // Add to top
  resultContainer.insertBefore(resultCard, resultContainer.firstChild);
  
  // Keep only last 10 results
  while (resultContainer.children.length > 10) {
    resultContainer.removeChild(resultContainer.lastChild);
  }
}

function updateStatus(status, text) {
  const dot = statusIndicator.querySelector('.status-dot');
  const textEl = statusIndicator.querySelector('.status-text');
  
  textEl.textContent = text;
  
  if (status === 'processing') {
    dot.style.backgroundColor = '#fbbf24';
  } else if (status === 'error') {
    dot.style.backgroundColor = '#ef4444';
  } else {
    dot.style.backgroundColor = '#10b981';
  }
}

function addLog(message, type = 'info') {
  const logEntry = document.createElement('div');
  logEntry.className = 'log-entry';
  
  const time = new Date().toLocaleTimeString();
  const typeClass = `log-${type}`;
  
  logEntry.innerHTML = `
    <span class="log-time">[${time}]</span>
    <span class="${typeClass}">${message}</span>
  `;
  
  // Clear placeholder
  if (logContainer.querySelector('.placeholder')) {
    logContainer.innerHTML = '';
  }
  
  // Add to top
  logContainer.insertBefore(logEntry, logContainer.firstChild);
  
  // Keep only last 50 logs
  while (logContainer.children.length > 50) {
    logContainer.removeChild(logContainer.lastChild);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Start
init().catch(console.error);
