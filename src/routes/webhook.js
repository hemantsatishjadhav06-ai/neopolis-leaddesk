// Meta WhatsApp webhook: GET = verification handshake, POST = inbound messages + delivery statuses.
//
// SECURITY MODEL (this endpoint is public — treat every post as hostile until proven otherwise):
//   1. Rate limit per IP, so a flood cannot run up LLM / WhatsApp spend or wedge the process.
//   2. Optional secret path segment (/webhook/<WEBHOOK_PATH_TOKEN>) — interim protection when the
//      Meta App Secret is not available.
//   3. X-Hub-Signature-256 HMAC, enforced whenever META_APP_SECRET is set. Fails CLOSED.
import express from 'express';
import { config } from '../config.js';
import { verifySignature } from '../services/whatsapp.js';
import { ingestWebhook } from '../services/conversation.js';
import { kvSet } from '../db.js';
import { log } from '../logger.js';

export const webhookRouter = express.Router();

// ---- rate limiting (in-memory, per instance) ----
const hits = new Map(); // ip -> { n, resetAt }
function rateLimited(ip) {
  const now = Date.now();
  const win = config.security.webhookRateWindowMs;
  let e = hits.get(ip);
  if (!e || e.resetAt <= now) { e = { n: 0, resetAt: now + win }; hits.set(ip, e); }
  e.n += 1;
  if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  return e.n > config.security.webhookRateMax;
}

// The secret path segment, when configured, must match.
function pathTokenOk(req) {
  const want = config.security.webhookPathToken;
  if (!want) return true;
  const got = req.params.token || '';
  return got.length === want.length && got === want;
}

webhookRouter.get('/:token?', (req, res) => {
  if (!pathTokenOk(req)) return res.sendStatus(404);
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    kvSet('webhook.verifiedAt', new Date().toISOString());
    log.info('Webhook verified by Meta');
    return res.status(200).send(String(challenge));
  }
  log.warn('Webhook verification rejected (bad verify token)');
  return res.sendStatus(403);
});

webhookRouter.post('/:token?', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    log.warn(`Webhook rate limit hit from ${ip}`);
    return res.sendStatus(429);
  }
  if (!pathTokenOk(req)) return res.sendStatus(404);

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  const sig = verifySignature(raw, req.get('x-hub-signature-256'));
  if (!sig.ok) {
    log.warn(`Webhook rejected (${sig.reason}) from ${ip}`);
    kvSet('webhook.lastRejectedAt', new Date().toISOString());
    // 403 (not 401) — Meta retries on 5xx, and we do not want retries of unauthenticated posts.
    return res.sendStatus(403);
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return res.sendStatus(400); }
  if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

  res.sendStatus(200); // acknowledge immediately; process in background
  kvSet('webhook.lastEventAt', new Date().toISOString());
  if (sig.unverified) kvSet('webhook.lastUnverifiedAt', new Date().toISOString());
  Promise.resolve()
    .then(() => ingestWebhook(body))
    .catch((e) => log.error('ingest error', e));
});
