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

// Dev-mode only logging
const isDev = process.argv.includes('--dev');
function debugLog(...args) {
  if (isDev) console.log(...args);
}

/**
 * Paste text to current cursor position
 * Uses system clipboard + OS-level paste simulation (single batch)
 */
async function pasteText(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text to paste');
  }

  try {
    console.log('Preparing to paste text, length:', text.length, 'lines:', text.split('\n').length);
    
    const paster = new StreamingPaster();
    await paster.start();
    await paster.push(text);
    await paster.finish();

    console.log('Text pasted successfully');
  } catch (error) {
    console.error('Paste failed:', error.message);
    throw new Error(`Failed to paste text: ${error.message}`);
  }
}

/**
 * StreamingPaster — paste text in multiple incremental chunks.
 *
 * Batches small incoming chunks to reduce paste operations.
 * Internally serializes clipboard access with a FIFO processing loop.
 *
 * Usage:
 *   const paster = new StreamingPaster();
 *   await paster.start();
 *   await paster.push('first chunk');
 *   await paster.push('second chunk');  // appends at cursor position
 *   await paster.finish();
 */
class StreamingPaster {
  constructor() {
    this._originalClipboard = '';
    this._started = false;
    this._finished = false;
    this._busy = false;
    this._pending = [];
    this._flushResolve = null;

    // Batching: accumulate small chunks to reduce paste frequency
    this._batchText = '';
    this._batchTimer = null;
    this._minBatchSize = 50;   // chars — flush when this much accumulates
    this._maxBatchDelay = 300; // ms — flush after this much idle time
  }

  /** Save original clipboard and prepare for streaming */
  async start() {
    if (this._started) return;
    this._started = true;
    this._originalClipboard = clipboard.readText();
    await sleep(50);
  }

  /**
   * Push a text chunk for streaming paste.
   *
   * Small chunks are batched internally and flushed when either:
   * - The accumulated text reaches _minBatchSize (50 chars)
   * - _maxBatchDelay (300ms) has passed since the last push
   *
   * @param {string} text - The text chunk to paste
   */
  async push(text) {
    if (!this._started || this._finished) {
      throw new Error('StreamingPaster: call start() before push(), and do not push() after finish()');
    }
    if (!text) return;

    // Accumulate into batch buffer
    this._batchText += text;

    // Reset debounce timer
    if (this._batchTimer) clearTimeout(this._batchTimer);

    // Flush if batch is large enough
    if (this._batchText.length >= this._minBatchSize) {
      this._flushBatch();
    } else {
      // Schedule a flush after idle timeout
      this._batchTimer = setTimeout(() => this._flushBatch(), this._maxBatchDelay);
    }
  }

  /**
   * Flush the accumulated batch into the processing queue.
   */
  _flushBatch() {
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    if (!this._batchText) return;

    this._pending.push(this._batchText);
    this._batchText = '';

    if (!this._busy) {
      this._busy = true;
      // DO NOT await — let the processing loop run in the background
      this._processQueue();
    }
  }

  /**
   * Internal async loop that processes queued paste operations
   * one at a time. clipboard.writeText() runs before the first await,
   * ensuring synchronous clipboard access.
   */
  async _processQueue() {
    debugLog('[StreamingPaster] _processQueue started, pending:', this._pending.length);
    while (this._pending.length > 0) {
      const text = this._pending.shift();

      // null = flush signal from finish()
      if (text === null) {
        debugLog('[StreamingPaster] flush signal received, restoring clipboard');
        this._finished = true;
        clipboard.writeText(this._originalClipboard);
        if (this._flushResolve) {
          this._flushResolve();
          this._flushResolve = null;
        }
        this._busy = false;
        return;
      }

      try {
        // clipboard.writeText runs SYNCHRONOUSLY before await
        clipboard.writeText(text);
        debugLog('[StreamingPaster] wrote to clipboard, length:', text.length);
        await sleep(20);
        await simulatePaste();
        debugLog('[StreamingPaster] paste completed');
        await sleep(30);
      } catch (err) {
        console.warn('[StreamingPaster] push failed:', err);
      }
    }
    debugLog('[StreamingPaster] _processQueue finished');
    this._busy = false;
  }

  /**
   * Flush any remaining batch, then restore original clipboard.
   */
  async finish() {
    if (this._finished) return;

    // Flush any remaining batch first
    this._flushBatch();

    debugLog('[StreamingPaster] finish called, pending:', this._pending.length);

    return new Promise((resolve) => {
      this._flushResolve = resolve;
      this._pending.push(null); // flush signal
      if (!this._busy) {
        this._busy = true;
        this._processQueue();
      }
    });
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
                       'WScript.Sleep 50\n' +
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

/** Short sleep helper */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  pasteText,
  StreamingPaster,
  getText,
  copyToClipboard,
  registerGlobalShortcut,
  unregisterAllShortcuts
};
