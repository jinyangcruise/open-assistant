/**
 * Renderer Process - UI Logic
 */

// State
let config = {};
let locale = {};
let currentLang = 'zh';

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

// Prompt Editor Modal Elements
const promptEditorOverlay = document.getElementById('promptEditorOverlay');
const promptEditorTitle = document.getElementById('promptEditorTitle');
const modalPromptName = document.getElementById('modalPromptName');
const modalPromptContent = document.getElementById('modalPromptContent');
const modalSavePromptBtn = document.getElementById('modalSavePromptBtn');
const modalCancelPromptBtn = document.getElementById('modalCancelPromptBtn');
const modalResetDefaultPromptBtn = document.getElementById('modalResetDefaultPromptBtn');

// Confirm Dialog Modal Elements
const confirmDialogOverlay = document.getElementById('confirmDialogOverlay');
const confirmDialogTitle = document.getElementById('confirmDialogTitle');
const confirmDialogMessage = document.getElementById('confirmDialogMessage');
const confirmDialogOk = document.getElementById('confirmDialogOk');
const confirmDialogCancel = document.getElementById('confirmDialogCancel');

// ===== i18n =====

async function loadLocale(lang) {
  currentLang = lang || 'zh';
  locale = await window.electronAPI.getLocale(currentLang);
  applyTranslations();
  updateLangButtons(currentLang);
}

function updateLangButtons(lang) {
  document.querySelectorAll('.lang-btn').forEach(function(btn) {
    if (btn.getAttribute('data-lang') === lang) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

function t(key, replacements) {
  var keys = key.split('.');
  var val = locale;
  for (var i = 0; i < keys.length; i++) {
    val = val ? val[keys[i]] : undefined;
  }
  if (val === undefined || val === null) return key;
  if (!replacements) return val;
  return val.replace(/\{(\w+)\}/g, function(_, k) {
    return replacements[k] !== undefined ? replacements[k] : '{' + k + '}';
  });
}

function applyTranslations() {
  // data-i18n: innerHTML replacement
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    var key = el.getAttribute('data-i18n');
    if (key) el.innerHTML = t(key);
  });
  // data-i18n-placeholder: placeholder replacement
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-placeholder');
    if (key) el.placeholder = t(key);
  });
  // data-i18n-title: title replacement
  document.querySelectorAll('[data-i18n-title]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-title');
    if (key) el.title = t(key);
  });
  // data-i18n-value: value replacement (for option texts)
  document.querySelectorAll('[data-i18n-value]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-value');
    if (key) el.value = t(key);
  });
}

// Initialize
async function init() {
  // Load config
  config = await window.electronAPI.getConfig();

  // Load locale
  await loadLocale(config.language || 'zh');

  populateForm(config);
  
  // Setup event listeners
  setupEventListeners();
  
  // Setup IPC listeners
  window.electronAPI.onAnalysisResult(handleAnalysisResult);
  window.electronAPI.onError(handleError);
  window.electronAPI.onConfigUpdated(async (newConfig) => {
    config = newConfig;
    populateForm(config);
    // Reload locale if language changed
    if (newConfig.language && newConfig.language !== currentLang) {
      await loadLocale(newConfig.language);
    }
    await loadPrompts();
    addLog(t('log.configUpdated'), 'info');
  });
  
  // Load prompt management
  await loadPrompts();

  addLog(t('log.appInitialized'), 'info');
}

function setupEventListeners() {
  // Auto-save on any form field change
  const formInputs = configForm.querySelectorAll('input, select');
  for (const input of formInputs) {
    input.addEventListener('change', async () => {
      await saveConfig();
    });
  }

  // Language switcher buttons
  document.querySelectorAll('.lang-btn').forEach(function(btn) {
    btn.addEventListener('click', async function() {
      var newLang = this.getAttribute('data-lang');
      if (newLang === currentLang) return;
      await window.electronAPI.updateConfig({ language: newLang });
      addLog(t('log.configSaved'), 'success');
      await loadLocale(newLang);
      updateLangButtons(newLang);
      // Re-render dynamic content
      if (typeof prompts !== 'undefined') renderPrompts();
      if (typeof agents !== 'undefined') await loadAgents();
    });
  });

  // Reset button
  resetBtn.addEventListener('click', async () => {
    var confirmed = await showConfirmDialog(t('config.resetConfirmTitle'), t('config.resetConfirmMsg'));
    if (!confirmed) return;
    config = await window.electronAPI.getConfig();
    populateForm(config);
    addLog(t('log.configReset'), 'info');
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

  // Prompt editor modal events
  modalSavePromptBtn.addEventListener('click', async function() {
    await savePrompt();
  });
  modalCancelPromptBtn.addEventListener('click', hidePromptEditor);
  promptEditorOverlay.addEventListener('click', function(e) {
    if (e.target === this) hidePromptEditor();
  });
  modalResetDefaultPromptBtn.addEventListener('click', async function() {
    var confirmed = await showConfirmDialog(t('prompt.resetConfirmTitle'), t('prompt.resetConfirmMsg'));
    if (!confirmed) return;
    var result = await window.electronAPI.resetDefaultPrompt();
    modalPromptContent.value = result.defaultPrompt;
    defaultPromptText = result.defaultPrompt;
    renderPrompts();
    addLog(t('log.promptDefaultReset'), 'info');
  });

  // Confirm dialog modal events
  confirmDialogOk.addEventListener('click', confirmDialogResolve);
  confirmDialogCancel.addEventListener('click', confirmDialogReject);
  confirmDialogOverlay.addEventListener('click', function(e) {
    if (e.target === this) confirmDialogReject();
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
    addLog(t('log.configSaved'), 'success');
  } catch (error) {
    addLog(t('log.configSaveFailed', { msg: error.message }), 'error');
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
  addLog(t('log.analysisComplete'), 'success');
  displayResult(result);
}

function handleError(error) {
  addLog(t('log.analysisError', { msg: error }), 'error');
}

function displayResult(result) {
  const resultCard = document.createElement('div');
  resultCard.className = 'result-card';

  var typeLabel = result.type === 'code' ? t('result.code') : t('result.document');
  var typeClass = result.type;

  resultCard.innerHTML = `
    <div class="result-type ${typeClass}">${typeLabel}</div>
    <div class="result-text">${escapeHtml(result.text || t('result.noContent'))}</div>
    <div style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--text-secondary);">
      ${t('result.generatedAt', { time: new Date(result.timestamp).toLocaleString() })}
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
  var preview = defaultPromptText ? defaultPromptText.substring(0, 60).replace(/\n/g, ' ') : t('prompt.empty');
  if (defaultPromptText && defaultPromptText.length > 60) preview += '...';
  var defaultItem = document.createElement('div');
  defaultItem.className = 'prompt-item';
  defaultItem.innerHTML =
    '<div class="prompt-item-info">' +
    '  <div class="prompt-item-name">' + t('prompt.systemDefault') + '</div>' +
    '  <div class="prompt-item-preview">' + (defaultPromptText ? escapeHtml(preview) : t('prompt.empty')) + '</div>' +
    '</div>' +
    '<div class="prompt-item-actions">' +
    '  <button class="prompt-item-btn edit-btn" title="' + t('prompt.editBtnTitle') + '">✏️</button>' +
    '</div>';

  // Edit System Default
  var editDefaultBtn = defaultItem.querySelector('.edit-btn');
  editDefaultBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    showPromptEditor({ id: 'system-default', name: t('prompt.systemDefault'), content: defaultPromptText });
  });

  promptsList.appendChild(defaultItem);

  // User-defined prompts
  for (var i = 0; i < prompts.length; i++) {
    var p = prompts[i];
    var preview = p.content ? p.content.substring(0, 60).replace(/\n/g, ' ') : t('prompt.empty');
    if (p.content && p.content.length > 60) preview += '...';

    var item = document.createElement('div');
    item.className = 'prompt-item';
    item.innerHTML =
      '<div class="prompt-item-info">' +
      '  <div class="prompt-item-name">' + escapeHtml(p.name) + '</div>' +
      '  <div class="prompt-item-preview">' + escapeHtml(preview) + '</div>' +
      '</div>' +
      '<div class="prompt-item-actions">' +
      '  <button class="prompt-item-btn edit-btn" title="' + t('prompt.editBtnTitle') + '">✏️</button>' +
      '  <button class="prompt-item-btn delete-btn" title="' + t('prompt.deleteBtnTitle') + '">🗑️</button>' +
      '</div>';

    // Edit button
    var editBtn = item.querySelector('.edit-btn');
    editBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      showPromptEditor(p);
    });

    // Delete button
    var deleteBtn = item.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', async function(e) {
      e.stopPropagation();
      var confirmed = await showConfirmDialog(t('prompt.deleteConfirmTitle'), t('prompt.deleteConfirmMsg', { name: p.name }));
      if (!confirmed) return;
      var result = await window.electronAPI.deletePrompt(p.id);
      prompts = result.prompts;
      selectedPromptId = result.selectedId;
      renderPrompts();
      addLog(t('log.promptDeleted', { name: p.name }), 'info');
    });

    promptsList.appendChild(item);
  }
}

function showPromptEditor(prompt) {
  modalPromptName.disabled = false;
  if (prompt) {
    promptEditorTitle.textContent = prompt.id === 'system-default' ? t('prompt.editTitleDefault') : t('prompt.editTitle');
    modalPromptName.value = prompt.name || '';
    modalPromptContent.value = prompt.content || '';
    editingPromptId = prompt.id;
    // Disable name field for system-default (name is fixed)
    if (prompt.id === 'system-default') modalPromptName.disabled = true;
    modalResetDefaultPromptBtn.style.display = prompt.id === 'system-default' ? 'inline-block' : 'none';
  } else {
    promptEditorTitle.textContent = t('prompt.newTitle');
    modalPromptName.value = '';
    modalPromptContent.value = '';
    editingPromptId = null;
    modalResetDefaultPromptBtn.style.display = 'none';
  }
  promptEditorOverlay.style.display = 'flex';
  modalPromptName.focus();
}

function hidePromptEditor() {
  promptEditorOverlay.style.display = 'none';
  modalPromptName.value = '';
  modalPromptContent.value = '';
  modalPromptName.disabled = false;
  editingPromptId = null;
  modalResetDefaultPromptBtn.style.display = 'none';
}

async function savePrompt() {
  var name = modalPromptName.value.trim();
  var content = modalPromptContent.value.trim();

  if (!name) {
    // Use a subtle visual cue instead of alert
    modalPromptName.style.borderColor = 'var(--error-color)';
    modalPromptName.focus();
    setTimeout(function() { modalPromptName.style.borderColor = ''; }, 2000);
    return;
  }
  if (!content) {
    modalPromptContent.style.borderColor = 'var(--error-color)';
    modalPromptContent.focus();
    setTimeout(function() { modalPromptContent.style.borderColor = ''; }, 2000);
    return;
  }

  // Handle system-default editing via updateDefaultPrompt IPC
  if (editingPromptId === 'system-default') {
    var result = await window.electronAPI.updateDefaultPrompt(content);
    defaultPromptText = result.defaultPrompt;
    hidePromptEditor();
    renderPrompts();
    addLog(t('log.promptDefaultUpdated'), 'success');
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

  addLog(t('log.promptSaved', { name: name }), 'success');
}

// ===== Confirm Dialog =====

var _confirmResolve = null;

function showConfirmDialog(title, message) {
  return new Promise(function(resolve) {
    _confirmResolve = resolve;
    confirmDialogTitle.textContent = title;
    confirmDialogMessage.textContent = message;
    confirmDialogOverlay.style.display = 'flex';
  });
}

function confirmDialogResolve() {
  confirmDialogOverlay.style.display = 'none';
  if (_confirmResolve) {
    _confirmResolve(true);
    _confirmResolve = null;
  }
}

function confirmDialogReject() {
  confirmDialogOverlay.style.display = 'none';
  if (_confirmResolve) {
    _confirmResolve(false);
    _confirmResolve = null;
  }
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
            addLog(t('log.installPathDetected', { name: a.name, path: detectResult.path }), 'info');
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
    addLog(t('log.agentsLoadFailed', { msg: error.message }), 'error');
  }
}

function renderAgents() {
  agentsList.innerHTML = '';

  if (agents.length === 0) {
    agentsList.innerHTML = '<p class="placeholder">' + t('agent.noAgents') + '</p>';
    return;
  }

  for (var i = 0; i < agents.length; i++) {
    var a = agents[i];
    var isSelected = selectedAgentIds.includes(a.id);
    var promptShortcuts = a.promptShortcuts || {};

    var item = document.createElement('div');
    item.className = 'agent-item' + (isSelected ? ' selected' : '');
    item.dataset.agentId = a.id;

    var typeLabel = a.type === 'electron' ? t('agent.desktop') : t('agent.web');

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
      '    <label class="agent-endpoint-label">' + t('agent.cdpLabel') + '</label>' +
      '    <input type="text" class="agent-endpoint-input" data-agent-id="' + a.id + '" ' +
      '      value="' + escapeHtml(a.endpoint) + '" />' +
      '    <button class="btn btn-xs btn-secondary test-btn" data-agent-id="' + a.id + '">' + t('agent.test') + '</button>' +
      '  </div>' +
      '  <div class="agent-install-path">' +
      '    <label class="install-path-label">' + t('agent.installLabel') + '</label>' +
      '    <input type="text" class="install-path-input" data-agent-id="' + a.id + '" ' +
      '      value="' + escapeHtml(a.installPath || '') + '" ' +
      '      placeholder="' + t('agent.installPlaceholder') + '" />' +
      '  </div>' +
      '  <div class="agent-prompts-section">' +
      '    <div class="agent-prompts-title">' + t('agent.promptsTitle') + '</div>' +
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
        addLog(t('log.installPathUpdated', { agent: agentId }), 'info');
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
        addLog(t('log.endpointUpdated', { agent: agentId }), 'info');
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
      : '<span class="capsule-shortcut-unset">' + t('agent.shortcutUnset') + '</span>';

    var clearBtnHtml = shortcut
      ? '<button class="capsule-clear-btn" data-agent-id="' + agent.id + '" data-prompt-id="' + promptId + '" title="' + t('agent.shortcutClearTitle') + '">✕</button>'
      : '';

    capsule.innerHTML =
      '<div class="prompt-capsule-name" title="' + escapeHtml(promptName) + '">' + escapeHtml(promptName) + '</div>' +
      '<div class="prompt-capsule-shortcut">' +
            shortcutDisplay +
      '    <button class="capsule-edit-btn" data-agent-id="' + agent.id + '" data-prompt-id="' + promptId + '" title="' + t('agent.shortcutEditTitle') + '">✏️</button>' +
            clearBtnHtml +
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

    // Clear button: clear shortcut
    var clearBtn = capsule.querySelector('.capsule-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', async function(e) {
        e.stopPropagation();
        await window.electronAPI.savePromptShortcut(agent.id, promptId, '');
        addLog(t('log.shortcutCleared', { agent: agent.name, prompt: promptName }), 'info');
        await loadAgents();
      });
    }

    // Toggle button: enable/disable this prompt shortcut
    var toggleBtn = capsule.querySelector('.prompt-capsule-toggle');
    toggleBtn.addEventListener('click', async function(e) {
      e.stopPropagation();
      var newEnabled = !enabled;
      await window.electronAPI.setPromptEnabled(agent.id, promptId, newEnabled);
      addLog(t(newEnabled ? 'log.promptEnabled' : 'log.promptDisabled', { prompt: promptName, agent: agent.name }), 'info');
      // Reload agents to reflect changes
      await loadAgents();
    });

    return capsule;
  }

  // System Default prompt (always first)
  listEl.appendChild(createCapsule('system-default', t('prompt.systemDefault')));

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
    addLog(t(result.selected ? 'log.agentEnabled' : 'log.agentDisabled', { name: found ? found.name : id }), 'info');
  } catch (error) {
    addLog(t('log.agentToggleError', { msg: error.message }), 'error');
  }
}

async function testAgentConnection(id) {
  var statusEl = document.getElementById('agent-status-' + id);
  if (statusEl) {
    statusEl.className = 'agent-item-status testing';
    statusEl.textContent = t('status.testing');
  }

  addLog(t('log.agentTesting', { id: id }), 'info');

  try {
    var result = await window.electronAPI.testAgentConnection(id);
    if (result.success) {
      if (statusEl) {
        statusEl.className = 'agent-item-status connected';
        statusEl.textContent = result.title ? t('status.testResult', { title: result.title }) : t('status.connected');
      }
      addLog(t('log.agentConnected', { id: id }), 'success');
    } else {
      if (statusEl) {
        statusEl.className = 'agent-item-status disconnected';
        statusEl.textContent = t('status.disconnected');
      }
      addLog(t('log.agentFailed', { id: id, error: result.error || 'Unknown error' }), 'error');
    }
  } catch (error) {
    if (statusEl) {
      statusEl.className = 'agent-item-status disconnected';
      statusEl.textContent = t('status.error');
    }
    addLog(t('log.agentTestError', { msg: error.message }), 'error');
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
      status.textContent = t('shortcut.continue');
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
        status.textContent = t('shortcut.conflict');
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
  status.textContent = t('shortcut.save');
  status.className = 'recorder-status';

  var result = await window.electronAPI.savePromptShortcut(recorderAgentId, recorderPromptId, recorderShortcut);

  if (result.success) {
    addLog(t('log.shortcutSaved', { agent: recorderAgentId, prompt: recorderPromptId, shortcut: recorderShortcut }), 'success');
    hideShortcutRecorder();
    // Reload agents to update display
    await loadAgents();
  } else if (result.error) {
    status.textContent = t('shortcut.error', { error: result.error });
    status.className = 'recorder-status error';
    confirmBtn.disabled = false;
  }
}

function cancelShortcut() {
  hideShortcutRecorder();
}

// Start
init().catch(console.error);
