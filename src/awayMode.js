const fs = require('fs');
const path = require('path');
const { getSessionPath } = require('./sessionStore');

function stateFile(userId) {
  return getSessionPath(userId, 'away-state.json');
}

function readState(userId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(userId), 'utf8'));
  } catch {
    return { enabled: false, updatedAt: null };
  }
}

function setEnabled(userId, enabled) {
  const state = { enabled: Boolean(enabled), updatedAt: new Date().toISOString() };
  fs.writeFileSync(stateFile(userId), JSON.stringify(state, null, 2));
  return state;
}

function isEnabled(userId) {
  return readState(userId).enabled === true;
}

module.exports = { isEnabled, setEnabled };
