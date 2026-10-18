# Boost – SMM store (Node.js)

## Run
1. `npm install`   (needs Node 22.5 or newer)
2. `cp .env.example .env` and fill it in
3. `npm start` → http://localhost:3000  (admin: /admin.html)

With no provider key you get demo services. Payments must use a configured real payment method.

## How money works
Customers add funds to a wallet first. Orders are paid from the wallet inside one database
transaction, and the provider is only called after payment. If the provider fails, the money returns automatically.
Amounts are stored as integer cents and the database refuses negative balances.

## Payment methods
- Card via Stripe Checkout: set STRIPE_SECRET_KEY, and add a Stripe webhook to
  https://YOUR-SITE/api/pay/stripe/webhook (event: checkout.session.completed), then set STRIPE_WEBHOOK_SECRET.
- Manual methods (bank transfer, e-wallets, crypto address): add them in Admin → Settings.
  Customers send money and enter a reference; you approve it in Admin → Payments.
  A reference can only be used once.

## Accounts
Sign-up needs email, phone (international format) and a password. Every user gets a unique ID like U1234567, shown to the
user (My account) and to the admin. Orders and payments need a phone number on the account.
Password recovery: the user enters their phone number (or email) and picks Telegram or WhatsApp. A 6-digit code is sent,
valid 10 minutes, 5 guesses, 1 code per minute, 5 per day per account.
- **Telegram (recommended, free):** create a bot with @BotFather, set TELEGRAM_BOT_TOKEN. The user opens the bot once and taps
  "Share my phone number"; Telegram vouches for the number, so this also verifies it. Changing the phone unlinks Telegram.
- **WhatsApp (optional, paid per message):** needs a Meta WhatsApp Business account, the Cloud API token/phone ID, and an approved
  "authentication" message template (one {{1}} code placeholder plus a copy-code button). Set the four WHATSAPP_* values.
- If neither works for a user, an admin can create a one-hour reset link from the Users screen and send it themselves.
Changing or resetting a password signs out every other device.

## Admin
Overview, Users (search by ID/email/phone, edit email/phone/password/ban, reset link, sign out devices, adjust balance), Payments (every wallet movement, approve/reject), Orders (refresh/cancel/refund),
Services (rename, price, hide), Settings (markup, pause, payment methods).

## Security included
Helmet headers with a strict CSP (no inline scripts or styles), HttpOnly SameSite=Strict signed cookies (Secure in production),
CSRF header check on every write, scrypt password hashing, constant-time comparisons, rate limits on login/register/payments/orders,
body size limits, input validation, HTML escaping everywhere, atomic wallet operations, webhook signature check,
provider key and your costs never reach the browser, production refuses to start with weak secrets.

## Go-live checklist
NODE_ENV=production, HTTPS (set BASE_URL, TRUST_PROXY=1 behind a proxy, FORCE_HTTPS=1), strong ADMIN_PASSWORD and SESSION_SECRET,
back up data/store.db regularly, and keep the admin URL private.
