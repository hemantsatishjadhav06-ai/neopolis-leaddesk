// Background loop: journey follow-ups (day-based template steps), NO_RESPONSE marking, sheet import + queue.
import { all, get, kvGet, kvSet, nowIso } from '../db.js';
import { config } from '../config.js';
import { getSetting, listFromCsv, getJourney, journeyStatus } from '../settings.js';
import { inSendWindow, hoursSince, minutesSince } from '../util/time.js';
import { getLead, updateLead, mirrorLead, audit } from './leads.js';
import { sendTemplateOut, renderTemplateText } from './conversation.js';
import { importFromSheet, processSheetQueue } from './sync.js';
import { activeSheetConfig } from './sheets/active.js';
import { cleanupSessions } from './auth.js';
import { isTestRecipient, SendBlocked } from './guard.js';
import { maybeBackup } from './backup.js';
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

// Which leads are due right now (used both by the loop and by the "preview" button in Settings).
// followup_stage = number of journey steps already sent; step N is due once day(N) x 24h have passed since the Day-0 send.
export function dueFollowups({ ignoreWindow = false } = {}) {
  const journey = getJourney();
  const rows = all(`SELECT * FROM leads WHERE mode = 'ai' AND outreach_paused = 0 AND opted_out = 0 AND last_inbound_at IS NULL AND status IN ('CREATED','CONTACTED','FOLLOWUP_1','FOLLOWUP_2','FOLLOWUP_3','FOLLOWUP_4','FOLLOWUP_5') AND followup_attempts < ?`, Number(getSetting('max_followup_attempts')) || 3);
  const due = [];
  for (const l of rows) {
    const stage = l.followup_stage || 0;
    if (stage >= journey.length) continue;
    if (l.followup_retry_at && Date.parse(l.followup_retry_at) > Date.now()) continue; // undelivered step, waiting to retry
    const step = journey[stage];
    const ready = stage === 0 || hoursSince(l.first_contact_at) >= step.day * 24;
    if (!ready) continue;
    due.push({ lead: l, step, stage, allowed: allowedBySendMode(l) });
  }
  return { due, inWindow: ignoreWindow || inSendWindow(getSetting('send_window_start'), getSetting('send_window_end')), sendMode: getSetting('send_mode'), journeyLength: journey.length };
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

export async function runFollowups({ maxPerRun = 40 } = {}) {
  if (config.brain === 'n8n') return { skipped: 'journey runs in n8n' };
  if (!wa.isConfigured()) return { skipped: 'whatsapp not configured' };
  const { due, inWindow, sendMode, journeyLength } = dueFollowups();
  if (sendMode === 'off') return { skipped: 'send_mode off', due: due.length };
  if (!inWindow) return { skipped: 'outside send window', due: due.length };
  let sent = 0, failed = 0, skipped = 0;
  const tpl = due.some(d => d.allowed) ? await templateStatuses() : { status: null };
  const awaitingApproval = new Set();
  for (const { lead, step, stage, allowed } of due) {
    if (sent + failed >= maxPerRun) break;
    if (!allowed) { skipped++; continue; }
    if (!templateApproved(tpl, step.template)) { skipped++; awaitingApproval.add(step.template); continue; }
    const fresh = getLead(lead.id);
    if (!fresh || fresh.last_inbound_at || fresh.mode !== 'ai' || fresh.outreach_paused || (fresh.followup_stage || 0) !== stage) { skipped++; continue; }
    const params = getSetting('templates_use_name_param') ? [fresh.first_name || 'there'] : [];
    try {
      await sendTemplateOut(fresh, { name: step.template, bodyParams: params, sender: 'system', bodyText: renderTemplateText(step.key, fresh) });
      const ts = nowIso();
      const updated = updateLead(fresh.id, { status: journeyStatus(stage), followup_stage: stage + 1, first_contact_at: fresh.first_contact_at || ts, last_followup_at: ts, followup_attempts: 0, followup_retry_at: null, last_error: null });
      audit('followup.sent', { leadId: fresh.id, data: { template: step.template, stage, day: step.day } });
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
  const result = { sent, failed, skipped, due: due.length, awaitingApproval: [...awaitingApproval], at: nowIso() };
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
    try { const r = await runFollowups(); if (r.sent || r.failed) log.info('Follow-ups', r); } catch (e) { log.error('Follow-up run failed', e); }
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
    lastRun: kvGet('followups.lastRun'), due: d.due.length, inWindow: d.inWindow, sendMode: d.sendMode, replyMode: getSetting('reply_mode'),
    whatsappConfigured: wa.isConfigured(),
    journey: getJourney().map(s => ({ key: s.key, day: s.day, template: s.template })),
    dueList: d.due.slice(0, 50).map(x => ({ id: x.lead.id, name: x.lead.full_name, wa_number: x.lead.wa_number, stage: x.stage, day: x.step.day, template: x.step.template, allowed: x.allowed })),
  };
}
