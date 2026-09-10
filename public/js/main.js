import { api, state, shell, setRenderer, parseRoute, connectEvents, toast, onEvent } from './core.js';
import { renderAuth } from './auth.js';
import { renderDashboard } from './dashboard.js';
import { renderInbox } from './inbox.js';
import { renderLeads } from './leads.js';
import { renderReview } from './review.js';
import { renderSettings } from './settings.js';

const root = document.getElementById('app');
const TITLES = { dashboard: 'Dashboard', inbox: 'Inbox', leads: 'Leads', review: 'AI Review', settings: 'Settings' };
const VIEWS = { dashboard: renderDashboard, inbox: renderInbox, leads: renderLeads, review: renderReview, settings: renderSettings };
let cleanup = null;

async function render() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  if (!state.user) { renderAuth(root, { needsSetup: state.boot?.needsSetup }, boot); return; }
  state.route = parseRoute();
  if (!VIEWS[state.route.view]) { location.hash = '#/dashboard'; return; }
  root.innerHTML = shell('<div id="view" class="content-wrap" style="display:contents"></div>', { title: TITLES[state.route.view] });
  const el = root.querySelector('#view');
  try { cleanup = await VIEWS[state.route.view](el, state.route); } catch (e) { console.error(e); el.innerHTML = `<div class="content"><div class="notice bad">${e.message}</div></div>`; }
}

async function boot() {
  try {
    state.boot = await api('/bootstrap');
    state.user = state.boot.user;
    if (state.user) { state.users = (await api('/users')).users; connectEvents(); }
  } catch (e) { root.innerHTML = `<div class="boot">Could not reach the server: ${e.message}</div>`; return; }
  render();
}

root.addEventListener('click', async (e) => {
  if (e.target.closest('[data-action=logout]')) { await api('/logout', { method: 'POST' }).catch(() => {}); state.user = null; state.sse?.close(); state.sse = null; location.hash = ''; render(); }
});
window.addEventListener('hashchange', render);
setRenderer(render);
onEvent((type, d) => { if (type === 'alert' && state.route.view !== 'inbox') { state.alerts++; const b = document.querySelector('.nav a[href="#/inbox"]'); if (b && !b.querySelector('.badge')) b.insertAdjacentHTML('beforeend', `<span class="badge red">${state.alerts}</span>`); else if (b) b.querySelector('.badge').textContent = state.alerts; } if (state.route.view === 'inbox') state.alerts = 0; });
boot();
