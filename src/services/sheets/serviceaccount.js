// Google Sheet provider via a service account (Sheets REST API, zero dependencies).
// Requires GOOGLE_SERVICE_ACCOUNT_B64 (base64 of the JSON key) and the sheet shared with the
// service account's client_email as Editor.
import crypto from 'node:crypto';
import { activeSheetConfig, configuredLeadTabs } from './active.js';
import { normHeader } from '../../util/normalize.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const cachedTokens = new Map(); // client_email -> { token, exp }

function credentials(firmId) {
  const b64 = activeSheetConfig(firmId).serviceAccountB64;
  if (!b64) throw new Error('GOOGLE_SERVICE_ACCOUNT_B64 is not set');
  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  if (!json.client_email || !json.private_key) throw new Error('Service account JSON is missing client_email/private_key');
  return json;
}
const b64url = (s) => Buffer.from(s).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

async function accessToken(firmId) {
  const c = credentials(firmId);
  const cachedToken = cachedTokens.get(c.client_email);
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: c.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), c.private_key);
  const assertion = `${header}.${claims}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const json = await res.json();
  if (!res.ok || !json.access_token) throw new Error(`Google token error: ${json.error_description || json.error || res.status}`);
  cachedTokens.set(c.client_email, { token: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 });
  return json.access_token;
}

async function api(firmId, method, path, body, query) {
  const url = new URL(`${API}/${activeSheetConfig(firmId).spreadsheetId}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${await accessToken(firmId)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${json.error?.message || res.statusText}`);
  return json;
}
const q = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

async function listTabs(firmId) { const meta = await api(firmId, 'GET', '', null, { fields: 'properties.title,sheets.properties.title' }); return { title: meta.properties?.title, tabs: (meta.sheets || []).map(s => s.properties.title) }; }
async function findLeadsTab(firmId) {
  const lt = configuredLeadTabs(firmId)[0]; if (lt) return lt;
  const { tabs } = await listTabs(firmId);
  for (const t of tabs) {
    const r = await api(firmId, 'GET', `/values/${encodeURIComponent(q(t) + '!1:1')}`);
    const h = (r.values?.[0] || []).map(normHeader);
    if (h.includes('whatsapp_number') && h.includes('lead_status')) return t;
  }
  throw new Error('No tab with whatsapp_number + lead_status headers');
}
async function readTab(firmId, tab) {
  const r = await api(firmId, 'GET', `/values/${encodeURIComponent(q(tab))}`, null, { valueRenderOption: 'FORMATTED_VALUE' });
  const values = r.values || [];
  const headers = values[0] || [];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    if (!row.some(v => v !== '' && v != null)) continue;
    rows.push({ rowNumber: i + 1, values: headers.map((_, j) => row[j] ?? '') });
  }
  return { tab, headers, rows };
}
function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

export function createServiceAccountProvider(firmId) {
  return {
    name: 'serviceaccount',
    ping: async () => { const t = await listTabs(firmId); return { ok: true, name: t.title, tabs: t.tabs }; },
    readLeads: async () => readTab(firmId, await findLeadsTab(firmId)),
    readTables: async () => {
      const configured = configuredLeadTabs(firmId);
      const tabs = configured.length ? configured : (await listTabs(firmId)).tabs;
      const out = [];
      for (const tab of tabs) out.push(await readTab(firmId, tab));
      return out;
    },
    updateRow: async (rowNumber, values, tab) => {
      tab = tab || await findLeadsTab(firmId);
      const hr = await api(firmId, 'GET', `/values/${encodeURIComponent(q(tab) + '!1:1')}`);
      const headers = hr.values?.[0] || [];
      const normed = headers.map(normHeader);
      const data = [];
      for (const [key, val] of Object.entries(values)) {
        let idx = normed.indexOf(normHeader(key));
        if (idx < 0) { idx = headers.length; headers.push(key); normed.push(normHeader(key)); data.push({ range: `${q(tab)}!${colLetter(idx + 1)}1`, values: [[key]] }); }
        data.push({ range: `${q(tab)}!${colLetter(idx + 1)}${rowNumber}`, values: [[val == null ? '' : String(val)]] });
      }
      await api(firmId, 'POST', '/values:batchUpdate', { valueInputOption: 'USER_ENTERED', data });
      return { ok: true };
    },
    appendReply: async (row) => {
      const tab = activeSheetConfig(firmId).repliesTab;
      const HEADERS = ['timestamp', 'whatsapp_number', 'full_name', 'message', 'ai_reply', 'lead_reference', 'conversation_link'];
      const { tabs } = await listTabs(firmId);
      if (!tabs.includes(tab)) {
        await api(firmId, 'POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }] });
        await api(firmId, 'PUT', `/values/${encodeURIComponent(q(tab) + '!A1')}`, { values: [HEADERS] }, { valueInputOption: 'USER_ENTERED' });
      }
      await api(firmId, 'POST', `/values/${encodeURIComponent(q(tab) + '!A1')}:append`, { values: [HEADERS.map(h => row[h] == null ? '' : String(row[h]))] }, { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' });
      return { ok: true };
    },
  };
}
