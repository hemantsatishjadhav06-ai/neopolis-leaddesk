// Background loop: journey follow-ups (day-based template steps), NO_RESPONSE marking, sheet import + queue.
import { all, get, kvGet, kvSet, nowIso } from '../db.js';
import { config } from '../config.js';
import { getSetting, listFromCsv, getJourney, journeyStatus } from '../settings.js';
import { inSendWindow, hoursSince, minutesSince, istParts } from '../util/time.js';
import { getLead, updateLead, mirrorLead, audit } from './leads.js';
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

function allowedBySendMode(lead) {
  const mode = getSetting('send_mode');
  if (mode === 'live') return true;
  // Digit-normalised comparison — '+919000000001', '919000000001' and '9755527306' all match.
  if (mode === 'test') return isTestRecipient(lead.wa_number);
  return false;
}

const journeyLeads = () => all(`SELECT * FROM leads WHERE mode = 'ai' AND outreach_paused = 0 AND opted_out = 0 AND last_inbound_at IS NULL AND status IN ('CREATED','CONTACTED','FOLLOWUP_1','FOLLOWUP_2','FOLLOWUP_3','FOLLOWUP_4','FOLLOWUP_5') AND followup_attempts < ?`, Number(getSetting('max_followup_attempts')) || 3);

// Which leads are due right now (used both by the loop and by the "preview" button in Settings).
// The next step is the first one WhatsApp has not confirmed as delivered (see journey.js); it is due once the
// previous step has been delivered for day(N) - day(N-1) days, or, when it failed, once its retry gap is up.
// Leads with no journey messages on record fall back to followup_stage + days since the Day-0 send.
export function dueFollowups({ ignoreWindow = false } = {}) {
  const journey = getJourney();
  const now = Date.now();
  const due = [];
  const held = { delivery: 0, retry: 0 };
  for (const l of journeyLeads()) {
    const st = journeyState(l, journey, now);
    if (st.stop || st.next >= journey.length) continue;
    const step = journey[st.next];
    const ready = st.legacy ? (st.next === 0 || hoursSince(l.first_contact_at) >= step.day * 24) : st.readyAt <= now;
    if (!ready) { if (st.waiting === 'delivery') held.delivery++; else if (st.waiting === 'retry') held.retry++; continue; }
    due.push({ lead: l, step, stage: st.next, retry: st.attempts > 0, allowed: allowedBySendMode(l) });
  }
  return { due, held, inWindow: ignoreWindow || inSendWindow(getSetting('send_window_start'), getSetting('send_window_end')), sendMode: getSetting('send_mode'), journeyLength: journey.length };
}

// Meta status of each template by name, refreshed every 10 minutes. A journey step only goes out once its
// template is APPROVED, so a step renamed or rewritten in Settings waits for Meta's review instead of failing
// and using up every due lead's attempts. status = null means the check itself failed: send as before.
const TEMPLATE_CHECK_MS = 10 * 60 * 1000;
let templateCache = { at: 0, status: null, complete: false };
async function templateStatuses() {
  if (Date.now() - templateCache.at < TEMPLATE_CHECK_MS) return templateCache;
  try {
    const r = await wa.listTemplates();
    const status = new Map();
    for (const t of r.data || []) if (status.get(t.name) !== 'APPROVED') status.set(t.name, t.status); // any language approved is enough
    templateCache = { at: Date.now(), status, complete: !r.paging?.next };
  } catch (e) {
    log.warn('Could not check template approval', e.message);
    templateCache = { at: Date.now(), status: null, complete: false };
  }
  return templateCache;
}
function templateApproved(tpl, name) {
  if (!tpl.status) return true;
  const st = tpl.status.get(name);
  return st ? st === 'APPROVED' : !tpl.complete; // missing from a partial listing → don't hold
}

// Journey templates Meta accepted since midnight IST.
function journeySentToday() {
  const since = new Date(`${istParts().date}T00:00:00+05:30`).toISOString();
  return get(`SELECT COUNT(*) AS n FROM messages WHERE sender = 'system' AND type = 'template' AND wa_message_id IS NOT NULL AND created_at >= ?`, since).n;
}

// paced = the background loop: a few sends per run, runs spaced out. "Run now" skips the spacing; the daily cap
// applies to both. One run at a time, so a "Run now" during the background run cannot send a step twice.
let followupsRunning = false;
export async function runFollowups(opts = {}) {
  if (followupsRunning) return { skipped: 'already running' };
  followupsRunning = true;
  try { return await runFollowupsOnce(opts); } finally { followupsRunning = false; }
}

async function runFollowupsOnce({ maxPerRun = 40, paced = false } = {}) {
  if (config.brain === 'n8n') return { skipped: 'journey runs in n8n' };
  if (!wa.isConfigured()) return { skipped: 'whatsapp not configured' };
  for (const l of journeyLeads()) reconcileJourney(l); // receipts → stored stage/status, and stop leads that can't be reached
  const { due, held, inWindow, sendMode, journeyLength } = dueFollowups();
  if (sendMode === 'off') return { skipped: 'send_mode off', due: due.length };
  if (!inWindow) return { skipped: 'outside send window', due: due.length };
  const dailyCap = Number(getSetting('journey_daily_cap')) || Infinity;
  const dailyUsed = journeySentToday();
  let limit = maxPerRun, waiting = false;
  if (paced) {
    limit = Number(getSetting('journey_per_run')) || maxPerRun;
    const gap = Number(getSetting('journey_run_minutes')) || 0;
    if (gap && minutesSince(kvGet('followups.lastSendAt')) < gap) { limit = 0; waiting = true; }
  }
  limit = Math.max(0, Math.min(limit, dailyCap - dailyUsed));
  let sent = 0, failed = 0, skipped = 0;
  const tpl = limit && due.some(d => d.allowed) ? await templateStatuses() : { status: null };
  const awaitingApproval = new Set();
  for (const { lead, step, stage, retry, allowed } of due) {
    if (sent + failed >= limit) break;
    if (!allowed) { skipped++; continue; }
    if (!templateApproved(tpl, step.template)) { skipped++; awaitingApproval.add(step.template); continue; }
    const fresh = getLead(lead.id);
    if (!fresh || fresh.last_inbound_at || fresh.mode !== 'ai' || fresh.outreach_paused) { skipped++; continue; }
    const cur = journeyState(fresh);
    if (cur.stop || cur.next !== stage || (!cur.legacy && cur.readyAt > Date.now())) { skipped++; continue; }
    const params = getSetting('templates_use_name_param') ? [fresh.first_name || 'there'] : [];
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
  const graceHours = Number(getSetting('no_response_days')) * 24;
  for (const l of all(`SELECT * FROM leads WHERE last_inbound_at IS NULL AND followup_stage >= ? AND status IN ('CONTACTED','FOLLOWUP_1','FOLLOWUP_2','FOLLOWUP_3','FOLLOWUP_4','FOLLOWUP_5')`, journeyLength)) {
    if (hoursSince(l.last_followup_at) >= graceHours) {
      const updated = updateLead(l.id, { status: 'NO_RESPONSE' });
      audit('lead.status', { leadId: l.id, data: { from: l.status, to: 'NO_RESPONSE', reason: 'no reply after the full journey' } });
      mirrorLead(updated);
    }
  }
  if (paced && (sent || failed)) kvSet('followups.lastSendAt', nowIso());
  const result = { sent, failed, skipped, due: due.length, waitingForDelivery: held.delivery, waitingToResend: held.retry, dailyUsed: dailyUsed + sent, dailyCap: Number.isFinite(dailyCap) ? dailyCap : null, ...(waiting ? { paced: true } : {}), awaitingApproval: [...awaitingApproval], at: nowIso() };
  kvSet('followups.lastRun', result);
  return result;
}

let running = false;
async function tick() {
  if (running) return; running = true;
  try {
    const lastImport = kvGet('sheet.lastImportAt');
    if (activeSheetConfig().provider !== 'none' && getSetting('sheet_import_enabled') && minutesSince(lastImport) >= Number(getSetting('sheet_sync_minutes'))) {
      kvSet('sheet.lastImportAt', nowIso());
      try { await importFromSheet(); } catch (e) { log.error('Sheet import failed', e); kvSet('sheet.lastError', { at: nowIso(), error: e.message, op: 'import' }); }
    }
    try { await processSheetQueue(); } catch (e) { log.error('Sheet queue failed', e); }
    try { const r = await runFollowups({ paced: true }); if (r.sent || r.failed) log.info('Follow-ups', r); } catch (e) { log.error('Follow-up run failed', e); }
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
export function followupStatus() {
  const d = dueFollowups();
  return {
    lastRun: kvGet('followups.lastRun'), due: d.due.length, held: d.held, inWindow: d.inWindow, sendMode: d.sendMode, replyMode: getSetting('reply_mode'),
    whatsappConfigured: wa.isConfigured(),
    journey: getJourney().map(s => ({ key: s.key, day: s.day, template: s.template })),
    dueList: d.due.slice(0, 50).map(x => ({ id: x.lead.id, name: x.lead.full_name, wa_number: x.lead.wa_number, stage: x.stage, day: x.step.day, template: x.step.template, resend: x.retry, allowed: x.allowed })),
  };
}
