const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const { SessionManager, getDashboardSessions } = require('../index');

const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.DASHBOARD_PORT || '3012', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const manager = new SessionManager();
const ADMIN_USERNAME = process.env.DASHBOARD_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.DASHBOARD_ADMIN_PASSWORD || 'admin';
const PUBLIC_ACCESS = String(process.env.DASHBOARD_PUBLIC || 'false').toLowerCase() === 'true';
const SECURE_COOKIE = String(process.env.DASHBOARD_SECURE_COOKIE || PUBLIC_ACCESS).toLowerCase() === 'true';
const SESSION_HOURS = Math.max(1, Number.parseInt(process.env.DASHBOARD_SESSION_HOURS || '12', 10));
const adminTokens = new Map();
const loginAttempts = new Map();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('DASHBOARD_PORT must be a valid TCP port.');
if (PUBLIC_ACCESS && (ADMIN_PASSWORD === 'admin' || ADMIN_PASSWORD.length < 12)) {
  throw new Error('Public dashboard refused: set DASHBOARD_ADMIN_PASSWORD to a strong password of at least 12 characters.');
}

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
  const token = getCookie(request, 'wa_admin_token');
  const expiresAt = adminTokens.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    adminTokens.delete(token);
    return false;
  }
  return true;
}

function redirectToLogin(response) {
  response.writeHead(302, { location: '/admin/login', 'cache-control': 'no-store' });
  response.end();
}

function loginAllowed(request) {
  const key = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return true;
  }
  current.count += 1;
  return current.count <= 5;
}

function sameText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
    if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { ok: true });
    if (request.method === 'GET' && url.pathname === '/') {
      if (!isAdmin(request)) return redirectToLogin(response);
      return sendFile(response, 'index.html', 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/app.js') {
      if (!isAdmin(request)) return redirectToLogin(response);
      return sendFile(response, 'app.js', 'application/javascript; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/admin/login') return sendFile(response, 'admin-login.html', 'text/html; charset=utf-8');
    if (request.method === 'GET' && url.pathname === '/admin') {
      if (!isAdmin(request)) {
        return redirectToLogin(response);
      }
      return sendFile(response, 'admin.html', 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/admin.js') {
      if (!isAdmin(request)) return redirectToLogin(response);
      return sendFile(response, 'admin.js', 'application/javascript; charset=utf-8');
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/login') {
      if (!loginAllowed(request)) return sendJson(response, 429, { error: 'Too many login attempts. Try again in 15 minutes.' });
      const { username, password } = await readBody(request);
      if (!sameText(username, ADMIN_USERNAME) || !sameText(password, ADMIN_PASSWORD)) throw new Error('Invalid administrator credentials.');
      const token = crypto.randomBytes(32).toString('hex');
      const maxAge = SESSION_HOURS * 60 * 60;
      adminTokens.set(token, Date.now() + maxAge * 1000);
      loginAttempts.delete(request.socket.remoteAddress || 'unknown');
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `wa_admin_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`,
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
      if (!requireAdmin(request, response)) return;
      const { userId, method, phoneNumber, replaceSavedLink } = await readBody(request);
      if (!['qr', 'pair'].includes(method)) throw new Error('Choose QR code or phone pairing code.');
      if (method === 'pair' && !phoneNumber) throw new Error('Enter the WhatsApp phone number for phone pairing.');
      await manager.register(userId, method === 'pair' ? phoneNumber : null, replaceSavedLink === true);
      return sendJson(response, 202, { ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/link-status') {
      if (!requireAdmin(request, response)) return;
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
  console.log(PUBLIC_ACCESS
    ? 'Public-access safeguards enabled. Publish only through an HTTPS reverse tunnel/proxy.'
    : 'Local/private mode. Set DASHBOARD_PUBLIC=true before publishing through HTTPS.');
});

async function shutdown() {
  await manager.stopAll();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
