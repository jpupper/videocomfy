/**
 * Telegram Bot Module for VideoComfy
 * 
 * Sends generated images and videos to Telegram chats using the Telegram Bot API.
 * Uses built-in https module with form-data for multipart file uploads.
 * 
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN - Bot token from @BotFather
 *   TELEGRAM_CHAT_ID   - Default chat ID to send to
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const TELEGRAM_API_BASE = 'api.telegram.org';

/**
 * Get the bot token from environment
 */
function getToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('[TelegramBot] ⚠️ TELEGRAM_BOT_TOKEN not set. Telegram features disabled.');
  }
  return token;
}

/**
 * Get default chat ID from environment
 */
function getDefaultChatId() {
  return process.env.TELEGRAM_CHAT_ID || null;
}

/**
 * Make a raw HTTPS request to the Telegram Bot API
 */
function telegramRequest(method, formData) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    if (!token) {
      return reject(new Error('TELEGRAM_BOT_TOKEN not configured'));
    }

    const headers = formData ? formData.getHeaders() : { 'Content-Type': 'application/json' };
    const pathStr = `/bot${token}/${method}`;

    const options = {
      hostname: TELEGRAM_API_BASE,
      path: pathStr,
      method: 'POST',
      headers: headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve(parsed);
          } else {
            reject(new Error(`Telegram API error: ${parsed.description || JSON.stringify(parsed)}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse Telegram response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Telegram request failed: ${err.message}`));
    });

    if (formData) {
      formData.pipe(req);
    } else {
      req.end();
    }
  });
}

/**
 * Send a text message to a Telegram chat
 * @param {string|number} chatId - Chat ID to send to
 * @param {string} text - Message text
 * @returns {Promise<object>} Telegram API response
 */
async function sendMessageToTelegram(chatId, text) {
  const targetChatId = chatId || getDefaultChatId();
  if (!targetChatId) {
    throw new Error('No chat ID provided and TELEGRAM_CHAT_ID not configured');
  }

  const payload = JSON.stringify({
    chat_id: targetChatId,
    text: text,
    parse_mode: 'HTML'
  });

  return new Promise((resolve, reject) => {
    const token = getToken();
    if (!token) return reject(new Error('TELEGRAM_BOT_TOKEN not configured'));

    const options = {
      hostname: TELEGRAM_API_BASE,
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) resolve(parsed);
          else reject(new Error(`Telegram API error: ${parsed.description}`));
        } catch (e) {
          reject(new Error(`Failed to parse Telegram response: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Send a photo to a Telegram chat using multipart upload
 * @param {string|number} chatId - Chat ID to send to
 * @param {string} filePath - Path to the image file
 * @param {string} caption - Optional caption (max 1024 chars)
 * @returns {Promise<object>} Telegram API response
 */
async function sendPhotoToTelegram(chatId, filePath, caption) {
  const targetChatId = chatId || getDefaultChatId();
  if (!targetChatId) {
    throw new Error('No chat ID provided and TELEGRAM_CHAT_ID not configured');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const form = new FormData();
  form.append('chat_id', String(targetChatId));
  form.append('photo', fs.createReadStream(filePath), { filename: path.basename(filePath) });
  if (caption) {
    form.append('caption', String(caption).substring(0, 1024));
  }

  return telegramRequest('sendPhoto', form);
}

/**
 * Send a video to a Telegram chat using multipart upload
 * @param {string|number} chatId - Chat ID to send to
 * @param {string} filePath - Path to the video file
 * @param {string} caption - Optional caption (max 1024 chars)
 * @returns {Promise<object>} Telegram API response
 */
async function sendVideoToTelegram(chatId, filePath, caption) {
  const targetChatId = chatId || getDefaultChatId();
  if (!targetChatId) {
    throw new Error('No chat ID provided and TELEGRAM_CHAT_ID not configured');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const form = new FormData();
  form.append('chat_id', String(targetChatId));
  form.append('video', fs.createReadStream(filePath), { filename: path.basename(filePath) });
  if (caption) {
    form.append('caption', String(caption).substring(0, 1024));
  }

  return telegramRequest('sendVideo', form);
}

/**
 * Send a document (any file type) to a Telegram chat using multipart upload
 * @param {string|number} chatId - Chat ID to send to
 * @param {string} filePath - Path to the file
 * @param {string} caption - Optional caption
 * @returns {Promise<object>} Telegram API response
 */
async function sendDocumentToTelegram(chatId, filePath, caption) {
  const targetChatId = chatId || getDefaultChatId();
  if (!targetChatId) {
    throw new Error('No chat ID provided and TELEGRAM_CHAT_ID not configured');
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const form = new FormData();
  form.append('chat_id', String(targetChatId));
  form.append('document', fs.createReadStream(filePath), { filename: path.basename(filePath) });
  if (caption) {
    form.append('caption', String(caption).substring(0, 1024));
  }

  return telegramRequest('sendDocument', form);
}

module.exports = {
  sendMessageToTelegram,
  sendPhotoToTelegram,
  sendVideoToTelegram,
  sendDocumentToTelegram,
  getDefaultChatId,
  getToken
};
