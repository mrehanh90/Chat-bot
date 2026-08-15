require('dotenv').config();

function required(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    console.error(`[config] Missing required environment variable: ${name}`);
    process.exit(1);
  }

  return value.trim();
}

function timeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return value;
  } catch {
    throw new Error(`Invalid APP_TIME_ZONE: ${value}`);
  }
}

module.exports = {
  // OpenRouter
  openRouterApiKey: required('OPENROUTER_API_KEY'),

  openRouterModel:
    process.env.OPENROUTER_MODEL?.trim() ||
    'openai/gpt-oss-20b:free',

  openRouterLiveModel:
    process.env.OPENROUTER_LIVE_MODEL?.trim() ||
    'openrouter/auto',

  openRouterFallbackModels:
    (process.env.OPENROUTER_FALLBACK_MODELS || '')
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean),

  requestTimeoutMs:
    Math.max(1000, parseInt(process.env.OPENROUTER_REQUEST_TIMEOUT_MS || '30000', 10)),

  maxRetries:
    Math.max(0, parseInt(process.env.OPENROUTER_MAX_RETRIES || '2', 10)),

  webSearchEngine:
    process.env.OPENROUTER_WEB_SEARCH_ENGINE?.trim() || 'exa',

  // Audio transcription model for WhatsApp voice notes. This model is used only
  // when a contact sends a push-to-talk voice note.
  openRouterTranscriptionModel:
    process.env.OPENROUTER_TRANSCRIPTION_MODEL?.trim() ||
    'openai/whisper-large-v3',

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

  timeZone: timeZone(process.env.APP_TIME_ZONE?.trim() || 'Asia/Karachi'),
};
