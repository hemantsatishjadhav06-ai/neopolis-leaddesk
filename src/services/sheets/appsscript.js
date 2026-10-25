// Google Sheet provider via the bundled Apps Script web app (apps-script/Code.gs).
// Full 2-way sync (read leads, write lead_status/last_reply, append Client Replies) using the
// user's own Google account — no Google Cloud project. URL + secret come from the active
// connection (Settings → Google Sheet) with the env vars as fallback.
import { activeSheetConfig, configuredLeadTabs } from './active.js';

async function call(op, payload = {}) {
  const { appsScriptUrl, appsScriptSecret } = activeSheetConfig();
  if (!appsScriptUrl) throw new Error('No Apps Script URL set — connect the sheet under Settings → Google Sheet.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    // Apps Script answers POSTs with a 302 to script.googleusercontent.com; fetch follows it.
    const res = await fetch(appsScriptUrl, {
      method: 'POST', redirect: 'follow', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: appsScriptSecret, op, ...payload }),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { throw new Error(`Sheet connector returned non-JSON (HTTP ${res.status}). Is the Apps Script deployed as a Web app with access "Anyone"?`); }
    if (json.error) throw new Error(`Sheet connector: ${json.error}`);
    return json;
  } finally { clearTimeout(timer); }
}

export function createAppsScriptProvider() {
  const leadsTab = () => configuredLeadTabs()[0];
  return {
    name: 'appsscript',
    ping: () => call('ping'),
    readLeads: () => call('readLeads', { tab: leadsTab() }),
    readTables: async () => {
      const configured = configuredLeadTabs();
      const tabs = configured.length ? configured : ((await call('ping')).tabs || []);
      const out = [];
      for (const tab of tabs) {
        try { out.push(await call('readLeads', { tab })); }
        catch (e) { if (configured.length) throw e; } // an auto-scanned tab that fails is simply not a leads tab
      }
      return out;
    },
    updateRow: (rowNumber, values, tab) => call('updateRow', { tab: tab || leadsTab(), rowNumber, values }),
    appendReply: (row) => call('appendReply', { row }),
  };
}
