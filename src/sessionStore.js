const fs = require('fs');
const path = require('path');

const SESSIONS_ROOT = path.join(__dirname, '..', 'sessions');
const USER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function assertUserId(userId) {
  if (!USER_ID_PATTERN.test(userId || '')) {
    throw new Error('userId must contain only letters, numbers, underscores, or hyphens (1-64 characters).');
  }
}

function getSessionDir(userId) {
  assertUserId(userId);
  return path.join(SESSIONS_ROOT, userId);
}

function getSessionPath(userId, fileName) {
  const dir = getSessionDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}

function sessionMetaFile(userId) {
  return getSessionPath(userId, 'session.json');
}

function readSessionMeta(userId) {
  try {
    return JSON.parse(fs.readFileSync(sessionMetaFile(userId), 'utf8'));
  } catch {
    return { userId, ownerJid: null, createdAt: new Date().toISOString() };
  }
}

function writeSessionMeta(userId, updates) {
  const meta = { ...readSessionMeta(userId), ...updates, userId };
  fs.writeFileSync(sessionMetaFile(userId), JSON.stringify(meta, null, 2));
  return meta;
}

function listUserIds() {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  return fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && USER_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name);
}

function appendContactLog(userId, entry) {
  const file = getSessionPath(userId, 'contacts.json');
  let contacts = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    contacts = Array.isArray(parsed) ? parsed : [];
  } catch {
    // First entry for this user.
  }
  contacts.push(entry);
  fs.writeFileSync(file, JSON.stringify(contacts, null, 2));
}

function readLastReplyTimestamps(userId) {
  try {
    const timestamps = JSON.parse(fs.readFileSync(getSessionPath(userId, 'last-replies.json'), 'utf8'));
    return timestamps && typeof timestamps === 'object' ? timestamps : {};
  } catch {
    return {};
  }
}

function writeLastReplyTimestamp(userId, chatJid, timestamp) {
  const timestamps = readLastReplyTimestamps(userId);
  timestamps[chatJid] = timestamp;
  fs.writeFileSync(getSessionPath(userId, 'last-replies.json'), JSON.stringify(timestamps, null, 2));
}

module.exports = {
  SESSIONS_ROOT,
  assertUserId,
  getSessionDir,
  getSessionPath,
  readSessionMeta,
  writeSessionMeta,
  listUserIds,
  appendContactLog,
  readLastReplyTimestamps,
  writeLastReplyTimestamp,
};
