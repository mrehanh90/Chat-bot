const byId = (id) => document.getElementById(id);
let selectedUserId = '';
let selectedMethod = 'qr';

function setMessage(text) {
  byId('message').textContent = text;
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function drawQr(matrix) {
  const canvas = byId('qr');
  const size = matrix.length;
  const scale = Math.max(1, Math.floor(336 / size));
  canvas.width = canvas.height = (scale * size) + 24;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000000';
  matrix.forEach((row, y) => row.forEach((isDark, x) => {
    if (isDark) context.fillRect(12 + (x * scale), 12 + (y * scale), scale, scale);
  }));
}

function showLink(session) {
  const panel = byId('qrPanel');
  if (session.pairingCode) {
    panel.style.display = 'block';
    byId('qr').style.display = 'none';
    byId('linkTitle').textContent = `Pairing code: ${session.pairingCode}`;
    byId('instructions').innerHTML = '<li>On the phone, open WhatsApp.</li><li>Open Linked devices, then Link a device.</li><li>Choose Link with phone number instead and enter this code.</li>';
  } else if (session.qrMatrix) {
    panel.style.display = 'block';
    byId('qr').style.display = 'block';
    drawQr(session.qrMatrix);
    byId('linkTitle').textContent = 'Scan this QR code';
    byId('instructions').innerHTML = '<li>On the WhatsApp phone, open Linked devices.</li><li>Tap Link a device and scan this QR code.</li><li>Wait for the status to become Connected.</li>';
  }
}

function escapeHtml(value) {
  const element = document.createElement('span');
  element.textContent = value || '';
  return element.innerHTML;
}

async function refresh() {
  try {
    if (!selectedUserId) return;
    const response = await request(`/api/link-status?userId=${encodeURIComponent(selectedUserId)}`);
    const active = response.session;
    if (!active) return;
    showLink(active);
    if (active.status === 'connected') setMessage('Connected successfully.');
    else if (active.linkError) setMessage(active.linkError);
    else {
      setMessage(selectedMethod === 'pair' ? 'Generating phone link code…' : 'Generating QR code…');
      setTimeout(refresh, active.pairingCode || active.qrMatrix ? 4000 : 1200);
    }
  } catch (error) {
    setMessage(error.message);
  }
}

byId('generate').onclick = async () => {
  const userId = byId('userId').value.trim();
  const method = byId('method').value;
  const phoneNumber = byId('phoneNumber').value.trim();
  const replaceSavedLink = byId('replaceSavedLink').checked;

  if (!userId) return setMessage('Enter a User ID first.');
  if (method === 'pair' && !phoneNumber) return setMessage('Enter the WhatsApp phone number first.');
  if (replaceSavedLink && !confirm(`Replace the saved bot login for ${userId}?`)) return;

  try {
    selectedUserId = userId;
    selectedMethod = method;
    byId('qrPanel').style.display = 'none';
    setMessage(method === 'pair' ? 'Generating your 8-character phone link code…' : 'Generating QR code…');
    await request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, method, phoneNumber, replaceSavedLink }),
    });
    setTimeout(refresh, 900);
  } catch (error) {
    setMessage(error.message);
  }
};

refresh();
