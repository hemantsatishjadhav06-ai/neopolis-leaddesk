// Unit tests: the delivery-confirmed journey state, the .xlsx reader and the multi-tab sheet import.
// Run: node tests/unit.mjs (part of npm test). No network: the Google export is stubbed with a generated workbook.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leaddesk-unit-'));
process.env.WA_MOCK = '1';
// Pasted the way it sometimes is into a dashboard: quoted, with "Bearer " in front (see config.cleanKey).
process.env.OPENROUTER_API_KEY = ' "Bearer sk-or-v1-0123456789abcdef0123" ';
const { computeJourneyState, stepOf, DELIVERY } = await import('../src/services/journey.js');
const { readXlsx } = await import('../src/util/xlsx.js');
const { pickLeadTables, importFromSheet } = await import('../src/services/sync.js');
const { setSheetConnection } = await import('../src/services/sheets/active.js');
const { resetSheetProvider } = await import('../src/services/sheets/index.js');
const { all } = await import('../src/db.js');

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name, '\n    ', e.message); process.exitCode = 1; } };

// ---------------- journey state ----------------
const H = 36e5;
const NOW = Date.parse('2026-10-25T06:00:00Z');
const journey = [0, 2, 4, 7, 10, 13].map((day, i) => ({ key: `d${day}`, day, template: `neopolis_v3_d${day}_step${i}`, text: '', buttons: [] }));
let id = 0;
const msg = (day, status, hoursAgo, { error = null, wa = true, template = `neopolis_v3_d${day}_step${journey.findIndex(s => s.day === day)}`, meta = '{}' } = {}) =>
  ({ id: ++id, template_name: template, status, error, wa_message_id: wa ? `wamid.${id}` : null, meta, created_at: new Date(NOW - hoursAgo * H).toISOString() });
const state = (msgs, stage = 0) => computeJourneyState({ msgs, journey, stage, now: NOW });

await test('no journey messages on record → legacy: trust the stored stage', async () => {
  const s = state([], 3); assert.equal(s.legacy, true); assert.equal(s.next, 3);
});
await test('Day 0 delivered 49h ago → Day 2 is due', async () => {
  const s = state([msg(0, 'delivered', 49)]); assert.equal(s.next, 1); assert.equal(s.waiting, null); assert.ok(s.readyAt <= NOW);
});
await test('Day 0 delivered 10h ago → Day 2 waits for the 2-day gap', async () => {
  const s = state([msg(0, 'read', 10)]); assert.equal(s.next, 1); assert.equal(s.waiting, 'gap'); assert.equal(s.readyAt, NOW - 10 * H + 48 * H);
});
await test('Day 0 accepted but no receipt yet → nothing else goes out (no Day 2 without context)', async () => {
  const s = state([msg(0, 'sent', 60)]); assert.equal(s.next, 0); assert.equal(s.waiting, 'delivery'); assert.equal(s.readyAt, Infinity);
});
await test('Day 0 failed (#131049) 2h ago → Day 0 again, after 24h', async () => {
  const s = state([msg(0, 'failed', 2, { error: '#131049 This message was not delivered' })]);
  assert.equal(s.next, 0); assert.equal(s.waiting, 'retry'); assert.equal(s.attempts, 1); assert.equal(s.readyAt, NOW - 2 * H + 24 * H); assert.match(s.lastError, /#131049/);
});
await test('Day 0 failed 25h ago → re-send is due now', async () => {
  const s = state([msg(0, 'failed', 25, { error: '#131049 x' })]); assert.equal(s.next, 0); assert.equal(s.waiting, null); assert.ok(s.readyAt <= NOW);
});
await test('second failure doubles the wait (48h)', async () => {
  const s = state([msg(0, 'failed', 100, { error: '#131049 x' }), msg(0, 'failed', 30, { error: '#131049 x' })]);
  assert.equal(s.attempts, 2); assert.equal(s.waiting, 'retry'); assert.equal(s.readyAt, NOW - 30 * H + 48 * H);
});
await test('a step missed under the old behaviour is not back-filled: continue after the last delivered step', async () => {
  const s = state([msg(0, 'delivered', 200), msg(2, 'failed', 150, { error: '#131049 x' }), msg(4, 'delivered', 100)], 3);
  assert.equal(s.next, 3); assert.equal(s.attempts, 0); assert.ok(s.readyAt <= NOW); // Day 7, 3 days after Day 4 arrived
});
await test('nothing delivered yet → Day 0 again, however far the old code got', async () => {
  const s = state([msg(0, 'failed', 120, { error: '#131049 x' }), msg(2, 'failed', 70, { error: '#131049 x' })], 2);
  assert.equal(s.next, 0); assert.equal(s.attempts, 1); assert.ok(s.readyAt <= NOW);
});
await test('a re-sent step that lands restarts the spacing for the next one', async () => {
  const s = state([msg(0, 'failed', 120, { error: '#131049 x' }), msg(0, 'delivered', 1)]);
  assert.equal(s.next, 1); assert.equal(s.waiting, 'gap'); assert.equal(s.readyAt, NOW - 1 * H + 48 * H);
});
await test('no receipt for over a week → treated as not delivered and re-sent', async () => {
  const s = state([msg(0, 'sent', 8 * 24)]); assert.equal(s.next, 0); assert.equal(s.attempts, 1); assert.ok(s.readyAt <= NOW); assert.match(s.lastError, /No delivery receipt/);
});
await test('#131026 (not on WhatsApp) → stop, no retries', async () => {
  const s = state([msg(0, 'failed', 30, { error: '#131026 Message undeliverable' })]); assert.equal(s.stop, 'permanent'); assert.match(s.lastError, /#131026/);
});
await test(`${DELIVERY.maxAttempts} undelivered tries → give up on the lead`, async () => {
  const msgs = Array.from({ length: DELIVERY.maxAttempts }, (_, i) => msg(0, 'failed', 400 - i * 50, { error: '#131049 x' }));
  const s = state(msgs); assert.equal(s.stop, 'gave_up'); assert.equal(s.attempts, DELIVERY.maxAttempts);
});
await test('renamed templates keep the lead\'s place (day read from the old name)', async () => {
  const old = msg(0, 'delivered', 72, { template: 'neopolis_journey_d0_intro' });
  assert.equal(stepOf(old, journey), 0);
  const s = state([old, msg(2, 'delivered', 24, { template: 'neopolis_journey_d2_value' })]); assert.equal(s.next, 2);
});
await test('the day recorded at send time wins over the template name', async () => {
  assert.equal(stepOf(msg(0, 'sent', 1, { template: 'custom_name', meta: JSON.stringify({ journey_day: 7 }) }), journey), 3);
});
await test('a send that failed before reaching Meta (no message id) is not a delivery attempt', async () => {
  const s = state([msg(0, 'failed', 1, { wa: false, error: 'network' })]); assert.equal(s.next, 0); assert.equal(s.attempts, 0); assert.ok(s.readyAt <= NOW);
});
await test('every step delivered → journey done', async () => {
  const s = state(journey.map((st, i) => msg(st.day, 'delivered', 400 - i * 48))); assert.equal(s.next, journey.length);
});

await test('due order: first sends before re-sends, newest lead first', async () => {
  const { dueFollowups } = await import('../src/services/scheduler.js');
  const { createLead, addMessage } = await import('../src/services/leads.js');
  const { run } = await import('../src/db.js');
  const { getJourney } = await import('../src/settings.js');
  const j = getJourney();
  const old = createLead({ wa_number: '+919000000601', full_name: 'Old Retry' });
  const m = addMessage(old.id, { direction: 'out', sender: 'system', type: 'template', template_name: j[0].template, wa_message_id: 'wamid.R1', status: 'failed', error: '#131049 x' });
  run('UPDATE messages SET created_at = ? WHERE id = ?', new Date(Date.now() - 30 * H).toISOString(), m.id);
  const older = createLead({ wa_number: '+919000000602', full_name: 'First Send A' });
  const newest = createLead({ wa_number: '+919000000603', full_name: 'First Send B' });
  try {
    const ids = dueFollowups().due.map(d => d.lead.id).filter(id => [old.id, older.id, newest.id].includes(id));
    assert.deepEqual(ids, [newest.id, older.id, old.id]);
  } finally { run('DELETE FROM leads WHERE id IN (?, ?, ?)', old.id, older.id, newest.id); }
});

// ---------------- xlsx + multi-tab import ----------------
// A tiny .xlsx writer, just enough to build test workbooks (stored as Google's export stores them).
function buildXlsx(sheets) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const col = (i) => { let s = ''; i++; while (i) { s = String.fromCharCode(65 + ((i - 1) % 26)) + s; i = Math.floor((i - 1) / 26); } return s; };
  const strings = [];
  const si = (v) => { let i = strings.indexOf(v); if (i < 0) { strings.push(v); i = strings.length - 1; } return i; };
  const files = {
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  };
  sheets.forEach((s, i) => {
    const rows = s.rows.map((r, ri) => r ? `<row r="${ri + 1}">${r.map((v, ci) => v === '' ? '' : typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : ci % 2 ? `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${si(v)}</v></c>`).join('')}</row>` : '').join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;
  const parts = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = zlib.deflateRawSync(raw), nameBuf = Buffer.from(name), crc = zlib.crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data); central.push(cen, nameBuf); offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// Shaped like the real sheet: a stray first tab, two lead-form tabs, a notes tab and the replies log.
const workbook = buildXlsx([
  { name: 'Sheet4', rows: [null, ['someone@example.com', 'Not a lead', 12345]] },
  { name: '02-08-2026', rows: [
    ['#ERROR!', 'created_time', 'full_name', ' ', 'whatsapp_number', 'lead_status', 'feedback'],
    ['l:1', '2026-08-06T19:31:58+05:30', 'Asha Rao', 'p:+919000000101', '+919000000101', 'FOLLOWUP_3', ''],
    ['l:2', '2026-08-07T10:00:00+05:30', 'Ravi & Co', 'p:+919000000102', '+919000000102', '', 'not insterested'],
    ['l:3', '2026-08-07T11:00:00+05:30', 'No Number', '', '', '', ''],
  ] },
  { name: 'Sheet6', rows: [
    ['id', 'created_time', 'full_name', 'phone_number', 'Column 17', 'lead_status'],
    ['l:4', '2026-10-11T09:00:00+05:30', 'Meera Iyer', 'p:+919000000103', 'dnp', ''],
    ['l:5', '2026-10-11T10:00:00+05:30', 'Asha again', 919000000101, '', ''], // same person as on 02-08-2026, number stored as a number
  ] },
  { name: 'visits list', rows: [['NAME', 'NUMBER', 'VISIT', 'FEEDBACK'], ['Visitor', 'p:+919000000199', 'infina 2', '']] },
  { name: 'Client Replies', rows: [['timestamp', 'whatsapp_number', 'full_name', 'message', 'ai_reply', 'lead_status'], ['2026-09-04', '919000000198', 'Someone', 'Hi', 'Hello', 'PROSPECT']] },
]);

await test('xlsx reader: every tab, in order, with shared and inline strings, numbers and entities', async () => {
  const sheets = readXlsx(workbook);
  assert.deepEqual(sheets.map(s => s.name), ['Sheet4', '02-08-2026', 'Sheet6', 'visits list', 'Client Replies']);
  assert.equal(sheets[0].rows[0].rowNumber, 2); // a blank first row stays blank
  const leads = sheets[1].rows;
  assert.equal(leads[2].values[2], 'Ravi & Co');
  assert.equal(sheets[2].rows[2].values[3], '919000000101');
});
await test('picks only the lead-form tabs (not the notes tab, the replies log or stray sheets)', async () => {
  const tables = readXlsx(workbook).map(s => ({ tab: s.name, headers: s.rows.find(r => r.rowNumber === 1)?.values || [], rows: [] }));
  assert.deepEqual(pickLeadTables(tables).map(t => t.tab), ['02-08-2026', 'Sheet6']);
  assert.deepEqual(pickLeadTables(tables, { configured: ['Sheet6'] }).map(t => t.tab), ['Sheet6']);
  // A NAME / NUMBER notes tab is never picked on its own while lead-form tabs exist (above), only when named.
  assert.deepEqual(pickLeadTables(tables, { configured: ['visits list'] }).map(t => t.tab), ['visits list']);
  assert.throws(() => pickLeadTables(tables, { configured: ['Sheet4'] }), /no whatsapp_number \/ phone_number column/);
  assert.throws(() => pickLeadTables(tables, { configured: ['Nope'] }), /not found/);
});
await test('import through a shared link reads every leads tab; a link\'s #gid no longer picks the tab', async () => {
  globalThis.fetch = async (url) => (String(url).includes('format=xlsx') ? new Response(workbook) : new Response('not found', { status: 404 }));
  setSheetConnection({ provider: 'publiclink', spreadsheetId: 'TEST', gid: '777', leadsTab: '', repliesTab: 'Client Replies' });
  resetSheetProvider();
  const r = await importFromSheet({ force: true });
  assert.equal(r.tab, '02-08-2026, Sheet6');
  assert.equal(r.created, 3); assert.equal(r.duplicates, 1); assert.equal(r.invalid, 1); assert.equal(r.paused, 1);
  const leads = all('SELECT wa_number, status, outreach_paused, sheet_tab FROM leads ORDER BY wa_number');
  assert.deepEqual(leads.map(l => [l.wa_number, l.status, l.outreach_paused, l.sheet_tab]), [
    ['+919000000101', 'FOLLOWUP_3', 0, '02-08-2026'],
    ['+919000000102', 'CREATED', 1, '02-08-2026'], // "not insterested" in the sheet → never messaged
    ['+919000000103', 'CREATED', 0, 'Sheet6'],
  ]);
  const again = await importFromSheet({ force: true });
  assert.equal(again.created, 0); assert.equal(again.updated, 0); // the same row wins every time
});
await test('a configured tab list is respected, and leads tabs it leaves out are reported', async () => {
  setSheetConnection({ provider: 'publiclink', spreadsheetId: 'TEST', gid: '', leadsTab: '02-08-2026', repliesTab: 'Client Replies' });
  resetSheetProvider();
  const r = await importFromSheet({ force: true });
  assert.equal(r.tab, '02-08-2026');
  assert.deepEqual(r.missedTabs, [{ tab: 'Sheet6', rows: 2 }]);
});

// ---------------- a second firm with a bulk-message sheet ----------------
const { seedFirmsFromEnv } = await import('../src/services/firm-setup.js');
const { getFirmBySlug } = await import('../src/firms.js');
const { getSetting, getJourney } = await import('../src/settings.js');
const { sheetConnectionPublic } = await import('../src/services/sheets/active.js');
// Shaped like the MoreSpace sheet: one tab, "Name" and "Number", typed by hand.
const contacts = buildXlsx([{ name: 'Sheet1', rows: [['Name', 'Number'], ['Kiran Shah', 7075100001], ['Asha Rao', '+91 90000 00101'], ['', '07075100003'], ['Typo', '12345']] }]);

await test('FIRMS seeds a firm once, with its number and its sheet; a re-run changes nothing', async () => {
  const seed = JSON.stringify([{ name: 'MoreSpace', number: '7075168306', sheet: 'https://docs.google.com/spreadsheets/d/1rAsfjBqTsV0O4NdI126vQkAvhYtUUB-83jyTnEBBzz4/edit?usp=sharing' }]);
  const [firm] = seedFirmsFromEnv(seed);
  assert.equal(firm.slug, 'morespace'); assert.equal(firm.display_number, '+917075168306'); assert.equal(firm.phone_number_id, '');
  const cx = sheetConnectionPublic(firm.id);
  assert.equal(cx.provider, 'publiclink'); assert.equal(cx.spreadsheetId, '1rAsfjBqTsV0O4NdI126vQkAvhYtUUB-83jyTnEBBzz4');
  assert.equal(seedFirmsFromEnv(seed)[0].id, firm.id);
  assert.equal(all('SELECT COUNT(*) AS n FROM firms')[0].n, 2);
});
await test('a Name / Number sheet imports into its own firm; the same person can be a lead of both firms', async () => {
  const firm = getFirmBySlug('morespace');
  globalThis.fetch = async (url) => (String(url).includes('1rAsfjBqTsV0O4NdI126vQkAvhYtUUB-83jyTnEBBzz4') && String(url).includes('format=xlsx') ? new Response(contacts) : new Response(workbook));
  const r = await importFromSheet({ force: true, firmId: firm.id });
  assert.equal(r.tab, 'Sheet1'); assert.equal(r.created, 3); assert.equal(r.invalid, 1);
  const rows = all('SELECT firm_id, wa_number, full_name, first_name FROM leads WHERE firm_id = ? ORDER BY wa_number', firm.id);
  assert.deepEqual(rows.map(l => [l.wa_number, l.full_name]), [['+917075100001', 'Kiran Shah'], ['+917075100003', ''], ['+919000000101', 'Asha Rao']]);
  assert.equal(all("SELECT COUNT(*) AS n FROM leads WHERE wa_number = '+919000000101'")[0].n, 2); // firm 1's Asha is untouched
  assert.equal((await importFromSheet({ force: true, firmId: firm.id })).created, 0);
  assert.equal((await importFromSheet({ force: true })).created, 0); // firm 1's import does not see firm 2's leads
});
await test("a new firm never inherits firm 1's send mode, test numbers or messages", async () => {
  const firm = getFirmBySlug('morespace');
  const { setSettings } = await import('../src/settings.js');
  setSettings({ send_mode: 'live', reply_mode: 'live', test_recipients: '+919000000001', journey_daily_cap: 25 });
  assert.equal(getSetting('send_mode', firm.id), 'off'); assert.equal(getSetting('reply_mode', firm.id), 'test');
  assert.equal(getSetting('test_recipients', firm.id), '');
  assert.equal(getSetting('journey_daily_cap', firm.id), 25); // pacing is shared until the firm sets its own
  assert.equal(getSetting('company_name', firm.id), 'MoreSpace');
  assert.ok(getJourney(firm.id).every(s => s.template.startsWith('morespace_')));
  setSettings({ journey_steps: '[]' }, firm.id);
  assert.deepEqual(getJourney(firm.id), []); // an emptied journey stays empty — it does not fall back to firm 1's
  assert.ok(getJourney().length > 0);
});

// ---------------- AI key check ----------------
const { aiKeyHealth } = await import('../src/services/ai.js');
const { config } = await import('../src/config.js');
await test('the AI key is cleaned of quotes and "Bearer ", and checked with the provider without exposing it', async () => {
  assert.equal(config.ai.apiKey, 'sk-or-v1-0123456789abcdef0123'); assert.equal(config.ai.apiKeyCleaned, true);
  const seen = [];
  globalThis.fetch = async (url, opts) => { seen.push([String(url), opts.headers.Authorization]); return new Response(JSON.stringify({ error: { message: 'User not found.', code: 401 } }), { status: 401 }); };
  const r = await aiKeyHealth();
  assert.equal(r.ok, false); assert.equal(r.status, 401); assert.equal(r.detail, 'User not found.'); assert.match(r.hint, /openrouter\.ai\/keys/);
  assert.equal(r.key, 'sk-or-v1-012…0123'); assert.ok(!JSON.stringify(r).includes('0123456789abcdef0123')); assert.ok(r.cleaned);
  assert.deepEqual(seen, [['https://openrouter.ai/api/v1/key', 'Bearer sk-or-v1-0123456789abcdef0123']]);
});
await test('a working key reports its credit; an account with no credit is not usable', async () => {
  let credits = 4.5;
  globalThis.fetch = async (url) => String(url).endsWith('/key')
    ? new Response(JSON.stringify({ data: { label: 'sk-or-v1-012...123', limit: null, limit_remaining: null, usage: 1.25, is_free_tier: false } }))
    : new Response(JSON.stringify({ data: { total_credits: 5.75, total_usage: 5.75 - credits } }));
  let r = await aiKeyHealth();
  assert.equal(r.ok, true); assert.equal(r.balance, 4.5); assert.equal(r.usage, 1.25);
  credits = 0;
  r = await aiKeyHealth();
  assert.equal(r.ok, false); assert.match(r.detail, /no credit/); assert.match(r.hint, /openrouter\.ai\/credits/);
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  assert.equal((await aiKeyHealth()).ok, null); // unreachable is "unknown", not "rejected"
});

console.log(`\n${passed} unit tests passed${process.exitCode ? ' (with failures)' : ''}`);
