/**
 * Share2.io NFC Store — minimal payment backend for Razorpay Curlec
 * -----------------------------------------------------------------
 * Does two things securely:
 *   1) POST /create-order   → creates an order with a SERVER-SIDE price table
 *                             (so the amount can never be tampered from the browser)
 *   2) POST /verify-payment → verifies the payment signature after checkout
 *
 * Your SECRET key is read from an environment variable and is NEVER sent to
 * the browser. The public key id (rzp_live_...) lives in index.html — that one
 * is meant to be public.
 *
 * Setup:
 *   npm install
 *   export RZP_KEY_ID="rzp_live_SsLxQHaLvXNKd7"
 *   export RZP_KEY_SECRET="your_secret_from_the_curlec_dashboard"
 *   node server.js
 *
 * Then, in index.html, set:  BACKEND_URL: "https://your-server-url"
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const Razorpay = require("razorpay");
const db = require("./db");
const adminRouter = require("./admin");

const KEY_ID = process.env.RZP_KEY_ID;
const KEY_SECRET = process.env.RZP_KEY_SECRET;

let razorpay = null;
if (KEY_ID && KEY_SECRET) {
  razorpay = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
  console.log("[config] Razorpay keys loaded — payments enabled.");
} else {
  console.warn("[config] RZP_KEY_ID / RZP_KEY_SECRET not set. The app will still run and /health will work, but payment endpoints return an error until you add both in cPanel (Environment variables) and Restart.");
}

const RM = (sen) => "RM" + (sen / 100).toFixed(2);

/* -----------------------------------------------------------------
   SOURCE-OF-TRUTH PRICES (in sen; 1 MYR = 100 sen).
   Must match the PLAN object in index.html.
   The browser only sends product ids + quantities; the amount is
   always calculated here.

   Every checkout is a ONE-TIME payment, not a subscription — see
   /create-order below. A plan "line item" is one of six SKUs (pro,
   max or team, monthly or yearly) covering that much access; a card
   line item (if any) is added on top of it in the same order. There's
   no automatic renewal: the customer pays again when their access
   period ends, because FPX and e-wallets cannot support automatic
   recurring charges.

   Plan prices follow https://share2.io/pricing (Pro RM25/RM180,
   Max RM150/RM880, Team RM550/RM2880 for monthly/yearly).
------------------------------------------------------------------ */
const PRODUCTS = {
  plan_pro_monthly:    { name: "Pro Plan (1 month access, one-time)",         price_sen: 2500   }, // RM25
  plan_pro_yearly:     { name: "Pro Plan (1 year access, one-time)",          price_sen: 18000  }, // RM180
  plan_max_monthly:    { name: "Max Plan (1 month access, one-time)",         price_sen: 15000  }, // RM150
  plan_max_yearly:     { name: "Max Plan (1 year access, one-time)",          price_sen: 88000  }, // RM880
  plan_team_monthly:   { name: "Team Plan (1 month access, one-time)",        price_sen: 55000  }, // RM550
  plan_team_yearly:    { name: "Team Plan (1 year access, one-time)",         price_sen: 288000 }, // RM2880
  setup_only:          { name: "Digital Profile Setup (one-time)",            price_sen: 4800   }, // RM48
  card_template_only:  { name: "Ready-made Card (one-time)",                  price_sen: 11800  }, // RM118
  card_custom_only:    { name: "Custom Card (one-time)",                      price_sen: 33800  }  // RM338
};

const app = express();

// This app runs behind Passenger's reverse proxy, not facing the internet
// directly — trust its X-Forwarded-* headers so req.ip (used for the admin
// login rate limiter) reflects the real visitor, not Passenger's internal
// address, and so Express's own notion of "is this request secure" is
// accurate rather than always appearing as plain HTTP internally.
app.set("trust proxy", 1);

// Allow your storefront to call this API. To lock it down, replace
// `cors()` with `cors({ origin: "https://share2.io" })`.
app.use(cors());

// This app is mounted at /shop, and cPanel/Passenger passes that prefix through in
// the request path. Strip it here, FIRST — before any route matching happens —
// so every route below (including the raw-body webhook capture just below this)
// sees the path it actually expects. This must run before route matching, not
// after: if it ran later, routes registered above it would be matching against
// the un-stripped "/shop/..." path and would never fire on the real prefixed
// requests Curlec/Passenger actually send.
const MOUNT_PATH = "/shop";
app.use((req, _res, next) => {
  if (req.url === MOUNT_PATH) req.url = "/";
  else if (req.url.startsWith(MOUNT_PATH + "/")) req.url = req.url.slice(MOUNT_PATH.length);
  next();
});

// IMPORTANT: the webhook route is registered here, BEFORE the global JSON parser
// below, specifically so it receives the raw request bytes (needed to verify
// Curlec's webhook signature). If this were registered after express.json(),
// the body would already be parsed/consumed and signature verification would
// always fail. See the route definition further down for the actual handler —
// this line just claims the raw body early; the logic lives at WEBHOOK_ROUTE.
app.post("/webhooks/curlec", express.raw({ type: "*/*", limit: "256kb" }), (req, res, next) => {
  req._rawWebhookBody = req.body; // Buffer
  next("route"); // fall through to the real handler registered later
});

app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: false })); // Razorpay posts the callback as form data

// Admin dashboard — mounted here (after the /shop prefix strip, before static
// file serving) so it's reachable at /shop/admin in production and can never
// be shadowed by a static file lookup.
app.use("/admin", adminRouter);

app.get("/health", (_req, res) => res.json({ ok: true, service: "share2-nfc-store", payments_configured: !!razorpay }));

// Exposes the PUBLIC key id (safe to share) so the storefront always uses the same
// key as this server — switch test/live by changing env vars only, no file edits.
app.get("/config", (_req, res) => res.json({ key_id: KEY_ID || "", currency: "MYR" }));

const clip = (s, n = 255) => String(s ?? "").slice(0, n);

app.post("/create-order", async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({ error: "Payments aren't set up yet. Add RZP_KEY_ID and RZP_KEY_SECRET in cPanel, then Restart the app." });
    }
    const { items, customer } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items in the order." });
    }

    // Every order must carry exactly one plan.
    if (items.filter(it => it && String(it.id).startsWith("plan_")).length !== 1) {
      return res.status(400).json({ error: "Please choose one plan." });
    }

    let amount = 0;
    const lines = [];
    for (const it of items) {
      const product = PRODUCTS[it && it.id];
      if (!product) return res.status(400).json({ error: "Unknown product: " + (it && it.id) });
      const qty = Math.max(1, Math.min(50, parseInt(it.qty, 10) || 0));
      amount += product.price_sen * qty;
      lines.push(`${qty}× ${product.name}`);
    }
    if (amount <= 0) return res.status(400).json({ error: "Invalid order amount." });

    const c = customer || {};
    const notes = {
      customer_name: clip(c.name),
      email: clip(c.email),
      phone: clip(c.phone),
      print_name: clip(c.printName),
      print_title: clip(c.jobTitle),
      company: clip(c.company),
      ship_to: clip(`${c.addr1 || ""} ${c.addr2 || ""}, ${c.city || ""} ${c.postcode || ""} ${c.state || ""}`),
      items: clip(lines.join(" | ")),
      order_notes: clip(c.notes)
    };

    const order = await razorpay.orders.create({
      amount,                       // in sen
      currency: "MYR",
      receipt: "rcpt_" + Date.now(),
      notes
    });

    console.log("[order created]", order.id, RM(amount), "-", lines.join(", "));

    // Infer plan/card_type/qty from the items for our own records. An order
    // may contain a plan item (plan_pro/plan_max/plan_team) and/or a card item
    // (card_template_only/card_custom_only/setup_only) — up to one of each.
    const SKU_CARD_TYPE = { card_template_only: "template", card_custom_only: "custom", setup_only: "setup" };
    const SKU_PLAN = { plan_pro_monthly: "pro", plan_pro_yearly: "pro", plan_max_monthly: "max", plan_max_yearly: "max", plan_team_monthly: "team", plan_team_yearly: "team" };
    const SKU_CYCLE = { plan_pro_monthly: "monthly", plan_pro_yearly: "yearly", plan_max_monthly: "monthly", plan_max_yearly: "yearly", plan_team_monthly: "monthly", plan_team_yearly: "yearly" };
    let inferredPlan = null, inferredCycle = null, inferredCardType = "none", inferredQty = 1;
    for (const it of items) {
      if (SKU_PLAN[it.id]) { inferredPlan = SKU_PLAN[it.id]; inferredCycle = SKU_CYCLE[it.id]; }
      if (SKU_CARD_TYPE[it.id]) { inferredCardType = SKU_CARD_TYPE[it.id]; inferredQty = Math.max(1, Math.min(50, parseInt(it.qty, 10) || 1)); }
    }
    db.insertRegistration({
      ref: order.id, kind: "order", status: "pending", plan: inferredPlan, billing_cycle: inferredCycle, card_type: inferredCardType,
      qty: inferredQty, amount_sen: amount,
      name: c.name, email: c.email, phone: c.phone,
      print_name: c.printName || null, job_title: c.jobTitle || null, company: c.company || null,
      addr1: c.addr1 || null, addr2: c.addr2 || null, city: c.city || null, postcode: c.postcode || null, state: c.state || null,
      notes: c.notes || null, razorpay_order_id: order.id
    });

    res.json({ order_id: order.id, amount: order.amount, currency: order.currency });
  } catch (err) {
    console.error("[create-order error]", err && err.error ? err.error : err);
    res.status(500).json({ error: "Could not create the order. Please try again." });
  }
});

app.post("/verify-payment", (req, res) => {
  try {
    if (!KEY_SECRET) {
      return res.status(503).json({ valid: false, error: "Server not configured with payment keys." });
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ valid: false, error: "Missing payment fields." });
    }

    const expected = crypto
      .createHmac("sha256", KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    const a = Buffer.from(expected);
    const b = Buffer.from(String(razorpay_signature));
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

    if (valid) {
      // Payment is genuine. This is where you'd persist the order,
      // trigger fulfilment, or send a confirmation email.
      console.log("[PAID ✓]", razorpay_order_id, razorpay_payment_id);
      db.markPaid(razorpay_order_id, { razorpay_payment_id });
      return res.json({ valid: true, order_id: razorpay_order_id, payment_id: razorpay_payment_id });
    }

    console.warn("[verify failed]", razorpay_order_id);
    return res.status(400).json({ valid: false });
  } catch (err) {
    console.error("[verify-payment error]", err);
    res.status(500).json({ valid: false, error: "Verification failed." });
  }
});

// NOTE: /create-subscription and /verify-subscription were removed. Every
// checkout (Pro, Max, Team) now goes through /create-order above as a
// one-time payment — see the big comment on PRODUCTS near the top of this
// file for why. This does not affect any customer who is already on a real
// recurring subscription from before this change; Curlec keeps billing
// those independently. It only affects new checkouts going forward.

/* -----------------------------------------------------------------
   WEBHOOK — Curlec calls this on every subscription lifecycle event:
     subscription.charged   → renewal succeeded (Curlec also emails the invoice)
     subscription.pending   → a renewal charge failed, will retry
     subscription.halted    → retries exhausted; card needs updating
   Set this exact URL in Curlec Dashboard → Settings → Webhooks:
     https://share2.io/shop/webhooks/curlec
   Set the same secret there and in RZP_WEBHOOK_SECRET below.
   Kept even though new checkouts are one-time — still fires for any
   pre-existing real subscriptions from before this change.
------------------------------------------------------------------ */
const WEBHOOK_SECRET = process.env.RZP_WEBHOOK_SECRET || "";

app.post("/webhooks/curlec", (req, res) => {
  try {
    const rawBody = req._rawWebhookBody; // captured earlier, before express.json() could consume it
    if (!Buffer.isBuffer(rawBody)) {
      console.error("[webhook error] No raw body captured — the raw-body middleware didn't run for this request.");
      return res.status(400).send("bad request");
    }
    let parsed;
    try { parsed = JSON.parse(rawBody.toString("utf8")); } catch { parsed = {}; }

    if (WEBHOOK_SECRET) {
      const sig = req.headers["x-razorpay-signature"];
      const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
      const a = Buffer.from(expected), b = Buffer.from(String(sig || ""));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        console.warn("[webhook] bad signature — ignoring");
        return res.status(400).send("invalid signature");
      }
    } else {
      console.warn("[webhook] RZP_WEBHOOK_SECRET not set — accepting unverified (set this before going live!)");
    }

    const event = parsed.event;
    const sub = parsed.payload && parsed.payload.subscription && parsed.payload.subscription.entity;
    const subId = sub && sub.id;

    if (event === "subscription.charged") {
      // A renewal succeeded. Curlec has already emailed the customer an invoice.
      console.log("[renewal charged ✓]", subId);
      // TODO: mark the account as renewed for another month in your own system.
    } else if (event === "subscription.pending") {
      console.warn("[renewal payment failed — will retry]", subId);
      // TODO: this is where you'd trigger a "please update your card" message.
    } else if (event === "subscription.halted") {
      console.warn("[renewal retries exhausted — subscription halted]", subId);
      // TODO: notify the customer their card needs updating to keep the plan active.
    } else {
      console.log("[webhook]", event, subId || "");
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("[webhook error]", err);
    res.status(500).send("error");
  }
});

/* -----------------------------------------------------------------
   Payment redirect callback. FPX, cards and e-wallets all return the
   browser here after payment. We verify the signature server-side and
   render a branded confirmation page.
------------------------------------------------------------------ */
const SHOP_URL = "https://share2.io/shop";
const WHATSAPP = "601163316630";
const REGISTER_URL = "https://share2.io/user/register";

function sigValid(orderId, paymentId, signature) {
  if (!KEY_SECRET || !orderId || !paymentId || !signature) return false;
  const expected = crypto.createHmac("sha256", KEY_SECRET).update(orderId + "|" + paymentId).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

function resultPage({ ok, heading, message, paymentId, orderId, refLabel, waText }) {
  const wa = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(waText || ("Hi Share2.io, about my order. Payment ID: " + (paymentId || "")))}`;
  const ref = ok
    ? (refLabel
        ? `<div class="ref">${esc(refLabel)}${paymentId ? ": " + esc(paymentId) : ""}</div>`
        : `<div class="ref">Payment ID: ${esc(paymentId)}<br/>Order ID: ${esc(orderId)}</div>`)
    : "";
  const buttons = ok
    ? (refLabel
        ? `<a class="btn gold" href="${REGISTER_URL}">Set up your profile</a><a class="btn ghost" href="${wa}">Message us on WhatsApp</a><a class="btn ghost" href="${SHOP_URL}">Back to store</a>`
        : `<a class="btn gold" href="${wa}">Message us on WhatsApp</a><a class="btn ghost" href="${REGISTER_URL}">Set up your profile</a><a class="btn ghost" href="${SHOP_URL}">Back to store</a>`)
    : `<a class="btn gold" href="${SHOP_URL}">Try again</a><a class="btn ghost" href="${wa}">Get help on WhatsApp</a>`;
  const icon = ok
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="#87C193" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="#E39A7C" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${ok ? "Payment received" : "Payment not completed"} · Share2.io</title>
<meta name="theme-color" content="#0B0A08"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*{margin:0;box-sizing:border-box}
body{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(900px 500px at 50% -10%,rgba(217,188,126,.08),transparent 60%),#0B0A08;color:#B7AD9B;font-family:'Inter',system-ui,sans-serif}
.card{max-width:440px;width:100%;background:linear-gradient(180deg,#1C1813,#16130F);border:1px solid rgba(217,188,126,.16);border-radius:22px;padding:34px 28px;text-align:center;box-shadow:0 24px 60px -30px rgba(0,0,0,.75)}
.brand{font-family:'Fraunces',serif;color:#ECE3D2;font-size:1.05rem;margin-bottom:22px}
.brand b{color:#D9BC7E}
.icon{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;margin:0 auto 18px;border:1px solid ${ok ? "rgba(135,193,147,.4)" : "rgba(227,154,124,.4)"};background:${ok ? "rgba(135,193,147,.14)" : "rgba(227,154,124,.12)"}}
.icon svg{width:32px;height:32px}
h1{font-family:'Fraunces',serif;color:#ECE3D2;font-size:1.7rem;font-weight:600;margin-bottom:12px}
p{font-size:1rem;line-height:1.6;margin-bottom:6px}
.ref{font-family:ui-monospace,Menlo,monospace;font-size:.82rem;color:#EAD6A6;background:#100E0B;border:1px solid rgba(237,228,211,.09);border-radius:8px;padding:10px;margin:16px 0;word-break:break-all}
.btn{display:block;width:100%;margin-top:10px;padding:15px;border-radius:12px;font-weight:700;font-size:1rem;text-decoration:none}
.btn.gold{color:#1a1610;background:linear-gradient(135deg,#E7CE95,#C7A257)}
.btn.ghost{color:#B7AD9B;border:1px solid rgba(217,188,126,.16)}
</style></head><body>
<div class="card">
  <div class="brand">Share<b>2.io</b></div>
  <div class="icon">${icon}</div>
  <h1>${esc(heading)}</h1>
  <p>${esc(message)}</p>
  ${ref}
  <div>${buttons}</div>
</div></body></html>`;
}

function handleCallback(req, res) {
  const b = req.body || {};
  const paymentId = b.razorpay_payment_id;
  const signature = b.razorpay_signature;

  // Subscription authorisation redirects include razorpay_subscription_id instead of an order id.
  if (b.razorpay_subscription_id) {
    const subId = b.razorpay_subscription_id;
    const expected = KEY_SECRET && crypto.createHmac("sha256", KEY_SECRET).update(paymentId + "|" + subId).digest("hex");
    const okSig = expected && signature &&
      Buffer.from(expected).length === Buffer.from(String(signature)).length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));

    if (okSig) {
      console.log("[SUBSCRIPTION AUTHORISED ✓ callback]", subId, paymentId);
      db.markPaid(subId, { razorpay_payment_id: paymentId });
      return res.status(200).send(resultPage({
        ok: true,
        heading: "You're subscribed.",
        message: "Your plan is active and will renew automatically each month — we'll email you a reminder before every renewal, and Curlec sends an invoice after each charge. We'll message you on WhatsApp to finalise your card and delivery.",
        paymentId, orderId: subId
      }));
    }
    const desc = b["error[description]"] || b.error_description || "";
    console.warn("[subscription callback not verified]", subId || "-", desc || "");
    return res.status(200).send(resultPage({
      ok: false,
      heading: "Subscription not completed.",
      message: desc ? ("No charge was made — " + desc) : "We couldn't confirm the subscription. If money left your account, message us with any reference and we'll fix it right away."
    }));
  }

  const orderId = b.razorpay_order_id;

  if (signature && sigValid(orderId, paymentId, signature)) {
    console.log("[PAID ✓ callback]", orderId, paymentId);
    db.markPaid(orderId, { razorpay_payment_id: paymentId });
    // TODO: mark order paid / trigger fulfilment / send confirmation email.
    return res.status(200).send(resultPage({
      ok: true,
      heading: "Payment received.",
      message: "Thank you for your order. We'll message you on WhatsApp to finalise your design and delivery.",
      paymentId, orderId
    }));
  }

  const desc = b["error[description]"] || b.error_description || "";
  console.warn("[callback not verified]", orderId || "-", desc || "");
  return res.status(200).send(resultPage({
    ok: false,
    heading: "Payment not completed.",
    message: desc ? ("No charge was made — " + desc) : "We couldn't confirm a completed payment. If money did leave your account, message us with any reference and we'll fix it right away."
  }));
}

app.post("/payment-callback", handleCallback);
app.get("/payment-callback", (_req, res) => res.redirect(SHOP_URL)); // someone opening the URL directly

/* Serve the storefront. index.html can sit EITHER directly in the app root (next to
   server.js) OR in a ./public folder — both work, so there's no wrong place to put it.
   Source and config files are never served. */
// Always serve fresh HTML so an update shows immediately (no stale cached page).
app.use((req, res, next) => {
  const p = decodeURIComponent(req.path);
  if (p === "/" || p.endsWith(".html")) res.set("Cache-Control", "no-store, max-age=0");
  next();
});
const HIDDEN = new Set(["server.js", "package.json", "package-lock.json", ".gitignore", ".htaccess"]);
app.use((req, res, next) => {
  const first = decodeURIComponent(req.path).replace(/^\/+/, "").split("/")[0];
  if (first && (HIDDEN.has(first) || first === "node_modules" || first.startsWith("."))) {
    return res.status(404).send("Not found");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\nShare2.io NFC store backend running on port ${PORT}\n`));
