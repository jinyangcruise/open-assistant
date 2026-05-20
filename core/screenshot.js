/**
 * Screenshot Module
 * 
 * Captures screen using screenshot-desktop library
 */

const screenshot = require('screenshot-desktop');

/**
 * Take a screenshot of the screen
 * @param {Object} options - Screenshot options
 * @returns {Promise<Buffer>} PNG buffer
 */
async function takeScreenshot(options = {}) {
  const defaultOptions = {
    format: 'png',
    ...options
  };

  try {
    const buffer = await screenshot(defaultOptions);
    return buffer;
  } catch (error) {
    console.error('Screenshot failed:', error.message);
    throw new Error(`Failed to capture screenshot: ${error.message}`);
  }
}

/**
 * Take screenshot of specific screen (multi-monitor setup)
 * @param {number} screenIndex - Screen index (0-based)
 * @returns {Promise<Buffer>}
 */
async function takeScreenshotOfScreen(screenIndex) {
  try {
    const buffer = await screenshot({ screen: screenIndex, format: 'png' });
    return buffer;
  } catch (error) {
    console.error('Screenshot of screen failed:', error.message);
    throw new Error(`Failed to capture screen ${screenIndex}: ${error.message}`);
  }
}

/**
 * List available screens
 * @returns {Promise<Array>}
 */
async function listScreens() {
  try {
    const screens = await screenshot.listDisplays();
    return screens;
  } catch (error) {
    console.error('List screens failed:', error.message);
    return [];
  }
}

module.exports = {
  takeScreenshot,
  takeScreenshotOfScreen,
  listScreens
};
