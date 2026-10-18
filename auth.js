// Accounts, passwords and reset links. No Express in here, so it can be tested on its own.
const crypto = require('crypto'), { promisify } = require('util');
const { get, run, tx, newPublicId } = require('./db');
const scrypt = promisify(crypto.scrypt);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const validEmail = e => typeof e === 'string' && e.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
// International format, e.g. +31612345678. Spaces, dashes and brackets are ignored; 00 becomes +.
function normPhone(p) {
  let s = String(p || '').replace(/[\s\-().]/g, ''); if (s.startsWith('00')) s = '+' + s.slice(2);
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}
const validPw = p => typeof p === 'string' && p.length >= 8 && p.length <= 128;

const hashPw = async pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + (await scrypt(pw, s, 64)).toString('hex'); };
const checkPw = async (pw, h) => { const [s, k] = h.split(':'); return eq((await scrypt(pw, Buffer.from(s, 'hex'), 64)).toString('hex'), k); };

class Bad extends Error {}
async function createUser({ email, phone, password }) {
  email = String(email || '').trim().toLowerCase(); const ph = normPhone(phone);
  if (!validEmail(email)) throw new Bad('Enter a valid email.');
  if (!ph) throw new Bad('Enter your phone number with the country code, like +31 6 12345678.');
  if (!validPw(password)) throw new Bad('Password must be 8–128 characters.');
  try { return Number(run('INSERT INTO users(email,phone,pass,public_id,created_at) VALUES(?,?,?,?,?)', email, ph, await hashPw(password), newPublicId(), new Date().toISOString()).lastInsertRowid); }
  catch { throw new Bad('An account with this email or phone number already exists. Try signing in.'); }
}
// One active link per user, valid for an hour, usable once. Only a hash is stored.
function createReset(userId, ttlMs = 3600_000) {
  const t = crypto.randomBytes(32).toString('base64url');
  run('DELETE FROM resets WHERE user_id=?', userId);
  run('INSERT INTO resets(token_hash,user_id,expires_at) VALUES(?,?,?)', sha(t), userId, Date.now() + ttlMs);
  return t;
}
async function consumeReset(token, newPw) {
  if (!validPw(newPw)) throw new Bad('Password must be 8–128 characters.');
  const h = sha(String(token || '')), r = get('SELECT * FROM resets WHERE token_hash=? AND used=0 AND expires_at>?', h, Date.now());
  if (!r) return false;
  const ph = await hashPw(newPw);
  return tx(() => {
    if (run('UPDATE resets SET used=1 WHERE token_hash=? AND used=0', h).changes === 0) return false;
    run('UPDATE users SET pass=?, sess_ver=sess_ver+1 WHERE id=?', ph, r.user_id); // signs out every device
    return true;
  });
}
// ---- 6-digit reset codes sent by Telegram / WhatsApp ----
// Valid 10 minutes, 5 guesses, one new code per minute, 5 codes per 24h per account.
function createOtp(userId) {
  const now = Date.now(), r = get('SELECT * FROM otps WHERE user_id=?', userId);
  if (r && now - r.last_sent < 60_000) return null;
  const fresh = r && now - r.day_start < 86400_000;
  if (fresh && r.day_count >= 5) return null;
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  run(`INSERT INTO otps(user_id,code_hash,expires_at,attempts,last_sent,day_start,day_count) VALUES(?,?,?,0,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,last_sent=excluded.last_sent,day_start=excluded.day_start,day_count=excluded.day_count`,
    userId, sha(`${userId}:${code}`), now + 600_000, now, fresh ? r.day_start : now, fresh ? r.day_count + 1 : 1);
  return code;
}
async function resetWithOtp(userId, code, newPw) {
  if (!validPw(newPw)) throw new Bad('Password must be 8–128 characters.');
  const r = get('SELECT * FROM otps WHERE user_id=?', userId);
  if (!r || r.expires_at < Date.now() || r.attempts >= 5) return false;
  run('UPDATE otps SET attempts=attempts+1 WHERE user_id=?', userId);          // every guess counts, right or wrong
  if (!eq(sha(`${userId}:${String(code || '').trim()}`), r.code_hash)) return false;
  const ph = await hashPw(newPw);
  return tx(() => {
    if (run('DELETE FROM otps WHERE user_id=? AND code_hash=?', userId, r.code_hash).changes === 0) return false;
    run('UPDATE users SET pass=?, sess_ver=sess_ver+1 WHERE id=?', ph, userId);
    return true;
  });
}
module.exports = { createOtp, resetWithOtp, Bad, validEmail, normPhone, validPw, hashPw, checkPw, createUser, createReset, consumeReset, eq };
