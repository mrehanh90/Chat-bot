# WhatsApp AI Assistant (Away Mode + Task Extraction)

A personal automation that connects to your own WhatsApp account via
[Baileys](https://github.com/WhiskeySockets/Baileys) (an unofficial WebSocket-based
WhatsApp Web client), and — when you toggle "away mode" on — has Gemini reply
courteously to incoming messages and extract action items into a task list.

> **Important — read before deploying**
> Baileys is an *unofficial* client that reverse-engineers the WhatsApp Web
> protocol. It is not sanctioned by Meta, and using any automated client
> outside WhatsApp's official Business API technically violates WhatsApp's
> Terms of Service. Accounts using unofficial clients — especially ones that
> auto-send messages — can be rate-limited or banned. Mitigate risk by:
> - Only auto-replying to real 1:1 messages, never bulk-sending or spamming
> - Keeping the flood guard and character limits in place
> - Not running this on a number you can't afford to lose
> - Treating `!away on` as opt-in, not something that fires on every message

---

## 1. Architecture

```
                 ┌─────────────────────────────┐
                 │   Oracle Cloud (Ampere A1)   │
                 │   Ubuntu 22.04, Node 18+     │
                 │                              │
  WhatsApp  ───► │  Baileys WebSocket client    │
  (your phone)   │       │                      │
                 │       ▼                      │
                 │  messages.upsert listener    │
                 │       │                      │
                 │  fromMe? ──yes──► owner       │
                 │       │           command     │
                 │       no          handler     │
                 │       ▼           (!away on)  │
                 │  away mode ON? ──no──► ignore │
                 │       │yes                    │
                 │       ▼                       │
                 │  Google Gemini (JSON mode)    │
                 │   → { reply, tasks[] }        │
                 │       │                       │
                 │       ├─► sendMessage(reply)  │
                 │       └─► tasks.json + notify │
                 │             your own chat     │
                 │                              │
                 │  PM2 (autorestart, boot)     │
                 └─────────────────────────────┘
```

Key design choices:
- **Away mode toggle** is controlled by sending yourself (`BOT_OWNER_NUMBER`,
  your own JID) the message `!away on` / `!away off` / `!away status` from
  any linked device. State persists to `away-state.json` so a restart doesn't
  lose it.
- **Task extraction** stores structured items in `tasks.json` and pings your
  own chat with a summary — no separate database needed for a personal setup.
- **Flood guard** (`MIN_REPLY_INTERVAL_MS`) prevents rapid-fire messages in
  one chat from triggering repeated Gemini calls.
- **Groups are ignored by default** (`IGNORE_GROUPS=true`) — auto-replying in
  group chats is the fastest way to look like spam and get flagged.

---

## 2. Provision the Oracle Cloud instance

1. In OCI Console, create a **VM.Standard.A1.Flex** (Ampere) instance:
   - Image: **Ubuntu 22.04** (or later)
   - Shape: 1–2 OCPUs / 6–12 GB RAM is more than enough (Always Free tier works)
   - Add your SSH public key during creation
2. Note the instance's public IP.
3. In the VCN's security list / NSG, you don't need to open any inbound
   ports for this bot — it only makes outbound connections to WhatsApp and
   Gemini. Leave inbound restricted to SSH (22) from your IP.
4. SSH in:
   ```bash
   ssh ubuntu@<your-instance-public-ip>
   ```

---

## 3. Install Node.js and PM2

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential

node -v   # should print v20.x
npm -v

# Install PM2 globally
sudo npm install -g pm2
```

---

## 4. Deploy the project

Upload this project directory to the server (via `scp`, `rsync`, or `git`):

```bash
# From your local machine
scp -r whatsapp-assistant ubuntu@<instance-ip>:~/whatsapp-assistant
```

Then on the server:

```bash
cd ~/whatsapp-assistant
npm install
cp .env.example .env
nano .env   # fill in GEMINI_API_KEY and BOT_OWNER_NUMBER
```

`BOT_OWNER_NUMBER` is your own WhatsApp JID in the form
`<countrycode><number>@s.whatsapp.net` (no `+`, no spaces), e.g.
`923392554286@s.whatsapp.net`.

---

## 5. First run — link your WhatsApp account

Run the bot directly first (not under PM2) so you can scan the QR code:

```bash
node index.js
```

A QR code renders in the terminal. On your phone:
**WhatsApp → Settings → Linked Devices → Link a Device**, then scan it.

Once connected you'll see `WhatsApp connection established.` in the logs.
Credentials are saved to `baileys_auth_info/` — **treat this folder like a
password**; anyone with it can act as your WhatsApp account. Never commit it
to git (already covered by `.gitignore`).

Stop the process with `Ctrl+C` once you've confirmed it connects.

---

## 6. Run 24/7 with PM2

```bash
pm2 start ecosystem.config.js
pm2 save                # persist the process list
pm2 startup             # prints a systemd command — copy/paste and run it
```

`pm2 startup` outputs something like:
```
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
```
Run exactly what it prints, then `pm2 save` again. This ensures PM2 (and
your bot) restarts automatically on server reboot.

Useful commands:
```bash
pm2 status                     # check it's running
pm2 logs whatsapp-assistant    # tail logs
pm2 restart whatsapp-assistant # restart after code/env changes
pm2 stop whatsapp-assistant
```

If the WhatsApp session ever gets logged out (e.g. you unlink the device
from your phone), delete `baileys_auth_info/` and re-run `node index.js`
manually to re-scan the QR code, then restart PM2.

---

## 7. Using it day-to-day

From your own WhatsApp (any linked device, including your phone), message
**yourself**:

| Command         | Effect                                            |
|-----------------|----------------------------------------------------|
| `!away on`      | Enable AI auto-reply + task extraction             |
| `!away off`     | Disable — you handle messages yourself             |
| `!away status`  | Check current state                                |
| `!tasks`        | List pending extracted tasks                       |

When away mode is on, incoming 1:1 messages get a courteous Gemini reply and
any action items get appended to `tasks.json` and pushed to your own chat.

---

## 8. Extending it

- **Mark tasks done**: add a `!done <n>` command that flips `done: true` in
  `tasks.json` for the nth pending task.
- **Allow specific contacts to bypass away mode**: keep an allowlist of JIDs
  in `.env` and check it before calling Gemini.
- **Group support**: set `IGNORE_GROUPS=false` and consider only replying
  when explicitly @-mentioned, to avoid spamming group chats.
- **Persistent task backend**: swap `tasks.json` for SQLite/Postgres if the
  list grows large or you want a web UI on top.

---

## 9. File overview

```
whatsapp-assistant/
├── index.js                # main bot: connection, listener, routing
├── ecosystem.config.js     # PM2 process config
├── package.json
├── .env.example
├── .gitignore
├── src/
│   ├── config.js           # env loading/validation
│   ├── awayMode.js         # persisted away-mode toggle
│   ├── taskStore.js        # persisted extracted tasks
│   └── geminiClient.js    # Gemini call: reply + task extraction
├── baileys_auth_info/      # created on first run — WhatsApp session (secret!)
├── away-state.json         # created on first toggle
├── tasks.json              # created on first extracted task
└── logs/                   # PM2 output/error logs
```
#   C h a t - b o t  
 