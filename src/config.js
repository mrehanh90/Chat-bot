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
  groqApiKey: required('GROQ_API_KEY'),
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  groqLiveModel: process.env.GROQ_LIVE_MODEL || 'groq/compound',
  ownerJid: required('BOT_OWNER_NUMBER'),
  ignoreGroups: (process.env.IGNORE_GROUPS || 'true').toLowerCase() === 'true',
  maxInputChars: parseInt(process.env.MAX_INPUT_CHARS || '2000', 10),
  minReplyIntervalMs: parseInt(process.env.MIN_REPLY_INTERVAL_MS || '15000', 10),
  authDir: require('path').join(__dirname, '..', 'baileys_auth_info'),
};