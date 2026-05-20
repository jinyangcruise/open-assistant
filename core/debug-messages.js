/**
 * Debug: Show what messages look like
 */

const DoubaoClient = require('./doubao-client').DoubaoClient;

async function debugMessages() {
  const endpoint = process.env.OPENCLI_CDP_ENDPOINT || 'http://127.0.0.1:9225';
  const client = new DoubaoClient(endpoint);

  try {
    await client.connect();
    console.log('✓ Connected to Doubao\n');

    // Get message info
    const info = await client.evaluate(`(function() {
      var selectors = ['.message-list-S2Fv2S', '[class*="message-list"]', 'main'];
      var container = null;
      
      for (var i = 0; i < selectors.length; i++) {
        container = document.querySelector(selectors[i]);
        if (container) {
          console.log('Found container:', selectors[i]);
          break;
        }
      }
      
      if (!container) {
        console.log('Using body');
        container = document.body;
      }
      
      var msgSelectors = ['[class*="message"]', 'p', '[class*="chat-item"]'];
      var messages = [];
      
      for (var j = 0; j < msgSelectors.length; j++) {
        var found = container.querySelectorAll(msgSelectors[j]);
        if (found.length > 0) {
          console.log('Using selector:', msgSelectors[j], 'count:', found.length);
          messages = Array.from(found).slice(-5);
          break;
        }
      }
      
      return messages.map(function(msg, idx) {
        var text = msg.innerText ? msg.innerText.trim() : '';
        return {
          index: idx,
          tag: msg.tagName,
          textLength: text.length,
          textPreview: text.substring(0, 100),
          hasChildren: msg.children.length
        };
      });
    })()`);

    console.log('\nLast 5 messages:');
    console.log(JSON.stringify(info, null, 2));

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    client.close();
  }
}

debugMessages();
