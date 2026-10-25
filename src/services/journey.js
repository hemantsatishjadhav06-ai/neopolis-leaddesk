// Where a lead really is in the journey, worked out from WhatsApp's delivery receipts rather than from
// what we tried to send. A step counts only once WhatsApp confirms it reached the phone (delivered/read):
// until then the next step waits, so nobody gets Day 2 without having seen Day 0. A step that was not
// delivered is re-sent with growing gaps (Meta asks for 24h+ after #131049) until it lands, or until it
// clearly never will (a permanent error, or too many tries), and then outreach to that lead stops.
// The journey continues from the last step that was delivered: steps missed before it (under the old
// behaviour) are not back-filled, which would only send old messages out of order.
import { all, parseJson } from '../db.js';
import { getJourney, journeyStatus } from '../settings.js';
import { PERMANENT_DELIVERY_ERRORS } from './whatsapp.js';
import { updateLead, mirrorLead, audit } from './leads.js';
import { log } from '../logger.js';

export const DELIVERY = {
  pendingHours: 7 * 24,   // accepted by Meta but no receipt after this long → treat as not delivered, re-send
  retryHours: 24,         // first re-send 24h after a failure, then 48h, 96h … capped at maxRetryHours
  maxRetryHours: 7 * 24,
  maxAttempts: 5,         // undelivered attempts of one step before giving up on the lead
  minGapHours: 24,        // never two journey messages to the same lead within this
};

const H = 36e5;
const ts = (iso) => Date.parse(iso) || 0;
const delivered = (m) => m.status === 'delivered' || m.status === 'read';
const permanentCode = (m) => { const c = Number((String(m.error || '').match(/^#(\d+)/) || [])[1]); return PERMANENT_DELIVERY_ERRORS.has(c) ? c : null; };

// Which journey step a sent template belongs to: the day recorded at send time, else the template name,
// else the day in the name (neopolis_journey_d2_value, neopolis_v3_d2_area → day 2), so renaming the
// templates in Settings does not lose anyone's place.
export function stepOf(msg, journey) {
  const day = parseJson(msg.meta, {}).journey_day;
  if (Number.isInteger(day)) return journey.findIndex(s => s.day === day);
  const i = journey.findIndex(s => s.template === msg.template_name);
  if (i >= 0) return i;
  const m = String(msg.template_name || '').match(/_d(\d+)(?:_|$)/);
  return m ? journey.findIndex(s => s.day === Number(m[1])) : -1;
}

// Pure: the journey state from a lead's template messages (oldest first).
// → { next, readyAt, waiting: null|'delivery'|'retry'|'gap', attempts, stop: null|'permanent'|'gave_up', lastError, legacy }
export function computeJourneyState({ msgs, journey, stage = 0, now = Date.now(), opts = DELIVERY }) {
  const steps = journey.map(() => ({ delivered: null, tries: [] }));
  let lastSentAt = 0, any = false;
  for (const m of msgs) {
    const k = stepOf(m, journey);
    if (k < 0) continue;
    any = true;
    if (delivered(m)) { steps[k].delivered = steps[k].delivered || m; }
    else if (m.wa_message_id) steps[k].tries.push(m); // accepted by Meta, then failed or still waiting
    if (m.wa_message_id) lastSentAt = Math.max(lastSentAt, ts(m.created_at));
  }
  if (!any) return { next: stage, readyAt: 0, waiting: null, attempts: 0, stop: null, lastError: null, legacy: true };

  let lastDelivered = -1;
  steps.forEach((s, i) => { if (s.delivered) lastDelivered = i; });
  const next = lastDelivered + 1;
  const base = { next, readyAt: 0, waiting: null, attempts: 0, stop: null, lastError: null, legacy: false };
  if (next >= journey.length) return base;

  const tries = steps[next].tries;
  const pending = tries.filter(m => m.status !== 'failed' && now - ts(m.created_at) < opts.pendingHours * H);
  if (pending.length) return { ...base, waiting: 'delivery', readyAt: Infinity };
  const failed = tries; // failed, or no receipt for longer than pendingHours
  const last = failed[failed.length - 1];
  const out = { ...base, attempts: failed.length, lastError: last ? (last.error || 'No delivery receipt from WhatsApp') : null };
  if (failed.some(permanentCode)) return { ...out, stop: 'permanent', lastError: failed.find(permanentCode).error };
  if (failed.length >= opts.maxAttempts) return { ...out, stop: 'gave_up' };

  let readyAt = 0, waiting = null;
  const later = (t, why) => { if (t > readyAt) { readyAt = t; waiting = why; } };
  if (last) later(ts(last.created_at) + Math.min(opts.retryHours * 2 ** (failed.length - 1), opts.maxRetryHours) * H, 'retry');
  // Space the steps from when the lead actually received the previous one.
  if (next > 0) later(ts(steps[next - 1].delivered.created_at) + (journey[next].day - journey[next - 1].day) * 24 * H, 'gap');
  if (lastSentAt) later(lastSentAt + opts.minGapHours * H, 'gap');
  return { ...out, readyAt, waiting: readyAt > now ? waiting : null };
}

export function journeyMessages(leadId) {
  return all(`SELECT id, template_name, status, error, wa_message_id, meta, created_at FROM messages
              WHERE lead_id = ? AND direction = 'out' AND type = 'template' ORDER BY id`, leadId);
}
export function journeyState(lead, journey = getJourney(), now = Date.now()) {
  return computeJourneyState({ msgs: journeyMessages(lead.id), journey, stage: lead.followup_stage || 0, now });
}

// Bring the stored stage / status in line with the receipts (so the sheet and the dashboard show what the lead
// really received), and stop outreach when a step can never be delivered.
export function reconcileJourney(lead, journey = getJourney()) {
  if (!lead || lead.last_inbound_at || lead.opted_out) return lead;
  const st = journeyState(lead, journey);
  if (st.legacy || st.waiting === 'delivery') return lead; // a step in flight: wait for its receipt before changing anything
  const patch = {};
  if ((lead.followup_stage || 0) !== st.next) {
    patch.followup_stage = st.next;
    patch.status = st.next === 0 ? 'CREATED' : journeyStatus(st.next - 1);
  }
  if (st.lastError && lead.last_error !== st.lastError) patch.last_error = st.lastError;
  if (st.stop && !lead.outreach_paused) {
    patch.outreach_paused = 1;
    const day = journey[st.next]?.day;
    patch.last_error = st.stop === 'permanent'
      ? `${st.lastError} — outreach stopped`
      : `WhatsApp did not deliver the day-${day} message after ${st.attempts} tries (last: ${st.lastError}) — outreach stopped`;
    audit('followup.stopped', { leadId: lead.id, data: { reason: st.stop, step: st.next, day, attempts: st.attempts, error: st.lastError } });
    log.warn(`Journey stopped for lead ${lead.id}: ${patch.last_error}`);
  }
  if (!Object.keys(patch).length) return lead;
  const updated = updateLead(lead.id, patch, { silent: true });
  if (patch.status) mirrorLead(updated);
  return updated;
}
