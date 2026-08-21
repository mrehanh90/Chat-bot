const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const { SessionManager, getDashboardSessions } = require('../index');

const HOST = '127.0.0.1';
const PORT = 3012;
const PUBLIC_DIR = path.join(__dirname, 'public');
const manager = new SessionManager();
const ADMIN_USERNAME = process.env.DASHBOARD_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.DASHBOARD_ADMIN_PASSWORD || 'admin';
const adminTokens = new Set();

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function sendFile(response, fileName, contentType) {
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(fs.readFileSync(path.join(PUBLIC_DIR, fileName)));
}

function getCookie(request, name) {
  const cookies = request.headers.cookie || '';
  const entry = cookies.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

function isAdmin(request) {
  return adminTokens.has(getCookie(request, 'wa_admin_token'));
}

function requireAdmin(request, response) {
  if (isAdmin(request)) return true;
  response.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: 'Admin login required.' }));
  return false;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) request.destroy();
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid request data.')); }
    });
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${HOST}:${PORT}`);
    if (request.method === 'GET' && url.pathname === '/') return sendFile(response, 'index.html', 'text/html; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/app.js') return sendFile(response, 'app.js', 'application/javascript; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/admin/login') return sendFile(response, 'admin-login.html', 'text/html; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/admin') {
      if (!isAdmin(request)) {
        response.writeHead(302, { location: '/admin/login' });
        return response.end();
      }
      return sendFile(response, 'admin.html', 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/admin.js') return sendFile(response, 'admin.js', 'application/javascript; charset=utf-8');
    if (request.method === 'POST' && url.pathname === '/api/admin/login') {
      const { username, password } = await readBody(request);
      if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) throw new Error('Invalid administrator credentials.');
      const token = crypto.randomBytes(32).toString('hex');
      adminTokens.add(token);
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `wa_admin_token=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
      return response.end(JSON.stringify({ ok: true }));
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
      adminTokens.delete(getCookie(request, 'wa_admin_token'));
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'wa_admin_token=; Max-Age=0; Path=/' });
      return response.end(JSON.stringify({ ok: true }));
    }
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      if (!requireAdmin(request, response)) return;
      return sendJson(response, 200, { sessions: getDashboardSessions(manager) });
    }
    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const { userId, method, phoneNumber, replaceSavedLink } = await readBody(request);
      if (!['qr', 'pair'].includes(method)) throw new Error('Choose QR code or phone pairing code.');
      if (method === 'pair' && !phoneNumber) throw new Error('Enter the WhatsApp phone number for phone pairing.');
      await manager.register(userId, method === 'pair' ? phoneNumber : null, replaceSavedLink === true);
      return sendJson(response, 202, { ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/link-status') {
      const userId = url.searchParams.get('userId') || '';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new Error('Invalid User ID.');
      const session = getDashboardSessions(manager).find((entry) => entry.userId === userId);
      if (!session) return sendJson(response, 200, { session: null });
      return sendJson(response, 200, {
        session: {
          userId: session.userId,
          status: session.status,
          pairingCode: session.pairingCode,
          qrMatrix: session.qrMatrix,
          linkError: session.linkError,
        },
      });
    }
    const stopMatch = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]{1,64})\/stop$/);
    if (request.method === 'POST' && stopMatch) {
      if (!requireAdmin(request, response)) return;
      await manager.stop(stopMatch[1]);
      return sendJson(response, 200, { ok: true });
    }
    return sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    return sendJson(response, 400, { error: error.message || 'Request failed.' });
  }
});

server.on('error', (error) => {
  console.error(`Dashboard could not start: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard ready: http://${HOST}:${PORT}`);
  console.log('This dashboard is local-only. Do not expose it to the internet.');
});

async function shutdown() {
  await manager.stopAll();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
