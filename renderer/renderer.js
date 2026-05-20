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

// Prompt state
let prompts = [];
let selectedPromptId = 'system-default';
let editingPromptId = null;

// Prompt DOM Elements
const promptsList = document.getElementById('promptsList');
const addPromptBtn = document.getElementById('addPromptBtn');
const editPromptBtn = document.getElementById('editPromptBtn');
const deletePromptBtn = document.getElementById('deletePromptBtn');
const promptEditor = document.getElementById('promptEditor');
const promptName = document.getElementById('promptName');
const promptContent = document.getElementById('promptContent');
const savePromptBtn = document.getElementById('savePromptBtn');
const cancelPromptBtn = document.getElementById('cancelPromptBtn');

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
  
  // Load prompt management
  await loadPrompts();
  
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
  
  // Prompt management
  setupPromptEventListeners();
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

// ===== Prompt Management =====

function setupPromptEventListeners() {
  addPromptBtn.addEventListener('click', function() {
    showPromptEditor(null);
  });

  editPromptBtn.addEventListener('click', function() {
    var prompt = prompts.find(function(p) { return p.id === selectedPromptId; });
    if (prompt) showPromptEditor(prompt);
  });

  deletePromptBtn.addEventListener('click', async function() {
    var prompt = prompts.find(function(p) { return p.id === selectedPromptId; });
    if (!prompt) return;
    if (!confirm('Delete prompt "' + prompt.name + '"?')) return;
    var result = await window.electronAPI.deletePrompt(prompt.id);
    prompts = result.prompts;
    selectedPromptId = result.selectedId;
    renderPrompts();
    addLog('Deleted prompt: ' + prompt.name, 'info');
  });

  savePromptBtn.addEventListener('click', async function() {
    await savePrompt();
  });

  cancelPromptBtn.addEventListener('click', function() {
    hidePromptEditor();
  });
}

async function loadPrompts() {
  var result = await window.electronAPI.getPrompts();
  prompts = result.prompts || [];
  selectedPromptId = result.selectedId || 'system-default';
  renderPrompts();
}

function renderPrompts() {
  // Clear list
  promptsList.innerHTML = '';

  // System default prompt (always first, built-in)
  var defaultItem = document.createElement('div');
  defaultItem.className = 'prompt-item' + (selectedPromptId === 'system-default' ? ' selected' : '');
  defaultItem.dataset.promptId = 'system-default';
  defaultItem.innerHTML = '<div class="prompt-item-radio">' +
    (selectedPromptId === 'system-default' ? '&#9679;' : '&#9675;') +
    '</div>' +
    '<div class="prompt-item-info">' +
    '  <div class="prompt-item-name">System Default</div>' +
    '  <div class="prompt-item-preview">Built-in prompt: analyze screenshot and provide smart completion suggestions</div>' +
    '</div>';
  defaultItem.addEventListener('click', async function() {
    await window.electronAPI.selectPrompt('system-default');
    selectedPromptId = 'system-default';
    renderPrompts();
    addLog('Selected prompt: System Default', 'info');
  });
  promptsList.appendChild(defaultItem);

  // User-defined prompts
  for (var i = 0; i < prompts.length; i++) {
    var p = prompts[i];
    var preview = p.content ? p.content.substring(0, 60).replace(/\n/g, ' ') : '(empty)';
    if (p.content && p.content.length > 60) preview += '...';
    
    var item = document.createElement('div');
    item.className = 'prompt-item' + (selectedPromptId === p.id ? ' selected' : '');
    item.dataset.promptId = p.id;
    item.innerHTML = '<div class="prompt-item-radio">' +
      (selectedPromptId === p.id ? '&#9679;' : '&#9675;') +
      '</div>' +
      '<div class="prompt-item-info">' +
      '  <div class="prompt-item-name">' + escapeHtml(p.name) + '</div>' +
      '  <div class="prompt-item-preview">' + escapeHtml(preview) + '</div>' +
      '</div>';
    item.addEventListener('click', (function(pid) {
      return async function() {
        await window.electronAPI.selectPrompt(pid);
        selectedPromptId = pid;
        renderPrompts();
        var found = prompts.find(function(p) { return p.id === pid; });
        addLog('Selected prompt: ' + (found ? found.name : pid), 'info');
      };
    })(p.id));
    promptsList.appendChild(item);
  }

  // Update button states
  editPromptBtn.disabled = selectedPromptId === 'system-default';
  deletePromptBtn.disabled = selectedPromptId === 'system-default' || !prompts.length;
}

function showPromptEditor(prompt) {
  if (prompt) {
    promptName.value = prompt.name || '';
    promptContent.value = prompt.content || '';
    editingPromptId = prompt.id;
  } else {
    promptName.value = '';
    promptContent.value = '';
    editingPromptId = null;
  }
  promptEditor.style.display = 'block';
}

function hidePromptEditor() {
  promptEditor.style.display = 'none';
  promptName.value = '';
  promptContent.value = '';
  editingPromptId = null;
}

async function savePrompt() {
  var name = promptName.value.trim();
  var content = promptContent.value.trim();
  
  if (!name) {
    alert('Please enter a prompt name.');
    return;
  }
  if (!content) {
    alert('Please enter prompt content.');
    return;
  }

  var data = {
    id: editingPromptId,
    name: name,
    content: content
  };

  var result = await window.electronAPI.savePrompt(data);
  prompts = result.prompts;
  hidePromptEditor();
  renderPrompts();
  
  addLog('Prompt saved: ' + name, 'success');
}

// Start
init().catch(console.error);
