const config = require('./config');
const { currentZonedIso } = require('./time');

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_TRANSCRIPTION_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

const SYSTEM_PROMPT = `You are a helpful WhatsApp assistant replying on behalf of the phone's owner,
who is currently away.

Given one incoming WhatsApp message:
1. If it is a general, timeless question, answer it directly, briefly, and helpfully.
2. For personal requests, messages, or action items, write a short polite reply that
   says the owner is away and will follow up. Do not invent commitments, prices, dates,
   or facts.
3. Extract concrete owner action items. A meeting, appointment, callback, visit, or
   deadline with a date or time is a scheduled task. When its date and time are clear,
   provide scheduledFor as an ISO 8601 timestamp with the supplied offset. Otherwise,
   set scheduledFor to null. Do not guess missing dates or times.
4. Set needsLiveData to true for questions that need current information, including
   current prices, exchange rates, weather, news, live scores, schedules, availability,
   market data, or anything described as today/latest/current. Set it to false otherwise.

Respond ONLY with JSON in exactly this shape:
{
  "reply": "<reply to send when needsLiveData is false>",
  "needsLiveData": true | false,
  "tasks": [
    {
      "task": "<short imperative task>",
      "kind": "meeting" | "action",
      "scheduledFor": "<ISO 8601 timestamp>" | null
    }
  ]
}

No markdown fences or extra commentary.`;

const ADVISOR_SYSTEM_PROMPT = `You are a warm, practical WhatsApp conversation assistant. You can have a natural ongoing conversation and give supportive advice about everyday life, relationships, study, work, and personal concerns.

Reply in the same language style as the sender: use clear English for English messages and natural Roman Urdu for Roman Urdu messages. Be empathetic, concise, and respectful. Never say that an owner is away. Do not shame the sender or present yourself as a doctor, lawyer, financial adviser, or emergency service. For danger, self-harm, abuse, or an immediate emergency, encourage the sender to contact local emergency services or a trusted person nearby.

Given one incoming WhatsApp message:
1. Answer the message helpfully and continue the conversation when appropriate.
2. Extract concrete action items. A meeting, appointment, callback, visit, or deadline with a date and time is a scheduled task. When its date and time are clear, provide scheduledFor as an ISO 8601 timestamp with the supplied offset. Otherwise set scheduledFor to null. Do not guess missing dates or times.
3. Set needsLiveData to true for questions that need current information, including current prices, exchange rates, weather, news, live scores, schedules, availability, market data, or anything described as today/latest/current. Otherwise set it to false.

Respond ONLY with JSON in exactly this shape:
{
  "reply": "<your helpful reply>",
  "needsLiveData": true | false,
  "tasks": [
    {
      "task": "<short imperative task>",
      "kind": "meeting" | "action",
      "scheduledFor": "<ISO 8601 timestamp>" | null
    }
  ]
}

No markdown fences or extra commentary.`;

const LIVE_ANSWER_PROMPT = `Answer the user's question using current, web-grounded information.
Be concise and accurate. Include essential units, date, or location when relevant.
Never invent facts. Do not mention being an AI or the owner's away status.
Only state a price, timing, or other exact value when it appears in the search
results. If the results do not verify the requested value, say that clearly and
give the best available official source instead. Never write an empty claim such
as "the rate is:".
When web results are available, use them as evidence and include short source links in
markdown when useful. Return plain text only.`;

function getOpenRouterHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.openRouterApiKey}`,
  };

  if (config.openRouterSiteUrl) headers['HTTP-Referer'] = config.openRouterSiteUrl;
  if (config.openRouterSiteName) headers['X-Title'] = config.openRouterSiteName;
  return headers;
}

async function callOpenRouter({
  model,
  systemPrompt,
  userPrompt,
  temperature,
  maxTokens,
  jsonMode = false,
  tools,
  extraBody = {},
}) {
  const models = [...new Set([model, ...config.openRouterFallbackModels].filter(Boolean))];
  let lastError;

  for (const candidate of models) {
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      const body = {
        model: candidate,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
        ...extraBody,
      };
      if (jsonMode) body.response_format = { type: 'json_object' };
      if (tools?.length) body.tools = tools;

      try {
        const data = await fetchJsonWithTimeout(OPENROUTER_API_URL, {
          method: 'POST',
          headers: getOpenRouterHeaders(),
          body: JSON.stringify(body),
        });
        return data;
      } catch (err) {
        lastError = err;
        if (!isRetriable(err) || attempt === config.maxRetries) break;
        const delayMs = Math.min(err.retryAfterMs || (1000 * (2 ** attempt)), 60000);
        console.warn(`[OpenRouter] ${err.message}; retrying ${candidate} in ${delayMs}ms`);
        await sleep(delayMs);
      }
    }
  }

  throw lastError || new Error('OpenRouter request failed');
}

async function fetchJsonWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (res.ok) return res.json();
    const errText = await res.text().catch(() => '');
    const error = new Error(`OpenRouter API error ${res.status}: ${errText || res.statusText}`);
    error.status = res.status;
    const retryAfter = Number(res.headers.get('retry-after'));
    error.retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
    throw error;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutError = new Error(`OpenRouter request timed out after ${config.requestTimeoutMs}ms`);
      timeoutError.status = 408;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isRetriable(error) {
  return !error.status || error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function transcribeVoiceNote(audioBuffer, mimeType = 'audio/ogg') {
  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) {
    throw new Error('Voice note did not contain audio data');
  }

  const format = mimeType.toLowerCase().includes('ogg') ? 'ogg' : 'wav';
  const data = await fetchJsonWithTimeout(OPENROUTER_TRANSCRIPTION_URL, {
    method: 'POST',
    headers: getOpenRouterHeaders(),
    body: JSON.stringify({
      model: config.openRouterTranscriptionModel,
      input_audio: {
        data: audioBuffer.toString('base64'),
        format,
      },
    }),
  });

  return typeof data.text === 'string' ? data.text.trim() : '';
}
function parseStructuredResponse(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('[openrouterClient] Failed to parse model output as JSON:', raw);
    const match = raw?.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
    const salvaged = match ? match[1].replace(/\\"/g, '"') : null;
    return {
      reply: salvaged || "Thanks for your message — I'm away right now but will get back to you soon.",
      needsLiveData: false,
      tasks: [],
    };
  }
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];

  return tasks
    .filter((item) => item && typeof item.task === 'string' && item.task.trim())
    .map((item) => ({
      task: item.task.trim(),
      kind: item.kind === 'meeting' ? 'meeting' : 'action',
      scheduledFor: typeof item.scheduledFor === 'string' && item.scheduledFor.trim()
        ? item.scheduledFor.trim()
        : null,
    }));
}

function extractSourceLinks(message) {
  const seen = new Set();
  const sources = [];

  // OpenRouter normalizes web search citations into message.annotations.
  for (const annotation of message?.annotations || []) {
    if (annotation?.type !== 'url_citation') continue;
    const citation = annotation.url_citation || {};
    const url = citation.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = citation.title || 'Source';
    sources.push(`[${title}](${url})`);
    if (sources.length >= 2) break;
  }

  return sources;
}

function addSources(answer, message) {
  const sources = extractSourceLinks(message);
  if (!sources.length) return answer;
  return `${answer}\n\nSources: ${sources.join(' · ')}`;
}

async function getLiveAnswer(messageText) {
  console.info('[live-search] Requesting web-grounded answer');
  const data = await callOpenRouter({
    model: config.openRouterLiveModel,
    systemPrompt: LIVE_ANSWER_PROMPT,
    userPrompt: `Current date and time in ${config.timeZone}: ${currentZonedIso(config.timeZone)}
User question: ${messageText}`,
    temperature: 0.2,
    maxTokens: 700,
    extraBody: {
      plugins: [{ id: 'web', engine: config.webSearchEngine, max_results: 3 }],
    },
  });

  const message = data.choices?.[0]?.message;
  const answer = (message?.content || '').trim();
  console.info(`[live-search] ${answer ? 'Answer received' : 'No answer returned'}`);
  return answer ? addSources(answer, message) : '';
}

/**
 * @param {string} messageText - incoming message content
 * @param {string} senderName - display name of sender, if known
 * @returns {Promise<{reply: string, tasks: Array<{task: string, kind: string, scheduledFor: string | null}>}>}
 */
async function processMessage(messageText, senderName, assistantProfile = 'away') {
  if (isLikelyLiveQuestion(messageText)) {
    const reply = await getLiveAnswer(messageText);
    return {
      reply: reply || "I couldn't find a verified current answer for that right now. Please check the official website or try again shortly.",
      tasks: [],
    };
  }

  const data = await callOpenRouter({
    model: config.openRouterModel,
    systemPrompt: assistantProfile === 'advisor' ? ADVISOR_SYSTEM_PROMPT : SYSTEM_PROMPT,
    userPrompt: `Current date and time in ${config.timeZone}: ${currentZonedIso(config.timeZone)}
Sender: ${senderName || 'Unknown'}
Message: ${messageText}`,
    temperature: 0.4,
    maxTokens: 1024,
    jsonMode: true,
  });

  const rawContent = data.choices?.[0]?.message?.content;
  const parsed = parseStructuredResponse(rawContent);
  let reply = typeof parsed.reply === 'string' ? parsed.reply : '';

  if (parsed.needsLiveData) {
    try {
      const liveAnswer = await getLiveAnswer(messageText);
      if (liveAnswer) reply = liveAnswer;
    } catch (err) {
      console.error('[openrouterClient] Live answer failed, falling back:', err.message);
      reply = reply || "I couldn't pull up live data for that right now — I'll check and follow up.";
    }
  }

  return {
    reply,
    tasks: normalizeTasks(parsed.tasks),
  };
}

function isLikelyLiveQuestion(text) {
  const normalized = (text || '').toLowerCase();
  const currentSignal = /\b(?:today|latest|current|right now|live|now|aaj|aj)\b/.test(normalized);
  const liveTopic = /\b(?:weather|temperature|forecast|gold|rate|price|exchange|currency|dollar|rupee|news|score|match|schedule|availability|stock|market|bank|timing|timings|hours)\b/.test(normalized);
  const businessHoursQuestion = /\b(?:bank|branch|office|shop|market)\b.*\b(?:time|timing|timings|hours|open|close|closing)\b|\b(?:time|timing|timings|hours|open|close|closing)\b.*\b(?:bank|branch|office|shop|market)\b/.test(normalized);
  return (currentSignal && liveTopic) || businessHoursQuestion;
}

module.exports = { processMessage, transcribeVoiceNote };
