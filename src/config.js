require('dotenv').config();

function required(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    console.error(`[config] Missing required environment variable: ${name}`);
    process.exit(1);
  }

  return value.trim();
}

module.exports = {
  // OpenRouter
  openRouterApiKey: required('OPENROUTER_API_KEY'),

  openRouterModel:
    process.env.OPENROUTER_MODEL?.trim() ||
    'openai/gpt-oss-20b:free',

  openRouterLiveModel:
    process.env.OPENROUTER_LIVE_MODEL?.trim() ||
    process.env.OPENROUTER_MODEL?.trim() ||
    'openai/gpt-oss-20b:free',

  // Optional OpenRouter metadata
  openRouterSiteUrl:
    process.env.OPENROUTER_SITE_URL?.trim() || '',

  openRouterSiteName:
    process.env.OPENROUTER_SITE_NAME?.trim() ||
    'WhatsApp AI Assistant',

  // Bot behavior
  ignoreGroups:
    (process.env.IGNORE_GROUPS || 'true').trim().toLowerCase() === 'true',

  maxInputChars:
    parseInt(process.env.MAX_INPUT_CHARS || '2000', 10),

  minReplyIntervalMs:
    parseInt(process.env.MIN_REPLY_INTERVAL_MS || '15000', 10),
};
