# Local Quickstart (test before deploying to Oracle Cloud)

This gets the bot running on your own laptop/desktop so you can validate the
whole flow — QR login, away-mode toggle, Gemini replies, task extraction —
before touching any cloud infrastructure. Nothing in the code differs
between local and cloud; only how you run/keep it alive changes.

---

## 1. Prerequisites

- **Node.js 18+** installed. Check with:
  ```bash
  node -v
  ```
  If missing, install from https://nodejs.org (LTS version) or via nvm.
- A WhatsApp account on your phone (this will be the account the bot logs
  into — use a real one you're comfortable testing with, ideally not your
  only/primary number until you trust the behavior).
- A Google Gemini API key (from Google AI Studio).

---

## 2. Install dependencies

From the project folder:

```bash
cd whatsapp-assistant
npm install
```

This also installs `nodemon` (dev-only) for auto-restart while you iterate
on the code.

---

## 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:
```
GEMINI_API_KEY=AIza...                          # your real key
GEMINI_MODEL=gemini-2.5-flash
BOT_OWNER_NUMBER=923392554286@s.whatsapp.net    # YOUR OWN number, no +, JID format
IGNORE_GROUPS=true
MAX_INPUT_CHARS=2000
MIN_REPLY_INTERVAL_MS=15000
```

`BOT_OWNER_NUMBER` must be your own WhatsApp number, since that's the chat
the bot listens on for `!away on/off/status` and `!tasks` commands, and
where it pings you about new extracted tasks.

---

## 4. Run it

```bash
npm start
```

or, for auto-restart on code changes while you're actively editing:

```bash
npm run dev
```

A QR code prints in your terminal. On your phone:
**WhatsApp → Settings → Linked Devices → Link a Device** → scan it.

Once linked you'll see:
```
Bot process started.
If this is your first run, scan the QR code above.
Away mode toggle: message yourself "..." with "!away on", ...
```

Your session is saved to `baileys_auth_info/` in the project folder — you
won't need to re-scan on subsequent `npm start` runs, even after quitting
with `Ctrl+C`, as long as that folder stays intact.

---

## 5. Test the flow

1. From your phone, open a chat **with yourself** (search your own number,
   or use the "Message yourself" option in WhatsApp) and send:
   ```
   !away on
   ```
   You should get an immediate confirmation reply from the bot.

2. From a **different** phone/number (a friend, a second SIM, or WhatsApp
   Web on another account), send a message to your bot's number, e.g.
   *"Hey, can you send me the invoice for last month by Friday?"*

3. Watch your terminal logs — you should see the bot process the message,
   call Gemini, and reply to the sender. Check your own chat too: you
   should get a "🆕 New task(s)" notification if the message implied an
   action item.

4. Send yourself `!tasks` to see the extracted list.

5. Send yourself `!away off` to stop auto-replies.

If any step doesn't work as expected, the terminal logs (pino output) will
show the error — most local issues are either a missing/invalid
`GEMINI_API_KEY` or `BOT_OWNER_NUMBER` not matching your actual JID exactly
(check the terminal logs for the JID format WhatsApp sends if unsure — it's
usually easiest to just message yourself once and read `msg.key.remoteJid`
from a debug log if it's not matching).

---

## 6. Stopping / resetting

- Stop the bot any time with `Ctrl+C` — the graceful shutdown handler
  closes the WhatsApp socket cleanly.
- To fully reset the WhatsApp link (e.g. testing the QR flow again), delete
  the session folder and restart:
  ```bash
  rm -rf baileys_auth_info
  npm start
  ```
- To reset away-mode/task state:
  ```bash
  rm -f away-state.json tasks.json
  ```

---

## 7. Once you're happy with it locally

Local runs stop the moment you close your terminal or your laptop sleeps —
fine for testing, not for real 24/7 use. Once the flow works the way you
want:

1. Follow the main **README.md** to provision the Oracle Cloud Ampere A1
   instance, install Node/PM2 there, and redeploy the exact same code.
2. You can reuse your local `.env` values (just re-paste them into the
   server's `.env` — don't upload the file itself insecurely).
3. **Don't copy `baileys_auth_info/` from local to the server** if you want
   a clean link — instead re-scan a fresh QR code on the server so the
   session is tied to that machine. Baileys sessions are portable in
   principle, but starting fresh avoids sync issues between two devices
   racing to use the same session state.
