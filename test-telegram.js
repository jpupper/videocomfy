/**
 * Test script for VideoComfy Telegram Bot
 * 
 * Run: node test-telegram.js
 * 
 * Sends a test message to verify the Telegram bot is working.
 * Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env or as environment variables.
 */

// Load .env if available (two possible locations)
try {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });
} catch (e) {
  // dotenv might not be available standalone, try anyway
}

const { sendMessageToTelegram } = require('./telegram-bot');

async function main() {
  console.log('=== Telegram Bot Test ===');
  console.log('');

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || process.argv[2]; // CLI arg overrides

  if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN not set!');
    console.error('   Add it to .env or set the environment variable.');
    console.error('   Format: TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
    process.exit(1);
  }

  if (!chatId) {
    console.error('❌ Chat ID not provided!');
    console.error('   Usage: node test-telegram.js <chat_id>');
    console.error('   Or set TELEGRAM_CHAT_ID in .env');
    console.error('   Get your chat ID from @userinfobot on Telegram.');
    process.exit(1);
  }

  console.log(`🤖 Bot Token : ${token.substring(0, 20)}...`);
  console.log(`👤 Chat ID   : ${chatId}`);
  console.log('');

  try {
    console.log('📤 Sending test message...');
    const result = await sendMessageToTelegram(
      chatId,
      '✅ <b>Test message from VideoComfy!</b>\n\nThe Telegram bot module is working correctly.'
    );
    console.log('✅ Message sent successfully!');
    console.log(`   Message ID: ${result.result?.message_id}`);
    console.log(`   Chat: ${result.result?.chat?.title || result.result?.chat?.first_name || 'OK'}`);
  } catch (err) {
    console.error('❌ Failed to send message:', err.message);
    console.error('');
    console.error('Possible issues:');
    console.error('  1. Invalid bot token - check TELEGRAM_BOT_TOKEN');
    console.error('  2. Invalid chat ID - use @userinfobot to get your ID');
    console.error('  3. Bot was blocked by the user');
    process.exit(1);
  }
}

main();
