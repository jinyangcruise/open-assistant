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
  ASR_BTN: '[data-testid="asr_btn"]',
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
   * Fast poll script — returns current state of Doubao's chat page.
   *
   * Returns structured data so the Node.js loop can make decisions about
   * idle timeout, completion detection, etc.
   *
   * Completion signal (as identified via DevTools inspection):
   * - hasAsrBtn → true: voice button visible = idle OR generation complete
   *   During generation, `asr_btn` element is REMOVED from the DOM and
   *   replaced by a send-btn-wrapper. When generation finishes, the
   *   `asr_btn` element is restored, signaling completion.
   *
   * @param {string} beforeLastText - assistant text captured BEFORE sending
   * @returns {string} evaluate script
   */
  _buildFastPollScript(beforeLastText) {
    const escapedText = JSON.stringify(beforeLastText);
    return `(function() {
      const containers = document.querySelectorAll('${SEL.MESSAGE}');
      const hasIndicator = document.querySelector('${SEL.INDICATOR}') !== null;
      const hasAsrBtn = document.querySelector('${SEL.ASR_BTN}') !== null;

      // --- Walk backwards: find the last assistant message ---
      let lastText = '';
      for (let i = containers.length - 1; i >= 0; i--) {
        if (containers[i].classList.contains('justify-end')) continue;
        const textEl = containers[i].querySelector('${SEL.MESSAGE_TEXT}');
        if (textEl) {
          lastText = textEl.innerText?.trim() || textEl.textContent?.trim() || '';
        }
        break;
      }

      return {
        text: lastText,
        hasIndicator: hasIndicator,
        hasAsrBtn: hasAsrBtn,
      };
    })()`;
  }

  /**
   * Analyze a screenshot using Doubao.
   *
   * Polling strategy (asr_btn-based):
   * - 200ms polling interval for near-instant response detection
   * - Primary completion: `[data-testid="asr_btn"]` reappears (voice button)
   *   This element is removed during generation and restored when done.
   * - Fallback: idle timeout (1.5s no output change) → assume complete
   * - Safety limit: user-configured timeout (context.timeout)
   *
   * @param {Buffer} screenshotBuffer - PNG screenshot buffer
   * @param {Object} context - Analysis context
   * @returns {Promise<Object>} Analysis result
   */
  async analyze(screenshotBuffer, context = {}) {
    let page = null;
    let tmpFile = null;

    try {
      // 0. Force fresh connection
      this.disconnect();
      page = await this.connect();

      // 1. Ensure we're on a proper chat page
      page = await this._ensureChatPage(page);

      // 2. Save screenshot and upload
      tmpFile = this._saveTempScreenshot(screenshotBuffer);
      await this._uploadScreenshot(page, tmpFile);

      // 3. Build the prompt
      const hasScreenshot = true;
      const prompt =
        context.customPrompt && context.customPrompt.trim()
          ? context.customPrompt.trim()
          : buildAnalysisPrompt(context, hasScreenshot);

      // 4. Use OpenCLI's utils for DOM interaction (injectText, clickSend)
      const { injectTextScript, clickSendScript } =
        await _getOpencliUtils();

      // 5. Wake up hidden renderer
      try {
        await page.cdp('Page.bringToFront');
        await sleep(0.5);
      } catch (e) {
        // Page might be unreachable
      }

      // 6. Capture the last assistant message text BEFORE sending
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

      // ---------------------------------------------------------------
      // 9. Idle-timeout based polling
      //
      //    Detection logic:
      //      1. Text changes → reset idle timer
      //      2. asr_btn reappears (!hasAsrBtn → true) → generation done
      //         The asr_btn (voice button) is REMOVED from the DOM during
      //         generation and RESTORED when done.
      //      3. Idle timeout (no new text for 1.5s) → fallback
      // ---------------------------------------------------------------
      const userTimeout = context.timeout || 30000;
      const MAX_TOTAL_MS = userTimeout;
      const IDLE_TIMEOUT_MS = Math.min(1500, Math.floor(MAX_TOTAL_MS / 3));
      const POLL_MS = 200;

      let lastText = beforeLastText;
      let idleMs = 0;
      let totalMs = 0;
      let hasNewText = false;
      let response = '';

      while (totalMs < MAX_TOTAL_MS) {
        await sleep(POLL_MS / 1000);
        totalMs += POLL_MS;

        const result = await page.evaluate(
          this._buildFastPollScript(beforeLastText),
        );
        if (!result) continue;

        // --- Detect new text → reset idle timer ---
        if (result.text && result.text !== lastText) {
          lastText = result.text;
          idleMs = 0;
          hasNewText = true;
        } else {
          idleMs += POLL_MS;
        }

        // --- PRIMARY COMPLETION: asr_btn reappeared → generation done ---
        // During generation, `[data-testid="asr_btn"]` is removed from the
        // DOM. When generation finishes, it's restored (voice button).
        if (hasNewText && result.text && result.hasAsrBtn) {
          response = result.text;
          break;
        }

        // --- FALLBACK: idle timeout → no new output for a while ---
        if (hasNewText && idleMs >= IDLE_TIMEOUT_MS) {
          response = result.text;
          break;
        }
      }

      if (!response) {
        throw new Error(`豆包未在 ${userTimeout / 1000} 秒内返回回复`);
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
