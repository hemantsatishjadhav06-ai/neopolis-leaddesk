import { api, esc, state, statusPill, modePill, fmtTime, userName, isWriter, STATUSES, STATUS_LABEL, toast, modal, onEvent, debounce } from './core.js';

export async function renderLeads(el, route) {
  const view = { status: route.tab && STATUSES.includes(route.tab) ? route.tab : '', mode: '', assigned: '', q: '', sort: 'last_message_at', rows: [], total: 0, selected: new Set() };
  el.innerHTML = `<div class="content">
    <div class="card"><div class="card-h" style="flex-wrap:wrap;gap:10px">
      <div class="row wrap grow">
        <input type="search" id="q" placeholder="Search name, number, email, corridor" style="width:260px">
        <select id="f-status" style="width:170px"><option value="">All statuses</option>${STATUSES.map(s => `<option value="${s}" ${view.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
        <select id="f-mode" style="width:130px"><option value="">AI + human</option><option value="ai">AI handling</option><option value="human">Human</option></select>
        <select id="f-assigned" style="width:160px"><option value="">Anyone</option><option value="none">Unassigned</option>${state.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
        <select id="f-sort" style="width:150px"><option value="last_message_at">Latest activity</option><option value="created_at">Newest first</option><option value="name">Name</option><option value="status">Status</option></select>
      </div>
      <div class="row"><a class="btn sm" href="/api/export/leads.csv">Export CSV</a>${isWriter() ? `<button class="btn sm primary" data-act="add">+ Add lead</button>` : ''}</div>
    </div>
    <div id="bulk" class="card-h hidden" style="background:#fffbeb"><div class="row wrap"><b id="selcount"></b><button class="btn sm" data-bulk="takeover">Take over</button><button class="btn sm" data-bulk="handback">Hand back to AI</button><button class="btn sm" data-bulk="pause">Pause follow-ups</button><button class="btn sm" data-bulk="resume">Resume follow-ups</button><select id="bulk-assign" style="width:160px"><option value="">Assign to…</option>${state.users.filter(u => u.active).map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select><select id="bulk-status" style="width:160px"><option value="">Set status…</option>${STATUSES.map(s => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join('')}</select></div><button class="btn sm ghost" data-bulk="clear">Clear</button></div>
    <div style="overflow:auto;max-height:calc(100vh - 190px)"><table class="tbl" id="tbl"></table></div>
    <div class="card-b small muted" id="foot"></div></div></div>`;
  const $ = (s) => el.querySelector(s);

  async function load() {
    const p = new URLSearchParams({ limit: 500, sort: view.sort });
    if (view.status) p.set('status', view.status); if (view.mode) p.set('mode', view.mode); if (view.assigned) p.set('assigned', view.assigned); if (view.q) p.set('q', view.q);
    try { const r = await api('/leads?' + p); view.rows = r.rows; view.total = r.total; } catch (e) { toast(e.message, 'error'); return; }
    draw();
  }
  function draw() {
    const w = isWriter();
    $('#tbl').innerHTML = `<thead><tr>${w ? '<th style="width:28px"><input type="checkbox" id="selall" style="width:auto"></th>' : ''}<th>Lead</th><th>Status</th><th>Mode</th><th>Assigned</th><th>Corridor</th><th>Budget</th><th>Timeline</th><th>Last message</th><th>Follow-ups</th><th>Source</th></tr></thead>
      <tbody>${view.rows.map(l => `<tr class="${view.selected.has(l.id) ? 'sel' : ''}" data-id="${l.id}">
        ${w ? `<td><input type="checkbox" class="selrow" data-id="${l.id}" ${view.selected.has(l.id) ? 'checked' : ''} style="width:auto"></td>` : ''}
        <td><a href="#/inbox/${l.id}"><b>${esc(l.full_name || '—')}</b></a><div class="small muted">${esc(l.wa_number)}${l.email ? ` · ${esc(l.email)}` : ''}</div></td>
        <td>${statusPill(l.status)}${l.qualified ? ' <span class="pill ok" title="Qualified">✓</span>' : ''}${l.opted_out ? ' <span class="pill bad">opt-out</span>' : ''}</td>
        <td>${modePill(l.mode)}</td><td class="small">${esc(userName(l.assigned_to) || '—')}</td>
        <td class="small">${esc(l.corridor || '—')}</td><td class="small">${esc(l.budget || '—')}</td><td class="small">${esc(l.timeline || '—')}</td>
        <td class="small" style="max-width:260px"><div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(l.last_message_preview || '—')}</div><div class="tiny faint">${l.last_message_at ? fmtTime(l.last_message_at) : ''}${l.unread_count ? ` · <b style="color:var(--red)">${l.unread_count} unread</b>` : ''}</div></td>
        <td class="small">${l.followup_stage}/3${l.outreach_paused ? ' <span class="pill warn">paused</span>' : ''}${l.last_error ? ` <span class="pill bad" title="${esc(l.last_error)}">error</span>` : ''}</td>
        <td class="small muted">${esc(l.source)}${l.sheet_row ? ` · row ${l.sheet_row}` : ''}</td></tr>`).join('')}</tbody>`;
    $('#foot').textContent = `${view.rows.length} of ${view.total} leads`;
    const bulk = $('#bulk'); bulk.classList.toggle('hidden', !view.selected.size); $('#selcount').textContent = `${view.selected.size} selected`;
    if (!view.rows.length) $('#tbl').innerHTML += `<tbody><tr><td colspan="11"><div class="empty"><h3>No leads match</h3>Leads arrive automatically from your Google Sheet (Settings → Google Sheet).</div></td></tr></tbody>`;
  }
  async function bulk(action, extra = {}) {
    if (!view.selected.size) return;
    try { const r = await api('/leads/bulk', { method: 'POST', body: { ids: [...view.selected], action, ...extra } }); toast(`Applied to ${r.count} leads`, 'success'); view.selected.clear(); load(); } catch (e) { toast(e.message, 'error'); }
  }
  function addLead() {
    modal({ title: 'Add a lead manually', body: `<div class="field-row"><label class="field">WhatsApp number</label><input type="text" id="nl-num" placeholder="+91 98765 43210"></div><div class="field-row"><label class="field">Full name</label><input type="text" id="nl-name"></div><div class="field-row"><label class="field">Email (optional)</label><input type="email" id="nl-email"></div><div class="help">The lead enters the normal flow: automated Day-0 outreach (when outreach is on) and AI replies.</div>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Add lead</button>`,
      onOpen: (bg, close) => { bg.querySelector('[data-ok]').onclick = async () => { try { const r = await api('/leads', { method: 'POST', body: { wa_number: bg.querySelector('#nl-num').value, full_name: bg.querySelector('#nl-name').value, email: bg.querySelector('#nl-email').value } }); toast('Lead added', 'success'); close(); location.hash = `#/inbox/${r.lead.id}`; } catch (e) { toast(e.message, 'error'); } }; } });
  }

  el.addEventListener('change', (e) => {
    if (e.target.id === 'f-status') { view.status = e.target.value; load(); }
    else if (e.target.id === 'f-mode') { view.mode = e.target.value; load(); }
    else if (e.target.id === 'f-assigned') { view.assigned = e.target.value; load(); }
    else if (e.target.id === 'f-sort') { view.sort = e.target.value; load(); }
    else if (e.target.id === 'selall') { view.selected = e.target.checked ? new Set(view.rows.map(r => r.id)) : new Set(); draw(); }
    else if (e.target.classList.contains('selrow')) { const id = Number(e.target.dataset.id); e.target.checked ? view.selected.add(id) : view.selected.delete(id); draw(); }
    else if (e.target.id === 'bulk-assign' && e.target.value) { bulk('assign', { user_id: Number(e.target.value) }); }
    else if (e.target.id === 'bulk-status' && e.target.value) { bulk('status', { status: e.target.value }); }
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bulk]'); if (b) { if (b.dataset.bulk === 'clear') { view.selected.clear(); draw(); } else bulk(b.dataset.bulk); return; }
    if (e.target.closest('[data-act=add]')) addLead();
  });
  $('#q').addEventListener('input', debounce((e) => { view.q = e.target.value.trim(); load(); }, 250));
  await load();
  const unsub = onEvent(debounce(load, 1500));
  return () => unsub();
}
