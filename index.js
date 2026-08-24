const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  areJidsSameUser,
  downloadMediaMessage,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

const config = require('./src/config');
const awayMode = require('./src/awayMode');
const openrouterClient = require('./src/openrouterClient');
const taskStore = require('./src/taskStore');
const googleCalendar = require('./src/googleCalendar');
const { currentZonedIso, formatTimestamp } = require('./src/time');
const {
  assertUserId,
  getSessionPath,
  readSessionMeta,
  writeSessionMeta,
  listUserIds,
} = require('./src/sessionStore');
const {
  appendContactLog,
  readLastReplyTimestamps,
  writeLastReplyTimestamp,
  rememberProcessedMessage,
} = require('./src/dataStore');

const logger = pino({ level: 'info' });
const MAX_PROCESSED_IDS = 2000;

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async register(userId, pairingNumber = null, replaceSavedLink = false) {
    assertUserId(userId);
    if (replaceSavedLink) {
      await this.stop(userId);
      fs.rmSync(getSessionPath(userId, 'baileys_auth_info'), { recursive: true, force: true });
      writeSessionMeta(userId, { ownerJid: null, status: 'registered', reLinkedAt: new Date().toISOString() });
    }
    writeSessionMeta(userId, { status: 'registered' });
    return this.start(userId, pairingNumber);
  }

  async start(userId, pairingNumber = null) {
    assertUserId(userId);
    const existing = this.sessions.get(userId);
    if (existing?.running || existing?.starting) return existing;

    const session = existing || {
      userId,
      sock: null,
      running: false,
      starting: false,
      manuallyStopped: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      processedMessageIds: new Set(),
      ownerAlertIds: new Map(),
      lastReplyAtByChat: new Map(Object.entries(readLastReplyTimestamps(userId))),
    };
    if (pairingNumber) {
      const normalizedNumber = pairingNumber.replace(/\D/g, '');
      if (normalizedNumber.length < 8 || normalizedNumber.length > 15) {
        throw new Error('Pairing number must include country code and contain 8-15 digits.');
      }
      session.pairingNumber = normalizedNumber;
    }
    session.manuallyStopped = false;
    session.starting = true;
    session.connectionStatus = 'starting';
    session.linkError = null;
    this.sessions.set(userId, session);

    try {
      const { state, saveCreds } = await useMultiFileAuthState(getSessionPath(userId, 'baileys_auth_info'));
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });

      session.sock = sock;
      session.running = true;
      session.starting = false;

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update) => this.handleConnectionUpdate(session, state, sock, update));
      sock.ev.on('messages.update', (updates) => this.handleMessageUpdates(session, updates));
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

  async requestPairingCodeWhenReady(session, state, sock) {
    if (session.pairingInProgress || !session.pairingNumber) return;
    session.pairingInProgress = true;

    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (session.sock !== sock || state.creds.registered || session.manuallyStopped) return;
        // The first request runs after the QR/pairing-ready event. Retries wait
        // briefly in case WhatsApp is still completing its transport handshake.
        if (attempt > 1) await wait(1500 * (attempt - 1));
        try {
          const pairingCode = await sock.requestPairingCode(session.pairingNumber);
          session.pairingCode = pairingCode;
          session.lastQrMatrix = null;
          console.log(`\n[${session.userId}] WhatsApp pairing code: ${pairingCode}\nOn that phone open WhatsApp > Linked devices > Link a device > Link with phone number instead, then enter this code.\n`);
          logger.info({ userId: session.userId }, 'WhatsApp pairing code generated');
          return;
        } catch (err) {
          logger.warn({ err, userId: session.userId, attempt }, 'Pairing code request was not ready; retrying');
        }
      }
      logger.error({ userId: session.userId }, 'Could not generate pairing code after retries. Check internet and run the register-pair command again.');
      session.linkError = 'WhatsApp could not generate a pairing code. Use QR linking, or stop this session and try again after a minute.';
    } finally {
      session.pairingInProgress = false;
    }
  }

  async stop(userId) {
    const session = this.sessions.get(userId);
    if (!session) return false;
    session.manuallyStopped = true;
    session.running = false;
    clearTimeout(session.reconnectTimer);
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

  handleConnectionUpdate(session, state, sock, update) {
    const { connection, lastDisconnect, qr } = update;
    const { userId } = session;

    // Ignore events emitted by a socket that was replaced during reconnect.
    if (session.sock !== sock) return;

    if (qr && !session.pairingNumber) {
      // QR and pairing-code flows are kept separate in the dashboard. This
      // prevents a code-link request from unexpectedly showing a QR instead.
      session.lastQrMatrix = createQrMatrix(qr);
    }

    if (qr && session.pairingNumber && !state.creds.registered) {
      session.connectionStatus = 'linking';
      // The QR event is the pairing-ready signal used by Baileys' own example.
      // Requesting the code before this point can trigger a 401 disconnect.
      void this.requestPairingCodeWhenReady(session, state, sock);
    } else if (qr) {
      session.connectionStatus = 'linking';
      console.log(`\n[${userId}] Scan this QR code in WhatsApp → Linked Devices:\n`);
      session.pairingCode = null;
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      session.connectionStatus = 'connected';
      session.reconnectAttempt = 0;
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
      session.lastQrMatrix = null;
      session.pairingCode = null;
      const ownerJid = jidNormalizedUser(state.creds.me?.lid || state.creds.me?.id);
      writeSessionMeta(userId, { ownerJid, status: 'connected', connectedAt: new Date().toISOString() });
      logger.info({ userId, ownerJid }, 'WhatsApp user session connected');
      return;
    }

    if (connection !== 'close') return;

    const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    session.running = false;
    session.connectionStatus = loggedOut ? 'logged_out' : 'reconnecting';
    session.sock = null;

    if (loggedOut) {
      session.linkError = 'WhatsApp closed this link attempt. Generate a fresh QR code or pairing code and try again.';
      writeSessionMeta(userId, { status: 'logged_out', loggedOutAt: new Date().toISOString() });
      logger.warn({ userId, statusCode }, 'User session logged out; run the register command again to link a new device');
      return;
    }

    if (!session.manuallyStopped) {
      const delayMs = Math.min(5000 * (2 ** session.reconnectAttempt), 60000);
      session.reconnectAttempt += 1;
      logger.warn({ userId, statusCode, retryInMs: delayMs }, 'User session disconnected; reconnecting this user only');
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = setTimeout(() => this.start(userId).catch((err) => {
        logger.error({ err, userId }, 'User session reconnect failed');
      }), delayMs);
    }
  }

  rememberMessageId(session, id) {
    session.processedMessageIds.add(id);
    if (session.processedMessageIds.size > MAX_PROCESSED_IDS) {
      session.processedMessageIds.delete(session.processedMessageIds.values().next().value);
    }
  }

  handleMessageUpdates(session, updates) {
    for (const update of updates) {
      const id = update.key?.id;
      if (!id || !session.ownerAlertIds.has(id)) continue;
      const alert = session.ownerAlertIds.get(id);
      logger.info({ userId: session.userId, messageId: id, status: update.update?.status, ...alert }, 'Owner alert delivery status updated');
      if (update.update?.status !== undefined) session.ownerAlertIds.delete(id);
    }
  }

  async sendOwnerAlert(session, ownerJid, text, metadata = {}) {
    const sent = await session.sock.sendMessage(ownerJid, { text, linkPreview: false });
    if (sent?.key?.id) session.ownerAlertIds.set(sent.key.id, metadata);
    logger.info({ userId: session.userId, ownerJid, messageId: sent?.key?.id, ...metadata }, 'Owner alert submitted to WhatsApp');
    return sent;
  }

  async isOwnerSelfChat(session, chatJid) {
    if (!chatJid) return false;
    const ownerJid = getOwnerJid(session.userId);
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
    const rawCommand = text.trim();
    const cmd = rawCommand.toLowerCase();
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
    if (cmd === '!calendar connect') {
      try {
        const url = await googleCalendar.startAuthorization(userId);
        await sock.sendMessage(replyJid, { text: `${googleCalendar.authorizationInstructions()}\n\n${url}`, linkPreview: false });
      } catch (err) {
        await sock.sendMessage(replyJid, { text: `Google Calendar connection could not start: ${err.message}`, linkPreview: false });
      }
      return true;
    }
    if (cmd === '!calendar status') {
      const status = await googleCalendar.getStatus(userId);
      const message = !status.configured
        ? 'Google Calendar credentials are missing from .env.'
        : status.connected
          ? `Google Calendar is connected to ${status.email || 'your Google account'} (primary calendar). Reminder: ${config.googleCalendarReminderMinutes} minutes.`
          : `Google Calendar is not connected. Send !calendar connect.${status.error ? `\nLast check: ${status.error}` : ''}`;
      await sock.sendMessage(replyJid, { text: message, linkPreview: false });
      return true;
    }
    if (cmd === '!calendar disconnect') {
      googleCalendar.disconnect(userId);
      await sock.sendMessage(replyJid, { text: 'Google Calendar has been disconnected for this WhatsApp session.', linkPreview: false });
      return true;
    }
    const addMatch = rawCommand.match(/^!calendar add\s+(\d+)$/i);
    if (addMatch) {
      const tasks = taskStore.readTasks(userId).filter((task) => !task.done);
      const task = tasks[Number(addMatch[1]) - 1];
      if (!task) {
        await sock.sendMessage(replyJid, { text: 'Task number not found. Send !tasks first.', linkPreview: false });
        return true;
      }
      try {
        const event = await googleCalendar.createEvent(userId, task);
        await sock.sendMessage(replyJid, {
          text: event.alreadyExists
            ? `This task is already in Google Calendar. ${event.eventLink || ''}`
            : `Google Calendar event created with a ${config.googleCalendarReminderMinutes}-minute reminder.\n${event.eventLink || ''}`,
          linkPreview: false,
        });
      } catch (err) {
        await sock.sendMessage(replyJid, { text: `Could not create calendar event: ${err.message}`, linkPreview: false });
      }
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

  async forwardTimeOrLocation(session, msg, chatJid, text, source = 'Message') {
    const ownerJid = getOwnerJid(session.userId);
    if (!ownerJid) return;

    const location = msg.message?.locationMessage;
    const hasTimeReference = containsSchedulingTimeReference(text);
    const isMeetingRequest = containsMeetingReference(text);
    if (!location && !hasTimeReference && !isMeetingRequest) return;

    const sender = msg.pushName || chatJid;
    const timestamp = new Date(Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const latitude = location?.degreesLatitude;
    const longitude = location?.degreesLongitude;
    const mapLink = Number.isFinite(latitude) && Number.isFinite(longitude)
      ? `https://www.google.com/maps?q=${latitude},${longitude}`
      : null;
    const venue = location?.name || location?.address || extractVenue(text) || 'Not provided';
    const place = mapLink || venue;
    const time = extractTimeReference(text) || 'Not specified';
    const task = isMeetingRequest
      ? 'Review and confirm the meeting request.'
      : 'Review the time/date mentioned in this message.';

    await this.sendOwnerAlert(session, ownerJid, [
        '📅 Meeting / Time Alert',
        `Place: ${place}`,
        `Time: ${time}`,
        `Venue: ${venue}`,
        `Sender name: ${sender}`,
        `Task: ${task}`,
        `Received: ${formatTimestamp(timestamp, config.timeZone)} (${config.timeZone})`,
        '',
        `Original ${source}:`,
        text || '(A location was shared without text.)',
      ].join('\n'), { sender, hasTimeReference, isMeetingRequest, kind: 'meeting_time' });
  }

  async automaticallyAddMeetingsToCalendar(session, tasks) {
    const meetings = tasks.filter((task) => task.kind === 'meeting' && task.scheduledFor);
    if (!meetings.length) return;

    for (const task of meetings) {
      try {
        const event = await googleCalendar.createEvent(session.userId, task);
        if (!event.alreadyExists) {
          logger.info({ userId: session.userId, taskId: task.id, eventId: event.eventId }, 'Meeting automatically added to Google Calendar');
          await session.sock.sendMessage(getOwnerJid(session.userId), {
            text: `[Calendar] Added: ${task.task}\nReminder: ${config.googleCalendarReminderMinutes} minutes.\n${event.eventLink || ''}`,
            linkPreview: false,
          });
        }
      } catch (err) {
        // A disconnected calendar must never prevent the WhatsApp reply or task save.
        logger.warn({ err, userId: session.userId, taskId: task.id }, 'Could not automatically add meeting to Google Calendar');
      }
    }
  }

  assistantProfile(userId) {
    return readSessionMeta(userId).assistantProfile === 'advisor' ? 'advisor' : 'away';
  }

  fallbackReply(userId) {
    return this.assistantProfile(userId) === 'advisor'
      ? "I'm here with you. Please tell me a little more about what happened."
      : 'Thanks for your message. The owner is away right now and will get back to you soon.';
  }

  offlineResult(userId, text) {
    if (containsMeetingReference(text)) {
      const scheduledFor = parseExplicitSchedule(text);
      return {
        reply: scheduledFor
          ? 'Thank you. I have noted the meeting details and forwarded them to the owner.'
          : 'Thank you. I have forwarded the meeting details to the owner for confirmation.',
        tasks: [{
          task: 'Review and confirm the meeting request',
          kind: 'meeting',
          scheduledFor,
        }],
      };
    }
    if (containsLiveQuestion(text)) {
      return {
        reply: "I can't access verified live information right now. Please try again shortly or check the official source.",
        tasks: [],
      };
    }
    return { reply: this.fallbackReply(userId), tasks: [] };
  }

  async handleIncoming(session, msg) {
    const id = msg.key?.id;
    if (!id || session.processedMessageIds.has(id) || !rememberProcessedMessage(session.userId, id)) return;
    this.rememberMessageId(session, id);

    const chatJid = msg.key.remoteJid;
    let text = extractText(msg.message);
    let source = 'Message';
    const { userId, sock } = session;

    logger.info({ userId, chatJid, fromMe: msg.key.fromMe, text: text.slice(0, 80) }, 'Incoming message event');

    if (msg.key.fromMe) {
      if (await this.isOwnerSelfChat(session, chatJid)) {
        await this.handleOwnerCommand(session, text, chatJid);
      }
      return;
    }

    if (!chatJid || chatJid === 'status@broadcast') return;

    if (!text && msg.message?.audioMessage?.ptt) {
      try {
        const audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
        text = await openrouterClient.transcribeVoiceNote(audioBuffer, msg.message.audioMessage.mimetype);
        source = 'Voice-note transcript';
        logger.info({ userId, chatJid, transcript: text.slice(0, 80) }, 'Voice note transcribed');
      } catch (err) {
        logger.error({ err, userId, chatJid }, 'Voice-note transcription failed');
        return;
      }
    }

    // Privacy notice: this is intentionally limited to WhatsApp JID, push name,
    // message timestamp, and any location the contact explicitly shared.
    this.logContactMessage(session, msg, msg.key.participant || chatJid);
    await this.forwardTimeOrLocation(session, msg, chatJid, text, source);

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
      const quickReply = getQuickReply(text);
      let result = quickReply ? { reply: quickReply, tasks: [] } : null;
      if (!result && containsMeetingReference(text)) {
        result = this.offlineResult(userId, text);
      }
      if (!result) {
        try {
          result = await openrouterClient.processMessage(
            text.slice(0, config.maxInputChars),
            senderName,
            this.assistantProfile(userId),
          );
        } catch (err) {
          logger.error({ err, userId, chatJid }, 'AI reply failed; using profile fallback');
          result = this.offlineResult(userId, text);
        }
      }

      const { reply, tasks } = result;
      if (reply) {
        await sock.sendMessage(chatJid, { text: reply, linkPreview: false });
        const repliedAt = Date.now();
        session.lastReplyAtByChat.set(chatJid, repliedAt);
        writeLastReplyTimestamp(userId, chatJid, repliedAt);
      }

      if (tasks.length > 0) {
        const savedTasks = taskStore.appendTasks(userId, tasks, { senderJid: chatJid, senderName, chatJid, originalMessage: text });
        await this.automaticallyAddMeetingsToCalendar(session, savedTasks);
        const ownerJid = getOwnerJid(userId);
        if (!ownerJid) return;

        const scheduledTasks = tasks.filter((task) => task.kind === 'meeting' || task.scheduledFor);
        // Time and meeting messages were already forwarded above in a structured
        // format. Persist the extracted task, but avoid sending the owner twice.
        if (scheduledTasks.length > 0) return;
        const taskSummary = tasks.map((task) => `- ${task.task}${task.scheduledFor ? ` — ${task.scheduledFor}` : ''}`).join('\n');
        await sock.sendMessage(ownerJid, {
          text: `🆕 New task(s) from ${senderName || chatJid}:\n${taskSummary}`,
          linkPreview: false,
        });
      }
    } finally {
      await sock.sendPresenceUpdate('paused', chatJid).catch(() => undefined);
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createQrMatrix(value) {
  const code = new QRCode(-1, QRErrorCorrectLevel.L);
  code.addData(value);
  code.make();
  return code.modules.map((row) => row.map(Boolean));
}

function getDashboardSessions(manager) {
  return listUserIds().map((userId) => {
    const meta = readSessionMeta(userId);
    const active = manager.sessions.get(userId);
    return {
      userId,
      status: active?.connectionStatus || meta.status || 'registered',
      ownerJid: meta.ownerJid || null,
      pairingCode: active?.pairingCode || null,
      qrMatrix: active?.lastQrMatrix || null,
      linkError: active?.linkError || null,
    };
  });
}

function extractText(message) {
  if (!message) return '';
  return (message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.videoMessage?.caption || '').trim();
}

function getOwnerJid(userId) {
  return jidNormalizedUser(readSessionMeta(userId).ownerJid);
}

function containsTimeReference(text) {
  if (!text) return false;
  const explicitTimeOrDate = /\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)|\d{1,2}\s*o['’]?clock|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|midnight|baje|baja|bjy|bje)\b/i;
  if (explicitTimeOrDate.test(text)) return true;

  // “Today” alone is common in live questions, e.g. today's weather. It is
  // treated as scheduling only when the message also describes an action.
  const relativeTime = /\b(?:today|tomorrow|tonight|this\s+(?:morning|afternoon|evening|weekend)|next\s+week|morning|afternoon|evening)\b/i;
  const schedulingContext = /\b(?:meet(?:ing)?|appointment|schedule|call|visit|come|deadline|remind|task|mulaqat)\b/i;
  return relativeTime.test(text) && schedulingContext.test(text);
  return /\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)|\d{1,2}\s*o['’]?clock|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?|today|tomorrow|tonight|this\s+(?:morning|afternoon|evening|weekend)|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|noon|midnight|baje|baja|bjy|bje)\b/i.test(text);
}

function containsMeetingReference(text) {
  return /\b(?:meeting|meet|appointment|session|schedule|call|mulaqat|meeting\s+hai)\b/i.test(text || '');
}

function containsSchedulingTimeReference(text) {
  if (!text) return false;
  const explicitTimeOrDate = /\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)|\d{1,2}\s*o['’]?clock|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|midnight|baje|baja|bjy|bje)\b/i;
  if (explicitTimeOrDate.test(text)) return true;
  const relativeTime = /\b(?:today|tomorrow|tonight|this\s+(?:morning|afternoon|evening|weekend)|next\s+week|morning|afternoon|evening)\b/i;
  const schedulingContext = /\b(?:meet(?:ing)?|appointment|session|schedule|call|visit|come|deadline|remind|task|mulaqat)\b/i;
  return relativeTime.test(text) && schedulingContext.test(text);
}

function parseExplicitSchedule(text) {
  if (!text) return null;
  const clock = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
  const oClock = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*o['’]?\s*clock\b/i);
  if (!clock && !oClock) return null;

  const timeMatch = clock || oClock;
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (clock) {
    const meridiem = clock[3].toLowerCase().replace(/\./g, '');
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  }

  const now = currentZonedIso(config.timeZone);
  const offset = now.slice(-6);
  let [year, month, day] = now.slice(0, 10).split('-').map(Number);
  const monthNames = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
    october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  const namedDate = text.match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b/i);
  const numericDate = text.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/);

  if (namedDate) {
    day = Number(namedDate[1]);
    month = monthNames[namedDate[2].toLowerCase()];
    year = Number(namedDate[3]);
  } else if (numericDate) {
    day = Number(numericDate[1]);
    month = Number(numericDate[2]);
    year = Number(numericDate[3]);
  } else if (/\btomorrow\b/i.test(text)) {
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  } else if (!/\btoday\b/i.test(text)) {
    return null;
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  const makeCandidate = (candidateHour) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(candidateHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${offset}`;

  if (oClock) {
    if (!/\btoday\b/i.test(text)) return null;
    const possibleHours = hour === 12 ? [0, 12] : [hour, hour + 12];
    const next = possibleHours
      .map(makeCandidate)
      .filter((value) => new Date(value).getTime() > Date.now())
      .sort((left, right) => new Date(left) - new Date(right))[0];
    return next || null;
  }

  const candidate = makeCandidate(hour);
  if (Number.isNaN(new Date(candidate).getTime())) return null;
  return candidate;
}

function containsLiveQuestion(text) {
  const normalized = (text || '').toLowerCase();
  const currentSignal = /\b(?:today|latest|current|right now|live|now|aaj|aj)\b/.test(normalized);
  const liveTopic = /\b(?:weather|temperature|forecast|gold|silver|rate|price|exchange|currency|dollar|rupee|news|score|match|availability|stock|market|bank|timing|timings|hours)\b/.test(normalized);
  return currentSignal && liveTopic;
}

function extractTimeReference(text) {
  return text?.match(/\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)|\d{1,2}\s*o['’]?clock|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?|today|tomorrow|tonight|this\s+(?:morning|afternoon|evening|weekend)|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|noon|midnight|baje|baja|bjy|bje)\b/i)?.[0] || '';
}

function extractVenue(text) {
  const explicit = text?.match(/\b(?:venue|location)\s*[:=-]?\s*([^,.!?\n]{2,80})/i);
  const meetingAt = text?.match(/\b(?:meet(?:ing)?|appointment|call)\s+at\s+([^,.!?\n]{2,80})/i);
  const venue = explicit?.[1] || meetingAt?.[1] || '';
  return venue.replace(/\s+(?:at|on)\s+(?:\d|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday).*$/i, '').trim();
}

function getQuickReply(text) {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/\b(?:ass+alamo?\s*ala?ikum|as+alamo?\s*ala?ikum|salaam|salam)\b/.test(normalized)) {
    return 'Wa Alaikum Assalam!';
  }

  if (/\b(?:how are you|how r u|kaisa(?: ho| haan| hain)?|kaise(?: ho| haan| hain)?|kesa(?: ho| haan| hain)?|kese(?: ho| haan| hain)?|kasa(?: ho| haan| hain)?|kya haal|kia haal)\b/.test(normalized)) {
    return 'Alhamdulillah, main theek hoon. Aap sunayein?';
  }

  if (/\b(?:what can you do|what you can do|how can you help|aap kya kar sakte|tum kya kar sakte)\b/.test(normalized)) {
    return 'I can answer general questions, help with everyday concerns, note meeting details, forward reminders to the owner, and—when connected—add scheduled meetings to Google Calendar.';
  }

  return '';
}

function printUsage() {
  console.log('Usage: node index.js [register <userId> | register-pair <userId> <phoneNumber> | set-profile-advisor <userId> | start <userId> | stop <userId> | list | calendar-status <userId>]');
}

async function main() {
  const manager = new SessionManager();
  const [command, userId, phoneNumber] = process.argv.slice(2);

  console.warn('Privacy notice: this service stores each contact\'s WhatsApp JID, display name, message timestamp, and any location they explicitly share. Voice notes are sent to the configured transcription provider. Ensure you have an appropriate notice and lawful basis before operating it.');

  if (command === 'register') {
    if (!userId) return printUsage();
    await manager.register(userId);
    console.log(`[${userId}] Registration started. Scan the QR code above to link WhatsApp.`);
  } else if (command === 'register-pair') {
    if (!userId || !phoneNumber) return printUsage();
    await manager.register(userId, phoneNumber);
    console.log(`[${userId}] Pairing-code registration started.`);
  } else if (command === 'set-profile-advisor') {
    if (!userId) return printUsage();
    assertUserId(userId);
    writeSessionMeta(userId, { assistantProfile: 'advisor' });
    awayMode.setEnabled(userId, true);
    console.log(`[${userId}] Advisor profile enabled. Away Mode is ON.`);
    return;
  } else if (command === 'start') {
    if (!userId) return printUsage();
    await manager.start(userId);
  } else if (command === 'stop') {
    if (!userId) return printUsage();
    await manager.stop(userId);
  } else if (command === 'list') {
    console.table(listUserIds().map((id) => readSessionMeta(id)));
    return;
  } else if (command === 'calendar-status') {
    if (!userId) return printUsage();
    const status = await googleCalendar.getStatus(userId);
    console.table([status]);
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

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'Fatal service startup error');
    process.exit(1);
  });
}

module.exports = { SessionManager, getDashboardSessions, parseExplicitSchedule };
