// Neopolis LeadDesk — entry point.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configSummary } from './config.js';
import { log } from './logger.js';
import { attachUser } from './middleware/auth.js';
import { apiRouter } from './routes/api.js';
import { webhookRouter } from './routes/webhook.js';
import { ingestRouter } from './routes/ingest.js';
import { bootstrapAdmin } from './services/auth.js';
import { seedFirmsFromEnv } from './services/firm-setup.js';
import { listFirms, firmPhoneNumberId } from './firms.js';
import { startScheduler } from './services/scheduler.js';
import { clientCount } from './services/events.js';
import { healthReport } from './services/monitor.js';
import { runBackup } from './services/backup.js';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Second line of defence: the inbox renders text a stranger sent over WhatsApp. Every value is
  // escaped, but if one ever slips through, this stops it becoming script execution or exfiltration.
  // No inline <script> and no external origins are used, so 'self' is enough; inline style
  // attributes are used throughout the UI, which is markup-only and cannot execute.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'", "connect-src 'self'",
    "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
  ].join('; '));
  if (req.secure || req.get('x-forwarded-proto') === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  if (req.path.startsWith('/api') || req.path === '/' || req.path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// Liveness: always 200 while the process is up (never let a degraded dependency trigger a restart loop).
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), sse_clients: clientCount() }));

// Readiness/diagnostics for an uptime monitor. Booleans + issue codes only — no tokens, no PII.
app.get('/health/ready', async (req, res) => {
  try {
    const r = await healthReport({ probeToken: false });
    res.status(r.ok ? 200 : 503).json({
      ok: r.ok,
      checkedAt: r.checkedAt,
      webhookAuth: r.webhook.auth,
      backupOk: !!r.backup?.last?.ok && !r.backup?.stale,
      whatsappOk: r.whatsapp?.ok !== false,
      issues: r.issues.map(i => ({ code: i.code, severity: i.severity })),
    });
  } catch (e) { res.status(500).json({ ok: false, error: 'health check failed' }); }
});
app.use('/webhook', webhookRouter);
app.use('/api/ingest', ingestRouter);   // n8n brain → LeadDesk events (secret header, no session)
app.use('/api', attachUser, apiRouter);

// Static UI
const pub = path.join(__dirname, '..', 'public');
// Scripts and styles revalidate on every load (a cheap 304), so a deploy never pairs a new module with a cached old one.
app.use(express.static(pub, { index: false, maxAge: '1h', etag: true, setHeaders: (res, file) => { if (/\.(js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(pub, 'index.html'));
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  log.error('Unhandled error', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal error' });
});

bootstrapAdmin();
seedFirmsFromEnv();

// Loud, unmissable warning if the public webhook is not authenticated.
if (!config.whatsapp.appSecret && !config.security.webhookPathToken) {
  if (config.security.allowUnsignedWebhook) {
    log.error('SECURITY: webhook accepts UNSIGNED posts (ALLOW_UNSIGNED_WEBHOOK=1). Anyone who knows the URL can inject fake WhatsApp messages. Do not run this in production.');
  } else {
    log.warn('SECURITY: no META_APP_SECRET and no WEBHOOK_PATH_TOKEN — webhook posts will be REJECTED. Set one of them or Meta events cannot be received.');
  }
}

const server = app.listen(config.port, () => {
  log.info(`Neopolis LeadDesk listening on :${config.port}`);
  log.info('Config', configSummary());
  log.info('Firms', listFirms().map(f => ({ id: f.id, name: f.name, number: f.display_number || null, phoneNumberId: firmPhoneNumberId(f) || null, active: !!f.active })));
  startScheduler();
  // Always have a fresh copy from the moment this build goes live.
  runBackup({ reason: 'startup' }).catch(e => log.error('Startup backup failed', e));
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  log.info(`${signal} received — shutting down`);
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    log.info('Closed cleanly');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
process.on('uncaughtException', (e) => log.error('uncaughtException', e));
