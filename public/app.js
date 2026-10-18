const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let cur = 'USD', services = [], platform = null, sel = null, me = null, pay = null, mode = 'login', method = null;
let PHONE_CODES = [];
const phoneCodesReady = api('/phone-codes').then(codes => {
  PHONE_CODES = codes.map(({ name, code }) => [name, code]);
  for (const id of ['phCode', 'fidCode', 'accCode']) {
    $(id).innerHTML = PHONE_CODES.map(([name, code]) => `<option value="${code}" ${code === '+966' ? 'selected' : ''}>${code} — ${esc(name)}</option>`).join('');
  }
}).catch(() => say($('authMsg'), 'Country calling codes could not load. Refresh and try again.', true));
const phoneValue = (codeId, phoneId) => {
  const raw = $(phoneId).value.trim(), code = $(codeId).value;
  if (raw.startsWith('+')) return '+' + raw.replace(/\D/g, '');
  const local = raw.replace(/\D/g, '').replace(/^0+/, '');
  return local ? code + local : PHONE_CODES.some(([, known]) => known === code) ? '' : code;
};
function fillPhone(codeId, phoneId, full) {
  const match = PHONE_CODES.map(([, code]) => code).sort((a, b) => b.length - a.length).find(code => full.startsWith(code));
  if (match) { $(codeId).value = match; $(phoneId).value = full.slice(match.length); }
  else if (full) {
    const option = document.createElement('option'); option.value = full; option.textContent = `Saved number (${full})`;
    $(codeId).append(option); $(codeId).value = full; $(phoneId).value = '';
  } else $(phoneId).value = '';
}
const money = (n, cents) => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(cents ? n / 100 : n);
const when = d => new Date(d).toLocaleString();

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Something went wrong.'); e.status = r.status; throw e; }
  return d;
}
const say = (el, t, err) => { el.textContent = t; el.className = 'msg' + (err ? ' err' : ''); };
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());

// ----- account bar -----
function drawAcct() {
  $('acct').innerHTML = me ? `<button class="btn" id="accB" aria-label="My account, ID ${esc(me.id)}">ID ${esc(me.id)}</button><b>${money(me.balance, true)}</b>
    <button class="btn solid" id="addF">Add funds</button><button class="btn" id="myO">My activity</button><button class="btn" id="out">Sign out</button>`
    : `<button class="btn solid" id="inB">Sign in</button>`;
  if (me) { $('accB').onclick = openAcct; $('addF').onclick = openFunds; $('myO').onclick = openOrders;
    $('out').onclick = async () => { await api('/auth/logout', 'POST'); me = null; drawAcct(); update(); }; }
  else $('inB').onclick = () => openAuth('login');
}
let asked = false;
async function loadMe() {
  const d = await api('/me'); me = d.email ? d : null; drawAcct(); update();
  if (me && !me.phone && !asked) { asked = true; openAcct('Please add your phone number so support can reach you.'); }
}

// ----- sign in / register / forgot / reset -----
let resetToken = new URLSearchParams(location.search).get('reset');
const TITLE = { login: 'Sign in', register: 'Create account', forgot: 'Reset your password', code: 'Enter your code', reset: 'Choose a new password' };
const GO = { login: 'Sign in', register: 'Create account', forgot: 'Send code', code: 'Change password', reset: 'Save new password' };
let chan = { telegram: null, whatsapp: false }, forgotId = '';
api('/auth/channels').then(c => chan = c).catch(() => {});
function openAuth(m) {
  mode = m; $('authT').textContent = TITLE[m]; $('authGo').textContent = GO[m];
  $('emBox').hidden = m !== 'login' && m !== 'register'; $('phoneBox').hidden = m !== 'register';
  $('idBox').hidden = m !== 'forgot'; $('chBox').hidden = m !== 'forgot'; $('cdBox').hidden = m !== 'code'; $('pwBox').hidden = m === 'forgot';
  $('pwL').textContent = m === 'login' || m === 'register' ? 'Password' : 'New password'; $('pw').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('authSwap').textContent = m === 'login' ? 'Create an account' : m === 'register' ? 'I already have an account' : 'Back to sign in';
  $('authForgot').hidden = m !== 'login'; say($('authMsg'), '');
  if (m === 'forgot') {
    const o = []; if (chan.telegram) o.push(['telegram', 'Telegram']); if (chan.whatsapp) o.push(['whatsapp', 'WhatsApp']);
    $('chOpts').innerHTML = o.map((x, i) => `<label class="opt"><input type="radio" name="ch" value="${x[0]}" ${i ? '' : 'checked'}>${x[1]}</label>`).join('');
    $('chHelp').innerHTML = (chan.telegram ? `Telegram: connect once by opening <a href="https://t.me/${esc(chan.telegram)}" target="_blank" rel="noopener">@${esc(chan.telegram)}</a> and tapping “Share my phone number”. ` : '')
      + (chan.whatsapp ? 'WhatsApp: the code goes to the phone number on your account. ' : '') + (o.length ? '' : 'Code delivery is not set up yet. Contact support with your user ID.');
    $('authGo').disabled = !o.length;
  } else $('authGo').disabled = false;
  if (!$('authD').open) $('authD').showModal();
}
$('authSwap').onclick = () => openAuth(mode === 'login' ? 'register' : 'login');
$('authForgot').onclick = () => openAuth('forgot');
$('authGo').onclick = async () => {
  $('authGo').disabled = true;
  try {
    await phoneCodesReady;
    if (mode === 'forgot') {
      const input = $('fid').value.trim();
      forgotId = input.includes('@') ? input : phoneValue('fidCode', 'fid');
      await api('/auth/forgot', 'POST', { identifier: forgotId, channel: (document.querySelector('[name=ch]:checked') || {}).value });
      openAuth('code'); say($('authMsg'), 'If an account matches and the channel is connected, a code is on its way. It lasts 10 minutes.');
    } else if (mode === 'code') {
      await api('/auth/reset-code', 'POST', { identifier: forgotId, code: $('cd').value, password: $('pw').value }); $('pw').value = $('cd').value = '';
      openAuth('login'); say($('authMsg'), 'Password changed. You can sign in now.');
    }
    else if (mode === 'reset') {
      await api('/auth/reset', 'POST', { token: resetToken, password: $('pw').value }); resetToken = null; history.replaceState(null, '', '/'); $('pw').value = '';
      say($('authMsg'), 'Password changed. You can sign in now.'); setTimeout(() => openAuth('login'), 1500);
    } else {
      me = await api('/auth/' + mode, 'POST', mode === 'register' ? { email: $('em').value, phone: phoneValue('phCode', 'ph'), password: $('pw').value } : { email: $('em').value, password: $('pw').value });
      $('pw').value = ''; $('authD').close(); drawAcct(); update();
    }
  } catch (e) { say($('authMsg'), e.message, true); }
  $('authGo').disabled = false;
};
$('pw').onkeydown = e => { if (e.key === 'Enter') $('authGo').click(); };

// ----- my account -----
async function openAcct(text) {
  await phoneCodesReady;
  $('accId').textContent = me.id; $('accEm').textContent = me.email;
  $('accTg').innerHTML = me.telegram ? 'Connected' : chan.telegram ? `Not connected. <a href="https://t.me/${esc(chan.telegram)}" target="_blank" rel="noopener">Open @${esc(chan.telegram)}</a> and tap “Share my phone number”.` : 'Not available'; fillPhone('accCode', 'accPh', me.phone || '');
  $('cpw').value = $('npw').value = ''; say($('accMsg'), typeof text === 'string' ? text : '', typeof text === 'string'); $('accD').showModal();
}
$('accSave').onclick = async () => { try { me = await api('/account', 'POST', { phone: phoneValue('accCode', 'accPh') }); drawAcct(); say($('accMsg'), 'Phone number saved.'); } catch (e) { say($('accMsg'), e.message, true); } };
$('pwSave').onclick = async () => {
  try { await api('/account/password', 'POST', { current: $('cpw').value, password: $('npw').value }); $('cpw').value = $('npw').value = ''; say($('accMsg'), 'Password changed. Other devices were signed out.'); }
  catch (e) { say($('accMsg'), e.message, true); }
};

// ----- services -----
let q = '', cat = '', shown = 100;
api('/pay/methods').then(d => { pay = d; cur = d.currency; }).catch(() => {}).finally(() =>
  api('/services').then(d => {
    services = d.services; platform = services[0]?.platform;
    $('tabs').innerHTML = [...new Set(services.map(s => s.platform))].map(p => `<button role="tab" data-p="${esc(p)}">${esc(p)}</button>`).join('');
    $('tabs').onclick = e => { if (e.target.dataset.p) { platform = e.target.dataset.p; cat = ''; shown = 100; draw(true); } };
    if (d.paused) say($('msg'), 'Orders are paused for now. You can still browse and add funds.');
    draw(true);
  }).catch(() => $('rows').innerHTML = '<p class="row">Services could not load. Refresh to try again.</p>'));
$('search').oninput = e => { q = e.target.value.trim().toLowerCase(); shown = 100; draw(); };
$('cat').onchange = e => { cat = e.target.value; shown = 100; draw(); };

function draw(rebuildCats) {
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.p === platform));
  const inPlat = services.filter(s => s.platform === platform);
  if (rebuildCats) $('cat').innerHTML = '<option value="">All categories</option>' + [...new Set(inPlat.map(s => s.category))].map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('cat').value = cat;
  const list = inPlat.filter(s => (!cat || s.category === cat) && (!q || `${s.name} ${s.category} ${s.id}`.toLowerCase().includes(q)));
  $('rows').innerHTML = list.slice(0, shown).map(s => `
    <button class="row" data-id="${s.id}" aria-pressed="${!!sel && sel.id === s.id}">
      <span><b>${esc(s.name)}</b><small>${esc(s.category)} · ${s.min.toLocaleString()}–${s.max.toLocaleString()}</small></span>
      <span class="p">${money(s.rate)}<small> /1k</small></span></button>`).join('')
    + (list.length > shown ? `<div class="filters"><button class="btn more" id="more">Show more (${list.length - shown} left)</button></div>` : '')
    + (list.length ? '' : '<p class="row">No services match.</p>');
  if ($('more')) $('more').onclick = () => { shown += 100; draw(); };
  document.querySelectorAll('.row[data-id]').forEach(r => r.onclick = () => {
    sel = services.find(s => s.id == r.dataset.id); $('title').textContent = sel.name;
    $('range').textContent = `Min ${sel.min.toLocaleString()} · Max ${sel.max.toLocaleString()}`;
    $('qty').value = sel.min; update(); draw();
    if (matchMedia('(max-width:860px)').matches) $('panel').scrollIntoView({ behavior: 'smooth' });
  });
}
function price() { const q = Number($('qty').value); return sel && q ? Math.max(1, Math.ceil(sel.rate * q / 10)) : 0; }
function update() {
  const q = Number($('qty').value);
  $('total').textContent = money(price(), true);
  const ok = sel && Number.isInteger(q) && q >= sel.min && q <= sel.max;
  $('buy').disabled = !ok; $('buy').textContent = !me ? 'Sign in to order' : me.balance < price() ? 'Add funds to order' : 'Place order';
}
$('qty').oninput = update;
$('buy').onclick = async () => {
  if (!me) return openAuth('login');
  if (me.balance < price()) return openFunds();
  $('buy').disabled = true; say($('msg'), 'Placing order…');
  try {
    const d = await api('/order', 'POST', { serviceId: sel.id, link: $('link').value.trim(), quantity: Number($('qty').value) });
    me.balance = d.balance; drawAcct(); say($('msg'), `Order placed. Order ID ${d.id}. Track it under My activity.`);
  } catch (e) { say($('msg'), e.message, true); if (e.status === 401) { me = null; drawAcct(); } if (e.message.includes('phone')) openAcct(e.message); }
  update();
};

// ----- receipt image: shrink in the browser so uploads stay small and fast -----
let receipt = null;
$('receipt').onchange = () => {
  receipt = null; $('prev').hidden = true; const f = $('receipt').files[0]; if (!f) return;
  if (!/^image\/(jpeg|png|webp)$/.test(f.type)) return say($('fundMsg'), 'Choose a JPG, PNG or WebP image.', true);
  const fr = new FileReader();
  fr.onload = () => { const img = new Image(); img.onload = () => {
    const k = Math.min(1, 1400 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
    cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    let out = cv.toDataURL('image/jpeg', 0.82); if (out.length > 1.9e6) out = cv.toDataURL('image/jpeg', 0.6);
    receipt = out; $('prev').src = out; $('prev').hidden = false; say($('fundMsg'), '');
  }; img.onerror = () => say($('fundMsg'), 'That image could not be read.', true); img.src = fr.result; };
  fr.readAsDataURL(f);
};

// ----- add funds -----
function openFunds() {
  if (!me) return openAuth('login');
  const m = [];
  if (pay.stripe) m.push({ id: 'stripe', name: 'Card (Visa, Mastercard, Apple Pay)' });
  pay.manual.forEach(x => m.push({ id: x.id, name: x.name, instructions: x.instructions, manual: true }));
  $('methods').innerHTML = m.length ? m.map((x, i) => `<label class="opt"><input type="radio" name="pm" value="${esc(x.id)}" ${i ? '' : 'checked'}>${esc(x.name)}</label>`).join('')
    : '<p class="hint">No payment methods are set up yet. Please contact support.</p>';
  $('fundGo').disabled = !m.length;
  const pick = () => { method = m.find(x => x.id === (document.querySelector('[name=pm]:checked') || {}).value);
    $('manualBox').hidden = !(method && method.manual); $('receipt').required = !!(method && method.manual); $('instr').textContent = method?.instructions || ''; };
  $('methods').onchange = pick; pick();
  $('amt').min = pay.min; $('amt').max = pay.max; $('amt').placeholder = `${pay.min} – ${pay.max}`;
  $('chips').innerHTML = [10, 25, 50, 100].filter(v => v >= pay.min && v <= pay.max).map(v => `<button class="btn" data-v="${v}">${money(v)}</button>`).join('');
  $('chips').onclick = e => { if (e.target.dataset.v) $('amt').value = e.target.dataset.v; };
  say($('fundMsg'), ''); receipt = null; $('receipt').value = ''; $('prev').hidden = true; $('fundsD').showModal();
}
$('fundGo').onclick = async () => {
  if (!method) return;
  const amount = Number($('amt').value); $('fundGo').disabled = true; say($('fundMsg'), 'Working…');
  try {
    if (method.id === 'stripe') { const d = await api('/pay/stripe', 'POST', { amount }); location.href = d.url; return; }
    if (method.manual) {
      if (!receipt) { say($('fundMsg'), 'Attach the screenshot of the transfer notification.', true); $('fundGo').disabled = false; return; }
      await api('/pay/manual', 'POST', { method: method.id, amount, reference: $('ref').value, receipt });
      say($('fundMsg'), 'Request sent. Your balance is updated as soon as an admin approves it. Track it under My activity.');
      $('ref').value = ''; $('receipt').value = ''; receipt = null; $('prev').hidden = true;
    }
  } catch (e) { say($('fundMsg'), e.message, true); }
  $('fundGo').disabled = false;
};

// ----- my activity -----
async function openOrders() {
  $('oList').innerHTML = $('tList').innerHTML = 'Loading…'; $('ordersD').showModal();
  const [o, t] = await Promise.all([api('/orders'), api('/txns')]);
  $('oList').innerHTML = o.length ? o.map(x => `<div class="item"><span><b>${esc(x.service)}</b><small>#${esc(x.id)} · ${x.quantity.toLocaleString()} · ${when(x.created_at)}</small></span>
    <span>${money(x.price, true)}<small>${esc(x.status)} <button class="btn sm" data-r="${esc(x.id)}">Refresh</button></small></span></div>`).join('') : '<p class="hint">No orders yet.</p>';
  $('tList').innerHTML = t.length ? t.map(x => `<div class="item"><span><b>${esc(x.type)}</b><small>${esc(x.note || x.method || '')} · ${when(x.created_at)}</small></span>
    <span>${x.amount > 0 ? '+' : ''}${money(x.amount, true)}<small>${esc(x.status)}</small></span></div>`).join('') : '<p class="hint">No payments yet.</p>';
  $('oList').onclick = async e => { if (!e.target.dataset.r) return; try { await api(`/orders/${e.target.dataset.r}/refresh`, 'POST'); await loadMe(); openOrders(); } catch {} };
}

loadMe().then(() => { if (resetToken) openAuth('reset'); });
if (location.search.includes('paid=1')) { history.replaceState(null, '', '/'); setTimeout(loadMe, 2500); setTimeout(loadMe, 8000); }
