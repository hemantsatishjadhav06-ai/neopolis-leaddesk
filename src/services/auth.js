// Users, passwords (scrypt) and cookie sessions.
import crypto from 'node:crypto';
import { all, get, run, nowIso } from '../db.js';
import { config } from '../config.js';
import { normalizePhone } from '../util/normalize.js';
import { log } from '../logger.js';

export const ROLES = ['admin', 'agent', 'viewer'];
const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
  try {
    const [, salt, hash] = String(stored).split('$');
    const calc = crypto.scryptSync(String(password), salt, 64);
    const ref = Buffer.from(hash, 'hex');
    return calc.length === ref.length && crypto.timingSafeEqual(calc, ref);
  } catch { return false; }
}

export const userCount = () => get('SELECT COUNT(*) AS n FROM users').n;
export const publicUser = (u) => u && ({ id: u.id, email: u.email, name: u.name, role: u.role, wa_number: u.wa_number || '', active: !!u.active, created_at: u.created_at, last_login_at: u.last_login_at });
export const listUsers = () => all('SELECT * FROM users ORDER BY id').map(publicUser);
export const getUserById = (id) => get('SELECT * FROM users WHERE id = ?', id);

export function createUser({ email, name, password, role = 'agent', wa_number = '' }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address');
  if (!name || String(name).trim().length < 2) throw new Error('Enter a name');
  if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters');
  if (!ROLES.includes(role)) throw new Error('Invalid role');
  if (get('SELECT id FROM users WHERE email = ?', email)) throw new Error('A user with that email already exists');
  const wa = wa_number ? (normalizePhone(wa_number) || '') : '';
  const r = run('INSERT INTO users(email,name,password_hash,role,wa_number,active,created_at) VALUES(?,?,?,?,?,1,?)', email, String(name).trim(), hashPassword(password), role, wa, nowIso());
  return getUserById(Number(r.lastInsertRowid));
}
export function updateUser(id, { name, role, active, password, wa_number }) {
  const u = getUserById(id); if (!u) throw new Error('User not found');
  if (name !== undefined) run('UPDATE users SET name = ? WHERE id = ?', String(name).trim(), id);
  if (role !== undefined) { if (!ROLES.includes(role)) throw new Error('Invalid role'); run('UPDATE users SET role = ? WHERE id = ?', role, id); }
  if (active !== undefined) run('UPDATE users SET active = ? WHERE id = ?', active ? 1 : 0, id);
  if (wa_number !== undefined) run('UPDATE users SET wa_number = ? WHERE id = ?', wa_number ? (normalizePhone(wa_number) || '') : '', id);
  if (password) { if (String(password).length < 8) throw new Error('Password must be at least 8 characters'); run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), id); run('DELETE FROM sessions WHERE user_id = ?', id); }
  return getUserById(id);
}

// ---- login throttling (per IP, in memory) ----
const attempts = new Map();
export function loginAllowed(ip) {
  const now = Date.now();
  // Drop IPs that have gone quiet, so this map can't grow without bound over a long uptime.
  if (attempts.size > 500) for (const [k, v] of attempts) if (!v.length || now - v[v.length - 1] > 60_000) attempts.delete(k);
  const a = attempts.get(ip) || [];
  const recent = a.filter(t => now - t < 60_000);
  attempts.set(ip, recent);
  return recent.length < 10;
}
export function noteLoginAttempt(ip) { const a = attempts.get(ip) || []; a.push(Date.now()); attempts.set(ip, a); }

export function login(email, password, meta = {}) {
  const u = get('SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
  if (!u || !u.active || !verifyPassword(password, u.password_hash)) return null;
  const id = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  run('INSERT INTO sessions(id,user_id,created_at,expires_at,ip,user_agent) VALUES(?,?,?,?,?,?)',
    id, u.id, now.toISOString(), new Date(now.getTime() + SESSION_DAYS * 864e5).toISOString(), meta.ip || '', (meta.userAgent || '').slice(0, 200));
  run('UPDATE users SET last_login_at = ? WHERE id = ?', now.toISOString(), u.id);
  return { sessionId: id, user: publicUser(u) };
}
export function logout(sessionId) { if (sessionId) run('DELETE FROM sessions WHERE id = ?', sessionId); }
export function userFromSession(sessionId) {
  if (!sessionId) return null;
  const s = get('SELECT * FROM sessions WHERE id = ?', sessionId);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) { run('DELETE FROM sessions WHERE id = ?', sessionId); return null; }
  const u = getUserById(s.user_id);
  return u && u.active ? u : null;
}
export function cleanupSessions() { run('DELETE FROM sessions WHERE expires_at < ?', nowIso()); }

// First admin from env (optional) — only when there are no users yet.
export function bootstrapAdmin() {
  if (userCount() > 0) return;
  if (config.adminEmail && config.adminPassword) {
    try { createUser({ email: config.adminEmail, name: config.adminName, password: config.adminPassword, role: 'admin' }); log.info(`Created first admin ${config.adminEmail} from environment`); }
    catch (e) { log.error('Could not create admin from env', e); }
  }
}
