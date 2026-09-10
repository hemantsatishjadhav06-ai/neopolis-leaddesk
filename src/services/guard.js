// Central outbound-send policy + spend ceilings.
//
// WHY: send_mode used to gate ONLY the journey scheduler. Reactive AI replies called wa.sendText()
// directly, so a (spoofable) inbound webhook could make the app send real, billable WhatsApp messages
// to arbitrary numbers. Every outbound path now goes through assertCanSend().
import { kvGet, kvSet } from '../db.js';
import { config } from '../config.js';
import { getSetting, listFromCsv } from '../settings.js';
import { log } from '../logger.js';

export class SendBlocked extends Error {
  constructor(message, reason) { super(message); this.name = 'SendBlocked'; this.reason = reason; this.blocked = true; }
}

const digits = (v) => String(v || '').replace(/\D/g, '');
const today = () => new Date().toISOString().slice(0, 10);

function counters() {
  const c = kvGet('limits.counters', null);
  if (!c || c.date !== today()) return { date: today(), sends: 0, ai: 0 };
  return c;
}
function bump(field, n = 1) {
  const c = counters(); c[field] = (c[field] || 0) + n; kvSet('limits.counters', c); return c;
}

export const spendSnapshot = () => {
  const c = counters();
  return { date: c.date, sends: c.sends, sendCap: config.limits.sendsPerDay, aiReplies: c.ai, aiCap: config.limits.aiRepliesPerDay };
};

export function isTestRecipient(waNumber) {
  const want = digits(waNumber);
  if (!want) return false;
  return listFromCsv(getSetting('test_recipients')).some(n => digits(n) === want);
}

// Proactive journey templates follow send_mode; everything reactive follows reply_mode.
export function governingMode(kind) {
  return kind === 'journey' ? getSetting('send_mode') : getSetting('reply_mode');
}

// kind: 'ai' | 'journey' | 'human' | 'system'
export function assertCanSend(lead, kind = 'system') {
  const mode = governingMode(kind);
  const label = kind === 'journey' ? 'Send mode' : 'Reply mode';
  const where = kind === 'journey' ? 'Settings → Outreach' : 'Settings → Outreach → Reply mode';
  const to = lead?.wa_number;
  if (!to) throw new SendBlocked('Lead has no WhatsApp number', 'no-number');

  // FAIL CLOSED. Only an exact 'live' sends without restriction; only an exact 'test' sends to the
  // test list. Anything else — a typo, a wrong case, an empty/missing settings row — blocks, rather
  // than silently behaving like 'live' against real customers.
  if (mode === 'live') {
    // allowed, fall through to the spend ceilings
  } else if (mode === 'test') {
    if (!isTestRecipient(to)) {
      throw new SendBlocked(`${label} is TEST — ${to} is not in the test numbers list, so nothing was sent.`, 'not-test-recipient');
    }
  } else if (mode === 'off') {
    throw new SendBlocked(`${label} is OFF — nothing was sent. Change it in ${where}.`, 'mode-off');
  } else {
    throw new SendBlocked(`${label} has an unrecognised value (${JSON.stringify(mode)}) — refusing to send. Set it to off, test or live in ${where}.`, 'mode-invalid');
  }

  const c = counters();
  if (c.sends >= config.limits.sendsPerDay) {
    throw new SendBlocked(`Daily send cap reached (${config.limits.sendsPerDay}). Raise SEND_DAILY_CAP if this is expected.`, 'send-cap');
  }
  if (kind === 'ai' && c.ai >= config.limits.aiRepliesPerDay) {
    throw new SendBlocked(`Daily AI reply cap reached (${config.limits.aiRepliesPerDay}).`, 'ai-cap');
  }
  return true;
}

export function noteSent(kind = 'system') {
  const c = bump('sends');
  if (kind === 'ai') bump('ai');
  const warnAt = Math.floor(config.limits.sendsPerDay * 0.8);
  if (c.sends === warnAt) log.warn(`Send volume at 80% of daily cap (${c.sends}/${config.limits.sendsPerDay})`);
  return c;
}
