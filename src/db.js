// SQLite persistence (node:sqlite — no native build step). One file on the data volume.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// One lead per (firm, number): the same person can be a lead of two firms, each with its own chat.
const leadsDdl = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER NOT NULL DEFAULT 1 REFERENCES firms(id),
  wa_number TEXT NOT NULL,                 -- E.164, e.g. +919876543210
  full_name TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  source TEXT NOT NULL DEFAULT 'sheet',    -- sheet | inbound | manual
  sheet_row INTEGER,                       -- 1-based row in the leads tab (for write-back)
  sheet_tab TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED',
  mode TEXT NOT NULL DEFAULT 'ai',         -- ai | human
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  outreach_paused INTEGER NOT NULL DEFAULT 0,
  opted_out INTEGER NOT NULL DEFAULT 0,
  qualified INTEGER NOT NULL DEFAULT 0,
  qualified_at TEXT,
  handoff_reason TEXT,
  corridor TEXT, budget TEXT, timeline TEXT, configuration TEXT, funding TEXT, objective TEXT,
  language TEXT,
  raw_fields TEXT DEFAULT '{}',            -- JSON of the ad-form answers / extra sheet columns
  followup_stage INTEGER NOT NULL DEFAULT 0, -- 0 none sent, 1 day0 sent, 2 day2 sent, 3 day5 sent
  first_contact_at TEXT,
  last_followup_at TEXT,
  followup_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_inbound_at TEXT,
  last_outbound_at TEXT,
  last_message_at TEXT,
  last_message_preview TEXT DEFAULT '',
  unread_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (firm_id, wa_number)
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',      -- admin | agent | viewer
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  wa_number TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT, user_agent TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS firms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  display_number TEXT NOT NULL DEFAULT '', -- the firm's WhatsApp business number, E.164
  phone_number_id TEXT NOT NULL DEFAULT '', -- Meta id of that number ('' on firm 1 = PHONE_NUMBER_ID)
  waba_id TEXT NOT NULL DEFAULT '',        -- '' = WABA_ID
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
${leadsDdl('leads')}
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,                 -- in | out
  sender TEXT NOT NULL,                    -- lead | ai | human | system
  sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'text',       -- text | template | image | audio | document | interactive | button | other
  body TEXT DEFAULT '',
  template_name TEXT,
  wa_message_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'received', -- received | queued | sent | delivered | read | failed
  error TEXT,
  meta TEXT DEFAULT '{}',                  -- JSON: AI analysis, raw payload bits, latency
  in_reply_to INTEGER,                     -- message id this AI reply answered
  review TEXT,                             -- good | bad | null
  review_note TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender, created_at);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  user_id INTEGER,
  type TEXT NOT NULL,
  data TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_lead ON audit(lead_id, id);
CREATE TABLE IF NOT EXISTS sheet_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,                        -- updateRow | appendReply
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
db.exec(SCHEMA);

// Idempotent column migrations (node:sqlite ships no migration tool; ADD COLUMN is cheap and safe).
for (const [table, col, decl] of [['users', 'wa_number', 'TEXT'], ['sheet_queue', 'firm_id', 'INTEGER NOT NULL DEFAULT 1'], ['audit', 'firm_id', 'INTEGER']]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (cols.includes(col)) continue;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  if (table === 'audit') db.exec('UPDATE audit SET firm_id = 1'); // everything logged before firms was firm 1's
}
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_firm ON audit(firm_id, id)');

// Firm 1 is the business this deployment was set up for; every existing lead belongs to it.
if (!db.prepare('SELECT 1 FROM firms WHERE id = 1').get()) {
  let name = 'Neopolis Infra';
  try { const r = db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get(); if (r) name = JSON.parse(r.value) || name; } catch { /* keep default */ }
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'main';
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO firms(id, slug, name, created_at, updated_at) VALUES (1, ?, ?, ?, ?)').run(slug, name, ts, ts);
}

// Leads used to be unique by number across the whole app. Adding firms means rebuilding the table with
// UNIQUE(firm_id, wa_number) — SQLite cannot drop a column constraint in place. This follows SQLite's
// documented 12-step procedure: foreign keys OFF (so dropping the old table cannot cascade-delete the
// messages), copy, drop, rename, check, all in one transaction. A snapshot is taken first.
function migrateLeadsToFirms() {
  const cols = db.prepare('PRAGMA table_info(leads)').all();
  if (cols.some(c => c.name === 'firm_id')) return;
  try {
    fs.mkdirSync(config.backup.dir, { recursive: true });
    const file = path.join(config.backup.dir, `leaddesk-pre-firms-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    console.log(`${new Date().toISOString()} [info] Snapshot before the firms migration: ${file}`);
  } catch (e) { console.error(`${new Date().toISOString()} [error] Snapshot before the firms migration failed (migrating anyway, it is transactional): ${e.message}`); }
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 0) throw new Error('could not turn foreign keys off');
    db.exec('BEGIN');
    try {
      const before = { leads: db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n };
      const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'leads'").get()?.seq || 0;
      db.exec(leadsDdl('leads_new'));
      const have = new Set(db.prepare('PRAGMA table_info(leads_new)').all().map(c => c.name));
      for (const c of cols) if (!have.has(c.name)) db.exec(`ALTER TABLE leads_new ADD COLUMN "${c.name}" ${c.type || ''}`); // columns added by later migrations
      const names = cols.map(c => `"${c.name}"`).join(', ');
      db.exec(`INSERT INTO leads_new (${names}) SELECT ${names} FROM leads`);
      db.exec('DROP TABLE leads');
      db.exec('ALTER TABLE leads_new RENAME TO leads');
      // Keep the id counter: a deleted lead's id must not come back (audit rows still point at it).
      if (seq) {
        db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'leads'").run(seq);
        db.prepare("INSERT INTO sqlite_sequence(name, seq) SELECT 'leads', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'leads')").run(seq);
      }
      const after = { leads: db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n };
      if (after.leads !== before.leads || after.messages !== before.messages) throw new Error(`row counts changed (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign key check failed: ${JSON.stringify(broken.slice(0, 3))}`);
      db.exec('COMMIT');
      console.log(`${new Date().toISOString()} [info] Firms migration done: ${after.leads} leads moved to firm 1, ${after.messages} messages kept`);
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
}
migrateLeadsToFirms();
db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_last_message ON leads(last_message_at);
CREATE INDEX IF NOT EXISTS idx_leads_firm ON leads(firm_id, last_message_at);`);

export const nowIso = () => new Date().toISOString();

export function run(sql, ...params) { return db.prepare(sql).run(...params); }
export function get(sql, ...params) { return db.prepare(sql).get(...params); }
export function all(sql, ...params) { return db.prepare(sql).all(...params); }
export function transaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
}
export function kvGet(key, dflt = null) { const r = get('SELECT value FROM kv WHERE key = ?', key); return r ? JSON.parse(r.value) : dflt; }
export function kvSet(key, value) { run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value)); }
export const parseJson = (s, d = {}) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
