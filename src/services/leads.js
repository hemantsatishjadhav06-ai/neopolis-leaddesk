// Lead + message domain logic: statuses, hand-offs, take-over, sheet mirroring, alerts.
import { all, get, run, nowIso, parseJson, transaction } from '../db.js';
import { config } from '../config.js';
import { activeSheetConfig } from './sheets/active.js';
import { getSetting } from '../settings.js';
import { normalizePhone, firstName } from '../util/normalize.js';
import { hoursSince, stampIst } from '../util/time.js';
import { broadcast } from './events.js';
import { log } from '../logger.js';

export const STATUSES = ['CREATED', 'CONTACTED', 'FOLLOWUP_1', 'FOLLOWUP_2', 'FOLLOWUP_3', 'FOLLOWUP_4', 'FOLLOWUP_5', 'NO_RESPONSE', 'REPLIED', 'PROSPECT', 'IN_SALES', 'VISIT_BOOKED', 'WON', 'LOST', 'OPTED_OUT'];
export const RANK = { CREATED: 0, CONTACTED: 1, FOLLOWUP_1: 2, FOLLOWUP_2: 2, FOLLOWUP_3: 2, FOLLOWUP_4: 2, FOLLOWUP_5: 2, NO_RESPONSE: 3, REPLIED: 5, PROSPECT: 6, IN_SALES: 7, VISIT_BOOKED: 8, WON: 9, LOST: 9, OPTED_OUT: 9 };
export const PRE_REPLY = ['CREATED', 'CONTACTED', 'FOLLOWUP_1', 'FOLLOWUP_2', 'FOLLOWUP_3', 'FOLLOWUP_4', 'FOLLOWUP_5', 'NO_RESPONSE'];
export const WINDOW_HOURS = 24;

export const getLead = (id) => get('SELECT * FROM leads WHERE id = ?', id);
export const getLeadByNumber = (wa) => get('SELECT * FROM leads WHERE wa_number = ?', wa);
export const windowOpen = (lead) => hoursSince(lead.last_inbound_at) < WINDOW_HOURS;
export const windowClosesAt = (lead) => (lead.last_inbound_at ? new Date(new Date(lead.last_inbound_at).getTime() + WINDOW_HOURS * 36e5).toISOString() : null);

export function audit(type, { leadId = null, userId = null, data = {} } = {}) {
  run('INSERT INTO audit(lead_id,user_id,type,data,created_at) VALUES(?,?,?,?,?)', leadId, userId, type, JSON.stringify(data), nowIso());
}

export function serializeLead(l) {
  if (!l) return null;
  return { ...l, raw_fields: parseJson(l.raw_fields, {}), window_open: windowOpen(l), window_closes_at: windowClosesAt(l), opted_out: !!l.opted_out, qualified: !!l.qualified, outreach_paused: !!l.outreach_paused };
}
export function serializeMessage(m) { return m && { ...m, meta: parseJson(m.meta, {}) }; }

export function createLead({ wa_number, full_name = '', email = '', source = 'manual', sheet_row = null, sheet_tab = null, status = 'CREATED', fields = {}, raw_fields = {} }) {
  const wa = normalizePhone(wa_number);
  if (!wa) throw new Error(`Invalid phone number: ${wa_number}`);
  const existing = getLeadByNumber(wa);
  if (existing) return existing;
  const ts = nowIso();
  const st = STATUSES.includes(String(status || '').toUpperCase()) ? String(status).toUpperCase() : 'CREATED';
  const r = run(`INSERT INTO leads(wa_number,full_name,first_name,email,source,sheet_row,sheet_tab,status,mode,corridor,budget,timeline,configuration,funding,objective,raw_fields,opted_out,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    wa, full_name || '', firstName(full_name), email || '', source, sheet_row, sheet_tab, st, getSetting('default_mode') || 'ai',
    fields.corridor || null, fields.budget || null, fields.timeline || null, fields.configuration || null, fields.funding || null, fields.objective || null,
    JSON.stringify(raw_fields || {}), st === 'OPTED_OUT' ? 1 : 0, ts, ts);
  const lead = getLead(Number(r.lastInsertRowid));
  audit('lead.created', { leadId: lead.id, data: { source } });
  broadcast('lead', { id: lead.id, reason: 'created' });
  return lead;
}

export function updateLead(id, patch, { userId = null, silent = false } = {}) {
  const allowed = ['full_name', 'first_name', 'email', 'status', 'mode', 'assigned_to', 'outreach_paused', 'opted_out', 'qualified', 'qualified_at', 'handoff_reason', 'corridor', 'budget', 'timeline', 'configuration', 'funding', 'objective', 'language', 'raw_fields', 'followup_stage', 'first_contact_at', 'last_followup_at', 'followup_attempts', 'followup_retry_at', 'last_error', 'last_inbound_at', 'last_outbound_at', 'last_message_at', 'last_message_preview', 'unread_count', 'notes', 'sheet_row', 'sheet_tab'];
  const sets = []; const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`); vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : (v === undefined ? null : v));
  }
  if (!sets.length) return getLead(id);
  sets.push('updated_at = ?'); vals.push(nowIso());
  run(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  const lead = getLead(id);
  if (!silent) broadcast('lead', { id, reason: 'updated' });
  return lead;
}

export function setStatus(lead, status, { userId = null, reason = '', mirror = true } = {}) {
  status = String(status || '').toUpperCase();
  if (!STATUSES.includes(status)) throw new Error(`Unknown status ${status}`);
  if (lead.status === status) return lead;
  const patch = { status };
  if (status === 'OPTED_OUT') patch.opted_out = 1;
  const updated = updateLead(lead.id, patch);
  audit('lead.status', { leadId: lead.id, userId, data: { from: lead.status, to: status, reason } });
  if (mirror) mirrorLead(updated);
  return updated;
}

export function addMessage(leadId, { direction, sender, type = 'text', body = '', template_name = null, wa_message_id = null, status, error = null, meta = {}, in_reply_to = null, sender_user_id = null }) {
  const ts = nowIso();
  const st = status || (direction === 'in' ? 'received' : 'sent');
  const r = run(`INSERT INTO messages(lead_id,direction,sender,sender_user_id,type,body,template_name,wa_message_id,status,error,meta,in_reply_to,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    leadId, direction, sender, sender_user_id, type, body || '', template_name, wa_message_id, st, error, JSON.stringify(meta || {}), in_reply_to, ts);
  const msg = get('SELECT * FROM messages WHERE id = ?', Number(r.lastInsertRowid));
  const preview = (body || (template_name ? `Template: ${template_name}` : `[${type}]`)).replace(/\s+/g, ' ').slice(0, 120);
  const lead = getLead(leadId);
  const patch = { last_message_at: ts, last_message_preview: preview };
  if (direction === 'in') { patch.last_inbound_at = ts; patch.unread_count = (lead.unread_count || 0) + 1; }
  else if (st !== 'failed') patch.last_outbound_at = ts;
  updateLead(leadId, patch, { silent: true });
  broadcast('message', { lead_id: leadId, id: msg.id, direction, sender });
  return msg;
}

export function updateMessageStatus(waMessageId, status, { error = null, at = null } = {}) {
  const m = get('SELECT * FROM messages WHERE wa_message_id = ?', waMessageId);
  if (!m) return null;
  const order = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
  if ((order[status] ?? 0) < (order[m.status] ?? 0) && status !== 'failed') return m; // never downgrade
  run('UPDATE messages SET status = ?, error = COALESCE(?, error) WHERE id = ?', status, error, m.id);
  if (status === 'failed') updateLead(m.lead_id, { last_error: error || 'Message failed' }, { silent: true });
  broadcast('message', { lead_id: m.lead_id, id: m.id, status });
  return get('SELECT * FROM messages WHERE id = ?', m.id);
}

export function getHistory(leadId, limit = 16, beforeId = null) {
  const rows = beforeId
    ? all('SELECT * FROM messages WHERE lead_id = ? AND id < ? ORDER BY id DESC LIMIT ?', leadId, beforeId, limit)
    : all('SELECT * FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT ?', leadId, limit);
  return rows.reverse();
}

export function markLeadRead(leadId) { updateLead(leadId, { unread_count: 0 }); }

// ---- hand-off / take-over ----
export function handoff(lead, { reason = '', userId = null, byAi = false } = {}) {
  const patch = { mode: 'human', qualified: 1, qualified_at: lead.qualified_at || nowIso(), handoff_reason: reason || lead.handoff_reason };
  if (RANK[lead.status] < RANK.PROSPECT) patch.status = 'PROSPECT';
  const updated = updateLead(lead.id, patch);
  audit(byAi ? 'lead.handoff.ai' : 'lead.handoff', { leadId: lead.id, userId, data: { reason } });
  mirrorLead(updated);
  broadcast('alert', { kind: 'handoff', lead_id: lead.id, name: updated.full_name || updated.wa_number, reason });
  if (getSetting('alert_on_handoff')) sendAlertWebhook({ type: 'handoff', lead: serializeLead(updated), reason }).catch(() => {});
  return updated;
}
// Ready for sales, but the AI KEEPS replying — the bot only goes silent when a human clicks
// "Take over". Used by auto_handoff so a qualified lead is flagged + alerted without muting the AI.
export function flagForSales(lead, { reason = '', userId = null, byAi = false } = {}) {
  const patch = { qualified: 1, qualified_at: lead.qualified_at || nowIso(), handoff_reason: reason || lead.handoff_reason };
  if (RANK[lead.status] < RANK.PROSPECT) patch.status = 'PROSPECT';
  const updated = updateLead(lead.id, patch);
  audit(byAi ? 'lead.handoff.ai' : 'lead.handoff', { leadId: lead.id, userId, data: { reason, aiKept: true } });
  mirrorLead(updated);
  broadcast('alert', { kind: 'handoff', lead_id: lead.id, name: updated.full_name || updated.wa_number, reason });
  if (getSetting('alert_on_handoff')) sendAlertWebhook({ type: 'handoff', lead: serializeLead(updated), reason }).catch(() => {});
  return updated;
}
// Statuses that tell the n8n brain "a person owns this chat — stay silent".
export const HUMAN_OWNED = ['PROSPECT', 'IN_SALES', 'VISIT_BOOKED', 'WON', 'LOST', 'OPTED_OUT'];
export function takeOver(lead, userId) {
  const patch = { mode: 'human' };
  if (userId && !lead.assigned_to) patch.assigned_to = userId;
  if (lead.status === 'PROSPECT' && userId) patch.status = 'IN_SALES';
  // With n8n as the brain the sheet status is the only signal it reads, so a take-over must move the lead
  // into a human-owned status (IN_SALES) or the n8n AI would keep replying.
  if (config.brain === 'n8n' && !HUMAN_OWNED.includes(patch.status || lead.status)) patch.status = 'IN_SALES';
  const updated = updateLead(lead.id, patch);
  audit('lead.takeover', { leadId: lead.id, userId });
  if (patch.status) mirrorLead(updated);
  return updated;
}
export function handBackToAi(lead, userId) {
  const patch = { mode: 'ai' };
  // n8n brain: leave the human-owned statuses so the AI resumes (REPLIED keeps the journey paused).
  if (config.brain === 'n8n' && ['PROSPECT', 'IN_SALES'].includes(lead.status)) patch.status = 'REPLIED';
  const updated = updateLead(lead.id, patch);
  audit('lead.handback', { leadId: lead.id, userId });
  if (patch.status) mirrorLead(updated);
  return updated;
}
export function assignLead(lead, assigneeId, userId) {
  const patch = { assigned_to: assigneeId || null };
  if (assigneeId) { patch.mode = 'human'; if (lead.status === 'PROSPECT') patch.status = 'IN_SALES'; }
  const updated = updateLead(lead.id, patch);
  audit('lead.assign', { leadId: lead.id, userId, data: { assigneeId } });
  if (patch.status) mirrorLead(updated);
  return updated;
}

// ---- Google Sheet mirroring (queued; processed by the scheduler, retried on failure) ----
export function queueSheetOp(op, payload) {
  const sheet = activeSheetConfig();
  if (sheet.provider === 'none' || sheet.readOnly) return; // read-only link connections can't write back
  if (!getSetting('sheet_mirror_enabled')) return;
  run('INSERT INTO sheet_queue(op,payload,attempts,next_at,created_at) VALUES(?,?,0,?,?)', op, JSON.stringify(payload), nowIso(), nowIso());
}
export function mirrorLead(lead, lastReply) {
  if (!lead.sheet_row) return;
  const values = { lead_status: lead.status };
  if (lastReply) values.last_reply = lastReply;
  queueSheetOp('updateRow', { rowNumber: lead.sheet_row, tab: lead.sheet_tab, values });
}
export function mirrorReply(lead, { message, aiReply = '' }) {
  if (!lead.sheet_row && lead.source !== 'inbound') return;
  const sid = activeSheetConfig().spreadsheetId;
  const leadRef = lead.sheet_row && sid ? `=HYPERLINK("https://docs.google.com/spreadsheets/d/${sid}/edit#gid=0&range=A${lead.sheet_row}","Row ${lead.sheet_row}")` : (lead.sheet_row ? `Row ${lead.sheet_row}` : 'not in sheet');
  queueSheetOp('appendReply', { row: {
    timestamp: stampIst(), whatsapp_number: lead.wa_number, full_name: lead.full_name, message, ai_reply: aiReply,
    lead_reference: leadRef, conversation_link: config.publicUrl ? `${config.publicUrl}/#/inbox/${lead.id}` : '',
  } });
}

export async function sendAlertWebhook(payload) {
  if (!config.alerts.webhookUrl) return;
  try {
    await fetch(config.alerts.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, app: 'Neopolis LeadDesk', url: config.publicUrl ? `${config.publicUrl}/#/inbox/${payload.lead?.id}` : '' }) });
  } catch (e) { log.warn('Alert webhook failed', e.message); }
}

// ---- queries for the UI ----
export function listLeads({ status, mode, assigned, q, qualified, limit = 200, offset = 0, sort = 'last_message_at' } = {}) {
  const where = []; const vals = [];
  if (status) { const list = String(status).split(',').map(s => s.trim().toUpperCase()).filter(Boolean); where.push(`status IN (${list.map(() => '?').join(',')})`); vals.push(...list); }
  if (mode) { where.push('mode = ?'); vals.push(mode); }
  if (assigned === 'me' || /^\d+$/.test(String(assigned || ''))) { where.push('assigned_to = ?'); vals.push(Number(assigned)); }
  else if (assigned === 'none') where.push('assigned_to IS NULL');
  if (qualified === '1' || qualified === true) where.push('qualified = 1');
  if (q) { where.push('(full_name LIKE ? OR wa_number LIKE ? OR email LIKE ? OR corridor LIKE ?)'); const like = `%${q}%`; vals.push(like, like, like, like); }
  const orderBy = { last_message_at: 'COALESCE(last_message_at, created_at) DESC', created_at: 'created_at DESC', name: 'full_name COLLATE NOCASE ASC', status: 'status ASC, COALESCE(last_message_at, created_at) DESC' }[sort] || 'COALESCE(last_message_at, created_at) DESC';
  const sql = `SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const rows = all(sql, ...vals, Math.min(Math.max(Number(limit) || 200, 1), 100000), Math.max(Number(offset) || 0, 0));
  const total = get(`SELECT COUNT(*) AS n FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...vals).n;
  return { rows: rows.map(serializeLead), total };
}

export function stats() {
  const byStatus = {}; for (const r of all('SELECT status, COUNT(*) AS n FROM leads GROUP BY status')) byStatus[r.status] = r.n;
  const total = get('SELECT COUNT(*) AS n FROM leads').n;
  const replied = get(`SELECT COUNT(*) AS n FROM leads WHERE last_inbound_at IS NOT NULL`).n;
  const contacted = get(`SELECT COUNT(*) AS n FROM leads WHERE first_contact_at IS NOT NULL OR last_outbound_at IS NOT NULL`).n;
  const prospects = get(`SELECT COUNT(*) AS n FROM leads WHERE qualified = 1`).n;
  const inSales = (byStatus.IN_SALES || 0) + (byStatus.VISIT_BOOKED || 0) + (byStatus.WON || 0);
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const aiToday = get(`SELECT COUNT(*) AS n FROM messages WHERE sender = 'ai' AND created_at > ?`, dayAgo).n;
  const inToday = get(`SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND created_at > ?`, dayAgo).n;
  const flagged = get(`SELECT COUNT(*) AS n FROM messages WHERE sender = 'ai' AND review = 'bad'`).n;
  const aiTotal = get(`SELECT COUNT(*) AS n FROM messages WHERE sender = 'ai'`).n;
  const reviewed = get(`SELECT COUNT(*) AS n FROM messages WHERE sender = 'ai' AND review IS NOT NULL`).n;
  const failed = get(`SELECT COUNT(*) AS n FROM messages WHERE status = 'failed' AND created_at > ?`, dayAgo).n;
  const humanUnread = get(`SELECT COUNT(*) AS n FROM leads WHERE mode = 'human' AND unread_count > 0`).n;
  const unassignedProspects = get(`SELECT COUNT(*) AS n FROM leads WHERE status = 'PROSPECT' AND assigned_to IS NULL`).n;
  const avgLatency = get(`SELECT AVG(CAST(json_extract(meta,'$.latency_ms') AS REAL)) AS ms FROM messages WHERE sender = 'ai' AND created_at > ?`, dayAgo).ms;
  return { total, byStatus, contacted, replied, prospects, inSales, won: byStatus.WON || 0, aiToday, inToday, flagged, aiTotal, reviewed, failed, humanUnread, unassignedProspects, avgAiLatencyMs: avgLatency ? Math.round(avgLatency) : null };
}
