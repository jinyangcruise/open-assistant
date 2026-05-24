/**
 * Renderer Process - UI Logic
 */

// State
let config = {};

// DOM Elements
const configForm = document.getElementById('configForm');
const resetBtn = document.getElementById('resetBtn');
const resultContainer = document.getElementById('resultContainer');
const logContainer = document.getElementById('logContainer');

// Prompt state
let prompts = [];
let selectedPromptId = 'system-default';
let editingPromptId = null;
let defaultPromptText = '';

// Agent state
let agents = [];
let selectedAgentIds = [];

// Shortcut recorder state
let recorderAgentId = null;
let recorderPromptId = null;
let recorderShortcut = null;

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
const resetDefaultPromptBtn = document.getElementById('resetDefaultPromptBtn');

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
  window.electronAPI.onConfigUpdated(async (newConfig) => {
    config = newConfig;
    populateForm(config);
    await loadPrompts();
    addLog('Configuration updated from tray', 'info');
  });
  
  // Load prompt management
  await loadPrompts();

  addLog('Application initialized', 'info');
}

function setupEventListeners() {
  // Auto-save on any form field change
  const formInputs = configForm.querySelectorAll('input, select');
  for (const input of formInputs) {
    input.addEventListener('change', async () => {
      await saveConfig();
    });
  }
  
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
  
  // Agent management
  setupAgentEventListeners();
  
  // Shortcut recorder modal events
  document.getElementById('recorderConfirm').addEventListener('click', confirmShortcut);
  document.getElementById('recorderCancel').addEventListener('click', cancelShortcut);
  document.getElementById('shortcutRecorderOverlay').addEventListener('click', function(e) {
    if (e.target === this) cancelShortcut();
  });
}

async function saveConfig() {
  const formData = new FormData(configForm);
  const updates = {};
  
  for (const [key, value] of formData.entries()) {
    if (key === 'auto_insert') {
      updates[key] = value === 'true';
    } else if (key === 'show_notifications') {
      updates[key] = formData.get(key) === 'on';
    } else if (key === 'timeout_seconds') {
      updates[key] = parseInt(value, 10);
    } else {
      updates[key] = value;
    }
  }
  
  try {
    config = await window.electronAPI.updateConfig(updates);
    addLog('Configuration saved', 'success');
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, 'error');
  }
}

function populateForm(config) {
  document.getElementById('timeout').value = config.timeout_seconds || 30;
  document.getElementById('autoInsert').value = config.auto_insert !== false ? 'true' : 'false';
  document.getElementById('showNotifications').checked = config.show_notifications !== false;
  document.getElementById('logLevel').value = config.log_level || 'info';
  document.getElementById('responseMode').value = config.response_mode || 'sse-fetch';
  document.getElementById('outputMode').value = config.output_mode || 'streaming';
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
    if (selectedPromptId === 'system-default') {
      // Edit the built-in default prompt
      showPromptEditor({ id: 'system-default', name: 'System Default', content: defaultPromptText });
    } else {
      var prompt = prompts.find(function(p) { return p.id === selectedPromptId; });
      if (prompt) showPromptEditor(prompt);
    }
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

  // Reset default prompt to built-in
  resetDefaultPromptBtn.addEventListener('click', async function() {
    if (!confirm('确定恢复为内置默认提示词？')) return;
    var result = await window.electronAPI.resetDefaultPrompt();
    promptContent.value = result.defaultPrompt;
    defaultPromptText = result.defaultPrompt;
    renderPrompts();
    addLog('默认提示词已恢复为内置值', 'info');
  });
}

async function loadPrompts() {
  var result = await window.electronAPI.getPrompts();
  prompts = result.prompts || [];
  selectedPromptId = result.selectedId || 'system-default';
  defaultPromptText = result.defaultPrompt || '';
  renderPrompts();
  // Re-render agent prompt capsules with updated prompt list
  await loadAgents();
}

function renderPrompts() {
  // Clear list
  promptsList.innerHTML = '';

  // System default prompt (always first, built-in)
  // Generate preview from actual default_prompt text in config
  var preview = defaultPromptText ? defaultPromptText.substring(0, 60).replace(/\n/g, ' ') : '(empty)';
  if (defaultPromptText && defaultPromptText.length > 60) preview += '...';
  var defaultItem = document.createElement('div');
  defaultItem.className = 'prompt-item' + (selectedPromptId === 'system-default' ? ' selected' : '');
  defaultItem.dataset.promptId = 'system-default';
  defaultItem.innerHTML = '<div class="prompt-item-radio">' +
    (selectedPromptId === 'system-default' ? '&#9679;' : '&#9675;') +
    '</div>' +
    '<div class="prompt-item-info">' +
    '  <div class="prompt-item-name">System Default</div>' +
    '  <div class="prompt-item-preview">' + (defaultPromptText ? escapeHtml(preview) : '(empty)') + '</div>' +
    '</div>';
  defaultItem.addEventListener('click', async function() {
    await window.electronAPI.selectPrompt('system-default');
    selectedPromptId = 'system-default';
    renderPrompts();
    addLog('Selected prompt for editing: System Default', 'info');
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
        addLog('Selected prompt for editing: ' + (found ? found.name : pid), 'info');
      };
    })(p.id));
    promptsList.appendChild(item);
  }

  // Update button states — Edit is always enabled (works for both system-default and user prompts)
  editPromptBtn.disabled = false;
  deletePromptBtn.disabled = selectedPromptId === 'system-default' || !prompts.length;
}

function showPromptEditor(prompt) {
  // Always reset to enabled first (especially if previous edit was system-default)
  promptName.disabled = false;
  if (prompt) {
    promptName.value = prompt.name || '';
    promptContent.value = prompt.content || '';
    editingPromptId = prompt.id;
    // Disable name field for system-default (name is fixed)
    if (prompt.id === 'system-default') promptName.disabled = true;
    resetDefaultPromptBtn.style.display = prompt.id === 'system-default' ? 'inline-block' : 'none';
  } else {
    promptName.value = '';
    promptContent.value = '';
    editingPromptId = null;
    resetDefaultPromptBtn.style.display = 'none';
  }
  promptEditor.style.display = 'block';
}

function hidePromptEditor() {
  promptEditor.style.display = 'none';
  promptName.value = '';
  promptContent.value = '';
  promptName.disabled = false;
  editingPromptId = null;
  resetDefaultPromptBtn.style.display = 'none';
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

  // Handle system-default editing via updateDefaultPrompt IPC
  if (editingPromptId === 'system-default') {
    var result = await window.electronAPI.updateDefaultPrompt(content);
    defaultPromptText = result.defaultPrompt;
    hidePromptEditor();
    renderPrompts();
    addLog('默认提示词已更新', 'success');
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

// ===== Agent Management =====

const agentsList = document.getElementById('agentsList');

function setupAgentEventListeners() {
  // Card toggle via event delegation
  agentsList.addEventListener('click', function(e) {
    var card = e.target.closest('.agent-item');
    if (!card) return;
    // Don't toggle when clicking on form controls or interactive elements
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
    var agentId = card.dataset.agentId;
    if (agentId) toggleAgent(agentId);
  });
}

async function loadAgents() {
  try {
    var result = await window.electronAPI.getAgents();
    agents = result.agents || [];
    selectedAgentIds = result.selectedIds || [];
    renderAgents();

    // Auto-detect install path for agents with empty install path
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      if (!a.installPath) {
        try {
          var detectResult = await window.electronAPI.detectInstallPath(a.id);
          if (detectResult && detectResult.path) {
            await window.electronAPI.updateAgentConfig(a.id, { install_path: detectResult.path });
            addLog('Auto-detected install path for ' + a.name + ': ' + detectResult.path, 'info');
          }
        } catch (detectError) {
          // Silently ignore detection failures
          console.log('Install path detection failed for', a.id, detectError.message);
        }
      }
    }

    // Re-render if any paths were updated
    if (agents.some(function(a) { return !a.installPath; })) {
      var updatedResult = await window.electronAPI.getAgents();
      agents = updatedResult.agents || [];
      renderAgents();
    }
  } catch (error) {
    addLog('Failed to load agents: ' + error.message, 'error');
  }
}

function renderAgents() {
  agentsList.innerHTML = '';

  if (agents.length === 0) {
    agentsList.innerHTML = '<p class="placeholder">No AI Agents configured.</p>';
    return;
  }

  for (var i = 0; i < agents.length; i++) {
    var a = agents[i];
    var isSelected = selectedAgentIds.includes(a.id);
    var promptShortcuts = a.promptShortcuts || {};

    var item = document.createElement('div');
    item.className = 'agent-item' + (isSelected ? ' selected' : '');
    item.dataset.agentId = a.id;

    var typeLabel = a.type === 'electron' ? 'Desktop' : 'Web';

    item.innerHTML =
      '<div class="agent-item-checkbox">' +
      '  <input type="checkbox" class="agent-checkbox" data-agent-id="' + a.id + '" ' +
      (isSelected ? 'checked' : '') + ' />' +
      '</div>' +
      '<div class="agent-item-info">' +
      '  <div class="agent-item-header">' +
      '    <div class="agent-item-name">' + escapeHtml(a.name) + '</div>' +
      '    <span class="agent-item-type">' + typeLabel + '</span>' +
      '  </div>' +
      '  <div class="agent-item-status" id="agent-status-' + a.id + '"></div>' +
      '  <div class="agent-endpoint-row">' +
      '    <label class="agent-endpoint-label">CDP Endpoint:</label>' +
      '    <input type="text" class="agent-endpoint-input" data-agent-id="' + a.id + '" ' +
      '      value="' + escapeHtml(a.endpoint) + '" />' +
      '    <button class="btn btn-xs btn-secondary test-btn" data-agent-id="' + a.id + '">Test</button>' +
      '  </div>' +
      '  <div class="agent-install-path">' +
      '    <label class="install-path-label">Install Path:</label>' +
      '    <input type="text" class="install-path-input" data-agent-id="' + a.id + '" ' +
      '      value="' + escapeHtml(a.installPath || '') + '" ' +
      '      placeholder="Leave empty for auto-detect" />' +
      '  </div>' +
      '  <div class="agent-prompts-section">' +
      '    <div class="agent-prompts-title">Prompts</div>' +
      '    <div class="agent-prompts-list" id="prompts-list-' + a.id + '">' +
      '    </div>' +
      '  </div>' +
      '</div>';

    agentsList.appendChild(item);

    // Render prompt capsules for this agent
    renderAgentPromptCapsules(a, promptShortcuts, item);

    // Checkbox toggle via change event (the actual checkbox input)
    var checkbox = item.querySelector('.agent-checkbox');
    checkbox.addEventListener('change', (function(agentId) {
      return async function(e) {
        e.stopPropagation();
        await toggleAgent(agentId);
      };
    })(a.id));

    // Auto-save install path on change/blur
    (function(agentId, input) {
      input.addEventListener('change', async function(e) {
        e.stopPropagation();
        var value = this.value.trim();
        await window.electronAPI.updateAgentConfig(agentId, { install_path: value });
        addLog('Install path updated for ' + agentId, 'info');
      });
      input.addEventListener('blur', async function(e) {
        e.stopPropagation();
        var value = this.value.trim();
        await window.electronAPI.updateAgentConfig(agentId, { install_path: value });
      });
    })(a.id, item.querySelector('.install-path-input'));

    // Auto-save endpoint on change/blur
    (function(agentId, input) {
      input.addEventListener('change', async function(e) {
        e.stopPropagation();
        var value = this.value.trim();
        await window.electronAPI.updateAgentConfig(agentId, { endpoint: value });
        addLog('CDP Endpoint updated for ' + agentId, 'info');
      });
      input.addEventListener('blur', async function(e) {
        e.stopPropagation();
        var value = this.value.trim();
        await window.electronAPI.updateAgentConfig(agentId, { endpoint: value });
      });
    })(a.id, item.querySelector('.agent-endpoint-input'));
  }

  // Attach test button handlers
  var testBtns = agentsList.querySelectorAll('.test-btn');
  for (var k = 0; k < testBtns.length; k++) {
    (function(btn) {
      btn.addEventListener('click', async function(e) {
        e.stopPropagation();
        var agentId = btn.dataset.agentId;
        await testAgentConnection(agentId);
      });
    })(testBtns[k]);
  }
}

function renderAgentPromptCapsules(agent, promptShortcuts, agentItem) {
  var listEl = agentItem.querySelector('.agent-prompts-list');
  if (!listEl) return;

  listEl.innerHTML = '';

  // Helper to render a capsule for a prompt
  function createCapsule(promptId, promptName) {
    var ps = promptShortcuts[promptId] || {};
    var shortcut = (ps.shortcut || '').trim();
    var enabled = !!ps.enabled;

    var capsule = document.createElement('div');
    capsule.className = 'prompt-capsule' + (enabled ? ' active' : '');

    var shortcutDisplay = shortcut
      ? '<span class="capsule-shortcut-text">' + escapeHtml(shortcut.replace('Control', 'Ctrl')) + '</span>'
      : '<span class="capsule-shortcut-unset">未设置</span>';

    capsule.innerHTML =
      '<div class="prompt-capsule-info">' +
      '  <div class="prompt-capsule-name">' + escapeHtml(promptName) + '</div>' +
      '  <div class="prompt-capsule-shortcut">' +
            shortcutDisplay +
      '    <button class="capsule-edit-btn" data-agent-id="' + agent.id + '" data-prompt-id="' + promptId + '" title="设置快捷键">✏️</button>' +
      '  </div>' +
      '</div>' +
      '<button class="prompt-capsule-toggle" data-agent-id="' + agent.id + '" data-prompt-id="' + promptId + '">' +
      '  <div class="toggle-track' + (enabled ? ' active' : '') + '">' +
      '    <div class="toggle-knob"></div>' +
      '  </div>' +
      '</button>';

    // Edit button: open shortcut recorder
    var editBtn = capsule.querySelector('.capsule-edit-btn');
    editBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      showShortcutRecorder(agent.id, promptId);
    });

    // Toggle button: enable/disable this prompt shortcut
    var toggleBtn = capsule.querySelector('.prompt-capsule-toggle');
    toggleBtn.addEventListener('click', async function(e) {
      e.stopPropagation();
      var newEnabled = !enabled;
      await window.electronAPI.setPromptEnabled(agent.id, promptId, newEnabled);
      addLog((newEnabled ? 'Enabled' : 'Disabled') + ' prompt: ' + promptName + ' for ' + agent.name, 'info');
      // Reload agents to reflect changes
      await loadAgents();
    });

    return capsule;
  }

  // System Default prompt (always first)
  listEl.appendChild(createCapsule('system-default', 'System Default'));

  // User-defined prompts
  for (var j = 0; j < prompts.length; j++) {
    var p = prompts[j];
    listEl.appendChild(createCapsule(p.id, p.name));
  }
}

async function toggleAgent(id) {
  try {
    var result = await window.electronAPI.toggleAgent(id);
    // Refresh selectedAgentIds from agents list
    selectedAgentIds = agents.filter(function(a) { return a.id === id ? result.selected : a.selected; }).map(function(a) { return a.id; });
    // Simpler approach: just reload agents
    await loadAgents();
    var found = agents.find(function(a) { return a.id === id; });
    addLog((result.selected ? 'Enabled' : 'Disabled') + ' agent: ' + (found ? found.name : id), 'info');
  } catch (error) {
    addLog('Error toggling agent: ' + error.message, 'error');
  }
}

async function testAgentConnection(id) {
  var statusEl = document.getElementById('agent-status-' + id);
  if (statusEl) {
    statusEl.className = 'agent-item-status testing';
    statusEl.textContent = 'Testing...';
  }

  addLog('Testing connection for agent: ' + id + '...', 'info');

  try {
    var result = await window.electronAPI.testAgentConnection(id);
    if (result.success) {
      if (statusEl) {
        statusEl.className = 'agent-item-status connected';
        statusEl.textContent = 'Connected' + (result.title ? ' (' + result.title + ')' : '');
      }
      addLog('Agent connected: ' + id, 'success');
    } else {
      if (statusEl) {
        statusEl.className = 'agent-item-status disconnected';
        statusEl.textContent = 'Disconnected';
      }
      addLog('Agent connection failed: ' + id + ' - ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    if (statusEl) {
      statusEl.className = 'agent-item-status disconnected';
      statusEl.textContent = 'Error';
    }
    addLog('Error testing agent connection: ' + error.message, 'error');
  }
}

// ===== Shortcut Recorder =====

var recorderKeyHandler = null;

function parseKeyEvent(e) {
  var parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');

  // Exclude standalone modifier keys
  var key = e.key;
  var code = e.code;
  var modifierKeys = ['Control', 'Shift', 'Alt', 'Meta'];
  if (modifierKeys.includes(key)) {
    // Only modifier keys pressed, not a complete shortcut
    return '';
  }

  var keyMap = {
    ' ': 'Space',
    'ArrowUp': 'Up',
    'ArrowDown': 'Down',
    'ArrowLeft': 'Left',
    'ArrowRight': 'Right',
    'Escape': 'Escape',
    'Enter': 'Enter',
    'Tab': 'Tab',
    'Delete': 'Delete',
    'Backspace': 'Backspace',
    'Insert': 'Insert',
    'Home': 'Home',
    'End': 'End',
    'PageUp': 'PageUp',
    'PageDown': 'PageDown',
  };

  if (keyMap[key]) {
    parts.push(keyMap[key]);
  } else if (key.length === 1) {
    // Single character keys (letters, numbers, punctuation)
    parts.push(key.toUpperCase());
  } else if (code) {
    // Fallback to e.code for keys where e.key might be unreliable
    if (code.startsWith('Digit')) {
      parts.push(code.replace('Digit', ''));
    } else if (code.startsWith('Key')) {
      parts.push(code.replace('Key', ''));
    } else {
      parts.push(code);
    }
  }

  return parts.join('+');
}

function showShortcutRecorder(agentId, promptId) {
  recorderAgentId = agentId;
  recorderPromptId = promptId;
  recorderShortcut = null;

  var overlay = document.getElementById('shortcutRecorderOverlay');
  var display = document.getElementById('recorderDisplay');
  var status = document.getElementById('recorderStatus');
  var confirmBtn = document.getElementById('recorderConfirm');

  display.textContent = '—';
  status.textContent = '';
  status.className = 'recorder-status';
  confirmBtn.disabled = true;
  overlay.style.display = 'flex';

  // Suspend all global shortcuts so they don't intercept the recording
  window.electronAPI.suspendShortcuts();

  // Listen for keydown events
  recorderKeyHandler = function(e) {
    e.preventDefault();
    e.stopPropagation();

    var shortcut = parseKeyEvent(e);

    // Show modifier-only feedback so user knows keys are being detected
    var modifierKeys = ['Control', 'Shift', 'Alt', 'Meta'];
    if (!shortcut && modifierKeys.includes(e.key)) {
      var modParts = [];
      if (e.ctrlKey) modParts.push('Ctrl');
      if (e.shiftKey) modParts.push('Shift');
      if (e.altKey) modParts.push('Alt');
      if (e.metaKey) modParts.push('Cmd');
      display.textContent = modParts.join('+');
      status.textContent = '继续按下其他键...';
      status.className = 'recorder-status hint';
      return;
    }

    if (!shortcut) return;

    recorderShortcut = shortcut;
    display.textContent = shortcut.replace('Control', 'Ctrl');

    // Check system conflict
    window.electronAPI.checkShortcut(shortcut).then(function(result) {
      if (result.available) {
        status.textContent = '';
        status.className = 'recorder-status';
      } else {
        status.textContent = '⚠ 该快捷键可能被其他软件占用';
        status.className = 'recorder-status warning';
      }
      confirmBtn.disabled = false;
    });
  };

  document.addEventListener('keydown', recorderKeyHandler);
}

function hideShortcutRecorder() {
  if (recorderKeyHandler) {
    document.removeEventListener('keydown', recorderKeyHandler);
    recorderKeyHandler = null;
  }
  recorderAgentId = null;
  recorderPromptId = null;
  recorderShortcut = null;
  document.getElementById('shortcutRecorderOverlay').style.display = 'none';
  // Resume global shortcuts that were suspended during recording
  window.electronAPI.resumeShortcuts();
}

async function confirmShortcut() {
  if (!recorderAgentId || !recorderPromptId || !recorderShortcut) return;

  var confirmBtn = document.getElementById('recorderConfirm');
  var status = document.getElementById('recorderStatus');
  confirmBtn.disabled = true;
  status.textContent = '保存中...';
  status.className = 'recorder-status';

  var result = await window.electronAPI.savePromptShortcut(recorderAgentId, recorderPromptId, recorderShortcut);

  if (result.success) {
    addLog('Shortcut saved for ' + recorderAgentId + '/' + recorderPromptId + ': ' + recorderShortcut, 'success');
    hideShortcutRecorder();
    // Reload agents to update display
    await loadAgents();
  } else if (result.error) {
    status.textContent = '✗ ' + result.error;
    status.className = 'recorder-status error';
    confirmBtn.disabled = false;
  }
}

function cancelShortcut() {
  hideShortcutRecorder();
}

// Start
init().catch(console.error);
