// Google Sheet ⇄ LeadDesk sync: import new leads from the sheet; push status/replies back (queued).
import { all, get, run, nowIso, kvGet, kvSet } from '../db.js';
import { getSetting } from '../settings.js';
import { normalizePhone, normHeader, prettyAnswer, firstName } from '../util/normalize.js';
import { getSheetProvider } from './sheets/index.js';
import { activeSheetConfig, configuredLeadTabs } from './sheets/active.js';
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

const PHONE_HEADERS = ['whatsapp_number', 'phone_number', 'phone', 'mobile'];
const hasPhoneColumn = (headers) => headers.map(normHeader).some(h => PHONE_HEADERS.includes(h));

// A tab that looks like a lead-form export: a phone column, a name, and created_time or lead_status.
// That leaves out notes tabs (a "visits list" with NAME / NUMBER), the replies log and stray sheets.
export function isLeadTable(t, repliesTab = 'Client Replies') {
  if (!t || normHeader(t.tab) === normHeader(repliesTab)) return false;
  const h = (t.headers || []).map(normHeader);
  if (h.includes('ai_reply')) return false;
  return hasPhoneColumn(t.headers || []) && (h.includes('full_name') || h.includes('name')) && (h.includes('created_time') || h.includes('lead_status'));
}

// Which of the tables read from the sheet to import: the configured tab(s) as given (each must have a phone
// column), otherwise every tab that looks like a leads tab.
export function pickLeadTables(tables, { configured = [], repliesTab = 'Client Replies' } = {}) {
  if (configured.length) {
    const byName = new Map(tables.map(t => [String(t.tab), t]));
    return configured.map(name => {
      const t = byName.get(name) || (tables.length === 1 ? tables[0] : null);
      if (!t) throw new Error(`Tab "${name}" was not found in the sheet.`);
      if (!hasPhoneColumn(t.headers || [])) throw new Error(`Tab "${t.tab}" has no whatsapp_number / phone_number column (columns: ${(t.headers || []).filter(Boolean).slice(0, 8).join(', ') || 'none'}). Set the leads tab under Settings → Google Sheet.`);
      return t;
    });
  }
  const leads = tables.filter(t => isLeadTable(t, repliesTab));
  if (!leads.length) {
    if (tables.length === 1 && hasPhoneColumn(tables[0].headers || [])) return tables; // single-table connectors
    throw new Error(`No leads tab found. Checked ${tables.map(t => `"${t.tab}"`).join(', ') || 'no tabs'}; a leads tab needs a whatsapp_number or phone_number column and full_name.`);
  }
  return leads;
}

// Notes the sales team leaves in the sheet ("not interested", "DND") — a new lead with one is imported paused,
// so the journey never messages someone who already said no on a call.
const DECLINED_NOTE = /not\s*(?:in?t+e?r?e?s?t?e?d|insterested|insted|intrested|intersted)|\bdnd\b|do\s*not\s*(?:call|disturb|message|contact)/i;

export async function importFromSheet({ userId = null, force = false } = {}) {
  const provider = getSheetProvider();
  if (!provider) return { skipped: true, reason: 'No sheet provider configured' };
  if (!force && !getSetting('sheet_import_enabled')) return { skipped: true, reason: 'Import disabled in settings' };
  const started = Date.now();
  const tables = provider.readTables ? await provider.readTables() : [await provider.readLeads()];
  const picked = pickLeadTables(tables, { configured: configuredLeadTabs(), repliesTab: activeSheetConfig().repliesTab });
  let created = 0, updated = 0, invalid = 0, seen = 0, duplicates = 0, paused = 0;
  const invalidRows = [];
  const tabs = [];
  const numbers = new Set(); // a number in several rows/tabs counts once: the first one wins
  for (const data of picked) {
    let tabRows = 0, tabCreated = 0;
    for (const r of data.rows) {
      seen++; tabRows++;
      const m = mapRow(data.headers, r.values);
      const wa = normalizePhone(m.wa_number);
      if (!wa) { invalid++; if (invalidRows.length < 20) invalidRows.push({ tab: data.tab, row: r.rowNumber, value: m.wa_number, name: m.full_name }); continue; }
      if (numbers.has(wa)) { duplicates++; continue; }
      numbers.add(wa);
      const existing = getLeadByNumber(wa);
      if (!existing) {
        const st = STATUSES.includes(String(m.lead_status).toUpperCase()) ? String(m.lead_status).toUpperCase() : 'CREATED';
        const lead = createLead({ wa_number: wa, full_name: m.full_name, email: m.email, source: 'sheet', sheet_row: r.rowNumber, sheet_tab: data.tab, status: st, fields: m.fields, raw_fields: m.raw });
        const note = r.values.find(v => DECLINED_NOTE.test(String(v)));
        if (note) {
          updateLead(lead.id, { outreach_paused: 1 }, { silent: true });
          audit('lead.paused', { leadId: lead.id, data: { reason: 'sheet note', note: String(note).slice(0, 80) } });
          paused++;
        }
        created++; tabCreated++;
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
    tabs.push({ tab: data.tab, rows: tabRows, created: tabCreated });
  }
  const tabNames = tabs.map(t => t.tab).join(', ');
  const result = { ok: true, tab: tabNames, tabs, rows: seen, created, updated, invalid, duplicates, paused, invalidRows, ms: Date.now() - started, at: nowIso() };
  kvSet('sheet.lastImport', result);
  audit('sheet.import', { userId, data: { created, updated, invalid, rows: seen, tabs: tabNames } });
  if (created || updated) broadcast('lead', { reason: 'import' });
  log.info(`Sheet import (${tabNames}): ${seen} rows, +${created} new${paused ? ` (${paused} paused: sheet says not interested)` : ''}, ${updated} updated, ${invalid} invalid${duplicates ? `, ${duplicates} duplicate` : ''}`);
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
