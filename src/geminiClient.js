const { GoogleGenAI } = require('@google/genai');
const config = require('./config');

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

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
Return plain text only; source links will be added separately.`;

function getPakistanTimestamp() {
  // Pakistan Standard Time is UTC+05:00 year-round.
  return new Date(Date.now() + (5 * 60 * 60 * 1000))
    .toISOString()
    .replace('Z', '+05:00');
}

function parseStructuredResponse(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('[geminiClient] Failed to parse model output as JSON:', raw);
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

function formatSources(response) {
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = [];
  const seen = new Set();

  for (const chunk of chunks) {
    const source = chunk.web;
    if (!source?.uri || seen.has(source.uri)) continue;
    seen.add(source.uri);
    sources.push(`[${source.title || 'Source'}](${source.uri})`);
    if (sources.length === 2) break;
  }

  return sources.length ? `\n\nSources: ${sources.join(' · ')}` : '';
}

async function getLiveAnswer(messageText) {
  const response = await ai.models.generateContent({
    model: config.geminiModel,
    contents: `Current time in Asia/Karachi: ${getPakistanTimestamp()}\nUser question: ${messageText}`,
    config: {
      systemInstruction: LIVE_ANSWER_PROMPT,
      tools: [{ googleSearch: {} }],
      temperature: 0.2,
      maxOutputTokens: 512,
    },
  });

  const answer = (response.text || '').trim();
  return answer ? `${answer}${formatSources(response)}` : '';
}

/**
 * @param {string} messageText - incoming message content
 * @param {string} senderName - display name of sender, if known
 * @returns {Promise<{reply: string, tasks: Array<{task: string, kind: string, scheduledFor: string | null}>}>}
 */
async function processMessage(messageText, senderName) {
  const response = await ai.models.generateContent({
    model: config.geminiModel,
    contents: `Current date and time in Asia/Karachi: ${getPakistanTimestamp()}\nSender: ${senderName || 'Unknown'}\nMessage: ${messageText}`,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.4,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  });

  const parsed = parseStructuredResponse(response.text);
  const reply = parsed.needsLiveData
    ? await getLiveAnswer(messageText)
    : (typeof parsed.reply === 'string' ? parsed.reply : '');

  return {
    reply,
    tasks: normalizeTasks(parsed.tasks),
  };
}

module.exports = { processMessage };
