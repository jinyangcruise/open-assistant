/**
 * OpenCLI Smart Assistant - Main Process
 * 
 * Handles:
 * - Global shortcut registration
 * - System tray icon
 * - IPC communication with renderer
 * - Core workflow: screenshot -> analyze -> insert
 */

const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, Notification, clipboard, nativeImage } = require('electron');
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
let tray;
let isProcessing = false;

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
    
    // Create a minimal 1x1 icon if no valid icon
    if (!trayIcon || trayIcon.isEmpty()) {
      // Create a 1x1 transparent PNG programmatically
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsQAAA7EAZUrDhsAAAANSURBVBhXYzh48OB/' +
        'AAAAAElFTkSuQmCC',
        'base64'
      );
      trayIcon = nativeImage.createFromBuffer(pngBuffer);
    }
    
    tray = new Tray(trayIcon);

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
        label: 'Auto Insert: ON',
        type: 'checkbox',
        checked: store.get('auto_insert'),
        click: (item) => {
          store.set('auto_insert', item.checked);
          item.label = `Auto Insert: ${item.checked ? 'ON' : 'OFF'}`;
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.quit()
      }
    ]);

    tray.setToolTip('OpenCLI Smart Assistant');
    tray.setContextMenu(contextMenu);

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

    // Prepare streaming paster if auto-insert is enabled
    const shouldAutoInsert = store.get('auto_insert');
    const storedMode = store.get('response_mode');
    console.log('[Main] stored response_mode:', JSON.stringify(storedMode), '| default fallback:', storedMode || 'sse-fetch');
    const context = {
      appName: activeWindow.title,
      timeout: store.get('timeout_seconds') * 1000,
      customPrompt: customPrompt,
      responseMode: storedMode || 'sse-fetch',
    };

    if (shouldAutoInsert) {
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

    const result = await agent.analyze(screenshotBuffer, context);
    console.log('Analysis result:', result);

    // 5. Finish streaming or finalize paste
    if (shouldAutoInsert && streamingPaster) {
      await streamingPaster.finish();
      console.log('Streaming paste completed');

      // Safety fallback: if no text was streamed (onChunk never triggered),
      // copy full text to clipboard so user can manually paste
      if (!result.text) {
        console.warn('[Streaming] Empty analysis result');
      }

      showNotification('Success', 'Text inserted successfully');
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
    console.error('Error in shortcut handler:', error);
    showNotification('Error', error.message || 'Failed to process request');

    // Restore clipboard even on error
    if (streamingPaster) {
      try { await streamingPaster.finish(); } catch { /* ignore cleanup errors */ }
    }

    if (mainWindow) {
      mainWindow.webContents.send('error', error.message);
    }
  } finally {
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
}

// App lifecycle
app.whenReady().then(() => {
  console.log('OpenCLI Smart Assistant starting...');
  
  // Setup IPC handlers FIRST
  setupIpcHandlers();
  
  // Then create UI
  createMainWindow();
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
