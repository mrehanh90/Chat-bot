function escapeHtml(value) { const element = document.createElement('span'); element.textContent = value || ''; return element.innerHTML; }

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

async function refresh() {
  try {
    const { sessions } = await api('/api/sessions');
    document.getElementById('sessions').innerHTML = sessions.length
      ? sessions.map((session) => `<tr><td>${escapeHtml(session.userId)}</td><td>${escapeHtml(session.status)}</td><td>${escapeHtml(session.ownerJid || '—')}</td><td><button data-stop="${escapeHtml(session.userId)}">Stop</button> <button data-delete="${escapeHtml(session.userId)}">Delete</button></td></tr>`).join('')
      : '<tr><td colspan="4">No sessions found.</td></tr>';
    document.querySelectorAll('[data-stop]').forEach((button) => {
      button.onclick = async () => { await api(`/api/sessions/${encodeURIComponent(button.dataset.stop)}/stop`, { method: 'POST' }); refresh(); };
    });
    document.querySelectorAll('[data-delete]').forEach((button) => {
      button.onclick = async () => {
        const userId = button.dataset.delete;
        if (!confirm(`Permanently delete session "${userId}" and all of its saved data?`)) return;
        button.disabled = true;
        try {
          await api(`/api/sessions/${encodeURIComponent(userId)}`, { method: 'DELETE' });
          document.getElementById('message').textContent = `Session "${userId}" is being deleted.`;
          await refresh();
        } catch (error) {
          document.getElementById('message').textContent = error.message;
          button.disabled = false;
        }
      };
    });
  } catch (error) {
    if (error.message === 'Admin login required.') location.assign('/admin/login');
  }
}

document.getElementById('logout').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }); location.assign('/admin/login'); };
refresh();
