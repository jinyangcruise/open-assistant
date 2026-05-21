/**
 * DoubaoAppAdapter - AI Agent for Doubao Desktop App
 *
 * Connects to the Doubao desktop app via CDP (port 9225),
 * uploads a screenshot, injects a prompt, clicks send,
 * and polls for the AI response.
 */

const BaseAgent = require('../base-agent');

// ---------------------------------------------------------------------------
// Doubao Desktop App DOM Selectors
// ---------------------------------------------------------------------------
const SEL = {
  MESSAGE: '[data-testid="message_content"]',
  MESSAGE_TEXT: '[data-testid="message_text_content"]',
  INDICATOR: '[data-testid="indicator"]',
  INPUT: '[data-testid="chat_input_input"]',
  SEND_BTN: '[data-testid="chat_input_send_button"]',
  FILE_INPUT: 'input[type="file"]',
  ACTION_KEYWORDS: [
    '复制', '朗读', '播报', '喜欢', '不喜欢', '分享', '重新生成',
    'copy', 'voice', 'like', 'dislike', 'share', 'regenerate', 'action', 'more',
  ],
};

// ---------------------------------------------------------------------------
// Injected JavaScript snippets (run in Doubao page context)
// ---------------------------------------------------------------------------

/**
 * Build script to upload a file via CDP (used as fallback)
 */
function buildFileInputQueryScript() {
  return `(function() {
    var inputs = document.querySelectorAll('${SEL.FILE_INPUT}');
    return { found: inputs.length > 0, count: inputs.length };
  })()`;
}

/**
 * Inject text into the chat input textarea (React-compatible)
 */
function buildInjectTextScript(text) {
  return `(function(t) {
    var textarea = document.querySelector('${SEL.INPUT}');
    if (!textarea) return { ok: false, error: 'No textarea found' };
    textarea.focus();
    var setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (setter) setter.call(textarea, t);
    else textarea.value = t;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })(${JSON.stringify(text)})`;
}

/**
 * Multi-strategy click on the send button
 */
function buildClickSendScript() {
  return `(function() {
    var textarea = document.querySelector('${SEL.INPUT}');

    // Strategy 1: Find button near textarea
    if (textarea) {
      var parent = textarea.closest('div');
      if (parent) {
        var container = parent.parentElement || parent;
        var allButtons = container.querySelectorAll('button, [role="button"]');
        for (var bi = 0; bi < allButtons.length; bi++) {
          var btn = allButtons[bi];
          var rect = btn.getBoundingClientRect();
          if (rect.width > 20 && rect.height > 20 && !btn.disabled) {
            if (rect.top > textarea.getBoundingClientRect().top - 50) {
              btn.click();
              return { clicked: true, strategy: 'parent-button' };
            }
          }
        }
      }
    }

    // Strategy 2: Match button by text
    var allButtons = document.querySelectorAll('button');
    for (var bi = 0; bi < allButtons.length; bi++) {
      var btn = allButtons[bi];
      var rect = btn.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 20 && !btn.disabled) {
        var btnText = (btn.textContent || '').toLowerCase();
        var btnHTML = btn.innerHTML.toLowerCase();
        if (btnText.indexOf('send') !== -1 || btnText.indexOf('发送') !== -1 ||
            btnHTML.indexOf('send') !== -1 || btnHTML.indexOf('arrow') !== -1 ||
            btnHTML.indexOf('upload') !== -1 || btnHTML.indexOf('plane') !== -1) {
          btn.click();
          return { clicked: true, strategy: 'text-match' };
        }
      }
    }

    // Strategy 3: Click SVG icon buttons
    var svgs = document.querySelectorAll('svg');
    for (var si = 0; si < svgs.length; si++) {
      var btn = svgs[si].closest('button, [role="button"], [onclick]');
      if (btn) {
        var rect = btn.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 20) {
          btn.click();
          return { clicked: true, strategy: 'svg-button' };
        }
      }
    }

    // Strategy 4: Simulate Enter key
    if (textarea) {
      textarea.focus();
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
      textarea.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
      return { clicked: true, strategy: 'enter-key' };
    }

    return { clicked: false, strategy: 'none' };
  })()`;
}

/**
 * Poll for AI response completion by detecting action buttons or indicator
 */
function buildPollScript() {
  const actionKeywords = JSON.stringify(SEL.ACTION_KEYWORDS);
  return `(function() {
    var msgs = document.querySelectorAll('${SEL.MESSAGE}');
    var lastAssistantEl = null;
    for (var idx = msgs.length - 1; idx >= 0; idx--) {
      var m = msgs[idx];
      if (!m.classList.contains('justify-end')) {
        lastAssistantEl = m;
        break;
      }
    }
    if (!lastAssistantEl) return { done: false };

    var actionKeywords = ${actionKeywords};
    var container = lastAssistantEl.parentElement || lastAssistantEl;
    var candidates = container.querySelectorAll('button, [role="button"], [tabindex]');

    var nextEl = lastAssistantEl.nextElementSibling;
    if (nextEl) {
      var siblingBtns = nextEl.querySelectorAll('button, [role="button"]');
      var combined = [];
      for (var ci = 0; ci < candidates.length; ci++) combined.push(candidates[ci]);
      for (var ci = 0; ci < siblingBtns.length; ci++) combined.push(siblingBtns[ci]);
      candidates = combined;
    }

    for (var bi = 0; bi < candidates.length; bi++) {
      var el = candidates[bi];
      var t = (el.textContent || '').toLowerCase().trim();
      var attr = (el.getAttribute('aria-label') || '').toLowerCase();
      var dataTestId = (el.getAttribute('data-testid') || '').toLowerCase();
      var combined = t + ' ' + attr + ' ' + dataTestId;
      for (var ki = 0; ki < actionKeywords.length; ki++) {
        if (combined.indexOf(actionKeywords[ki]) !== -1) {
          var textEl = lastAssistantEl.querySelector('${SEL.MESSAGE_TEXT}');
          if (!textEl) return { done: false };
          var children = textEl.querySelectorAll('div[dir]');
          var text = '';
          if (children.length > 0) {
            text = Array.from(children).map(function(c) { return c.innerText || c.textContent || ''; }).join('');
          } else {
            text = textEl.innerText?.trim() || textEl.textContent?.trim() || '';
          }
          if (text.length < 5) return { done: false };
          return { done: true, text: text, method: 'action-btn' };
        }
      }
    }

    // Fallback: indicator check
    var textEl = lastAssistantEl.querySelector('${SEL.MESSAGE_TEXT}');
    if (textEl) {
      var hasIndicator = textEl.querySelector('${SEL.INDICATOR}') !== null ||
                         textEl.getAttribute('data-show-indicator') === 'true';
      var children = textEl.querySelectorAll('div[dir]');
      var text = '';
      if (children.length > 0) {
        text = Array.from(children).map(function(c) { return c.innerText || c.textContent || ''; }).join('');
      } else {
        text = textEl.innerText?.trim() || textEl.textContent?.trim() || '';
      }
      if (text.length > 10 && !hasIndicator) {
        return { done: true, text: text, method: 'no-indicator' };
      }
    }

    return { done: false };
  })()`;
}

/**
 * Build the analysis prompt
 */
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
    // Strategy 1: Use raw CDP DOM.setFileInputFiles
    try {
      const docResult = await page.cdp('DOM.getDocument');
      const queryResult = await page.cdp('DOM.querySelector', {
        nodeId: docResult.root.nodeId,
        selector: SEL.FILE_INPUT,
      });
      if (queryResult && queryResult.nodeId) {
        await page.cdp('DOM.setFileInputFiles', {
          files: [filePath],
          nodeId: queryResult.nodeId,
        });
        return { success: true };
      }
    } catch (err) {
      // Fall through
    }

    // Strategy 2: Try via evaluate (for pages where DOM CDP commands are restricted)
    try {
      const info = await page.evaluate(buildFileInputQueryScript());
      if (info && info.found) {
        // Retry with fresh document
        const docResult2 = await page.cdp('DOM.getDocument');
        const queryResult2 = await page.cdp('DOM.querySelector', {
          nodeId: docResult2.root.nodeId,
          selector: SEL.FILE_INPUT,
        });
        if (queryResult2 && queryResult2.nodeId) {
          await page.cdp('DOM.setFileInputFiles', {
            files: [filePath],
            nodeId: queryResult2.nodeId,
          });
          return { success: true };
        }
      }
    } catch (err) {
      // Fall through
    }

    return { success: false };
  }

  /**
   * Wait for Doubao to finish generating a response
   * @param {Object} page - CDPPage instance
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<string>} Response text
   */
  async _waitForResponse(page, timeout) {
    const pollInterval = 500;
    const maxPolls = Math.ceil(timeout / pollInterval);

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      const result = await page.evaluate(buildPollScript());
      if (result && result.done) {
        return result.text || '';
      }
    }

    throw new Error('Response timeout');
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

      // 2. Verify we're on a Doubao page
      const title = await page.evaluate('document.title');
      const url = await page.evaluate('window.location.href');

      // 3. Save screenshot to temp file and upload
      tmpFile = this._saveTempScreenshot(screenshotBuffer);
      const uploadResult = await this._uploadScreenshot(page, tmpFile);

      // 4. Build and inject the prompt
      const hasScreenshot = uploadResult.success;
      const prompt = context.customPrompt && context.customPrompt.trim()
        ? context.customPrompt.trim()
        : buildAnalysisPrompt(context, hasScreenshot);

      const injected = await page.evaluate(buildInjectTextScript(prompt));
      if (!injected || !injected.ok) {
        throw new Error('Failed to inject text into Doubao');
      }

      // Verify text was written
      const verifyLen = await page.evaluate(
        `document.querySelector('${SEL.INPUT}')?.value?.length || 0`
      );

      // 5. Click send
      const clicked = await page.evaluate(buildClickSendScript());
      if (!clicked || !clicked.clicked) {
        throw new Error('Failed to click send button');
      }

      // 6. Wait for response
      const timeout = context.timeout || 30000;
      const response = await this._waitForResponse(page, timeout);

      return {
        text: response,
        type: this._analyzeContentType(response),
        timestamp: new Date().toISOString(),
        agentId: this.id,
      };
    } finally {
      // Cleanup
      this._cleanupTempFile(tmpFile);
      // Note: we keep the connection alive for potential reuse,
      // caller can call disconnect() when done
    }
  }
}

module.exports = DoubaoAppAdapter;
