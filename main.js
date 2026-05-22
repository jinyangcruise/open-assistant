/**
 * OpenCLI Smart Assistant - Main Process
 * 
 * Handles:
 * - Global shortcut registration
 * - System tray icon
 * - IPC communication with renderer
 * - Core workflow: screenshot -> analyze -> insert
 */

const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, Notification, clipboard, nativeImage, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { takeScreenshot } = require('./core/screenshot');
const { pasteText, StreamingPaster, getText } = require('./core/clipboard-pure');
const { detectActiveWindow } = require('./core/context-analyzer');
const AgentRegistry = require('./core/agent-manager/registry');
const DoubaoAppAdapter = require('./core/agent-manager/agents/doubao-app-adapter');

// Initialize store for persistent config
const store = new Store({
  name: 'opencli-assistant-config',
  defaults: require('./config.json')
});

// Initialize Agent Registry
AgentRegistry.init(store);
AgentRegistry.register(new DoubaoAppAdapter());

let mainWindow;
let overlayWindow;
let tray;
let isProcessing = false;
let currentAbortController = null;

// Create main settings window
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
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
    if (process.argv.includes('--dev')) {
      mainWindow.show();
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
    width: 240,
    height: 44,
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
  const barWidth = 240;
  const barHeight = 44;
  const offsetX = 15;
  const offsetY = 20;

  let winX = x + offsetX;
  let winY = y + offsetY;

  // Prevent the bar from going off-screen
  if (winX + barWidth > workArea.x + workArea.width) {
    winX = workArea.x + workArea.width - barWidth - 8;
  }
  if (winY + barHeight > workArea.y + workArea.height) {
    winY = y - barHeight - 8;
  }
  if (winX < workArea.x) winX = workArea.x + 4;
  if (winY < workArea.y) winY = workArea.y + 4;

  overlayWindow.setPosition(Math.round(winX), Math.round(winY));
  overlayWindow.showInactive(); // Show without stealing focus
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

    tray.setToolTip('OpenCLI Smart Assistant');

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

// Build or rebuild the tray context menu from current config
function rebuildTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Settings',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createMainWindow();
        }
      }
    },
    {
      label: 'Trigger Assistant',
      accelerator: store.get('shortcut'),
      click: () => handleShortcut()
    },
    { type: 'separator' },
    {
      label: 'Output',
      submenu: [
        {
          label: 'Auto Insert',
          type: 'radio',
          checked: store.get('auto_insert') !== false,
          click: () => {
            store.set('auto_insert', true);
            notifyConfigUpdated();
          }
        },
        {
          label: 'Clipboard',
          type: 'radio',
          checked: store.get('auto_insert') === false,
          click: () => {
            store.set('auto_insert', false);
            notifyConfigUpdated();
          }
        }
      ]
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit()
    }
  ]);

  tray.setContextMenu(contextMenu);
}

// Notify the settings window that config has been updated
function notifyConfigUpdated() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-updated', store.store);
  }
}

// Register global shortcut
function registerShortcut() {
  const shortcut = store.get('shortcut');
  
  if (globalShortcut.isRegistered(shortcut)) {
    globalShortcut.unregister(shortcut);
  }

  const registered = globalShortcut.register(shortcut, async () => {
    await handleShortcut();
  });

  if (!registered) {
    console.error(`Failed to register shortcut: ${shortcut}`);
    showNotification('Failed to register shortcut', 'Please check for conflicts');
  } else {
    console.log(`Shortcut registered: ${shortcut}`);
  }
}

// Main shortcut handler
async function handleShortcut() {
  if (isProcessing) {
    showNotification('Already Processing', 'Please wait for the current request to complete');
    return;
  }

  isProcessing = true;
  let streamingPaster = null;

  try {
    // Update tray menu
    updateTrayStatus('Processing...');

    // Show notification
    showNotification('OpenCLI Assistant', 'Analyzing screen...');

    // 1. Detect active window
    const activeWindow = detectActiveWindow();
    console.log('Active window:', activeWindow);

    // 2. Take screenshot
    console.log('Taking screenshot...');
    const screenshotBuffer = await takeScreenshot();
    console.log('Screenshot captured:', screenshotBuffer.length, 'bytes');

    // 3. Get selected prompt (if custom)
    let customPrompt = null;
    const selectedId = store.get('selected_prompt_id');
    if (selectedId && selectedId !== 'system-default') {
      const prompts = store.get('prompts') || [];
      const found = prompts.find(function(p) { return p.id === selectedId; });
      if (found && found.content && found.content.trim()) {
        customPrompt = found.content.trim();
        console.log('Using custom prompt:', found.name);
      }
    }

    // 4. Analyze with selected AI Agent (with optional streaming)
    const agent = AgentRegistry.getSelected();
    console.log('Analyzing with agent:', agent ? agent.id : 'none');

    if (!agent) {
      throw new Error('No AI Agent selected. Please configure an agent in Settings.');
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
      showNotification('Cancelled', 'AI generation cancelled');
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

        showNotification('Success', 'Text inserted successfully');
      } else if (outputMode === 'full') {
        // Full output: paste complete text at once
        await pasteText(result.text);
        console.log('Full paste completed');
        showNotification('Success', 'Text inserted successfully');
      }
    } else {
      // Copy to clipboard for manual paste
      clipboard.writeText(result.text);
      showNotification('Copied to Clipboard', 'Press Ctrl+V to paste');
    }

    // Send result to renderer
    if (mainWindow) {
      mainWindow.webContents.send('analysis-result', result);
    }

  } catch (error) {
    // Don't show error notification for user-initiated cancellations
    if (error.name === 'AbortError' || (currentAbortController && currentAbortController.signal.aborted)) {
      console.log('Shortcut handler: cancelled by user');
      showNotification('Cancelled', 'AI generation cancelled');
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
    tray.setToolTip(`OpenCLI Smart Assistant - ${status}`);
  }
}

// IPC handlers
function setupIpcHandlers() {
  // Get config
  ipcMain.handle('get-config', () => {
    return store.store;
  });

  // Update config
  ipcMain.handle('update-config', (event, updates) => {
    store.set(updates);
    
    // Re-register shortcut if it changed
    if (updates.shortcut) {
      registerShortcut();
    }
    
    // Rebuild tray menu to reflect config changes (e.g. Output mode)
    rebuildTrayMenu();
    
    return store.store;
  });

  // Trigger assistant manually from UI
  ipcMain.handle('trigger-assistant', async () => {
    await handleShortcut();
    return { success: true };
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
      selectedId: store.get('selected_prompt_id') || 'system-default'
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
    
    return { prompts: prompts, selectedId: store.get('selected_prompt_id') };
  });

  // Select a prompt
  ipcMain.handle('select-prompt', (event, id) => {
    store.set('selected_prompt_id', id);
    return { selectedId: id };
  });

  // --- Agent Management ---

  // Get all agents with current selection
  ipcMain.handle('get-agents', () => {
    return {
      agents: AgentRegistry.getAll(),
      selectedId: AgentRegistry.getSelected()?.id || null
    };
  });

  // Select an agent
  ipcMain.handle('select-agent', (event, id) => {
    const success = AgentRegistry.setSelected(id);
    return { success };
  });

  // Test agent connection
  ipcMain.handle('test-agent-connection', async (event, id) => {
    return await AgentRegistry.testConnection(id);
  });

  // --- Overlay Window IPC (floating status bar) ---

  // Cancel current processing from the overlay's cancel button
  ipcMain.on('cancel-processing', () => {
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
}

// App lifecycle
app.whenReady().then(() => {
  console.log('OpenCLI Smart Assistant starting...');
  
  // Setup IPC handlers FIRST
  setupIpcHandlers();
  
  // Then create UI
  createMainWindow();
  createOverlayWindow();
  createTray();
  registerShortcut();
  
  showNotification('OpenCLI Assistant Ready', `Press ${store.get('shortcut')} to trigger`);
});

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
