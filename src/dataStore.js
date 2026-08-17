const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getSessionDir } = require('./sessionStore');

const databases = new Map();

function getDatabase(userId) {
  if (databases.has(userId)) return databases.get(userId);

  const db = new DatabaseSync(path.join(getSessionDir(userId), 'assistant.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contact_logs (
      id INTEGER PRIMARY KEY,
      contact_jid TEXT NOT NULL,
      push_name TEXT,
      received_at TEXT NOT NULL,
      latitude REAL,
      longitude REAL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      task TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      chat_jid TEXT NOT NULL,
      kind TEXT NOT NULL,
      scheduled_for TEXT,
      original_message TEXT,
      created_at TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS last_replies (
      chat_jid TEXT PRIMARY KEY,
      replied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS calendar_tokens (
      provider TEXT PRIMARY KEY,
      encrypted_token TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS calendar_events (
      task_id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_link TEXT,
      created_at TEXT NOT NULL
    );
  `);
  migrateLegacyJson(db, userId);
  databases.set(userId, db);
  return db;
}

function migrateLegacyJson(db, userId) {
  if (db.prepare("SELECT value FROM metadata WHERE key = 'legacy_json_migrated'").get()) return;
  const directory = getSessionDir(userId);
  const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')); } catch { return fallback; }
  };

  const contacts = readJson('contacts.json', []);
  if (Array.isArray(contacts)) {
    const insert = db.prepare('INSERT INTO contact_logs (contact_jid, push_name, received_at, latitude, longitude) VALUES (?, ?, ?, ?, ?)');
    for (const entry of contacts) {
      if (!entry?.contactJid || !entry?.timestamp) continue;
      insert.run(entry.contactJid, entry.pushName || null, entry.timestamp, entry.location?.latitude ?? null, entry.location?.longitude ?? null);
    }
  }

  const tasks = readJson('tasks.json', []);
  if (Array.isArray(tasks)) {
    const insert = db.prepare('INSERT INTO tasks (task, sender_jid, sender_name, chat_jid, kind, scheduled_for, original_message, created_at, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const task of tasks) {
      if (!task?.task || !task?.from || !task?.chat) continue;
      insert.run(task.task, task.from, task.senderName || null, task.chat, task.kind || 'action', task.scheduledFor || null, task.originalMessage || null, task.createdAt || new Date().toISOString(), task.done ? 1 : 0);
    }
  }

  const replies = readJson('last-replies.json', {});
  if (replies && typeof replies === 'object') {
    const insert = db.prepare('INSERT OR REPLACE INTO last_replies (chat_jid, replied_at) VALUES (?, ?)');
    for (const [chatJid, repliedAt] of Object.entries(replies)) {
      if (Number.isFinite(Number(repliedAt))) insert.run(chatJid, Number(repliedAt));
    }
  }

  db.prepare("INSERT INTO metadata (key, value) VALUES ('legacy_json_migrated', ?)").run(new Date().toISOString());
}

function appendContactLog(userId, entry) {
  const db = getDatabase(userId);
  db.prepare('INSERT INTO contact_logs (contact_jid, push_name, received_at, latitude, longitude) VALUES (?, ?, ?, ?, ?)')
    .run(entry.contactJid, entry.pushName || null, entry.timestamp, entry.location?.latitude ?? null, entry.location?.longitude ?? null);
}

function readLastReplyTimestamps(userId) {
  const rows = getDatabase(userId).prepare('SELECT chat_jid, replied_at FROM last_replies').all();
  return Object.fromEntries(rows.map((row) => [row.chat_jid, row.replied_at]));
}

function writeLastReplyTimestamp(userId, chatJid, timestamp) {
  getDatabase(userId).prepare('INSERT OR REPLACE INTO last_replies (chat_jid, replied_at) VALUES (?, ?)').run(chatJid, timestamp);
}

function rememberProcessedMessage(userId, messageId) {
  const db = getDatabase(userId);
  db.prepare('DELETE FROM processed_messages WHERE processed_at < ?')
    .run(new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString());
  const result = db
    .prepare('INSERT OR IGNORE INTO processed_messages (message_id, processed_at) VALUES (?, ?)')
    .run(messageId, new Date().toISOString());
  return result.changes === 1;
}

function appendTasks(userId, newTasks, meta) {
  if (!Array.isArray(newTasks) || !newTasks.length) return [];
  const insert = getDatabase(userId).prepare('INSERT INTO tasks (task, sender_jid, sender_name, chat_jid, kind, scheduled_for, original_message, created_at, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)');
  const createdAt = new Date().toISOString();
  const createdTasks = [];
  for (const item of newTasks) {
    const task = typeof item === 'string' ? item : item?.task;
    if (typeof task !== 'string' || !task.trim()) continue;
    const kind = item?.kind === 'meeting' ? 'meeting' : 'action';
    const scheduledFor = item?.scheduledFor || null;
    const result = insert.run(task.trim(), meta.senderJid, meta.senderName || null, meta.chatJid, kind, scheduledFor, meta.originalMessage || null, createdAt);
    createdTasks.push({
      id: Number(result.lastInsertRowid),
      task: task.trim(),
      from: meta.senderJid,
      senderName: meta.senderName || null,
      chat: meta.chatJid,
      kind,
      scheduledFor,
      originalMessage: meta.originalMessage || null,
      createdAt,
      done: false,
    });
  }
  return createdTasks;
}

function readTasks(userId) {
  return getDatabase(userId).prepare('SELECT id, task, sender_jid AS "from", sender_name AS senderName, chat_jid AS chat, kind, scheduled_for AS scheduledFor, original_message AS originalMessage, created_at AS createdAt, done FROM tasks ORDER BY id DESC').all()
    .map((task) => ({ ...task, done: Boolean(task.done) }));
}

function saveCalendarToken(userId, provider, encryptedToken) {
  getDatabase(userId).prepare('INSERT OR REPLACE INTO calendar_tokens (provider, encrypted_token, updated_at) VALUES (?, ?, ?)')
    .run(provider, encryptedToken, new Date().toISOString());
}

function readCalendarToken(userId, provider) {
  return getDatabase(userId).prepare('SELECT encrypted_token AS encryptedToken FROM calendar_tokens WHERE provider = ?').get(provider)?.encryptedToken || null;
}

function deleteCalendarToken(userId, provider) {
  getDatabase(userId).prepare('DELETE FROM calendar_tokens WHERE provider = ?').run(provider);
}

function readCalendarEvent(userId, taskId) {
  return getDatabase(userId).prepare('SELECT event_id AS eventId, event_link AS eventLink FROM calendar_events WHERE task_id = ?').get(taskId) || null;
}

function saveCalendarEvent(userId, taskId, eventId, eventLink) {
  getDatabase(userId).prepare('INSERT INTO calendar_events (task_id, provider, event_id, event_link, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, 'google', eventId, eventLink || null, new Date().toISOString());
}

module.exports = {
  appendContactLog,
  readLastReplyTimestamps,
  writeLastReplyTimestamp,
  rememberProcessedMessage,
  appendTasks,
  readTasks,
  saveCalendarToken,
  readCalendarToken,
  deleteCalendarToken,
  readCalendarEvent,
  saveCalendarEvent,
};
