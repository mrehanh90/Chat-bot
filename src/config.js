require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[config] Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

module.exports = {
  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  ownerJid: required('BOT_OWNER_NUMBER'),
  ignoreGroups: (process.env.IGNORE_GROUPS || 'true').toLowerCase() === 'true',
  maxInputChars: parseInt(process.env.MAX_INPUT_CHARS || '2000', 10),
  minReplyIntervalMs: parseInt(process.env.MIN_REPLY_INTERVAL_MS || '15000', 10),
  authDir: require('path').join(__dirname, '..', 'baileys_auth_info'),
};