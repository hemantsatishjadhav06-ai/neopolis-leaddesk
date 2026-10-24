import { api, esc, state, isAdmin, toast, modal, confirmDialog, ago, fmtTime } from './core.js';

const SECTIONS = [['ai', 'AI concierge'], ['outreach', 'Outreach & follow-ups'], ['whatsapp', 'WhatsApp'], ['sheet', 'Google Sheet'], ['team', 'Team'], ['account', 'My account']];

export async function renderSettings(el, route) {
  const view = { tab: SECTIONS.some(s => s[0] === route.tab) ? route.tab : 'ai', settings: null, defaults: null, config: null, readOnly: !isAdmin() };
  try { const r = await api('/settings'); Object.assign(view, { settings: r.settings, defaults: r.defaults, config: r.config }); } catch (e) { el.innerHTML = `<div class="content"><div class="notice bad">${esc(e.message)}</div></div>`; return; }
  el.innerHTML = `<div class="content"><div class="settings"><div class="snav" id="snav"></div><div class="panel" id="panel"></div></div></div>`;
  const $ = (s) => el.querySelector(s);
  const S = () => view.settings;
  const ro = view.readOnly ? 'disabled' : '';
  const field = (k, label, { type = 'text', help = '', rows = 0, options = null, step = null } = {}) => {
    const v = S()[k];
    let input;
    if (options) input = `<select name="${k}" ${ro}>${options.map(([val, l]) => `<option value="${val}" ${String(v) === String(val) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    else if (type === 'checkbox') input = `<label class="switch"><input type="checkbox" name="${k}" ${v ? 'checked' : ''} ${ro}> ${label}</label>`;
    else if (rows) input = `<textarea name="${k}" rows="${rows}" ${ro}>${esc(v)}</textarea>`;
    else input = `<input type="${type}" name="${k}" value="${esc(v)}" ${step ? `step="${step}"` : ''} ${ro}>`;
    return `<div class="field-row">${type === 'checkbox' ? '' : `<label class="field">${label}</label>`}${input}${help ? `<div class="help">${help}</div>` : ''}</div>`;
  };
  const saveBar = () => view.readOnly ? `<div class="notice info small">Only admins can change settings.</div>` : `<div class="row between mt16"><span class="small muted" id="savemsg"></span><button class="btn primary" data-act="save">Save changes</button></div>`;

  function drawNav() { $('#snav').innerHTML = SECTIONS.map(([k, l]) => `<button class="${view.tab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join(''); }

  async function drawPanel() {
    drawNav();
    const p = $('#panel');
    const brainNote = view.config.brain === 'n8n' ? `<div class="notice info small mb16"><b>n8n is the brain.</b> AI replies and the 13-day journey run in your n8n workflows and are streamed into this inbox. Take-over / hand-back and status changes here are written to the sheet, which n8n obeys. The AI and outreach settings below only apply if you ever switch the brain to LeadDesk (BRAIN env var).</div>` : '';
    if (view.tab === 'ai') p.innerHTML = `<form id="sform"><div class="card"><div class="card-h"><h2>AI concierge</h2><button class="btn sm" data-act="ai-test" type="button">Test the AI</button></div><div class="card-b">${brainNote}
        <div class="notice ${view.config.ai.apiKeySet || view.config.ai.provider === 'mock' ? 'ok' : 'warn'} small mb16">${view.config.ai.provider === 'mock' ? 'Running in <b>mock</b> mode (no real AI calls).' : view.config.ai.apiKeySet ? `Connected to ${esc(view.config.ai.provider)}.` : 'No AI key configured — set <code class="inline">OPENROUTER_API_KEY</code> in the environment.'}</div>
        <div class="form-grid">
          <div>${field('ai_enabled', 'AI replies enabled', { type: 'checkbox' })}${field('auto_handoff', 'Automatically hand over to sales when a lead qualifies or asks for a person', { type: 'checkbox' })}${field('mark_read', 'Show blue ticks (mark inbound messages as read)', { type: 'checkbox' })}</div>
          <div>${field('default_mode', 'New leads start in', { options: [['ai', 'AI mode — the AI replies instantly'], ['human', 'Human mode — team replies, AI stays silent']] })}</div>
          ${field('ai_model', 'Model', { help: 'OpenRouter model id, e.g. openai/gpt-4o-mini, anthropic/claude-3.5-haiku, google/gemini-flash-1.5' })}
          ${field('ai_temperature', 'Creativity (temperature 0–1)', { type: 'number', step: '0.1' })}
          ${field('ai_history_messages', 'Messages of history the AI sees', { type: 'number' })}
          ${field('ai_fallback_reply', 'Fallback reply if the AI fails', { help: 'Sent instead of an AI reply when the AI provider errors; the chat is then handed to a human.' })}
          <div class="full">${field('ai_system_prompt', 'Knowledge & instructions (system prompt)', { rows: 22, help: 'Everything the AI knows about Neopolis Infra and how it should behave. Edit freely — changes apply to the next message.' })}</div>
        </div>${saveBar()}</div></div></form>`;
    else if (view.tab === 'outreach') {
      let fs = null, tplStatus = {}; try { fs = (await api('/system')).followups; } catch { /* ignore */ }
      try { const st = await api('/wa/status'); for (const t of (st.templates?.data || [])) tplStatus[t.name] = t.status; } catch { /* ignore */ }
      let journey = []; try { journey = JSON.parse(S().journey_steps); } catch { journey = []; }
      view.journey = journey;
      const stepHtml = (st, i) => `<div class="journey-step" data-step="${i}">
          <div class="jh"><b>Step ${i + 1}</b><span class="muted small">Day</span><input type="number" min="0" data-j="day" value="${esc(st.day)}" ${ro}><span class="muted small">Template name</span><input type="text" data-j="template" value="${esc(st.template)}" style="width:260px" ${ro}>
            ${tplStatus[st.template] ? `<span class="pill ${tplStatus[st.template] === 'APPROVED' ? 'ok' : tplStatus[st.template] === 'REJECTED' ? 'bad' : 'warn'}">${esc(tplStatus[st.template])}</span>` : `<span class="pill">not in Meta yet</span>`}
            <span class="grow"></span>${view.readOnly ? '' : `<button class="btn xs danger" type="button" data-act="j-remove">Remove</button>`}</div>
          <textarea data-j="text" ${ro}>${esc(st.text)}</textarea>
          <div class="row mt8"><span class="muted small">Quick-reply buttons (comma separated, max 3)</span><input type="text" data-j="buttons" value="${esc((st.buttons || []).join(', '))}" ${ro}></div>
        </div>`;
      p.innerHTML = `<form id="sform">${brainNote}<div class="card mb16"><div class="card-h"><h2>Automated outreach</h2><div class="row"><button class="btn sm" data-act="preview-due" type="button">Who is due now?</button><button class="btn sm" data-act="run-followups" type="button">Run now</button></div></div><div class="card-b">
        <div class="notice ${S().reply_mode === 'live' ? 'ok' : S().reply_mode === 'test' ? 'warn' : 'info'} small mb8"><b>Reply mode: ${esc(String(S().reply_mode || 'test').toUpperCase())}.</b> ${S().reply_mode === 'off' ? 'The AI will NOT reply to anyone who messages you.' : S().reply_mode === 'test' ? 'The AI only replies to the test numbers below — real customers get no reply.' : 'The AI replies to everyone who messages you.'}</div>
        <div class="notice ${S().send_mode === 'live' ? 'ok' : S().send_mode === 'test' ? 'warn' : 'info'} small mb16"><b>Send mode: ${esc(S().send_mode.toUpperCase())}.</b> ${S().send_mode === 'off' ? 'Nothing is sent to leads. Journey steps are computed but held.' : S().send_mode === 'test' ? 'Only the test numbers below receive templates.' : 'Every due lead receives the next journey step automatically.'}${fs ? ` &nbsp;·&nbsp; ${fs.due} lead(s) due now${fs.inWindow ? '' : ' (outside send window)'}${fs.lastRun ? ` · last run ${ago(fs.lastRun.at)}: ${fs.lastRun.sent} sent, ${fs.lastRun.failed} failed` : ''}${fs.lastRun?.awaitingApproval?.length ? ` · <b>waiting for Meta to approve ${esc(fs.lastRun.awaitingApproval.join(', '))}</b>` : ''}` : ''}</div>
        <div class="form-grid">
          ${field('send_mode', 'Send mode', { options: [['off', 'Off — hold everything (safe default)'], ['test', 'Test — only the test numbers'], ['live', 'Live — send to all due leads']], help: 'Proactive journey templates. Switch to Live only after the templates show APPROVED below.' })}
          ${field('reply_mode', 'Reply mode', { options: [['off', 'Off — never auto-reply'], ['test', 'Test — only reply to the test numbers'], ['live', 'Live — reply to everyone']], help: 'Replies to people who message YOU (AI answers, opt-out acknowledgements and inbox replies). Kept separate from Send mode so pausing a campaign never mutes a real customer.' })}
          ${field('test_recipients', 'Test numbers (comma separated)', { help: 'E.164 format, e.g. +919000000001' })}
          ${field('send_window_start', 'Send window start (IST hour)', { type: 'number' })}${field('send_window_end', 'Send window end (IST hour)', { type: 'number' })}
          ${field('no_response_days', 'Mark NO_RESPONSE this many days after the last step', { type: 'number' })}${field('max_followup_attempts', 'Max send attempts per step', { type: 'number' })}
          ${field('journey_per_run', 'Journey messages per run', { type: 'number', help: 'Drip pacing for the automatic run, so a backlog goes out gradually. 0 = no limit.' })}${field('journey_run_minutes', 'Minutes between runs', { type: 'number', help: '"Run now" ignores this. 0 = every minute.' })}${field('journey_daily_cap', 'Max journey messages per day', { type: 'number', help: 'Counted from midnight IST. 0 = no limit.' })}
        </div></div></div>
        <div class="card mb16"><div class="card-h"><h2>The journey (${journey.length} steps over ${journey.length ? Math.max(...journey.map(j => Number(j.day) || 0)) : 0} days)</h2><div class="row">${view.readOnly ? '' : `<button class="btn sm" type="button" data-act="j-defaults">Load recommended messages</button><button class="btn sm" type="button" data-act="j-add">+ Add step</button><button class="btn sm gold" type="button" data-act="submit-templates">Submit templates to Meta</button>`}</div></div><div class="card-b">
        <div class="help mb16">Each step is a Meta <b>marketing template</b> sent on that day (counted from the first send) to leads who still haven't replied. Any reply stops the journey and the AI takes over. <code class="inline">{{1}}</code> = the lead's first name. Edit the text here, then <b>Submit templates to Meta</b> — approval usually takes minutes to a few hours; a step only goes out once its template is APPROVED.</div>
        <div id="journey">${journey.map(stepHtml).join('')}</div>
        <div class="form-grid mt16">${field('template_language', 'Template language code')}${field('template_footer', 'Footer on every template (max 60 chars)')}<div>${field('templates_use_name_param', 'Templates use {{1}} for first name', { type: 'checkbox' })}</div></div>
        <h3 class="mt16 mb8">Opt-out handling</h3><div class="form-grid">${field('optout_keywords', 'Opt-out keywords (comma separated)')}${field('optout_reply', 'Opt-out acknowledgement', { rows: 3 })}</div>
        ${saveBar()}</div></div></form>`;
    }
    else if (view.tab === 'whatsapp') { p.innerHTML = `<div class="muted">Loading WhatsApp status…</div>`; await drawWhatsApp(p); }
    else if (view.tab === 'sheet') { await drawSheet(p); }
    else if (view.tab === 'team') { await drawTeam(p); }
    else if (view.tab === 'account') p.innerHTML = `<div class="card"><div class="card-h"><h2>My account</h2></div><div class="card-b"><div class="kv mb16"><div class="k">Name</div><div>${esc(state.user.name)}</div><div class="k">Email</div><div>${esc(state.user.email)}</div><div class="k">Role</div><div style="text-transform:capitalize">${esc(state.user.role)}</div></div>
        <h3 class="mb8">Change password</h3><form id="pwform" class="form-grid"><div class="field-row"><label class="field">Current password</label><input type="password" name="current" required autocomplete="current-password"></div><div class="field-row"><label class="field">New password</label><input type="password" name="password" required minlength="8" autocomplete="new-password"></div><div class="full"><button class="btn primary" type="submit">Update password</button></div></form>
        <h3 class="mt16 mb8">Notifications</h3><button class="btn sm" data-act="notify">Enable browser notifications</button><div class="help">Get a desktop notification when the AI hands a lead to sales or a human-mode chat gets a reply.</div></div></div>`;
  }

  async function drawWhatsApp(p) {
    const c = view.config; let st = null;
    try { st = await api('/wa/status'); } catch (e) { st = { error: e.message }; }
    const ok = (o) => o && !o.error;
    const phone = ok(st.phone) ? st.phone : null;
    const numbers = ok(st.numbers) ? (st.numbers.data || []) : [];
    const templates = ok(st.templates) ? (st.templates.data || []) : [];
    const webhookUrl = c.publicUrl ? `${c.publicUrl}/webhook` : '(set PUBLIC_URL to your app URL)';
    const line = (label, good, text) => `<div class="status-line"><span class="lbl2">${label}</span><span class="dot ${good === true ? 'g' : good === false ? 'r' : 'a'}"></span><span>${text}</span></div>`;
    p.innerHTML = `<div class="card mb16"><div class="card-h"><h2>Connection</h2><button class="btn sm" data-act="wa-refresh">Refresh</button></div><div class="card-b">
        ${c.whatsapp.mock ? `<div class="notice warn small mb8">Mock mode — no real WhatsApp calls (WA_MOCK=1).</div>` : ''}
        ${line('Access token', c.whatsapp.tokenSet ? (ok(st.token) ? true : false) : false, c.whatsapp.tokenSet ? (ok(st.token) ? `valid (${esc(st.token.name || st.token.id || 'ok')})` : `invalid: ${esc(st.token?.error || '')}`) : 'WHATSAPP_TOKEN not set')}
        ${line('Sender number', phone ? (phone.status === 'CONNECTED' || phone.code_verification_status === 'VERIFIED' ? true : null) : false, phone ? `${esc(phone.display_phone_number)} · ${esc(phone.verified_name)} · ${esc(phone.code_verification_status || '')} · quality ${esc(phone.quality_rating || '?')}${phone.messaging_limit_tier ? ` · ${esc(phone.messaging_limit_tier)}` : ''}` : c.whatsapp.phoneNumberId ? `error: ${esc(st.phone?.error || '')}` : 'PHONE_NUMBER_ID not set')}
        ${line('Business account', !!c.whatsapp.wabaId, c.whatsapp.wabaId ? `WABA ${esc(c.whatsapp.wabaId)} · ${numbers.length} number(s)` : 'WABA_ID not set')}
        ${line('App webhook', st.webhook?.data ? true : (c.whatsapp.appSecretSet ? null : false), st.webhook?.data ? `subscribed: ${esc((st.webhook.data[0]?.callback_url) || 'yes')}` : c.whatsapp.appSecretSet ? esc(st.webhook?.error || 'not subscribed yet') : 'META_APP_ID / META_APP_SECRET not set — configure the webhook manually in Meta')}
        ${line('WABA subscription', ok(st.subscribedApps) ? ((st.subscribedApps.data || []).length ? true : false) : null, ok(st.subscribedApps) ? ((st.subscribedApps.data || []).length ? 'app subscribed to this business account' : 'not subscribed — click "Subscribe app"') : esc(st.subscribedApps?.error || '—'))}
      </div></div>
      <div class="grid c2 mb16">
        <div class="card"><div class="card-h"><h2>Webhook (paste in Meta)</h2></div><div class="card-b">
          <div class="field-row"><label class="field">Callback URL</label><input type="text" readonly value="${esc(webhookUrl)}"></div>
          <div class="field-row"><label class="field">Verify token</label><input type="text" readonly value="${esc(c.whatsapp.verifyToken)}"></div>
          <div class="help">Meta app → WhatsApp → Configuration → Webhook → Edit: paste both, then subscribe to the <b>messages</b> field.</div>
          <div class="row mt8"><button class="btn sm" data-act="wa-configure-webhook" ${c.whatsapp.appSecretSet && c.publicUrl ? '' : 'disabled'}>Configure automatically</button><button class="btn sm" data-act="wa-subscribe">Subscribe app to WABA</button></div>
        </div></div>
        <div class="card"><div class="card-h"><h2>Send a test</h2></div><div class="card-b">
          <div class="field-row"><label class="field">To (E.164)</label><input type="text" id="t-to" placeholder="+919000000001"></div>
          <div class="field-row"><label class="field">Message</label><input type="text" id="t-text" value="Test message from Neopolis LeadDesk"></div>
          <div class="row"><button class="btn sm primary" data-act="wa-send-test">Send text</button><select id="t-tpl" style="width:auto"><option value="">or a template…</option>${templates.map(t => `<option value="${esc(t.name)}">${esc(t.name)} (${esc(t.status)})</option>`).join('')}</select><button class="btn sm" data-act="wa-send-template">Send template</button></div>
          <div class="help">Free text only reaches numbers that messaged you in the last 24h; templates reach anyone.</div>
        </div></div>
      </div>
      <div class="grid c2">
        <div class="card"><div class="card-h"><h2>Numbers on this account</h2></div><div class="card-b">
          ${numbers.length ? `<table class="tbl">${numbers.map(n => `<tr><td><b>${esc(n.display_phone_number)}</b><div class="small muted">${esc(n.verified_name)} · id ${esc(n.id)}</div></td><td class="small">${esc(n.code_verification_status || '')}<br>${esc(n.status || '')}</td></tr>`).join('')}</table>` : `<div class="small muted">${esc(st.numbers?.error || 'No numbers yet.')}</div>`}
          <details class="mt8"><summary class="small" style="cursor:pointer">Register a new number (wizard)</summary>
            <div class="stack mt8">
              <div class="row"><input type="text" id="r-num" placeholder="10-digit number, e.g. 9876543210"><input type="text" id="r-name" placeholder="Display name" value="Neopolis Infra" style="width:180px"><button class="btn sm" data-act="wa-add">1. Add</button></div>
              <div class="row"><input type="text" id="r-pid" placeholder="phone_number_id (from step 1 or the list above)"><button class="btn sm" data-act="wa-code">2. Send SMS code</button></div>
              <div class="row"><input type="text" id="r-code" placeholder="6-digit code from SMS" style="width:160px"><button class="btn sm" data-act="wa-verify">3. Verify</button><input type="text" id="r-pin" placeholder="new 6-digit PIN" style="width:150px"><button class="btn sm" data-act="wa-register">4. Register</button></div>
              <div class="help">The number must not be active on the WhatsApp app any more (delete the account in the app first). After step 4, set <code class="inline">PHONE_NUMBER_ID</code> to the new id and redeploy.</div>
            </div></details>
        </div></div>
        <div class="card"><div class="card-h"><h2>Message templates in Meta</h2></div><div class="card-b">
          ${templates.length ? `<table class="tbl">${templates.map(t => `<tr><td><b>${esc(t.name)}</b><div class="small muted">${esc(t.language)} · ${esc(t.category)}</div></td><td><span class="pill ${t.status === 'APPROVED' ? 'ok' : t.status === 'REJECTED' ? 'bad' : 'warn'}">${esc(t.status)}</span></td></tr>`).join('')}</table>` : `<div class="small muted">${esc(st.templates?.error || 'No templates yet — create them in WhatsApp Manager → Message templates.')}</div>`}
          <div class="help mt8">Follow-ups need APPROVED templates whose names match Settings → Outreach.</div>
        </div></div>
      </div>`;
  }

  async function drawSheet(p) {
    let cx = null, sys = null;
    try { const r = await api('/sheet/connection'); cx = r.connection; sys = r.status; }
    catch (e) { p.innerHTML = `<div class="card"><div class="card-b"><div class="notice bad">${esc(e.message)}</div></div></div>`; return; }
    const connected = cx.provider && cx.provider !== 'none';
    const secret = view.sheetSecret || sessionStorage.getItem('ld.sheetsecret') || (() => { const s = Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2, '0')).join(''); sessionStorage.setItem('ld.sheetsecret', s); return s; })();
    view.sheetSecret = secret;
    const label = { publiclink: 'Link import (read-only)', appsscript: 'Apps Script (two-way sync)', serviceaccount: 'Service account (two-way sync)', n8n: 'n8n bridge', memory: 'in-memory (test)' }[cx.provider] || cx.provider;
    const method = view.sheetMethod || (cx.provider === 'publiclink' ? 'link' : 'appsscript');
    const urlVal = esc(view.sheetUrlDraft != null ? view.sheetUrlDraft : (cx.sheetUrl || ''));
    const tabVal = esc(view.sheetTabDraft != null ? view.sheetTabDraft : (cx.leadsTab || ''));

    const statusCard = `<div class="card mb16"><div class="card-h"><h2>Google Sheet</h2><div class="row">
        ${connected ? `<button class="btn sm" data-act="sheet-test" type="button">Test</button><button class="btn sm" data-act="sheet-import" type="button">Import now</button>${cx.readOnly ? '' : `<button class="btn sm" data-act="sheet-flush" type="button">Push writes</button>`}<button class="btn sm danger" data-act="sheet-disconnect" type="button">Disconnect</button>` : ''}
      </div></div><div class="card-b">
        <div class="notice ${connected ? 'ok' : 'warn'} small mb8">${connected
          ? `Connected · <b>${esc(label)}</b>${cx.sheetUrl ? ` · <a href="${esc(cx.sheetUrl)}" target="_blank" rel="noopener">open sheet ↗</a>` : ''}${cx.leadsTab ? ` · tab <b>${esc(cx.leadsTab)}</b>` : ' · leads tab auto-detected'}${cx.readOnly ? ' · <b>read-only</b> — leads import in; statuses stay in LeadDesk' : ''}`
          : 'No sheet connected yet. Connect one below and leads flow in automatically.'}</div>
        ${sys ? `<div class="small muted">Last import: ${sys.lastImport ? `${ago(sys.lastImport.at)} — ${sys.lastImport.rows} rows, +${sys.lastImport.created} new, ${sys.lastImport.invalid} invalid` : 'never'}${cx.readOnly ? '' : ` · Last write: ${sys.lastWrite ? ago(sys.lastWrite) : 'never'} · Pending: ${sys.pending}`}${sys.lastError ? `<div style="color:var(--red)">Last error ${ago(sys.lastError.at)}: ${esc(sys.lastError.error)}</div>` : ''}${(sys.lastImport?.invalidRows || []).length ? `<details class="mt8"><summary style="cursor:pointer;color:var(--red)">${sys.lastImport.invalid} row(s) skipped — no usable WhatsApp number (click to see which)</summary><ul class="small muted" style="margin:6px 0 0 16px">${sys.lastImport.invalidRows.map(r => `<li>Row ${esc(String(r.row))}${r.name ? ` — ${esc(r.name)}` : ''}: <code class="inline">${esc(String(r.value ?? '(empty)'))}</code></li>`).join('')}</ul><div class="help mt4">Fix the number in the sheet (or add a <code class="inline">whatsapp_number</code> value) and re-import.</div></details>` : ''}</div>` : ''}
      </div></div>`;

    const syncForm = `<form id="sform"><div class="card mb16"><div class="card-h"><h2>Sync behaviour</h2></div><div class="card-b">
        <div class="form-grid">${field('sheet_sync_minutes', 'Import new leads every (minutes)', { type: 'number' })}<div>${field('sheet_import_enabled', 'Import new leads from the sheet automatically', { type: 'checkbox' })}${cx.readOnly ? '' : field('sheet_mirror_enabled', 'Write lead_status / last_reply and Client Replies back to the sheet', { type: 'checkbox' })}</div></div>
        ${saveBar()}</div></div></form>`;

    const tabBtn = (m, l) => `<button type="button" class="btn ${method === m ? 'primary' : ''}" data-act="sheet-method" data-method="${m}">${l}</button>`;
    let body = '';
    if (method === 'link') {
      body = `<div class="notice warn small mb12"><b>Privacy warning — read before using this method.</b> It requires setting your sheet to <b>Anyone with the link&nbsp;→&nbsp;Viewer</b>, which means <b>anyone who obtains that URL can read every lead's name and phone number</b>, with no login. Only use it for a sheet that holds no personal data. For real leads use <b>Two-way sync</b>, which keeps the sheet private.</div>
        <div class="notice info small mb12">Read-only: LeadDesk imports leads, but lead statuses and replies are never written back to the sheet.</div>
        <div class="help mb8"><b>One-time sharing step:</b> open the sheet → <b>Share</b> → <b>General access</b> → <b>Anyone with the link</b> → <b>Viewer</b>.</div>
        <div class="row"><button class="btn primary" type="button" data-act="sheet-connect" data-method="link">Connect &amp; import leads</button></div>`;
    } else {
      body = `<div class="notice info small mb12">Two-way sync using <b>your own Google account</b> (nothing is made public). LeadDesk reads leads and writes <code class="inline">lead_status</code> / <code class="inline">last_reply</code> back, plus a <b>Client Replies</b> tab. ~3 minutes, once.</div>
        <ol class="steps">
          <li>In your sheet: <b>Extensions → Apps Script</b>. Delete anything there.</li>
          <li><button class="btn sm" type="button" data-act="sheet-copy-script">Copy the connector script</button> (your secret is already filled in) and paste it in.</li>
          <li><b>Deploy → New deployment → Web app</b> → Execute as <b>Me</b> → Who has access <b>Anyone</b> → <b>Deploy</b>, authorise, and copy the URL ending in <code class="inline">/exec</code>.</li>
          <li>Paste that URL below and press Connect.</li>
        </ol>
        <div class="field-row"><label class="field">Apps Script Web app URL</label><input type="text" id="sheet-appsurl" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div class="help mb8">Secret (kept in sync automatically): <code class="inline">${esc(secret)}</code></div>
        <div class="row"><button class="btn primary" type="button" data-act="sheet-connect" data-method="appsscript">Connect &amp; import leads</button></div>`;
    }
    const connectCard = `<div class="card"><div class="card-h"><h2>${connected ? 'Reconnect / change sheet' : 'Connect your Google Sheet'}</h2></div><div class="card-b">
        <div class="field-row"><label class="field">Your Google Sheet link</label><input type="text" id="sheet-url" placeholder="https://docs.google.com/spreadsheets/d/…/edit" value="${urlVal}"></div>
        <div class="field-row"><label class="field">Leads tab name <span class="muted">(optional)</span></label><input type="text" id="sheet-tab" placeholder="e.g. 02-08-2026 — blank = auto-detect" value="${tabVal}"></div>
        <div class="row mt8 mb4">${tabBtn('link', 'Quick — just the link')}${tabBtn('appsscript', 'Two-way sync (recommended)')}</div>
        <div id="method-body">${body}</div>
      </div></div>`;

    p.innerHTML = statusCard + syncForm + connectCard;
  }

  async function drawTeam(p) {
    let users = []; try { users = (await api('/users')).users; } catch (e) { toast(e.message, 'error'); }
    const admin = isAdmin();
    p.innerHTML = `<div class="card"><div class="card-h"><h2>Team</h2>${admin ? `<button class="btn sm primary" data-act="user-add">+ Add member</button>` : ''}</div>
      <table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>WhatsApp</th><th>Role</th><th>Status</th><th>Last sign-in</th>${admin ? '<th></th>' : ''}</tr></thead><tbody>
      ${users.map(u => `<tr data-uid="${u.id}"><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td><td class="small">${esc(u.wa_number || '\u2014')}</td><td>${admin ? `<select data-urole style="width:120px"><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option><option value="agent" ${u.role === 'agent' ? 'selected' : ''}>Sales agent</option><option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Viewer</option></select>` : `<span style="text-transform:capitalize">${esc(u.role)}</span>`}</td><td>${u.active ? '<span class="pill ok">active</span>' : '<span class="pill bad">disabled</span>'}</td><td class="small muted">${u.last_login_at ? fmtTime(u.last_login_at) : 'never'}</td>${admin ? `<td class="right"><button class="btn xs" data-act="user-pw">Reset password</button> <button class="btn xs ${u.active ? 'danger' : 'success'}" data-act="user-toggle">${u.active ? 'Disable' : 'Enable'}</button></td>` : ''}</tr>`).join('')}</tbody></table>
      <div class="card-b help"><b>Admin</b> = everything incl. settings. <b>Sales agent</b> = inbox, leads, reviews. <b>Viewer</b> = read-only.</div></div>`;
  }

  // ---------- actions ----------
  function collectJourney() {
    const steps = [...el.querySelectorAll('#journey .journey-step')].map((row, i) => ({
      key: (view.journey?.[i]?.key) || `s${i}`,
      day: Number(row.querySelector('[data-j=day]').value) || 0,
      template: row.querySelector('[data-j=template]').value.trim(),
      text: row.querySelector('[data-j=text]').value,
      buttons: row.querySelector('[data-j=buttons]').value.split(',').map(x => x.trim()).filter(Boolean).slice(0, 3),
    })).filter(st => st.template);
    return steps.map((st, i) => ({ ...st, key: `d${st.day}_${i}` }));
  }
  function collectForm() {
    const f = $('#sform'); if (!f) return {};
    const out = {};
    for (const el2 of f.querySelectorAll('[name]')) out[el2.name] = el2.type === 'checkbox' ? el2.checked : el2.value;
    if (el.querySelector('#journey')) out.journey_steps = JSON.stringify(collectJourney());
    return out;
  }
  async function save() {
    try { const r = await api('/settings', { method: 'PUT', body: collectForm() }); view.settings = r.settings; toast(r.changed.length ? `Saved: ${r.changed.join(', ')}` : 'No changes', 'success'); if (r.changed.includes('send_mode') || r.changed.includes('reply_mode')) drawPanel(); }
    catch (e) { toast(e.message, 'error'); }
  }
  const showResult = (title, obj) => modal({ title, body: `<pre class="code">${esc(JSON.stringify(obj, null, 2))}</pre>`, footer: `<button class="btn" data-close>Close</button>` });
  async function run(act, bg) {
    const val = (id) => $(id)?.value?.trim();
    try {
      switch (act) {
        case 'save': return save();
        case 'ai-test': { toast('Asking the AI…'); const r = await api('/ai/test', { method: 'POST' }); return showResult('AI test reply', r.result); }
        case 'preview-due': { const r = await api('/system'); const f = r.followups; return modal({ title: `Due now: ${f.due} lead(s)`, body: f.dueList.length ? `<div class="help mb8">Mode ${esc(f.sendMode)} · ${f.inWindow ? 'inside' : 'outside'} send window. "Allowed" = would actually be sent in the current mode.</div><table class="tbl">${f.dueList.map(d => `<tr><td>${esc(d.name || d.wa_number)}<div class="small muted">${esc(d.wa_number)}</div></td><td>Day ${[0, 2, 5][d.stage]} · ${esc(d.template)}</td><td>${d.allowed ? '<span class="pill ok">allowed</span>' : '<span class="pill">held</span>'}</td></tr>`).join('')}</table>` : '<div class="empty">Nobody is due right now.</div>', footer: `<button class="btn" data-close>Close</button>` }); }
        case 'run-followups': { if (!(await confirmDialog('Run follow-ups now?', `Send mode is ${S().send_mode.toUpperCase()}. Due leads that are allowed in this mode will receive their next template immediately (inside the send window).`, { okLabel: 'Run now' }))) return; const r = await api('/followups/run', { method: 'POST' }); return showResult('Follow-up run', r.result); }
        case 'sheet-test': { const r = await api('/sheet/test', { method: 'POST' }); return showResult('Sheet connection', r.result); }
        case 'sheet-import': { const r = await api('/sheet/import', { method: 'POST' }); toast(`Imported: +${r.result.created} new, ${r.result.updated} updated, ${r.result.invalid} invalid`, 'success'); return drawPanel(); }
        case 'sheet-flush': { const r = await api('/sheet/flush', { method: 'POST' }); toast(`Pushed ${r.result.processed}, failed ${r.result.failed}, pending ${r.result.pending}`, r.result.failed ? 'error' : 'success'); return drawPanel(); }
        case 'sheet-method': { view.sheetMethod = bg.dataset.method; const u = $('#sheet-url'); if (u) view.sheetUrlDraft = u.value; const t = $('#sheet-tab'); if (t) view.sheetTabDraft = t.value; return drawPanel(); }
        case 'sheet-copy-script': {
          try { const res = await fetch('/connector.gs'); let code = await res.text(); code = code.replace('REPLACE_WITH_SECRET', view.sheetSecret || ''); await navigator.clipboard.writeText(code); toast('Connector script copied — paste it into Apps Script', 'success'); }
          catch { modal({ title: 'Copy the connector script', body: `<div class="help mb8">Open <code class="inline">${esc(location.origin)}/connector.gs</code>, copy it all, and set <code class="inline">SECRET</code> to <code class="inline">${esc(view.sheetSecret || '')}</code>.</div>`, footer: `<button class="btn" data-close>Close</button>` }); }
          return;
        }
        case 'sheet-connect': {
          const url = $('#sheet-url')?.value?.trim();
          const tab = $('#sheet-tab')?.value?.trim();
          const m = bg.dataset.method || view.sheetMethod || 'link';
          const body = { method: m, sheetUrl: url, leadsTab: tab };
          if (m === 'appsscript') { body.appsScriptUrl = $('#sheet-appsurl')?.value?.trim(); body.appsScriptSecret = view.sheetSecret; if (!body.appsScriptUrl) return toast('Paste the Apps Script /exec URL first', 'error'); }
          else if (!url) return toast('Paste your Google Sheet link first', 'error');
          if (m === 'link' && !(await confirmDialog('Publish this sheet to anyone with the link?',
            'This method only works if the sheet is shared as “Anyone with the link → Viewer”. Anyone who gets that URL will be able to read every lead’s name and phone number without signing in. Use Two-way sync instead to keep the sheet private.',
            { okLabel: 'I understand — connect anyway', danger: true }))) return;
          toast('Connecting…');
          const r = await api('/sheet/connect', { method: 'POST', body });
          if (!r.ok) return modal({ title: 'Could not connect', body: `<div class="notice bad">${esc(r.error || 'Connection failed')}</div>`, footer: `<button class="btn" data-close>Close</button>` });
          view.sheetUrlDraft = null; view.sheetTabDraft = null;
          toast(`Connected — imported +${r.import?.created || 0} new, ${r.import?.updated || 0} updated`, 'success');
          return drawPanel();
        }
        case 'sheet-disconnect': { if (!(await confirmDialog('Disconnect the sheet?', 'LeadDesk will stop importing from and writing to this sheet. Existing leads stay in LeadDesk.', { okLabel: 'Disconnect' }))) return; await api('/sheet/disconnect', { method: 'POST' }); view.sheetMethod = null; toast('Sheet disconnected', 'success'); return drawPanel(); }
        case 'j-defaults': { if (!(await confirmDialog('Load the recommended messages?', 'Replaces every journey step in the editor with the recommended six-step journey (new template names). Nothing is saved until you click Save or Submit templates to Meta; each step then waits until Meta approves its template.', { okLabel: 'Load' }))) return; view.settings.journey_steps = view.defaults.journey_steps; return drawPanel(); }
        case 'j-add': { const st = collectJourney(); st.push({ day: (st.length ? Math.max(...st.map(x => x.day)) + 3 : 0), template: `neopolis_journey_step${st.length + 1}`, text: 'Hello {{1}}, ', buttons: [] }); view.settings.journey_steps = JSON.stringify(st); return drawPanel(); }
        case 'j-remove': { const i = Number(bg.closest('[data-step]').dataset.step); const st = collectJourney(); st.splice(i, 1); view.settings.journey_steps = JSON.stringify(st); return drawPanel(); }
        case 'submit-templates': { await save(); if (!(await confirmDialog('Submit templates to Meta?', 'Every journey step will be created as a MARKETING template on your WhatsApp Business Account and sent for approval. Steps that already exist in Meta are skipped. Template names cannot be reused for 30 days after deletion, so review the text first.', { okLabel: 'Submit to Meta' }))) return; const r = await api('/wa/submit-templates', { method: 'POST' }); showResult('Template submission', r.results); return drawPanel(); }
        case 'wa-refresh': return drawPanel();
        case 'wa-configure-webhook': { const r = await api('/wa/configure-webhook', { method: 'POST' }); toast('Webhook configured in Meta', 'success'); return showResult('Webhook', r.result); }
        case 'wa-subscribe': { const r = await api('/wa/subscribe', { method: 'POST' }); toast('App subscribed to the business account', 'success'); return showResult('Subscribe', r.result); }
        case 'wa-send-test': { const r = await api('/wa/send-test', { method: 'POST', body: { to: val('#t-to'), text: val('#t-text') } }); toast(`Sent (status ${r.message.status})`, 'success'); return; }
        case 'wa-send-template': { const tpl = val('#t-tpl'); if (!tpl) return toast('Pick a template first', 'error'); const r = await api('/wa/send-test', { method: 'POST', body: { to: val('#t-to'), template: tpl } }); toast(`Template sent (status ${r.message.status})`, 'success'); return; }
        case 'wa-add': { const r = await api('/wa/add-number', { method: 'POST', body: { phone_number: val('#r-num'), verified_name: val('#r-name') } }); if (r.result?.id) $('#r-pid').value = r.result.id; return showResult('Add number', r.result); }
        case 'wa-code': { const r = await api('/wa/request-code', { method: 'POST', body: { phone_number_id: val('#r-pid') } }); toast('SMS code requested', 'success'); return showResult('Request code', r.result); }
        case 'wa-verify': { const r = await api('/wa/verify-code', { method: 'POST', body: { phone_number_id: val('#r-pid'), code: val('#r-code') } }); toast('Number verified', 'success'); return showResult('Verify', r.result); }
        case 'wa-register': { const r = await api('/wa/register', { method: 'POST', body: { phone_number_id: val('#r-pid'), pin: val('#r-pin') } }); toast('Number registered for the Cloud API', 'success'); return showResult('Register', r.result); }
        case 'notify': { const p = await Notification.requestPermission(); toast(p === 'granted' ? 'Notifications enabled' : 'Notifications not allowed', p === 'granted' ? 'success' : 'error'); return; }
        case 'user-add': return modal({ title: 'Add a team member', body: `<div class="field-row"><label class="field">Name</label><input type="text" id="u-name"></div><div class="field-row"><label class="field">Email</label><input type="email" id="u-email"></div><div class="field-row"><label class="field">WhatsApp number <span class="muted">(optional)</span></label><input type="text" id="u-wa" placeholder="+91 98765 43210"></div><div class="field-row"><label class="field">Temporary password</label><input type="text" id="u-pw" value="${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}"></div><div class="field-row"><label class="field">Role</label><select id="u-role"><option value="agent">Sales agent</option><option value="admin">Admin</option><option value="viewer">Viewer</option></select></div><div class="help">Share the password with them privately; they can change it under My account.</div>`,
          footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-ok>Create</button>`, onOpen: (b, close) => { b.querySelector('[data-ok]').onclick = async () => { try { await api('/users', { method: 'POST', body: { name: b.querySelector('#u-name').value, email: b.querySelector('#u-email').value, wa_number: b.querySelector('#u-wa').value, password: b.querySelector('#u-pw').value, role: b.querySelector('#u-role').value } }); toast('Member added', 'success'); close(); state.users = (await api('/users')).users; drawPanel(); } catch (e) { toast(e.message, 'error'); } }; } });
        case 'user-pw': { const uid = Number(bg.closest('[data-uid]').dataset.uid); const pw = `${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`; if (!(await confirmDialog('Reset password?', `The new temporary password will be: ${pw}\n\nCopy it now and share it privately.`, { okLabel: 'Reset' }))) return; await api(`/users/${uid}`, { method: 'PATCH', body: { password: pw } }); return modal({ title: 'Password reset', body: `<p>New temporary password:</p><pre class="code">${esc(pw)}</pre>`, footer: `<button class="btn" data-close>Close</button>` }); }
        case 'user-toggle': { const row = bg.closest('[data-uid]'); const uid = Number(row.dataset.uid); const active = bg.textContent.trim() === 'Enable'; await api(`/users/${uid}`, { method: 'PATCH', body: { active } }); state.users = (await api('/users')).users; return drawPanel(); }
        default: return;
      }
    } catch (e) { toast(e.message, 'error'); }
  }
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]'); if (t) { view.tab = t.dataset.tab; history.replaceState(null, '', `#/settings/${view.tab}`); return drawPanel(); }
    const a = e.target.closest('[data-act]'); if (a) { e.preventDefault(); run(a.dataset.act, a); }
  });
  el.addEventListener('change', async (e) => {
    if (e.target.matches('[data-urole]')) { const uid = Number(e.target.closest('[data-uid]').dataset.uid); try { await api(`/users/${uid}`, { method: 'PATCH', body: { role: e.target.value } }); toast('Role updated', 'success'); state.users = (await api('/users')).users; } catch (ex) { toast(ex.message, 'error'); drawPanel(); } }
  });
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'sform') return save();
    if (e.target.id === 'pwform') { const fd = Object.fromEntries(new FormData(e.target).entries()); try { await api('/me/password', { method: 'POST', body: fd }); toast('Password updated', 'success'); e.target.reset(); } catch (ex) { toast(ex.message, 'error'); } }
  });
  await drawPanel();
  return () => {};
}
