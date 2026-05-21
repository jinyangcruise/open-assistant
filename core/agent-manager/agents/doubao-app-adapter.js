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
   * @returns {Promise<string>} Response text
   */
  async _pollDomResponse(page, beforeLastText, timeout, onChunk) {
    console.log('[DoubaoAdapter] _pollDomResponse: timeout=' + timeout + ' beforeLastTextLen=' + (beforeLastText || '').length);
    const POLL_MS = 200;
    const IDLE_TIMEOUT_MS = Math.min(1500, Math.floor(timeout / 3));

    let lastText = beforeLastText;
    let lastEmittedText = beforeLastText;
    let idleMs = 0;
    let totalMs = 0;
    let hasNewText = false;
    let seenNewMessage = false;

    while (totalMs < timeout) {
      await sleep(POLL_MS / 1000);
      totalMs += POLL_MS;

      let result;
      try {
        result = await page.evaluate(
          this._buildFastPollScript(beforeLastText),
        );
      } catch (evaluateError) {
        console.log('[DoubaoAdapter] DOM poll evaluate failed:', evaluateError.message);
        // If the connection was lost and we already have text, return it
        if (hasNewText && lastText) {
          console.log('[DoubaoAdapter] Connection lost, returning partial text:', lastText.length, 'chars');
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
            console.log('[DoubaoAdapter] DOM poll onChunk, incremental length:', incremental.length);
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
   * Capture AI response via CDP Fetch domain (SSE interception).
   *
   * Enables Fetch interception for /chat/completion requests at the
   * browser process level, then polls Fetch.getResponseBody to read
   * the streaming response body as it accumulates. Works even when
   * the chat window is hidden / minimized to tray.
   *
   * CRITICAL: This method starts pre-listening for the request BEFORE
   * the send button is clicked. Call it first (it returns a Promise),
   * THEN click send, THEN await the returned promise.
   *
   * @param {Object} bridge  - CDPBridge instance (from this.getBridge())
   * @param {number} timeout - max wait time in ms
   * @param {Function} [onChunk] - optional callback(incrementalText) for streaming
   * @returns {Promise<string>} Full response text
   */
  async _captureSSEResponse(bridge, timeout, onChunk) {
    const POLL_MS = 200;
    const REQUEST_WAIT_MS = 15000;

    // Enable Network domain — response flows normally to page,
    // we capture the body after Network.loadingFinished
    console.log('[DoubaoAdapter] Network.enable');
    await bridge.send('Network.enable');

    let targetRequestId = null;
    let caughtBody = null;
    let cleanupDone = false;

    const cleanup = async () => {
      if (cleanupDone) return;
      cleanupDone = true;
      try { await bridge.send('Network.disable'); } catch (_) { /* ignore */ }
      bridge.off('Network.requestWillBeSent', onReqSent);
      bridge.off('Network.loadingFinished', onLoadFinished);
    };

    let resolveCapture, rejectCapture;
    const capturePromise = new Promise((resolve, reject) => {
      resolveCapture = resolve;
      rejectCapture = reject;
    });

    // Identify the /chat/completion request
    const onReqSent = (event) => {
      if (targetRequestId) return;
      if ((event?.request?.url || '').includes('chat/completion')) {
        targetRequestId = event.requestId;
        console.log('[DoubaoAdapter] Network: /chat/completion requestId=', targetRequestId);
      }
    };

    // Capture body when loading finishes
    const onLoadFinished = async (event) => {
      if (event.requestId !== targetRequestId) return;
      console.log('[DoubaoAdapter] Network.loadingFinished for:', targetRequestId);
      try {
        const result = await bridge.send('Network.getResponseBody', { requestId: targetRequestId });
        console.log('[DoubaoAdapter] getResponseBody result keys:', Object.keys(result || {}), 'base64Encoded:', result?.base64Encoded, 'bodyType:', typeof result?.body, 'bodyLen:', result?.body?.length);
        caughtBody = result?.base64Encoded
          ? Buffer.from(result.body, 'base64').toString('utf-8')
          : (result?.body || '');
        // Debug: hex dump first 80 bytes to determine actual encoding
        const raw = result?.body || '';
        const hexBytes = [];
        for (let i = 0; i < Math.min(80, raw.length); i++) {
          const code = raw.charCodeAt(i);
          hexBytes.push(code.toString(16).padStart(2, '0'));
        }
        const hasHighChars = [...raw.substring(0, 80)].some(c => c.charCodeAt(0) > 0xFF);
        console.log('[DoubaoAdapter] Body hex (first 80 bytes):', hexBytes.join(' '),
          '| hasCodePoints>0xFF:', hasHighChars);
        console.log('[DoubaoAdapter] Got response body, length=', caughtBody.length);
      } catch (err) {
        console.log('[DoubaoAdapter] Network.getResponseBody failed:', err.message);
      }
    };

    bridge.on('Network.requestWillBeSent', onReqSent);
    bridge.on('Network.loadingFinished', onLoadFinished);

    // Poll until body is captured or timeout
    let elapsed = 0;
    const startTime = Date.now();

    const run = async () => {
      while (elapsed < timeout) {
        await sleep(POLL_MS / 1000);
        elapsed = Date.now() - startTime;

        // Still waiting for request to be detected
        if (!targetRequestId) {
          if (elapsed >= REQUEST_WAIT_MS) {
            await cleanup();
            rejectCapture(new Error('未检测到豆包聊天请求（15秒超时），请确认消息已成功发送'));
            return;
          }
          continue;
        }

        // Body captured — parse SSE events and emit incrementally
        if (caughtBody) {
          // Debug: dump first 500 chars of raw body and first event
          console.log('[DoubaoAdapter] Body preview (first 300 chars):', caughtBody.substring(0, 300));

          const events = caughtBody.split('\n\n');
          let fullText = '';
          let eventCount = 0;
          let chunkDebugCount = 0;

          // Buffered conversion: Doubao emits each byte of Chinese text
          // as separate CHUNK_DELTA events, so we accumulate raw Latin-1
          // bytes and convert only complete UTF-8 sequences.
          let rawAccumulator = '';   // pending Latin-1 bytes
          let lastConvertedLen = 0;  // chars emitted so far
          let totalChunks = 0;
          let streamMsgCount = 0;

          for (const raw of events) {
            const lines = raw.split('\n');
            let evType = '', evData = '';
            for (const l of lines) {
              if (l.startsWith('event:')) evType = l.slice(6).trim();
              else if (l.startsWith('data:')) evData = l.slice(5).trim();
            }
            if (!evType || !evData) continue;

            // Debug first 3 events
            if (eventCount < 3) {
              console.log('[DoubaoAdapter] Event #' + eventCount + ' type=' + evType + ' data=' + evData.substring(0, 200));
            }
            eventCount++;

            try {
              const d = JSON.parse(evData);
              if (evType === 'CHUNK_DELTA' && typeof d?.text === 'string') {
                rawAccumulator += d.text;
                totalChunks++;
                if (chunkDebugCount < 5) {
                  chunkDebugCount++;
                  const hexCodes = [];
                  for (let i = 0; i < Math.min(30, d.text.length); i++) {
                    hexCodes.push(d.text.charCodeAt(i).toString(16).padStart(2, '0'));
                  }
                  console.log('[DoubaoAdapter] CHUNK_DELTA #' + chunkDebugCount + ' raw[' + d.text.length + ']:', hexCodes.join(' '));
                }
              } else if (evType === 'STREAM_MSG_NOTIFY') {
                streamMsgCount++;
                const blocks = d?.content?.content_block || [];
                console.log('[DoubaoAdapter] STREAM_MSG_NOTIFY #' + streamMsgCount + ': blocks=' + blocks.length,
                  'keys=' + Object.keys(d || {}).join(','));
                if (blocks.length > 0) {
                  console.log('[DoubaoAdapter] STREAM_MSG_NOTIFY firstBlock keys:', Object.keys(blocks[0] || {}).join(','));
                  console.log('[DoubaoAdapter] STREAM_MSG_NOTIFY evData:', evData.substring(0, 400));
                }
                for (const b of blocks) {
                  const rawText = b?.content?.text_block?.text;
                  if (typeof rawText === 'string') {
                    rawAccumulator += rawText;
                    totalChunks++;
                  }
                }
              } else if (evType === 'SSE_REPLY_END' && d?.end_type === 3) {
                // Drain: convert all accumulated raw bytes at once
                console.log('[DoubaoAdapter] Accumulated raw hex (first 100):',
                  [...rawAccumulator.slice(0, 50)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' '));
                const converted = this._cdpBodyToUtf8(rawAccumulator);
                console.log('[DoubaoAdapter] Final convert: rawLen=' + rawAccumulator.length + ' convertedLen=' + converted.length);
                console.log('[DoubaoAdapter] Converted text (first 100):', JSON.stringify(converted.slice(0, 100)));
                fullText = converted;
                if (onChunk) onChunk(converted);
                rawAccumulator = '';
                break;
              }
            } catch (e) {
              if (eventCount < 5) console.log('[DoubaoAdapter] Event parse error:', e.message, 'data:', evData.substring(0, 80));
            }
          }

          // Fallback drain if we didn't hit SSE_REPLY_END(type=3)
          if (rawAccumulator) {
            const leftover = this._cdpBodyToUtf8(rawAccumulator);
            fullText += leftover;
            if (onChunk && leftover) onChunk(leftover);
          }

          console.log('[DoubaoAdapter] Network done: events=' + eventCount + ' chunks=' + totalChunks + ' rawLen=' + rawAccumulator.length + ' fullText=' + fullText.length + ' chars');

          await cleanup();
          resolveCapture(fullText);
          return;
        }

        console.log('[DoubaoAdapter] Network poll: waiting for body, elapsed=' + elapsed + 'ms');
      }

      console.log('[DoubaoAdapter] Network capture timeout after ' + elapsed + 'ms');
      await cleanup();
      resolveCapture('');
    };

    run(); // Start polling in background
    return capturePromise;
  }

  /**
   * Pre-check: verify the CDP endpoint has a usable chat page target.
   * Called at the start of analyze() to fail fast with a friendly message.
   *
   * @param {string} endpoint - CDP HTTP endpoint (e.g. http://127.0.0.1:9225)
   * @returns {Promise<void>}
   */
  async _preCheckTargets(endpoint) {
    let targets;
    try {
      targets = await _fetchTargets(endpoint || this.endpoint);
    } catch (err) {
      throw new Error(
        `无法连接到豆包桌面端（${endpoint || this.endpoint}）。` +
        `请确认豆包已启动并开启了远程调试端口。`
      );
    }

    if (!targets || targets.length === 0) {
      throw new Error('豆包桌面端未返回任何页面目标，请确认豆包已启动。');
    }

    // Check for valid chat page targets
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

    if (!chatTarget) {
      // List available target types for debugging
      const types = [...new Set(targets.map((t) => t.type))].join(', ');
      const urls = targets.map((t) => (t.url || '(empty)')).filter(Boolean);
      console.log('[DoubaoAdapter] preCheck: no chat target. Available types:', types, 'urls:', urls);
      throw new Error(
        '豆包聊天窗口未打开。请打开豆包聊天页面后重试。' +
        `（当前可用目标类型: ${types}）`
      );
    }

    console.log('[DoubaoAdapter] preCheck: found chat target —', chatTarget.url);
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
      // 0. Pre-check: verify CDP endpoint has a usable chat target
      await this._preCheckTargets(this.endpoint);

      // 1. Force fresh connection
      this.disconnect();
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

      // 6. Wake up hidden renderer (best-effort; OK to fail for SSE Fetch)
      try {
        await page.cdp('Page.bringToFront');
        await sleep(0.5);
      } catch (e) {
        // Page might be hidden — this is OK, especially for SSE Fetch
      }

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
        console.log('[DoubaoAdapter] Could not capture beforeLastText:', e.message);
        beforeLastText = '';
      }

      // 8. Inject text into chat input
      const injected = await page.evaluate(injectTextScript(prompt));
      if (!injected || !injected.ok) {
        throw new Error('无法在豆包聊天输入框中输入文本');
      }

      await sleep(0.5);

      // 9. Determine capture mode and output options
      const mode = context.responseMode || 'sse-fetch';
      const userTimeout = context.timeout || 30000;
      const onChunk = typeof context.onChunk === 'function' ? context.onChunk : null;
      console.log('[DoubaoAdapter] analyze: mode=' + mode + ' timeout=' + userTimeout + ' hasOnChunk=' + (onChunk !== null));

      let response;

      if (mode === 'sse-fetch') {
        // === SSE FETCH MODE ===
        // CRITICAL TIMING: start SSE interception BEFORE clicking send
        const bridge = this.getBridge();
        if (!bridge) {
          throw new Error('CDP bridge 不可用，无法使用 SSE Fetch 模式');
        }

        const ssePromise = this._captureSSEResponse(bridge, userTimeout, onChunk);

        // Click send (trigger the request that SSE capture is waiting for)
        const clicked = await page.evaluate(clickSendScript());
        if (!clicked) {
          await page.pressKey('Enter');
        }

        response = await ssePromise;

      } else {
        // === DOM POLL MODE ===
        const clicked = await page.evaluate(clickSendScript());
        if (!clicked) {
          await page.pressKey('Enter');
        }

        response = await this._pollDomResponse(
          page, beforeLastText, userTimeout, onChunk,
        );
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
