/**
 * DoubaoAppAdapter - AI Agent for Doubao Desktop App
 *
 * Captures AI responses by polling the DOM for new text content.
 * Uses asr_btn presence as the completion signal.
 *
 * Note: Network.eventSourceMessageReceived CDP event is NOT used
 * because Doubao uses `fetch()` with a streaming response body
 * (not the EventSource API), so Chrome never fires that event.
 */

const path = require('path');
const http = require('http');
const BaseAgent = require('../base-agent');

// Dev-mode only logging: [DoubaoAdapter] logs only print with --dev flag
const isDev = process.argv.includes('--dev');
function debugLog(...args) {
  if (isDev) console.log('[DoubaoAdapter]', ...args);
}

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
   * Find a Doubao chat page by positive DOM verification.
   *
   * Fetches all CDP targets, connects to each candidate (page/webview/app
   * type with a WebSocket URL), and checks for the chat input element.
   * Keeps the connection to the first verified chat page found.
   *
   * Replaces the old exclusion-based approach (which required updating
   * whenever Doubao added new internal page types like doubao-text-picker).
   *
   * @returns {Promise<Object>} CDPPage connected to the verified chat page
   */
  async _findOrVerifyChatPage() {
    // 1. Fetch all CDP targets
    let targets;
    try {
      targets = await _fetchTargets(this.endpoint);
    } catch (err) {
      throw new Error(
        `无法连接到豆包桌面端（${this.endpoint}）。` +
        `请确认豆包已启动并开启了远程调试端口。`
      );
    }

    if (!targets || targets.length === 0) {
      throw new Error('豆包桌面端未返回任何页面目标，请确认豆包已启动。');
    }

    // 2. Filter candidates: must have wsUrl + be a DOM-bearing type
    const candidates = targets.filter((t) =>
      t.webSocketDebuggerUrl &&
      (t.type === 'page' || t.type === 'webview' || t.type === 'app')
    );

    if (candidates.length === 0) {
      const types = [...new Set(targets.map((t) => t.type))].join(', ');
      debugLog('_findOrVerifyChatPage: no candidates. Available types:', types);
      throw new Error(
        '未找到可用的豆包页面目标。请打开豆包聊天页面后重试。' +
        `（当前可用目标类型: ${types}）`
      );
    }

    debugLog('_findOrVerifyChatPage: scanning', candidates.length, 'candidates');

    // 3. Probe each candidate: find chat pages, prefer the focused one
    const { CDPBridge } = await this._getOpencliCdp();
    let firstMatch = null;     // page of the first chat page (fallback)
    let firstBridge = null;    // bridge of the first chat page (fallback)

    for (const t of candidates) {
      let bridge = null;
      try {
        bridge = new CDPBridge();
        const page = await bridge.connect({ cdpEndpoint: t.webSocketDebuggerUrl });
        const hasInput = await page.evaluate(
          `document.querySelector('${SEL.INPUT}') !== null`,
        );
        if (!hasInput) {
          try { bridge.close(); } catch (_) { /* ignore */ }
          continue;
        }

        // Found a chat page — check if it has focus (currently active conversation)
        const hasFocus = await page.evaluate('document.hasFocus()');
        debugLog('_findOrVerifyChatPage: found chat page —', t.url, 'focused:', hasFocus);

        if (hasFocus) {
          // Active conversation found — close fallback connection if different
          if (firstBridge && firstBridge !== bridge) {
            try { firstBridge.close(); } catch (_) { /* ignore */ }
          }
          this._bridge = bridge;
          this._page = page;
          debugLog('_findOrVerifyChatPage: using focused chat page');
          return page;
        }

        // Save first non-focused match as fallback
        if (!firstMatch) {
          firstMatch = page;
          firstBridge = bridge;
        } else {
          try { bridge.close(); } catch (_) { /* ignore */ }
        }
      } catch (e) {
        debugLog('_findOrVerifyChatPage: probe failed for', t.url, '—', e.message);
        if (bridge) {
          try { bridge.close(); } catch (_) { /* ignore */ }
        }
      }
    }

    // 4. No focused page found — use the first chat page as fallback
    if (firstMatch) {
      this._bridge = firstBridge;
      this._page = firstMatch;
      debugLog('_findOrVerifyChatPage: no focused page found, using first match');
      return firstMatch;
    }

    // 5. None matched
    throw new Error(
      '无法找到豆包聊天页面。请确保豆包桌面端已打开且处于聊天页面。' +
      `（共检查 ${candidates.length} 个目标，均未包含聊天输入框）`
    );
  }

  /**
   * Upload a screenshot file to Doubao chat via CDP
   * @param {Object} page - CDPPage instance
   * @param {string} filePath - Absolute path to the screenshot file
   * @returns {Promise<{success: boolean}>}
   */
  async _uploadScreenshot(page, filePath) {
    // Step 1: Ensure the file input element is rendered in the DOM.
    // After restart, the chat input area's lazy components (including the
    // file input) may not be initialized until the user interacts with the
    // page. We try progressively stronger triggers:
    //   1a. JS-level focus + dispatchEvent (may not wake React lazy loading)
    //   1b. CDP-level mouse click + keystroke (real hardware-level events)
    try {
      const hasFileInput = await page.evaluate(
        `document.querySelector('${FILE_INPUT}') !== null`,
      );
      if (!hasFileInput) {
        debugLog('_uploadScreenshot: file input not found, triggering chat area...');
        // 1a. JS-level trigger
        await page.evaluate(`(function() {
          const input = document.querySelector('${SEL.INPUT}');
          if (input) {
            input.focus();
            input.dispatchEvent(new Event('focus', { bubbles: true }));
            input.dispatchEvent(new Event('click', { bubbles: true }));
          }
          return !!input;
        })()`);
        await new Promise(r => setTimeout(r, 500));

        // 1b. If still missing, use CDP Input commands for real mouse+keyboard
        const stillMissing = await page.evaluate(
          `document.querySelector('${FILE_INPUT}') === null`,
        );
        if (stillMissing) {
          debugLog('_uploadScreenshot: JS trigger insufficient, trying CDP Input events...');
          try {
            // Get input element bounding box for CDP mouse click
            const rect = await page.evaluate(`(function() {
              var el = document.querySelector('${SEL.INPUT}');
              if (!el) return null;
              var r = el.getBoundingClientRect();
              return { x: r.x, y: r.y, w: r.width, h: r.height };
            })()`);
            if (rect && rect.w > 0 && rect.h > 0) {
              var cx = Math.round(rect.x + rect.w / 2);
              var cy = Math.round(rect.y + rect.h / 2);
              // Real mouse click at center of input
              await page.cdp('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
              });
              await page.cdp('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
              });
              await new Promise(r => setTimeout(r, 200));
              // Type Space then Backspace to trigger React state change
              await page.cdp('Input.dispatchKeyEvent', {
                type: 'keyDown', windowsVirtualKeyCode: 32, key: ' ',
              });
              await page.cdp('Input.dispatchKeyEvent', {
                type: 'keyUp', windowsVirtualKeyCode: 32, key: ' ',
              });
              await page.cdp('Input.dispatchKeyEvent', {
                type: 'keyDown', windowsVirtualKeyCode: 8, key: 'Backspace',
              });
              await page.cdp('Input.dispatchKeyEvent', {
                type: 'keyUp', windowsVirtualKeyCode: 8, key: 'Backspace',
              });
              // Wait for React lazy components to mount
              await new Promise(r => setTimeout(r, 1500));
            }
          } catch (e2) {
            debugLog('_uploadScreenshot: CDP Input trigger failed:', e2.message);
          }
        }
      }
    } catch (e) {
      debugLog('_uploadScreenshot: pre-check failed:', e.message);
    }

    // Step 2: Upload file via CDP DOM API
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
        debugLog('_uploadScreenshot: success');
        return { success: true };
      }
      debugLog('_uploadScreenshot: file input node not found in DOM');
    } catch (err) {
      debugLog('_uploadScreenshot: CDP upload failed:', err.message);
    }
    return { success: false };
  }

  /**
   * Poll the DOM to confirm the content was actually sent.
   * Checks three signals:
   *   1. Break button visible → generation started → content sent
   *   2. asr_btn removed → generation in progress → content sent
   *   3. Textarea value/textContent cleared → content was dispatched
   *
   * Polls every 100ms for up to 3 seconds.
   *
   * @param {Object} page - CDPPage instance
   * @returns {Promise<boolean>} true if send was confirmed
   */
  async _waitSendConfirm(page) {
    for (let i = 0; i < 30; i++) {  // up to 3 seconds (30 × 100ms)
      const result = await page.evaluate(`(function() {
        // 1. Break button visible → generation started → content sent
        if (document.querySelector('[data-testid="chat_input_local_break_button"]')) return 'sent:break';
        // 2. asr_btn removed → generation in progress → content sent
        if (!document.querySelector('[data-testid="asr_btn"]')) return 'sent:no_asr';
        // 3. Textarea content cleared → content was dispatched
        var input = document.querySelector('${SEL.INPUT}');
        if (input && !input.value && !input.textContent) return 'sent:empty';
        return 'pending:' + (input ? (input.value||'').length + ',' + (input.textContent||'').length : 'no_input');
      })()`);
      if (result.startsWith('sent')) {
        debugLog('_waitSendConfirm: confirmed (' + result + ') at iteration ' + i);
        return true;
      }
      if (i % 10 === 0) debugLog('_waitSendConfirm: iter ' + i + ' state=' + result);
      await new Promise(r => setTimeout(r, 100));
    }
    debugLog('_waitSendConfirm: timeout after 3s, content may not have been sent');
    return false;
  }

  // ===================================================================
  //  DOM POLL MODE — asr_btn-based polling (primary capture method)

  /**
   * Fast poll script — returns current state of Doubao's chat page.
   *
   * Completion signal:
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
   * Poll Doubao's DOM until the response is ready.
   *
   * Strategy:
   * - 200ms polling interval
   * - Primary completion: asr_btn reappears (voice button)
   * - Fallback: idle timeout (no output change for 1.5s)
   * - Safety limit: user-configured timeout
   *
   * When onChunk is provided, emits incremental text as new content
   * appears in the DOM for streaming output to the user's editor.
   *
   * @param {Object} page - CDPPage instance
   * @param {string} beforeLastText - assistant text BEFORE sending
   * @param {number} timeout - max wait time in ms
   * @param {Function} [onChunk] - callback(text) called for each text increment
   * @param {AbortSignal} [signal] - optional AbortSignal for cancellation
   * @returns {Promise<string>} Response text
   */
  async _pollDomResponse(page, beforeLastText, timeout, onChunk, signal) {
    debugLog('_pollDomResponse: timeout=' + timeout + ' beforeLastTextLen=' + (beforeLastText || '').length);
    const POLL_MS = 200;
    const IDLE_TIMEOUT_MS = Math.min(1500, Math.floor(timeout / 3));

    let lastText = beforeLastText;
    let lastEmittedText = beforeLastText;
    let idleMs = 0;
    let totalMs = 0;
    let hasNewText = false;
    let seenNewMessage = false;

    while (totalMs < timeout) {
      // Check for cancellation
      if (signal && signal.aborted) {
        debugLog('DOM poll cancelled by signal, returning partial text');
        return lastText || '';
      }

      await sleep(POLL_MS / 1000);
      totalMs += POLL_MS;

      let result;
      try {
        result = await page.evaluate(
          this._buildFastPollScript(beforeLastText),
        );
      } catch (evaluateError) {
        debugLog('DOM poll evaluate failed:', evaluateError.message);
        // If the connection was lost and we already have text, return it
        if (hasNewText && lastText) {
          debugLog('Connection lost, returning partial text:', lastText.length, 'chars');
          return lastText;
        }
        // If we have no text at all, let the outer timeout handle it
        if (totalMs >= timeout * 0.5) {
          throw new Error('豆包连接已断开，无法获取回复。请确认豆包窗口已打开。');
        }
        continue; // Transient error, retry
      }

      if (!result) continue;

      // --- Detect new text → reset idle timer ---
      if (result.text && result.text !== lastText) {
        // First detection of the new assistant message: reset emitted cursor
        // so incremental slice starts from beginning of new message.
        if (!seenNewMessage) {
          lastEmittedText = '';
          seenNewMessage = true;
        }

        lastText = result.text;
        idleMs = 0;
        hasNewText = true;

        // Emit incremental text for streaming output
        if (onChunk && lastText !== lastEmittedText) {
          const incremental = lastText.slice(lastEmittedText.length);
          if (incremental) {
            debugLog('DOM poll onChunk, incremental length:', incremental.length);
            onChunk(incremental);
            lastEmittedText = lastText;
          }
        }
      } else {
        idleMs += POLL_MS;
      }

      // --- PRIMARY COMPLETION: asr_btn reappeared → generation done ---
      if (hasNewText && result.text && result.hasAsrBtn) {
        return result.text;
      }

      // --- FALLBACK: idle timeout → no new output for a while ---
      if (hasNewText && idleMs >= IDLE_TIMEOUT_MS) {
        return result.text || '';
      }
    }

    throw new Error(`豆包未在 ${timeout / 1000} 秒内返回回复`);
  }

  // ===================================================================
  //  SSE FETCH MODE — CDP Network-domain interception
  // ===================================================================

  /**
   * Convert a CDP body string to proper UTF-8.
   *
   * Chrome's CDP encodes body bytes using a mix of:
   *   - Latin-1 (chars ≤ 0xFF): bytes 0x00-0xFF → U+0000-U+00FF
   *   - Windows-1252: bytes 0x80-0x9F → specific Unicode chars > 0xFF
   *     (e.g. byte 0x88 → U+02C6, byte 0x85 → U+2026)
   *
   * This reverses the encoding: Windows-1252 chars are mapped back to
   * their original bytes, then the full byte sequence is UTF-8 decoded.
   */
  _cdpBodyToUtf8(str) {
    if (!str) return '';

    // Windows-1252 → byte reverse map (0x80-0x9F range)
    const WS2_BYTE = {
      '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84,
      '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88,
      '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C,
      '\u017D': 0x8E,
      '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93, '\u201D': 0x94,
      '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97, '\u02DC': 0x98,
      '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B, '\u0153': 0x9C,
      '\u017E': 0x9E, '\u0178': 0x9F,
    };

    const byteBuf = [];
    for (const ch of str) {
      const code = ch.charCodeAt(0);
      if (code <= 0x7F) {
        // ASCII: pass through as byte value
        byteBuf.push(code);
      } else if (code <= 0xFF) {
        // Latin-1 high byte (0xA0-0xFF): pass through as byte value
        byteBuf.push(code);
      } else {
        // Windows-1252 mapped char: reverse to original byte
        const b = WS2_BYTE[ch];
        if (b !== undefined) {
          byteBuf.push(b);
        }
        // else: unexpected char, skip
      }
    }
    return Buffer.from(byteBuf).toString('utf-8');
  }

  /**
   * Parse SSE response body into accumulated full text.
   *
   * Doubao uses a custom SSE protocol with these event types:
   *   SSE_HEARTBEAT         : keep-alive ping
   *   SSE_ACK               : server acknowledgement
   *   FULL_MSG_NOTIFY       : user message echo
   *   STREAM_MSG_NOTIFY     : first block of AI streaming response
   *   CHUNK_DELTA           : text delta — partial AI response text
   *   SSE_REPLY_END (type=1): message done (stops generation)
   *   SSE_REPLY_END (type=2): answer done
   *   SSE_REPLY_END (type=3): final end signal → completion
   *
   * @param {string} body - raw SSE response body text
   * @returns {{ text: string, isComplete: boolean }}
   */
  _parseSSEResponseBody(body) {
    let fullText = '';
    let isComplete = false;

    if (!body) return { text: '', isComplete: false };

    const events = body.split('\n\n');
    for (const rawEvent of events) {
      const lines = rawEvent.split('\n');
      let eventType = '';
      let dataStr = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataStr = line.slice(5).trim();
        }
      }

      if (!eventType || !dataStr) continue;

      try {
        const data = JSON.parse(dataStr);

        switch (eventType) {
          case 'CHUNK_DELTA':
            if (data && typeof data.text === 'string') {
              fullText += data.text;
            }
            break;

          case 'STREAM_MSG_NOTIFY': {
            const blocks = data?.content?.content_block;
            if (Array.isArray(blocks)) {
              for (const block of blocks) {
                const t = block?.content?.text_block?.text;
                if (typeof t === 'string') fullText += t;
              }
            }
            break;
          }

          case 'SSE_REPLY_END':
            if (data?.end_type === 3) {
              // Final end — stop here, discard trailing brief/events
              isComplete = true;
              return { text: fullText.trim(), isComplete: true };
            }
            if (data?.end_type === 1) {
              const brief = data?.msg_finish_attr?.brief;
              if (typeof brief === 'string' && brief) {
                fullText += brief;
              }
            }
            break;

          default:
            // SSE_HEARTBEAT, SSE_ACK, FULL_MSG_NOTIFY — ignore
            break;
        }
      } catch (_) {
        // Skip unparseable events
      }
    }

    return { text: fullText.trim(), isComplete: false };
  }

  /**
   * Capture AI response via injected fetch interceptor.
   *
   * Injects a script into the Doubao page that monkey-patches window.fetch to
   * intercept the /chat/completion SSE response. The script clones and reads
   * the streaming response body, extracts text chunks from SSE events in
   * real-time, and sends them back via console.debug('__SSE_TEXT__', text).
   *
   * This achieves true streaming — text arrives as Doubao generates it,
   * rather than waiting for the entire Network.loadingFinished body.
   *
   * CRITICAL: Call this BEFORE clicking send. The interceptor must be
   * installed before the fetch request is made.
   *
   * @param {Object} bridge  - CDPBridge instance
   * @param {number} timeout - max wait time in ms
   * @param {Function} [onChunk] - streaming callback (null = full mode)
   * @param {AbortSignal} [signal] - optional AbortSignal for cancellation
   * @returns {Promise<string>} Full response text
   */
  async _captureSSEResponse(bridge, timeout, onChunk, signal) {
    let fullText = '';
    let done = false;
    let cleanupDone = false;

    const cleanup = async () => {
      if (cleanupDone) return;
      cleanupDone = true;
      try { await bridge.send('Runtime.disable'); } catch (_) { /* ignore */ }
      bridge.off('Runtime.consoleAPICalled', onConsole);
    };

    let resolveCapture, rejectCapture;
    const capturePromise = new Promise((resolve, reject) => {
      resolveCapture = resolve;
      rejectCapture = reject;
    });

    const onConsole = (event) => {
      if (event.type !== 'debug') return;
      const args = event.args || [];
      if (args.length < 2) return;
      const tag = args[0]?.value;
      const text = args[1]?.value;

      if (tag === '__SSE_TEXT__' && typeof text === 'string') {
        // Sequence number (3rd arg) distinguishes new wrapper from old.
        // Old wrapper fires __SSE_TEXT__ without seq — we skip those
        // to avoid duplicates during the transition period.
        const seq = args[2]?.value;
        if (typeof seq !== 'number') return;
        //debugLog('SSE chunk:', JSON.stringify(text));
        fullText += text;
        if (onChunk) onChunk(text);
      } else if (tag === '__SSE_RAW__' && typeof text === 'string') {
        //debugLog('SSE raw event:', text);
      } else if (tag === '__SSE_EVENT__' && typeof text === 'string') {
        //debugLog('SSE parsed:', text);
      } else if (tag === '__SSE_DONE__') {
        if (!done) {
          done = true;
          cleanup().then(() => resolveCapture(fullText));
        }
      } else if (tag === '__SSE_ERR__') {
        if (!done) {
          done = true;
          cleanup().then(() => resolveCapture(fullText));
        }
      }
    };

    // Enable Runtime domain for console.debug interception
    debugLog('Runtime.enable + inject fetch interceptor');
    await bridge.send('Runtime.enable');
    bridge.on('Runtime.consoleAPICalled', onConsole);

    // Inject fetch interceptor — clones SSE response, reads stream,
    // extracts text from CHUNK_DELTA / STREAM_MSG_NOTIFY events,
    // sends chunks via console.debug('__SSE_TEXT__', text)
    // Refactored injectScript: _proc stored as window.__sseProc, updated
    // on every call. Fetch wrapper installed only once. STREAM_CHUNK
    // events are now handled (they carry text like "氏" that CHUNK_DELTA
    // may miss). A sequence counter on __SSE_TEXT__ deduplicates output
    // when an old wrapper is still in the chain (transition period).
    const injectScript = `(function(){
// === ALWAYS update _proc (takes effect immediately) ===
window.__sseProc=function _proc(raw){
var DEV=${isDev};
if(DEV)console.debug('__SSE_RAW__',raw.substring(0,300));
var lines=raw.split('\\n');
var et='',ed='';
for(var i=0;i<lines.length;i++){
var l=lines[i];
if(l.indexOf('event:')===0)et=l.slice(6).trim();
else if(l.indexOf('data:')===0)ed=l.slice(5).trim();
}
if(!et&&!ed){if(DEV)console.debug('__SSE_EVENT__','skip: no event, no data');return;}
if(!et){if(DEV)console.debug('__SSE_EVENT__','skip: no event type, data='+ed.substring(0,150));return;}
if(!ed){if(DEV)console.debug('__SSE_EVENT__','skip: no data, event='+et);return;}
if(DEV)console.debug('__SSE_EVENT__','event='+et+' data='+ed.substring(0,300));
try{
var d=JSON.parse(ed);
if(et==='CHUNK_DELTA'&&d.text){
if(!window.__sseTextSeq)window.__sseTextSeq=0;
console.debug('__SSE_TEXT__',d.text,++window.__sseTextSeq);
}else if(et==='STREAM_MSG_NOTIFY'&&d.content&&d.content.content_block){
var blocks=d.content.content_block;
for(var j=0;j<blocks.length;j++){
var t=blocks[j]&&blocks[j].content&&blocks[j].content.text_block&&blocks[j].content.text_block.text;
if(t){if(!window.__sseTextSeq)window.__sseTextSeq=0;console.debug('__SSE_TEXT__',t,++window.__sseTextSeq);}
}
}else if(et==='STREAM_CHUNK'&&d.patch_op){
for(var k=0;k<d.patch_op.length;k++){
var op=d.patch_op[k];
if(op.patch_object===1&&op.patch_value&&op.patch_value.content_block){
var cblocks=op.patch_value.content_block;
for(var m=0;m<cblocks.length;m++){
var ct=cblocks[m]&&cblocks[m].content&&cblocks[m].content.text_block&&cblocks[m].content.text_block.text;
if(ct){if(!window.__sseTextSeq)window.__sseTextSeq=0;console.debug('__SSE_TEXT__',ct,++window.__sseTextSeq);}
}
}
}
}
}catch(e){if(DEV)console.debug('__SSE_EVENT__','json_parse_fail:'+(e&&e.message));}
};
// === Only install the fetch wrapper once ===
if(window.__sseWrapperInstalled)return;
window.__sseWrapperInstalled=true;
var _orig=window.fetch;
window.fetch=async function(){
var response=await _orig.apply(this,arguments);
var url=typeof arguments[0]==='string'?arguments[0]:(arguments[0]&&arguments[0].url);
if(url&&url.indexOf('chat/completion')!==-1&&response.body){
var clone=response.clone();
var reader=clone.body.getReader();
var decoder=new TextDecoder('utf-8');
var buffer='';
(function pump(){
reader.read().then(function(r){
if(r.done){
if(buffer.trim()){
var events=buffer.split('\\n\\n');
for(var i=0;i<events.length;i++)window.__sseProc(events[i]);
}
console.debug('__SSE_DONE__','');
return;
}
buffer+=decoder.decode(r.value,{stream:true});
var parts=buffer.split('\\n\\n');
buffer=parts.pop();
for(var i=0;i<parts.length;i++)window.__sseProc(parts[i]);
pump();
}).catch(function(e){
console.debug('__SSE_ERR__',(e&&e.message)||'');
});
})();
}
return response;
};
})()`;

    await bridge.send('Runtime.evaluate', { expression: injectScript });

    // Timeout safety
    setTimeout(async () => {
      if (!done) {
        done = true;
        await cleanup();
        resolveCapture(fullText);
      }
    }, timeout);

    // Abort signal: user cancelled via overlay
    if (signal) {
      // Handle already-aborted signal (edge case)
      if (signal.aborted) {
        done = true;
        debugLog('SSE capture signal already aborted');
        await cleanup();
        resolveCapture(fullText);
        return capturePromise;
      }

      signal.addEventListener('abort', async () => {
        if (!done) {
          done = true;
          debugLog('SSE capture cancelled by signal, returning partial text');
          await cleanup();
          resolveCapture(fullText);
        }
      }, { once: true });
    }

    return capturePromise;
  }

  // ===================================================================
  //  Main analyze method — dispatches to selected mode
  // ===================================================================

  /**
   * Analyze a screenshot using Doubao.
   *
   * Supports two capture modes (responseMode):
   *   - "sse-fetch": CDP Fetch domain interception, works when window is hidden
   *   - "dom-poll":  DOM polling with asr_btn completion signal
   *
   * Output format controlled by context.onChunk:
   *   - onChunk provided: streaming output via incremental callbacks
   *   - onChunk omitted:  full text returned at once (used with pasteText)
   *
   * @param {Buffer} screenshotBuffer - PNG screenshot buffer
   * @param {Object} context - Analysis context
   * @param {number} [context.timeout] - Timeout in ms
   * @param {string} [context.responseMode] - "sse-fetch" or "dom-poll"
   * @param {string} [context.customPrompt] - Custom prompt override
   * @param {Function} [context.onChunk] - Callback(incrementalText) for streaming
   * @returns {Promise<Object>} Analysis result
   */
  async analyze(screenshotBuffer, context = {}) {
    let page = null;
    let tmpFile = null;

    try {
      // 0. Find and connect to a verified Doubao chat page (positive DOM check)
      page = await this._findOrVerifyChatPage();

      // 3. Wake up hidden/minimized renderer before any DOM interaction.
      //    After restart, the page's lazy components (incl. file input) only
      //    render when the page is active. Must bringToFront BEFORE upload.
      try {
        await page.cdp('Page.bringToFront');
        debugLog('bringToFront (wake) succeeded');
        await sleep(0.5);
      } catch (e) {
        debugLog('bringToFront (wake) failed:', e.message);
      }

      // 4. Save screenshot and upload
      tmpFile = this._saveTempScreenshot(screenshotBuffer);
      debugLog('analyze: uploading screenshot...');
      await this._uploadScreenshot(page, tmpFile);
      debugLog('analyze: screenshot upload done');

      // 5. Build the prompt
      const hasScreenshot = true;
      const prompt =
        context.customPrompt && context.customPrompt.trim()
          ? context.customPrompt.trim()
          : buildAnalysisPrompt(context, hasScreenshot);

      // 6. Use OpenCLI's utils for DOM interaction (injectText, clickSend)
      const { injectTextScript, clickSendScript } =
        await _getOpencliUtils();

      // 7. Capture the last assistant message text BEFORE sending (needed by DOM poll)
      let beforeLastText = '';
      try {
        beforeLastText = await page.evaluate(`(function() {
          const containers = document.querySelectorAll('${SEL.MESSAGE}');
          for (let i = containers.length - 1; i >= 0; i--) {
            if (containers[i].classList.contains('justify-end')) continue;
            const textEl = containers[i].querySelector('${SEL.MESSAGE_TEXT}');
            if (!textEl) return '';
            return textEl.innerText?.trim() || textEl.textContent?.trim() || '';
          }
          return '';
        })()`);
      } catch (e) {
        debugLog('Could not capture beforeLastText:', e.message);
        beforeLastText = '';
      }

      // 8. Inject text into chat input
      debugLog('analyze: injecting text...');
      const injected = await page.evaluate(injectTextScript(prompt));
      if (!injected || !injected.ok) {
        throw new Error('无法在豆包聊天输入框中输入文本');
      }
      debugLog('analyze: text injected, sleeping 0.5s...');

      await sleep(0.5);

      // 9. Determine capture mode and output options
      const signal = context.signal || null;
      const mode = context.responseMode || 'sse-fetch';
      const userTimeout = context.timeout || 30000;
      const onChunk = typeof context.onChunk === 'function' ? context.onChunk : null;
      debugLog('analyze: mode=' + mode + ' timeout=' + userTimeout + ' hasOnChunk=' + (onChunk !== null) + ' hasSignal=' + (signal !== null));

      let response;

      if (mode === 'sse-fetch') {
        // === SSE FETCH MODE ===
        // CRITICAL TIMING: start SSE interception BEFORE clicking send
        const bridge = this.getBridge();
        if (!bridge) {
          throw new Error('CDP bridge 不可用，无法使用 SSE Fetch 模式');
        }

        const ssePromise = this._captureSSEResponse(bridge, userTimeout, onChunk, signal);

        // Ensure page is active before clicking send (window may be minimized/hidden)
        try {
          await page.cdp('Page.bringToFront');
          await sleep(0.3);
        } catch (e) {
          debugLog('bringToFront before send failed:', e.message);
        }

        // Click send (trigger the request that SSE capture is waiting for)
        // CDP Enter is most reliable for textarea-based input
        debugLog('analyze: sending (sse-fetch mode)...');
        await page.pressKey('Enter');
        // Also try clicking the send button as backup
        await page.evaluate(clickSendScript());

        response = await ssePromise;

      } else {
        // === DOM POLL MODE ===
        // Ensure page is active before clicking send
        try {
          await page.cdp('Page.bringToFront');
          await sleep(0.3);
        } catch (e) {
          debugLog('bringToFront before send failed:', e.message);
        }

        // CDP Enter is most reliable for textarea-based input
        debugLog('analyze: sending (dom-poll mode)...');
        await page.pressKey('Enter');
        // Also try clicking the send button as backup
        await page.evaluate(clickSendScript());

        response = await this._pollDomResponse(
          page, beforeLastText, userTimeout, onChunk, signal,
        );
      }

      // ── If cancelled: stop the AI generation now that content was sent ──
      // stopGeneration() runs here instead of in the IPC handler because at this
      // point the content has been dispatched and the break button is visible.
      if (signal && signal.aborted) {
        debugLog('analyze: signal was aborted, stopping generation...');
        for (let retry = 0; retry < 3; retry++) {
          try {
            await this.stopGeneration();
          } catch (e) {
            debugLog('analyze: stopGeneration attempt ' + retry + ' failed:', e.message);
          }
          // Wait 0.5s then check if generation is still running
          await new Promise(r => setTimeout(r, 500));
          const stillRunning = await page.evaluate(`(function() {
            var btn = document.querySelector('[data-testid="chat_input_local_break_button"]');
            if (!btn) return false;
            var r = btn.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })()`);
          if (!stillRunning) {
            debugLog('analyze: generation stopped after attempt ' + retry);
            break;
          }
          debugLog('analyze: generation still running, retry ' + (retry + 1) + '...');
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

  /**
   * Stop Doubao's AI generation.
   *
   * Strategy (in order):
   *   1. Click the visible stop button via
   *      [data-testid="chat_input_local_break_button"] (current Doubao).
   *   2. Send Escape key via CDP (works if button is hidden).
   *   3. Find div#flow-end-msg-send.send-btn-wrapper.group.\!hidden
   *      and click its inner <button> (older Doubao versions).
   *   4. CDP-level mouse click on the button area (general fallback).
   *
   * @returns {Promise<boolean>} true if generation was stopped
   */
  async stopGeneration() {
    if (!this._page) {
      debugLog('stopGeneration: no CDP page connection available');
      return false;
    }
    try {
      // ── Pre-step: If content is still in the input, send it first ──
      // This handles the case where user cancels before analyze() has sent.
      // After confirming the content is sent, we proceed to stop generation.
      debugLog('stopGeneration: checking input content...');
      const inputState = await this._page.evaluate(`(function() {
        var input = document.querySelector('${SEL.INPUT}');
        if (!input) return JSON.stringify({ found: false });
        return JSON.stringify({
          found: true,
          valueLen: (input.value||'').length,
          textLen: (input.textContent||'').length,
          breakBtn: !!document.querySelector('[data-testid="chat_input_local_break_button"]'),
          asrBtn: !!document.querySelector('[data-testid="asr_btn"]'),
        });
      })()`);
      debugLog('stopGeneration: input state: ' + inputState);
      var parsed = JSON.parse(inputState);
      if (parsed.found && (parsed.valueLen > 0 || parsed.textLen > 0)) {
        debugLog('stopGeneration: content still in input (' + parsed.valueLen + '/' + parsed.textLen + ' chars), sending now...');
        try {
          // Bring page to front for reliable interaction
          debugLog('stopGeneration: bringToFront...');
          await this._page.cdp('Page.bringToFront');
          await new Promise(r => setTimeout(r, 200));
          // Focus the input element
          await this._page.evaluate(`(function() {
            var input = document.querySelector('${SEL.INPUT}');
            if (input) { input.focus(); input.dispatchEvent(new Event('focus', { bubbles: true })); }
          })()`);
          await new Promise(r => setTimeout(r, 100));
          // CDP Enter — most reliable for textarea-based send
          debugLog('stopGeneration: pressKey Enter...');
          await this._page.pressKey('Enter');
          // Also try clicking the send button as backup
          const { clickSendScript } = await _getOpencliUtils();
          debugLog('stopGeneration: clickSendScript...');
          await this._page.evaluate(clickSendScript());
          // Poll DOM to confirm content was actually sent
          debugLog('stopGeneration: waiting for send confirmation...');
          const confirmed = await this._waitSendConfirm(this._page);
          debugLog('stopGeneration: send confirmed=' + confirmed);
        } catch (e) {
          debugLog('stopGeneration: send pre-step failed:', e.message);
        }
      } else {
        debugLog('stopGeneration: no content in input, skipping send (breakBtn=' + parsed.breakBtn + ' asrBtn=' + parsed.asrBtn + ')');
      }

      // ── Attempt 1: Click the stop button ──
      // During generation, Doubao shows a visible div with
      // data-testid="chat_input_local_break_button" containing a stop icon.
      debugLog('stopGeneration: clicking break button...');
      const breakResult = await this._page.evaluate(`(function() {
        var btn = document.querySelector('[data-testid="chat_input_local_break_button"]');
        if (!btn) return { ok: false, reason: 'no break button' };
        // Ensure it's visible (has dimensions)
        var r = btn.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return { ok: false, reason: 'break button not visible' };
        btn.click();
        return { ok: true, method: 'break-btn' };
      })()`);
      if (breakResult && breakResult.ok) {
        debugLog('stopGeneration: stopped via break button');
        return true;
      }
      debugLog('stopGeneration: break button not available:', breakResult?.reason);

      // ── Attempt 2: Escape key via CDP ──
      debugLog('stopGeneration: sending Escape key...');
      await this._page.cdp('Input.dispatchKeyEvent', {
        type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape',
      });
      await this._page.cdp('Input.dispatchKeyEvent', {
        type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape',
      });
      await new Promise(r => setTimeout(r, 300));

      // Verify: send button should become visible + enabled again
      const check = await this._page.evaluate(`(function() {
        var btn = document.getElementById('flow-end-msg-send');
        if (!btn) return { stopped: false, reason: 'no button' };
        var r = btn.getBoundingClientRect();
        return { stopped: r.width > 0 && r.height > 0 };
      })()`);
      if (check && check.stopped) {
        debugLog('stopGeneration: stopped by Escape key');
        return true;
      }

      // ── Attempt 3: Spec-compliant ──
      //   Find div#flow-end-msg-send.send-btn-wrapper.group.\!hidden
      //   and click its inner <button>
      const result = await this._page.evaluate(`(function() {
        var container = document.getElementById('flow-end-msg-send');
        if (container &&
            container.classList.contains('send-btn-wrapper') &&
            container.classList.contains('group') &&
            container.classList.contains('!hidden')) {
          var btn = container.querySelector('button');
          if (btn) {
            btn.click();
            return { ok: true, method: 'spec-inner-btn' };
          }
          container.click();
          return { ok: true, method: 'spec-container' };
        }

        var btn2 = document.querySelector('[data-testid="chat_input_send_button"]');
        if (btn2) {
          btn2.click();
          return { ok: true, method: 'testid' };
        }

        return { ok: false, reason: 'no button found' };
      })()`);
      if (result && result.ok) {
        debugLog('stopGeneration: clicked (' + result.method + ')');
        return true;
      }
      debugLog('stopGeneration: JS click failed:', result?.reason);

      // ── Attempt 4: CDP-level mouse click ──
      debugLog('stopGeneration: trying CDP mouse click...');
      var rect = await this._page.evaluate(`(function() {
        var el = document.getElementById('flow-end-msg-send') ||
                 document.querySelector('[data-testid="chat_input_send_button"]');
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()`);
      if (rect && rect.w > 0 && rect.h > 0) {
        var cx = Math.round(rect.x + rect.w / 2);
        var cy = Math.round(rect.y + rect.h / 2);
        await this._page.cdp('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
        });
        await this._page.cdp('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
        });
        debugLog('stopGeneration: CDP mouse click sent');
        return true;
      }
      debugLog('stopGeneration: all attempts failed');
      return false;
    } catch (e) {
      debugLog('stopGeneration failed:', e.message);
      return false;
    }
  }
}

module.exports = DoubaoAppAdapter;
