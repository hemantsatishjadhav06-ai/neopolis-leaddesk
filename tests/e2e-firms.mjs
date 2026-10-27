// End-to-end test of a second firm (mocks): a firm declared in FIRMS, its own sheet, its own WhatsApp number
// (registered through the wizard), its own settings — and nothing of it leaking into firm 1 or the other way.
// Run: npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const APP_SECRET = 'test-app-secret-firms';
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaddesk-firms-'));
const FIRMS = JSON.stringify([{ name: 'MoreSpace', number: '7075168306' }]);
let logs = '';
let server;
function start() {
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: { ...process.env, PORT, DATA_DIR: dataDir, WA_MOCK: '1', AI_MOCK: '1', SHEETS_PROVIDER: 'memory', SCHEDULER_ENABLED: '0', PUBLIC_URL: BASE, NODE_ENV: 'test', META_APP_SECRET: APP_SECRET, BACKUP_ENABLED: '0', FIRMS },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => { logs += d; });
  server.stderr.on('data', d => { logs += d; });
  return waitFor(async () => { try { return (await fetch(BASE + '/health')).ok; } catch { return false; } }, { timeout: 10000 });
}

let cookie = '';
async function api(p, { method = 'GET', body, firm } = {}) {
  const headers = { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json', Cookie: cookie };
  if (firm) headers['X-Firm-Id'] = String(firm);
  const res = await fetch(BASE + '/api' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${json.error}`);
  return json;
}
async function waPost(body) {
  const raw = JSON.stringify(body);
  return fetch(BASE + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex') }, body: raw });
}
const inbound = (metadata, from, text, name = '') => waPost({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata, contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id: 'wamid.T.' + crypto.randomBytes(6).toString('hex'), timestamp: '1', type: 'text', text: { body: text } }] } }] }] });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, { timeout = 5000, every = 100 } = {}) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error('timeout waiting'); await sleep(every); } }

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name, '\n    ', e.message); process.exitCode = 1; } };

try {
  await start();
  let ms; // the MoreSpace firm
  const leadOf = async (firm, number) => (await api('/leads?limit=100', { firm })).rows.find(l => l.wa_number === number);

  await test('FIRMS adds MoreSpace next to the main firm, with its number and no sender yet', async () => {
    await api('/setup', { method: 'POST', body: { name: 'Hemant', email: 'admin@test.local', password: 'password123' } });
    const b = await api('/bootstrap');
    assert.deepEqual(b.firms.map(f => f.name), ['Neopolis Infra', 'MoreSpace']);
    ms = b.firms[1];
    assert.equal(ms.display_number, '+917075168306'); assert.equal(ms.phone_source, 'none'); assert.equal(ms.phone_number_id, '');
  });

  await test('each firm imports its own sheet; the same person is a separate lead in each', async () => {
    assert.equal((await api('/sheet/import', { method: 'POST' })).result.created, 5);
    const r = await api('/sheet/connect', { method: 'POST', firm: ms.id, body: { method: 'memory' } });
    assert.equal(r.import.created, 3); assert.equal(r.import.invalid, 1); assert.equal(r.import.tab, 'Sheet1');
    const one = await api('/leads?limit=100'), two = await api('/leads?limit=100', { firm: ms.id });
    assert.equal(one.total, 5); assert.equal(two.total, 3);
    assert.deepEqual(two.rows.map(l => l.full_name).sort(), ['Asha Rao', 'Divya Nair', 'Kiran Shah']);
    const a1 = one.rows.find(l => l.wa_number === '+919000000002'), a2 = two.rows.find(l => l.wa_number === '+919000000002');
    assert.ok(a1 && a2 && a1.id !== a2.id); assert.equal(a2.firm_id, ms.id);
  });

  await test("settings are per firm: MoreSpace starts OFF with its own journey, firm 1's are untouched", async () => {
    const s2 = await api('/settings', { firm: ms.id });
    assert.equal(s2.settings.send_mode, 'off'); assert.equal(s2.settings.company_name, 'MoreSpace');
    assert.ok(JSON.parse(s2.settings.journey_steps).every(st => st.template.startsWith('morespace_')));
    assert.equal(s2.firm.name, 'MoreSpace');
    await api('/settings', { method: 'PUT', firm: ms.id, body: { send_mode: 'test', reply_mode: 'live', test_recipients: '+919000000101', send_window_start: 0, send_window_end: 24 } });
    const s1 = await api('/settings');
    assert.equal(s1.settings.send_mode, 'off'); assert.equal(s1.settings.reply_mode, 'test'); assert.equal(s1.settings.test_recipients, '');
    assert.equal((await api('/followups/run', { method: 'POST' })).result.skipped, 'send_mode off'); // firm 1 still holds everything
  });

  await test('with no number registered, MoreSpace sends nothing — and never from the main number', async () => {
    assert.match((await api('/followups/run', { method: 'POST', firm: ms.id })).result.skipped, /no WhatsApp number/);
    await assert.rejects(api('/wa/send-test', { method: 'POST', firm: ms.id, body: { to: '+919000000101', text: 'hello' } }), /no WhatsApp number connected/);
    const kiran = await leadOf(ms.id, '+919000000101');
    const d = await api(`/leads/${kiran.id}`);
    assert.equal(d.messages.at(-1).status, 'blocked'); assert.equal(d.messages.at(-1).meta.blocked, 'no-sender');
  });

  let pid;
  await test('the wizard registers 7075168306 and links it to MoreSpace (not to the main firm)', async () => {
    const add = await api('/wa/add-number', { method: 'POST', firm: ms.id, body: {} }); // number + name default to the firm's
    pid = add.result.id;
    assert.ok(/^\d+$/.test(pid)); assert.equal(add.linked, true); assert.equal(add.firm.phone_number_id, pid); assert.equal(add.firm.phone_source, 'firm');
    await api('/wa/request-code', { method: 'POST', firm: ms.id, body: {} });
    await api('/wa/verify-code', { method: 'POST', firm: ms.id, body: { code: '123456' } });
    assert.equal((await api('/wa/register', { method: 'POST', firm: ms.id, body: { pin: '112233' } })).linked, false); // already linked
    const st = await api('/wa/status', { firm: ms.id });
    assert.equal(st.firm.phone_number_id, pid); assert.match(st.phone.display_phone_number, /7075168306/);
    assert.equal((await api('/firms')).firms[0].phone_source, 'none'); // main firm untouched (env PHONE_NUMBER_ID is unset in tests)
  });

  await test("MoreSpace's journey goes out from MoreSpace's number with MoreSpace's template", async () => {
    const r = (await api('/followups/run', { method: 'POST', firm: ms.id })).result;
    assert.equal(r.sent, 1, JSON.stringify(r)); // only the test number; Asha and Divya are held
    const kiran = await leadOf(ms.id, '+919000000101');
    const t = (await api(`/leads/${kiran.id}`)).messages.find(m => m.type === 'template' && m.status === 'sent');
    assert.equal(t.template_name, 'morespace_d0_intro'); assert.ok(t.body.startsWith('Hi Kiran, this is MoreSpace')); assert.equal(t.meta.from, pid);
    assert.equal((await api('/system', { firm: ms.id })).followups.lastRun.sent, 1);
    assert.equal((await api('/system')).followups.lastRun, null); // firm 1 has not run
  });

  await test("a message to MoreSpace's number lands in MoreSpace's chat and is answered from that number", async () => {
    await inbound({ phone_number_id: pid, display_phone_number: '917075168306' }, '919000000002', 'Hi, can you build us a website?', 'Asha Rao');
    const asha2 = await leadOf(ms.id, '+919000000002');
    const d = await waitFor(async () => { const d = await api(`/leads/${asha2.id}`); return d.messages.some(m => m.sender === 'ai') ? d : null; });
    assert.equal(d.messages[0].body, 'Hi, can you build us a website?');
    const ai = d.messages.find(m => m.sender === 'ai'); assert.equal(ai.status, 'sent'); assert.equal(ai.meta.from, pid);
    const asha1 = await leadOf(1, '+919000000002');
    assert.equal((await api(`/leads/${asha1.id}`)).messages.length, 0); // firm 1's Asha saw nothing
  });

  await test("a message to the main number stays with the main firm (and its reply mode)", async () => {
    await inbound({ phone_number_id: 'MOCK', display_phone_number: '910000000000' }, '919000000002', 'Is Kokapet available?', 'Asha Rao');
    const asha1 = await leadOf(1, '+919000000002');
    const d = await waitFor(async () => { const d = await api(`/leads/${asha1.id}`); return d.messages.length >= 2 ? d : null; });
    assert.equal(d.messages[0].body, 'Is Kokapet available?');
    assert.equal(d.messages[1].status, 'blocked'); // firm 1 is in reply mode TEST and Asha is not its test number
  });

  await test('a registered number not yet linked is linked to its firm by display number on first contact', async () => {
    const g = (await api('/firms', { method: 'POST', body: { name: 'Gamma Homes', display_number: '9111111111' } })).firm;
    assert.equal(g.phone_source, 'none');
    await inbound({ phone_number_id: '5550001', display_phone_number: '919111111111' }, '919000000777', 'hello', 'New Person');
    await waitFor(async () => (await api('/leads?limit=10', { firm: g.id })).total === 1);
    assert.equal((await api('/firms')).firms.find(f => f.id === g.id).phone_number_id, '5550001');
    assert.equal((await api('/leads?limit=100')).total, 5); assert.equal((await api('/leads?limit=100', { firm: ms.id })).total, 3);
  });

  await test('dashboard, review queue and CSV export are per firm', async () => {
    const s2 = await api('/stats', { firm: ms.id }), s1 = await api('/stats');
    assert.equal(s2.stats.total, 3); assert.equal(s1.stats.total, 5);
    assert.equal(s2.stats.aiToday, 1); assert.equal(s1.stats.aiToday, 1); // one AI reply each (firm 1's was held by its reply mode)
    assert.ok(s2.activity.some(a => a.type === 'sheet.import')); assert.ok(s2.activity.every(a => a.firm_id === ms.id));
    const r2 = await api('/review?filter=all', { firm: ms.id }), r1 = await api('/review?filter=all');
    assert.equal(r2.counts.all, 1); assert.match(r2.rows[0].inbound_body, /website/);
    assert.equal(r1.counts.all, 1); assert.match(r1.rows[0].inbound_body, /Kokapet/);
    const csv = await (await fetch(`${BASE}/api/export/leads.csv?firm=${ms.id}`, { headers: { Cookie: cookie } })).text();
    assert.equal(csv.trim().split('\r\n').length, 4); assert.match(csv, /Kiran Shah/); assert.doesNotMatch(csv, /Arjun Reddy/);
  });

  await test("guards: the main firm's sender stays in Railway, and one number cannot belong to two firms", async () => {
    await assert.rejects(api('/firms/1', { method: 'PATCH', body: { phone_number_id: '123456789' } }), /PHONE_NUMBER_ID/);
    await assert.rejects(api('/firms', { method: 'POST', body: { name: 'Copy', display_number: '+91 70751 68306' } }), /already MoreSpace's number/);
    await assert.rejects(api(`/firms/${ms.id}`, { method: 'PATCH', body: { phone_number_id: '5550001' } }), /already belongs to Gamma Homes/);
    const renamed = (await api(`/firms/${ms.id}`, { method: 'PATCH', body: { name: 'MoreSpace Services' } })).firm;
    assert.equal(renamed.name, 'MoreSpace Services'); assert.equal(renamed.phone_number_id, pid);
  });

  await test('restart: FIRMS does not re-create or overwrite a firm the team has edited', async () => {
    server.kill(); await new Promise(r => server.once('exit', r));
    await start();
    const firms = (await api('/firms')).firms;
    assert.deepEqual(firms.map(f => f.name), ['Neopolis Infra', 'MoreSpace Services', 'Gamma Homes']);
    assert.equal(firms[1].phone_number_id, pid);
    assert.equal((logs.match(/Firm added: MoreSpace/g) || []).length, 1);
    assert.equal((await api('/leads?limit=100', { firm: ms.id })).total, 3);
  });

  console.log(`\n${passed} firm tests passed${process.exitCode ? ' (with failures)' : ''}`);
} catch (e) {
  console.error('FATAL', e); process.exitCode = 1;
} finally {
  server.kill();
  if (process.exitCode) console.log('\n--- server log ---\n' + logs.slice(-4000));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
