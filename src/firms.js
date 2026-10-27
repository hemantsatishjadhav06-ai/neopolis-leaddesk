// Firms: each business that runs its own WhatsApp number, Google Sheet, AI prompt and journey from this one
// LeadDesk. Firm 1 is the business the deployment was set up for: its number, WABA and sheet still come from
// the environment (PHONE_NUMBER_ID, WABA_ID, SPREADSHEET_ID …) and its settings are the plain settings rows.
// Every other firm stores its own number, and its settings and kv state sit under a firm:<id>: prefix.
//
// Which firm a piece of work is for travels with it (AsyncLocalStorage): the webhook sets it from the number a
// message was sent to, the scheduler runs each firm in turn, and the UI sends the selected firm with every call.
// Work outside any firm context is firm 1's, which is exactly how the app behaved before firms existed.
import { AsyncLocalStorage } from 'node:async_hooks';
import { all, get, run, nowIso } from './db.js';
import { config } from './config.js';
import { normalizePhone } from './util/normalize.js';

export const DEFAULT_FIRM_ID = 1;
const context = new AsyncLocalStorage();

export const currentFirmId = () => context.getStore() || DEFAULT_FIRM_ID;
export const inFirm = (firmId, fn) => context.run(Number(firmId) || DEFAULT_FIRM_ID, fn);
export const isDefaultFirm = (firmId) => (Number(firmId) || DEFAULT_FIRM_ID) === DEFAULT_FIRM_ID;
// kv / settings key for a firm: firm 1 keeps the original key, so nothing it stored before firms moves.
export const firmKey = (key, firmId = currentFirmId()) => (isDefaultFirm(firmId) ? key : `firm:${Number(firmId)}:${key}`);

export const listFirms = ({ activeOnly = false } = {}) => all(`SELECT * FROM firms ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`);
export const getFirm = (id) => get('SELECT * FROM firms WHERE id = ?', Number(id) || DEFAULT_FIRM_ID);
export const getFirmBySlug = (slug) => get('SELECT * FROM firms WHERE slug = ?', String(slug || '').trim().toLowerCase());
export const firmName = (firmId = currentFirmId()) => getFirm(firmId)?.name || '';

const asFirm = (f) => (f && typeof f === 'object' ? f : getFirm(f ?? currentFirmId()));
const digits = (v) => String(v || '').replace(/\D/g, '');

// The Meta phone_number_id this firm sends from. Firm 1 falls back to PHONE_NUMBER_ID; any other firm has
// none until its own number is registered — it must never send from firm 1's number.
export function firmPhoneNumberId(f) {
  f = asFirm(f);
  if (!f) return '';
  return f.phone_number_id || (isDefaultFirm(f.id) ? config.whatsapp.phoneNumberId : '');
}
export const firmWabaId = (f) => asFirm(f)?.waba_id || config.whatsapp.wabaId;
// With BRAIN=n8n the n8n workflows reply for firm 1 only; LeadDesk is the brain for every other firm.
export const firmBrain = (firmId = currentFirmId()) => (isDefaultFirm(firmId) ? config.brain : 'leaddesk');

// Which firm an inbound webhook event belongs to, from the business number it was sent to. A number we only
// know by its display digits (registered, but its id not saved yet) is linked to its firm on first contact.
export function firmForInbound({ phone_number_id: pid = '', display_phone_number: shown = '' } = {}) {
  const firms = listFirms();
  if (pid) {
    const byId = firms.find(f => f.phone_number_id && f.phone_number_id === String(pid));
    if (byId) return byId;
    if (String(pid) === config.whatsapp.phoneNumberId) return getFirm(DEFAULT_FIRM_ID);
  }
  const want = digits(shown);
  if (want) {
    const byNumber = firms.find(f => !isDefaultFirm(f.id) && !f.phone_number_id && digits(f.display_number) === want);
    if (byNumber && pid) return updateFirm(byNumber.id, { phone_number_id: String(pid) });
    if (byNumber) return byNumber;
  }
  return getFirm(DEFAULT_FIRM_ID);
}

export const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function clean({ name, display_number, phone_number_id, waba_id, active } = {}) {
  const out = {};
  if (name !== undefined) { out.name = String(name).trim(); if (out.name.length < 2) throw Object.assign(new Error('Enter the firm name'), { status: 400 }); }
  if (display_number !== undefined) {
    out.display_number = display_number ? normalizePhone(display_number) : '';
    if (display_number && !out.display_number) throw Object.assign(new Error(`Not a valid WhatsApp number: ${display_number}`), { status: 400 });
  }
  if (phone_number_id !== undefined) { out.phone_number_id = String(phone_number_id || '').trim(); if (out.phone_number_id && !/^\d{6,25}$/.test(out.phone_number_id)) throw Object.assign(new Error('phone_number_id is the numeric id Meta shows for the number'), { status: 400 }); }
  if (waba_id !== undefined) { out.waba_id = String(waba_id || '').trim(); if (out.waba_id && !/^\d{6,25}$/.test(out.waba_id)) throw Object.assign(new Error('WABA id must be numeric'), { status: 400 }); }
  if (active !== undefined) out.active = active ? 1 : 0;
  return out;
}

function assertNumberFree(id, { phone_number_id, display_number }) {
  for (const f of listFirms()) {
    if (f.id === id) continue;
    if (phone_number_id && firmPhoneNumberId(f) === phone_number_id) throw Object.assign(new Error(`That WhatsApp number already belongs to ${f.name}`), { status: 400 });
    if (display_number && f.display_number && digits(f.display_number) === digits(display_number)) throw Object.assign(new Error(`${display_number} is already ${f.name}'s number`), { status: 400 });
  }
}

export function createFirm({ name, slug, display_number = '', phone_number_id = '', waba_id = '' }) {
  const v = clean({ name, display_number, phone_number_id, waba_id });
  const s = slugify(slug || name);
  if (!s) throw Object.assign(new Error('Enter the firm name'), { status: 400 });
  if (getFirmBySlug(s)) throw Object.assign(new Error(`A firm called "${s}" already exists`), { status: 400 });
  assertNumberFree(0, v);
  const ts = nowIso();
  const r = run('INSERT INTO firms(slug, name, display_number, phone_number_id, waba_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', s, v.name, v.display_number, v.phone_number_id, v.waba_id, ts, ts);
  return getFirm(Number(r.lastInsertRowid));
}

export function updateFirm(id, patch) {
  const f = getFirm(id);
  if (!f) throw Object.assign(new Error('Firm not found'), { status: 404 });
  const v = clean(patch);
  if (isDefaultFirm(f.id) && v.active === 0) throw Object.assign(new Error('The main firm cannot be switched off'), { status: 400 });
  assertNumberFree(f.id, v);
  const keys = Object.keys(v);
  if (!keys.length) return f;
  run(`UPDATE firms SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map(k => v[k]), nowIso(), f.id);
  return getFirm(f.id);
}

// What the UI may see. phone_source says where the sender id comes from: the firm itself, the environment
// (firm 1's PHONE_NUMBER_ID) or nowhere yet (number not registered).
export function publicFirm(f) {
  f = asFirm(f);
  if (!f) return null;
  const pid = firmPhoneNumberId(f);
  return {
    id: f.id, slug: f.slug, name: f.name, display_number: f.display_number || '', active: !!f.active, is_default: isDefaultFirm(f.id),
    phone_number_id: pid, phone_source: f.phone_number_id ? 'firm' : pid ? 'env' : 'none',
    waba_id: firmWabaId(f), waba_source: f.waba_id ? 'firm' : 'env',
  };
}
