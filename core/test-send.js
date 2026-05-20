/**
 * Test script to verify send button click
 */

const DoubaoClient = require('./doubao-client').DoubaoClient;

async function testSendButton() {
  const endpoint = process.env.OPENCLI_CDP_ENDPOINT || 'http://127.0.0.1:9225';
  const client = new DoubaoClient(endpoint);

  try {
    await client.connect();
    console.log('✓ Connected to Doubao');

    // Get text length before
    const beforeCount = await client.getTextLength();
    console.log('Text length before:', beforeCount);

    // Type a test message
    console.log('\nTyping test message...');
    const injected = await client.injectText('你好，这是一个测试消息');
    console.log('Text injected:', injected);

    // Wait a bit for button to appear
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Try to click send
    console.log('\nAttempting to click send...');
    const clicked = await client.clickSend();
    console.log('Send clicked:', clicked);

    // Wait for response
    console.log('\nWaiting for response...');
    try {
      const response = await client.waitForResponse(beforeCount, 30000);
      console.log('\n✓ Response received:');
      console.log(response.substring(0, 200) + '...');
    } catch (error) {
      console.log('\n✗ Timeout:', error.message);
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    client.close();
  }
}

testSendButton();
