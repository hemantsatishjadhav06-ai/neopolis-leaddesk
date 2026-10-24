// SQLite persistence (node:sqlite — no native build step). One file on the data volume.
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

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
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_number TEXT NOT NULL UNIQUE,          -- E.164, e.g. +919876543210
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
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_last_message ON leads(last_message_at);
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
for (const [table, col, decl] of [['users', 'wa_number', 'TEXT'], ['leads', 'followup_retry_at', 'TEXT']]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

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
