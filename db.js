// SQLite storage. Uses better-sqlite3 if installed, otherwise Node 22's built-in node:sqlite.
const fs = require('fs'), path = require('path');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const file = process.env.DB_FILE || path.join(__dirname, 'data', 'store.db');
let db;
try { db = new (require('better-sqlite3'))(file); }
catch { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(file); }

db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),   -- cents; the DB itself refuses overdrafts
  banned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login TEXT);
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), provider_id TEXT,
  service_id INTEGER, service TEXT, link TEXT, quantity INTEGER,
  price INTEGER NOT NULL, cost INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS txns(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,            -- deposit | order | refund | adjust
  amount INTEGER NOT NULL, method TEXT, ref TEXT,
  status TEXT NOT NULL,          -- pending | completed | rejected
  note TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS txn_ref ON txns(method, ref) WHERE ref IS NOT NULL AND type='deposit';
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS txns_user ON txns(user_id);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

const get = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
const defaults = { markup: Number(process.env.MARKUP || 0.5), paused: false, hidden: [], overrides: {},
  manual: [{ id: 'shamcash', name: 'Sham Cash', instructions: 'Send the amount to our Sham Cash account' + (process.env.SHAMCASH_ACCOUNT ? ': ' + process.env.SHAMCASH_ACCOUNT : '') + '. Then upload the transfer notification, the transaction number and the amount you sent.' }] };
const settings = () => { const r = get("SELECT v FROM kv WHERE k='settings'"); return { ...defaults, ...(r ? JSON.parse(r.v) : {}) }; };
const saveSettings = s => run("INSERT INTO kv(k,v) VALUES('settings',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify(s));


// ---- migrations (safe to run on an existing database) ----
const crypto = require('crypto');
const newPublicId = () => { for (;;) { const id = 'U' + crypto.randomInt(1000000, 10000000); if (!get('SELECT 1 FROM users WHERE public_id=?', id)) return id; } };
const have = all('PRAGMA table_info(users)').map(c => c.name);
if (!have.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
if (!have.includes('public_id')) db.exec('ALTER TABLE users ADD COLUMN public_id TEXT');
if (!have.includes('telegram_chat_id')) db.exec('ALTER TABLE users ADD COLUMN telegram_chat_id TEXT');
if (!have.includes('sess_ver')) db.exec('ALTER TABLE users ADD COLUMN sess_ver INTEGER NOT NULL DEFAULT 0');
const tcols = all('PRAGMA table_info(txns)').map(c => c.name);
if (!tcols.includes('receipt')) db.exec('ALTER TABLE txns ADD COLUMN receipt TEXT');
if (!tcols.includes('receipt_hash')) db.exec('ALTER TABLE txns ADD COLUMN receipt_hash TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS txn_receipt ON txns(receipt_hash) WHERE receipt_hash IS NOT NULL');
all('SELECT id FROM users WHERE public_id IS NULL').forEach(u => run('UPDATE users SET public_id=? WHERE id=?', newPublicId(), u.id));
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_public_id ON users(public_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_phone ON users(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_tg ON users(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS otps(user_id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_sent INTEGER NOT NULL, day_start INTEGER NOT NULL, day_count INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS resets(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);`);

module.exports = { db, get, all, run, tx, settings, saveSettings, newPublicId };
