// All money movement lives here. Amounts are integer cents. Every change is one DB transaction.
const crypto = require('crypto');
const { get, run, tx } = require('./db');
const now = () => new Date().toISOString();

const addTxn = (userId, type, amount, method, ref, status, note, receipt, rhash) =>
  Number(run('INSERT INTO txns(user_id,type,amount,method,ref,status,note,created_at,receipt,receipt_hash) VALUES(?,?,?,?,?,?,?,?,?,?)',
    userId, type, amount, method, ref ?? null, status, note ?? null, now(), receipt ?? null, rhash ?? null).lastInsertRowid);

const newDeposit = (userId, cents, method, ref, note, receipt, rhash) => addTxn(userId, 'deposit', cents, method, ref, 'pending', note, receipt, rhash);

// Pending -> completed, credits the wallet. Safe to call twice (webhooks retry).
// An admin may credit a different amount than requested when the receipt shows something else.
function completeDeposit(txnId, note, amountCents) {
  return tx(() => {
    const t = get("SELECT * FROM txns WHERE id=? AND type='deposit'", txnId);
    if (!t || t.status !== 'pending') return false;
    const amt = amountCents > 0 ? amountCents : t.amount;
    run("UPDATE txns SET status='completed', amount=?, note=COALESCE(?,note) WHERE id=?", amt, note ?? null, txnId);
    run('UPDATE users SET balance=balance+? WHERE id=?', amt, t.user_id);
    return true;
  });
}
function rejectDeposit(txnId, note) {
  return run("UPDATE txns SET status='rejected', note=COALESCE(?,note) WHERE id=? AND type='deposit' AND status='pending'", note ?? null, txnId).changes > 0;
}
// Admin correction, positive or negative. Throws if it would make the balance negative.
function adjust(userId, cents, note) {
  return tx(() => {
    run('UPDATE users SET balance=balance+? WHERE id=?', cents, userId);
    addTxn(userId, 'adjust', cents, 'admin', null, 'completed', note);
  });
}
// Charge the wallet and create the order in one step. Throws 'INSUFFICIENT' without balance.
function placeOrder(userId, svc, link, qty, price, cost) {
  const id = crypto.randomBytes(5).toString('hex');
  tx(() => {
    const r = run('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?', price, userId, price);
    if (r.changes === 0) throw new Error('INSUFFICIENT');
    run('INSERT INTO orders(id,user_id,service_id,service,link,quantity,price,cost,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, userId, svc.id, svc.name, link, qty, price, cost, 'Processing', now());
    addTxn(userId, 'order', -price, 'wallet', id, 'completed', svc.name);
  });
  return id;
}
// Give the money back once; no-op if the order was already refunded or failed.
function refundOrder(orderId, status) {
  return tx(() => {
    const o = get('SELECT * FROM orders WHERE id=?', orderId);
    if (!o || ['Failed', 'Canceled', 'Refunded'].includes(o.status)) return false;
    run('UPDATE orders SET status=? WHERE id=?', status, orderId);
    run('UPDATE users SET balance=balance+? WHERE id=?', o.price, o.user_id);
    addTxn(o.user_id, 'refund', o.price, 'wallet', orderId, 'completed', `${status}: ${o.service}`);
    return true;
  });
}
module.exports = { newDeposit, completeDeposit, rejectDeposit, adjust, placeOrder, refundOrder };
