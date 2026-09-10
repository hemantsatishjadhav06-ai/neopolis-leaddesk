// Inbound pipeline: webhook payload → lead → (opt-out | AI reply | human queue) → sheet mirror.
// Also the outbound helpers used by the inbox (human replies, templates).
import { get } from '../db.js';
import { config } from '../config.js';
import { assertCanSend, noteSent, SendBlocked } from './guard.js';
import { getSetting, listFromCsv, journeyStep, getJourney } from '../settings.js';
import { normalizePhone, firstName } from '../util/normalize.js';
import { stampIst } from '../util/time.js';
import * as wa from './whatsapp.js';
import { generateReply } from './ai.js';
import { broadcast } from './events.js';
import { log } from '../logger.js';
import {
  getLead, getLeadByNumber, createLead, updateLead, addMessage, updateMessageStatus, getHistory, handoff, flagForSales,
  mirrorLead, mirrorReply, PRE_REPLY, windowOpen, audit, serializeLead, sendAlertWebhook,
} from './leads.js';

// Serialise processing per lead so two quick messages never produce two overlapping AI replies.
const chains = new Map();
function serial(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => { if (chains.get(key) === next) chains.delete(key); });
  chains.set(key, next);
  return next;
}

export function extractText(m) {
  switch (m.type) {
    case 'text': return { text: m.text?.body || '', type: 'text' };
    case 'button': return { text: m.button?.text || m.button?.payload || '', type: 'button' };
    case 'interactive': return { text: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '', type: 'interactive' };
    case 'image': return { text: m.image?.caption || '', type: 'image' };
    case 'video': return { text: m.video?.caption || '', type: 'video' };
    case 'document': return { text: m.document?.caption || m.document?.filename || '', type: 'document' };
    case 'audio': return { text: '', type: 'audio' };
    case 'location': return { text: m.location ? `Location shared: ${m.location.name || ''} ${m.location.latitude},${m.location.longitude}`.trim() : '', type: 'location' };
    case 'contacts': return { text: 'Contact card shared', type: 'contacts' };
    case 'reaction': return { text: m.reaction?.emoji || '', type: 'reaction' };
    default: return { text: '', type: m.type || 'other' };
  }
}

function isOptOut(text) {
  const t = String(text || '').toLowerCase();
  return listFromCsv(getSetting('optout_keywords')).some(k => k && t.includes(k.toLowerCase()));
}

// Entry point from the webhook route — returns quickly; processing continues in the background.
export function ingestWebhook(body) {
  const jobs = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || '';
      const contacts = value.contacts || [];
      for (const m of value.messages || []) {
        const contact = contacts.find(c => c.wa_id === m.from) || contacts[0];
        jobs.push(serial(m.from, () => handleInbound({ message: m, profileName: contact?.profile?.name || '', phoneNumberId }).catch(e => log.error('inbound failed', e))));
      }
      for (const s of value.statuses || []) {
        try { updateMessageStatus(s.id, s.status, { error: s.errors?.[0] ? `${s.errors[0].title || ''} ${s.errors[0].message || ''} ${s.errors[0].error_data?.details || ''}`.trim() : null }); }
        catch (e) { log.warn('status update failed', e.message); }
      }
    }
  }
  return jobs.length;
}

export async function handleInbound({ message, profileName = '', phoneNumberId = '' }) {
  const waNumber = normalizePhone('+' + String(message.from).replace(/^\+/, ''));
  if (!waNumber) { log.warn('inbound from un-normalisable number', message.from); return; }
  if (message.id && get('SELECT id FROM messages WHERE wa_message_id = ?', message.id)) return; // webhook retry → ignore

  let lead = getLeadByNumber(waNumber);
  if (!lead) lead = createLead({ wa_number: waNumber, full_name: profileName, source: 'inbound', status: 'REPLIED' });
  else if (!lead.full_name && profileName) lead = updateLead(lead.id, { full_name: profileName, first_name: firstName(profileName) }, { silent: true });

  const { text, type } = extractText(message);
  const inbound = addMessage(lead.id, { direction: 'in', sender: 'lead', type, body: text, wa_message_id: message.id, status: 'received', meta: { phoneNumberId, wa_type: message.type, timestamp: message.timestamp } });
  lead = getLead(lead.id);

  // Any reply moves a pre-reply lead to REPLIED (and stops follow-ups).
  const patch = {};
  if (PRE_REPLY.includes(lead.status)) patch.status = 'REPLIED';
  if (Object.keys(patch).length) { lead = updateLead(lead.id, patch); audit('lead.status', { leadId: lead.id, data: { from: 'auto', to: patch.status, reason: 'inbound' } }); }
  const lastReply = `${stampIst()} - ${String(text || `[${type}]`).replace(/\s+/g, ' ').slice(0, 80)}`;
  mirrorLead(lead, lastReply);
  if (getSetting('mark_read')) wa.markRead(message.id, { phoneNumberId }).catch(() => {});

  // Opt-out honoured regardless of mode.
  if (text && isOptOut(text)) {
    lead = updateLead(lead.id, { status: 'OPTED_OUT', opted_out: 1, outreach_paused: 1 });
    audit('lead.optout', { leadId: lead.id });
    mirrorLead(lead, lastReply);
    let replyText = '';
    if (getSetting('ai_enabled') && lead.mode === 'ai') {
      replyText = getSetting('optout_reply');
      await safeSend(lead, { text: replyText, sender: 'system', inReplyTo: inbound.id, phoneNumberId });
    }
    mirrorReply(lead, { message: text, aiReply: replyText });
    return;
  }

  let aiReplyText = '';
  if (lead.mode === 'ai' && getSetting('ai_enabled') && config.brain !== 'n8n') {
    aiReplyText = await aiRespond(lead, inbound, { phoneNumberId });
  } else {
    broadcast('alert', { kind: 'human_unread', lead_id: lead.id, name: lead.full_name || lead.wa_number, preview: text.slice(0, 80) });
    if (getSetting('alert_on_human_unread')) sendAlertWebhook({ type: 'human_unread', lead: serializeLead(lead), message: text }).catch(() => {});
  }
  mirrorReply(getLead(lead.id), { message: text || `[${type}]`, aiReply: aiReplyText });
}

async function aiRespond(lead, inbound, { phoneNumberId }) {
  const history = getHistory(lead.id, Number(getSetting('ai_history_messages')) || 16, inbound.id);
  let analysis;
  try {
    analysis = await generateReply({ lead, history, inboundText: inbound.body || `[${inbound.type} message]` });
  } catch (e) {
    log.error('AI generation failed', e);
    audit('ai.error', { leadId: lead.id, data: { error: e.message } });
    const fallback = getSetting('ai_fallback_reply');
    await safeSend(lead, { text: fallback, sender: 'ai', inReplyTo: inbound.id, phoneNumberId, meta: { error: e.message, fallback: true } });
    // AI stays ON even after an error — a human is alerted but the bot keeps the chat unless someone takes over.
    broadcast('alert', { kind: 'human_unread', lead_id: lead.id, name: lead.full_name || lead.wa_number, preview: 'AI error — fallback sent, bot still on' });
    return fallback;
  }

  // Remember what the AI learned.
  const learned = {};
  for (const k of ['corridor', 'budget', 'timeline', 'configuration']) if (analysis[k]) learned[k] = analysis[k];
  if (analysis.language && analysis.language !== 'other') learned.language = analysis.language;
  if (Object.keys(learned).length) lead = updateLead(lead.id, learned, { silent: true });

  if (analysis.intent === 'opt_out') {
    lead = updateLead(lead.id, { status: 'OPTED_OUT', opted_out: 1, outreach_paused: 1 });
    audit('lead.optout', { leadId: lead.id, data: { byAi: true } });
    mirrorLead(lead);
  }

  const { reply, ...meta } = analysis;
  await safeSend(lead, { text: reply, sender: 'ai', inReplyTo: inbound.id, phoneNumberId, meta });

  const shouldHandoff = getSetting('auto_handoff') && (analysis.handoff || analysis.qualified) && analysis.intent !== 'opt_out';
  if (shouldHandoff) {
    const reason = analysis.handoff_reason || (analysis.qualified ? 'Lead qualified (corridor + budget known)' : 'AI requested hand-off');
    flagForSales(getLead(lead.id), { reason, byAi: true });
  } else if (analysis.qualified && !lead.qualified) {
    updateLead(lead.id, { qualified: 1, qualified_at: new Date().toISOString() });
  }
  return reply;
}

// Automatic (AI / system) sends: never let a blocked or failed send escape into webhook processing.
// The attempt is already recorded on the conversation by sendOut(), so this only decides control flow.
async function safeSend(lead, opts) {
  try { return await sendOut(lead, opts); }
  catch (e) {
    if (e instanceof SendBlocked) return null;           // recorded as 'blocked'
    log.error('Automatic send failed', e);               // recorded as 'failed'
    return null;
  }
}

// Send a free-form text and record it. Throws on failure (after recording a failed message).
export async function sendOut(lead, { text, sender = 'human', userId = null, inReplyTo = null, phoneNumberId = null, meta = {} }) {
  const kind = sender === 'ai' ? 'ai' : sender === 'human' ? 'human' : 'system';
  try {
    assertCanSend(lead, kind);
  } catch (e) {
    if (e instanceof SendBlocked) {
      addMessage(lead.id, { direction: 'out', sender, sender_user_id: userId, type: 'text', body: text, status: 'blocked', error: e.message, in_reply_to: inReplyTo, meta: { ...meta, blocked: e.reason } });
      log.warn(`Outbound blocked (${e.reason}) for lead ${lead.id}`);
    }
    throw e;
  }
  try {
    const r = await wa.sendText(lead.wa_number, text, { phoneNumberId: phoneNumberId || undefined });
    noteSent(kind);
    return addMessage(lead.id, { direction: 'out', sender, sender_user_id: userId, type: 'text', body: text, wa_message_id: r.id || null, status: 'sent', in_reply_to: inReplyTo, meta });
  } catch (e) {
    addMessage(lead.id, { direction: 'out', sender, sender_user_id: userId, type: 'text', body: text, status: 'failed', error: e.message, in_reply_to: inReplyTo, meta });
    updateLead(lead.id, { last_error: e.message }, { silent: true });
    throw e;
  }
}

export async function sendTemplateOut(lead, { name, language, bodyParams = [], sender = 'system', userId = null, bodyText = '' }) {
  const kind = sender === 'human' ? 'human' : 'journey';
  try {
    assertCanSend(lead, kind);
  } catch (e) {
    if (e instanceof SendBlocked) {
      addMessage(lead.id, { direction: 'out', sender, sender_user_id: userId, type: 'template', template_name: name, body: bodyText, status: 'blocked', error: e.message, meta: { bodyParams, blocked: e.reason } });
      log.warn(`Template blocked (${e.reason}) for lead ${lead.id}`);
    }
    throw e;
  }
  try {
    const r = await wa.sendTemplate(lead.wa_number, { name, language: language || getSetting('template_language'), bodyParams });
    noteSent(kind);
    return addMessage(lead.id, { direction: 'out', sender, sender_user_id: userId, type: 'template', template_name: name, body: bodyText, wa_message_id: r.id || null, status: 'sent', meta: { bodyParams } });
  } catch (e) {
    addMessage(lead.id, { direction: 'out', sender, sender_user_id: userId, type: 'template', template_name: name, body: bodyText, status: 'failed', error: e.message, meta: { bodyParams } });
    updateLead(lead.id, { last_error: e.message }, { silent: true });
    throw e;
  }
}

export function renderTemplateText(key, lead) {
  const step = journeyStep(key);
  const t = step ? step.text : '';
  return t.replace(/\{\{\s*1\s*\}\}/g, lead.first_name || 'there');
}
export const templateChoices = (lead) => getJourney().map(s => ({ key: s.key, day: s.day, name: s.template, text: renderTemplateText(s.key, lead) }));

// Human reply from the inbox
export async function humanReply(leadId, userId, text) {
  const lead = getLead(leadId);
  if (!lead) throw new Error('Lead not found');
  if (!text || !String(text).trim()) throw new Error('Message is empty');
  if (!windowOpen(lead)) throw new Error('The 24-hour window is closed — send an approved template instead');
  const msg = await sendOut(lead, { text: String(text).trim(), sender: 'human', userId });
  audit('message.human', { leadId, userId, data: { id: msg.id } });
  return msg;
}
export async function humanTemplate(leadId, userId, key) {
  const lead = getLead(leadId);
  if (!lead) throw new Error('Lead not found');
  const step = journeyStep(key);
  if (!step) throw new Error('Template not found in the journey');
  const params = getSetting('templates_use_name_param') ? [lead.first_name || 'there'] : [];
  const msg = await sendTemplateOut(lead, { name: step.template, bodyParams: params, sender: 'human', userId, bodyText: renderTemplateText(step.key, lead) });
  audit('message.template.human', { leadId, userId, data: { name: step.template } });
  return msg;
}
