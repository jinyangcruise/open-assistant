/**
 * Clipboard Module - Pure Electron (No native compilation needed)
 * 
 * Uses Electron's built-in clipboard and globalShortcut
 * No robotjs dependency - works out of the box!
 */

const { clipboard, globalShortcut, BrowserWindow } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Paste text to current cursor position
 * Uses system clipboard + OS-level paste simulation
 */
async function pasteText(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text to paste');
  }

  try {
    console.log('Preparing to paste text, length:', text.length, 'lines:', text.split('\n').length);
    
    // Save current clipboard
    const oldClipboard = clipboard.readText();

    // Set new text to clipboard (preserve original format)
    clipboard.writeText(text);
    
    // Wait for clipboard to update
    await new Promise(resolve => setTimeout(resolve, 300));

    // Verify clipboard was set
    const verifyText = clipboard.readText();
    if (verifyText.length < text.length * 0.9) {
      console.warn('Clipboard verification failed, retrying...');
      console.log('Expected length:', text.length, 'Got:', verifyText.length);
      clipboard.writeText(text);
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log('Clipboard content verified, length:', clipboard.readText().length);

    // Simulate Ctrl+V at OS level
    console.log('Simulating paste shortcut...');
    await simulatePaste();

    // Wait for paste to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Restore clipboard
    clipboard.writeText(oldClipboard);

    console.log('Text pasted successfully');
  } catch (error) {
    console.error('Paste failed:', error.message);
    throw new Error(`Failed to paste text: ${error.message}`);
  }
}

/**
 * Simulate Ctrl+V paste at OS level
 */
function simulatePaste() {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    
    if (platform === 'win32') {
      // Windows: Use VBScript to simulate Ctrl+V
      const vbscript = 'Set WshShell = CreateObject("WScript.Shell")\n' +
                       'WScript.Sleep 200\n' +
                       'WshShell.SendKeys "^v"';
      
      const tempFile = path.join(os.tmpdir(), 'paste.vbs');
      
      try {
        fs.writeFileSync(tempFile, vbscript);
        exec(`cscript //nologo "${tempFile}"`, (error) => {
          // Clean up temp file
          try { fs.unlinkSync(tempFile); } catch (e) {}
          
          if (error) {
            console.warn('VBScript paste failed:', error.message);
          }
          resolve();
        });
      } catch (error) {
        console.warn('Failed to create VBScript:', error.message);
        resolve();
      }
    } else if (platform === 'darwin') {
      // macOS: Use osascript
      exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, (error) => {
        if (error) {
          console.warn('macOS paste failed');
        }
        resolve();
      });
    } else {
      // Linux: Use xdotool
      exec('xdotool key ctrl+v', (error) => {
        if (error) {
          console.warn('Linux paste failed');
        }
        resolve();
      });
    }
  });
}

/**
 * Get current clipboard text
 */
function getText() {
  return clipboard.readText();
}

/**
 * Copy text to clipboard
 */
function copyToClipboard(text) {
  clipboard.writeText(text);
}

/**
 * Register a global shortcut
 */
function registerGlobalShortcut(accelerator, callback) {
  return globalShortcut.register(accelerator, callback);
}

/**
 * Unregister all shortcuts
 */
function unregisterAllShortcuts() {
  globalShortcut.unregisterAll();
}

module.exports = {
  pasteText,
  getText,
  copyToClipboard,
  registerGlobalShortcut,
  unregisterAllShortcuts
};
