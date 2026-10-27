// Background loop: journey follow-ups (day-based template steps), NO_RESPONSE marking, sheet import + queue.
import { all, get, kvGet, kvSet, nowIso } from '../db.js';
import { config } from '../config.js';
import { getSetting, listFromCsv, getJourney, journeyStatus } from '../settings.js';
import { inSendWindow, hoursSince, minutesSince, istParts } from '../util/time.js';
import { getLead, updateLead, mirrorLead, audit, firmTag } from './leads.js';
import { currentFirmId, inFirm, listFirms, firmKey, firmBrain, isDefaultFirm, firmPhoneNumberId, firmWabaId } from '../firms.js';
import { sendTemplateOut, renderTemplateText } from './conversation.js';
import { importFromSheet, processSheetQueue } from './sync.js';
import { activeSheetConfig } from './sheets/active.js';
import { cleanupSessions } from './auth.js';
import { isTestRecipient, SendBlocked } from './guard.js';
import { maybeBackup } from './backup.js';
import { journeyState, reconcileJourney } from './journey.js';
import { runMonitor } from './monitor.js';
import * as wa from './whatsapp.js';
import { log } from '../logger.js';

// Everything here runs for one firm at a time (firmId, default: the firm in context): its leads, its journey,
// its send mode, its pacing and daily cap.
function allowedBySendMode(lead) {
  const mode = getSetting('send_mode', lead.firm_id);
  if (mode === 'live') return true;
  // Digit-normalised comparison — '+919000000001', '919000000001' and '9755527306' all match.
  if (mode === 'test') return isTestRecipient(lead.wa_number, lead.firm_id);
  return false;
}

const journeyLeads = (firmId = currentFirmId()) => all(`SELECT * FROM leads WHERE firm_id = ? AND mode = 'ai' AND outreach_paused = 0 AND opted_out = 0 AND last_inbound_at IS NULL AND status IN ('CREATED','CONTACTED','FOLLOWUP_1','FOLLOWUP_2','FOLLOWUP_3','FOLLOWUP_4','FOLLOWUP_5') AND followup_attempts < ?`, Number(firmId), Number(getSetting('max_followup_attempts', firmId)) || 3);

// Which leads are due right now (used both by the loop and by the "preview" button in Settings).
// The next step is the first one WhatsApp has not confirmed as delivered (see journey.js); it is due once the
// previous step has been delivered for day(N) - day(N-1) days, or, when it failed, once its retry gap is up.
// Leads with no journey messages on record fall back to followup_stage + days since the Day-0 send.
export function dueFollowups({ ignoreWindow = false, firmId = currentFirmId() } = {}) {
  const journey = getJourney(firmId);
  const now = Date.now();
  const due = [];
  const held = { delivery: 0, retry: 0 };
  for (const l of journeyLeads(firmId)) {
    const st = journeyState(l, journey, now);
    if (st.stop || st.next >= journey.length) continue;
    const step = journey[st.next];
    const ready = st.legacy ? (st.next === 0 || hoursSince(l.first_contact_at) >= step.day * 24) : st.readyAt <= now;
    if (!ready) { if (st.waiting === 'delivery') held.delivery++; else if (st.waiting === 'retry') held.retry++; continue; }
    due.push({ lead: l, step, stage: st.next, retry: st.attempts > 0, allowed: allowedBySendMode(l) });
  }
  // First sends before re-sends, newest leads first: with a daily cap, retries to cold leads must not crowd out
  // a fresh lead's Day 0.
  due.sort((a, b) => (a.retry - b.retry) || (b.lead.id - a.lead.id));
  return { due, held, inWindow: ignoreWindow || inSendWindow(getSetting('send_window_start', firmId), getSetting('send_window_end', firmId)), sendMode: getSetting('send_mode', firmId), journeyLength: journey.length };
}

// Meta status of each template by name, refreshed every 10 minutes. A journey step only goes out once its
// template is APPROVED, so a step renamed or rewritten in Settings waits for Meta's review instead of failing
// and using up every due lead's attempts. status = null means the check itself failed: send as before.
// Templates belong to a WhatsApp Business Account, so the cache is per WABA.
const TEMPLATE_CHECK_MS = 10 * 60 * 1000;
const templateCaches = new Map(); // wabaId -> { at, status, complete }
async function templateStatuses(wabaId) {
  const cached = templateCaches.get(wabaId);
  if (cached && Date.now() - cached.at < TEMPLATE_CHECK_MS) return cached;
  let fresh;
  try {
    const r = await wa.listTemplates(wabaId);
    const status = new Map();
    for (const t of r.data || []) if (status.get(t.name) !== 'APPROVED') status.set(t.name, t.status); // any language approved is enough
    fresh = { at: Date.now(), status, complete: !r.paging?.next };
  } catch (e) {
    log.warn('Could not check template approval', e.message);
    fresh = { at: Date.now(), status: null, complete: false };
  }
  templateCaches.set(wabaId, fresh);
  return fresh;
}
function templateApproved(tpl, name) {
  if (!tpl.status) return true;
  const st = tpl.status.get(name);
  return st ? st === 'APPROVED' : !tpl.complete; // missing from a partial listing → don't hold
}

// Journey templates Meta accepted since midnight IST, for one firm.
function journeySentToday(firmId) {
  const since = new Date(`${istParts().date}T00:00:00+05:30`).toISOString();
  return get(`SELECT COUNT(*) AS n FROM messages m JOIN leads l ON l.id = m.lead_id WHERE l.firm_id = ? AND m.sender = 'system' AND m.type = 'template' AND m.wa_message_id IS NOT NULL AND m.created_at >= ?`, Number(firmId), since).n;
}

// paced = the background loop: a few sends per run, runs spaced out. "Run now" skips the spacing; the daily cap
// applies to both. One run at a time, so a "Run now" during the background run cannot send a step twice.
const followupsRunning = new Set(); // firm ids with a run in progress
export async function runFollowups(opts = {}) {
  const firmId = Number(opts.firmId || currentFirmId());
  if (followupsRunning.has(firmId)) return { skipped: 'already running' };
  followupsRunning.add(firmId);
  try { return await runFollowupsOnce({ ...opts, firmId }); } finally { followupsRunning.delete(firmId); }
}

async function runFollowupsOnce({ maxPerRun = 40, paced = false, firmId }) {
  if (firmBrain(firmId) === 'n8n') return { skipped: 'journey runs in n8n' };
  if (!wa.isConfigured()) return { skipped: 'whatsapp not configured' };
  if (!isDefaultFirm(firmId) && !firmPhoneNumberId(firmId)) return { skipped: 'no WhatsApp number connected for this firm yet' };
  const S = (key) => getSetting(key, firmId);
  for (const l of journeyLeads(firmId)) reconcileJourney(l); // receipts → stored stage/status, and stop leads that can't be reached
  const { due, held, inWindow, sendMode, journeyLength } = dueFollowups({ firmId });
  if (sendMode === 'off') return { skipped: 'send_mode off', due: due.length };
  if (!inWindow) return { skipped: 'outside send window', due: due.length };
  const dailyCap = Number(S('journey_daily_cap')) || Infinity;
  const dailyUsed = journeySentToday(firmId);
  let limit = maxPerRun, waiting = false;
  if (paced) {
    limit = Number(S('journey_per_run')) || maxPerRun;
    const gap = Number(S('journey_run_minutes')) || 0;
    if (gap && minutesSince(kvGet(firmKey('followups.lastSendAt', firmId))) < gap) { limit = 0; waiting = true; }
  }
  limit = Math.max(0, Math.min(limit, dailyCap - dailyUsed));
  let sent = 0, failed = 0, skipped = 0;
  const tpl = limit && due.some(d => d.allowed) ? await templateStatuses(firmWabaId(firmId)) : { status: null };
  const awaitingApproval = new Set();
  for (const { lead, step, stage, retry, allowed } of due) {
    if (sent + failed >= limit) break;
    if (!allowed) { skipped++; continue; }
    if (!templateApproved(tpl, step.template)) { skipped++; awaitingApproval.add(step.template); continue; }
    const fresh = getLead(lead.id);
    if (!fresh || fresh.last_inbound_at || fresh.mode !== 'ai' || fresh.outreach_paused) { skipped++; continue; }
    const cur = journeyState(fresh);
    if (cur.stop || cur.next !== stage || (!cur.legacy && cur.readyAt > Date.now())) { skipped++; continue; }
    const params = S('templates_use_name_param') ? [fresh.first_name || 'there'] : [];
    try {
      await sendTemplateOut(fresh, { name: step.template, bodyParams: params, sender: 'system', bodyText: renderTemplateText(step.key, fresh), meta: { journey_day: step.day } });
      const ts = nowIso();
      const updated = updateLead(fresh.id, { status: journeyStatus(stage), followup_stage: stage + 1, first_contact_at: fresh.first_contact_at || ts, last_followup_at: ts, followup_attempts: 0, last_error: null });
      audit('followup.sent', { leadId: fresh.id, data: { template: step.template, stage, day: step.day, ...(retry ? { resend: true } : {}) } });
      mirrorLead(updated);
      sent++;
    } catch (e) {
      // A policy block (send mode / cap) is not a delivery failure — don't burn a retry attempt on it.
      if (e instanceof SendBlocked || e.blocked) {
        skipped++;
        log.warn(`Follow-up held for ${fresh.wa_number}: ${e.message}`);
        continue;
      }
      failed++;
      const attempts = (fresh.followup_attempts || 0) + 1;
      updateLead(fresh.id, { followup_attempts: attempts, last_error: e.message });
      audit('followup.failed', { leadId: fresh.id, data: { template: step.template, error: e.message, attempts } });
      log.warn(`Follow-up failed for ${fresh.wa_number}: ${e.message}`);
    }
  }
  // Journey finished and still silent → NO_RESPONSE
  const graceHours = Number(S('no_response_days')) * 24;
  for (const l of all(`SELECT * FROM leads WHERE firm_id = ? AND last_inbound_at IS NULL AND followup_stage >= ? AND status IN ('CONTACTED','FOLLOWUP_1','FOLLOWUP_2','FOLLOWUP_3','FOLLOWUP_4','FOLLOWUP_5')`, firmId, journeyLength)) {
    if (hoursSince(l.last_followup_at) >= graceHours) {
      const updated = updateLead(l.id, { status: 'NO_RESPONSE' });
      audit('lead.status', { leadId: l.id, data: { from: l.status, to: 'NO_RESPONSE', reason: 'no reply after the full journey' } });
      mirrorLead(updated);
    }
  }
  if (paced && (sent || failed)) kvSet(firmKey('followups.lastSendAt', firmId), nowIso());
  const result = { sent, failed, skipped, due: due.length, waitingForDelivery: held.delivery, waitingToResend: held.retry, dailyUsed: dailyUsed + sent, dailyCap: Number.isFinite(dailyCap) ? dailyCap : null, ...(waiting ? { paced: true } : {}), awaitingApproval: [...awaitingApproval], at: nowIso() };
  kvSet(firmKey('followups.lastRun', firmId), result);
  return result;
}

// One firm's share of a tick: its sheet import (when due), its queued sheet writes, its journey sends.
async function tickFirm(firmId) {
  const lastImport = kvGet(firmKey('sheet.lastImportAt', firmId));
  if (activeSheetConfig(firmId).provider !== 'none' && getSetting('sheet_import_enabled', firmId) && minutesSince(lastImport) >= Number(getSetting('sheet_sync_minutes', firmId))) {
    kvSet(firmKey('sheet.lastImportAt', firmId), nowIso());
    try { await importFromSheet({ firmId }); } catch (e) { log.error(`Sheet import failed${firmTag(firmId)}`, e); kvSet(firmKey('sheet.lastError', firmId), { at: nowIso(), error: e.message, op: 'import' }); }
  }
  try { await processSheetQueue(25, firmId); } catch (e) { log.error(`Sheet queue failed${firmTag(firmId)}`, e); }
  try { const r = await runFollowups({ paced: true, firmId }); if (r.sent || r.failed) log.info(`Follow-ups${firmTag(firmId)}`, r); } catch (e) { log.error(`Follow-up run failed${firmTag(firmId)}`, e); }
}

let running = false;
async function tick() {
  if (running) return; running = true;
  try {
    for (const firm of listFirms({ activeOnly: true })) await inFirm(firm.id, () => tickFirm(firm.id));
    try { await maybeBackup(); } catch (e) { log.error('Backup run failed', e); }
    try { await runMonitor(); } catch (e) { log.error('Monitor run failed', e); }
    cleanupSessions();
  } finally { running = false; }
}

export function startScheduler() {
  if (!config.scheduler.enabled) { log.info('Scheduler disabled'); return; }
  const every = Math.max(15, config.scheduler.tickSeconds) * 1000;
  setTimeout(tick, 5000);
  setInterval(tick, every);
  log.info(`Scheduler running every ${every / 1000}s`);
}
export const runTickNow = tick;
export function followupStatus(firmId = currentFirmId()) {
  const d = dueFollowups({ firmId });
  return {
    lastRun: kvGet(firmKey('followups.lastRun', firmId)), due: d.due.length, held: d.held, inWindow: d.inWindow, sendMode: d.sendMode, replyMode: getSetting('reply_mode', firmId),
    whatsappConfigured: wa.isConfigured() && (isDefaultFirm(firmId) || !!firmPhoneNumberId(firmId)),
    journey: getJourney(firmId).map(s => ({ key: s.key, day: s.day, template: s.template })),
    dueList: d.due.slice(0, 50).map(x => ({ id: x.lead.id, name: x.lead.full_name, wa_number: x.lead.wa_number, stage: x.stage, day: x.step.day, template: x.step.template, resend: x.retry, allowed: x.allowed })),
  };
}
