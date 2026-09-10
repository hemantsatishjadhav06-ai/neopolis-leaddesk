import { userFromSession } from '../services/auth.js';

export const COOKIE = 'ld_sid';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function attachUser(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.sessionId = req.cookies[COOKIE] || null;
  req.user = userFromSession(req.sessionId);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission for this action' });
    next();
  };
}
// Writers = admin + agent (viewers are read-only)
export const requireWriter = requireRole('admin', 'agent');

// Simple CSRF defence: state-changing API calls must carry a custom header (browsers won't add it cross-site).
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'fetch') return res.status(403).json({ error: 'Missing X-Requested-With header' });
  next();
}

export function setSessionCookie(res, sessionId, secure) {
  const parts = [`${COOKIE}=${encodeURIComponent(sessionId)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${30 * 86400}`];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
