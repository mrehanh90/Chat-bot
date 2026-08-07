const fs = require('fs');
const path = require('path');

const TASKS_FILE = path.join(__dirname, '..', 'tasks.json');

function readTasks() {
  try {
    const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function appendTasks(newTasks, meta) {
  if (!Array.isArray(newTasks) || newTasks.length === 0) return;
  const tasks = readTasks();
  const timestamp = new Date().toISOString();
  for (const item of newTasks) {
    // Accept the old string format too, so existing callers and saved tasks
    // remain compatible while new tasks retain meeting details.
    const task = typeof item === 'string' ? item : item?.task;
    if (typeof task !== 'string' || !task.trim()) continue;

    tasks.push({
      task: task.trim(),
      from: meta.senderJid,
      senderName: meta.senderName || null,
      chat: meta.chatJid,
      kind: item?.kind === 'meeting' ? 'meeting' : 'action',
      scheduledFor: typeof item?.scheduledFor === 'string' ? item.scheduledFor : null,
      originalMessage: meta.originalMessage || null,
      createdAt: timestamp,
      done: false,
    });
  }
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

module.exports = { readTasks, appendTasks };
