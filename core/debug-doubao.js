/**
 * Debug script to inspect Doubao UI structure
 * Run this to understand the correct selectors
 */

const DoubaoClient = require('./doubao-client').DoubaoClient;

async function debugDoubaoUI() {
  const endpoint = process.env.OPENCLI_CDP_ENDPOINT || 'http://127.0.0.1:9225';
  const client = new DoubaoClient(endpoint);

  try {
    await client.connect();
    console.log('✓ Connected to Doubao');

    // Get page info
    const title = await client.evaluate('document.title');
    console.log('\nPage title:', title);

    // Find message containers
    const messageInfo = await client.evaluate(`(function() {
      // Try different common selectors
      const selectors = [
        '[class*="message"]',
        '[class*="chat"]',
        '[class*="conversation"]',
        'article',
        'section'
      ];
      
      const results = {};
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          results[sel] = {
            count: els.length,
            sample: Array.from(els).slice(0, 2).map(el => ({
              tag: el.tagName,
              className: el.className,
              text: (el.textContent || '').substring(0, 50)
            }))
          };
        }
      }
      return results;
    })()`);
    
    console.log('\nMessage elements found:', JSON.stringify(messageInfo, null, 2));

    // Find textarea
    const textareaInfo = await client.evaluate(`(function() {
      const textareas = document.querySelectorAll('textarea');
      return {
        count: textareas.length,
        details: Array.from(textareas).map((ta, i) => ({
          index: i,
          className: ta.className,
          placeholder: ta.placeholder,
          id: ta.id
        }))
      };
    })()`);
    
    console.log('\nTextarea elements:', JSON.stringify(textareaInfo, null, 2));

    // Find send button
    const buttonInfo = await client.evaluate(`(function() {
      const buttons = document.querySelectorAll('button');
      const sendButtons = Array.from(buttons).filter(btn => {
        const text = (btn.textContent || '').toLowerCase();
        return text.includes('send') || text.includes('发送') || text.includes('submit');
      });
      
      return {
        totalButtons: buttons.length,
        sendButtons: sendButtons.map(btn => ({
          className: btn.className,
          text: btn.textContent,
          type: btn.type
        }))
      };
    })()`);
    
    console.log('\nSend buttons:', JSON.stringify(buttonInfo, null, 2));

    // Check for screen sharing indicator
    const screenShareInfo = await client.evaluate(`(function() {
      return {
        url: window.location.href,
        hasVideo: !!document.querySelector('video'),
        hasScreenShare: !!document.querySelector('[class*="screen"]') || 
                        !!document.querySelector('[class*="share"]')
      };
    })()`);
    
    console.log('\nScreen sharing:', JSON.stringify(screenShareInfo, null, 2));

    console.log('\n✓ Debug complete!');
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    client.close();
  }
}

debugDoubaoUI();
