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
const {
  assertUserId,
  getSessionPath,
  readSessionMeta,
  writeSessionMeta,
  listUserIds,
  appendContactLog,
  readLastReplyTimestamps,
  writeLastReplyTimestamp,
} = require('./src/sessionStore');

const logger = pino({ level: 'info' });
const MAX_PROCESSED_IDS = 2000;

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async register(userId) {
    assertUserId(userId);
    writeSessionMeta(userId, { status: 'registered' });
    await this.start(userId);
  }

  async start(userId) {
    assertUserId(userId);
    const existing = this.sessions.get(userId);
    if (existing?.running || existing?.starting) return existing;

    const session = existing || {
      userId,
      sock: null,
      running: false,
      starting: false,
      manuallyStopped: false,
      processedMessageIds: new Set(),
      lastReplyAtByChat: new Map(Object.entries(readLastReplyTimestamps(userId))),
    };
    session.manuallyStopped = false;
    session.starting = true;
    this.sessions.set(userId, session);

    try {
      const { state, saveCreds } = await useMultiFileAuthState(getSessionPath(userId, 'baileys_auth_info'));
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });

      session.sock = sock;
      session.running = true;
      session.starting = false;

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update) => this.handleConnectionUpdate(session, state, update));
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          try {
            await this.handleIncoming(session, msg);
          } catch (err) {
            logger.error({ err, userId }, 'Error handling user session message');
          }
        }
      });

      logger.info({ userId }, 'WhatsApp session started');
      return session;
    } catch (err) {
      session.starting = false;
      session.running = false;
      logger.error({ err, userId }, 'Failed to start user session');
      throw err;
    }
  }

  async stop(userId) {
    const session = this.sessions.get(userId);
    if (!session) return false;
    session.manuallyStopped = true;
    session.running = false;
    try {
      session.sock?.end?.(undefined);
    } catch (err) {
      logger.warn({ err, userId }, 'Error stopping user session');
    }
    this.sessions.delete(userId);
    writeSessionMeta(userId, { status: 'stopped' });
    return true;
  }

  async stopAll() {
    await Promise.all([...this.sessions.keys()].map((userId) => this.stop(userId)));
  }

  handleConnectionUpdate(session, state, update) {
    const { connection, lastDisconnect, qr } = update;
    const { userId } = session;

    if (qr) {
      console.log(`\n[${userId}] Scan this QR code in WhatsApp → Linked Devices:\n`);
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      const ownerJid = state.creds.me?.lid || state.creds.me?.id || null;
      writeSessionMeta(userId, { ownerJid, status: 'connected', connectedAt: new Date().toISOString() });
      logger.info({ userId, ownerJid }, 'WhatsApp user session connected');
      return;
    }

    if (connection !== 'close') return;

    const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    session.running = false;
    session.sock = null;

    if (loggedOut) {
      writeSessionMeta(userId, { status: 'logged_out', loggedOutAt: new Date().toISOString() });
      logger.warn({ userId, statusCode }, 'User session logged out; run the register command again to link a new device');
      return;
    }

    if (!session.manuallyStopped) {
      logger.warn({ userId, statusCode }, 'User session disconnected; reconnecting this user only');
      setTimeout(() => this.start(userId).catch((err) => {
        logger.error({ err, userId }, 'User session reconnect failed');
      }), 5000);
    }
  }

  rememberMessageId(session, id) {
    session.processedMessageIds.add(id);
    if (session.processedMessageIds.size > MAX_PROCESSED_IDS) {
      session.processedMessageIds.delete(session.processedMessageIds.values().next().value);
    }
  }

  async isOwnerSelfChat(session, chatJid) {
    if (!chatJid) return false;
    const ownerJid = readSessionMeta(session.userId).ownerJid;
    if (!ownerJid) return false;
    if (areJidsSameUser(chatJid, ownerJid)) return true;

    try {
      const ownerLid = await session.sock.signalRepository.lidMapping.getLIDForPN(ownerJid);
      return ownerLid ? areJidsSameUser(chatJid, ownerLid) : false;
    } catch {
      return false;
    }
  }

  async handleOwnerCommand(session, text, replyJid) {
    const cmd = text.trim().toLowerCase();
    const { userId, sock } = session;
    if (cmd === '!away on') {
      awayMode.setEnabled(userId, true);
      await sock.sendMessage(replyJid, { text: '✅ Away mode ENABLED. Incoming messages will get AI replies.', linkPreview: false });
      return true;
    }
    if (cmd === '!away off') {
      awayMode.setEnabled(userId, false);
      await sock.sendMessage(replyJid, { text: '✅ Away mode DISABLED. You are handling messages yourself.', linkPreview: false });
      return true;
    }
    if (cmd === '!away status') {
      await sock.sendMessage(replyJid, { text: `Away mode is currently ${awayMode.isEnabled(userId) ? 'ON' : 'OFF'}.`, linkPreview: false });
      return true;
    }
    if (cmd === '!tasks') {
      const tasks = taskStore.readTasks(userId).filter((task) => !task.done);
      const list = tasks.length
        ? tasks.map((task, index) => `${index + 1}. ${task.task} (from ${task.senderName || task.from})`).join('\n')
        : 'No pending tasks.';
      await sock.sendMessage(replyJid, { text: `📋 Pending tasks:\n${list}`, linkPreview: false });
      return true;
    }
    return false;
  }

  logContactMessage(session, msg, contactJid) {
    const location = msg.message?.locationMessage;
    appendContactLog(session.userId, {
      contactJid,
      pushName: msg.pushName || null,
      timestamp: new Date(Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      ...(location ? {
        location: {
          latitude: location.degreesLatitude,
          longitude: location.degreesLongitude,
        },
      } : {}),
    });
  }

  async handleIncoming(session, msg) {
    const id = msg.key?.id;
    if (!id || session.processedMessageIds.has(id)) return;
    this.rememberMessageId(session, id);

    const chatJid = msg.key.remoteJid;
    const text = extractText(msg.message);
    const { userId, sock } = session;

    logger.info({ userId, chatJid, fromMe: msg.key.fromMe, text: text.slice(0, 80) }, 'Incoming message event');

    if (msg.key.fromMe) {
      if (await this.isOwnerSelfChat(session, chatJid)) {
        await this.handleOwnerCommand(session, text, chatJid);
      }
      return;
    }

    if (!chatJid || chatJid === 'status@broadcast') return;

    // Privacy notice: this is intentionally limited to WhatsApp JID, push name,
    // message timestamp, and any location the contact explicitly shared.
    this.logContactMessage(session, msg, msg.key.participant || chatJid);

    // Contacts are still logged above, but group auto-replies remain opt-in.
    if (config.ignoreGroups && chatJid.endsWith('@g.us')) return;

    if (!text || !awayMode.isEnabled(userId)) return;

    const now = Date.now();
    const lastReplyAt = session.lastReplyAtByChat.get(chatJid) || 0;
    if (now - lastReplyAt < config.minReplyIntervalMs) {
      logger.info({ userId, chatJid }, 'Skipping AI reply within flood-guard window');
      return;
    }

    await sock.sendPresenceUpdate('composing', chatJid);
    try {
      const senderName = msg.pushName || undefined;
      const { reply, tasks } = await openrouterClient.processMessage(text.slice(0, config.maxInputChars), senderName);
      if (reply) {
        await sock.sendMessage(chatJid, { text: reply, linkPreview: false });
        const repliedAt = Date.now();
        session.lastReplyAtByChat.set(chatJid, repliedAt);
        writeLastReplyTimestamp(userId, chatJid, repliedAt);
      }

      if (tasks.length > 0) {
        taskStore.appendTasks(userId, tasks, { senderJid: chatJid, senderName, chatJid, originalMessage: text });
        const ownerJid = readSessionMeta(userId).ownerJid;
        if (!ownerJid) return;

        const scheduledTasks = tasks.filter((task) => task.kind === 'meeting' || task.scheduledFor);
        const taskSummary = tasks.map((task) => `- ${task.task}${task.scheduledFor ? ` — ${task.scheduledFor}` : ''}`).join('\n');
        await sock.sendMessage(ownerJid, {
          text: scheduledTasks.length
            ? `📅 Scheduled item from ${senderName || chatJid}:\n${taskSummary}\n\nOriginal message:\n${text}`
            : `🆕 New task(s) from ${senderName || chatJid}:\n${taskSummary}`,
          linkPreview: false,
        });
      }
    } finally {
      await sock.sendPresenceUpdate('paused', chatJid).catch(() => undefined);
    }
  }
}

function extractText(message) {
  if (!message) return '';
  return (message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.videoMessage?.caption || '').trim();
}

function printUsage() {
  console.log('Usage: node index.js [register <userId> | start <userId> | stop <userId> | list]');
}

async function main() {
  const manager = new SessionManager();
  const [command, userId] = process.argv.slice(2);

  console.warn('Privacy notice: this service stores each contact\'s WhatsApp JID, display name, message timestamp, and any location they explicitly share. Ensure you have an appropriate notice and lawful basis before operating it.');

  if (command === 'register') {
    if (!userId) return printUsage();
    await manager.register(userId);
    console.log(`[${userId}] Registration started. Scan the QR code above to link WhatsApp.`);
  } else if (command === 'start') {
    if (!userId) return printUsage();
    await manager.start(userId);
  } else if (command === 'stop') {
    if (!userId) return printUsage();
    await manager.stop(userId);
  } else if (command === 'list') {
    console.table(listUserIds().map((id) => readSessionMeta(id)));
    return;
  } else if (!command) {
    const users = listUserIds();
    if (!users.length) {
      console.log('No registered users. Run: node index.js register <userId>');
      return;
    }
    await Promise.all(users.map((id) => manager.start(id)));
    console.log(`Started ${users.length} independent WhatsApp session(s).`);
  } else {
    printUsage();
    return;
  }

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Stopping all user sessions');
    await manager.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal service startup error');
  process.exit(1);
});
