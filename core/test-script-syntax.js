/**
 * Debug script to test the polling script syntax
 */

const DoubaoClient = require('./doubao-client').DoubaoClient;

async function testScriptSyntax() {
  const endpoint = process.env.OPENCLI_CDP_ENDPOINT || 'http://127.0.0.1:9225';
  const client = new DoubaoClient(endpoint);

  try {
    await client.connect();
    console.log('✓ Connected to Doubao');

    // Test a simpler script first
    const simpleScript = `(function(prevCount, pollIndex) {
      return { test: true, pollIndex: pollIndex, prevCount: prevCount };
    })(0, 5)`;

    console.log('\nTesting simple script...');
    const result1 = await client.evaluate(simpleScript);
    console.log('Simple script result:', result1);

    // Now test the actual polling script
    const beforeCount = 32;
    const i = 0;
    
    const pollingScript = `(function(prevCount, pollIndex) {
      const selectors = [
        '.message-list-S2Fv2S',
        '[class*="message-list"]'
      ];
      
      let messageContainer = null;
      for (const sel of selectors) {
        messageContainer = document.querySelector(sel);
        if (messageContainer) {
          if (pollIndex === 0) console.log('[Debug] Found container:', sel);
          break;
        }
      }
      
      if (!messageContainer) {
        if (pollIndex === 0) console.log('[Debug] Using body as container');
        messageContainer = document.body;
      }
      
      const messageSelectors = [
        '[class*="message"]',
        'p'
      ];
      
      let allMessages = [];
      for (const sel of messageSelectors) {
        const found = messageContainer.querySelectorAll(sel);
        if (found.length > 0) {
          allMessages = Array.from(found);
          if (pollIndex === 0) console.log('[Debug] Using selector:', sel, 'count:', found.length);
          break;
        }
      }
      
      const currentCount = allMessages.length;
      
      if (pollIndex === 0) {
        console.log('[Debug] Total messages:', currentCount);
      }
      
      return { 
        phase: currentCount > prevCount ? 'waiting' : 'waiting', 
        count: currentCount 
      };
    })(${beforeCount}, ${i})`;

    console.log('\nTesting polling script...');
    console.log('Script length:', pollingScript.length);
    const result2 = await client.evaluate(pollingScript);
    console.log('Polling script result:', result2);

  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    client.close();
  }
}

testScriptSyntax();
