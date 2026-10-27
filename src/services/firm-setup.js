// Adding a firm: the firm row plus, optionally, its Google Sheet. Used by Settings → Firms and, at boot, by the
// FIRMS environment variable, which lets a deployment declare its firms, e.g.
//   FIRMS=[{"name":"MoreSpace","number":"7075168306","sheet":"https://docs.google.com/spreadsheets/d/…/edit"}]
// Seeding only ever adds: a firm that exists is left as the team edited it, and its sheet is connected once
// (a sheet someone later disconnected stays disconnected).
import { config } from '../config.js';
import { kvGet, kvSet } from '../db.js';
import { createFirm, getFirmBySlug, updateFirm, slugify, firmKey, isDefaultFirm } from '../firms.js';
import { parseSheetRef, setSheetConnection } from './sheets/active.js';
import { resetSheetProvider } from './sheets/index.js';
import { audit } from './leads.js';
import { log } from '../logger.js';

// Link import: the sheet must be shared "Anyone with the link"; leads come in, nothing is written back.
export function connectFirmSheet(firmId, sheetUrl, { leadsTab = '' } = {}) {
  const ref = parseSheetRef(sheetUrl);
  if (!ref.spreadsheetId) throw Object.assign(new Error('That is not a Google Sheet link'), { status: 400 });
  setSheetConnection({ provider: 'publiclink', spreadsheetId: ref.spreadsheetId, gid: ref.gid, leadsTab: String(leadsTab || '').trim(), repliesTab: 'Client Replies' }, firmId);
  resetSheetProvider(firmId);
  kvSet(firmKey('sheet.seeded', firmId), true);
}

export function addFirm({ name, slug, number = '', phone_number_id = '', waba_id = '', sheet = '', leads_tab = '' }, { userId = null } = {}) {
  const firm = createFirm({ name, slug, display_number: number, phone_number_id, waba_id });
  if (sheet) connectFirmSheet(firm.id, sheet, { leadsTab: leads_tab });
  audit('firm.created', { userId, firmId: firm.id, data: { name: firm.name, number: firm.display_number, sheet: !!sheet } });
  log.info(`Firm added: ${firm.name} (${firm.display_number || 'no number yet'})${sheet ? ' with its Google Sheet' : ''}`);
  return firm;
}

export function seedFirmsFromEnv(raw = config.firmsSeed) {
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch (e) { log.error(`FIRMS is not valid JSON — ignored (${e.message})`); return []; }
  if (!Array.isArray(list)) list = [list];
  const out = [];
  for (const f of list) {
    try {
      const slug = slugify(f.slug || f.name);
      let firm = getFirmBySlug(slug);
      if (!firm) firm = addFirm({ ...f, slug, sheet: '' });
      else {
        const fill = {};
        if (!firm.display_number && f.number) fill.display_number = f.number;
        if (!firm.phone_number_id && f.phone_number_id) fill.phone_number_id = f.phone_number_id;
        if (!firm.waba_id && f.waba_id) fill.waba_id = f.waba_id;
        if (Object.keys(fill).length) firm = updateFirm(firm.id, fill);
      }
      // Firm 1's sheet is the environment's / Settings' business, never the seed's.
      if (f.sheet && !isDefaultFirm(firm.id) && !kvGet(firmKey('sheet.seeded', firm.id), false)) connectFirmSheet(firm.id, f.sheet, { leadsTab: f.leads_tab || '' });
      out.push(firm);
    } catch (e) { log.error(`FIRMS entry ${JSON.stringify(f?.name || f?.slug || f)} skipped: ${e.message}`); }
  }
  return out;
}
