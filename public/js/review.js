import { api, esc, statusPill, modePill, fmtTime, isWriter, toast, askText, onEvent, debounce } from './core.js';

const TABS = [['unreviewed', 'To review'], ['flagged', 'Flagged'], ['good', 'Approved'], ['all', 'All AI replies']];

export async function renderReview(el, route) {
  const view = { filter: TABS.some(t => t[0] === route.tab) ? route.tab : 'unreviewed', rows: [], counts: {} };
  el.innerHTML = `<div class="content"><div class="tabs" id="tabs"></div><div id="list"></div></div>`;
  const $ = (s) => el.querySelector(s);
  async function load() {
    try { const r = await api(`/review?filter=${view.filter}&limit=100`); view.rows = r.rows; view.counts = r.counts; } catch (e) { toast(e.message, 'error'); return; }
    draw();
  }
  function draw() {
    $('#tabs').innerHTML = TABS.map(([k, l]) => `<button class="${view.filter === k ? 'active' : ''}" data-tab="${k}">${l}<span class="cnt">${view.counts[k] ?? 0}</span></button>`).join('');
    const w = isWriter();
    $('#list').innerHTML = view.rows.length ? view.rows.map(m => `<div class="card mb16" data-mid="${m.id}"><div class="card-h">
        <div class="row wrap"><a href="#/inbox/${m.lead_id}"><b>${esc(m.full_name || m.wa_number)}</b></a><span class="muted small">${esc(m.wa_number)}</span>${statusPill(m.lead_status)}${modePill(m.mode)}<span class="tiny faint">${fmtTime(m.created_at)}</span></div>
        <div class="row">${m.review ? `<span class="pill ${m.review === 'bad' ? 'bad' : 'ok'}">${m.review === 'bad' ? 'flagged' : 'approved'}${m.reviewer_name ? ` by ${esc(m.reviewer_name)}` : ''}</span>` : ''}
          ${w ? `<button class="btn sm ${m.review === 'good' ? 'success' : ''}" data-review="good">👍 Good</button><button class="btn sm ${m.review === 'bad' ? 'danger' : ''}" data-review="bad">👎 Flag</button>` : ''}<a class="btn sm" href="#/inbox/${m.lead_id}">Open chat</a></div></div>
      <div class="card-b rv-card">
        <div><div class="lbl">Lead wrote</div><div class="bubble in">${esc(m.inbound_body || '(non-text message)')}</div></div>
        <div><div class="lbl">AI replied ${m.meta.latency_ms ? `<span class="faint">· ${(m.meta.latency_ms / 1000).toFixed(1)}s · ${esc(m.meta.model || '')}</span>` : ''}</div><div class="bubble ai">${esc(m.body)}</div>
          <div class="chips mt8">${m.meta.intent ? `<span class="pill">intent: ${esc(m.meta.intent)}</span>` : ''}${m.meta.sentiment ? `<span class="pill ${m.meta.sentiment === 'negative' ? 'bad' : m.meta.sentiment === 'positive' ? 'ok' : ''}">${esc(m.meta.sentiment)}</span>` : ''}${m.meta.language && m.meta.language !== 'en' ? `<span class="pill info">${esc(m.meta.language)}</span>` : ''}${m.meta.qualified ? `<span class="pill ok">qualified</span>` : ''}${m.meta.handoff ? `<span class="pill warn">hand-off: ${esc(m.meta.handoff_reason || '')}</span>` : ''}${m.meta.corridor ? `<span class="pill">${esc(m.meta.corridor)}</span>` : ''}${m.meta.budget ? `<span class="pill">${esc(m.meta.budget)}</span>` : ''}${m.meta.fallback ? `<span class="pill bad">fallback after AI error</span>` : ''}${m.status === 'failed' ? `<span class="pill bad">delivery failed</span>` : ''}</div>
          ${m.review_note ? `<div class="notice warn small mt8">Note: ${esc(m.review_note)}</div>` : ''}</div>
      </div></div>`).join('') : `<div class="empty"><h3>Nothing here</h3>${view.filter === 'unreviewed' ? 'Every AI reply lands here until someone marks it good or flags it.' : 'No replies in this list yet.'}</div>`;
  }
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab]'); if (t) { view.filter = t.dataset.tab; history.replaceState(null, '', `#/review/${view.filter}`); return load(); }
    const b = e.target.closest('[data-review]'); if (!b) return;
    const card = b.closest('[data-mid]'); const mid = Number(card.dataset.mid); const row = view.rows.find(r => r.id === mid);
    const review = row?.review === b.dataset.review ? null : b.dataset.review;
    let note = row?.review_note || '';
    if (review === 'bad') { const n = await askText('Flag this AI reply', 'What was wrong? (optional — helps tune the AI prompt)', note, { okLabel: 'Flag reply' }); if (n === null) return; note = n; }
    try { await api(`/messages/${mid}/review`, { method: 'POST', body: { review, note } }); load(); } catch (ex) { toast(ex.message, 'error'); }
  });
  await load();
  const unsub = onEvent((type) => { if (type === 'message') debounce(load, 1500)(); });
  return () => unsub();
}
