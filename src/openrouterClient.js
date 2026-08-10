const config = require('./config');

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

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

const LIVE_ANSWER_PROMPT = `Answer the user's question using current, web-grounded information.
Be concise and accurate. Include essential units, date, or location when relevant.
Never invent facts. Do not mention being an AI or the owner's away status.
When web results are available, use them as evidence and include short source links in
markdown when useful. Return plain text only.`;

function getPakistanTimestamp() {
  // Pakistan Standard Time is UTC+05:00 year-round.
  return new Date(Date.now() + (5 * 60 * 60 * 1000))
    .toISOString()
    .replace('Z', '+05:00');
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
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
    ...extraBody,
  };

  if (jsonMode) {
    // OpenRouter exposes an OpenAI-compatible response_format.
    // The selected free model supports structured outputs.
    body.response_format = { type: 'json_object' };
  }

  if (tools?.length) {
    body.tools = tools;
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.openRouterApiKey}`,
  };

  // Optional headers recommended by OpenRouter for attribution/rankings.
  if (config.openRouterSiteUrl) headers['HTTP-Referer'] = config.openRouterSiteUrl;
  if (config.openRouterSiteName) headers['X-Title'] = config.openRouterSiteName;

  const res = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter API error ${res.status}: ${errText}`);
  }

  return res.json();
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
  const data = await callOpenRouter({
    model: config.openRouterLiveModel,
    systemPrompt: LIVE_ANSWER_PROMPT,
    userPrompt: `Current date and time in Asia/Karachi: ${getPakistanTimestamp()}
User question: ${messageText}`,
    temperature: 0.2,
    maxTokens: 700,
    tools: [
      {
        type: 'openrouter:web_search',
        parameters: {
          engine: 'auto',
          max_results: 3,
          max_total_results: 5,
          max_characters: 3000,
        },
      },
    ],
  });

  const message = data.choices?.[0]?.message;
  const answer = (message?.content || '').trim();
  return answer ? addSources(answer, message) : '';
}

/**
 * @param {string} messageText - incoming message content
 * @param {string} senderName - display name of sender, if known
 * @returns {Promise<{reply: string, tasks: Array<{task: string, kind: string, scheduledFor: string | null}>}>}
 */
async function processMessage(messageText, senderName) {
  const data = await callOpenRouter({
    model: config.openRouterModel,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Current date and time in Asia/Karachi: ${getPakistanTimestamp()}
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

module.exports = { processMessage };
