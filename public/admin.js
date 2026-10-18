const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const m = c => '$' + (Number(c || 0) / 100).toFixed(2);
const when = d => d ? new Date(d).toLocaleString() : '—';
async function api(path, method = 'GET', body) {
  const r = await fetch('/api/admin' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { show(false); throw new Error(d.error); }
  if (!r.ok) throw new Error(d.error || 'Something went wrong.');
  return d;
}
const show = on => { $('login').hidden = on; $('app').hidden = !on; };
const table = (heads, rows, empty) => `<div class="wrap"><table><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
  rows.length ? rows.join('') : `<tr><td colspan="${heads.length}">${empty}</td></tr>`}</tbody></table></div>`;

$('go').onclick = async () => { try { await api('/login', 'POST', { password: $('pw').value }); $('pw').value = ''; show(true); tab('overview'); } catch (e) { $('lmsg').textContent = e.message; } };
$('pw').onkeydown = e => { if (e.key === 'Enter') $('go').click(); };
$('out').onclick = async () => { await api('/logout', 'POST'); show(false); };
$('nav').onclick = e => e.target.dataset.t && tab(e.target.dataset.t);

async function tab(t) {
  document.querySelectorAll('#nav button').forEach(b => b.setAttribute('aria-selected', b.dataset.t === t));
  $('view').textContent = 'Loading…';
  try { await ({ overview, users, txns, orders, services, settings })[t](); } catch (e) { $('view').innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
}
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
const note = t => { const el = $('m'); if (el) el.textContent = t; };

async function overview() {
  const s = await api('/stats'); $('demo').hidden = !s.demo;
  const box = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;
  $('view').innerHTML = `<div class="stats">${box(m(s.revenue), 'Sales')}${box(m(s.profit), 'Profit')}${box(m(s.cost), 'Provider cost')}${box(m(s.today), 'Sales, last 24 hours')}
    ${box(m(s.deposits), 'Total deposited')}${box(m(s.wallets), 'Held in customer wallets')}${box(s.users, 'Users')}${box(s.orders, 'Orders')}
    ${box(s.pending, 'Payments awaiting review')}${box(s.balance ? esc(s.balance.balance) + ' ' + esc(s.balance.currency || '') : '—', 'Provider balance')}</div>
    <p class="msg">${s.balance ? '' : 'Provider balance is unavailable. Check your API key.'}</p>`;
}

async function users() {
  let list = await api('/users'), editing = null, timer;
  $('view').innerHTML = `<h2>Users</h2><div class="bar"><input id="q" placeholder="Search by ID, email or phone" aria-label="Search users"><span id="count" class="hint"></span></div><div id="t"></div><div class="msg" id="m" role="status"></div>`;
  const draw = () => { $('count').textContent = `${list.length} found`; $('t').innerHTML = table(['User ID', 'Email', 'Phone', 'Telegram', 'Balance', 'Deposited', 'Orders', 'Joined', 'Last sign-in', 'Status', 'Actions'],
    list.map(u => `<tr class="${u.banned ? 'dim' : ''}"><td><b>${esc(u.public_id)}</b></td><td>${esc(u.email)}</td><td>${esc(u.phone) || '<i>missing</i>'}</td><td>${u.telegram ? 'Connected' : '—'}</td><td>${m(u.balance)}</td><td>${m(u.deposited)}</td><td>${u.orders}</td>
      <td>${when(u.created_at)}</td><td>${when(u.last_login)}</td><td>${u.banned ? 'Banned' : 'Active'}</td>
      <td><button class="btn" data-a="edit" data-id="${u.id}">Edit</button> <button class="btn" data-a="adj" data-id="${u.id}">Adjust balance</button></td></tr>`), 'No users match your search.'); };
  draw();
  $('q').oninput = e => { clearTimeout(timer); timer = setTimeout(async () => { list = await api('/users?q=' + encodeURIComponent(e.target.value)); draw(); }, 250); };
  $('t').onclick = async e => {
    const { a, id } = e.target.dataset; if (!a) return;
    if (a === 'edit') {
      editing = list.find(x => x.id == id); $('uId').textContent = editing.public_id; $('uEm').value = editing.email; $('uPh').value = editing.phone || '';
      $('uPw').value = ''; $('uBan').checked = !!editing.banned; $('uLinkOut').hidden = true; $('uMsg').textContent = ''; $('uD').showModal();
    } else {
      const v = prompt('Amount to add (use a minus sign to remove), e.g. 10 or -5'); if (!v) return;
      try { await api(`/users/${id}/adjust`, 'POST', { amount: Number(v), note: prompt('Reason (kept in the payment log)') || '' }); tab('users'); } catch (err) { note(err.message); }
    }
  };
  const uNote = t => $('uMsg').textContent = t;
  $('uSave').onclick = async () => {
    try {
      const body = { email: $('uEm').value, phone: $('uPh').value, banned: $('uBan').checked }; if ($('uPw').value) body.password = $('uPw').value;
      const row = await api('/users/' + editing.id, 'PUT', body); list = list.map(x => x.id === row.id ? row : x); editing = row; $('uPw').value = ''; draw(); uNote('Saved.');
    } catch (err) { uNote(err.message); }
  };
  $('uLink').onclick = async () => { try { const r = await api(`/users/${editing.id}/reset-link`, 'POST'); $('uLinkOut').value = r.link; $('uLinkOut').hidden = false; $('uLinkOut').select(); uNote(`Send this link to the user. It works once and expires in ${r.expires}.`); } catch (err) { uNote(err.message); } };
  $('uOut').onclick = async () => { try { await api(`/users/${editing.id}/signout`, 'POST'); uNote('All devices signed out.'); } catch (err) { uNote(err.message); } };
}

async function txns() {
  $('view').innerHTML = `<h2>Payments and wallet activity</h2><div class="bar">
    <select id="s" aria-label="Status"><option value="">All statuses</option><option value="pending">Pending</option><option value="completed">Completed</option><option value="rejected">Rejected</option></select>
    <select id="ty" aria-label="Type"><option value="">All types</option><option value="deposit">Deposits</option><option value="order">Orders</option><option value="refund">Refunds</option><option value="adjust">Adjustments</option></select></div>
    <div id="t"></div><div class="msg" id="m" role="status"></div>`;
  const load = async () => {
    const list = await api(`/txns?status=${$('s').value}&type=${$('ty').value}`);
    $('t').innerHTML = table(['ID', 'Date', 'User ID', 'Email', 'Type', 'Method', 'Reference', 'Amount', 'Status', 'Note', ''], list.map(t => `<tr><td>${t.id}</td><td>${when(t.created_at)}</td><td>${esc(t.public_id)}</td><td>${esc(t.email)}</td>
      <td>${esc(t.type)}</td><td>${esc(t.method)}</td><td>${esc(t.ref)}</td><td>${m(t.amount)}</td><td>${esc(t.status)}</td><td class="l" title="${esc(t.note)}">${esc(t.note)}</td>
      <td>${t.receipt ? `<button class="btn" data-a="receipt" data-id="${t.id}" data-info="${esc(t.public_id + ' · ' + t.ref + ' · ' + m(t.amount))}">Receipt</button> ` : ''}${t.type === 'deposit' && t.status === 'pending' ? `<button class="btn" data-a="approve" data-id="${t.id}" data-amt="${(t.amount / 100).toFixed(2)}">Approve</button> <button class="btn" data-a="reject" data-id="${t.id}">Reject</button>` : ''}</td></tr>`), 'Nothing here yet.');
  };
  $('s').onchange = $('ty').onchange = load; await load();
  $('t').onclick = async e => {
    const { a, id, amt, info } = e.target.dataset; if (!a) return;
    if (a === 'receipt') { $('rImg').src = `/api/admin/txns/${id}/receipt`; $('rImg').hidden = false; $('rOpen').href = `/api/admin/txns/${id}/receipt`; $('rInfo').textContent = `Payment ${id}: ${info}`; return $('rD').showModal(); }
    const body = {};
    if (a === 'approve') { const v = prompt('Amount to add to the user’s balance (change it if the receipt shows a different amount):', amt); if (v === null) return; body.amount = Number(v); }
    else { const why = prompt('Reason for rejecting (the user will see it):', ''); if (why === null) return; body.note = why; }
    try { await api(`/txns/${id}/${a}`, 'POST', body); await load(); note(`Payment ${id}: ${a === 'approve' ? 'approved and credited' : 'rejected'}`); } catch (err) { note(err.message); }
  };
}

async function orders() {
  let list = await api('/orders'), q = '', st = '';
  $('view').innerHTML = `<h2>Orders</h2><div class="bar"><input id="q" placeholder="Search email, link, ID" aria-label="Search orders">
    <select id="st" aria-label="Status"><option value="">All statuses</option>${[...new Set(list.map(o => o.status))].map(s => `<option>${esc(s)}</option>`).join('')}</select></div>
    <div id="t"></div><div class="msg" id="m" role="status"></div>`;
  const draw = () => {
    const rows = list.filter(o => (!st || o.status === st) && (!q || JSON.stringify(o).toLowerCase().includes(q)));
    $('t').innerHTML = table(['ID', 'Date', 'User ID', 'Email', 'Service', 'Link', 'Qty', 'Price', 'Cost', 'Status', 'Actions'], rows.map(o => `<tr><td>${esc(o.id)}</td><td>${when(o.created_at)}</td><td>${esc(o.public_id)}</td><td>${esc(o.email)}</td>
      <td>${esc(o.service)}</td><td class="l" title="${esc(o.link)}">${esc(o.link)}</td><td>${o.quantity}</td><td>${m(o.price)}</td><td>${m(o.cost)}</td><td>${esc(o.status)}</td>
      <td><button class="btn" data-a="refresh" data-id="${esc(o.id)}">Refresh</button> <button class="btn" data-a="cancel" data-id="${esc(o.id)}">Cancel</button> <button class="btn" data-a="refund" data-id="${esc(o.id)}">Refund</button></td></tr>`), 'No orders match.');
  };
  draw();
  $('q').oninput = e => { q = e.target.value.toLowerCase(); draw(); };
  $('st').onchange = e => { st = e.target.value; draw(); };
  $('t').onclick = async e => {
    const { a, id } = e.target.dataset; if (!a) return;
    if (a !== 'refresh' && !confirm(`${a} order ${id}? The customer's money goes back to their wallet.`)) return;
    try { const o = await api(`/orders/${id}/${a}`, 'POST'); list = list.map(x => x.id === id ? { ...x, ...o } : x); draw(); note(`Order ${id}: ${o.status}`); } catch (err) { note(err.message); }
  };
}

async function services() {
  const { services: list } = await api('/services');
  $('view').innerHTML = `<h2>Services</h2><div class="bar"><button class="btn" id="ref">Reload from provider</button><span id="m" role="status"></span></div>` +
    table(['ID', 'Platform', 'Name', 'Cost /1k', 'Your price /1k', 'Min–Max', 'Visible', ''], list.map(s => `<tr class="${s.hidden ? 'dim' : ''}"><td>${s.id}</td><td>${esc(s.platform)}</td>
      <td><input data-n="${s.id}" value="${esc(s.name)}" aria-label="Name of service ${s.id}"></td><td>${'$' + s.cost.toFixed(2)}</td>
      <td><input type="number" step="0.01" min="0" data-r="${s.id}" value="${s.rate}" aria-label="Price of service ${s.id}"> ${s.custom ? '<span class="badge">custom</span>' : ''}</td>
      <td>${s.min}–${s.max}</td><td><input type="checkbox" data-h="${s.id}" ${s.hidden ? '' : 'checked'} aria-label="Show service ${s.id}"></td>
      <td><button class="btn" data-save="${s.id}">Save</button> <button class="btn" data-reset="${s.id}">Reset price</button></td></tr>`), 'No services loaded.');
  $('ref').onclick = async () => { await api('/services/refresh', 'POST'); tab('services'); };
  $('view').onclick = async e => {
    const id = e.target.dataset.save || e.target.dataset.reset; if (!id) return;
    const body = e.target.dataset.reset ? { rate: null } : { rate: Number(document.querySelector(`[data-r="${id}"]`).value), name: document.querySelector(`[data-n="${id}"]`).value.trim() };
    try { await api('/services/' + id, 'PUT', body); tab('services'); } catch (err) { note(err.message); }
  };
  $('view').onchange = async e => { const id = e.target.dataset.h; if (id) try { await api('/services/' + id, 'PUT', { hidden: !e.target.checked }); tab('services'); } catch (err) { note(err.message); } };
}

async function settings() {
  const s = (await api('/services')).settings; let manual = [...s.manual];
  const drawM = () => $('mm').innerHTML = manual.map((x, i) => `<div class="mrow"><input data-i="${i}" data-k="name" value="${esc(x.name)}" placeholder="Name, e.g. Bank transfer" aria-label="Method name">
    <input data-i="${i}" data-k="instructions" value="${esc(x.instructions)}" placeholder="What the customer should do and where to send money" aria-label="Instructions">
    <button class="btn" data-del="${i}">Remove</button></div>`).join('');
  $('view').innerHTML = `<h2>Settings</h2><div class="set">
    <label for="mk">Markup over provider cost (0.5 means +50%)</label><input id="mk" type="number" step="0.05" min="0" max="20" value="${s.markup}">
    <label class="inline"><input id="ps" type="checkbox" ${s.paused ? 'checked' : ''}> Pause the store (customers can browse but not order)</label>
    <label>Manual payment methods</label><p class="hint">Bank transfer, e-wallets, crypto addresses. Customers send money, enter the reference, and you approve it under Payments.</p>
    <div id="mm"></div><div class="bar"><button class="btn" id="add">Add a method</button></div>
    <button class="btn solid block mt" id="sv">Save settings</button><div class="msg" id="m" role="status"></div></div>`;
  drawM();
  $('mm').oninput = e => { const { i, k } = e.target.dataset; if (i !== undefined) manual[i][k] = e.target.value; };
  $('mm').onclick = e => { if (e.target.dataset.del !== undefined) { manual.splice(e.target.dataset.del, 1); drawM(); } };
  $('add').onclick = () => { manual.push({ name: '', instructions: '' }); drawM(); };
  $('sv').onclick = async () => { try { await api('/settings', 'PUT', { markup: Number($('mk').value), paused: $('ps').checked, manual }); note('Settings saved.'); } catch (e) { note(e.message); } };
}

api('/stats').then(() => { show(true); tab('overview'); }).catch(() => show(false));
