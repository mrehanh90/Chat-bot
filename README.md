# WhatsApp AI Assistant

A multi-session WhatsApp assistant built with Baileys and OpenRouter. Each
registered owner has an isolated WhatsApp session, settings, task list, and
local data store. A session can use either Away Mode or Advisor Mode.

> Baileys is an unofficial WhatsApp Web client. Automated use may violate
> WhatsApp terms or cause account restrictions. Use it only with an account you
> own and keep rate limits enabled.

## Features

- Independent WhatsApp sessions under `sessions/<userId>/`.
- Away-mode replies controlled from the owner's self-chat.
- Advisor Mode for supportive conversations and practical advice in English or
  Roman Urdu, matching the sender's language.
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

# Google Calendar (optional)
GOOGLE_CALENDAR_CLIENT_ID=
GOOGLE_CALENDAR_CLIENT_SECRET=
# Optional public HTTPS URL for mobile Calendar approval, for example:
# https://calendar.example.com/oauth2callback
GOOGLE_CALENDAR_REDIRECT_URI=
GOOGLE_CALENDAR_REDIRECT_PORT=3000
GOOGLE_CALENDAR_CALLBACK_HOST=127.0.0.1
GOOGLE_CALENDAR_REMINDER_MINUTES=30
CALENDAR_TOKEN_ENCRYPTION_KEY=

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

### Link by phone number instead of QR

For a new WhatsApp session, request a pairing code instead of a QR code. Use
the WhatsApp number with country code and no `+` or leading zero:

```powershell
npm run register:pair -- advisor 923001234567
```

On that phone, open **WhatsApp → Linked devices → Link a device → Link with
phone number instead**, then enter the code printed in the terminal.

Use one WhatsApp number for only one running user session. Linking the same
number to two active sessions can cause duplicate replies and separate task or
Calendar records.

An already-linked assistant does not need either a QR or a pairing code to
change its behavior.

### Enable Advisor Mode for the current assistant

To change the existing `rehan` assistant into an English/Roman-Urdu advice and
conversation assistant, run:

```powershell
npm run profile:advisor -- rehan
```

Advisor Mode automatically enables Away Mode so it can respond immediately.
It can continue conversations, give supportive everyday and relationship
advice, and retains the same task, meeting alert, Calendar, live-information,
and voice-note features. It does not replace professional medical, legal,
financial, or emergency support.

Scan the QR code in WhatsApp:

`Settings -> Linked Devices -> Link a Device`

Start every registered session later with:

```powershell
npm start
```

Start only one named session (recommended while testing a new assistant):

```powershell
npm run start:session -- advisor
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
!calendar connect
!calendar status
!calendar add 1
!calendar disconnect
```

Normal AI replies require Away Mode to be on. Meeting/time/location alerts are
forwarded to the owner self-chat even when Away Mode is off.

`!calendar connect` sends a Google authorization link. By default it must be
opened on the same computer running the bot because the callback uses
`127.0.0.1`. To authorize on a mobile phone, configure a public HTTPS callback:

1. Create a **Web application** OAuth client in the same Google Cloud project.
2. Add an exact authorized redirect URI such as
   `https://calendar.example.com/oauth2callback` in Google Cloud.
3. Point `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET` to
   that Web client, then set `GOOGLE_CALENDAR_REDIRECT_URI` to the same HTTPS
   address.
4. Use a secure reverse proxy or tunnel to forward that public callback to the
   running bot at `127.0.0.1:3000`. Keep
   `GOOGLE_CALENDAR_CALLBACK_HOST=127.0.0.1` unless the proxy is on another
   machine.

With the public HTTPS callback configured, the `!calendar connect` link can be
opened and approved on a phone. The bot must remain running until approval is
complete. Use `!calendar status` afterward to confirm the connection.
Meetings the AI extracts with a valid date and time are automatically added to
the connected user's primary Google Calendar with the configured reminder.
`!calendar add 1` remains available to manually add an older saved task.

## Message behavior

| Incoming message | Bot behavior |
| --- | --- |
| `AssalamoAlaikum` | Replies `Wa Alaikum Assalam!` |
| `Kaisa ho?` / `How are you?` | Replies `Alhamdulillah, main theek hoon. Aap sunayein?` |
| General or personal topic | Away Mode: concise owner-away reply. Advisor Mode: helpful ongoing English/Roman-Urdu conversation. |
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

## WhatsApp linking troubleshooting

- A QR code repeating in the terminal means that session is not linked. A QR
  expires quickly; Baileys requests a fresh one after the old QR expires. Scan
  the newest QR once and wait for the log line `WhatsApp user session connected`.
- If you only want to use one assistant during testing, start only that session
  with `npm run start:session -- <userId>` instead of `npm start`, which starts
  every registered session.
- If a session repeatedly shows `not logged in, attempting registration`, its
  `baileys_auth_info` credentials are missing, invalid, or were removed. Relink
  that one session with QR or pairing code.
- Do not run two sessions linked to the same WhatsApp number. That can cause
  duplicate replies and separate task/Calendar records.

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
