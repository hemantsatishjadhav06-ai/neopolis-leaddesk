// Events posted by the n8n brain (BRAIN=n8n): every inbound + AI reply, every journey send, status changes.
// LeadDesk stores them so the team sees the conversation live. Sheet writes are NOT mirrored here — n8n already did them.
import express from 'express';
import crypto from 'node:crypto';
import { get } from '../db.js';
import { config } from '../config.js';
import { getSetting, journeyStep, getJourney } from '../settings.js';
import { normalizePhone, firstName } from '../util/normalize.js';
import { getLeadByNumber, createLead, updateLead, addMessage, updateMessageStatus, STATUSES, RANK, audit, serializeLead, sendAlertWebhook } from '../services/leads.js';
import { broadcast } from '../services/events.js';
import { log } from '../logger.js';

export const ingestRouter = express.Router();
ingestRouter.use(express.json({ limit: '2mb' }));

function authorized(req) {
  const secret = config.ingestSecret;
  if (!secret) return false;
  const given = String(req.get('x-ingest-secret') || '');
  try { return given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret)); } catch { return false; }
}

function findOrCreate(number, name) {
  const wa = normalizePhone(number);
  if (!wa) throw new Error(`Invalid number ${number}`);
  let lead = getLeadByNumber(wa);
  if (!lead) lead = createLead({ wa_number: wa, full_name: name || '', source: 'inbound', status: 'REPLIED' });
  else if (!lead.full_name && name) lead = updateLead(lead.id, { full_name: name, first_name: firstName(name) }, { silent: true });
  return lead;
}
const validStatus = (s) => (s && STATUSES.includes(String(s).toUpperCase()) ? String(s).toUpperCase() : null);

function handleConversation(ev) {
  let lead = findOrCreate(ev.to || ev.whatsapp_number, ev.fullName || ev.profileName);
  if (ev.rowNumber && lead.sheet_row !== Number(ev.rowNumber)) lead = updateLead(lead.id, { sheet_row: Number(ev.rowNumber), source: lead.source === 'inbound' ? 'sheet' : lead.source }, { silent: true });
  const inboundId = ev.messageId || null;
  let inbound = inboundId ? get('SELECT * FROM messages WHERE wa_message_id = ?', inboundId) : null;
  if (!inbound) inbound = addMessage(lead.id, { direction: 'in', sender: 'lead', type: ev.msgType || 'text', body: ev.inboundText || '', wa_message_id: inboundId, status: 'received', meta: { via: 'n8n', timestamp: ev.timestamp } });
  let outMsg = null;
  if (ev.reply) {
    const sender = ev.sender === 'system' ? 'system' : 'ai';
    const failed = !!ev.sendError;
    outMsg = addMessage(lead.id, { direction: 'out', sender, type: 'text', body: ev.reply, wa_message_id: ev.waMessageId || null, status: failed ? 'failed' : 'sent', error: failed ? ev.sendError : null, in_reply_to: inbound.id,
      meta: { via: 'n8n', intent: ev.intent, sentiment: ev.sentiment, handoff: !!ev.handoff, handoff_reason: ev.handoffReason || null, corridor: ev.corridor || null, budget: ev.budget || null, language: ev.language || null, model: 'n8n brain' } });
  }
  const patch = {};
  const st = validStatus(ev.newStatus);
  if (st && st !== lead.status) patch.status = st;
  if (st === 'OPTED_OUT') { patch.opted_out = 1; patch.outreach_paused = 1; }
  for (const k of ['corridor', 'budget']) if (ev[k]) patch[k] = String(ev[k]).slice(0, 120); // what the AI just learned beats the ad-form answer
  if (ev.language && ev.language !== 'other') patch.language = ev.language;
  if (ev.handoff) { patch.mode = 'human'; patch.qualified = 1; patch.qualified_at = lead.qualified_at || new Date().toISOString(); patch.handoff_reason = ev.handoffReason || lead.handoff_reason; }
  if (Object.keys(patch).length) lead = updateLead(lead.id, patch);
  if (patch.status) audit('lead.status', { leadId: lead.id, data: { from: 'n8n', to: patch.status, reason: ev.intent || 'n8n brain' } });
  if (ev.handoff) {
    audit('lead.handoff.ai', { leadId: lead.id, data: { reason: ev.handoffReason || '', via: 'n8n' } });
    broadcast('alert', { kind: 'handoff', lead_id: lead.id, name: lead.full_name || lead.wa_number, reason: ev.handoffReason || '' });
  } else if (ev.sender === 'none' || ev.action === 'human') {
    broadcast('alert', { kind: 'human_unread', lead_id: lead.id, name: lead.full_name || lead.wa_number, preview: String(ev.inboundText || '').slice(0, 80) });
  }
  return { lead_id: lead.id, inbound_id: inbound.id, reply_id: outMsg?.id || null };
}

function handleJourney(items) {
  const out = [];
  for (const it of items) {
    const lead = findOrCreate(it.whatsapp_number, it.full_name);
    const step = getJourney().find(s => s.template === it.template);
    const text = step ? step.text.replace(/\{\{\s*1\s*\}\}/g, lead.first_name || it.first_name || 'there') : '';
    const failed = String(it.status || '').toLowerCase().startsWith('fail');
    const exists = it.wa_message_id ? get('SELECT id FROM messages WHERE wa_message_id = ?', it.wa_message_id) : null;
    if (!exists) addMessage(lead.id, { direction: 'out', sender: 'system', type: 'template', template_name: it.template, body: text, wa_message_id: it.wa_message_id || null, status: failed ? 'failed' : 'sent', error: failed ? String(it.status) : null, meta: { via: 'n8n', step: it.step, day: it.day } });
    const patch = {};
    if (!failed) {
      const st = validStatus(it.newStatus); if (st) patch.status = st;
      const stage = Number(it.step); if (!Number.isNaN(stage)) patch.followup_stage = Math.max(lead.followup_stage || 0, stage + 1);
      const ts = new Date().toISOString(); patch.last_followup_at = ts; if (!lead.first_contact_at) patch.first_contact_at = ts;
      if (it.row_number && lead.sheet_row !== Number(it.row_number)) patch.sheet_row = Number(it.row_number);
    } else patch.last_error = String(it.status);
    if (Object.keys(patch).length) updateLead(lead.id, patch);
    audit(failed ? 'followup.failed' : 'followup.sent', { leadId: lead.id, data: { template: it.template, stage: it.step, day: it.day, via: 'n8n', error: failed ? it.status : undefined } });
    out.push(lead.id);
  }
  return { leads: out };
}

function handleStatus(ev) {
  const lead = findOrCreate(ev.whatsapp_number, ev.full_name);
  const st = validStatus(ev.newStatus);
  if (!st) throw new Error('Unknown status');
  const patch = { status: st };
  if (ev.row_number) patch.sheet_row = Number(ev.row_number);
  updateLead(lead.id, patch);
  audit('lead.status', { leadId: lead.id, data: { from: lead.status, to: st, reason: ev.reason || 'n8n' } });
  return { lead_id: lead.id };
}

ingestRouter.post('/', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'bad ingest secret' });
  const ev = req.body || {};
  try {
    let result;
    switch (ev.type) {
      case 'conversation': result = handleConversation(ev); break;
      case 'journey': result = handleJourney(Array.isArray(ev.items) ? ev.items : [ev]); break;
      case 'status': result = handleStatus(ev); break;
      case 'delivery': result = { updated: !!updateMessageStatus(ev.wa_message_id, ev.status, { error: ev.error || null }) }; break;
      case 'ping': result = { ok: true, brain: config.brain }; break;
      default: return res.status(400).json({ error: `unknown event type ${ev.type}` });
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    log.error('ingest failed', e);
    res.status(400).json({ error: e.message });
  }
});
