// Meta WhatsApp Business Cloud API client (official Graph API only — no unofficial libraries).
import crypto from 'node:crypto';
import { config } from '../config.js';
import { toWaId } from '../util/normalize.js';
import { log } from '../logger.js';

const wa = config.whatsapp;
const BASE = () => `https://graph.facebook.com/${wa.graphVersion}`;

export class WhatsAppError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

async function graph(method, path, { body, token, query } = {}) {
  const url = new URL(`${BASE()}/${path.replace(/^\//, '')}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token || wa.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = json.error || {};
      const msg = `${err.message || res.statusText}${err.error_user_msg ? ' — ' + err.error_user_msg : ''}${err.error_subcode ? ' (subcode ' + err.error_subcode + ')' : ''}`;
      throw new WhatsAppError(msg, { status: res.status, ...err });
    }
    return json;
  } finally { clearTimeout(timer); }
}

// ---- mock (for local testing without Meta) ----
export const mockOutbox = [];
const fakeId = () => 'wamid.MOCK.' + crypto.randomBytes(8).toString('hex');

export function isConfigured() { return wa.mock || (!!wa.token && !!wa.phoneNumberId); }

export async function sendText(to, text, { phoneNumberId } = {}) {
  const pid = phoneNumberId || wa.phoneNumberId;
  if (wa.mock) { const id = fakeId(); mockOutbox.push({ to, type: 'text', text, id, ts: Date.now() }); return { id }; }
  if (!wa.token || !pid) throw new WhatsAppError('WhatsApp is not configured (WHATSAPP_TOKEN / PHONE_NUMBER_ID missing)');
  const r = await graph('POST', `${pid}/messages`, { body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: toWaId(to), type: 'text', text: { preview_url: true, body: text } } });
  return { id: r.messages?.[0]?.id, raw: r };
}

export async function sendTemplate(to, { name, language = 'en', bodyParams = [], phoneNumberId } = {}) {
  const pid = phoneNumberId || wa.phoneNumberId;
  if (wa.mock) { const id = fakeId(); mockOutbox.push({ to, type: 'template', name, bodyParams, id, ts: Date.now() }); return { id }; }
  if (!wa.token || !pid) throw new WhatsAppError('WhatsApp is not configured (WHATSAPP_TOKEN / PHONE_NUMBER_ID missing)');
  const template = { name, language: { code: language } };
  if (bodyParams.length) template.components = [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) }];
  const r = await graph('POST', `${pid}/messages`, { body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: toWaId(to), type: 'template', template } });
  return { id: r.messages?.[0]?.id, raw: r };
}

export async function markRead(messageId, { phoneNumberId } = {}) {
  const pid = phoneNumberId || wa.phoneNumberId;
  if (wa.mock || !wa.token || !pid || !messageId) return;
  try { await graph('POST', `${pid}/messages`, { body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId } }); }
  catch (e) { log.debug('markRead failed', e.message); }
}

// Verify X-Hub-Signature-256 on webhook posts.
// SECURITY: this FAILS CLOSED. With no META_APP_SECRET we cannot prove a post came from Meta, so we
// reject it unless the deployment has explicitly opted into unsigned posts (local dev) or is relying
// on the secret-path-token fallback (checked separately in routes/webhook.js).
export function verifySignature(rawBody, signatureHeader) {
  if (!wa.appSecret) {
    if (config.security.allowUnsignedWebhook) return { ok: true, unverified: true, reason: 'unsigned-allowed' };
    if (config.security.webhookPathToken) return { ok: true, unverified: true, reason: 'path-token' };
    return { ok: false, reason: 'no-app-secret' };
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return { ok: false, reason: 'missing-signature' };
  const expected = crypto.createHmac('sha256', wa.appSecret).update(rawBody).digest('hex');
  const given = signatureHeader.slice(7);
  try {
    const ok = expected.length === given.length && crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'));
    return { ok, reason: ok ? 'signature' : 'bad-signature' };
  } catch { return { ok: false, reason: 'bad-signature' }; }
}

// Is the WhatsApp access token still valid? Used by the monitor so an expired token is caught
// before leads stop getting replies. Returns { ok, detail }.
export async function tokenHealth() {
  if (wa.mock) return { ok: true, mock: true };
  if (!wa.token || !wa.phoneNumberId) return { ok: false, detail: 'WHATSAPP_TOKEN / PHONE_NUMBER_ID not set' };
  try {
    const info = await phoneInfo();
    return { ok: true, detail: { name: info.verified_name, quality: info.quality_rating, tier: info.messaging_limit_tier, status: info.status } };
  } catch (e) {
    const d = e.details || {};
    const expired = d.status === 401 || d.code === 190;
    return { ok: false, expired, detail: e.message };
  }
}

// ---- Admin / setup helpers (used by the Settings → WhatsApp panel) ----
export async function phoneInfo(phoneNumberId = wa.phoneNumberId) {
  if (wa.mock) return { id: 'MOCK', display_phone_number: '+91 00000 00000', verified_name: 'Mock Business', quality_rating: 'GREEN', code_verification_status: 'VERIFIED', status: 'CONNECTED' };
  return graph('GET', phoneNumberId, { query: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,status,name_status,messaging_limit_tier' } });
}
export async function listPhoneNumbers(wabaId = wa.wabaId) {
  if (wa.mock) return { data: [await phoneInfo()] };
  return graph('GET', `${wabaId}/phone_numbers`, { query: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,status,name_status' } });
}
export async function addPhoneNumber({ cc = '91', phoneNumber, verifiedName, wabaId = wa.wabaId }) {
  return graph('POST', `${wabaId}/phone_numbers`, { body: { cc, phone_number: phoneNumber, verified_name: verifiedName } });
}
export async function requestCode(phoneNumberId, { method = 'SMS', language = 'en' } = {}) {
  return graph('POST', `${phoneNumberId}/request_code`, { body: { code_method: method, language } });
}
export async function verifyCode(phoneNumberId, code) {
  return graph('POST', `${phoneNumberId}/verify_code`, { body: { code: String(code).trim() } });
}
export async function registerNumber(phoneNumberId, pin) {
  return graph('POST', `${phoneNumberId}/register`, { body: { messaging_product: 'whatsapp', pin: String(pin) } });
}
export async function subscribeApp(wabaId = wa.wabaId) {
  if (wa.mock) return { success: true, mock: true };
  return graph('POST', `${wabaId}/subscribed_apps`, {});
}
export async function subscribedApps(wabaId = wa.wabaId) {
  if (wa.mock) return { data: [{ whatsapp_business_api_data: { name: 'Mock app' } }] };
  return graph('GET', `${wabaId}/subscribed_apps`, {});
}
export async function listTemplates(wabaId = wa.wabaId) {
  if (wa.mock) return { data: [{ name: 'neopolis_intro_day0', status: 'APPROVED', language: 'en', category: 'MARKETING' }] };
  return graph('GET', `${wabaId}/message_templates`, { query: { fields: 'name,status,language,category,components', limit: 100 } });
}
export async function createTemplate(wabaId = wa.wabaId, tpl) {
  if (wa.mock) return { id: 'MOCK_' + tpl.name, status: 'PENDING', category: tpl.category };
  return graph('POST', `${wabaId || wa.wabaId}/message_templates`, { body: tpl });
}
// Point the Meta app's WhatsApp webhook at this deployment (needs META_APP_ID + META_APP_SECRET).
export async function configureWebhook(callbackUrl) {
  if (!wa.appId || !wa.appSecret) throw new WhatsAppError('META_APP_ID and META_APP_SECRET are required to configure the webhook automatically');
  const appToken = `${wa.appId}|${wa.appSecret}`;
  return graph('POST', `${wa.appId}/subscriptions`, { token: appToken, body: { object: 'whatsapp_business_account', callback_url: callbackUrl, verify_token: wa.verifyToken, fields: ['messages'] } });
}
export async function webhookStatus() {
  if (wa.mock) return { data: [{ object: 'whatsapp_business_account', callback_url: 'mock', active: true }] };
  if (!wa.appId || !wa.appSecret) return { configured: null, reason: 'META_APP_ID / META_APP_SECRET not set' };
  const appToken = `${wa.appId}|${wa.appSecret}`;
  return graph('GET', `${wa.appId}/subscriptions`, { token: appToken });
}
export async function tokenDebug() {
  if (wa.mock) return { mock: true };
  return graph('GET', 'me', { query: { fields: 'id,name' } });
}
