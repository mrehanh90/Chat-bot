# WhatsApp AI Assistant

A multi-session WhatsApp away-mode assistant built with Baileys and OpenRouter.
Each registered owner has an isolated WhatsApp session, settings, task list, and
local data store.

> Baileys is an unofficial WhatsApp Web client. Automated use may violate
> WhatsApp terms or cause account restrictions. Use it only with an account you
> own and keep rate limits enabled.

## Features

- Independent WhatsApp sessions under `sessions/<userId>/`.
- Away-mode replies controlled from the owner's self-chat.
- Direct replies for common greetings, Salaam, and "how are you / kaisa ho".
- General and personal-topic replies while Away Mode is enabled.
- Live web-grounded answers for common current questions: weather, gold rates,
  news, exchange rates, scores, market data, and business hours.
- Voice-note transcription, then the same reply/task/time workflow as text.
- Meeting, date/time, and explicitly shared WhatsApp-location alerts sent to
  the owner's self-chat in a structured format.
- SQLite storage for contacts, tasks, reply timestamps, and persistent message
  deduplication.
- Per-session reconnect backoff and failure isolation.

## Requirements

- Node.js 22.5 or later
- A WhatsApp account for each owner
- An OpenRouter API key
- OpenRouter credit for dependable live web search and voice transcription

## Install

```powershell
cd D:\Projects\whatsapp-assistant
npm.cmd install
```

## Configure

Copy the template and add your OpenRouter key:

```powershell
Copy-Item .env.example .env
```

Important `.env` settings:

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here

# General replies and task extraction. Free models can be rate-limited.
OPENROUTER_MODEL=openai/gpt-oss-20b:free

# Used for current/live questions. Requires OpenRouter balance.
OPENROUTER_LIVE_MODEL=openrouter/auto
OPENROUTER_FALLBACK_MODELS=
OPENROUTER_WEB_SEARCH_ENGINE=exa

# Request reliability.
OPENROUTER_REQUEST_TIMEOUT_MS=30000
OPENROUTER_MAX_RETRIES=2

# Voice notes. This model may have usage charges.
OPENROUTER_TRANSCRIPTION_MODEL=openai/whisper-large-v3

# Local timezone used in meeting alerts and AI scheduling context.
APP_TIME_ZONE=Asia/Karachi

IGNORE_GROUPS=true
MAX_INPUT_CHARS=2000
MIN_REPLY_INTERVAL_MS=15000
```

Do not commit `.env` or `sessions/`.

## Register and link WhatsApp

Create a session and show its QR code:

```powershell
npm run register -- rehan
```

Scan the QR code in WhatsApp:

`Settings -> Linked Devices -> Link a Device`

Start every registered session later with:

```powershell
npm start
```

List sessions:

```powershell
npm run list-sessions
```

To relink one owner with a new QR code, stop the bot and remove only that
owner's authentication folder:

```powershell
Ctrl+C
Remove-Item -Recurse -Force .\sessions\rehan\baileys_auth_info
npm run register -- rehan
```

## Owner commands

Send these from the owner's own WhatsApp self-chat:

```text
!away on
!away off
!away status
!tasks
```

Normal AI replies require Away Mode to be on. Meeting/time/location alerts are
forwarded to the owner self-chat even when Away Mode is off.

## Message behavior

| Incoming message | Bot behavior |
| --- | --- |
| `AssalamoAlaikum` | Replies `Wa Alaikum Assalam!` |
| `Kaisa ho?` / `How are you?` | Replies `Alhamdulillah, main theek hoon. Aap sunayein?` |
| General or personal topic | Gives a concise reply while Away Mode is on |
| Current weather, gold rate, news, exchange rate, score | Uses live web-grounded search |
| Bank hours/timings | Uses live web-grounded search |
| Meeting, date, time, or shared location | Sends the owner a structured alert and stores AI-extracted tasks when available |
| WhatsApp voice note | Transcribes it, then handles it like a text message |

The flood guard allows one AI reply per chat every `MIN_REPLY_INTERVAL_MS`
(15 seconds by default). This is about four replies per minute for one contact.

## Meeting and location alert format

```text
Meeting / Time Alert
Place: ...
Time: ...
Venue: ...
Sender name: ...
Task: ...
Received: ... (Asia/Karachi)

Original Message:
...
```

## Local data and privacy

Per-user data is stored in:

```text
sessions/<userId>/assistant.sqlite
```

The database stores the sender's WhatsApp JID, display name, message timestamp,
tasks, reply timestamps, and latitude/longitude only when the sender explicitly
shares a WhatsApp location. It does not collect device model or IP address.

Voice-note audio is sent to the configured transcription provider. Provide an
appropriate privacy notice and make sure you have a lawful basis before using
this service.

## Live-search and voice-note troubleshooting

- `429`: the selected model/provider is rate-limited. The bot retries temporary
  failures, then uses configured fallback models when available.
- `402` for voice transcription: add OpenRouter credit. Audio transcription has
  a minimum account-balance requirement.
- `No answer returned`: a web search completed without a usable answer. The bot
  tells the sender to check an official source or try again.
- Live search requires OpenRouter credit even when a normal text model is free.
- `ENOTFOUND web.whatsapp.com`: fix the computer's internet or DNS connection.

## Run with PM2

```powershell
npm.cmd exec pm2 start ecosystem.config.js
npm.cmd exec pm2 save
```

Useful commands:

```powershell
npm.cmd exec pm2 status
npm.cmd exec pm2 logs whatsapp-assistant
npm.cmd exec pm2 restart whatsapp-assistant
npm.cmd exec pm2 stop whatsapp-assistant
```

## Security

Never share or commit:

- `OPENROUTER_API_KEY`
- `.env`
- `sessions/`
- WhatsApp credential files
- `assistant.sqlite`

If an API key was pasted into a chat, committed to Git, or otherwise exposed,
revoke it in OpenRouter and create a replacement key.
