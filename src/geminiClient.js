const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('./config');

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

const SYSTEM_PROMPT = `You are a helpful WhatsApp assistant replying on behalf of the phone's owner,
who is currently away.

Given one incoming WhatsApp message:
1. If it is a general, timeless question, answer it directly, briefly, and helpfully.
   Do not say the owner is away unless that is relevant. Never pretend to know live,
   current, or private information that you cannot verify (for example, today's price,
   live weather, or a current schedule). For those, explain the limitation briefly.
2. For personal requests, messages, or action items, write a short polite reply that
   says the owner is away and will follow up. Do not invent commitments, prices, dates,
   or facts.
3. Extract concrete owner action items. A meeting, appointment, callback, visit, or
   deadline with a date or time is a scheduled task. When its date and time are clear,
   provide scheduledFor as an ISO 8601 timestamp with the supplied offset. Otherwise,
   set scheduledFor to null. Do not guess missing dates or times.

Respond ONLY with JSON in exactly this shape:
{
  "reply": "<reply to send>",
  "tasks": [
    {
      "task": "<short imperative task>",
      "kind": "meeting" | "action",
      "scheduledFor": "<ISO 8601 timestamp>" | null
    }
  ]
}

No markdown fences or extra commentary.`;

const model = genAI.getGenerativeModel({
  model: config.geminiModel,
  systemInstruction: SYSTEM_PROMPT,
  generationConfig: {
    temperature: 0.4,
    maxOutputTokens: 1024,
    responseMimeType: 'application/json',
  },
});

/**
 * @param {string} messageText - incoming message content
 * @param {string} senderName - display name of sender, if known
 * @returns {Promise<{reply: string, tasks: Array<{task: string, kind: string, scheduledFor: string | null}>}>}
 */
async function processMessage(messageText, senderName) {
  // Pakistan Standard Time is UTC+05:00 year-round.
  const nowInPakistan = new Date(Date.now() + (5 * 60 * 60 * 1000))
    .toISOString()
    .replace('Z', '+05:00');
  const userContent = `Current date and time in Asia/Karachi: ${nowInPakistan}\nSender: ${senderName || 'Unknown'}\nMessage: ${messageText}`;

  const result = await model.generateContent(userContent);
  const raw = result.response.text() || '{}';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('[geminiClient] Failed to parse model output as JSON:', raw);
    // Try to salvage a usable reply if the JSON was cut off mid-string
    // (e.g. `{"reply": "Hello, thanks for...` with no closing quote/brace).
    const match = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
    const salvaged = match ? match[1].replace(/\\"/g, '"') : null;
    parsed = {
      reply: salvaged || "Thanks for your message — I'm away right now but will get back to you soon.",
      tasks: [],
    };
  }

  return {
    reply: typeof parsed.reply === 'string' ? parsed.reply : '',
    tasks: Array.isArray(parsed.tasks)
      ? parsed.tasks
        .filter((item) => item && typeof item.task === 'string' && item.task.trim())
        .map((item) => ({
          task: item.task.trim(),
          kind: item.kind === 'meeting' ? 'meeting' : 'action',
          scheduledFor: typeof item.scheduledFor === 'string' && item.scheduledFor.trim()
            ? item.scheduledFor.trim()
            : null,
        }))
      : [],
  };
}

module.exports = { processMessage };
