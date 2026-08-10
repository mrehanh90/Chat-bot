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
  openRouterApiKey: required('OPENROUTER_API_KEY'),
  openRouterModel: process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free',
  // Optional paid/current-data model. If empty, live web search uses the same model
  // with OpenRouter's server-side web_search tool.
  openRouterLiveModel: process.env.OPENROUTER_LIVE_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free',
  openRouterSiteUrl: process.env.OPENROUTER_SITE_URL || '',
  openRouterSiteName: process.env.OPENROUTER_SITE_NAME || 'WhatsApp AI Assistant',

  ownerJid: required('BOT_OWNER_NUMBER'),
  ignoreGroups: (process.env.IGNORE_GROUPS || 'true').toLowerCase() === 'true',
  maxInputChars: parseInt(process.env.MAX_INPUT_CHARS || '2000', 10),
  minReplyIntervalMs: parseInt(process.env.MIN_REPLY_INTERVAL_MS || '15000', 10),
  authDir: require('path').join(__dirname, '..', 'baileys_auth_info'),
};
