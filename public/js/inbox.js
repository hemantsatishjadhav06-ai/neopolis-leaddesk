import { api, esc, state, statusPill, modePill, initials, fmtTime, fmtDay, ago, untilText, userName, isWriter, STATUSES, STATUS_LABEL, toast, modal, askText, onEvent, debounce } from './core.js?v=2';

const FILTERS = [['all', 'All'], ['human', 'Needs human'], ['prospects', 'Prospects'], ['ai', 'AI handling'], ['mine', 'Mine']];

export async function renderInbox(el, route) {
  const view = { filter: sessionStorage.getItem('ld.inbox.filter') || 'all', q: '', rows: [], selected: route.id || null, detail: null, sending: false };
  el.innerHTML = `<div class="content flush"><div class="inbox">
    <div class="convlist"><div class="filters"><input type="search" id="q" placeholder="Search name or number"><div class="chips" id="chips"></div></div><div class="items" id="items"></div></div>
    <div class="chat" id="chat"></div>
    <div class="leadpane" id="pane"></div>
  </div></div>`;
  const $ = (s) => el.querySelector(s);

  const listParams = () => {
    const p = new URLSearchParams({ limit: 300 });
    if (view.filter === 'human') p.set('mode', 'human');
    if (view.filter === 'ai') p.set('mode', 'ai');
    if (view.filter === 'prospects') p.set('status', 'PROSPECT,IN_SALES,VISIT_BOOKED');
    if (view.filter === 'mine') p.set('assigned', 'me');
    if (view.q) p.set('q', view.q);
    return p.toString();
  };
  async function loadList() {
    try { const r = await api('/leads?' + listParams()); view.rows = r.rows; }
    catch (e) { toast(e.message, 'error'); return; }
    drawList();
  }
  function drawList() {
    $('#chips').innerHTML = FILTERS.map(([k, l]) => `<span class="chip ${view.filter === k ? 'active' : ''}" data-f="${k}">${l}</span>`).join('');
    const rows = view.rows;
    $('#items').innerHTML = rows.length ? rows.map(l => `<div class="conv ${view.selected === l.id ? 'active' : ''}" data-id="${l.id}">
        <div class="avatar">${esc(initials(l.full_name, '#'))}</div>
        <div class="body"><div class="top"><span class="nm ${l.unread_count ? 'unread' : ''}">${esc(l.full_name || l.wa_number)}</span><span class="tm">${fmtTime(l.last_message_at || l.created_at)}</span></div>
        <div class="pv ${l.unread_count ? 'unread' : ''}">${esc(l.last_message_preview || (l.status === 'CREATED' ? 'No messages yet' : ''))}</div>
        <div class="meta">${modePill(l.mode)}${statusPill(l.status)}${l.unread_count ? `<span class="badge red" style="margin-left:auto">${l.unread_count}</span>` : ''}</div></div></div>`).join('')
      : `<div class="empty">No conversations match.</div>`;
  }

  async function loadConv(id) {
    if (!id) { $('#chat').innerHTML = `<div class="empty" style="margin:auto"><h3>Select a conversation</h3>Every WhatsApp chat — AI and human — shows up here live.</div>`; $('#pane').innerHTML = ''; return; }
    try { view.detail = await api('/leads/' + id); } catch (e) { toast(e.message, 'error'); return; }
    drawChat(); drawPane();
    if (view.detail.lead.unread_count) { api('/leads/' + id + '/read', { method: 'POST' }).catch(() => {}); const r = view.rows.find(x => x.id === id); if (r) { r.unread_count = 0; drawList(); } }
  }

  function drawChat() {
    const { lead, messages, templates } = view.detail;
    const w = lead.window_open;
    const writer = isWriter();
    let last = '';
    const items = messages.map(m => {
      const day = fmtDay(m.created_at); const sep = day !== last ? `<div class="daysep">${day}</div>` : ''; last = day;
      const who = m.direction === 'in' ? '' : m.sender === 'ai' ? 'AI concierge' : m.sender === 'human' ? (userName(m.sender_user_id) || 'Team') : (m.type === 'template' ? 'Automated follow-up' : 'System');
      const tick = m.direction === 'in' ? '' : m.status === 'failed' ? `<span class="tick failed" title="${esc(m.error || '')}">✕ failed</span>` : m.status === 'read' ? `<span class="tick read">✓✓</span>` : m.status === 'delivered' ? `<span class="tick">✓✓</span>` : `<span class="tick">✓</span>`;
      const an = m.sender === 'ai' && m.meta ? `<div class="analysis">${m.meta.intent ? `<span class="pill">${esc(m.meta.intent)}</span>` : ''}${m.meta.sentiment && m.meta.sentiment !== 'neutral' ? `<span class="pill ${m.meta.sentiment === 'negative' ? 'bad' : 'ok'}">${esc(m.meta.sentiment)}</span>` : ''}${m.meta.handoff ? `<span class="pill warn">hand-off: ${esc(m.meta.handoff_reason || '')}</span>` : ''}${m.meta.fallback ? `<span class="pill bad">fallback (AI error)</span>` : ''}${m.meta.latency_ms ? `<span class="pill">${(m.meta.latency_ms / 1000).toFixed(1)}s</span>` : ''}</div>` : '';
      const rv = m.sender === 'ai' && writer ? `<div class="rv"><button class="btn xs ${m.review === 'good' ? 'success' : ''}" data-review="good" data-mid="${m.id}" title="Good reply">👍</button><button class="btn xs ${m.review === 'bad' ? 'danger' : ''}" data-review="bad" data-mid="${m.id}" title="Flag this reply">👎</button>${m.review_note ? `<span class="tiny muted">${esc(m.review_note)}</span>` : ''}</div>` : '';
      const body = m.body || (m.type === 'template' ? `Template: ${m.template_name}` : `[${m.type} message]`);
      return `${sep}<div class="msg ${m.direction} ${m.sender} ${m.type === 'template' ? 'template' : ''} ${m.status === 'failed' ? 'failed' : ''}">${who ? `<div class="who">${esc(who)}${m.type === 'template' ? ` · <span class="tiny muted">template ${esc(m.template_name || '')}</span>` : ''}</div>` : ''}${esc(body)}${an}<div class="ft"><span>${fmtTime(m.created_at)}</span>${tick}</div>${rv}</div>`;
    }).join('');
    const modeBtn = lead.mode === 'ai'
      ? `<button class="btn sm gold" data-act="takeover" title="Stop the AI and reply yourself">Take over</button>`
      : `<button class="btn sm" data-act="handback" title="Let the AI continue this chat">Hand back to AI</button>`;
    $('#chat').innerHTML = `
      <div class="chat-h"><div class="avatar" style="width:36px;height:36px;border-radius:50%;background:#e8ecf3;display:grid;place-items:center;font-weight:700;color:var(--navy)">${esc(initials(lead.full_name, '#'))}</div>
        <div class="grow"><div class="nm">${esc(lead.full_name || 'Unknown')} <span class="muted small">${esc(lead.wa_number)}</span></div>
        <div class="row small">${modePill(lead.mode)}${statusPill(lead.status)}${lead.assigned_to ? `<span class="pill info">${esc(userName(lead.assigned_to))}</span>` : ''}${lead.opted_out ? `<span class="pill bad">opted out</span>` : ''}<span class="muted">${w ? `reply window closes in ${untilText(lead.window_closes_at)}` : lead.last_inbound_at ? 'reply window closed — templates only' : 'no reply yet — templates only'}</span></div></div>
        ${writer ? modeBtn : ''}
      </div>
      <div class="msgs" id="msgs">${items || `<div class="empty">No messages yet.${lead.status === 'CREATED' ? ' The Day-0 follow-up will go out automatically when outreach is on.' : ''}</div>`}</div>
      ${writer ? `<div class="composer">
        ${lead.mode === 'ai' ? `<div class="notice info small mb8">The AI is handling this chat. Sending a message will <b>take it over</b> automatically so you don't talk over each other.</div>` : ''}
        ${w ? `<textarea id="reply" placeholder="Type a reply… (Enter to send, Shift+Enter for a new line)"></textarea>
          <div class="bar"><span class="tiny muted">Sending as ${esc(state.user.name)} from the business number</span><div class="row"><button class="btn sm" data-act="template">Send template</button><button class="btn sm primary" data-act="send">Send</button></div></div>`
        : `<div class="row between wrap"><div class="small muted">WhatsApp only allows free-text replies within 24 hours of the customer's last message. Send an approved template to re-open the conversation.</div><button class="btn sm primary" data-act="template">Send template</button></div>`}
      </div>` : ''}`;
    const box = $('#msgs'); box.scrollTop = box.scrollHeight;
  }

  function drawPane() {
    const { lead, history } = view.detail;
    const writer = isWriter();
    const raw = lead.raw_fields || {};
    const fld = (k, label, type = 'text') => `<div class="field-row"><label class="field">${label}</label><input type="${type}" data-field="${k}" value="${esc(lead[k] || '')}" ${writer ? '' : 'disabled'}></div>`;
    $('#pane').innerHTML = `
      <section><h3>Lead</h3>
        <div class="field-row"><label class="field">Status</label><select data-field="status" ${writer ? '' : 'disabled'}>${STATUSES.map(s => `<option value="${s}" ${lead.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></div>
        <div class="field-row"><label class="field">Assigned to</label><select data-field="assigned_to" ${writer ? '' : 'disabled'}><option value="">— unassigned —</option>${state.users.filter(u => u.active).map(u => `<option value="${u.id}" ${lead.assigned_to === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
        ${fld('full_name', 'Name')}${fld('email', 'Email', 'email')}
        <label class="switch"><input type="checkbox" data-field="outreach_paused" ${lead.outreach_paused ? 'checked' : ''} ${writer ? '' : 'disabled'}> Pause automated follow-ups</label>
        ${lead.qualified ? `<div class="notice ok small mt8"><b>Qualified</b> ${lead.qualified_at ? ago(lead.qualified_at) : ''}${lead.handoff_reason ? ` — ${esc(lead.handoff_reason)}` : ''}</div>` : ''}
        ${lead.last_error ? `<div class="notice bad small mt8">${esc(lead.last_error)}</div>` : ''}
      </section>
      <section><h3>Requirements</h3>
        ${fld('corridor', 'Corridor')}${fld('budget', 'Budget')}${fld('timeline', 'Timeline')}${fld('configuration', 'Configuration')}${fld('funding', 'Funding')}${fld('objective', 'Objective')}
      </section>
      <section><h3>Notes</h3><textarea data-field="notes" placeholder="Internal notes for the team" ${writer ? '' : 'disabled'}>${esc(lead.notes || '')}</textarea></section>
      ${Object.keys(raw).length ? `<section><h3>Ad form answers</h3><div class="kv small">${Object.entries(raw).map(([k, v]) => `<div class="k">${esc(k.replace(/_/g, ' ').slice(0, 40))}</div><div>${esc(String(v).replace(/_/g, ' '))}</div>`).join('')}</div></section>` : ''}
      <section><h3>Details</h3><div class="kv small"><div class="k">Source</div><div>${esc(lead.source)}${lead.sheet_row ? ` · sheet row ${lead.sheet_row}` : ''}</div><div class="k">Created</div><div>${fmtTime(lead.created_at)}</div><div class="k">Last inbound</div><div>${lead.last_inbound_at ? fmtTime(lead.last_inbound_at) : '—'}</div><div class="k">Follow-ups</div><div>${lead.followup_stage} of 3 sent</div><div class="k">Language</div><div>${esc(lead.language || 'en')}</div></div></section>
      <section><h3>History</h3>${history.slice(0, 15).map(h => `<div class="act"><span class="t">${fmtTime(h.created_at)}</span> ${esc(h.type.replace(/\./g, ' '))}${h.user_name ? ` · ${esc(h.user_name)}` : ''}${h.data?.reason ? ` · ${esc(h.data.reason)}` : ''}${h.data?.to ? ` → ${esc(STATUS_LABEL[h.data.to] || h.data.to)}` : ''}</div>`).join('') || '<div class="small muted">Nothing yet.</div>'}</section>`;
  }

  // ---------- actions ----------
  async function saveField(field, value) {
    const id = view.selected; if (!id) return;
    try {
      if (field === 'assigned_to') await api(`/leads/${id}/assign`, { method: 'POST', body: { user_id: value || null } });
      else if (field === 'status') await api(`/leads/${id}/status`, { method: 'POST', body: { status: value } });
      else await api(`/leads/${id}`, { method: 'PATCH', body: { [field]: value } });
      toast('Saved', 'success', { timeout: 1200 });
      await loadConv(id); loadList();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function send() {
    const ta = $('#reply'); const text = ta?.value.trim(); if (!text || view.sending) return;
    view.sending = true; const btn = $('[data-act=send]'); if (btn) btn.disabled = true;
    try {
      const lead = view.detail.lead;
      if (lead.mode === 'ai') await api(`/leads/${lead.id}/takeover`, { method: 'POST' });
      await api(`/leads/${lead.id}/messages`, { method: 'POST', body: { text } });
      ta.value = ''; await loadConv(lead.id); loadList();
    } catch (e) { toast(e.message, 'error'); }
    finally { view.sending = false; }
  }
  function pickTemplate() {
    const { lead, templates } = view.detail;
    if (!templates.length) return toast('No templates configured — see Settings → Outreach', 'error');
    modal({ title: 'Send an approved template', body: `<div class="help mb8">Templates must be approved by Meta before they can be delivered. The lead's first name fills {{1}}.</div>${templates.map(t => `<label class="card" style="display:block;padding:10px;margin-bottom:8px;cursor:pointer"><div class="row"><input type="radio" name="tpl" value="${t.key}" style="width:auto"> <b>${esc(t.name)}</b></div><div class="small muted mt8" style="white-space:pre-wrap">${esc(t.text)}</div></label>`).join('')}`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Send template</button>`,
      onOpen: (bg, close) => { bg.querySelector('[data-ok]').onclick = async () => { const key = bg.querySelector('input[name=tpl]:checked')?.value; if (!key) return; try { if (lead.mode === 'ai') await api(`/leads/${lead.id}/takeover`, { method: 'POST' }); await api(`/leads/${lead.id}/template`, { method: 'POST', body: { key } }); toast('Template sent', 'success'); close(); await loadConv(lead.id); loadList(); } catch (e) { toast(e.message, 'error'); } }; } });
  }

  el.addEventListener('click', async (e) => {
    const chip = e.target.closest('.chip[data-f]'); if (chip) { view.filter = chip.dataset.f; sessionStorage.setItem('ld.inbox.filter', view.filter); return loadList(); }
    const conv = e.target.closest('.conv[data-id]'); if (conv) { view.selected = Number(conv.dataset.id); history.replaceState(null, '', `#/inbox/${view.selected}`); drawList(); return loadConv(view.selected); }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'send') return send();
    if (act === 'template') return pickTemplate();
    if (act === 'takeover' || act === 'handback') { try { await api(`/leads/${view.selected}/${act}`, { method: 'POST' }); toast(act === 'takeover' ? 'You have taken over this chat — the AI is paused.' : 'The AI is handling this chat again.', 'success'); await loadConv(view.selected); loadList(); } catch (ex) { toast(ex.message, 'error'); } return; }
    const rv = e.target.closest('[data-review]');
    if (rv) {
      const mid = Number(rv.dataset.mid); const current = view.detail.messages.find(m => m.id === mid);
      const review = current?.review === rv.dataset.review ? null : rv.dataset.review;
      let note = current?.review_note || '';
      if (review === 'bad') { const n = await askText('Flag this AI reply', 'What was wrong? (optional — helps tune the AI prompt)', note, { okLabel: 'Flag reply' }); if (n === null) return; note = n; }
      try { await api(`/messages/${mid}/review`, { method: 'POST', body: { review, note } }); await loadConv(view.selected); } catch (ex) { toast(ex.message, 'error'); }
    }
  });
  el.addEventListener('change', (e) => {
    const f = e.target.closest('[data-field]'); if (!f) return;
    const val = f.type === 'checkbox' ? f.checked : f.value;
    saveField(f.dataset.field, val);
  });
  el.addEventListener('keydown', (e) => { if (e.target.id === 'reply' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  $('#q').addEventListener('input', debounce((e) => { view.q = e.target.value.trim(); loadList(); }, 250));

  await loadList();
  await loadConv(view.selected);
  const refreshList = debounce(loadList, 800);
  const unsub = onEvent((type, d) => {
    if (type === 'lead') { refreshList(); if (d.id === view.selected) loadConv(view.selected); }
    if (type === 'message') { refreshList(); if (d.lead_id === view.selected) loadConv(view.selected); }
  });
  return () => unsub();
}
