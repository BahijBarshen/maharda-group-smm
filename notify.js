// Telegram bot (links a user's verified phone number to their chat) and WhatsApp Cloud API sending.
const { get, run } = require('./db'), A = require('./auth');
const E = process.env, TOKEN = E.TELEGRAM_BOT_TOKEN, state = { bot: null };
const whatsappOn = !!(E.WHATSAPP_TOKEN && E.WHATSAPP_PHONE_ID && E.WHATSAPP_TEMPLATE);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tg(method, body = {}, timeout = 15000) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const d = await r.json(); if (!d.ok) throw new Error(d.description || 'Telegram error'); return d.result;
}
const sendTelegram = (chatId, text, extra = {}) => tg('sendMessage', { chat_id: chatId, text, ...extra });

// WhatsApp needs an approved "authentication" template with one {{1}} placeholder and a copy-code button.
async function sendWhatsApp(phone, code) {
  const r = await fetch(`https://graph.facebook.com/v20.0/${E.WHATSAPP_PHONE_ID}/messages`, { method: 'POST',
    headers: { Authorization: 'Bearer ' + E.WHATSAPP_TOKEN, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone.replace(/^\+/, ''), type: 'template', template: {
      name: E.WHATSAPP_TEMPLATE, language: { code: E.WHATSAPP_LANG || 'en_US' }, components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }] } }) });
  if (!r.ok) throw new Error(`WhatsApp ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// The user taps "Share my phone number" in the bot. Telegram vouches for the number, so it counts as verified.
function linkContact(msg) {
  const c = msg.contact;
  if (!c || msg.chat.type !== 'private') return { error: 'ignored' };
  if (c.user_id !== msg.from.id) return { error: 'not-yours' };            // someone forwarding another person's contact
  const phone = A.normPhone('+' + String(c.phone_number).replace(/^\+/, ''));
  const u = phone && get('SELECT id,public_id,banned FROM users WHERE phone=?', phone);
  if (!u || u.banned) return { error: 'no-account' };
  run('UPDATE users SET telegram_chat_id=NULL WHERE telegram_chat_id=?', String(msg.chat.id));
  run('UPDATE users SET telegram_chat_id=? WHERE id=?', String(msg.chat.id), u.id);
  return { user: u };
}
const ASK = { reply_markup: { keyboard: [[{ text: 'Share my phone number', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } };
async function onMessage(msg) {
  if (msg.contact) {
    const r = linkContact(msg);
    if (r.user) return sendTelegram(msg.chat.id, `Connected. Your user ID is ${r.user.public_id}. If you forget your password, choose Telegram on the sign-in page and we will send the code here.`, { reply_markup: { remove_keyboard: true } });
    if (r.error === 'not-yours') return sendTelegram(msg.chat.id, 'Please share your own phone number using the button.', ASK);
    if (r.error === 'no-account') return sendTelegram(msg.chat.id, 'No account uses this phone number. Create an account on the website with this number first, then come back.');
    return;
  }
  if (msg.chat.type === 'private') return sendTelegram(msg.chat.id, 'Tap the button to connect your account. We match it to the phone number you registered with.', ASK);
}
async function startTelegram() {
  if (!TOKEN) return;
  try { state.bot = (await tg('getMe')).username; await tg('deleteWebhook'); console.log(`Telegram bot @${state.bot} is running`); }
  catch (e) { return console.error('Telegram setup failed:', e.message); }
  let offset = 0;
  for (;;) {
    try {
      for (const u of await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 40000)) {
        offset = u.update_id + 1; if (u.message) await onMessage(u.message).catch(e => console.error('telegram:', e.message));
      }
    } catch (e) { console.error('telegram poll:', e.message); await sleep(5000); }
  }
}
module.exports = { sendTelegram, sendWhatsApp, startTelegram, linkContact, whatsappOn, telegramBot: () => state.bot };
