/**
 * Find all text content in the page
 */

const DoubaoClient = require('./doubao-client').DoubaoClient;

async function findAllText() {
  const endpoint = process.env.OPENCLI_CDP_ENDPOINT || 'http://127.0.0.1:9225';
  const client = new DoubaoClient(endpoint);

  try {
    await client.connect();
    console.log('✓ Connected to Doubao\n');

    const textElements = await client.evaluate(`(function() {
      // Get all elements with substantial text
      var allElements = document.querySelectorAll('div, p, span');
      var textElements = [];
      
      for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        var text = el.innerText ? el.innerText.trim() : '';
        
        if (text.length > 50 && text.length < 500) {
          // Skip if it's a known UI element
          if (text.indexOf('发消息') !== -1) continue;
          if (text.indexOf('豆包') !== -1 && text.length < 100) continue;
          
          textElements.push({
            tag: el.tagName,
            className: el.className ? el.className.substring(0, 60) : '',
            textLength: text.length,
            textPreview: text.substring(0, 150)
          });
          
          if (textElements.length >= 10) break;
        }
      }
      
      return textElements;
    })()`);

    console.log('Found', textElements.length, 'elements with substantial text:\n');
    textElements.forEach(function(el, idx) {
      console.log('--- Element', idx + 1, '---');
      console.log('Tag:', el.tag);
      console.log('Class:', el.className);
      console.log('Length:', el.textLength);
      console.log('Preview:', el.textPreview);
      console.log('');
    });

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    client.close();
  }
}

findAllText();
