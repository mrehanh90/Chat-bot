const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  areJidsSameUser,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

const config = require('./src/config');
const awayMode = require('./src/awayMode');
const openrouterClient = require('./src/openrouterClient');
const taskStore = require('./src/taskStore');

const logger = pino({ level: 'info' });

// De-dupe: Baileys can re-deliver messages on reconnect.
const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 2000;

// Basic per-chat flood guard so a chatty contact can't burn AI API quota.
const lastReplyAtByChat = new Map();

function rememberMessageId(id) {
  processedMessageIds.add(id);
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const first = processedMessageIds.values().next().value;
    processedMessageIds.delete(first);
  }
}

function extractText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ''
  ).trim();
}

async function handleOwnerCommand(sock, text, replyJid) {
  const cmd = text.trim().toLowerCase();
  if (cmd === '!away on') {
    awayMode.setEnabled(true);
    await sock.sendMessage(replyJid, { text: '✅ Away mode ENABLED. Incoming messages will get AI replies.', linkPreview: false });
    return true;
  }
  if (cmd === '!away off') {
    awayMode.setEnabled(false);
    await sock.sendMessage(replyJid, { text: '✅ Away mode DISABLED. You are handling messages yourself.', linkPreview: false });
    return true;
  }
  if (cmd === '!away status') {
    const enabled = awayMode.isEnabled();
    await sock.sendMessage(replyJid, { text: `Away mode is currently ${enabled ? 'ON' : 'OFF'}.`, linkPreview: false });
    return true;
  }
  if (cmd === '!tasks') {
    const tasks = taskStore.readTasks().filter((t) => !t.done);
    const list = tasks.length
      ? tasks.map((t, i) => `${i + 1}. ${t.task} (from ${t.senderName || t.from})`).join('\n')
      : 'No pending tasks.';
    await sock.sendMessage(replyJid, { text: `📋 Pending tasks:\n${list}`, linkPreview: false });
    return true;
  }
  return false;
}

async function isOwnerSelfChat(sock, chatJid) {
  if (!chatJid) return false;

  // A self-chat can be addressed by the phone-number JID or WhatsApp's opaque
  // LID. Baileys saves this LID-to-phone mapping after the connection opens.
  if (areJidsSameUser(chatJid, config.ownerJid)) return true;

  const ownerLid = await sock.signalRepository.lidMapping.getLIDForPN(config.ownerJid);
  return ownerLid ? areJidsSameUser(chatJid, ownerLid) : false;
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false, // we handle QR rendering ourselves below
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan this QR code with WhatsApp (Linked Devices):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      logger.warn(`Connection closed (code=${statusCode}). Logged out: ${loggedOut}`);
      if (!loggedOut) {
        connectToWhatsApp().then((sock) => {
          activeSocket = sock;
        });
      } else {
        logger.error('Session logged out. Delete baileys_auth_info/ and re-scan QR to reconnect.');
      }
    } else if (connection === 'open') {
      logger.info('WhatsApp connection established.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        await handleIncoming(sock, msg);
      } catch (err) {
        logger.error({ err }, 'Error handling message');
      }
    }
  });

  return sock;
}

async function handleIncoming(sock, msg) {
  const id = msg.key?.id;
  if (!id || processedMessageIds.has(id)) return;
  rememberMessageId(id);

  const chatJid = msg.key.remoteJid;
  const text = extractText(msg.message);

  logger.info(
    { chatJid, fromMe: msg.key.fromMe, text: text.slice(0, 80) },
    'Incoming message event'
  );

  // 1) Messages WE sent (fromMe): only commands from our self-chat are valid.
  if (msg.key.fromMe) {
    const isOwnerChat = await isOwnerSelfChat(sock, chatJid);

    if (isOwnerChat && (text.startsWith('!away') || text === '!tasks')) {
      await handleOwnerCommand(sock, text, chatJid);
    }
    return;
  }

  // 2) Skip group chats unless explicitly enabled.
  if (config.ignoreGroups && chatJid.endsWith('@g.us')) return;

  // 3) Skip status broadcasts / non-chat updates.
  if (chatJid === 'status@broadcast') return;

  if (!text) return; // ignore non-text messages (images, stickers, etc.) for now

  // 4) Only act if away mode is on.
  if (!awayMode.isEnabled()) return;

  // 5) Basic per-chat flood guard.
  const now = Date.now();
  const last = lastReplyAtByChat.get(chatJid) || 0;
  if (now - last < config.minReplyIntervalMs) {
    logger.info(`Skipping AI reply to ${chatJid}: within flood-guard window.`);
    return;
  }

  const senderName = msg.pushName || undefined;
  const trimmedText = text.slice(0, config.maxInputChars);

  // SHOW "TYPING..." STATUS
  await sock.sendPresenceUpdate('composing', chatJid);

  try {
    const { reply, tasks } = await openrouterClient.processMessage(trimmedText, senderName);

    if (reply) {
      // DISABLED LINK PREVIEWS
      await sock.sendMessage(chatJid, { text: reply, linkPreview: false });
      lastReplyAtByChat.set(chatJid, Date.now()); // use fresh timestamp
    }

    if (tasks.length > 0) {
      taskStore.appendTasks(tasks, {
        senderJid: chatJid,
        senderName,
        chatJid,
        originalMessage: text,
      });

      const scheduledTasks = tasks.filter((task) => task.kind === 'meeting' || task.scheduledFor);
      const taskSummary = tasks.map((task) => {
        const when = task.scheduledFor ? ` — ${task.scheduledFor}` : '';
        return `- ${task.task}${when}`;
      }).join('\n');

      // DISABLED LINK PREVIEWS FOR OWNER FORWARDING
      await sock.sendMessage(config.ownerJid, {
        text: scheduledTasks.length > 0
          ? `📅 Scheduled item from ${senderName || chatJid}:\n${taskSummary}\n\nOriginal message:\n${text}`
          : `🆕 New task(s) from ${senderName || chatJid}:\n${taskSummary}`,
        linkPreview: false 
      });
    }
  } catch (error) {
    logger.error({ error }, 'Error processing AI response');
  } finally {
    // CLEAR "TYPING..." STATUS
    await sock.sendPresenceUpdate('paused', chatJid);
  }
}

let activeSocket = null;

connectToWhatsApp()
  .then((sock) => {
    activeSocket = sock;
    console.log('\n----------------------------------------------------');
    console.log(' Bot process started.');
    console.log(' If this is your first run, scan the QR code above.');
    console.log(` Away mode toggle: message yourself "${config.ownerJid}"`);
    console.log('   with "!away on", "!away off", "!away status", "!tasks"');
    console.log(' Press Ctrl+C to stop.');
    console.log('----------------------------------------------------\n');
  })
  .catch((err) => {
    logger.error({ err }, 'Fatal error starting bot');
    process.exit(1);
  });

function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  try {
    activeSocket?.end?.(undefined);
  } catch (err) {
    logger.warn({ err }, 'Error while closing socket');
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));