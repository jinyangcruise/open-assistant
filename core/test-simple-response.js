/**
 * Simple test - get Doubao's last response
 */

const DoubaoClient = require('./doubao-client').DoubaoClient;

async function testSimpleResponse() {
  const endpoint = process.env.OPENCLI_CDP_ENDPOINT || 'http://127.0.0.1:9225';
  const client = new DoubaoClient(endpoint);

  try {
    await client.connect();
    console.log('✓ Connected to Doubao\n');

    // Get all text from the page
    const allText = await client.evaluate(`(function() {
      var container = document.querySelector('.message-list-S2Fv2S');
      if (!container) return 'Container not found';
      return container.innerText || 'No text';
    })()`);

    console.log('Full text from message list:');
    console.log('---');
    console.log(allText);
    console.log('---');
    console.log('\nLength:', allText.length);

    // Try to find Doubao's response
    const response = await client.evaluate(`(function() {
      // Get all div elements with substantial text
      var allDivs = document.querySelectorAll('div');
      var responses = [];
      
      for (var i = 0; i < allDivs.length; i++) {
        var text = allDivs[i].innerText ? allDivs[i].innerText.trim() : '';
        if (text.length > 20 && text.length < 300) {
          // Skip UI elements
          if (text.indexOf('发消息') !== -1) continue;
          if (text.indexOf('历史对话') !== -1) continue;
          if (text.indexOf('豆包') !== -1 && text.length < 50) continue;
          
          responses.push({
            length: text.length,
            preview: text.substring(0, 100)
          });
        }
      }
      
      return responses.slice(-5);
    })()`);

    console.log('\nPossible response texts:');
    response.forEach(function(r, idx) {
      console.log('\n--- Response', idx + 1, '---');
      console.log('Length:', r.length);
      console.log('Preview:', r.preview);
    });

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    client.close();
  }
}

testSimpleResponse();
