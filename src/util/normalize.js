// Phone normalisation to E.164 (+91XXXXXXXXXX) and name helpers.
// Handles the mess found in real lead sheets: "p:+91...", stray zeros, spaces, bare 10 digits.
export function normalizePhone(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^(p|wa|tel):/i, '');
  const hadPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 13 && digits.startsWith('910')) digits = '91' + digits.slice(3); // +91 0XXXXXXXXXX
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) return '+91' + digits;
  if (hadPlus && digits.length >= 11 && digits.length <= 15) return '+' + digits;      // other countries
  if (!hadPlus && digits.length >= 11 && digits.length <= 15 && !digits.startsWith('0')) return '+' + digits;
  return null;
}
export const toWaId = (e164) => (e164 ? String(e164).replace(/^\+/, '') : null);

export function firstName(fullName) {
  if (!fullName) return '';
  let n = String(fullName).replace(/\S+@\S+/g, '').replace(/\d{5,}/g, '').replace(/[^\p{L}\p{M}\s.'-]/gu, ' ').trim();
  const token = n.split(/\s+/)[0] || '';
  if (!token) return '';
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

// Turn ad-form snake_case answers into readable text: "tellapur_/_kollur_(high_appreciation" → "tellapur / kollur (high appreciation"
export function prettyAnswer(v) {
  if (v == null) return '';
  return String(v).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}
export function normHeader(h) { return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
