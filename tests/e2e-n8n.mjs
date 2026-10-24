// n8n-brain mode test: LeadDesk as inbox, events arriving from n8n, sheet access through a (fake) n8n bridge.
// Run: node tests/e2e-n8n.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createMemoryProvider } from '../src/services/sheets/memory.js';

const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const BRIDGE_PORT = PORT + 1;
const SECRET = 'bridge-secret-123', INGEST = 'ingest-secret-456';

// ---- fake n8n Sheet Bridge (what the "Neopolis WA · Sheet Bridge" workflow does) ----
const sheet = createMemoryProvider();
const bridgeCalls = [];
const bridge = http.createServer(async (req, res) => {
  let body = ''; req.on('data', d => body += d); await new Promise(r => req.on('end', r));
  const send = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers['x-bridge-secret'] !== SECRET) return send({ error: 'unauthorized' }, 401);
  const p = JSON.parse(body || '{}'); bridgeCalls.push(p);
  try {
    if (p.op === 'ping') return send({ ok: true, name: 'fake bridge', tabs: ['02-08-2026'] });
    if (p.op === 'readLeads') { const r = await sheet.readLeads(); return send({ tab: r.tab, rows: r.rows.map(x => Object.fromEntries([...r.headers.map((h, i) => [h, x.values[i]]), ['row_number', x.rowNumber]])) }); }
    if (p.op === 'updateRow') { await sheet.updateRow(p.rowNumber, p.values); return send({ ok: true }); }
    if (p.op === 'appendReply') { await sheet.appendReply(p.row); return send({ ok: true }); }
    send({ error: 'unknown op' }, 400);
  } catch (e) { send({ error: e.message }, 500); }
});
await new Promise(r => bridge.listen(BRIDGE_PORT, r));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaddesk-n8n-'));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, WA_MOCK: '1', AI_MOCK: '1', BRAIN: 'n8n', INGEST_SECRET: INGEST, SHEETS_PROVIDER: 'n8n', N8N_BRIDGE_URL: `http://localhost:${BRIDGE_PORT}/bridge`, N8N_BRIDGE_SECRET: SECRET, SCHEDULER_ENABLED: '0', PUBLIC_URL: BASE, NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; server.stdout.on('data', d => { logs += d; }); server.stderr.on('data', d => { logs += d; });

let cookie = '';
async function api(p, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + '/api' + p, { method, headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${json.error}`);
  return json;
}
const ingest = (ev) => api('/ingest', { method: 'POST', body: ev, headers: { 'X-Ingest-Secret': INGEST } });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, { timeout = 5000, every = 100 } = {}) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error('timeout'); await sleep(every); } }
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name, '\n    ', e.message); process.exitCode = 1; } };

try {
  await waitFor(async () => { try { return (await fetch(BASE + '/health')).ok; } catch { return false; } }, { timeout: 10000 });
  await api('/setup', { method: 'POST', body: { name: 'Hemant', email: 'admin@test.local', password: 'password123' } });
  await api('/settings', { method: 'PUT', body: { reply_mode: 'live' } }); // reactive replies default to TEST

  await test('sheet import works through the n8n bridge', async () => {
    const t = await api('/sheet/test', { method: 'POST' }); assert.equal(t.result.name, 'fake bridge');
    const r = await api('/sheet/import', { method: 'POST' }); assert.equal(r.result.created, 5);
    const { rows } = await api('/leads?limit=50'); assert.equal(rows.find(l => l.full_name === 'Arjun Reddy').sheet_row, 4);
  });
  await test('ingest rejects a bad secret', async () => {
    await assert.rejects(api('/ingest', { method: 'POST', body: { type: 'ping' }, headers: { 'X-Ingest-Secret': 'nope' } }), /401/);
    const p = await ingest({ type: 'ping' }); assert.equal(p.brain, 'n8n');
  });
  let arjunId;
  await test('conversation event from n8n creates inbound + AI reply, hand-off → PROSPECT + human mode', async () => {
    const r = await ingest({ type: 'conversation', to: '+919000000001', fullName: 'Arjun Reddy', inboundText: 'Is a 3 BHK in Kokapet available around 2 Cr?', messageId: 'wamid.IN1', msgType: 'text', reply: 'Great choice — a consultant will connect with you shortly.', waMessageId: 'wamid.OUT1', sender: 'ai', intent: 'location', handoff: true, handoffReason: 'asked availability', newStatus: 'PROSPECT', corridor: 'Kokapet', budget: '2 Cr', sentiment: 'positive', language: 'en', rowNumber: 4, sheetFound: true });
    arjunId = r.lead_id;
    const d = await api('/leads/' + arjunId);
    assert.equal(d.messages.length, 2); assert.equal(d.messages[1].sender, 'ai'); assert.equal(d.messages[1].meta.handoff, true);
    assert.equal(d.lead.status, 'PROSPECT'); assert.equal(d.lead.mode, 'human'); assert.equal(d.lead.corridor, 'Kokapet'); assert.equal(d.lead.unread_count, 1);
    const again = await ingest({ type: 'conversation', to: '+919000000001', inboundText: 'dup', messageId: 'wamid.IN1', reply: '', sender: 'none', newStatus: 'PROSPECT' });
    assert.equal((await api('/leads/' + arjunId)).messages.length, 2); // duplicate inbound ignored, no reply added
  });
  await test('LeadDesk did not mirror n8n events to the sheet (n8n already did)', async () => {
    assert.equal(bridgeCalls.filter(c => c.op === 'updateRow').length, 0);
  });
  await test('human reply goes out via WhatsApp; take-over/hand-back write statuses n8n obeys', async () => {
    const m = await api(`/leads/${arjunId}/messages`, { method: 'POST', body: { text: 'Hi Arjun, Hemant here — when can you visit?' } }); assert.equal(m.message.status, 'sent');
    await api(`/leads/${arjunId}/takeover`, { method: 'POST' });
    assert.equal((await api('/leads/' + arjunId)).lead.status, 'IN_SALES');
    await api('/sheet/flush', { method: 'POST' });
    const upd = bridgeCalls.filter(c => c.op === 'updateRow'); assert.ok(upd.length >= 1); assert.equal(upd.at(-1).values.lead_status, 'IN_SALES'); assert.equal(upd.at(-1).rowNumber, 4);
    await api(`/leads/${arjunId}/handback`, { method: 'POST' });
    assert.equal((await api('/leads/' + arjunId)).lead.status, 'REPLIED');
    await api('/sheet/flush', { method: 'POST' });
    assert.equal(bridgeCalls.filter(c => c.op === 'updateRow').at(-1).values.lead_status, 'REPLIED');
  });
  await test('journey events record template sends and advance the stage', async () => {
    const r = await ingest({ type: 'journey', items: [{ whatsapp_number: '+919000000002', full_name: 'Asha Rao', first_name: 'Asha', step: 0, day: 0, template: 'neopolis_journey_d0_intro', wa_message_id: 'wamid.J1', status: 'sent', newStatus: 'CONTACTED', row_number: 2 }, { whatsapp_number: '+919000000005', full_name: 'Sameer Khan', step: 0, day: 0, template: 'neopolis_journey_d0_intro', wa_message_id: '', status: 'failed: invalid number', newStatus: 'CONTACTED', row_number: 6 }] });
    assert.equal(r.leads.length, 2);
    const p = await api('/leads/' + r.leads[0]); assert.equal(p.lead.status, 'CONTACTED'); assert.equal(p.lead.followup_stage, 1); assert.equal(p.messages[0].type, 'template'); assert.ok(p.messages[0].body.startsWith('Hello Asha'));
    const s = await api('/leads/' + r.leads[1]); assert.equal(s.lead.status, 'CREATED'); assert.equal(s.messages[0].status, 'failed');
  });
  await test('status event + delivery event + LeadDesk journey is off in n8n mode', async () => {
    await ingest({ type: 'status', whatsapp_number: '+919000000002', newStatus: 'NO_RESPONSE', reason: 'test' });
    assert.equal((await api('/leads?q=Asha')).rows[0].status, 'NO_RESPONSE');
    const d = await ingest({ type: 'delivery', wa_message_id: 'wamid.J1', status: 'read' }); assert.equal(d.updated, true);
    const f = await api('/followups/run', { method: 'POST' }); assert.equal(f.result.skipped, 'journey runs in n8n');
    const b = await api('/bootstrap'); assert.equal(b.brain, 'n8n');
  });
  console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
} catch (e) { console.error('FATAL', e); process.exitCode = 1; }
finally { server.kill(); bridge.close(); if (process.exitCode) console.log(logs.slice(-3000)); fs.rmSync(dataDir, { recursive: true, force: true }); }
