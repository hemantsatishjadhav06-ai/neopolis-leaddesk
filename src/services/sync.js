// Google Sheet ⇄ LeadDesk sync: import new leads from the sheet; push status/replies back (queued).
import { all, get, run, nowIso, kvGet, kvSet } from '../db.js';
import { getSetting } from '../settings.js';
import { currentFirmId, firmKey } from '../firms.js';
import { normalizePhone, normHeader, prettyAnswer, firstName } from '../util/normalize.js';
import { getSheetProvider } from './sheets/index.js';
import { activeSheetConfig, configuredLeadTabs } from './sheets/active.js';
import { getLeadByNumber, createLead, updateLead, STATUSES, audit, firmTag } from './leads.js';
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
// Column names that hold the WhatsApp number, in order of preference: ad-form exports use whatsapp_number /
// phone_number; a hand-made bulk-message list usually just says Number or Mobile.
const PHONE_HEADERS = ['whatsapp_number', 'phone_number', 'phone', 'mobile', 'whatsapp', 'number', 'mobile_number', 'contact_number', 'whatsapp_no', 'phone_no', 'mobile_no'];
const SKIP_RAW = new RegExp(`^(id|created_time|ad_id|adset_id|campaign_id|form_id|is_organic|full_name|name|email|lead_status|last_reply|${PHONE_HEADERS.join('|')})$`);

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
    wa_number: PHONE_HEADERS.map(h => byKey[h]).find(v => String(v ?? '').trim()) || '',
    full_name: byKey.full_name || byKey.name || '',
    email: byKey.email || '',
    lead_status: byKey.lead_status || '',
    fields, raw,
  };
}

const hasPhoneColumn = (headers) => headers.map(normHeader).some(h => PHONE_HEADERS.includes(h));

// A tab that looks like a lead-form export: a phone column, a name, and created_time or lead_status.
// That leaves out notes tabs (a "visits list" with NAME / NUMBER), the replies log and stray sheets.
export function isLeadTable(t, repliesTab = 'Client Replies') {
  if (!t || normHeader(t.tab) === normHeader(repliesTab)) return false;
  const h = (t.headers || []).map(normHeader);
  if (h.includes('ai_reply')) return false;
  return hasPhoneColumn(t.headers || []) && (h.includes('full_name') || h.includes('name')) && (h.includes('created_time') || h.includes('lead_status'));
}

// A plain contact list (Name / Number, as typed for a bulk message): a phone column and a name, nothing else needed.
const isContactList = (t, repliesTab) => !!t && normHeader(t.tab) !== normHeader(repliesTab) && !(t.headers || []).map(normHeader).includes('ai_reply')
  && hasPhoneColumn(t.headers || []) && (t.headers || []).map(normHeader).some(h => h === 'name' || h === 'full_name');

// Which of the tables read from the sheet to import: the configured tab(s) as given (each must have a phone
// column), otherwise every tab that looks like a leads tab. A sheet with no ad-form tabs at all is a contact
// list (a bulk-message sheet): then every tab with a name and a number is imported.
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
    const contacts = tables.filter(t => isContactList(t, repliesTab));
    if (contacts.length) return contacts;
    if (tables.length === 1 && hasPhoneColumn(tables[0].headers || [])) return tables; // single-table connectors
    throw new Error(`No leads tab found. Checked ${tables.map(t => `"${t.tab}"`).join(', ') || 'no tabs'}; a leads tab needs a whatsapp_number, phone_number or Number column and a name.`);
  }
  return leads;
}

// Notes the sales team leaves in the sheet ("not interested", "DND") — a new lead with one is imported paused,
// so the journey never messages someone who already said no on a call.
const DECLINED_NOTE = /not\s*(?:in?t+e?r?e?s?t?e?d|insterested|insted|intrested|intersted)|\bdnd\b|do\s*not\s*(?:call|disturb|message|contact)/i;

export async function importFromSheet({ userId = null, force = false, firmId = currentFirmId() } = {}) {
  const provider = getSheetProvider(firmId);
  if (!provider) return { skipped: true, reason: 'No sheet provider configured' };
  if (!force && !getSetting('sheet_import_enabled', firmId)) return { skipped: true, reason: 'Import disabled in settings' };
  const started = Date.now();
  const tables = provider.readTables ? await provider.readTables() : [await provider.readLeads()];
  const configured = configuredLeadTabs(firmId);
  const repliesTab = activeSheetConfig(firmId).repliesTab;
  const picked = pickLeadTables(tables, { configured, repliesTab });
  // Leads tabs the configured list leaves out (e.g. a newer ad form's tab): imported only once someone adds them.
  const missedTabs = configured.length ? tables.filter(t => isLeadTable(t, repliesTab) && !configured.includes(String(t.tab))).map(t => ({ tab: t.tab, rows: t.rows.length })) : [];
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
      const existing = getLeadByNumber(wa, firmId);
      if (!existing) {
        const st = STATUSES.includes(String(m.lead_status).toUpperCase()) ? String(m.lead_status).toUpperCase() : 'CREATED';
        const lead = createLead({ firm_id: firmId, wa_number: wa, full_name: m.full_name, email: m.email, source: 'sheet', sheet_row: r.rowNumber, sheet_tab: data.tab, status: st, fields: m.fields, raw_fields: m.raw });
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
  const result = { ok: true, tab: tabNames, tabs, missedTabs, rows: seen, created, updated, invalid, duplicates, paused, invalidRows, ms: Date.now() - started, at: nowIso() };
  kvSet(firmKey('sheet.lastImport', firmId), result);
  audit('sheet.import', { userId, firmId, data: { created, updated, invalid, rows: seen, tabs: tabNames } });
  if (created || updated) broadcast('lead', { reason: 'import', firm_id: firmId });
  log.info(`Sheet import${firmTag(firmId)} (${tabNames}): ${seen} rows, +${created} new${paused ? ` (${paused} paused: sheet says not interested)` : ''}, ${updated} updated, ${invalid} invalid${duplicates ? `, ${duplicates} duplicate` : ''}`);
  if (missedTabs.length) log.warn(`Sheet import${firmTag(firmId)}: leads tab(s) not imported because Settings → Google Sheet names only "${configured.join(', ')}": ${missedTabs.map(t => `${t.tab} (${t.rows} rows)`).join(', ')}. Clear the tab name to import every leads tab, or add them.`);
  return result;
}

export async function processSheetQueue(max = 25, firmId = currentFirmId()) {
  const provider = getSheetProvider(firmId);
  if (!provider) return { processed: 0 };
  const jobs = all('SELECT * FROM sheet_queue WHERE firm_id = ? AND next_at <= ? ORDER BY id LIMIT ?', firmId, nowIso(), max);
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
      if (attempts >= 8) { run('DELETE FROM sheet_queue WHERE id = ?', j.id); log.error(`Sheet op ${j.op}${firmTag(firmId)} dropped after ${attempts} attempts: ${e.message}`); kvSet(firmKey('sheet.lastError', firmId), { at: nowIso(), error: e.message, op: j.op }); }
      else { const delayMin = Math.min(60, 2 ** attempts); run('UPDATE sheet_queue SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?', attempts, new Date(Date.now() + delayMin * 60000).toISOString(), e.message, j.id); kvSet(firmKey('sheet.lastError', firmId), { at: nowIso(), error: e.message, op: j.op }); }
    }
  }
  if (ok) kvSet(firmKey('sheet.lastWrite', firmId), nowIso());
  return { processed: ok, failed, pending: get('SELECT COUNT(*) AS n FROM sheet_queue WHERE firm_id = ?', firmId).n };
}

export function sheetStatus(firmId = currentFirmId()) {
  return {
    provider: getSheetProvider(firmId)?.name || 'none',
    lastImport: kvGet(firmKey('sheet.lastImport', firmId)),
    lastWrite: kvGet(firmKey('sheet.lastWrite', firmId)),
    lastError: kvGet(firmKey('sheet.lastError', firmId)),
    pending: get('SELECT COUNT(*) AS n FROM sheet_queue WHERE firm_id = ?', firmId).n,
  };
}
