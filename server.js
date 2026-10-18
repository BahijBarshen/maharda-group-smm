require('dotenv').config();
const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const { getCountries, getCountryCallingCode } = require('libphonenumber-js');
const crypto = require('crypto'), path = require('path'), { promisify } = require('util');
const { get, all, run, settings, saveSettings } = require('./db');
const W = require('./wallet'), A = require('./auth'), N = require('./notify'), R = require('./receipt');

const E = process.env, PROD = E.NODE_ENV === 'production', PORT = E.PORT || 3000;
const RATE_MULT = Number(E.PROVIDER_RATE_MULT || 1);   // converts the provider's currency into yours
const DEMO = !E.PROVIDER_API_URL || !E.PROVIDER_API_KEY;
const STRIPE = E.STRIPE_SECRET_KEY, CUR = (E.CURRENCY || 'usd').toLowerCase();
const MIN_DEP = Number(E.MIN_DEPOSIT || 5), MAX_DEP = Number(E.MAX_DEPOSIT || 500);
const BASE = (E.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
if (PROD && ((E.ADMIN_PASSWORD || '').length < 12 || (E.SESSION_SECRET || '').length < 32)) {
  console.error('Production needs ADMIN_PASSWORD (12+ chars) and SESSION_SECRET (32+ chars) in .env'); process.exit(1);
}
const SECRET = E.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const scrypt = promisify(crypto.scrypt);
const $ = c => (c / 100).toFixed(2);
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---------- security basics ----------
const app = express();
app.disable('x-powered-by');
if (Number(E.TRUST_PROXY)) app.set('trust proxy', Number(E.TRUST_PROXY));
if (E.FORCE_HTTPS === '1') app.use((req, res, next) => req.secure ? next() : res.redirect(301, BASE + req.originalUrl));
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com'],
    fontSrc: ['https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
    frameAncestors: ["'none'"], formAction: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"],
    upgradeInsecureRequests: PROD ? [] : null } },
  referrerPolicy: { policy: 'same-origin' },
}));

// Stripe webhook needs the raw body, so it is registered before express.json()
app.post('/api/pay/stripe/webhook', express.raw({ type: 'application/json', limit: '100kb' }), (req, res) => {
  const secret = E.STRIPE_WEBHOOK_SECRET;
  const parts = Object.fromEntries((req.get('stripe-signature') || '').split(',').map(p => p.split('=')));
  if (!secret || !parts.t || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return res.sendStatus(400);
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${req.body}`).digest('hex');
  if (!eq(parts.v1 || '', expected)) return res.sendStatus(400);
  const ev = JSON.parse(req.body);
  if (ev.type === 'checkout.session.completed' && ev.data.object.payment_status === 'paid') {
    const s = ev.data.object, t = get("SELECT * FROM txns WHERE method='stripe' AND ref=?", s.id);
    if (t && t.amount === s.amount_total && s.currency === CUR) W.completeDeposit(t.id, 'Paid by card');
  }
  res.json({ received: true });
});

const smallJson = express.json({ limit: '10kb' }), receiptJson = express.json({ limit: '3mb' });
app.use((req, res, next) => (req.path === '/api/pay/manual' ? receiptJson : smallJson)(req, res, next));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // CSRF: browsers can't add this header cross-site without a CORS preflight (which we never allow)
  if (req.method !== 'GET' && req.get('x-requested-with') !== 'fetch') return res.status(403).json({ error: 'Request blocked.' });
  next();
});
app.use('/api', rateLimit({ windowMs: 60_000, max: 120 }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- sessions ----------
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const eq = A.eq;
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(c => c[0] && c[1]));
const setCookie = (res, n, v, age) => res.append('Set-Cookie', `${n}=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${PROD ? '; Secure' : ''}`);
const token = (kind, id, ttl) => { const p = `${kind}:${id}:${Date.now() + ttl}`; return Buffer.from(p).toString('base64url') + '.' + sign(p); };
function readToken(raw, kind) {
  const [b, s] = (raw || '').split('.'); if (!b || !s) return null;
  const p = Buffer.from(b, 'base64url').toString();
  if (!eq(s, sign(p))) return null;
  const [k, id, exp] = p.split(':'); return k === kind && Number(exp) > Date.now() ? id : null;
}
// The session carries the user's "sess_ver"; changing a password or an admin "sign out everywhere" bumps it and kills old sessions.
const startSession = (res, u) => setCookie(res, 'sid', token('u', `${u.id}_${u.sess_ver}`, 7 * 864e5), 7 * 86400);
const USER_COLS = 'id,public_id,email,phone,balance,banned,sess_ver,pass,telegram_chat_id';
function sessionUser(req) {
  const [id, ver] = (readToken(cookies(req).sid, 'u') || '').split('_');
  const u = id && get(`SELECT ${USER_COLS} FROM users WHERE id=?`, Number(id));
  return u && !u.banned && u.sess_ver === Number(ver) ? u : null;
}
const meOf = u => ({ id: u.public_id, email: u.email, phone: u.phone, balance: u.balance, telegram: !!u.telegram_chat_id });
const userAuth = (req, res, next) => { const u = sessionUser(req); if (!u) return res.status(401).json({ error: 'Please sign in.' }); req.user = u; next(); };
const needPhone = (req, res, next) => req.user.phone ? next() : res.status(400).json({ error: 'Add your phone number under My account first.', code: 'PHONE' });
const tooMany = (windowMs, max) => rateLimit({ windowMs, max, message: { error: 'Too many attempts. Try again later.' } });
let DUMMY; A.hashPw('not-a-real-password').then(h => DUMMY = h);

const authErr = (res, e) => e instanceof A.Bad ? res.status(400).json({ error: e.message }) : null;

app.post('/api/auth/register', tooMany(3600_000, 10), wrap(async (req, res) => {
  try {
    const id = await A.createUser(req.body);
    const u = get(`SELECT ${USER_COLS} FROM users WHERE id=?`, id); startSession(res, u); res.json(meOf(u));
  } catch (e) { if (!authErr(res, e)) throw e; }
}));
app.post('/api/auth/login', tooMany(15 * 60_000, 10), wrap(async (req, res) => {
  const u = get(`SELECT ${USER_COLS} FROM users WHERE email=?`, String(req.body.email || '').trim().toLowerCase());
  const ok = await A.checkPw(String(req.body.password || '').slice(0, 128), u ? u.pass : DUMMY); // same work either way
  if (!u || !ok || u.banned) return res.status(401).json({ error: 'Wrong email or password.' });
  run('UPDATE users SET last_login=? WHERE id=?', new Date().toISOString(), u.id); startSession(res, u); res.json(meOf(u));
}));
app.post('/api/auth/logout', (req, res) => { setCookie(res, 'sid', '', 0); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { const u = sessionUser(req); res.json(u ? meOf(u) : { email: null }); });

// Password recovery by code, sent to Telegram or WhatsApp. The answer is always the same so nobody can use this to find out who has an account.
app.get('/api/auth/channels', (req, res) => res.json({ telegram: N.telegramBot(), whatsapp: N.whatsappOn }));
const phoneCodes = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' }), byCode = new Map();
  for (const country of getCountries()) {
    const code = '+' + getCountryCallingCode(country), countries = byCode.get(code) || [];
    countries.push(names.of(country) || country); byCode.set(code, countries);
  }
  return [...byCode].map(([code, countries]) => ({ name: countries.join(', '), code })).sort((a, b) => a.name.localeCompare(b.name));
})();
app.get('/api/phone-codes', (req, res) => res.json(phoneCodes));
const findUser = id => { id = String(id || '').trim(); const p = id.includes('@') ? null : A.normPhone(id);
  return id.includes('@') ? get('SELECT * FROM users WHERE email=?', id.toLowerCase()) : p ? get('SELECT * FROM users WHERE phone=?', p) : null; };
app.post('/api/auth/forgot', tooMany(3600_000, 5), (req, res) => {
  const u = findUser(req.body.identifier), ch = req.body.channel;
  if (u && !u.banned) {
    const tgOk = ch === 'telegram' && N.telegramBot() && u.telegram_chat_id, waOk = ch === 'whatsapp' && N.whatsappOn && u.phone;
    const code = (tgOk || waOk) && A.createOtp(u.id);
    const text = code && `Your password reset code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this message.`;
    if (code) (tgOk ? N.sendTelegram(u.telegram_chat_id, text) : N.sendWhatsApp(u.phone, code)).catch(e => console.error('code delivery failed:', e.message));
  }
  res.json({ ok: true });   // not awaited above, so timing does not reveal whether the account exists
});
app.post('/api/auth/reset-code', tooMany(15 * 60_000, 10), wrap(async (req, res) => {
  const u = findUser(req.body.identifier);
  try { if (u && !u.banned && await A.resetWithOtp(u.id, req.body.code, req.body.password)) return res.json({ ok: true }); }
  catch (e) { if (authErr(res, e)) return; throw e; }
  res.status(400).json({ error: 'That code is wrong or has expired. Request a new one.' });
}));
app.post('/api/auth/reset', tooMany(3600_000, 10), wrap(async (req, res) => {
  try { if (await A.consumeReset(req.body.token, req.body.password)) return res.json({ ok: true }); }
  catch (e) { if (authErr(res, e)) return; throw e; }
  res.status(400).json({ error: 'This reset link is invalid or has expired. Ask for a new one.' });
}));

// Signed-in account changes
app.post('/api/account', userAuth, (req, res) => {
  const phone = A.normPhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter your phone number with the country code, like +31 6 12345678.' });
  try { run('UPDATE users SET phone=?, telegram_chat_id=CASE WHEN phone IS ? THEN telegram_chat_id ELSE NULL END WHERE id=?', phone, phone, req.user.id); } catch { return res.status(400).json({ error: 'That phone number is already used by another account.' }); }
  res.json({ ...meOf(req.user), phone, telegram: phone === req.user.phone && !!req.user.telegram_chat_id });
});
app.post('/api/account/password', userAuth, tooMany(15 * 60_000, 10), wrap(async (req, res) => {
  if (!(await A.checkPw(String(req.body.current || '').slice(0, 128), req.user.pass))) return res.status(400).json({ error: 'Your current password is wrong.' });
  if (!A.validPw(req.body.password)) return res.status(400).json({ error: 'Password must be 8–128 characters.' });
  run('UPDATE users SET pass=?, sess_ver=sess_ver+1 WHERE id=?', await A.hashPw(req.body.password), req.user.id);
  startSession(res, { id: req.user.id, sess_ver: req.user.sess_ver + 1 }); res.json({ ok: true });  // other devices are signed out
}));

// ---------- provider & services ----------
async function provider(params) {
  const r = await fetch(E.PROVIDER_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ key: E.PROVIDER_API_KEY, ...params }), signal: AbortSignal.timeout(20_000), redirect: 'error' }); // never follow redirects: the key is in the body
  const d = await r.json(); if (d.error) throw new Error(d.error); return d;
}
const DEMO_SERVICES = [
  { service: 1, name: 'Followers - Real Looking', category: 'Instagram Followers', rate: '1.80', min: 100, max: 50000 },
  { service: 2, name: 'Likes - Instant', category: 'Instagram Likes', rate: '0.40', min: 50, max: 20000 },
  { service: 3, name: 'Page Followers', category: 'Facebook Followers', rate: '1.20', min: 100, max: 30000 },
  { service: 4, name: 'Post Likes', category: 'Facebook Likes', rate: '0.60', min: 50, max: 20000 },
  { service: 5, name: 'Subscribers', category: 'YouTube Subscribers', rate: '8.00', min: 50, max: 5000 },
  { service: 6, name: 'Followers', category: 'TikTok Followers', rate: '2.10', min: 100, max: 40000 }];
const PLATFORMS = [['Instagram', /insta|انستجرام|إنستجرام|انستغرام/i], ['Facebook', /facebook|فيسبوك|فيس بوك|\bfb\b/i], ['TikTok', /tik.?tok|تيك ?توك/i],
  ['YouTube', /youtube|يوتيوب/i], ['Twitter', /twitter|\bx\.com|تويتر/i], ['Telegram', /telegram|تيليجرام|تلغرام|تليجرام/i], ['Snapchat', /snap|سناب/i],
  ['WhatsApp', /whatsapp|واتساب|واتس/i], ['Spotify', /spotify/i], ['SoundCloud', /soundcloud/i], ['LinkedIn', /linkedin/i], ['Twitch', /twitch/i], ['Threads', /threads/i]];
const platformOf = (c = '') => (PLATFORMS.find(p => p[1].test(c)) || ['Other'])[0];
let cache = { at: 0, raw: [] };
async function getRaw() {
  if (Date.now() - cache.at < 600_000 && cache.raw.length) return cache.raw;
  // Only plain "link + quantity" services; types like Custom Comments need extra fields this store does not collect.
  const raw = DEMO ? DEMO_SERVICES : (await provider({ action: 'services' })).filter(x => !x.type || String(x.type).toLowerCase() === 'default');
  cache = { at: Date.now(), raw }; return raw;
}
async function getServices(includeHidden = false) {
  const st = settings();
  const list = (await getRaw()).map(s => {
    const id = Number(s.service), ov = st.overrides[id] || {}, cost = Number(s.rate) * RATE_MULT;
    return { id, name: ov.name || s.name, category: s.category, platform: platformOf(s.category + ' ' + s.name),
      min: Number(s.min), max: Number(s.max), cost, rate: +(ov.rate != null ? ov.rate : cost * (1 + st.markup)).toFixed(4),
      hidden: st.hidden.includes(id), custom: ov.rate != null };
  });
  return includeHidden ? list : list.filter(s => !s.hidden);
}
app.get('/api/services', wrap(async (req, res) => {
  const st = settings();
  try { res.json({ demo: DEMO, paused: st.paused, services: (await getServices()).map(({ cost, hidden, custom, ...s }) => s) }); }
  catch { res.status(502).json({ error: 'Could not load services. Try again soon.' }); }
}));

// ---------- orders ----------
const orderLimit = tooMany(60_000, 20);
app.post('/api/order', userAuth, needPhone, orderLimit, wrap(async (req, res) => {
  if (settings().paused) return res.status(503).json({ error: 'The store is paused for now. Please come back soon.' });
  const { serviceId, link } = req.body, qty = Number(req.body.quantity);
  const s = (await getServices()).find(x => x.id === Number(serviceId));
  if (!s) return res.status(400).json({ error: 'Choose a service.' });
  if (typeof link !== 'string' || link.length > 300 || !/^https?:\/\/[^\s<>"']+$/.test(link)) return res.status(400).json({ error: 'Enter a full link starting with https://' });
  if (!Number.isInteger(qty) || qty < s.min || qty > s.max) return res.status(400).json({ error: `Quantity must be between ${s.min} and ${s.max}.` });
  const price = Math.max(1, Math.ceil(s.rate * qty / 10)), cost = Math.round(s.cost * qty / 10); // cents
  let id;
  try { id = W.placeOrder(req.user.id, s, link, qty, price, cost); }
  catch (e) { if (e.message === 'INSUFFICIENT') return res.status(402).json({ error: 'Not enough balance. Add funds to continue.' }); throw e; }
  try {
    const r = DEMO ? { order: Math.floor(Math.random() * 1e6) } : await provider({ action: 'add', service: s.id, link, quantity: qty });
    run("UPDATE orders SET provider_id=?, status='Pending' WHERE id=?", String(r.order), id);
  } catch { W.refundOrder(id, 'Failed'); return res.status(502).json({ error: 'The order failed and your balance was returned.' }); }
  res.json({ id, balance: get('SELECT balance FROM users WHERE id=?', req.user.id).balance });
}));
async function refreshOrder(o) {
  if (['Completed', 'Canceled', 'Refunded', 'Failed'].includes(o.status) || !o.provider_id) return o;
  const st = DEMO ? { status: 'In progress' } : await provider({ action: 'status', order: o.provider_id });
  if (st.status === 'Canceled') W.refundOrder(o.id, 'Canceled'); else run('UPDATE orders SET status=? WHERE id=?', st.status, o.id);
  return get('SELECT * FROM orders WHERE id=?', o.id);
}
const pub = o => ({ id: o.id, service: o.service, quantity: o.quantity, price: o.price, status: o.status, created_at: o.created_at });
app.get('/api/orders', userAuth, (req, res) => res.json(all('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50', req.user.id).map(pub)));
app.post('/api/orders/:id/refresh', userAuth, wrap(async (req, res) => {
  const o = get('SELECT * FROM orders WHERE id=? AND user_id=?', req.params.id, req.user.id);
  if (!o) return res.status(404).json({ error: 'Order not found.' });
  try { res.json(pub(await refreshOrder(o))); } catch { res.status(502).json({ error: 'Status unavailable right now.' }); }
}));
app.get('/api/txns', userAuth, (req, res) => res.json(all('SELECT id,type,amount,method,status,note,created_at FROM txns WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id)));

// ---------- payments ----------
function amountOf(req, res) {
  const cents = Math.round(Number(req.body.amount) * 100);
  if (!Number.isFinite(cents) || cents < MIN_DEP * 100 || cents > MAX_DEP * 100) { res.status(400).json({ error: `Amount must be between ${MIN_DEP} and ${MAX_DEP}.` }); return null; }
  return cents;
}
app.get('/api/pay/methods', (req, res) => res.json({ currency: CUR.toUpperCase(), min: MIN_DEP, max: MAX_DEP, stripe: !!STRIPE,
  manual: settings().manual.map(({ id, name, instructions }) => ({ id, name, instructions })) }));

app.post('/api/pay/stripe', userAuth, needPhone, tooMany(3600_000, 20), wrap(async (req, res) => {
  if (!STRIPE) return res.status(400).json({ error: 'Card payments are not enabled.' });
  const cents = amountOf(req, res); if (!cents) return;
  const txn = W.newDeposit(req.user.id, cents, 'stripe', null);
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST',
    headers: { Authorization: 'Bearer ' + STRIPE, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ mode: 'payment', success_url: BASE + '/?paid=1', cancel_url: BASE + '/?paid=0',
      'line_items[0][price_data][currency]': CUR, 'line_items[0][price_data][product_data][name]': 'Wallet top-up',
      'line_items[0][price_data][unit_amount]': String(cents), 'line_items[0][quantity]': '1',
      client_reference_id: String(txn), customer_email: req.user.email }) });
  const s = await r.json();
  if (!r.ok || !s.url) { W.rejectDeposit(txn, 'Could not start checkout'); return res.status(502).json({ error: 'Card checkout is unavailable right now.' }); }
  run('UPDATE txns SET ref=? WHERE id=?', s.id, txn);
  res.json({ url: s.url });
}));
// Manual transfer (Sham Cash etc.): receipt image + transaction number + amount. Nothing is credited until an admin approves it.
app.post('/api/pay/manual', userAuth, needPhone, tooMany(3600_000, 20), (req, res) => {
  const m = settings().manual.find(x => x.id === req.body.method), ref = String(req.body.reference || '').trim();
  if (!m) return res.status(400).json({ error: 'Choose a payment method.' });
  if (ref.length < 4 || ref.length > 80) return res.status(400).json({ error: 'Enter the transaction number (4–80 characters).' });
  const cents = amountOf(req, res); if (!cents) return;
  if (get("SELECT COUNT(*) n FROM txns WHERE user_id=? AND type='deposit' AND status='pending'", req.user.id).n >= 5)
    return res.status(400).json({ error: 'You already have 5 payments waiting for review. Please wait for them to be checked.' });
  let rc; try { rc = R.parse(req.body.receipt); } catch (e) { return res.status(400).json({ error: e.message }); }
  const file = R.save(rc);
  try { W.newDeposit(req.user.id, cents, 'manual:' + m.id, ref, m.name, file, rc.hash); }
  catch (e) { R.remove(file); return res.status(400).json({ error: /receipt/.test(e.message) ? 'This receipt image was already submitted.' : 'That transaction number was already used.' }); }
  res.json({ ok: true });
});
// ---------- admin ----------
const admin = express.Router();
admin.post('/login', tooMany(15 * 60_000, 8), (req, res) => {
  if (!E.ADMIN_PASSWORD) return res.status(500).json({ error: 'Set ADMIN_PASSWORD in .env first.' });
  if (!eq(String(req.body.password || ''), E.ADMIN_PASSWORD)) return res.status(401).json({ error: 'Wrong password.' });
  setCookie(res, 'adm', token('a', 'admin', 8 * 3600_000), 8 * 3600); res.json({ ok: true });
});
admin.post('/logout', (req, res) => { setCookie(res, 'adm', '', 0); res.json({ ok: true }); });
admin.use((req, res, next) => readToken(cookies(req).adm, 'a') ? next() : res.status(401).json({ error: 'Please sign in.' }));

admin.get('/stats', wrap(async (req, res) => {
  const day = new Date(Date.now() - 864e5).toISOString();
  const o = get("SELECT COUNT(*) n, COALESCE(SUM(price),0) rev, COALESCE(SUM(cost),0) cost FROM orders WHERE status NOT IN ('Failed','Canceled','Refunded')");
  let balance = null; try { balance = DEMO ? { balance: '25.00', currency: 'USD' } : await provider({ action: 'balance' }); } catch {}
  res.json({ demo: DEMO, orders: o.n, revenue: o.rev, cost: o.cost, profit: o.rev - o.cost,
    today: get("SELECT COALESCE(SUM(price),0) s FROM orders WHERE created_at>? AND status NOT IN ('Failed','Canceled','Refunded')", day).s,
    users: get('SELECT COUNT(*) n FROM users').n, wallets: get('SELECT COALESCE(SUM(balance),0) s FROM users').s,
    deposits: get("SELECT COALESCE(SUM(amount),0) s FROM txns WHERE type='deposit' AND status='completed'").s,
    pending: get("SELECT COUNT(*) n FROM txns WHERE type='deposit' AND status='pending' AND method LIKE 'manual:%'").n, balance });
}));
const userRow = id => get(`SELECT u.id,u.public_id,u.email,u.phone,u.telegram_chat_id IS NOT NULL telegram,u.balance,u.banned,u.created_at,u.last_login,
  (SELECT COUNT(*) FROM orders WHERE user_id=u.id) orders,
  (SELECT COALESCE(SUM(amount),0) FROM txns WHERE user_id=u.id AND type='deposit' AND status='completed') deposited FROM users u WHERE u.id=?`, id);
// Search by email, phone, user ID (U1234567) or the internal number
admin.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase(), ph = q.replace(/[\s\-().]/g, '');
  res.json(all(`SELECT u.id,u.public_id,u.email,u.phone,u.telegram_chat_id IS NOT NULL telegram,u.balance,u.banned,u.created_at,u.last_login,
    (SELECT COUNT(*) FROM orders WHERE user_id=u.id) orders,
    (SELECT COALESCE(SUM(amount),0) FROM txns WHERE user_id=u.id AND type='deposit' AND status='completed') deposited
    FROM users u WHERE ?='' OR u.email LIKE ? OR u.public_id LIKE ? OR (?!='' AND u.phone LIKE ?) OR CAST(u.id AS TEXT)=?
    ORDER BY u.id DESC LIMIT 500`, q, `%${q}%`, `%${q}%`, ph, `%${ph}%`, q));
});
// Edit any user: email, phone, ban status, new password
admin.put('/users/:id', wrap(async (req, res) => {
  const id = Number(req.params.id), u = get('SELECT id,phone FROM users WHERE id=?', Number(req.params.id)), b = req.body;
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const sets = [], vals = [];
  if (b.email !== undefined) { const e = String(b.email).trim().toLowerCase(); if (!A.validEmail(e)) return res.status(400).json({ error: 'Enter a valid email.' }); sets.push('email=?'); vals.push(e); }
  if (b.phone !== undefined) { const p = String(b.phone).trim() ? A.normPhone(b.phone) : null; if (String(b.phone).trim() && !p) return res.status(400).json({ error: 'Phone must include the country code, like +31 6 12345678.' }); sets.push('phone=?'); vals.push(p); if (p !== u.phone) sets.push('telegram_chat_id=NULL'); }
  if (b.banned !== undefined) { sets.push('banned=?'); vals.push(b.banned ? 1 : 0); if (b.banned) sets.push('sess_ver=sess_ver+1'); }
  if (b.password) { if (!A.validPw(b.password)) return res.status(400).json({ error: 'Password must be 8–128 characters.' }); sets.push('pass=?', 'sess_ver=sess_ver+1'); vals.push(await A.hashPw(b.password)); }
  if (!sets.length) return res.json(userRow(id));
  try { run(`UPDATE users SET ${sets.join(',')} WHERE id=?`, ...vals, id); } catch { return res.status(400).json({ error: 'That email or phone number belongs to another account.' }); }
  res.json(userRow(id));
}));
admin.post('/users/:id/reset-link', (req, res) => {
  if (!get('SELECT 1 FROM users WHERE id=?', Number(req.params.id))) return res.status(404).json({ error: 'User not found.' });
  res.json({ link: `${BASE}/?reset=${A.createReset(Number(req.params.id))}`, expires: '1 hour' });
});
admin.post('/users/:id/signout', (req, res) => { run('UPDATE users SET sess_ver=sess_ver+1 WHERE id=?', Number(req.params.id)); res.json({ ok: true }); });
admin.post('/users/:id/adjust', (req, res) => {
  const cents = Math.round(Number(req.body.amount) * 100), note = String(req.body.note || '').slice(0, 200);
  if (!Number.isFinite(cents) || cents === 0 || Math.abs(cents) > 1e7) return res.status(400).json({ error: 'Enter an amount.' });
  try { W.adjust(Number(req.params.id), cents, note || 'Admin adjustment'); res.json({ ok: true }); }
  catch { res.status(400).json({ error: 'That would make the balance negative.' }); }
});
admin.get('/txns', (req, res) => {
  const { status = '', type = '' } = req.query;
  res.json(all(`SELECT t.*, u.email, u.public_id FROM txns t JOIN users u ON u.id=t.user_id
    WHERE (?='' OR t.status=?) AND (?='' OR t.type=?) ORDER BY t.id DESC LIMIT 500`, status, status, type, type));
});
admin.get('/txns/:id/receipt', (req, res) => {
  const t = get('SELECT receipt FROM txns WHERE id=?', Number(req.params.id));
  if (!t || !t.receipt) return res.status(404).json({ error: 'No receipt for this payment.' });
  res.set('Cache-Control', 'private, no-store'); res.sendFile(R.pathOf(t.receipt));
});
// Approve (optionally with a corrected amount) or reject with a reason the user will see. The user is told on Telegram if connected.
admin.post('/txns/:id/:act', (req, res) => {
  const id = Number(req.params.id), t = get('SELECT t.*, u.telegram_chat_id tg FROM txns t JOIN users u ON u.id=t.user_id WHERE t.id=?', id);
  if (!t) return res.status(404).json({ error: 'Payment not found.' });
  let ok = false, msg = '';
  if (req.params.act === 'approve') {
    const cents = req.body.amount === undefined ? undefined : Math.round(Number(req.body.amount) * 100);
    if (cents !== undefined && !(cents > 0 && cents <= MAX_DEP * 1000)) return res.status(400).json({ error: 'Enter a valid amount.' });
    ok = W.completeDeposit(id, 'Approved by admin', cents); msg = `Your payment was approved. ${$(cents || t.amount)} ${CUR.toUpperCase()} was added to your balance.`;
  } else if (req.params.act === 'reject') {
    const why = String(req.body.note || '').trim().slice(0, 200);
    ok = W.rejectDeposit(id, why ? 'Rejected: ' + why : 'Rejected by admin'); msg = `Your payment was rejected.${why ? ' Reason: ' + why : ''} Contact support if this is a mistake.`;
  }
  if (!ok) return res.status(400).json({ error: 'This payment is no longer pending.' });
  if (t.tg && N.telegramBot()) N.sendTelegram(t.tg, msg).catch(() => {});
  res.json({ ok });
});
admin.get('/orders', (req, res) => res.json(all('SELECT o.*, u.email, u.public_id FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 500')));
const orderOf = (req, res) => { const o = get('SELECT * FROM orders WHERE id=?', req.params.id); if (!o) res.status(404).json({ error: 'Order not found.' }); return o; };
admin.post('/orders/:id/refresh', wrap(async (req, res) => {
  const o = orderOf(req, res); if (!o) return;
  try { res.json(await refreshOrder(o)); } catch (e) { res.status(502).json({ error: 'Provider did not answer: ' + e.message }); }
}));
admin.post('/orders/:id/cancel', wrap(async (req, res) => {
  const o = orderOf(req, res); if (!o) return;
  try { if (!DEMO && o.provider_id) await provider({ action: 'cancel', orders: o.provider_id }); } catch (e) { return res.status(502).json({ error: 'Provider refused: ' + e.message }); }
  W.refundOrder(o.id, 'Canceled'); res.json(get('SELECT * FROM orders WHERE id=?', o.id));
}));
admin.post('/orders/:id/refund', (req, res) => { const o = orderOf(req, res); if (!o) return; W.refundOrder(o.id, 'Refunded'); res.json(get('SELECT * FROM orders WHERE id=?', o.id)); });

admin.get('/services', wrap(async (req, res) => {
  try { res.json({ settings: settings(), services: await getServices(true) }); } catch { res.status(502).json({ error: 'Could not load provider services.' }); }
}));
admin.post('/services/refresh', (req, res) => { cache.at = 0; res.json({ ok: true }); });
admin.put('/services/:id', (req, res) => {
  const id = Number(req.params.id), st = settings(), { hidden, rate, name } = req.body;
  if (hidden !== undefined) st.hidden = hidden ? [...new Set([...st.hidden, id])] : st.hidden.filter(x => x !== id);
  if (rate !== undefined || name !== undefined) {
    const ov = st.overrides[id] || {};
    if (rate === null) delete ov.rate; else if (rate !== undefined) { if (!(Number(rate) >= 0)) return res.status(400).json({ error: 'Enter a valid price.' }); ov.rate = Number(rate); }
    if (name !== undefined) { if (name) ov.name = String(name).slice(0, 120); else delete ov.name; }
    if (Object.keys(ov).length) st.overrides[id] = ov; else delete st.overrides[id];
  }
  saveSettings(st); res.json({ ok: true });
});
admin.put('/settings', (req, res) => {
  const st = settings(), { markup, paused, manual } = req.body;
  if (markup !== undefined) { if (!(markup >= 0 && markup <= 20)) return res.status(400).json({ error: 'Markup must be between 0 and 20.' }); st.markup = Number(markup); }
  if (paused !== undefined) st.paused = !!paused;
  if (Array.isArray(manual)) st.manual = manual.slice(0, 10).filter(m => m.name && m.instructions).map((m, i) => ({
    id: m.id || crypto.randomBytes(3).toString('hex'), name: String(m.name).slice(0, 60), instructions: String(m.instructions).slice(0, 500) }));
  saveSettings(st); res.json(st);
});
app.use('/api/admin', admin);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong. Please try again.' }); });
app.listen(PORT, () => { console.log(`${BASE}${DEMO ? '  (demo services: no provider key set)' : ''}`); N.startTelegram(); });
