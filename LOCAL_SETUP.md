# Local Setup — OpenRouter

## Requirements

- Node.js 22.5+
- A WhatsApp account to link through Baileys
- An OpenRouter API key

## Install

```bash
npm install
```

## Configure

Copy `.env.example` to `.env` and set:

```env
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=openai/gpt-oss-20b:free
OPENROUTER_LIVE_MODEL=openrouter/auto
OPENROUTER_FALLBACK_MODELS=
OPENROUTER_REQUEST_TIMEOUT_MS=30000
OPENROUTER_MAX_RETRIES=2
```

Live web search and voice transcription need an OpenRouter balance; free shared
models can be rate-limited.

## Start

```bash
npm run register -- your-user-id
```

Scan the displayed QR code from WhatsApp:

**Settings → Linked Devices → Link a Device**

Then enable the assistant from your self-chat:

```text
!away on
```

Test with a normal message from another 1:1 WhatsApp account.

## Live-data behavior

For messages asking for current/latest information, the app uses OpenRouter's
`openrouter:web_search` server tool. Web search can have separate usage charges,
even when the selected model is free.

## Troubleshooting

If you see `401`, verify `OPENROUTER_API_KEY`.

If you see model errors, try another currently available OpenRouter model by
changing `OPENROUTER_MODEL` in `.env`.

If WhatsApp logs out, remove only
`sessions/<your-user-id>/baileys_auth_info/` and run the register command again.

Never commit `.env` or `sessions/`.
