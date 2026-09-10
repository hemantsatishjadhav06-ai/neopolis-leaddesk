import { api, esc, state, toast } from './core.js';

export function renderAuth(root, { needsSetup }, onDone) {
  root.innerHTML = `<div class="auth"><div class="card">
    <div class="brand"><div class="logo">N</div><div><div class="name">${esc(state.boot?.app_name || 'Neopolis LeadDesk')}</div><div class="sub">${needsSetup ? 'First-time setup — create the admin account' : 'Sign in to the team inbox'}</div></div></div>
    <form id="authform" class="stack" style="margin-top:14px">
      ${needsSetup ? `<div class="field-row"><label class="field">Your name</label><input type="text" name="name" required autocomplete="name" placeholder="e.g. Hemant"></div>` : ''}
      <div class="field-row"><label class="field">Email</label><input type="email" name="email" required autocomplete="username" placeholder="you@neopolisinfra.com"></div>
      <div class="field-row"><label class="field">Password</label><input type="password" name="password" required minlength="8" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" placeholder="${needsSetup ? 'At least 8 characters' : ''}"></div>
      <div id="autherr" class="notice bad hidden"></div>
      <button class="btn primary" type="submit" style="justify-content:center;padding:10px">${needsSetup ? 'Create admin & continue' : 'Sign in'}</button>
      <div class="help center">${needsSetup ? 'You can add sales team members later under Settings → Team.' : 'Forgot your password? Ask an admin to reset it under Settings → Team.'}</div>
    </form></div></div>`;
  root.querySelector('#authform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const err = root.querySelector('#autherr'); err.classList.add('hidden');
    const btn = e.target.querySelector('button'); btn.disabled = true;
    try {
      const r = await api(needsSetup ? '/setup' : '/login', { method: 'POST', body: fd });
      state.user = r.user; toast(`Welcome, ${r.user.name}`, 'success'); onDone();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
    finally { btn.disabled = false; }
  });
}
