// Google Sheet provider via an n8n "Sheet Bridge" workflow (uses n8n's own Google Sheets credential —
// no Apps Script or service account needed). See n8n workflow "Neopolis WA · Sheet Bridge".
import { config } from '../../config.js';

async function call(op, payload = {}) {
  const { n8nBridgeUrl, n8nBridgeSecret } = config.sheets;
  if (!n8nBridgeUrl) throw new Error('N8N_BRIDGE_URL is not set');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(n8nBridgeUrl, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': n8nBridgeSecret },
      body: JSON.stringify({ op, ...payload }),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { throw new Error(`n8n bridge returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
    if (Array.isArray(json)) json = json[0] || {};
    if (!res.ok || json.error) throw new Error(`n8n bridge: ${json.error || res.status}`);
    return json;
  } finally { clearTimeout(timer); }
}

export function createN8nBridgeProvider() {
  return {
    name: 'n8n',
    ping: () => call('ping'),
    readLeads: async () => {
      const r = await call('readLeads');
      const rows = Array.isArray(r.rows) ? r.rows : [];
      const headers = [];
      for (const row of rows) for (const k of Object.keys(row)) if (k !== 'row_number' && !headers.includes(k)) headers.push(k);
      return { tab: r.tab || config.sheets.leadsTab || 'leads', headers, rows: rows.filter(row => row.row_number).map(row => ({ rowNumber: Number(row.row_number), values: headers.map(h => (row[h] == null ? '' : String(row[h]))) })) };
    },
    updateRow: (rowNumber, values) => call('updateRow', { rowNumber, values }),
    appendReply: (row) => call('appendReply', { row }),
  };
}
