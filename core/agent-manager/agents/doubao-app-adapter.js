/**
 * DoubaoAppAdapter - AI Agent for Doubao Desktop App
 *
 * Uses OpenCLI's built-in doubao-app adapter for the core interaction
 * (text injection → send → response polling), with custom screenshot
 * upload logic that OpenCLI doesn't natively support.
 */

const path = require('path');
const BaseAgent = require('../base-agent');

// ---------------------------------------------------------------------------
// Doubao Desktop App DOM Selectors (mirrors OpenCLI's SEL in utils.js)
// ---------------------------------------------------------------------------
const SEL = {
  MESSAGE: '[data-testid="message_content"]',
  INPUT: '[data-testid="chat_input_input"]',
};

const FILE_INPUT = 'input[type="file"]';

// ---------------------------------------------------------------------------
// OpenCLI module access helpers (file:// URL bypasses Node exports map)
// ---------------------------------------------------------------------------

/** Resolve the file:// URL for OpenCLI's installed doubao-app utils.js */
function _resolveOpencliPath() {
  const utilsPath = path.resolve(
    __dirname,
    '../../../node_modules/@jackwener/opencli/clis/doubao-app/utils.js',
  );
  return 'file:///' + utilsPath.replace(/\\/g, '/');
}

/** Lazy-load the ask command from OpenCLI's doubao-app adapter */
let _askCommandPromise = null;
async function _getAskCommand() {
  if (!_askCommandPromise) {
    const askPath = path.resolve(
      __dirname,
      '../../../node_modules/@jackwener/opencli/clis/doubao-app/ask.js',
    );
    const askUrl = 'file:///' + askPath.replace(/\\/g, '/');
    _askCommandPromise = import(askUrl).then((m) => m.askCommand);
  }
  return _askCommandPromise;
}

// ---------------------------------------------------------------------------
// Analysis prompt builder (application-specific)
// ---------------------------------------------------------------------------

function buildAnalysisPrompt(context, hasScreenshot) {
  const screenshotNote = hasScreenshot
    ? '我发送了一张屏幕截图，请分析截图中的内容'
    : '请分析当前屏幕内容（截图上传可能未成功，如能看到请分析）';

  return `${screenshotNote}，并提供智能补全建议。

${context.appName && context.appName !== 'Unknown' ? '当前应用: ' + context.appName : ''}

要求：
1. 判断我正在做什么（写代码/写文档/其他）
2. 如果是代码，识别编程语言和上下文
3. 根据上下文，提供智能补全建议
4. 只返回补全内容，不要解释
5. 保持代码格式和缩进
6. 根据用户使用的编程语言和工具，使用正确的缩进方式（空格/制表符）
7. 不要重复用户已有的内容，例如用户写的注释

请直接分析屏幕截图并返回补全建议：`;
}

// ---------------------------------------------------------------------------
// DoubaoAppAdapter
// ---------------------------------------------------------------------------

class DoubaoAppAdapter extends BaseAgent {
  constructor() {
    super({
      id: 'doubao-app',
      name: '豆包桌面端',
      type: 'electron',
      endpoint: 'http://127.0.0.1:9225',
    });
  }

  /**
   * Upload a screenshot file to Doubao chat via CDP
   * @param {Object} page - CDPPage instance
   * @param {string} filePath - Absolute path to the screenshot file
   * @returns {Promise<{success: boolean}>}
   */
  async _uploadScreenshot(page, filePath) {
    try {
      const docResult = await page.cdp('DOM.getDocument');
      const queryResult = await page.cdp('DOM.querySelector', {
        nodeId: docResult.root.nodeId,
        selector: FILE_INPUT,
      });
      if (queryResult && queryResult.nodeId) {
        await page.cdp('DOM.setFileInputFiles', {
          files: [filePath],
          nodeId: queryResult.nodeId,
        });
        return { success: true };
      }
    } catch (err) {
      // File input not found or CDP command failed
    }

    return { success: false };
  }

  /**
   * Analyze a screenshot using Doubao
   * @param {Buffer} screenshotBuffer - PNG screenshot buffer
   * @param {Object} context - Analysis context
   * @returns {Promise<Object>} Analysis result
   */
  async analyze(screenshotBuffer, context = {}) {
    let page = null;
    let tmpFile = null;

    try {
      // 1. Connect to Doubao CDP
      page = await this.connect();

      // 2. Save screenshot to temp file and upload
      tmpFile = this._saveTempScreenshot(screenshotBuffer);
      const uploadResult = await this._uploadScreenshot(page, tmpFile);

      // 3. Build the prompt
      const hasScreenshot = uploadResult.success;
      const prompt =
        context.customPrompt && context.customPrompt.trim()
          ? context.customPrompt.trim()
          : buildAnalysisPrompt(context, hasScreenshot);

      // 4. Use OpenCLI's doubao-app/ask command func for:
      //    - Text injection into chat input
      //    - Clicking the send button
      //    - Polling for AI response completion
      const askCommand = await _getAskCommand();
      const timeoutSec = Math.ceil((context.timeout || 30000) / 1000);

      const result = await askCommand.func(page, {
        text: prompt,
        timeout: timeoutSec,
      });

      // askCommand.func returns [{Role, Text}, {Role, Text}]
      // Index 0 = User message, Index 1 = Assistant response
      const response = (result && result[1] && result[1].Text) || '';

      return {
        text: response,
        type: this._analyzeContentType(response),
        timestamp: new Date().toISOString(),
        agentId: this.id,
      };
    } finally {
      // Cleanup
      this._cleanupTempFile(tmpFile);
      // Note: we keep the CDP connection alive for potential reuse;
      // caller can call disconnect() when done
    }
  }
}

module.exports = DoubaoAppAdapter;
