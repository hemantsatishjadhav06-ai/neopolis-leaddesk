// The ACTIVE Google-Sheet connection of a firm. It can be set at runtime from Settings → Google Sheet
// (stored in the kv table) and, when set, overrides the environment defaults from config.js.
// This is what makes "paste your sheet link and connect" work without a redeploy.
// The environment's sheet variables (SPREADSHEET_ID, SHEETS_APPS_SCRIPT_URL, N8N_BRIDGE_URL …) are firm 1's;
// every other firm has only the connection it was given.
import { config } from '../../config.js';
import { kvGet, kvSet } from '../../db.js';
import { currentFirmId, isDefaultFirm, firmKey } from '../../firms.js';

const KEY = 'sheet.connection';
const NO_ENV = { provider: 'none', spreadsheetId: '', leadsTab: '', repliesTab: 'Client Replies', appsScriptUrl: '', appsScriptSecret: '', serviceAccountB64: '', n8nBridgeUrl: '', n8nBridgeSecret: '' };

// Pull a spreadsheet id + optional gid (tab) out of a pasted Google Sheets URL or a raw id.
export function parseSheetRef(input) {
  const s = String(input || '').trim();
  if (!s) return { spreadsheetId: '', gid: '' };
  const idMatch = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || s.match(/^([a-zA-Z0-9-_]{20,})$/);
  const gidMatch = s.match(/[#&?]gid=([0-9]+)/);
  return { spreadsheetId: idMatch ? idMatch[1] : '', gid: gidMatch ? gidMatch[1] : '' };
}

// Merge the stored connection (if any) over the env defaults. Same shape as config.sheets, plus gid + readOnly.
export function activeSheetConfig(firmId = currentFirmId()) {
  const env = isDefaultFirm(firmId) ? config.sheets : NO_ENV;
  const c = kvGet(firmKey(KEY, firmId), null);
  if (!c || !c.provider) {
    return { ...env, gid: '', readOnly: false, source: 'env' };
  }
  return {
    provider: c.provider,
    spreadsheetId: c.spreadsheetId || env.spreadsheetId || '',
    leadsTab: c.leadsTab != null ? c.leadsTab : (env.leadsTab || ''),
    repliesTab: c.repliesTab || env.repliesTab || 'Client Replies',
    gid: c.gid || '',
    appsScriptUrl: c.appsScriptUrl || env.appsScriptUrl || '',
    appsScriptSecret: c.appsScriptSecret || env.appsScriptSecret || '',
    serviceAccountB64: c.serviceAccountB64 || env.serviceAccountB64 || '',
    n8nBridgeUrl: env.n8nBridgeUrl || '',
    n8nBridgeSecret: env.n8nBridgeSecret || '',
    readOnly: c.provider === 'publiclink',
    source: 'runtime',
  };
}

// The leads tab(s) named in the connection: "02-08-2026, Sheet6" → ['02-08-2026', 'Sheet6']. Empty = auto-detect.
export function configuredLeadTabs(firmId = currentFirmId()) {
  return String(activeSheetConfig(firmId).leadsTab || '').split(',').map(s => s.trim()).filter(Boolean);
}

export function setSheetConnection(conn, firmId = currentFirmId()) { kvSet(firmKey(KEY, firmId), conn); }
export function clearSheetConnection(firmId = currentFirmId()) { kvSet(firmKey(KEY, firmId), null); }

// A UI-safe view of the connection: never leaks the Apps Script secret or service-account key.
export function sheetConnectionPublic(firmId = currentFirmId()) {
  const c = activeSheetConfig(firmId);
  return {
    provider: c.provider,
    source: c.source,
    readOnly: !!c.readOnly,
    spreadsheetId: c.spreadsheetId,
    leadsTab: c.leadsTab,
    repliesTab: c.repliesTab,
    gid: c.gid,
    appsScriptUrl: c.appsScriptUrl,
    appsScriptSecretSet: !!c.appsScriptSecret,
    serviceAccountSet: !!c.serviceAccountB64,
    sheetUrl: c.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${c.spreadsheetId}/edit` : '',
  };
}
