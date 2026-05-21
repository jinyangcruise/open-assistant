/**
 * DoubaoAppAdapter - AI Agent for Doubao Desktop App
 *
 * Uses OpenCLI's individual utils functions (injectTextScript, clickSendScript)
 * directly with a custom polling script that does NOT rely on message-count
 * comparison (beforeCount), since Doubao may reuse DOM containers on repeated
 * calls. Instead, it also compares the last assistant message text.
 */

const path = require('path');
const http = require('http');
const BaseAgent = require('../base-agent');

// ---------------------------------------------------------------------------
// Doubao Desktop App DOM Selectors (mirrors OpenCLI's SEL in utils.js)
// ---------------------------------------------------------------------------
const SEL = {
  MESSAGE: '[data-testid="message_content"]',
  MESSAGE_TEXT: '[data-testid="message_text_content"]',
  INDICATOR: '[data-testid="indicator"]',
  INPUT: '[data-testid="chat_input_input"]',
};

const FILE_INPUT = 'input[type="file"]';

// ---------------------------------------------------------------------------
// CDP target listing helper
// ---------------------------------------------------------------------------

/** Fetch all CDP targets from the HTTP endpoint */
function _fetchTargets(httpEndpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(httpEndpoint.replace(/\/$/, '') + '/json');
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// OpenCLI module access helpers (file:// URL bypasses Node exports map)
// ---------------------------------------------------------------------------

/** Lazy-load utils from OpenCLI's doubao-app adapter */
let _utilsPromise = null;
async function _getOpencliUtils() {
  if (!_utilsPromise) {
    const utilsPath = path.resolve(
      __dirname,
      '../../../node_modules/@jackwener/opencli/clis/doubao-app/utils.js',
    );
    const utilsUrl = 'file:///' + utilsPath.replace(/\\/g, '/');
    _utilsPromise = import(utilsUrl);
  }
  return _utilsPromise;
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
// Simple sleep helper (avoids page.wait → waitForDomStableJs)
// ---------------------------------------------------------------------------

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
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
   * Ensure the connected page is on a Doubao chat page with a visible input.
   * If connected to an internal/background page, find the real chat target
   * and reconnect. Does NOT create new conversations.
   * @param {Object} page - CDPPage instance (may be stale after reconnect)
   * @returns {Promise<Object>} The (possibly reconnected) page
   */
  async _ensureChatPage(page) {
    const currentUrl = await page.evaluate('window.location.href');

    // If on an internal/background page, find the real chat target
    if (!currentUrl ||
        currentUrl.startsWith('chrome://') ||
        currentUrl.startsWith('devtools://') ||
        currentUrl === 'about:blank') {
      const targets = await _fetchTargets(this.endpoint);
      const chatTarget = targets.find((t) => {
        const u = (t.url || '').toLowerCase();
        return (
          t.webSocketDebuggerUrl &&
          !u.startsWith('chrome://') &&
          !u.startsWith('devtools://') &&
          !u.startsWith('about:') &&
          u !== '' &&
          (t.type === 'page' || t.type === 'webview' || t.type === 'app')
        );
      });

      if (chatTarget) {
        this.disconnect();
        page = await this.connect(chatTarget.webSocketDebuggerUrl);
      } else {
        throw new Error(
          `无法找到豆包聊天页面。连接到后台页面: "${currentUrl}"，` +
          `且未找到其他可用的聊天页面目标。请确保豆包桌面端已打开。`,
        );
      }
    }

    // Wait for the chat input to appear (up to 8s)
    for (let attempt = 0; attempt < 8; attempt++) {
      const hasInput = await page.evaluate(
        `document.querySelector('${SEL.INPUT}') !== null`,
      );
      if (hasInput) return page;
      await sleep(1);
    }

    const title = await page.evaluate('document.title');
    const url = await page.evaluate('window.location.href');
    throw new Error(
      `无法找到豆包聊天输入框。页面标题: "${title}", URL: "${url}". ` +
      `请确保豆包桌面端已打开且处于聊天页面。`,
    );
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
   * Check if a new assistant response is ready.
   *
   * Walks backwards through message containers and checks:
   * 1. Whether the indicator (streaming cursor) is still visible
   * 2. Whether the last assistant message text has changed from before
   *
   * IMPORTANT: We do NOT rely on nowCount > beforeCount here, because the
   * user's own message also creates a new [data-testid="message_content"]
   * container — so the count would increase before the assistant responds,
   * causing us to return the stale old assistant text as "done".
   *
   * @param {number} beforeCount - message count before sending (kept for
   *   possible future use, not used in the main check)
   * @param {string} beforeLastText - text of the last assistant message
   *   before sending
   * @returns {string} evaluate script
   */
  _buildCustomPollScript(beforeCount, beforeLastText) {
    const escapedText = JSON.stringify(beforeLastText);
    return `(function() {
      const containers = document.querySelectorAll('${SEL.MESSAGE}');
      const hasIndicator = document.querySelector('${SEL.INDICATOR}') !== null;

      // Walk backwards to find the last assistant message
      let lastAssistantText = '';
      for (let i = containers.length - 1; i >= 0; i--) {
        const c = containers[i];
        if (c.classList.contains('justify-end')) continue;
        const textEl = c.querySelector('${SEL.MESSAGE_TEXT}');
        if (!textEl) continue;
        lastAssistantText = textEl.innerText?.trim() || textEl.textContent?.trim() || '';
        break;
      }

      // 1. Still streaming — indicator is visible
      if (hasIndicator) return { phase: 'streaming' };

      // 2. Assistant text has changed → new response is ready
      if (lastAssistantText && lastAssistantText !== ${escapedText}) {
        return { phase: 'done', text: lastAssistantText };
      }

      // 3. No change yet — keep waiting
      return { phase: 'waiting' };
    })()`;
  }

  /**
   * Analyze a screenshot using Doubao.
   *
   * Uses OpenCLI's injectTextScript + clickSendScript for DOM interaction,
   * but uses a custom polling script that checks BOTH message count AND
   * last-assistant-text-change — so it works whether Doubao creates new
   * DOM containers or reuses existing ones on repeated calls.
   *
   * @param {Buffer} screenshotBuffer - PNG screenshot buffer
   * @param {Object} context - Analysis context
   * @returns {Promise<Object>} Analysis result
   */
  async analyze(screenshotBuffer, context = {}) {
    let page = null;
    let tmpFile = null;

    try {
      // 1. Connect to Doubao CDP (reuses existing connection if available)
      page = await this.connect();

      // 2. Ensure we're on a proper chat page
      page = await this._ensureChatPage(page);

      // 3. Save screenshot and upload
      tmpFile = this._saveTempScreenshot(screenshotBuffer);
      await this._uploadScreenshot(page, tmpFile);

      // 4. Build the prompt
      const hasScreenshot = true;
      const prompt =
        context.customPrompt && context.customPrompt.trim()
          ? context.customPrompt.trim()
          : buildAnalysisPrompt(context, hasScreenshot);

      // 5. Use OpenCLI's utils for DOM interaction (injectText, clickSend)
      const { injectTextScript, clickSendScript } =
        await _getOpencliUtils();

      // 6. Capture snapshot BEFORE sending:
      //    - message count (to detect new DOM containers)
      //    - last assistant text (to detect in-place content updates)
      const beforeCount = await page.evaluate(
        `document.querySelectorAll('${SEL.MESSAGE}').length`,
      );
      const beforeLastText = await page.evaluate(`(function() {
        const containers = document.querySelectorAll('${SEL.MESSAGE}');
        for (let i = containers.length - 1; i >= 0; i--) {
          if (containers[i].classList.contains('justify-end')) continue;
          const textEl = containers[i].querySelector('${SEL.MESSAGE_TEXT}');
          if (!textEl) return '';
          return textEl.innerText?.trim() || textEl.textContent?.trim() || '';
        }
        return '';
      })()`);

      // 7. Inject text into chat input
      const injected = await page.evaluate(injectTextScript(prompt));
      if (!injected || !injected.ok) {
        throw new Error('无法在豆包聊天输入框中输入文本');
      }

      await sleep(0.5);

      // 8. Click send button (fallback: Enter key)
      const clicked = await page.evaluate(clickSendScript());
      if (!clicked) {
        await page.pressKey('Enter');
      }

      // 9. Poll for response using custom script (simple setTimeout, no page.wait)
      const timeoutSec = Math.ceil((context.timeout || 30000) / 1000);
      const pollInterval = 1;
      const maxPolls = Math.ceil(timeoutSec / pollInterval);
      let response = '';

      for (let i = 0; i < maxPolls; i++) {
        await sleep(pollInterval);

        const result = await page.evaluate(
          this._buildCustomPollScript(beforeCount, beforeLastText),
        );
        if (!result) continue;

        if (result.phase === 'done' && result.text) {
          response = result.text;
          break;
        }
      }

      if (!response) {
        throw new Error(`豆包未在 ${timeoutSec} 秒内返回回复`);
      }

      return {
        text: response,
        type: this._analyzeContentType(response),
        timestamp: new Date().toISOString(),
        agentId: this.id,
      };
    } finally {
      this._cleanupTempFile(tmpFile);
    }
  }
}

module.exports = DoubaoAppAdapter;
