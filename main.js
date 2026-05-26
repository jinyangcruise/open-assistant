/**
 * Open Assistant - Main Process
 * 
 * Handles:
 * - Global shortcut registration
 * - System tray icon
 * - IPC communication with renderer
 * - Core workflow: screenshot -> analyze -> insert
 */

const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, Notification, clipboard, nativeImage, screen, shell } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const { takeScreenshot } = require('./core/screenshot');
const { pasteText, StreamingPaster, getText } = require('./core/clipboard-pure');
const { detectActiveWindow } = require('./core/context-analyzer');
const AgentRegistry = require('./core/agent-manager/registry');
const DoubaoAppAdapter = require('./core/agent-manager/agents/doubao-app-adapter');

// Initialize store for persistent config
const store = new Store({
  name: 'opencli-assistant-config',
  cwd: path.join(app.getPath('appData'), 'OpenAssistant'),
  defaults: require('./config.json')
});

// Initialize Agent Registry
AgentRegistry.init(store);
AgentRegistry.register(new DoubaoAppAdapter());

// Sync persisted agent config to live instances on startup
const persistedAgents = store.get('agents') || {};
for (const [id, config] of Object.entries(persistedAgents)) {
  const agent = AgentRegistry.getAgent(id);
  if (agent) {
    if (config.endpoint) agent.endpoint = config.endpoint;
    if (config.install_path) agent.installPath = config.install_path;
  }
}

let mainWindow;
let overlayWindow;
/** Drag state for the overlay window (tracked in main process to avoid async IPC race) */
let overlayDragState = null;
let tray;
let isProcessing = false;
let currentAbortController = null;
/** Current AI agent adapter instance (used to stop Doubao generation on cancel) */
let currentAdapter = null;

// Create main settings window
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false
  });

  mainWindow.loadFile('renderer/index.html');

  mainWindow.on('ready-to-show', () => {
    var shouldShow = process.argv.includes('--dev') || store.get('quiet_start') === false;
    if (shouldShow) {
      mainWindow.show();
    }
    if (process.argv.includes('--dev')) {
      mainWindow.webContents.openDevTools();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Create floating overlay window (status bar)
function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 280,
    height: 84,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  overlayWindow.loadFile('overlay/index.html');
  overlayWindow.setVisibleOnAllWorkspaces(true);

  // Forward mouse events by default (click passes through to underneath windows)
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

// Show the overlay status bar at the given screen coordinates
function showOverlay(x, y) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  // Clamp position to the display's work area
  const display = screen.getDisplayNearestPoint({ x, y });
  const workArea = display.workArea;
  const winWidth = 280;
  const winHeight = 84;
  const pad = 20;
  const offsetX = 15 - pad;  // bar visual position stays at x+15
  const offsetY = 20 - pad;  // bar visual position stays at y+20

  let winX = x + offsetX;
  let winY = y + offsetY;

  // Prevent the bar from going off-screen
  if (winX + winWidth > workArea.x + workArea.width) {
    winX = workArea.x + workArea.width - winWidth - 8;
  }
  if (winY + winHeight > workArea.y + workArea.height) {
    winY = y - winHeight - 8;
  }
  if (winX < workArea.x) winX = workArea.x + 4;
  if (winY < workArea.y) winY = workArea.y + 4;

  overlayWindow.setBounds({
    x: Math.round(winX), y: Math.round(winY),
    width: winWidth, height: winHeight,
  });
  overlayWindow.showInactive(); // Show without stealing focus
  // moveTop brings the window above other windows without activating it.
  // This is needed because Windows' showInactive (SW_SHOWNOACTIVATE) may
  // place a previously-hidden window behind the active foreground window.
  overlayWindow.moveTop();
  // Disable forwarding immediately so the bar is interactive on appearance.
  // mouseleave on the bar will re-enable forwarding when the user moves away.
  overlayWindow.setIgnoreMouseEvents(false);

}

// Hide the overlay status bar
function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
}

// Create system tray
function createTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
    const fs = require('fs');
    
    let trayIcon;
    
    // Check if icon exists and create a valid tray icon
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath);
      if (trayIcon.isEmpty()) {
        console.log('Tray icon is invalid, creating default');
        trayIcon = null;
      }
    }
    
    // Fallback: use scaled app icon if tray-icon is missing
    if (!trayIcon || trayIcon.isEmpty()) {
      const appIconPath = path.join(__dirname, 'assets', 'icon.png');
      if (fs.existsSync(appIconPath)) {
        const appIcon = nativeImage.createFromPath(appIconPath);
        if (!appIcon.isEmpty()) {
          trayIcon = appIcon.resize({ width: 16, height: 16 });
          console.log('Using resized app icon for tray (tray-icon.png not found)');
        }
      }
    }

    // Last resort: create a minimal 1x1 icon
    if (!trayIcon || trayIcon.isEmpty()) {
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsQAAA7EAZUrDhsAAAANSURBVBhXYzh48OB/' +
        'AAAAAElFTkSuQmCC',
        'base64'
      );
      trayIcon = nativeImage.createFromBuffer(pngBuffer);
    }
    
    tray = new Tray(trayIcon);
    rebuildTrayMenu();

    tray.setToolTip('Open Assistant');

    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
      } else {
        createMainWindow();
      }
    });
    
    console.log('System tray created successfully');
  } catch (error) {
    console.error('Failed to create tray (continuing anyway):', error.message);
    // Continue without tray
    tray = null;
  }
}

// Built-in default prompt (used for reset functionality)
const BUILTIN_DEFAULT_PROMPT_ZH = '我发送了一张屏幕截图，请分析截图中的内容，并提供智能补全建议。\n\n当前应用: {app}\n\n要求：\n\n1. 判断我正在做什么（写代码/写文档/其他）\n2. 如果是代码，识别编程语言和上下文\n3. 根据上下文，提供智能补全建议\n4. 只返回补全内容，不要解释\n5. 保持代码格式和缩进\n6. 根据用户使用的编程语言和工具，使用正确的缩进方式（空格/制表符）\n7. 不要重复用户已有的内容，例如用户写的注释\n\n请直接分析屏幕截图并返回补全建议：';

const BUILTIN_DEFAULT_PROMPT_EN = 'I have sent a screenshot. Please analyze the content and provide smart completion suggestions.\n\nCurrent app: {app}\n\nRequirements:\n\n1. Determine what I am doing (writing code / writing documents / other)\n2. If it\'s code, identify the programming language and context\n3. Based on the context, provide smart completion suggestions\n4. Only return the completion content, do not explain\n5. Maintain code formatting and indentation\n6. Use the correct indentation (spaces/tabs) based on the programming language and tools\n7. Do not repeat existing content the user has already written, such as user\'s comments\n\nPlease directly analyze the screenshot and return completion suggestions:';

function getBuiltinDefaultPrompt(lang) {
  return lang === 'en' ? BUILTIN_DEFAULT_PROMPT_EN : BUILTIN_DEFAULT_PROMPT_ZH;
}

// Simple locale loader for tray menu (main process)
let _trayLocale = {};
let _trayLang = 'zh';

function loadTrayLocale() {
  _trayLang = store.get('language') || 'zh';
  const fs = require('fs');
  const localePath = path.join(__dirname, 'locales', _trayLang + '.json');
  const finalPath = fs.existsSync(localePath) ? localePath : path.join(__dirname, 'locales', 'zh.json');
  try {
    _trayLocale = JSON.parse(fs.readFileSync(finalPath, 'utf-8'));
  } catch (e) {
    _trayLocale = {};
  }
}

function tt(key, replacements) {
  var keys = key.split('.');
  var val = _trayLocale;
  for (var i = 0; i < keys.length; i++) {
    val = val ? val[keys[i]] : undefined;
  }
  if (val === undefined || val === null) return key;
  if (!replacements) return val;
  return val.replace(/\{(\w+)\}/g, function(_, k) {
    return replacements[k] !== undefined ? replacements[k] : '{' + k + '}';
  });
}

// Apply auto-launch (login item) setting
function applyAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: app.getPath('exe'),
    });
    console.log(`[Main] Auto-launch ${enabled ? 'enabled' : 'disabled'}`);
  } catch (error) {
    console.error('[Main] Failed to set auto-launch:', error.message);
  }
}

// Check if an HTTP endpoint is reachable (e.g. CDP endpoint already running)
function isEndpointReachable(endpointUrl) {
  return new Promise(function(resolve) {
    try {
      var urlObj = new URL(endpointUrl);
      var http = require('http');
      var req = http.get(endpointUrl.replace(/\/$/, '') + '/json', function(res) {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.on('error', function() { resolve(false); });
      req.setTimeout(3000, function() { req.destroy(); resolve(false); });
    } catch (e) {
      resolve(false);
    }
  });
}

// Build or rebuild the tray context menu from current config
function rebuildTrayMenu() {
  if (!tray) return;
  loadTrayLocale();

  const menuItems = [
    {
      label: tt('tray.openSettings'),
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createMainWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: tt('tray.output'),
      submenu: [
        {
          label: tt('tray.autoInsert'),
          type: 'radio',
          checked: store.get('auto_insert') !== false,
          click: () => {
            store.set('auto_insert', true);
            notifyConfigUpdated();
          }
        },
        {
          label: tt('tray.clipboard'),
          type: 'radio',
          checked: store.get('auto_insert') === false,
          click: () => {
            store.set('auto_insert', false);
            notifyConfigUpdated();
          }
        }
      ]
    },
  ];

  // Add "Initialize {agent}" for each selected agent that supports it
  const selectedIds = AgentRegistry.getSelectedIds();
  if (selectedIds.includes('doubao-app')) {
    const agent = AgentRegistry.getAgent('doubao-app');
    menuItems.push({
      label: tt('tray.initAgent', { name: agent ? ((_trayLocale.agent && _trayLocale.agent.names && _trayLocale.agent.names[agent.id]) || agent.name) : 'Doubao' }),
      click: () => launchDoubaoWithDebug()
    });
  }

  menuItems.push(
    { type: 'separator' },
    {
      label: tt('tray.quit'),
      click: () => app.quit()
    }
  );

  const contextMenu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(contextMenu);
}

// Notify the settings window that config has been updated
function notifyConfigUpdated() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-updated', store.store);
  }
}

/**
 * Detect the installation path for a given agent by searching common locations.
 * @param {string} agentId - The agent ID (e.g. 'doubao-app')
 * @returns {string|null} The detected install path, or null if not found
 */
function detectInstallPath(agentId) {
  const agentConfig = store.get(`agents.${agentId}`) || {};
  const savedPath = (agentConfig.install_path || '').trim();
  if (savedPath) {
    const fs = require('fs');
    if (fs.existsSync(savedPath)) return savedPath;
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.PROGRAMFILES || '';
  const userProfile = process.env.USERPROFILE || '';

  // Determine the executable name based on agent
  const defaultExeName = agentId === 'doubao-app' ? 'Doubao.exe' : `${agentId}.exe`;

  const fs = require('fs');

  // Common search paths
  const paths = [
    path.join(localAppData, 'doubao', defaultExeName),
    path.join(localAppData, 'Doubao', defaultExeName),
    path.join(localAppData, 'Programs', 'Doubao', defaultExeName),
    path.join(userProfile, 'AppData', 'Local', 'doubao', defaultExeName),
    path.join(userProfile, 'AppData', 'Local', 'Doubao', defaultExeName),
    path.join(programFiles, 'doubao', defaultExeName),
    path.join(programFiles, 'Doubao', defaultExeName),
  ];

  // Scan all drive letters for Program Files variants
  const drives = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (const letter of drives) {
    const root = letter + ':\\';
    try { fs.readdirSync(root); } catch (e) { continue; }
    paths.push(path.join(root, 'Program Files', 'doubao', defaultExeName));
    paths.push(path.join(root, 'Program Files', 'Doubao', defaultExeName));
    paths.push(path.join(root, 'Program Files (x86)', 'doubao', defaultExeName));
    paths.push(path.join(root, 'Program Files (x86)', 'Doubao', defaultExeName));
  }

  // Search paths
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

// Launch Doubao desktop app with remote debugging port
function launchDoubaoWithDebug() {
  // Read install_path and endpoint from agent config
  const agentConfig = store.get('agents.doubao-app') || {};
  const installPath = (agentConfig.install_path || '').trim();
  const endpoint = agentConfig.endpoint || 'http://127.0.0.1:9225';
  const match = endpoint.match(/:(\d+)$/);
  const debugPort = match ? match[1] : '9225';

  // Auto-detect if no install path set
  const exePath = installPath || detectInstallPath('doubao-app');

  if (!exePath) {
    // Fallback: try `where` command
    exec('where Doubao.exe 2>nul', (err, stdout) => {
      if (!err && stdout) {
        const found = stdout.trim().split('\n')[0].trim();
        if (found) {
          launchExe(found, debugPort);
          return;
        }
      }
      showNotification('Initialization Failed', '找不到豆包桌面端，请确认已安装');
    });
    return;
  }

  launchExe(exePath, debugPort);
}

function launchExe(exePath, debugPort) {
  const exeName = path.basename(exePath);

  // Kill any existing Doubao processes
  exec(`taskkill /F /IM ${exeName} 2>nul`, () => {
    // Wait briefly for process to terminate
    setTimeout(() => {
      const args = [`--remote-debugging-port=${debugPort}`];
      const child = spawn(exePath, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      console.log(`[Main] Launched ${exeName} with --remote-debugging-port=${debugPort}:`, exePath);
      showNotification('Doubao Initialized', `已启动豆包（调试端口 ${debugPort}）`);
    }, 1000);
  });
}

// Register global shortcuts for all enabled prompt shortcuts across selected agents
function registerAllShortcuts() {
  globalShortcut.unregisterAll();

  const agents = AgentRegistry.getAll();
  const selectedIds = AgentRegistry.getSelectedIds();
  const registeredShortcuts = new Map(); // shortcut -> { agentId, promptId, modeId }
  let count = 0;

  for (const agent of agents) {
    // Only register shortcuts for selected/checked agents
    if (!selectedIds.includes(agent.id)) continue;

    const promptShortcuts = store.get(`agents.${agent.id}.promptShortcuts`) || {};
    for (const [promptId, config] of Object.entries(promptShortcuts)) {
      // New format: modes within each prompt
      var modes = config.modes;
      if (modes) {
        for (const [modeId, modeConfig] of Object.entries(modes)) {
          var shortcut = (modeConfig.shortcut || '').trim();
          if (!shortcut || !modeConfig.enabled) continue;

          if (registeredShortcuts.has(shortcut)) {
            var existing = registeredShortcuts.get(shortcut);
            console.log(`[Main] Shortcut "${shortcut}" already registered for "${existing.agentId}/${existing.promptId}/${existing.modeId}", skipping "${agent.id}/${promptId}/${modeId}"`);
            continue;
          }

          var registered = globalShortcut.register(shortcut, function(id, pid, mid) {
            return function() { handleShortcut(id, pid, mid); };
          }(agent.id, promptId, modeId));

          if (registered) {
            registeredShortcuts.set(shortcut, { agentId: agent.id, promptId: promptId, modeId: modeId });
            count++;
            console.log(`[Main] Shortcut registered: ${shortcut} -> ${agent.id}/${promptId}/${modeId}`);
          } else {
            console.error(`[Main] Failed to register shortcut for ${agent.id}/${promptId}/${modeId}: ${shortcut}`);
          }
        }
      } else {
        // Legacy format: shortcut directly on the prompt
        var shortcut = (config.shortcut || '').trim();
        if (!shortcut || !config.enabled) continue;

        if (registeredShortcuts.has(shortcut)) {
          var existing = registeredShortcuts.get(shortcut);
          console.log(`[Main] Shortcut "${shortcut}" already registered for "${existing.agentId}/${existing.promptId}", skipping "${agent.id}/${promptId}"`);
          continue;
        }

        var registered = globalShortcut.register(shortcut, function(id, pid) {
          return function() { handleShortcut(id, pid, 'fullscreen'); };
        }(agent.id, promptId));

        if (registered) {
          registeredShortcuts.set(shortcut, { agentId: agent.id, promptId: promptId, modeId: 'fullscreen' });
          count++;
          console.log(`[Main] Shortcut registered: ${shortcut} -> ${agent.id}/${promptId} (legacy)`);
        } else {
          console.error(`[Main] Failed to register shortcut for ${agent.id}/${promptId}: ${shortcut}`);
        }
      }
    }
  }

  console.log(`[Main] Registered ${count} prompt shortcut(s) for selected agents`);
}

// Main shortcut handler
async function handleShortcut(agentId, promptId, modeId) {
  if (isProcessing) {
    showNotification('Already Processing', 'Please wait for the current request to complete');
    return;
  }

  isProcessing = true;
  let streamingPaster = null;

  try {
    // Update tray menu
    updateTrayStatus('Processing...');

    // 1. Detect active window
    const activeWindow = detectActiveWindow();
    console.log('Active window:', activeWindow);

    // 2. Take screenshot
    console.log('Taking screenshot...');
    const screenshotBuffer = await takeScreenshot();
    console.log('Screenshot captured:', screenshotBuffer.length, 'bytes');

    // 3. Get prompt text based on the promptId that triggered this shortcut
    let customPrompt = null;
    if (promptId === 'system-default') {
      // Load the built-in default prompt from config
      customPrompt = (store.get('default_prompt') || '').trim();
      if (customPrompt) console.log('Using system default prompt');
    } else if (promptId) {
      const prompts = store.get('prompts') || [];
      const found = prompts.find(function(p) { return p.id === promptId; });
      if (found && found.content && found.content.trim()) {
        customPrompt = found.content.trim();
        console.log('Using custom prompt:', found.name);
      }
    }

    // Replace {app} placeholder with the active window title (works for all prompts)
    if (customPrompt && activeWindow && activeWindow.title) {
      customPrompt = customPrompt.replace(/\{app\}/g, activeWindow.title);
    }

    // 4. Analyze with specified AI Agent (with optional streaming)
    const agent = AgentRegistry.getAgent(agentId);
    currentAdapter = agent;
    console.log('Analyzing with agent:', agent ? agent.id : 'none');

    if (!agent) {
      throw new Error(`AI Agent "${agentId}" not found. Please check configuration.`);
    }

    // Prepare output based on output_mode and auto_insert settings
    const shouldAutoInsert = store.get('auto_insert');
    const storedMode = store.get('response_mode');
    const outputMode = store.get('output_mode') || 'streaming';
    console.log('[Main] stored response_mode:', JSON.stringify(storedMode), 'output_mode:', outputMode, '| default fallback: sse-fetch / streaming');
    const context = {
      appName: activeWindow.title,
      timeout: store.get('timeout_seconds') * 1000,
      customPrompt: customPrompt,
      responseMode: storedMode || 'sse-fetch',
    };

    // Create AbortController for cancellation support
    currentAbortController = new AbortController();
    context.signal = currentAbortController.signal;

    // Show overlay at mouse position
    const cursorPos = screen.getCursorScreenPoint();
    showOverlay(cursorPos.x, cursorPos.y);

    if (shouldAutoInsert) {
      if (outputMode === 'streaming') {
        // === STREAMING OUTPUT ===
        streamingPaster = new StreamingPaster();
        await streamingPaster.start();

        // Minimize our window so streaming pastes go to user's app
        if (mainWindow && mainWindow.isVisible()) {
          mainWindow.minimize();
        }
        await new Promise(resolve => setTimeout(resolve, 500));

        context.onChunk = (incrementalText) => {
          streamingPaster.push(incrementalText);
        };
      }
      // Full output mode: no onChunk — analyze returns complete text,
      // we'll paste it all at once after receiving the result.
    }

    const result = await agent.analyze(screenshotBuffer, context);
    console.log('Analysis result:', result);

    // Check if user cancelled during analysis
    const wasCancelled = currentAbortController?.signal.aborted;

    // 5. Output result
    if (wasCancelled) {
      console.log('Shortcut handler: analysis was cancelled by user, keeping partial paste');
      // Still need to finish streaming paster to restore clipboard
      if (streamingPaster) {
        await streamingPaster.finish();
      }
    } else if (shouldAutoInsert) {
      if (outputMode === 'streaming' && streamingPaster) {
        // Finish streaming paste
        await streamingPaster.finish();
        console.log('Streaming paste completed');

        if (!result.text) {
          console.warn('[Streaming] Empty analysis result');
        }
      } else if (outputMode === 'full') {
        // Full output: paste complete text at once
        await pasteText(result.text);
        console.log('Full paste completed');
      }
    } else {
      // Copy to clipboard for manual paste
      clipboard.writeText(result.text);
    }

    // Send result to renderer
    if (mainWindow) {
      mainWindow.webContents.send('analysis-result', result);
    }

  } catch (error) {
    // Don't show error notification for user-initiated cancellations
    if (error.name === 'AbortError' || (currentAbortController && currentAbortController.signal.aborted)) {
      console.log('Shortcut handler: cancelled by user');
    } else {
      console.error('Error in shortcut handler:', error);
      showNotification('Error', error.message || 'Failed to process request');
    }

    // Restore clipboard even on error
    if (streamingPaster) {
      try { await streamingPaster.finish(); } catch { /* ignore cleanup errors */ }
    }

    if (mainWindow && !currentAbortController?.signal.aborted) {
      mainWindow.webContents.send('error', error.message);
    }
  } finally {
    hideOverlay();
    currentAbortController = null;
    currentAdapter = null;
    isProcessing = false;
    updateTrayStatus('Ready');
  }
}

// Show system notification
function showNotification(title, body) {
  if (store.get('show_notifications')) {
    new Notification({
      title,
      body,
      icon: path.join(__dirname, 'assets', 'icon.png')
    }).show();
  }
}

// Update tray status
function updateTrayStatus(status) {
  if (tray) {
    tray.setToolTip(`Open Assistant - ${status}`);
  }
}

// IPC handlers
function setupIpcHandlers() {
  // Dev-mode debug logging for overlay drag
  const isDragDebug = process.argv.includes('--dev');
  function dragLog(...args) {
    if (isDragDebug) console.log('[Drag]', ...args);
  }

  // Forward renderer-side debug logs (from overlay.js) to terminal
  ipcMain.on('overlay-debug-log', (event, ...args) => {
    if (isDragDebug) console.log('[Overlay]', ...args);
  });

    // Get config
  ipcMain.handle('get-config', () => {
    return store.store;
  });

  // Update config
  ipcMain.handle('update-config', (event, updates) => {
    store.set(updates);

    // Apply auto-launch when setting changes
    if (updates.hasOwnProperty('auto_launch')) {
      applyAutoLaunch(updates.auto_launch);
    }

    // Re-register all shortcuts (in case agent configs changed)
    registerAllShortcuts();

    // Rebuild tray menu to reflect config changes (e.g. Output mode)
    rebuildTrayMenu();

    return store.store;
  });

  // Get logs
  ipcMain.handle('get-logs', () => {
    return [];
  });

  // --- Prompt Management ---

  // Get all prompts with selected ID
  ipcMain.handle('get-prompts', () => {
    return {
      prompts: store.get('prompts') || [],
      selectedId: store.get('selected_prompt_id') || 'system-default',
      defaultPrompt: store.get('default_prompt') || ''
    };
  });

  // Save a prompt (create or update)
  ipcMain.handle('save-prompt', (event, promptData) => {
    const prompts = store.get('prompts') || [];
    const idx = prompts.findIndex(function(p) { return p.id === promptData.id; });
    
    if (idx >= 0) {
      prompts[idx] = promptData;
    } else {
      promptData.id = 'prompt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
      prompts.push(promptData);
    }
    
    store.set('prompts', prompts);
    rebuildTrayMenu();
    notifyConfigUpdated();
    return { prompts: prompts, selectedId: store.get('selected_prompt_id') };
  });

  // Delete a prompt
  ipcMain.handle('delete-prompt', (event, id) => {
    var prompts = store.get('prompts') || [];
    prompts = prompts.filter(function(p) { return p.id !== id; });
    store.set('prompts', prompts);
    
    // If deleted prompt was selected, revert to system-default
    if (store.get('selected_prompt_id') === id) {
      store.set('selected_prompt_id', 'system-default');
    }
    
    rebuildTrayMenu();
    notifyConfigUpdated();
    return { prompts: prompts, selectedId: store.get('selected_prompt_id') };
  });

  // Select a prompt
  ipcMain.handle('select-prompt', (event, id) => {
    store.set('selected_prompt_id', id);
    rebuildTrayMenu();
    notifyConfigUpdated();
    return { selectedId: id };
  });

  // Update default prompt text
  ipcMain.handle('update-default-prompt', (event, text) => {
    store.set('default_prompt', text);
    return { success: true, defaultPrompt: text };
  });

  // Reset default prompt to built-in
  ipcMain.handle('reset-default-prompt', (event, lang) => {
    var prompt = getBuiltinDefaultPrompt(lang || store.get('language') || 'zh');
    store.set('default_prompt', prompt);
    rebuildTrayMenu();
    notifyConfigUpdated();
    return { success: true, defaultPrompt: prompt };
  });

  // --- Agent Management ---

  // Get all agents with current selection
  ipcMain.handle('get-agents', () => {
    return {
      agents: AgentRegistry.getAll(),
      selectedIds: AgentRegistry.getSelectedIds()
    };
  });

  // Toggle an agent's selected state (multi-select)
  ipcMain.handle('toggle-agent', (event, id) => {
    const isSelected = AgentRegistry.toggleSelected(id);
    rebuildTrayMenu(); // Update tray menu (e.g. show/hide Initialize Doubao)
    registerAllShortcuts(); // Re-register shortcuts based on new selection
    return { success: true, selected: isSelected };
  });

  // Test agent connection
  ipcMain.handle('test-agent-connection', async (event, id) => {
    return await AgentRegistry.testConnection(id);
  });

  // Update agent config (e.g. install_path, endpoint, shortcut)
  ipcMain.handle('update-agent-config', (event, agentId, updates) => {
    const agentPath = `agents.${agentId}`;
    Object.keys(updates).forEach(key => {
      store.set(`${agentPath}.${key}`, updates[key]);
    });
    // Sync endpoint and install_path to live agent instance so they take effect immediately
    const agent = AgentRegistry.getAgent(agentId);
    if (agent) {
      if (updates.endpoint) agent.endpoint = updates.endpoint;
      if (updates.install_path) agent.installPath = updates.install_path;
    }
    // Re-register all shortcuts in case shortcut config changed
    registerAllShortcuts();
    return { success: true };
  });

  // Auto-detect install path for an agent
  ipcMain.handle('detect-install-path', (event, agentId) => {
    const detectedPath = detectInstallPath(agentId);
    return { path: detectedPath };
  });

  // Save a prompt shortcut for an agent
  ipcMain.handle('save-prompt-shortcut', (event, agentId, promptId, shortcut) => {
    store.set(`agents.${agentId}.promptShortcuts.${promptId}.shortcut`, shortcut);
    registerAllShortcuts();
    return { success: true };
  });

  // Set enabled state for a prompt on an agent
  ipcMain.handle('set-prompt-enabled', (event, agentId, promptId, enabled) => {
    store.set(`agents.${agentId}.promptShortcuts.${promptId}.enabled`, enabled);
    registerAllShortcuts();
    return { success: true };
  });

  // Check if a shortcut is available (not in use by system/other apps)
  ipcMain.handle('check-shortcut', (event, shortcut) => {
    if (!shortcut) return { available: false };
    try {
      const registered = globalShortcut.register(shortcut, () => {});
      if (registered) {
        globalShortcut.unregister(shortcut);
        return { available: true };
      }
      return { available: false };
    } catch (e) {
      return { available: false };
    }
  });

  // Suspend all global shortcuts (for shortcut recording)
  ipcMain.handle('suspend-shortcuts', () => {
    globalShortcut.unregisterAll();
    return { success: true };
  });

  // Resume all agent shortcuts
  ipcMain.handle('resume-shortcuts', () => {
    registerAllShortcuts();
    return { success: true };
  });

  // --- Overlay Window IPC (floating status bar) ---

  // Cancel current processing from the overlay's cancel button
  // Also tells Doubao to stop generating via CDP (if adapter supports it)
  ipcMain.on('cancel-processing', () => {
    // Hide overlay immediately so the bar disappears right away.
    // stopGeneration continues in the background (SSE capture abort →
    // stop generation retry loop), but the user sees instant feedback.
    hideOverlay();
    // Abort current processing — analyze() will handle stopping generation
    // after content has been sent (when the break button is actually visible).
    const controller = currentAbortController;
    if (controller && !controller.signal.aborted) {
      console.log('[Main] User cancelled processing via overlay');
      controller.abort();
    }
  });

  // Toggle mouse event forwarding on the overlay window
  // When the user hovers over the cancel button, disable forwarding so clicks register.
  // When they leave, re-enable forwarding so clicks pass through.
  ipcMain.on('set-ignore-mouse-events', (event, ignore) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      if (ignore) {
        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      } else {
        overlayWindow.setIgnoreMouseEvents(false);
      }
    }
  });

  // Overlay window drag — mousedown: record base position
  ipcMain.on('overlay-drag-start', (event, mouseX, mouseY, winScreenX, winScreenY) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    // Use renderer-provided window position (from window.screenX/Y in DOM)
    // as the starting position. Subsequent drag-move adds movement deltas.
    overlayDragState = { currentWinX: winScreenX, currentWinY: winScreenY };
    dragLog('start  winScreen=(%d,%d)', winScreenX, winScreenY);
  });

  // Overlay window drag — mousemove: apply movement delta to current position
  // Uses e.movementX/Y from the renderer (cumulative delta from last mousemove)
  // instead of absolute screen coords, so synthetic events (movementX=0) from
  // SSE / focus-changes don't snap the window back to the drag origin.
  // Uses setBounds to atomically set position AND size — prevents DWM from
  // independently resizing transparent layered windows during repeated calls.
  ipcMain.on('overlay-drag-move', (event, deltaX, deltaY) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayDragState) return;
    const newX = overlayDragState.currentWinX + deltaX;
    const newY = overlayDragState.currentWinY + deltaY;
    overlayWindow.setBounds({
      x: Math.round(newX), y: Math.round(newY),
      width: 280, height: 84,
    });
    overlayDragState.currentWinX = newX;
    overlayDragState.currentWinY = newY;
    dragLog('move   delta=(%d,%d)  curPos=(%d,%d)', deltaX, deltaY, newX, newY);
  });

  // Overlay window drag — mouseup: clear state and reset size
  ipcMain.on('overlay-drag-end', () => {
    overlayDragState = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const [x, y] = overlayWindow.getPosition();
      overlayWindow.setBounds({ x, y, width: 280, height: 84 });
    }
  });

  // Open external link in default browser
  ipcMain.handle('open-external', (event, url) => {
    shell.openExternal(url);
  });

  // Restart (initialize) an agent
  ipcMain.handle('restart-agent', (event, agentId) => {
    if (agentId === 'doubao-app') {
      launchDoubaoWithDebug();
    } else {
      console.log('[Main] No restart handler for agent:', agentId);
    }
  });

  // Load locale file
  ipcMain.handle('get-locale', (event, lang) => {
    const fs = require('fs');
    const localePath = path.join(__dirname, 'locales', lang + '.json');
    // Fallback to zh if requested locale not found
    const finalPath = fs.existsSync(localePath) ? localePath : path.join(__dirname, 'locales', 'zh.json');
    try {
      return JSON.parse(fs.readFileSync(finalPath, 'utf-8'));
    } catch (e) {
      return {};
    }
  });

  // Check for updates
  ipcMain.handle('check-for-updates', async () => {
    if (!app.isPackaged) {
      return { success: false, error: 'dev' };
    }
    try {
      autoUpdater.checkForUpdates();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Download update
  ipcMain.handle('download-update', async () => {
    try {
      autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Install update
  ipcMain.handle('install-update', () => {
    setImmediate(() => autoUpdater.quitAndInstall());
    return { success: true };
  });

}

// App lifecycle
app.whenReady().then(() => {
  console.log('Open Assistant starting...');

  // Set AppUserModelId for Windows taskbar/task manager icon
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.opencli.assistant');
  }
  
  // Setup IPC handlers FIRST
  setupIpcHandlers();

  // Remove default menu bar (Edit, View, Window, Help)
  Menu.setApplicationMenu(null);

  // Then create UI
  createMainWindow();
  createOverlayWindow();
  createTray();
  registerAllShortcuts();

  // Apply startup settings
  if (store.get('auto_launch')) {
    applyAutoLaunch(true);
  }

  // Auto-init Doubao on startup (skip if already running)
  if (store.get('auto_init_agent')) {
    setTimeout(async () => {
      var endpoint = (store.get('agents.doubao-app') || {}).endpoint || 'http://127.0.0.1:9225';
      var alreadyRunning = await isEndpointReachable(endpoint);
      if (alreadyRunning) {
        console.log('[Main] Doubao already running at', endpoint + ', skipping auto-init');
      } else {
        console.log('[Main] Doubao not detected at', endpoint + ', starting...');
        launchDoubaoWithDebug();
      }
    }, 2000);
  }

  // Configure auto-updater
  // autoUpdater.logger = console; // Uncomment for debug logs
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
});

// ===== Auto Updater =====

// Forward updater events to the renderer
function setupUpdaterIpc() {
  autoUpdater.on('checking-for-update', () => {
    if (mainWindow) mainWindow.webContents.send('update-status', { type: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-status', { type: 'available', version: info.version, info: info });
  });

  autoUpdater.on('update-not-available', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-status', { type: 'not-available' });
  });

  autoUpdater.on('error', (err) => {
    if (mainWindow) mainWindow.webContents.send('update-status', { type: 'error', message: err.message });
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) mainWindow.webContents.send('update-status', { type: 'progress', percent: progress.percent });
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow) mainWindow.webContents.send('update-status', { type: 'downloaded', version: info.version });
  });
}

setupUpdaterIpc();

app.on('window-all-closed', (e) => {
  // Keep app running in tray
  e.preventDefault();
});

app.on('will-quit', () => {
  // Unregister all shortcuts
  globalShortcut.unregisterAll();
  // Destroy overlay window if it exists
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }
  // Disconnect any active agent connections
  AgentRegistry.getAll().forEach(a => {
    const agent = AgentRegistry.getAgent(a.id);
    if (agent) agent.disconnect();
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// Export for testing
module.exports = { handleShortcut, store };
