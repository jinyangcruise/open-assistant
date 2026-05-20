/**
 * Debug: Show full message structure with children
 */

const DoubaoClient = require('./doubao-client').DoubaoClient;

async function debugMessageStructure() {
  const endpoint = process.env.OPENCLI_CDP_ENDPOINT || 'http://127.0.0.1:9225';
  const client = new DoubaoClient(endpoint);

  try {
    await client.connect();
    console.log('✓ Connected to Doubao\n');

    const info = await client.evaluate(`(function() {
      var container = document.querySelector('.message-list-S2Fv2S') || document.body;
      var messages = Array.from(container.querySelectorAll('[class*="message"]')).slice(-3);
      
      return messages.map(function(msg, idx) {
        var text = msg.innerText ? msg.innerText.trim() : '';
        var children = Array.from(msg.children).map(function(child) {
          return {
            tag: child.tagName,
            className: child.className ? child.className.substring(0, 50) : '',
            text: child.innerText ? child.innerText.trim().substring(0, 100) : '',
            textLength: child.innerText ? child.innerText.trim().length : 0
          };
        });
        
        return {
          index: idx,
          directText: text.substring(0, 50),
          directTextLength: text.length,
          children: children
        };
      });
    })()`);

    console.log('Last 3 messages structure:');
    console.log(JSON.stringify(info, null, 2));

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    client.close();
  }
}

debugMessageStructure();
