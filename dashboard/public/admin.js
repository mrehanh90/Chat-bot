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
      ? sessions.map((session) => `<tr><td>${escapeHtml(session.userId)}</td><td>${escapeHtml(session.status)}</td><td>${escapeHtml(session.ownerJid || '—')}</td><td><button data-stop="${escapeHtml(session.userId)}">Stop</button></td></tr>`).join('')
      : '<tr><td colspan="4">No sessions found.</td></tr>';
    document.querySelectorAll('[data-stop]').forEach((button) => {
      button.onclick = async () => { await api(`/api/sessions/${encodeURIComponent(button.dataset.stop)}/stop`, { method: 'POST' }); refresh(); };
    });
  } catch (error) {
    if (error.message === 'Admin login required.') location.assign('/admin/login');
  }
}

document.getElementById('logout').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }); location.assign('/admin/login'); };
refresh();
