// AI concierge — one chat-completion call returns the reply AND a structured analysis
// (intent, extracted corridor/budget/timeline, qualified, hand-off) as JSON.
import { config } from '../config.js';
import { getSetting } from '../settings.js';
import { currentFirmId } from '../firms.js';
import { log } from '../logger.js';
import { createLimiter } from '../util/limit.js';

// Bound simultaneous LLM calls (see util/limit.js).
const aiLimit = createLimiter(config.limits.aiConcurrency);
export const aiQueueStats = () => aiLimit.stats();

export const INTENTS = ['greeting', 'interest', 'question', 'price', 'location', 'loan', 'visit', 'callback', 'language', 'opt_out', 'complaint', 'unrelated', 'other'];

// The JSON contract every reply follows. The hand-off line names the lead's firm, and what counts as "qualified"
// is the firm's own rule (ai_qualify_rule): corridor + budget for a property firm, something else elsewhere.
const outputContract = (firmId) => `
OUTPUT FORMAT — respond with ONE JSON object only, no markdown, with exactly these keys:
{
  "reply": "the WhatsApp message to send to the buyer (plain text, line breaks allowed)",
  "language": "en" | "hi" | "te" | "other",
  "intent": one of ${JSON.stringify(INTENTS)},
  "corridor": "corridor the buyer prefers, if known (else null)",
  "budget": "budget range the buyer mentioned, if known (else null)",
  "timeline": "when they want to buy, if known (else null)",
  "configuration": "unit type/size they want, if known (else null)",
  "qualified": true if ${getSetting('ai_qualify_rule', firmId)}, else false,
  "handoff": true if a human consultant should take over now (buyer asks for a visit, a call, exact prices/availability, a complaint, an angry message, wants to talk to a person, or asks something you cannot answer from the facts), else false,
  "handoff_reason": "short reason when handoff is true, else null",
  "sentiment": "positive" | "neutral" | "negative"
}
When handoff is true, your reply must tell the buyer a ${getSetting('company_name', firmId)} consultant will connect with them shortly (do not promise a specific time).`;

function leadFacts(lead) {
  const facts = [];
  if (lead.first_name) facts.push(`First name: ${lead.first_name}`);
  if (lead.corridor) facts.push(`Preferred corridor: ${lead.corridor}`);
  if (lead.budget) facts.push(`Budget: ${lead.budget}`);
  if (lead.timeline) facts.push(`Timeline: ${lead.timeline}`);
  if (lead.configuration) facts.push(`Configuration: ${lead.configuration}`);
  if (lead.funding) facts.push(`Funding plan: ${lead.funding}`);
  if (lead.objective) facts.push(`Objective: ${lead.objective}`);
  if (lead.language && lead.language !== 'en') facts.push(`Preferred language: ${lead.language}`);
  return facts.length ? `KNOWN ABOUT THIS BUYER (from their ad form / earlier chat — do not ask again for what is already known):\n- ${facts.join('\n- ')}` : 'Nothing is known about this buyer yet beyond their name.';
}

export function buildMessages({ lead, history, inboundText }) {
  const firmId = lead.firm_id || currentFirmId();
  const system = `${getSetting('ai_system_prompt', firmId)}\n\n${leadFacts(lead)}\n${outputContract(firmId)}`;
  const msgs = [{ role: 'system', content: system }];
  for (const m of history) {
    if (m.direction === 'in') msgs.push({ role: 'user', content: m.body || `[${m.type}]` });
    else msgs.push({ role: 'assistant', content: m.sender === 'human' ? `[Consultant] ${m.body}` : (m.body || `[template: ${m.template_name}]`) });
  }
  msgs.push({ role: 'user', content: inboundText || '[non-text message]' });
  return msgs;
}

function coerce(obj, inboundText, firmId = currentFirmId()) {
  const s = (v) => (v == null || v === '' || v === 'null' ? null : String(v).trim().slice(0, 120));
  const out = {
    reply: String(obj.reply || '').trim(),
    language: ['en', 'hi', 'te', 'other'].includes(obj.language) ? obj.language : 'en',
    intent: INTENTS.includes(obj.intent) ? obj.intent : 'other',
    corridor: s(obj.corridor), budget: s(obj.budget), timeline: s(obj.timeline), configuration: s(obj.configuration),
    qualified: obj.qualified === true,
    handoff: obj.handoff === true,
    handoff_reason: s(obj.handoff_reason),
    sentiment: ['positive', 'neutral', 'negative'].includes(obj.sentiment) ? obj.sentiment : 'neutral',
  };
  if (!out.reply) out.reply = getSetting('ai_fallback_reply', firmId);
  return out;
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

// ---- mock brain for local testing ----
function mockReply({ lead, inboundText }) {
  const t = (inboundText || '').toLowerCase();
  const name = lead.first_name ? `${lead.first_name}, ` : '';
  const known = { corridor: lead.corridor, budget: lead.budget };
  const res = { language: 'en', sentiment: 'positive', intent: 'other', corridor: null, budget: null, timeline: null, configuration: null, qualified: false, handoff: false, handoff_reason: null };
  if (/\b(stop|unsubscribe|not interested)\b/.test(t)) { Object.assign(res, { intent: 'opt_out', reply: "Understood — I won't send any further messages. Wishing you the best." }); }
  else if (/visit|call me|appointment/.test(t)) { Object.assign(res, { intent: 'visit', qualified: true, handoff: true, handoff_reason: 'Asked for a site visit', reply: `Wonderful, ${name}I'd be glad to arrange a site visit. A Neopolis consultant will connect with you shortly to fix a convenient slot.` }); }
  else if (/kokapet|narsingi|tellapur|kollur|manchirevula|financial district/.test(t)) {
    const c = t.match(/kokapet|narsingi|tellapur|kollur|manchirevula|financial district/)[0];
    res.corridor = c.replace(/\b\w/g, x => x.toUpperCase());
    res.intent = 'location';
    res.qualified = !!(known.budget);
    res.reply = `Great choice — ${res.corridor} is one of our most sought-after corridors. ${known.budget ? 'Our team will shortlist verified landlord-share options for you.' : 'To shortlist the right options, what budget range are you considering?'}`;
    if (res.qualified) { res.handoff = true; res.handoff_reason = 'Corridor and budget known'; res.reply += ' A Neopolis consultant will connect with you shortly.'; }
  }
  else if (/cr|crore|lakh|budget|price|cost/.test(t)) {
    res.intent = 'price'; res.budget = (t.match(/[\d.]+\s*(cr|crore|lakh)/) || [t.slice(0, 30)])[0];
    res.qualified = !!known.corridor;
    res.reply = `Thank you, ${name}our West Hyderabad homes range from under Rs 1 Cr to Rs 3.5 Cr+, typically 8-14% below resale in the same tower. ${known.corridor ? 'A consultant will share verified options shortly.' : 'Which corridor do you prefer — Kokapet, Narsingi, Tellapur, Kollur, Manchirevula or the Financial District?'}`;
    if (res.qualified) { res.handoff = true; res.handoff_reason = 'Corridor and budget known'; }
  }
  else if (/loan|emi|bank/.test(t)) { Object.assign(res, { intent: 'loan', reply: `Yes ${name}home loans work for most of our units — do confirm eligibility with your lender. Which corridor and budget are you considering?` }); }
  else if (/hi|hello|hey|yes|interested|details/.test(t)) { Object.assign(res, { intent: 'interest', reply: `Hello ${name}thank you for your interest in Neopolis Infra — premium 3 & 4 BHK homes in West Hyderabad, direct from landowners with zero brokerage. Which corridor do you prefer?` }); }
  else { Object.assign(res, { intent: 'question', reply: `Thanks ${name}happy to help. Could you tell me your preferred corridor and budget so I can point you to the right options?` }); }
  return res;
}

export async function generateReply(args) {
  return aiLimit(() => generateReplyInner(args));
}

async function generateReplyInner({ lead, history, inboundText }) {
  const started = Date.now();
  const firmId = lead.firm_id || currentFirmId();
  if (config.ai.mock || config.ai.provider === 'mock') {
    return { ...coerce(mockReply({ lead, inboundText }), inboundText, firmId), model: 'mock', latency_ms: Date.now() - started };
  }
  if (!config.ai.apiKey) throw new Error('AI is not configured (OPENROUTER_API_KEY missing)');
  const model = getSetting('ai_model', firmId);
  const body = {
    model,
    temperature: Number(getSetting('ai_temperature', firmId)),
    max_tokens: 600,
    response_format: { type: 'json_object' },
    messages: buildMessages({ lead, history, inboundText }),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.ai.apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': config.publicUrl || 'https://neopolisinfra.com', 'X-Title': 'Neopolis LeadDesk' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`AI provider error ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    const content = json.choices?.[0]?.message?.content || '';
    const parsed = parseJsonLoose(content);
    if (!parsed) { log.warn('AI returned non-JSON; using raw text as reply'); return { ...coerce({ reply: content }, inboundText, firmId), model, latency_ms: Date.now() - started, usage: json.usage }; }
    return { ...coerce(parsed, inboundText, firmId), model, latency_ms: Date.now() - started, usage: json.usage };
  } finally { clearTimeout(timer); }
}

// Is the AI key usable? Asked of the provider directly (OpenRouter: GET /key and /credits; OpenAI-style: GET
// /models), so a dead key shows up at boot and in the hourly monitor, not only when a lead's reply falls back.
// The key itself is never returned: only a masked form (like OpenRouter's own label) and its shape.
export const maskKey = (k) => (k ? `${k.slice(0, 12)}…${k.slice(-4)}` : '');
async function getJson(url, key) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, json, text };
}
export async function aiKeyHealth() {
  if (config.ai.mock || config.ai.provider === 'mock') return { ok: true, mock: true };
  const key = config.ai.apiKey;
  const openrouter = config.ai.provider === 'openrouter';
  if (!key) return { ok: false, detail: `${openrouter ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'} is not set` };
  const shape = { key: maskKey(key), length: key.length };
  if (openrouter && !key.startsWith('sk-or-')) shape.warning = 'does not start with sk-or- (every OpenRouter key does) — is it a key from another service?';
  if (config.ai.apiKeyCleaned) shape.cleaned = 'quotes, spaces or "Bearer " were removed from the variable';
  const url = `${config.ai.baseUrl}/${openrouter ? 'key' : 'models'}`;
  try {
    const { res, json, text } = await getJson(url, key);
    if (!res.ok) {
      const detail = json.error?.message || text.slice(0, 200) || res.statusText;
      const hint = res.status === 401 || res.status === 403
        ? (openrouter ? 'This key belongs to no OpenRouter account (deleted, mistyped, or from another service). Create one at https://openrouter.ai/keys and set OPENROUTER_API_KEY in Railway.' : 'The provider rejected this key.')
        : '';
      return { ok: false, status: res.status, detail, ...(hint ? { hint } : {}), ...shape };
    }
    if (!openrouter) return { ok: true, ...shape };
    const d = json.data || {};
    const out = { ok: true, ...shape, label: d.label || null, keyLimit: d.limit ?? null, keyRemaining: d.limit_remaining ?? null, usage: d.usage ?? null, freeTier: !!d.is_free_tier };
    // Account balance: a valid key on an account with no credit still fails every paid model with 402.
    try {
      const c = await getJson(`${config.ai.baseUrl}/credits`, key);
      if (c.res.ok && c.json.data) out.balance = Math.round(((c.json.data.total_credits || 0) - (c.json.data.total_usage || 0)) * 100) / 100;
    } catch { /* balance is optional */ }
    if (out.keyRemaining !== null && out.keyRemaining <= 0) return { ...out, ok: false, detail: 'This key has used up its credit limit', hint: 'Raise the key\'s limit on https://openrouter.ai/keys or create a new key.' };
    if (out.balance !== undefined && out.balance <= 0) return { ...out, ok: false, detail: 'The OpenRouter account has no credit left', hint: 'Add credit on https://openrouter.ai/credits (paid models such as openai/gpt-4o-mini need it).' };
    return out;
  } catch (e) { return { ok: null, detail: `could not reach ${url}: ${e.message}`, ...shape }; }
}

// Quick connectivity test used from Settings
export async function testAi() {
  const r = await generateReply({ lead: { first_name: 'Test' }, history: [], inboundText: 'Hi, I am looking for a 3 BHK in Kokapet around 2 Cr' });
  return r;
}
