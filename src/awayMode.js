const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'away-state.json');

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { enabled: false, updatedAt: null };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isEnabled() {
  return readState().enabled === true;
}

function setEnabled(enabled) {
  const state = { enabled, updatedAt: new Date().toISOString() };
  writeState(state);
  return state;
}

module.exports = { isEnabled, setEnabled };
