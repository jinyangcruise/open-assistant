/**
 * BaseAgent - Abstract base class for all AI Agent adapters
 * 
 * Wraps OpenCLI CDPBridge for CDP connection management,
 * defines the analyze() template method that subclasses must implement.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

class BaseAgent {
  /**
   * @param {Object} config
   * @param {string} config.id - Unique agent identifier (e.g. 'doubao-app')
   * @param {string} config.name - Human-readable name (e.g. '豆包桌面端')
   * @param {'electron'|'web'} config.type - Connection type
   * @param {string} config.endpoint - CDP endpoint or URL
   * @param {boolean} [config.enabled=true] - Whether this agent is enabled
   */
  constructor(config) {
    if (!config.id || !config.name) {
      throw new Error('Agent config must include id and name');
    }
    this.id = config.id;
    this.name = config.name;
    this.type = config.type || 'electron';
    this.endpoint = config.endpoint;
    this.enabled = config.enabled !== false;
    this.installPath = config.install_path || '';
    this._page = null;
    this._bridge = null;
    this._opencliCdp = null; // cached module reference
  }

  /**
   * Lazy-load the OpenCLI CDP module via dynamic import()
   * @returns {Promise<Object>} CDPBridge class
   */
  async _getOpencliCdp() {
    if (!this._opencliCdp) {
      this._opencliCdp = await import('@jackwener/opencli/browser/cdp');
    }
    return this._opencliCdp;
  }

  /**
   * Connect to the CDP endpoint and return a CDPPage instance.
   * If wsUrl is provided, connect directly to that WebSocket URL
   * (bypassing target selection). Otherwise, use this.endpoint.
   * @param {string} [wsUrl] - Optional direct WebSocket URL to connect to
   * @returns {Promise<Object>} CDPPage instance
   */
  async connect(wsUrl) {
    if (this._page) return this._page;

    const { CDPBridge } = await this._getOpencliCdp();
    this._bridge = new CDPBridge();
    this._page = await this._bridge.connect({
      cdpEndpoint: wsUrl || this.endpoint,
    });

    return this._page;
  }

  /**
   * Disconnect from the CDP endpoint
   */
  disconnect() {
    if (this._bridge) {
      try { this._bridge.close(); } catch (e) { /* ignore */ }
    }
    this._bridge = null;
    this._page = null;
  }

  /**
   * Expose the CDP bridge for direct CDP command access.
   * Used by SSE Fetch mode to send Fetch.enable, Fetch.getResponseBody, etc.
   * @returns {Object|null} CDPBridge instance
   */
  getBridge() {
    return this._bridge;
  }

  /**
   * Test if the CDP endpoint is reachable and responsive
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async testConnection() {
    try {
      const page = await this.connect();
      // Try a simple evaluate to verify the connection is alive
      const title = await page.evaluate('document.title');
      return { success: true, title: String(title) };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      this.disconnect();
    }
  }

  /**
   * Subclasses MUST implement this method.
   * 
   * @param {Buffer} screenshotBuffer - PNG screenshot buffer
   * @param {Object} context - Analysis context
   * @param {string} context.appName - Active application name
   * @param {number} context.timeout - Timeout in milliseconds
   * @param {string} [context.customPrompt] - Custom prompt override
   * @returns {Promise<{text: string, type: string, timestamp: string, agentId: string}>}
   */
  async analyze(screenshotBuffer, context) {
    throw new Error(`analyze() not implemented for agent: ${this.id}`);
  }

  /**
   * Save a screenshot buffer to a temporary file
   * @param {Buffer} buffer
   * @returns {string} Temporary file path
   */
  _saveTempScreenshot(buffer) {
    const tmpFile = path.join(os.tmpdir(), `opencli-screenshot-${Date.now()}.png`);
    fs.writeFileSync(tmpFile, buffer);
    return tmpFile;
  }

  /**
   * Clean up a temporary file
   * @param {string|null} filePath
   */
  _cleanupTempFile(filePath) {
    if (filePath) {
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore cleanup errors */ }
    }
  }

  /**
   * Analyze content type (code vs document)
   * @param {string} text
   * @returns {'code'|'document'}
   */
  _analyzeContentType(text) {
    const codePatterns = /```[\s\S]*?```|function\s+\w+|class\s+\w+|import\s+|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|def\s+\w+|public\s+class|private\s+void/;
    return codePatterns.test(text) ? 'code' : 'document';
  }
}

module.exports = BaseAgent;
