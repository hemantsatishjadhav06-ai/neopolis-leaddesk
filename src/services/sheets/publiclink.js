// Read-only Google Sheet provider: pulls leads straight from a shared sheet LINK, no Google
// project, no script, no credentials. Requires the sheet's General access = "Anyone with the
// link: Viewer". Import only — status/replies are kept inside LeadDesk (use the Apps Script
// connector if you also want them written back to the sheet).
import { activeSheetConfig } from './active.js';
import { readXlsx } from '../../util/xlsx.js';
import { log } from '../../logger.js';

// Tiny RFC-4180-ish CSV parser (handles quotes, escaped quotes, embedded commas + newlines).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = String(text || '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchCsv() {
  const c = activeSheetConfig();
  if (!c.spreadsheetId) throw new Error('No spreadsheet linked yet.');
  const base = `https://docs.google.com/spreadsheets/d/${c.spreadsheetId}`;
  // Try, in order: exact tab by gid, exact tab by name (gviz), then the first sheet.
  const urls = [];
  if (c.gid) urls.push(`${base}/export?format=csv&gid=${encodeURIComponent(c.gid)}`);
  if (c.leadsTab) urls.push(`${base}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(c.leadsTab)}`);
  urls.push(`${base}/export?format=csv`);
  let lastErr = null;
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let res, text;
      try { res = await fetch(url, { redirect: 'follow', signal: ctrl.signal }); text = await res.text(); }
      finally { clearTimeout(timer); }
      if (res.status === 401 || res.status === 403 || /<html/i.test(text.slice(0, 400))) {
        lastErr = new Error('The sheet is not open to link access. In Google Sheets: Share → General access → "Anyone with the link" → Viewer, then try again.');
        continue;
      }
      if (!res.ok) { lastErr = new Error(`Google returned HTTP ${res.status}`); continue; }
      return text;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Could not read the sheet from its link.');
}

// Every tab of the workbook in one request. The CSV export only gives one tab, and only the one whose gid
// happened to be in the pasted link, which is how an import ended up reading a "visits list" tab.
async function fetchWorkbook() {
  const c = activeSheetConfig();
  if (!c.spreadsheetId) throw new Error('No spreadsheet linked yet.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${c.spreadsheetId}/export?format=xlsx`, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error(`Google returned HTTP ${res.status}`);
    return readXlsx(Buffer.from(await res.arrayBuffer())); // a sign-in page (sheet not shared by link) fails to parse here
  } finally { clearTimeout(timer); }
}

export function createPublicLinkProvider() {
  const provider = {
    name: 'publiclink',
    readOnly: true,
    ping: async () => {
      const table = parseCsv(await fetchCsv());
      const headers = table[0] || [];
      return { ok: true, mode: 'read-only (link)', rows: Math.max(0, table.length - 1), headers };
    },
    readLeads: async () => {
      const c = activeSheetConfig();
      const table = parseCsv(await fetchCsv());
      const headers = table[0] || [];
      const rows = [];
      for (let i = 1; i < table.length; i++) {
        const v = table[i];
        if (!v || !v.some(x => String(x).trim() !== '')) continue;
        rows.push({ rowNumber: i + 1, values: headers.map((_, j) => v[j] ?? '') });
      }
      return { tab: c.leadsTab || 'sheet', headers, rows };
    },
    readTables: async () => {
      try {
        return (await fetchWorkbook()).map(s => {
          const headers = s.rows.find(r => r.rowNumber === 1)?.values || [];
          const rows = s.rows.filter(r => r.rowNumber > 1 && r.values.some(x => String(x).trim() !== ''))
            .map(r => ({ rowNumber: r.rowNumber, values: headers.map((_, j) => r.values[j] ?? '') }));
          return { tab: s.name, headers, rows };
        });
      } catch (e) {
        log.warn(`Whole-workbook read failed (${e.message}); reading a single tab instead`);
        return [await provider.readLeads()];
      }
    },
    // Read-only: writes are silently no-ops (mirroring is disabled for this provider anyway).
    updateRow: async () => ({ ok: true, skipped: 'read-only link connection' }),
    appendReply: async () => ({ ok: true, skipped: 'read-only link connection' }),
  };
  return provider;
}
