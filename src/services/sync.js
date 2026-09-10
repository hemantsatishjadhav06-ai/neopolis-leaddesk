// Google Sheet ⇄ LeadDesk sync: import new leads from the sheet; push status/replies back (queued).
import { all, get, run, nowIso, kvGet, kvSet } from '../db.js';
import { getSetting } from '../settings.js';
import { normalizePhone, normHeader, prettyAnswer, firstName } from '../util/normalize.js';
import { getSheetProvider } from './sheets/index.js';
import { getLeadByNumber, createLead, updateLead, STATUSES, audit } from './leads.js';
import { broadcast } from './events.js';
import { log } from '../logger.js';

// Map messy ad-form headers to lead fields.
const FIELD_RULES = [
  { field: 'corridor', test: h => /corridor|location|area/.test(h) },
  { field: 'timeline', test: h => /how_soon|when|timeline/.test(h) },
  { field: 'configuration', test: h => /configuration|unit_size|bhk|size/.test(h) },
  { field: 'funding', test: h => /fund|loan|finance/.test(h) },
  { field: 'budget', test: h => /budget|down_pa|price_range|payment/.test(h) },
  { field: 'objective', test: h => /objective|purpose|reason/.test(h) },
];
const SKIP_RAW = /^(id|created_time|ad_id|adset_id|campaign_id|form_id|is_organic|whatsapp_number|phone_number|full_name|email|lead_status|last_reply)$/;

export function mapRow(headers, values) {
  const normed = headers.map(normHeader);
  const byKey = {};
  normed.forEach((h, i) => { if (h) byKey[h] = values[i] ?? ''; });
  const fields = {}; const raw = {};
  normed.forEach((h, i) => {
    if (!h) return;
    const v = values[i]; if (v === '' || v == null) return;
    const rule = FIELD_RULES.find(r => r.test(h));
    if (rule && !fields[rule.field] && !SKIP_RAW.test(h)) fields[rule.field] = prettyAnswer(v);
    if (!SKIP_RAW.test(h)) raw[headers[i].trim()] = String(v);
  });
  return {
    wa_number: byKey.whatsapp_number || byKey.phone_number || byKey.phone || byKey.mobile || '',
    full_name: byKey.full_name || byKey.name || '',
    email: byKey.email || '',
    lead_status: byKey.lead_status || '',
    fields, raw,
  };
}

export async function importFromSheet({ userId = null, force = false } = {}) {
  const provider = getSheetProvider();
  if (!provider) return { skipped: true, reason: 'No sheet provider configured' };
  if (!force && !getSetting('sheet_import_enabled')) return { skipped: true, reason: 'Import disabled in settings' };
  const started = Date.now();
  const data = await provider.readLeads();
  let created = 0, updated = 0, invalid = 0, seen = 0;
  const invalidRows = [];
  for (const r of data.rows) {
    seen++;
    const m = mapRow(data.headers, r.values);
    const wa = normalizePhone(m.wa_number);
    if (!wa) { invalid++; if (invalidRows.length < 20) invalidRows.push({ row: r.rowNumber, value: m.wa_number, name: m.full_name }); continue; }
    const existing = getLeadByNumber(wa);
    if (!existing) {
      const st = STATUSES.includes(String(m.lead_status).toUpperCase()) ? String(m.lead_status).toUpperCase() : 'CREATED';
      createLead({ wa_number: wa, full_name: m.full_name, email: m.email, source: 'sheet', sheet_row: r.rowNumber, sheet_tab: data.tab, status: st, fields: m.fields, raw_fields: m.raw });
      created++;
    } else {
      // keep row pointer fresh (rows can shift if someone sorts the sheet) and back-fill blanks
      const patch = {};
      if (existing.sheet_row !== r.rowNumber || existing.sheet_tab !== data.tab) { patch.sheet_row = r.rowNumber; patch.sheet_tab = data.tab; }
      if (!existing.full_name && m.full_name) { patch.full_name = m.full_name; patch.first_name = firstName(m.full_name); }
      if (!existing.email && m.email) patch.email = m.email;
      for (const k of ['corridor', 'budget', 'timeline', 'configuration', 'funding', 'objective']) if (!existing[k] && m.fields[k]) patch[k] = m.fields[k];
      if (existing.source === 'inbound') { patch.source = 'sheet'; patch.raw_fields = JSON.stringify(m.raw); }
      if (Object.keys(patch).length) { updateLead(existing.id, patch, { silent: true }); updated++; }
    }
  }
  const result = { ok: true, tab: data.tab, rows: seen, created, updated, invalid, invalidRows, ms: Date.now() - started, at: nowIso() };
  kvSet('sheet.lastImport', result);
  audit('sheet.import', { userId, data: { created, updated, invalid, rows: seen } });
  if (created || updated) broadcast('lead', { reason: 'import' });
  log.info(`Sheet import: ${seen} rows, +${created} new, ${updated} updated, ${invalid} invalid`);
  return result;
}

export async function processSheetQueue(max = 25) {
  const provider = getSheetProvider();
  if (!provider) return { processed: 0 };
  const jobs = all('SELECT * FROM sheet_queue WHERE next_at <= ? ORDER BY id LIMIT ?', nowIso(), max);
  let ok = 0, failed = 0;
  for (const j of jobs) {
    const payload = JSON.parse(j.payload);
    try {
      if (j.op === 'updateRow') await provider.updateRow(payload.rowNumber, payload.values, payload.tab);
      else if (j.op === 'appendReply') await provider.appendReply(payload.row);
      run('DELETE FROM sheet_queue WHERE id = ?', j.id); ok++;
    } catch (e) {
      failed++;
      const attempts = j.attempts + 1;
      if (attempts >= 8) { run('DELETE FROM sheet_queue WHERE id = ?', j.id); log.error(`Sheet op ${j.op} dropped after ${attempts} attempts: ${e.message}`); kvSet('sheet.lastError', { at: nowIso(), error: e.message, op: j.op }); }
      else { const delayMin = Math.min(60, 2 ** attempts); run('UPDATE sheet_queue SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?', attempts, new Date(Date.now() + delayMin * 60000).toISOString(), e.message, j.id); kvSet('sheet.lastError', { at: nowIso(), error: e.message, op: j.op }); }
    }
  }
  if (ok) kvSet('sheet.lastWrite', nowIso());
  return { processed: ok, failed, pending: get('SELECT COUNT(*) AS n FROM sheet_queue').n };
}

export function sheetStatus() {
  return {
    provider: getSheetProvider()?.name || 'none',
    lastImport: kvGet('sheet.lastImport'),
    lastWrite: kvGet('sheet.lastWrite'),
    lastError: kvGet('sheet.lastError'),
    pending: get('SELECT COUNT(*) AS n FROM sheet_queue').n,
  };
}
