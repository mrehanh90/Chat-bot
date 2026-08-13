# WhatsApp AI Assistant — OpenRouter

## Multi-user sessions

Each registered owner has an isolated WhatsApp session under `sessions/<userId>/`.
That folder contains the user's Baileys credentials, away-mode state, tasks,
contact log, and session metadata.

Register and link a user account by scanning the QR code:

```bash
npm run register -- alice
```

Start all registered user sessions:

```bash
npm start
```

List registered sessions:

```bash
npm run list-sessions
```

Each owner controls only their own session by sending themselves `!away on`,
`!away off`, `!away status`, or `!tasks` from a linked device.

> **Privacy notice:** The service stores a direct contact's WhatsApp JID,
> display name, message timestamp, and any location they explicitly share. It
> does not collect device model or IP address. Provide an appropriate notice and
> ensure a lawful basis before operating the service.

A personal WhatsApp assistant that connects to your own WhatsApp account through
Baileys. When Away Mode is enabled, it can generate replies, extract tasks, and
use OpenRouter's web-search server tool for questions that require current data.

> **Important:** Baileys is an unofficial WhatsApp Web client. Automated use can
> violate WhatsApp's terms and may result in rate limits or account restrictions.
> Use this only for a personal account and keep the existing flood guard/group
> protections enabled.

## What changed from the Groq version

- Replaced the Groq API with OpenRouter's OpenAI-compatible Chat Completions API.
- Default model: `openai/gpt-oss-20b:free`.
- Structured JSON output is still used for reply + task extraction.
- Live/current questions now use OpenRouter's `openrouter:web_search` server tool.
- Removed the old Groq-specific compound-search code.
- **The web-search part is not necessarily free**: OpenRouter currently charges
  for server-side web search depending on the search engine/provider, even when
  the selected LLM model is free. The free model itself has zero token pricing.
  See OpenRouter's current pricing/docs before enabling frequent live searches.

## 1. Install

```bash
npm install
```

Node.js 20+ is recommended/required by this project.

## 2. Configure `.env`

Copy the example:

```bash
cp .env.example .env
```

Then set:

```env
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=openai/gpt-oss-20b:free
OPENROUTER_LIVE_MODEL=openai/gpt-oss-20b:free
```

Do **not** commit `.env` or `sessions/`.

## 3. Link WhatsApp

Run:

```bash
npm run register -- alice
```

Scan the QR code from:

**WhatsApp → Settings → Linked Devices → Link a Device**

After linking, credentials and all user-specific data are stored locally in
`sessions/alice/`.

## 4. Enable Away Mode

From your own WhatsApp self-chat:

```text
!away on
```

Other commands:

```text
!away off
!away status
!tasks
```

## 5. How the AI flow works

```text
Incoming WhatsApp message
        |
        v
Away Mode enabled?
        |
       yes
        v
OpenRouter structured-output model
        |
        +---- normal question ----> reply
        |
        +---- current/latest -----> OpenRouter web_search
        |                              |
        |                              v
        |                         grounded reply
        |
        +---- action item --------> sessions/<userId>/tasks.json + owner notification
```

The model first decides whether the message needs live information. Only those
messages invoke the web-search tool.

## 6. Free-model note

OpenRouter currently lists `openai/gpt-oss-20b:free` as a free model and documents
that it supports structured outputs and tool use. Free-model availability and
rate limits can change, so you can switch `OPENROUTER_MODEL` without changing
the application code.

OpenRouter's `openrouter/free` router is another option if you want automatic
selection among currently available free models:

```env
OPENROUTER_MODEL=openrouter/free
```

For this project, the pinned `openai/gpt-oss-20b:free` default is preferable
because it makes behavior more predictable.

## 7. Running 24/7 with PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Useful commands:

```bash
pm2 status
pm2 logs whatsapp-assistant
pm2 restart whatsapp-assistant
pm2 stop whatsapp-assistant
```

## Security

Never share:

- `OPENROUTER_API_KEY`
- the `.env` file
- the `sessions/` directory
- WhatsApp session/credential JSON files

If an API key was previously placed in a repository or shared archive, revoke it
and create a new one.
