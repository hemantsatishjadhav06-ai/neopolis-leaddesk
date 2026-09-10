/**
 * Neopolis LeadDesk — Google Sheet connector (Google Apps Script, bound to the leads spreadsheet).
 *
 * What it does: lets LeadDesk read the leads tab, update lead_status / last_reply on a row,
 * and append rows to the "Client Replies" tab — using YOUR Google account's access, so no
 * Google Cloud project or service account is needed.
 *
 * Install (one time, ~2 minutes):
 *   1. Open the leads spreadsheet → Extensions → Apps Script.
 *   2. Delete any code there, paste this whole file, and replace SECRET below with the value
 *      LeadDesk shows under Settings → Google Sheet (or any long random string — same in both places).
 *   3. Click Deploy → New deployment → type "Web app" → Execute as: Me → Who has access: Anyone → Deploy.
 *      Authorise when Google asks (it is your own script accessing your own sheet).
 *   4. Copy the Web app URL (ends with /exec) into LeadDesk's SHEETS_APPS_SCRIPT_URL environment variable
 *      and the secret into SHEETS_APPS_SCRIPT_SECRET.
 *   If you edit this file later, use Deploy → Manage deployments → Edit → Version: New → Deploy.
 */
var SECRET = 'REPLACE_WITH_SECRET';
var REPLIES_TAB = 'Client Replies';
var REPLIES_HEADERS = ['timestamp', 'whatsapp_number', 'full_name', 'message', 'ai_reply', 'lead_reference', 'conversation_link'];

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!SECRET || SECRET === 'REPLACE_WITH_SECRET' || body.secret !== SECRET) return out({ error: 'unauthorized' });
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    switch (body.op) {
      case 'ping': return out({ ok: true, name: ss.getName(), tabs: ss.getSheets().map(function (s) { return s.getName(); }) });
      case 'readLeads': return out(readLeads(ss, body.tab));
      case 'updateRow': return out(updateRow(ss, body.tab, body.rowNumber, body.values || {}));
      case 'appendReply': return out(appendReply(ss, body.row || {}));
      default: return out({ error: 'unknown op: ' + body.op });
    }
  } catch (err) {
    return out({ error: String((err && err.message) || err) });
  }
}
function doGet() { return out({ ok: true, service: 'Neopolis LeadDesk sheet connector' }); }

function out(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function norm(h) { return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }

function findLeadsTab(ss, tab) {
  if (tab) { var s = ss.getSheetByName(tab); if (!s) throw new Error('Tab not found: ' + tab); return s; }
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i]; var lc = sh.getLastColumn(); if (lc < 1) continue;
    var h = sh.getRange(1, 1, 1, lc).getValues()[0].map(norm);
    if (h.indexOf('whatsapp_number') >= 0 && h.indexOf('lead_status') >= 0) return sh;
  }
  throw new Error('No tab with whatsapp_number + lead_status headers');
}

function readLeads(ss, tab) {
  var s = findLeadsTab(ss, tab);
  var lastRow = s.getLastRow(), lastCol = s.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { tab: s.getName(), headers: [], rows: [] };
  var values = s.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    var empty = true; for (var j = 0; j < r.length; j++) { if (r[j] !== '') { empty = false; break; } }
    if (empty) continue;
    rows.push({ rowNumber: i + 1, values: r });
  }
  return { tab: s.getName(), headers: headers, rows: rows };
}

function updateRow(ss, tab, rowNumber, values) {
  var s = findLeadsTab(ss, tab);
  var lc = s.getLastColumn();
  var headers = lc ? s.getRange(1, 1, 1, lc).getValues()[0] : [];
  var normed = headers.map(norm);
  var keys = Object.keys(values);
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    var idx = normed.indexOf(norm(key));
    if (idx < 0) { // only ever adds a brand-new column at the far right (e.g. last_reply)
      var col = headers.length + 1;
      s.getRange(1, col).setValue(key).setFontWeight('bold');
      headers.push(key); normed.push(norm(key)); idx = col - 1;
    }
    s.getRange(Number(rowNumber), idx + 1).setValue(values[key]);
  }
  return { ok: true };
}

function appendReply(ss, row) {
  var s = ss.getSheetByName(REPLIES_TAB);
  if (!s) {
    s = ss.insertSheet(REPLIES_TAB);
    s.appendRow(REPLIES_HEADERS);
    s.getRange(1, 1, 1, REPLIES_HEADERS.length).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  s.appendRow(REPLIES_HEADERS.map(function (h) { return row[h] == null ? '' : row[h]; }));
  return { ok: true };
}
