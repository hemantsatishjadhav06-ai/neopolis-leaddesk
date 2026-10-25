import { api, esc, state, statusPill, modePill, ago, fmtTime, userName, STATUS_LABEL, onEvent, debounce } from './core.js';

export async function renderDashboard(el) {
  el.innerHTML = `<div class="content"><div class="muted">Loading…</div></div>`;
  let unsub = null;
  const load = async () => {
    let d; try { d = await api('/stats'); } catch (e) { el.innerHTML = `<div class="content"><div class="notice bad">${esc(e.message)}</div></div>`; return; }
    const s = d.stats;
    const funnel = [['Leads', s.total], ['Contacted', s.contacted], ['Replied', s.replied], ['Prospects', s.prospects], ['In sales', s.inSales], ['Won', s.won]];
    const max = Math.max(1, ...funnel.map(f => f[1]));
    const wa = d.followups; const sheet = d.sheet;
    const sysline = (label, ok, text) => `<div class="status-line"><span class="lbl2">${label}</span><span class="dot ${ok === true ? 'g' : ok === false ? 'r' : 'a'}"></span><span>${text}</span></div>`;
    el.innerHTML = `<div class="content">
      <div class="grid c4 mb16">
        ${kpi('Total leads', s.total, `${s.byStatus.CREATED || 0} new · ${s.byStatus.NO_RESPONSE || 0} no response`)}
        ${kpi('Replied', s.replied, `${s.inToday} inbound in last 24h`)}
        ${kpi('Prospects (qualified)', s.prospects, `${s.unassignedProspects} waiting for a salesperson`)}
        ${kpi('In sales / won', `${s.inSales} / ${s.won}`, `${s.byStatus.VISIT_BOOKED || 0} visits booked`)}
      </div>
      <div class="grid c4 mb16">
        ${kpi('AI replies (24h)', s.aiToday, s.avgAiLatencyMs ? `avg ${(s.avgAiLatencyMs / 1000).toFixed(1)}s response` : 'no replies yet')}
        ${kpi('AI flagged', s.flagged, `${s.reviewed} of ${s.aiTotal} reviewed`)}
        ${kpi('Waiting for human', s.humanUnread, 'unread chats in human mode')}
        ${kpi('Failed sends (24h)', s.failed, s.failed ? 'check WhatsApp status' : 'all good')}
      </div>
      <div class="grid c3 mb16">
        <div class="card" style="grid-column:span 2"><div class="card-h"><h2>Pipeline</h2><a href="#/leads" class="small">Open leads →</a></div><div class="card-b">
          <div class="funnel">${funnel.map(([l, v]) => `<div class="bar"><b>${v}</b><i style="height:${Math.max(4, Math.round(v / max * 80))}px"></i><span>${l}</span></div>`).join('')}</div>
          <div class="chips mt16">${Object.keys(STATUS_LABEL).map(k => `<a class="chip" href="#/leads/${k}">${STATUS_LABEL[k]}<span class="cnt">${s.byStatus[k] || 0}</span></a>`).join('')}</div>
        </div></div>
        <div class="card"><div class="card-h"><h2>System</h2><a href="#/settings/whatsapp" class="small">Settings →</a></div><div class="card-b">
          ${sysline('Brain', true, (state.boot?.brain || 'leaddesk') === 'n8n' ? 'n8n workflows (AI replies + journey)' : 'LeadDesk (built-in AI + journey)')}
          ${sysline('WhatsApp', wa.whatsappConfigured, wa.whatsappConfigured ? 'connected' : 'not configured')}
          ${sysline('Webhook', d.webhook.lastEventAt ? true : (d.webhook.verifiedAt ? null : false), d.webhook.lastEventAt ? `last event ${ago(d.webhook.lastEventAt)}` : d.webhook.verifiedAt ? `verified ${ago(d.webhook.verifiedAt)}, no events yet` : 'not verified yet')}
          ${sysline('Google Sheet', sheet.provider === 'none' ? false : (sheet.lastError && (!sheet.lastWrite || sheet.lastError.at > sheet.lastWrite) ? null : true), sheet.provider === 'none' ? 'not connected' : `${sheet.lastImport ? `imported ${ago(sheet.lastImport.at)} (${sheet.lastImport.rows} rows)` : 'no import yet'}${sheet.pending ? ` · ${sheet.pending} writes pending` : ''}`)}
          ${sysline('AI replies', wa.replyMode === 'live' ? true : wa.replyMode === 'test' ? null : false, wa.replyMode === 'live' ? 'replying to everyone' : wa.replyMode === 'test' ? 'TEST — only test numbers get a reply' : 'OFF — nobody gets a reply')}
          ${sysline('Follow-ups', wa.sendMode === 'live' ? true : wa.sendMode === 'test' ? null : false, `${wa.sendMode.toUpperCase()} mode · ${wa.due} due${wa.inWindow ? '' : ' · outside send window'}`)}
          ${wa.replyMode && wa.replyMode !== 'live' ? `<div class="notice warn small mt8"><b>Replies are not live.</b> ${wa.replyMode === 'off' ? 'Nobody who messages you gets a reply.' : 'Only your test numbers get a reply — real customers get nothing.'} <a href="#/settings/outreach">Change reply mode →</a></div>` : ''}
          ${sheet.lastError ? `<div class="notice bad small mt8">Sheet error ${ago(sheet.lastError.at)}: ${esc(sheet.lastError.error)}</div>` : ''}
        </div></div>
      </div>
      <div class="grid c3">
        <div class="card"><div class="card-h"><h2>Needs attention</h2></div><div class="card-b">
          ${d.attention.unassignedProspects.length ? `<div class="lbl">Prospects waiting for sales</div>${d.attention.unassignedProspects.map(l => `<div class="list-item row between"><div><a href="#/inbox/${l.id}"><b>${esc(l.full_name || l.wa_number)}</b></a><div class="small muted">${esc(l.handoff_reason || '')}</div></div>${statusPill(l.status)}</div>`).join('')}` : ''}
          ${d.attention.humanUnread.length ? `<div class="lbl mt8">Unread in human mode</div>${d.attention.humanUnread.map(l => `<div class="list-item row between"><div><a href="#/inbox/${l.id}"><b>${esc(l.full_name || l.wa_number)}</b></a><div class="small muted">${esc(l.last_message_preview)}</div></div><span class="badge red">${l.unread_count}</span></div>`).join('')}` : ''}
          ${d.attention.failed.length ? `<div class="lbl mt8">Failed messages</div>${d.attention.failed.map(m => `<div class="list-item"><a href="#/inbox/${m.lead_id}"><b>${esc(m.full_name || m.wa_number)}</b></a><div class="small" style="color:var(--red)">${esc(m.error || 'failed')}</div></div>`).join('')}` : ''}
          ${!d.attention.unassignedProspects.length && !d.attention.humanUnread.length && !d.attention.failed.length ? `<div class="empty"><h3>All clear</h3>Nothing is waiting on a human right now.</div>` : ''}
        </div></div>
        <div class="card"><div class="card-h"><h2>Latest AI replies</h2><a href="#/review" class="small">Review →</a></div><div class="card-b">
          ${d.recentAi.length ? d.recentAi.map(m => `<div class="list-item"><div class="row between"><a href="#/inbox/${m.lead_id}"><b>${esc(m.full_name || m.wa_number)}</b></a><span class="tiny faint">${fmtTime(m.created_at)}</span></div><div class="small muted" style="white-space:pre-wrap">${esc(m.body.slice(0, 160))}${m.body.length > 160 ? '…' : ''}</div><div class="row mt8">${m.meta.intent ? `<span class="pill">${esc(m.meta.intent)}</span>` : ''}${m.meta.handoff ? `<span class="pill warn">hand-off</span>` : ''}${m.review ? `<span class="pill ${m.review === 'bad' ? 'bad' : 'ok'}">${esc(m.review)}</span>` : ''}</div></div>`).join('') : `<div class="empty">No AI replies yet.</div>`}
        </div></div>
        <div class="card"><div class="card-h"><h2>Activity</h2></div><div class="card-b">
          ${d.activity.length ? d.activity.map(a => `<div class="act"><span class="t">${fmtTime(a.created_at)}</span> · ${esc(describe(a))}</div>`).join('') : `<div class="empty">No activity yet.</div>`}
        </div></div>
      </div>
    </div>`;
  };
  await load();
  const refresh = debounce(load, 1500);
  unsub = onEvent(() => refresh());
  return () => unsub?.();
}
const kpi = (label, value, hint) => `<div class="card kpi"><div class="label">${label}</div><div class="value">${value ?? 0}</div><div class="hint">${hint || ''}</div></div>`;

export function describe(a) {
  const who = a.user_name ? a.user_name : (a.type.endsWith('.ai') || a.type.startsWith('followup') || a.type.startsWith('sheet') ? 'System' : 'System');
  const lead = a.full_name || a.wa_number || '';
  const d = a.data || {};
  switch (a.type) {
    case 'lead.created': return `${lead} added (${d.source || 'sheet'})`;
    case 'lead.status': return `${lead}: ${STATUS_LABEL[d.from] || d.from || '—'} → ${STATUS_LABEL[d.to] || d.to}${d.reason ? ` (${d.reason})` : ''}`;
    case 'lead.handoff.ai': return `AI handed ${lead} to sales — ${d.reason || ''}`;
    case 'lead.handoff': return `${who} handed ${lead} to sales`;
    case 'lead.takeover': return `${who} took over ${lead}`;
    case 'lead.handback': return `${who} handed ${lead} back to the AI`;
    case 'lead.assign': return `${who} assigned ${lead} to ${userName(d.assigneeId) || 'nobody'}`;
    case 'lead.optout': return `${lead} opted out`;
    case 'lead.edit': return `${who} edited ${lead}`;
    case 'lead.bulk': return `${who} bulk ${d.action} on ${d.count} leads`;
    case 'message.human': return `${who} replied to ${lead}`;
    case 'message.template.human': return `${who} sent template ${d.name} to ${lead}`;
    case 'followup.sent': return `Journey day ${d.day ?? d.stage} (${d.template}) sent to ${lead}`;
    case 'followup.failed': return `Follow-up to ${lead} ${d.undelivered ? 'was not delivered' : 'failed'}: ${d.error}`;
    case 'followup.stopped': return `Journey stopped for ${lead}: ${d.error || d.reason}`;
    case 'lead.paused': return `${lead} imported paused (sheet note: ${d.note})`;
    case 'ai.review': return `${who} marked an AI reply to ${lead} as ${d.review || 'unreviewed'}`;
    case 'ai.error': return `AI error for ${lead}: ${d.error}`;
    case 'sheet.import': return `Sheet import: +${d.created} new, ${d.updated} updated, ${d.invalid} invalid`;
    case 'templates.submit': return `${who} submitted journey templates to Meta`;
    case 'settings.update': return `${who} changed settings: ${(d.changed || []).join(', ')}`;
    default: return `${a.type} ${lead}`;
  }
}
