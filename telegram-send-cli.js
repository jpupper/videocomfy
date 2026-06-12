#!/usr/bin/env node
/**
 * Telegram Send CLI for VideoComfy
 * 
 * Sends a file (image/video/document) or text message to a Telegram chat.
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from .env.
 * 
 * Usage:
 *   node telegram-send-cli.js --message "Hello world"
 *   node telegram-send-cli.js --file /path/to/image.png --type image --caption "My caption"
 *   node telegram-send-cli.js --file /path/to/video.mp4 --type video --caption "My video"
 *   node telegram-send-cli.js --file /path/to/doc.pdf --type document
 *   node telegram-send-cli.js --chatid 123456789 --message "Custom chat"
 */

// Load .env
try {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });
} catch (e) {
  // dotenv might not be available
}

const path = require('path');
const { sendMessageToTelegram, sendPhotoToTelegram, sendVideoToTelegram, sendDocumentToTelegram } = require('./telegram-bot');

function parseArgs() {
  const args = {};
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].startsWith('--')) {
      const key = raw[i].slice(2);
      i++;
      args[key] = raw[i] || '';
    }
  }
  return args;
}

async function main() {
  const args = parseArgs();

  const chatId = args.chatid || process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN not set in .env');
    process.exit(1);
  }

  if (!chatId) {
    console.error('❌ No chat ID provided. Use --chatid <id> or set TELEGRAM_CHAT_ID in .env');
    process.exit(1);
  }

  try {
    if (args.message) {
      console.log(`📤 Sending message to chat ${chatId}...`);
      const result = await sendMessageToTelegram(chatId, args.message);
      console.log(`✅ Message sent (ID: ${result.result?.message_id})`);
    } 
    else if (args.file) {
      const filePath = path.resolve(args.file);
      const fileType = args.type || 'document';
      const caption = args.caption || '';

      if (!require('fs').existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        process.exit(1);
      }

      console.log(`📤 Sending ${fileType} to chat ${chatId}...`);
      console.log(`   File: ${filePath}`);
      if (caption) console.log(`   Caption: ${caption}`);

      let result;
      switch (fileType) {
        case 'image':
          result = await sendPhotoToTelegram(chatId, filePath, caption);
          break;
        case 'video':
          result = await sendVideoToTelegram(chatId, filePath, caption);
          break;
        case 'document':
        default:
          result = await sendDocumentToTelegram(chatId, filePath, caption);
          break;
      }
      console.log(`✅ ${fileType} sent successfully!`);
    }
    else {
      console.log('📋 Telegram Send CLI');
      console.log('');
      console.log('Usage:');
      console.log('  Send a message:');
      console.log('    node telegram-send-cli.js --message "Hello world"');
      console.log('');
      console.log('  Send a file:');
      console.log('    node telegram-send-cli.js --file /path/to/image.png --type image --caption "my caption"');
      console.log('    node telegram-send-cli.js --file /path/to/video.mp4 --type video --caption "my video"');
      console.log('    node telegram-send-cli.js --file /path/to/doc.pdf --type document');
      console.log('');
      console.log('  Custom chat ID:');
      console.log('    node telegram-send-cli.js --chatid 123456789 --message "custom chat"');
      console.log('');
      console.log('Current config:');
      console.log(`  TELEGRAM_BOT_TOKEN: ${token.substring(0, 20)}...`);
      console.log(`  TELEGRAM_CHAT_ID:   ${chatId || '(not set)'}`);
    }
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
