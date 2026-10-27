import { api, state, shell, setRenderer, parseRoute, connectEvents, toast, onEvent, setFirms, selectFirm } from './core.js?v=2';
import { renderAuth } from './auth.js?v=2';
import { renderDashboard } from './dashboard.js?v=2';
import { renderInbox } from './inbox.js?v=2';
import { renderLeads } from './leads.js?v=2';
import { renderReview } from './review.js?v=2';
import { renderSettings } from './settings.js?v=2';

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
    setFirms(state.boot.firms);
    if (state.user) { state.users = (await api('/users')).users; if (!state.firms.length) setFirms((await api('/firms')).firms.filter(f => f.active)); connectEvents(); }
  } catch (e) { root.innerHTML = `<div class="boot">Could not reach the server: ${e.message}</div>`; return; }
  render();
}

root.addEventListener('click', async (e) => {
  if (e.target.closest('[data-action=logout]')) { await api('/logout', { method: 'POST' }).catch(() => {}); state.user = null; state.sse?.close(); state.sse = null; location.hash = ''; render(); }
});
// Switching firm re-renders the current screen for the new firm (a single chat goes back to the inbox list).
root.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-action=firm]');
  if (!sel || !selectFirm(sel.value)) return;
  state.alerts = 0;
  if (state.route.view === 'inbox' && state.route.id) location.hash = '#/inbox'; else render();
});
// A toast about another firm's lead switches to that firm before opening the chat.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-firm]');
  if (a && Number(a.dataset.firm) && Number(a.dataset.firm) !== state.firmId) selectFirm(a.dataset.firm);
}, true);
// Settings → Firms changed the list (a firm added or renamed): refresh it everywhere.
async function reloadFirms() { setFirms((await api('/firms')).firms.filter(f => f.active)); render(); }
window.addEventListener('ld:firms-changed', () => { reloadFirms().catch(() => {}); });
window.addEventListener('hashchange', render);
setRenderer(render);
onEvent((type, d) => { if (type === 'alert' && state.route.view !== 'inbox') { state.alerts++; const b = document.querySelector('.nav a[href="#/inbox"]'); if (b && !b.querySelector('.badge')) b.insertAdjacentHTML('beforeend', `<span class="badge red">${state.alerts}</span>`); else if (b) b.querySelector('.badge').textContent = state.alerts; } if (state.route.view === 'inbox') state.alerts = 0; });
boot();
