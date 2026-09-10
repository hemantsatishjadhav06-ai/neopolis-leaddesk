// Database snapshots. The whole business (leads + every conversation) lives in one SQLite file on one
// Railway volume; without this there is no copy of it anywhere.
//
// Strategy: `VACUUM INTO` writes a consistent snapshot without stopping writes. Snapshots are rotated
// on the volume (protects against corruption / a bad deploy / accidental deletion) and, when
// BACKUP_OFFSITE_URL is set, streamed off the box too (protects against losing the volume itself).
import fs from 'node:fs';
import path from 'node:path';
import { db, kvGet, kvSet } from '../db.js';
import { config } from '../config.js';
import { log } from '../logger.js';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

export function listBackups() {
  try {
    return fs.readdirSync(config.backup.dir)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const st = fs.statSync(path.join(config.backup.dir, f));
        return { file: f, bytes: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch { return []; }
}

async function offsite(file) {
  const url = config.backup.offsiteUrl;
  if (!url) return { skipped: true };
  const buf = fs.readFileSync(file);
  const headers = { 'Content-Type': 'application/octet-stream', 'X-Backup-Name': path.basename(file) };
  if (config.backup.offsiteToken) headers.Authorization = `Bearer ${config.backup.offsiteToken}`;
  const res = await fetch(url, { method: 'POST', headers, body: buf });
  if (!res.ok) throw new Error(`offsite upload failed: ${res.status} ${res.statusText}`);
  return { uploaded: true, bytes: buf.length };
}

export async function runBackup({ reason = 'scheduled' } = {}) {
  const started = Date.now();
  try {
    fs.mkdirSync(config.backup.dir, { recursive: true });
    const target = path.join(config.backup.dir, `leaddesk-${stamp()}.db`);
    // VACUUM INTO takes a consistent snapshot of the live DB.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const bytes = fs.statSync(target).size;

    // rotate
    const keep = Math.max(1, config.backup.keep);
    for (const b of listBackups().slice(keep)) {
      try { fs.unlinkSync(path.join(config.backup.dir, b.file)); } catch { /* ignore */ }
    }

    let off = { skipped: true };
    try { off = await offsite(target); }
    catch (e) { log.error('Offsite backup failed', e); off = { error: e.message }; }

    const result = { ok: true, at: new Date().toISOString(), file: path.basename(target), bytes, ms: Date.now() - started, reason, offsite: off };
    kvSet('backup.last', result);
    log.info(`Backup ok — ${path.basename(target)} (${Math.round(bytes / 1024)} KB)`);
    return result;
  } catch (e) {
    const result = { ok: false, at: new Date().toISOString(), error: e.message, reason };
    kvSet('backup.last', result);
    log.error('Backup FAILED', e);
    return result;
  }
}

export function backupStatus() {
  const last = kvGet('backup.last', null);
  const files = listBackups();
  const ageHours = last?.at ? (Date.now() - Date.parse(last.at)) / 3600000 : null;
  return {
    enabled: config.backup.enabled,
    everyHours: config.backup.everyHours,
    keep: config.backup.keep,
    offsiteConfigured: !!config.backup.offsiteUrl,
    last,
    count: files.length,
    latest: files[0] || null,
    stale: config.backup.enabled && (ageHours === null || ageHours > config.backup.everyHours * 2),
  };
}

// Called from the scheduler tick; only actually runs when due.
export async function maybeBackup() {
  if (!config.backup.enabled) return { skipped: 'disabled' };
  const last = kvGet('backup.last', null);
  const dueAfter = config.backup.everyHours * 3600000;
  if (last?.ok && last.at && Date.now() - Date.parse(last.at) < dueAfter) return { skipped: 'not due' };
  return runBackup({ reason: 'scheduled' });
}
