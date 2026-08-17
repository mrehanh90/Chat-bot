const crypto = require('crypto');
const http = require('http');
const { google } = require('googleapis');
const config = require('./config');
const {
  saveCalendarToken,
  readCalendarToken,
  deleteCalendarToken,
  readCalendarEvent,
  saveCalendarEvent,
} = require('./dataStore');

const PROVIDER = 'google';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
];

class GoogleCalendarClient {
  constructor() {
    this.server = null;
    this.pendingAuthorizations = new Map();
  }

  isConfigured() {
    return Boolean(config.googleCalendarClientId && config.googleCalendarClientSecret);
  }

  redirectUri() {
    return `http://127.0.0.1:${config.googleCalendarRedirectPort}/oauth2callback`;
  }

  createOAuthClient() {
    return new google.auth.OAuth2(
      config.googleCalendarClientId,
      config.googleCalendarClientSecret,
      this.redirectUri(),
    );
  }

  async startAuthorization(userId) {
    if (!this.isConfigured()) throw new Error('Google Calendar credentials are missing from .env');
    await this.ensureCallbackServer();
    const state = crypto.randomBytes(24).toString('base64url');
    this.pendingAuthorizations.set(state, { userId, expiresAt: Date.now() + (10 * 60 * 1000) });
    const client = this.createOAuthClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state,
    });
  }

  async ensureCallbackServer() {
    if (this.server) return;
    await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleCallback(req, res));
      server.once('error', reject);
      server.listen(config.googleCalendarRedirectPort, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  async handleCallback(req, res) {
    const url = new URL(req.url, this.redirectUri());
    if (url.pathname !== '/oauth2callback') {
      res.writeHead(404).end('Not found');
      return;
    }

    const state = url.searchParams.get('state');
    const authorization = this.pendingAuthorizations.get(state);
    const error = url.searchParams.get('error');
    if (!authorization || authorization.expiresAt < Date.now() || error) {
      this.pendingAuthorizations.delete(state);
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h2>Google Calendar connection failed or expired.</h2>');
      return;
    }

    try {
      const client = this.createOAuthClient();
      const { tokens } = await client.getToken(url.searchParams.get('code'));
      if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Remove this app from Google account access and try connect again.');
      saveCalendarToken(authorization.userId, PROVIDER, encrypt(tokens));
      this.pendingAuthorizations.delete(state);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h2>Google Calendar connected.</h2><p>You may close this window and return to WhatsApp.</p>');
    } catch (err) {
      this.pendingAuthorizations.delete(state);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h2>Google Calendar connection failed.</h2><p>Return to WhatsApp and try again.</p>');
      console.error('[google-calendar] OAuth callback failed:', err.message);
    }
  }

  async getStatus(userId) {
    if (!this.isConfigured()) return { configured: false, connected: false };
    const encrypted = readCalendarToken(userId, PROVIDER);
    if (!encrypted) return { configured: true, connected: false };
    const client = this.authorizedClient(userId);
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const { data } = await oauth2.userinfo.get();
      return { configured: true, connected: true, email: data.email || null };
    } catch (err) {
      return { configured: true, connected: false, error: err.message };
    }
  }

  disconnect(userId) {
    deleteCalendarToken(userId, PROVIDER);
  }

  async createEvent(userId, task) {
    if (!task?.id || !task.scheduledFor) throw new Error('This task needs a confirmed date and time before it can be added to Google Calendar.');
    const existing = readCalendarEvent(userId, task.id);
    if (existing) return { alreadyExists: true, ...existing };

    const client = this.authorizedClient(userId);
    const calendar = google.calendar({ version: 'v3', auth: client });
    const start = new Date(task.scheduledFor);
    if (Number.isNaN(start.getTime())) throw new Error('The saved task has an invalid date/time.');
    const end = new Date(start.getTime() + (60 * 60 * 1000));
    const { data } = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: task.task,
        description: [`WhatsApp task`, `Sender: ${task.senderName || task.from}`, '', task.originalMessage || ''].join('\n'),
        start: { dateTime: task.scheduledFor, timeZone: config.timeZone },
        end: { dateTime: end.toISOString(), timeZone: config.timeZone },
        reminders: {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: config.googleCalendarReminderMinutes }],
        },
      },
    });
    saveCalendarEvent(userId, task.id, data.id, data.htmlLink);
    return { eventId: data.id, eventLink: data.htmlLink, alreadyExists: false };
  }

  authorizedClient(userId) {
    const encrypted = readCalendarToken(userId, PROVIDER);
    if (!encrypted) throw new Error('Google Calendar is not connected. Send !calendar connect first.');
    const client = this.createOAuthClient();
    client.setCredentials(decrypt(encrypted));
    client.on('tokens', (tokens) => {
      const existing = decrypt(readCalendarToken(userId, PROVIDER));
      saveCalendarToken(userId, PROVIDER, encrypt({ ...existing, ...tokens }));
    });
    return client;
  }
}

function encryptionKey() {
  return crypto.createHash('sha256').update(config.calendarTokenEncryptionSecret).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decrypt(value) {
  const [ivText, tagText, encryptedText] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8'));
}

module.exports = new GoogleCalendarClient();
