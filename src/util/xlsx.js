// Minimal .xlsx reader (zero dependencies): every sheet's name and cell values, as strings.
// Used to read a link-shared Google Sheet in one request (export?format=xlsx), which, unlike the CSV
// export, includes every tab with its real name. Values are what the cell holds; formatting is ignored.
import zlib from 'node:zlib';

// ---- zip ----
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not an xlsx file (no zip directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt xlsx (bad zip directory)');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.local + 30 + buf.readUInt16LE(f.local + 26) + buf.readUInt16LE(f.local + 28);
    const data = buf.subarray(start, start + f.size);
    if (f.method === 0) return data.toString('utf8');
    if (f.method === 8) return zlib.inflateRawSync(data).toString('utf8');
    throw new Error(`Unsupported xlsx compression (${f.method})`);
  };
}

// ---- xml helpers (the OOXML parts used here are flat and machine-written) ----
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
});
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? decode(m[1]) : null; };
// Text of every <t> run, skipping phonetic hints (<rPh>).
const runsText = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)].map(m => decode(m[1] || '')).join('');
function colIndex(ref) { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }

// → [{ name, rows: [{ rowNumber, values: [...] }] }] in workbook (tab) order.
export function readXlsx(buf) {
  const read = unzip(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new Error('Not an xlsx file (no workbook)');
  const rels = new Map([...(read('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sharedXml = read('xl/sharedStrings.xml') || '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\s*\/>/g)].map(m => runsText(m[1] || ''));
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name');
    const target = rels.get(attr(m[0], 'r:id'));
    if (!name || !target) continue;
    const xml = read(target.startsWith('/') ? target.slice(1) : `xl/${target}`) || '';
    const rows = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const values = [];
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(` ${c[1]}`, 'r'); if (!ref) continue;
        const type = attr(` ${c[1]}`, 't');
        const body = c[2] || '';
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (type === 's') val = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') val = runsText(body);
        else if (v != null) val = decode(v);
        const i = colIndex(ref);
        while (values.length < i) values.push('');
        values[i] = val;
      }
      rows.push({ rowNumber: Number(attr(` ${r[1]}`, 'r')) || rows.length + 1, values });
    }
    sheets.push({ name, rows });
  }
  return sheets;
}
