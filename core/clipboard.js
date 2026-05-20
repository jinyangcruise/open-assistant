/**
 * Clipboard and Keyboard Module
 * 
 * Handles clipboard operations and keyboard simulation using robotjs
 */

const { clipboard } = require('electron');
const robot = require('robotjs');

/**
 * Paste text to current cursor position
 * @param {string} text - Text to paste
 */
async function pasteText(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text to paste');
  }

  try {
    // Save current clipboard content
    const oldClipboard = clipboard.readText();

    // Set new text to clipboard
    clipboard.writeText(text);

    // Small delay to ensure clipboard is updated
    await new Promise(resolve => setTimeout(resolve, 100));

    // Simulate Ctrl+V (or Cmd+V on macOS)
    const isMac = process.platform === 'darwin';
    const modifier = isMac ? 'command' : 'control';

    robot.keyToggle(modifier, 'down');
    robot.keyTap('v');
    robot.keyToggle(modifier, 'up');

    // Small delay after paste
    await new Promise(resolve => setTimeout(resolve, 200));

    // Restore old clipboard content
    clipboard.writeText(oldClipboard);

    console.log('Text pasted successfully');
  } catch (error) {
    console.error('Paste failed:', error.message);
    throw new Error(`Failed to paste text: ${error.message}`);
  }
}

/**
 * Get current clipboard text
 * @returns {string}
 */
function getText() {
  return clipboard.readText();
}

/**
 * Copy text to clipboard (without pasting)
 * @param {string} text
 */
function copyToClipboard(text) {
  clipboard.writeText(text);
}

/**
 * Simulate keyboard shortcut
 * @param {string} keys - Keys to press (e.g., 'Ctrl+A', 'Cmd+C')
 */
function simulateShortcut(keys) {
  const parts = keys.split('+').map(k => k.trim());
  const modifiers = parts.slice(0, -1);
  const key = parts[parts.length - 1];

  // Press modifiers
  modifiers.forEach(mod => {
    robot.keyToggle(mod.toLowerCase(), 'down');
  });

  // Tap key
  robot.keyTap(key.toLowerCase());

  // Release modifiers (in reverse order)
  modifiers.reverse().forEach(mod => {
    robot.keyToggle(mod.toLowerCase(), 'up');
  });
}

/**
 * Type text character by character (for special cases where paste doesn't work)
 * @param {string} text
 * @param {number} delay - Delay between characters (ms)
 */
async function typeText(text, delay = 10) {
  for (const char of text) {
    try {
      robot.typeString(char);
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error) {
      console.warn(`Failed to type character: ${char}`, error.message);
    }
  }
}

/**
 * Select all text in current field
 */
function selectAll() {
  simulateShortcut(process.platform === 'darwin' ? 'Cmd+A' : 'Ctrl+A');
}

/**
 * Delete selected text
 */
function deleteSelected() {
  robot.keyTap('delete');
}

/**
 * Move cursor
 * @param {string} direction - 'left', 'right', 'up', 'down'
 * @param {number} count - Number of times
 */
function moveCursor(direction, count = 1) {
  for (let i = 0; i < count; i++) {
    robot.keyTap(direction);
  }
}

module.exports = {
  pasteText,
  getText,
  copyToClipboard,
  simulateShortcut,
  typeText,
  selectAll,
  deleteSelected,
  moveCursor
};
