# Share2.io — NFC Card Store (Razorpay Curlec)

A single-page storefront (`index.html`) plus a tiny payment backend (`server.js`) that
accepts real payments through **Razorpay Curlec** (FPX, cards, and e-wallets) in MYR.

Why a backend is needed: Curlec **auto-refunds any payment made without a server-created
`order_id`**, and the payment signature must be verified with your **secret key** — which
can never live in the browser. The backend handles exactly those two things and nothing else.

---

## Files

| File | What it is |
|------|------------|
| `index.html` | The storefront — products, cart, delivery form, Curlec checkout. Edit the `CONFIG` block at the top. |
| `server.js` | Node/Express backend — creates orders (with a server-side price table) and verifies payments. |
| `package.json` | Backend dependencies. |
| `.gitignore` | Keeps `.env` and `node_modules` out of version control. |

---

## 1. Preview the storefront (no payment)

Just open `index.html` in a browser. Everything works — product selection, cart totals,
form validation — except the final payment, which stays in **preview mode** until the
backend is connected. This is normal and safe.

> Note: the live payment window and web fonts won't load inside the Claude artifact preview.
> Download the file and open it (or deploy it) to see the finished result.

---

## 2. Run the payment backend

You need Node.js 18+.

```bash
npm install

# Your keys — get the SECRET from the Curlec Dashboard (Account & Settings → API Keys).
# Never commit these or put the secret in index.html.
export RZP_KEY_ID="rzp_live_SsLxQHaLvXNKd7"
export RZP_KEY_SECRET="your_secret_key_here"

npm start          # → runs on http://localhost:3000
```

Confirm it's up: open `http://localhost:3000/health` → `{"ok":true,...}`.

For a real deployment, host `server.js` anywhere that runs Node (Render, Railway, Fly.io,
a VPS, etc.) and set `RZP_KEY_ID` / `RZP_KEY_SECRET` as environment variables there.

---

## 3. Connect the storefront to the backend

In `index.html`, set `BACKEND_URL` in the `CONFIG` block to your server's address:

```js
const CONFIG = {
  RAZORPAY_KEY_ID: "rzp_live_SsLxQHaLvXNKd7",  // public — fine to expose
  BACKEND_URL:     "https://your-server-url",   // ← your deployed backend
  ...
};
```

**Simplest option:** drop `index.html` into a `public/` folder next to `server.js`
(`server.js` already serves that folder). Then the site and API share one URL, and you can
set `BACKEND_URL: ""` … *actually*, keep it pointing at the same origin, e.g. your domain.

---

## 4. Test before going live

Curlec strongly recommends a full test run first:

1. In the Dashboard, switch to **Test Mode** and generate **test** API keys.
2. Temporarily use the test key id in `index.html` and the test secret on the server.
3. Place an order using a Curlec **test card / test FPX bank** (see their docs).
4. Confirm the payment shows as **Captured** in Dashboard → Transactions → Payments.
5. Switch both back to your **live** keys.

**Go-live checklist**
- [ ] Test payment succeeded and showed **Captured**.
- [ ] **Auto-capture** is enabled in the Dashboard (otherwise authorised payments auto-refund).
- [ ] Live secret key is set only on the server (env var), never in `index.html`.
- [ ] `.env` is **not** committed to git.
- [ ] Prices in `index.html` match the `PRODUCTS` table in `server.js`.

---

## Prices (single source of truth)

Both files must agree. Amounts in `server.js` are in **sen** (1 MYR = 100 sen).

| Product id | Plan | Design | Price |
|------------|------|--------|-------|
| `pro_template`  | Pro  | 5 templates | RM 138 |
| `pro_custom`    | Pro  | Custom branding | RM 438 |
| `team_template` | Team | 5 templates | RM 238 |
| `team_custom`   | Team | Custom branding | RM 588 |

To change a price, edit it in **both** the `PRODUCTS` object in `index.html` **and**
`server.js`. The server value is what actually gets charged.

---

## Security notes

- **Key id vs secret.** `rzp_live_...` (the key id) is *public* — it's meant to sit in the
  browser. The **secret** is what proves a payment is real; keep it server-only.
- **Amounts are computed server-side.** The browser only sends product ids + quantities.
  A tampered price in the browser has no effect — `server.js` recalculates from its own table.
- **Every payment is verified.** The backend checks the HMAC-SHA256 signature before it's
  treated as paid.

---

## Nice next steps (optional — happy to build these)

- **Order confirmation emails** + a webhook so paid orders are recorded even if the buyer
  closes the tab mid-redirect.
- **FPX redirect flow** (`callback_url`) for the most reliable Malaysian bank-transfer
  experience — the current popup flow covers cards and e-wallets well.
- **中文 / Bahasa Melayu** language switcher, matching your `nfc.html` landing page.
- **Product photos** of the actual card designs on each option.

---

*Questions on the build: reply here. Questions on payouts, settlement, or FPX approvals:
Razorpay Curlec support.*
