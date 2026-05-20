/**
 * Doubao CDP Client
 * 
 * Connects to Doubao App via Chrome DevTools Protocol
 * Sends analysis requests and retrieves responses
 */

const { WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Selectors for Doubao App UI (matching opencli doubao-app pattern)
const SEL = {
  MESSAGE: '[data-testid="message_content"]',
  MESSAGE_TEXT: '[data-testid="message_text_content"]',
  MESSAGE_INPUT: '[data-testid="message_input"]',
  INDICATOR: '[data-testid="indicator"]',
  INPUT: '[data-testid="chat_input_input"]',
  INPUT_CONTAINER: '[data-testid="chat_input"]',
  SEND_BTN: '[data-testid="chat_input_send_button"]',
  SEND_MESSAGE: '[data-testid="send_message"]',
  FILE_INPUT: 'input[type="file"]',
  UPLOAD_BUTTON: '[data-testid*="upload"], [data-testid*="image"], [data-testid*="file"], [data-testid*="attachment"]',
};

class DoubaoClient {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.ws = null;
    this.idCounter = 0;
    this.pending = new Map();
  }

  /**
   * Connect to Doubao App via CDP
   */
  async connect(timeout = 10000) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    let wsUrl = this.endpoint;
    
    // If HTTP endpoint, get WebSocket URL from /json
    if (this.endpoint.startsWith('http')) {
      const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/json`);
      const targets = await response.json();
      const target = targets.find(t => t.webSocketDebuggerUrl);
      
      if (!target) {
        throw new Error('No inspectable Doubao targets found. Make sure Doubao is launched with --remote-debugging-port=9225');
      }
      
      wsUrl = target.webSocketDebuggerUrl;
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP connection timeout'));
      }, timeout);

      ws.on('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });

      ws.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`CDP connection failed: ${error.message}`));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject, timer } = this.pending.get(msg.id);
            clearTimeout(timer);
            this.pending.delete(msg.id);
            
            if (msg.error) {
              reject(new Error(msg.error.message));
            } else {
              resolve(msg.result);
            }
          }
        } catch (error) {
          console.error('Failed to parse CDP message:', error);
        }
      });

      this.ws = ws;
    });
  }

  /**
   * Send CDP command
   */
  async send(method, params = {}, timeout = 10000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP connection is not open');
    }

    const id = ++this.idCounter;
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate JavaScript in Doubao
   */
  async evaluate(script) {
    const result = await this.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true
    });

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'Evaluation failed');
    }

    return result.result?.value;
  }

  /**
   * Inject text into chat input
   */
  async injectText(text) {
    const script = `(function(t) {
      const textarea = document.querySelector('${SEL.INPUT}');
      if (!textarea) return { ok: false, error: 'No textarea found' };
      textarea.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;
      if (setter) setter.call(textarea, t);
      else textarea.value = t;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })(${JSON.stringify(text)})`;

    return await this.evaluate(script);
  }

  /**
   * Click send button
   */
  async clickSend() {
    const script = `(function() {
      const textarea = document.querySelector('${SEL.INPUT}');
        
      // Strategy 1: Look for button near textarea (parent container)
      if (textarea) {
        const parent = textarea.closest('div');
        if (parent) {
          const container = parent.parentElement || parent;
          const allButtons = container.querySelectorAll('button, [role="button"]');
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
        
      // Strategy 2: Match button by text content
      var allButtons = document.querySelectorAll('button');
      for (var bi = 0; bi < allButtons.length; bi++) {
        var btn = allButtons[bi];
        var rect = btn.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 20 && !btn.disabled) {
          var btnText = (btn.textContent || '').toLowerCase();
          var btnHTML = btn.innerHTML.toLowerCase();
          if (btnText.includes('send') || btnText.includes('发送') ||
              btnHTML.includes('send') || btnHTML.includes('arrow') ||
              btnHTML.includes('upload') || btnHTML.includes('plane')) {
            btn.click();
            return { clicked: true, strategy: 'text-match' };
          }
        }
      }
        
      // Strategy 3: Look for SVG icon buttons
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
        
      // Strategy 4: Simulate Enter key on textarea
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
  
    return await this.evaluate(script);
  }

  /**
   * Wait for Doubao response using message count strategy
   */
  async waitForResponse(beforeCount, timeout = 30000) {
    const pollInterval = 1000;
    const maxPolls = Math.ceil(timeout / pollInterval);
    let lastTextLength = 0;
    let stableCount = 0;

    console.log(`[Debug] Waiting for response (baseline: ${beforeCount} messages)...`);

    for (let i = 0; i < maxPolls; i++) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const script = `(function(pollIdx) {
        const msgs = document.querySelectorAll('${SEL.MESSAGE}');
        
        // Find the last assistant message (non-user)
        var lastAssistantText = '';
        var hasIndicator = false;
        for (var idx = msgs.length - 1; idx >= 0; idx--) {
          var m = msgs[idx];
          if (!m.classList.contains('justify-end')) {
            var textEl = m.querySelector('${SEL.MESSAGE_TEXT}');
            if (textEl) {
              hasIndicator = textEl.querySelector('${SEL.INDICATOR}') !== null || textEl.getAttribute('data-show-indicator') === 'true';
              var children = textEl.querySelectorAll('div[dir]');
              if (children.length > 0) {
                lastAssistantText = Array.from(children).map(function(c) { return c.innerText || c.textContent || ''; }).join('');
              } else {
                lastAssistantText = textEl.innerText?.trim() || textEl.textContent?.trim() || '';
              }
            }
            break;
          }
        }
        
        var textLen = lastAssistantText.length;
        
        if (pollIdx % 5 === 0) {
          return { phase: textLen > 10 && !hasIndicator ? 'checking' : 'waiting', textLen: textLen, hasIndicator: hasIndicator, debug: 'lastAssistant len=' + textLen + ' indicator=' + hasIndicator };
        }
        
        if (textLen > 10 && !hasIndicator) {
          return { phase: 'checking', text: lastAssistantText, textLen: textLen, hasIndicator: false };
        }
        return { phase: 'waiting', text: null, textLen: textLen, hasIndicator: hasIndicator };
      })(${i})`;

      const result = await this.evaluate(script);
      
      if (i % 5 === 0) {
        console.log(`[Debug] Poll ${i}:`, result?.debug || `phase=${result?.phase} len=${result?.textLen}`);
      }
      
      // Stability check: text length unchanged for 3 seconds
      if (result?.textLen > 10 && !result?.hasIndicator) {
        if (result.textLen === lastTextLength) {
          stableCount++;
          if (stableCount >= 3) {
            console.log(`[Debug] Response stable for ${stableCount}s, extracting...`);
            return result.text || '';
          }
        } else {
          stableCount = 0;
        }
        lastTextLength = result.textLen;
      }
    }

    throw new Error('Response timeout');
  }

  /**
   * Get message count
   */
  async getMessageCount() {
    return await this.evaluate(`document.querySelectorAll('${SEL.MESSAGE}').length`);
  }

  /**
   * Upload an image file to Doubao via CDP
   * @param {string} filePath - Absolute path to the image file
   * @returns {Promise<Object>} Upload result
   */
  async uploadImage(filePath) {
    console.log('Uploading image to Doubao via CDP...');

    // Strategy 1: Use DOM.setFileInputFiles on <input type="file">
    try {
      const docResult = await this.send('DOM.getDocument');
      const queryResult = await this.send('DOM.querySelector', {
        nodeId: docResult.root.nodeId,
        selector: SEL.FILE_INPUT
      });

      if (queryResult && queryResult.nodeId) {
        await this.send('DOM.setFileInputFiles', {
          files: [filePath],
          nodeId: queryResult.nodeId
        });
        console.log('File set via DOM.setFileInputFiles');

        // Trigger events to notify the React app
        await this.evaluate(`(function() {
          var inputs = document.querySelectorAll('input[type="file"]');
          for (var i = 0; i < inputs.length; i++) {
            inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
            inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          }
          return { count: inputs.length };
        })()`);

        // Wait for upload to process
        console.log('Waiting for upload to complete...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        return { success: true, method: 'setFileInputFiles' };
      } else {
        console.log('No file input element found, trying alternative approach...');
      }
    } catch (err) {
      console.warn('DOM.setFileInputFiles approach failed:', err.message);
    }

    // Strategy 2: Try finding file input via JavaScript query
    try {
      const fileInputInfo = await this.evaluate(`(function() {
        var result = { found: false, details: [] };

        // Check all input[type=file]
        var fileInputs = document.querySelectorAll('input[type="file"]');
        fileInputs.forEach(function(inp, i) {
          result.details.push({ type: 'input', idx: i, id: inp.id, className: inp.className });
          result.found = true;
        });

        // Check for buttons with upload-related attributes
        var uploadSelectors = ['[data-testid*="upload"]', '[data-testid*="image"]', '[data-testid*="file"]', '[data-testid*="attachment"]'];
        uploadSelectors.forEach(function(sel) {
          var els = document.querySelectorAll(sel);
          if (els.length > 0) {
            result.details.push({ type: 'upload-btn', selector: sel, count: els.length });
          }
        });

        return result;
      })()`);

      console.log('File input search result:', JSON.stringify(fileInputInfo));

      // If we found file inputs but DOM.setFileInputFiles didn't work,
      // try getting them again after the doc might have changed
      if (fileInputInfo && fileInputInfo.found) {
        // Retry with fresh document
        const docResult2 = await this.send('DOM.getDocument');
        const queryResult2 = await this.send('DOM.querySelector', {
          nodeId: docResult2.root.nodeId,
          selector: SEL.FILE_INPUT
        });
        if (queryResult2 && queryResult2.nodeId) {
          await this.send('DOM.setFileInputFiles', {
            files: [filePath],
            nodeId: queryResult2.nodeId
          });
          console.log('File set via retry DOM.setFileInputFiles');
          await new Promise(resolve => setTimeout(resolve, 3000));
          return { success: true, method: 'setFileInputFiles-retry' };
        }
      }
    } catch (err) {
      console.warn('Alternative upload approach failed:', err.message);
    }

    return { success: false, method: 'none' };
  }

  /**
   * Close connection
   */
  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

/**
 * Analyze screenshot with Doubao
 * @param {Buffer} screenshotBuffer - Screenshot data (PNG buffer)
 * @param {Object} context - Context information
 * @returns {Promise<Object>} Analysis result
 */
async function analyzeWithDoubao(screenshotBuffer, context = {}) {
  const endpoint = process.env.OPENCLI_CDP_ENDPOINT || 'http://127.0.0.1:9225';
  const client = new DoubaoClient(endpoint);
  let tmpFile = null;

  try {
    // Connect to Doubao
    await client.connect();
    console.log('Connected to Doubao App');

    // Get page title to verify connection
    const title = await client.evaluate('document.title');
    const url = await client.evaluate('window.location.href');
    console.log('Doubao page title:', title);
    console.log('Doubao page URL:', url);

    // Save screenshot to temp file for CDP upload
    tmpFile = path.join(os.tmpdir(), `opencli-screenshot-${Date.now()}.png`);
    fs.writeFileSync(tmpFile, screenshotBuffer);
    console.log('Screenshot saved to temp file:', tmpFile, `(${screenshotBuffer.length} bytes)`);

    // Upload the screenshot image to Doubao chat input
    console.log('Uploading screenshot to Doubao...');
    const uploadResult = await client.uploadImage(tmpFile);
    console.log('Upload result:', JSON.stringify(uploadResult));

    if (!uploadResult.success) {
      console.warn('Screenshot upload may not have succeeded, continuing anyway...');
    }

    // Build analysis prompt (screenshot is now embedded in chat)
    const prompt = buildAnalysisPrompt(context, uploadResult.success);
    console.log('Prompt:', prompt.substring(0, 100) + '...');

    // Inject text prompt
    const injected = await client.injectText(prompt);
    console.log('Text injected:', injected);
    if (!injected?.ok) {
      throw new Error('Failed to inject text into Doubao');
    }

    // Verify text was actually written to the input
    const verifyText = await client.evaluate(`document.querySelector('${SEL.INPUT}')?.value?.length || 0`);
    console.log('Input text length after inject:', verifyText);

    await new Promise(resolve => setTimeout(resolve, 800));

    const clicked = await client.clickSend();
    console.log('Send clicked:', clicked);
    if (!clicked?.clicked) {
      throw new Error('Failed to click send button');
    }

    // Debug: check message count after send
    await new Promise(resolve => setTimeout(resolve, 1500));
    const postDebug = await client.evaluate(`(function() {
      var msgs = document.querySelectorAll('${SEL.MESSAGE}');
      var info = { total: msgs.length, userCount: 0, msgs: [] };
      msgs.forEach(function(m, i) {
        var isUser = m.classList.contains('justify-end');
        if (isUser) info.userCount++;
        var textEl = m.querySelector('${SEL.MESSAGE_TEXT}');
        var hasIndicator = textEl ? (textEl.querySelector('${SEL.INDICATOR}') !== null || textEl.getAttribute('data-show-indicator') === 'true') : false;
        var textLen = textEl ? (textEl.innerText || textEl.textContent || '').length : 0;
        info.msgs.push({ idx: i, isUser: isUser, hasIndicator: hasIndicator, textLen: textLen });
      });
      return info;
    })()`);
    console.log('After send debug:', JSON.stringify(postDebug));

    console.log('Waiting for Doubao response (timeout: ' + (context.timeout || 30000) + 'ms)...');

    // Wait for response
    const timeout = context.timeout || 30000;
    const response = await client.waitForResponse(0, timeout);

    console.log('Doubao response received:', response?.substring(0, 100) + '...');

    return {
      text: response,
      type: analyzeContentType(response),
      timestamp: new Date().toISOString(),
      context: context
    };

  } finally {
    // Clean up temp file
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore cleanup errors */ }
    }
    client.close();
  }
}

/**
 * Build analysis prompt
 * @param {Object} context - Context information
 * @param {boolean} hasScreenshot - Whether a screenshot was successfully uploaded
 */
function buildAnalysisPrompt(context, hasScreenshot = true) {
  const screenshotNote = hasScreenshot
    ? '我发送了一张屏幕截图，请分析截图中的内容'
    : '请分析当前屏幕内容（截图上传可能未成功，如能看到请分析）';

  return `${screenshotNote}，并提供智能补全建议。

${context.appName && context.appName !== 'Unknown' ? `当前应用: ${context.appName}` : ''}

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

/**
 * Analyze content type (code vs document)
 */
function analyzeContentType(text) {
  const codePatterns = /```[\s\S]*?```|function\s+\w+|class\s+\w+|import\s+|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|def\s+\w+|public\s+class|private\s+void/;
  
  if (codePatterns.test(text)) {
    return 'code';
  }
  
  return 'document';
}

module.exports = {
  DoubaoClient,
  analyzeWithDoubao,
  analyzeContentType,
};
