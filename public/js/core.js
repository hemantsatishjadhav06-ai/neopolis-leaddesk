// Shared runtime: state, API client, router, layout, live events, helpers.
export const state = { user: null, boot: null, users: [], firms: [], firmId: null, route: { view: 'dashboard', id: null, tab: null }, alerts: 0, sse: null, listeners: new Set() };

// The firm the team is looking at: every list, setting and send in the UI is for this firm (X-Firm-Id).
export const currentFirm = () => state.firms.find(f => f.id === state.firmId) || state.firms[0] || null;
export const firmName = (id) => state.firms.find(f => f.id === id)?.name || '';
export function setFirms(firms) {
  state.firms = firms || [];
  let saved = null; try { saved = Number(localStorage.getItem('ld.firm')); } catch { /* storage may be blocked */ }
  if (!state.firms.some(f => f.id === state.firmId)) state.firmId = state.firms.some(f => f.id === saved) ? saved : (state.firms[0]?.id || null);
}
export function selectFirm(id) {
  if (!state.firms.some(f => f.id === Number(id))) return false;
  state.firmId = Number(id);
  try { localStorage.setItem('ld.firm', String(state.firmId)); } catch { /* ignore */ }
  return true;
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'X-Requested-With': 'fetch', ...(state.firmId ? { 'X-Firm-Id': String(state.firmId) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { data = {}; }
  if (res.status === 401 && !path.startsWith('/login') && !path.startsWith('/bootstrap')) { state.user = null; renderApp(); throw new Error('Signed out'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- helpers ----------
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const initials = (name, fallback = '#') => { const p = String(name || '').trim().split(/\s+/).filter(Boolean); return p.length ? (p[0][0] + (p[1]?.[0] || '')).toUpperCase() : fallback; };
export const STATUS_LABEL = { CREATED: 'New', CONTACTED: 'Contacted', FOLLOWUP_1: 'Follow-up 1', FOLLOWUP_2: 'Follow-up 2', FOLLOWUP_3: 'Follow-up 3', FOLLOWUP_4: 'Follow-up 4', FOLLOWUP_5: 'Follow-up 5', NO_RESPONSE: 'No response', REPLIED: 'Replied', PROSPECT: 'Prospect', IN_SALES: 'In sales', VISIT_BOOKED: 'Visit booked', WON: 'Won', LOST: 'Lost', OPTED_OUT: 'Opted out' };
export const STATUSES = Object.keys(STATUS_LABEL);
export const statusPill = (s) => `<span class="pill s-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
export const modePill = (m) => m === 'human' ? `<span class="pill mode-human">Human</span>` : `<span class="pill mode-ai">AI</span>`;
export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso); const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return t;
  const yesterday = new Date(now.getTime() - 864e5);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday ' + t;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + t;
}
export function fmtDay(iso) { const d = new Date(iso); const now = new Date(); if (d.toDateString() === now.toDateString()) return 'Today'; const y = new Date(now.getTime() - 864e5); if (d.toDateString() === y.toDateString()) return 'Yesterday'; return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined }); }
export function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`;
}
export function untilText(iso) { const ms = new Date(iso).getTime() - Date.now(); if (ms <= 0) return 'closed'; const h = Math.floor(ms / 36e5), m = Math.floor((ms % 36e5) / 6e4); return h ? `${h}h ${m}m` : `${m}m`; }
export const userName = (id) => (state.users.find(u => u.id === id)?.name) || (id ? `User #${id}` : '');
export const isWriter = () => state.user && ['admin', 'agent'].includes(state.user.role);
export const isAdmin = () => state.user && state.user.role === 'admin';

export function toast(msg, kind = '', { html = false, timeout = 4000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.innerHTML = html ? msg : esc(msg);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), timeout);
}
export function modal({ title, body, footer, onOpen }) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><div class="m-h"><h2>${esc(title)}</h2><button class="btn ghost sm" data-close>✕</button></div><div class="m-b">${body}</div>${footer ? `<div class="m-f">${footer}</div>` : ''}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(bg);
  onOpen?.(bg, close);
  return { el: bg, close };
}
export function confirmDialog(title, text, { okLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    modal({ title, body: `<p>${esc(text)}</p>`, footer: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button>`,
      onOpen: (bg, close) => { bg.querySelector('[data-ok]').onclick = () => { resolve(true); close(); }; bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) resolve(false); }); } });
  });
}
export function askText(title, label, initial = '', { okLabel = 'Save', multiline = true } = {}) {
  return new Promise((resolve) => {
    modal({ title, body: `<label class="field">${esc(label)}</label>${multiline ? `<textarea id="ask-text">${esc(initial)}</textarea>` : `<input type="text" id="ask-text" value="${esc(initial)}">`}`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>${esc(okLabel)}</button>`,
      onOpen: (bg, close) => { const inp = bg.querySelector('#ask-text'); inp.focus(); bg.querySelector('[data-ok]').onclick = () => { resolve(inp.value); close(); }; bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) resolve(null); }); } });
  });
}
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------- router ----------
export function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view = 'dashboard', a = null, b = null] = h.split('/');
  return { view, id: a && /^\d+$/.test(a) ? Number(a) : null, tab: a && !/^\d+$/.test(a) ? a : b };
}
export const go = (path) => { location.hash = path; };

// ---------- live events ----------
export function connectEvents() {
  if (state.sse) return;
  const es = new EventSource('/api/events');
  state.sse = es;
  const emit = (type, e) => { let data = {}; try { data = JSON.parse(e.data); } catch { /* ignore */ } for (const l of state.listeners) { try { l(type, data); } catch (err) { console.error(err); } } };
  es.addEventListener('lead', (e) => emit('lead', e));
  es.addEventListener('message', (e) => emit('message', e));
  es.addEventListener('alert', (e) => { emit('alert', e); handleAlert(e); });
  es.onerror = () => { es.close(); state.sse = null; setTimeout(connectEvents, 4000); };
}
function handleAlert(e) {
  let d = {}; try { d = JSON.parse(e.data); } catch { return; }
  const name = esc(d.name || 'A lead');
  // An alert for another firm says which, and its link switches to that firm (main.js).
  const other = d.firm_id && d.firm_id !== state.firmId ? firmName(d.firm_id) : '';
  const tag = other ? `[${esc(other)}] ` : '';
  const link = (label) => `<a href="#/inbox/${d.lead_id}" data-firm="${Number(d.firm_id) || ''}">${label}</a>`;
  if (d.kind === 'handoff') toast(`${tag}<b>${name}</b> is ready for sales — ${esc(d.reason || 'qualified')}. ${link('Open chat')}`, 'alert', { html: true, timeout: 9000 });
  else if (d.kind === 'human_unread') toast(`${tag}<b>${name}</b> replied (AI is off for this chat). ${link('Reply')}`, 'alert', { html: true, timeout: 9000 });
  try { if (Notification?.permission === 'granted') new Notification(d.kind === 'handoff' ? `${other ? `${other}: ` : ''}Ready for sales: ${d.name}` : `${other ? `${other}: ` : ''}New reply: ${d.name}`, { body: d.reason || d.preview || '' }); } catch { /* ignore */ }
}
export function onEvent(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }

// ---------- layout ----------
const ICONS = {
  dashboard: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  inbox: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12h-5l-2 3h-4l-2-3H3"/><path d="M5 5h14l2 7v7H3v-7z"/></svg>',
  leads: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 14.5c3 0 5.5 2 5.5 5"/></svg>',
  review: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2l.9-5.5-4-3.9L9.5 8z"/></svg>',
  settings: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
const NAV = [['dashboard', 'Dashboard'], ['inbox', 'Inbox'], ['leads', 'Leads'], ['review', 'AI Review'], ['settings', 'Settings']];

export function shell(contentHtml, { title = '', actions = '' } = {}) {
  const u = state.user;
  const firm = currentFirm();
  const switcher = state.firms.length > 1
    ? `<label class="firm-switch"><span class="lbl">Firm</span><select data-action="firm" aria-label="Firm">${state.firms.map(f => `<option value="${f.id}" ${f.id === firm?.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>`
    : '';
  return `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><div class="logo">${esc((firm?.name || 'N').trim().charAt(0).toUpperCase())}</div><div><div class="name">${esc(state.boot?.app_name || 'LeadDesk')}</div><div class="sub">${esc(firm?.name || state.boot?.company_name || '')}</div></div></div>
      ${switcher}
      <nav class="nav">${NAV.map(([k, l]) => `<a href="#/${k}" class="${state.route.view === k ? 'active' : ''}">${ICONS[k]}<span class="t">${l}</span>${k === 'inbox' && state.alerts ? `<span class="badge red">${state.alerts}</span>` : ''}</a>`).join('')}</nav>
      <div class="spacer"></div>
      <div class="userbox"><div class="avatar">${esc(initials(u?.name))}</div><div class="info"><div>${esc(u?.name || '')}</div><div class="role">${esc(u?.role || '')}</div></div><button title="Sign out" data-action="logout">⎋</button></div>
    </aside>
    <div class="main">
      ${title ? `<div class="topbar"><h1>${title}</h1><div class="row">${actions}</div></div>` : ''}
      ${contentHtml}
    </div></div>`;
}

let renderer = null;
export function setRenderer(fn) { renderer = fn; }
export function renderApp() { renderer?.(); }
