const fs = require('fs');
const { getSessionPath } = require('./sessionStore');

function taskFile(userId) {
  return getSessionPath(userId, 'tasks.json');
}

function readTasks(userId) {
  try {
    const tasks = JSON.parse(fs.readFileSync(taskFile(userId), 'utf8'));
    return Array.isArray(tasks) ? tasks : [];
  } catch {
    return [];
  }
}

function appendTasks(userId, newTasks, meta) {
  if (!Array.isArray(newTasks) || newTasks.length === 0) return;

  const tasks = readTasks(userId);
  const createdAt = new Date().toISOString();
  for (const item of newTasks) {
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
      createdAt,
      done: false,
    });
  }

  fs.writeFileSync(taskFile(userId), JSON.stringify(tasks, null, 2));
}

module.exports = { readTasks, appendTasks };
