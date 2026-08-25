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

function optionalPublicUrl(value) {
  if (!value || !value.trim()) return '';
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('GOOGLE_CALENDAR_REDIRECT_URI must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.search || url.hash) {
    throw new Error('GOOGLE_CALENDAR_REDIRECT_URI must be an HTTPS URL without query parameters or a fragment.');
  }
  return url.toString().replace(/\/$/, '');
}

module.exports = {
  // OpenRouter
  openRouterApiKey: required('OPENROUTER_API_KEY'),

  openRouterModel:
    process.env.OPENROUTER_MODEL?.trim() ||
    'openrouter/free',

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

  googleCalendarClientId: process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim() || '',
  googleCalendarClientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim() || '',
  // Optional public HTTPS callback. When configured through a reverse proxy or
  // tunnel, the Google approval link can be completed on a mobile phone.
  googleCalendarRedirectUri: optionalPublicUrl(process.env.GOOGLE_CALENDAR_REDIRECT_URI),
  googleCalendarRedirectPort: Math.max(1024, parseInt(process.env.GOOGLE_CALENDAR_REDIRECT_PORT || '3000', 10)),
  googleCalendarCallbackHost: process.env.GOOGLE_CALENDAR_CALLBACK_HOST?.trim() || '127.0.0.1',
  googleCalendarReminderMinutes: Math.max(0, parseInt(process.env.GOOGLE_CALENDAR_REMINDER_MINUTES || '30', 10)),
  calendarTokenEncryptionSecret:
    process.env.CALENDAR_TOKEN_ENCRYPTION_KEY?.trim() || required('OPENROUTER_API_KEY'),
};
