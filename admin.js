/* -----------------------------------------------------------------
   Admin dashboard — login-gated view of the `registrations` table.

   Reads credentials from environment variables (set these in cPanel
   next to the DB_* and RZP_* vars):

     ADMIN_USER           the login username
     ADMIN_PASSWORD_HASH  a bcrypt hash of the login password — never
                           the plain password itself. Generate one with:
                             node hash-password.js "your-password-here"
                           and paste the output here.
     SESSION_SECRET       any long random string, used to sign the
                           login session cookie. Generate one with:
                             node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

   If any of these three aren't set, every /admin route responds with
   a plain "Admin dashboard is not configured yet" message instead of
   either crashing or (worse) accidentally serving data with no login
   required. Nothing else in the app is affected.
------------------------------------------------------------------ */
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const db = require("./db");

const { ADMIN_USER, ADMIN_PASSWORD_HASH: ADMIN_PASSWORD_HASH_RAW, SESSION_SECRET } = process.env;

// Some hosting panels' environment-variable fields mangle "$" characters,
// which every bcrypt hash contains ("$2a$12$..."). To sidestep that
// entirely, ADMIN_PASSWORD_HASH may be given either as the raw hash or as
// that hash base64-encoded (which contains no "$" at all) — this decodes
// it transparently either way.
function resolveAdminHash(raw) {
  if (!raw) return raw;
  if (/^\$2[aby]\$/.test(raw)) return raw; // already a raw bcrypt hash
  try {
    const buf = Buffer.alloc(Buffer.byteLength(raw, "base64"));
    buf.write(raw, "base64");
    const decoded = buf.toString("utf8");
    if (/^\$2[aby]\$/.test(decoded)) return decoded;
  } catch (e) { /* fall through */ }
  return raw;
}
const ADMIN_PASSWORD_HASH = resolveAdminHash(ADMIN_PASSWORD_HASH_RAW);
const configured = !!(ADMIN_USER && ADMIN_PASSWORD_HASH && SESSION_SECRET);

if (!configured) {
  console.warn("[admin] ADMIN_USER / ADMIN_PASSWORD_HASH / SESSION_SECRET not fully set — " +
    "/admin will show a setup message instead of a login form until all three are added.");
}

const router = express.Router();

// This app is mounted at /shop behind Passenger, which does NOT strip that
// prefix — server.js strips it internally for route matching, but any
// absolute URL sent to the BROWSER (redirects, form actions) still needs
// it, or the browser's next request won't reach this app at all.
const SHOP_PREFIX = "/shop";

/* ---- brand tokens, shared with the storefront for a consistent look ---- */
const CSS = `
:root{
  --ink:#2B2E4A;--body:#5B6178;--muted:#8A90A6;--bg:#FCFDFF;--panel:#F6F8FB;--panel-2:#EEF3F7;
  --line:#E6EBF1;--line-soft:#EFF2F6;--teal:#15B789;--teal-deep:#0E9B74;--blue:#1296B7;--blue-deep:#0F7E9A;
  --grad:linear-gradient(120deg,#15B789 0%,#1296B7 100%);--grad-soft:linear-gradient(120deg,rgba(21,183,137,.10),rgba(18,150,183,.10));
  --tint-teal:rgba(21,183,137,.14);--danger:#E8604C;--radius:16px;--radius-sm:12px;--radius-lg:22px;
  --shadow-sm:0 2px 10px -4px rgba(43,46,74,.10);--shadow-md:0 18px 44px -16px rgba(43,46,74,.16);
  --sans:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
*{margin:0;box-sizing:border-box}
body{background:var(--panel);color:var(--body);font-family:var(--sans);font-size:15.5px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--teal-deep);text-decoration:none}
a:hover{color:var(--blue-deep)}
.wrap{max-width:1180px;margin:0 auto;padding:0 26px}
h1,h2{font-family:var(--sans);color:var(--ink);font-weight:800;letter-spacing:-.01em}
.topbar{background:#fff;border-bottom:1px solid var(--line);padding:16px 0}
.topbar .in{display:flex;align-items:center;gap:16px}
.topbar .logo{height:28px}
.topbar h1{font-size:17px;margin-left:2px}
.topbar .sp{flex:1}
.btn{display:inline-flex;align-items:center;gap:8px;border-radius:10px;padding:10px 18px;font-weight:700;font-size:14.5px;
  cursor:pointer;border:1px solid var(--line);background:#fff;color:var(--ink);transition:border-color .2s ease,background .2s ease}
.btn:hover{border-color:rgba(21,183,137,.45)}
.btn-primary{background:var(--grad);color:#fff;border:none;box-shadow:0 8px 18px -8px rgba(18,150,183,.5)}
.btn-primary:hover{filter:brightness(1.05)}
.card{background:#fff;border:1px solid var(--line);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm)}
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.login-card{width:100%;max-width:380px;padding:36px 34px}
.login-card .logo{height:32px;display:block;margin:0 auto 22px}
.login-card h1{font-size:21px;text-align:center;margin-bottom:26px}
.field{margin-bottom:16px}
.field label{display:block;font-size:13.5px;font-weight:800;color:var(--ink);margin-bottom:6px}
.field input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);font:inherit;font-size:15px;color:var(--ink)}
.field input:focus{outline:none;border-color:var(--teal);box-shadow:0 0 0 3px var(--tint-teal)}
.login-card .btn-primary{width:100%;justify-content:center;padding:12px 0;margin-top:6px}
.err{background:rgba(232,96,76,.08);border:1px solid rgba(232,96,76,.3);color:#B04434;border-radius:10px;padding:11px 14px;font-size:14px;margin-bottom:16px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:26px 0}
.stat{padding:18px 20px}
.stat .n{font-size:26px;font-weight:800;color:var(--ink)}
.stat .l{font-size:13px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-top:2px}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
.toolbar input,.toolbar select{padding:9px 13px;border-radius:9px;border:1px solid var(--line);font:inherit;font-size:14px;color:var(--ink);background:#fff}
.toolbar input{flex:1;min-width:180px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:800;padding:11px 14px;border-bottom:1px solid var(--line)}
td{padding:12px 14px;border-bottom:1px solid var(--line-soft);vertical-align:top}
tr:last-child td{border-bottom:none}
tr.rowlink{cursor:pointer}
tr.rowlink:hover{background:var(--panel)}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:800}
.badge-paid{background:rgba(21,183,137,.12);color:var(--teal-deep)}
.badge-pending{background:rgba(18,150,183,.12);color:var(--blue-deep)}
.badge-signed_up{background:rgba(21,183,137,.12);color:var(--teal-deep)}
.badge-failed{background:rgba(232,96,76,.1);color:#B04434}
.kind{font-size:12px;color:var(--muted);font-weight:700;text-transform:uppercase}
.detail{background:var(--panel);display:none}
.detail.open{display:table-row}
.detail td{padding:16px 24px}
.detail dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13.5px}
.detail dt{color:var(--muted);font-weight:700}
.detail dd{color:var(--ink)}
.empty{padding:60px 20px;text-align:center;color:var(--muted)}
.pager{display:flex;justify-content:space-between;align-items:center;margin-top:18px;font-size:14px;color:var(--muted)}
.pager .btn{padding:8px 14px}
.pager .btn[disabled]{opacity:.4;pointer-events:none}
@media(max-width:800px){.stats{grid-template-columns:1fr 1fr}}
`;

const LOGO = "https://share2.io/content/Share2IO-Main-Logo-new.png";

function page(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Share2.io Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<meta name="robots" content="noindex, nofollow">
<style>${CSS}</style></head><body>${bodyHtml}</body></html>`;
}

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

/* ---- not configured yet: show a plain message instead of ever exposing data ---- */
router.use((req, res, next) => {
  if (configured) return next();
  res.status(503).send(page("Not configured", `
    <div class="login-wrap"><div class="card login-card">
      <h1>Admin dashboard isn't set up yet</h1>
      <p style="text-align:center;color:var(--body);line-height:1.6">
        Add <code>ADMIN_USER</code>, <code>ADMIN_PASSWORD_HASH</code> and <code>SESSION_SECRET</code>
        as environment variables in cPanel, then restart the app.
      </p>
    </div></div>`));
});

/* ---- sessions ----
   The default in-memory session store only works if every request lands on
   the SAME Node process. Shared hosting often runs more than one worker
   process behind the scenes — if login lands on worker A but the next
   request lands on worker B, worker B has never heard of that session and
   bounces back to the login page with no error shown (since nothing is
   technically "wrong," the session just isn't there). Storing sessions in
   MySQL instead (reusing db.js's existing pool — no second connection)
   fixes this, since every worker reads from the same table. Falls back to
   the default in-memory store if the database isn't configured yet, so
   this never blocks login for someone who hasn't set up MySQL. */
let sessionStore;
if (db.pool) {
  try {
    const MySQLStore = require("express-mysql-session")(session);
    sessionStore = new MySQLStore({}, db.pool);
    sessionStore.on("error", (err) => {
      console.error("[admin] Session store runtime error:", err.message,
        "\u2014 sessions may stop persisting until this clears.");
    });
    console.log("[admin] Using MySQL-backed sessions (survives multiple worker processes).");
  } catch (err) {
    sessionStore = undefined;
    console.error("[admin] Failed to set up MySQL-backed sessions:", err.message,
      "\u2014 falling back to in-memory sessions. This will cause login to intermittently bounce" +
      " back to the login page if more than one worker process is running.");
  }
} else {
  console.warn("[admin] No database configured — falling back to in-memory sessions. " +
    "If login seems to work but immediately bounces back to the login page, this is almost " +
    "certainly why: set up DB_HOST/DB_USER/DB_PASSWORD/DB_NAME (see schema.sql) to fix it.");
}

// Temporary diagnostic escape hatch: if the cookie is being silently dropped
// by the browser (confirmed via the "sent NO cookie at all" log from
// requireAuth below), the most likely cause is the Secure flag not matching
// how the connection is actually terminating in production. Setting
// SESSION_INSECURE_COOKIE=true removes the Secure flag so you can confirm
// whether that's really the cause — if login starts working with this set,
// that CONFIRMS an HTTPS/proxy mismatch upstream that needs fixing properly.
// This is not a permanent fix — remove this env var once the real HTTPS
// issue is found, since it makes the session cookie readable over plain HTTP.
const FORCE_INSECURE_COOKIE = process.env.SESSION_INSECURE_COOKIE === "true";
if (FORCE_INSECURE_COOKIE) {
  console.warn("[admin] SESSION_INSECURE_COOKIE=true \u2014 the session cookie is running WITHOUT the Secure flag. " +
    "This is for diagnosing the cookie-not-being-sent issue only. Remove this env var once that's resolved.");
}

router.use(session({
  store: sessionStore, // undefined falls back to express-session's default MemoryStore
  secret: SESSION_SECRET || "unconfigured",
  name: "share2_admin_sid",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 8 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === "production" && !FORCE_INSECURE_COOKIE
  }
}));

/* ---- basic brute-force lockout: 5 bad attempts / IP locks that IP for 15 min ---- */
const attempts = new Map(); // ip -> { count, lockedUntil }
function isLocked(ip) {
  const a = attempts.get(ip);
  return !!(a && a.lockedUntil && a.lockedUntil > Date.now());
}
function recordFailure(ip) {
  const a = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= 5) { a.lockedUntil = Date.now() + 15 * 60 * 1000; a.count = 0; }
  attempts.set(ip, a);
}
function recordSuccess(ip) { attempts.delete(ip); }

function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  const hadCookie = !!(req.headers.cookie && req.headers.cookie.includes("share2_admin_sid="));
  console.warn("[admin] Rejected " + req.originalUrl + " \u2014 session " + req.sessionID + " has no isAdmin flag.",
    hadCookie
      ? "The browser DID send a share2_admin_sid cookie, but the session store has no record of it (or it expired). This points at the session store, not the browser \u2014 if you're using MySQL-backed sessions, check the `sessions` table actually has a row for this ID; if you're on the in-memory fallback, this is expected whenever a different worker process handles this request than handled the login."
      : "The browser sent NO share2_admin_sid cookie at all. This points at the cookie never being set/kept by the browser \u2014 check that the site is being served over HTTPS (the cookie is marked Secure in production, so it's silently dropped over plain HTTP), and that nothing is stripping cookies between browser and server.");
  return res.redirect(SHOP_PREFIX + "/admin/login");
}

/* ---- login ---- */
router.get("/login", (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect(SHOP_PREFIX + "/admin");
  res.send(page("Log in", loginHtml()));
});

router.post("/login", express.urlencoded({ extended: false }), async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  if (isLocked(ip)) {
    return res.status(429).send(page("Log in", loginHtml("Too many attempts. Try again in 15 minutes.")));
  }
  const { username, password } = req.body || {};
  // Always run bcrypt.compare, even if the username is wrong/missing, so a bad
  // username doesn't return faster than a bad password and leak which part failed.
  const passOk = await bcrypt.compare(String(password || ""), ADMIN_PASSWORD_HASH).catch(() => false);
  const userOk = typeof username === "string" && username.length === ADMIN_USER.length &&
    crypto.timingSafeEqual(Buffer.from(username), Buffer.from(ADMIN_USER));

  if (userOk && passOk) {
    recordSuccess(ip);
    req.session.isAdmin = true;
    return req.session.save((err) => {
      if (err) {
        console.error("[admin] Login OK but session SAVE FAILED for session", req.sessionID + ":", err.message,
          "\u2014 this is why it'll bounce back to login next request.");
        return res.status(500).send(page("Log in", loginHtml("Something went wrong saving your session. Please try again.")));
      }
      console.log("[admin] Login OK \u2014 session", req.sessionID, "saved successfully. Redirecting to dashboard.");
      return res.redirect(SHOP_PREFIX + "/admin");
    });
  }
  recordFailure(ip);
  res.status(401).send(page("Log in", loginHtml("Incorrect username or password.")));
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect(SHOP_PREFIX + "/admin/login"));
});

function loginHtml(error) {
  return `<div class="login-wrap"><div class="card login-card">
    <img src="${LOGO}" alt="Share2.io" class="logo">
    <h1>Admin dashboard</h1>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    <form method="POST" action="${SHOP_PREFIX}/admin/login">
      <div class="field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required autofocus></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button type="submit" class="btn btn-primary">Log in</button>
    </form>
  </div></div>`;
}

/* ---- dashboard ---- */
const PAGE_SIZE = 25;
const KIND_LABEL = { free_signup: "Free signup", order: "One-time order", subscription: "Subscription" };

router.get("/", requireAuth, async (req, res) => {
  if (!db.pool) {
    return res.send(page("Dashboard", dashboardShell(`<div class="empty">Database isn't configured yet — add DB_HOST / DB_USER / DB_PASSWORD / DB_NAME and restart.</div>`, null)));
  }
  try {
    const search = (req.query.q || "").trim();
    const status = ["pending", "paid", "signed_up", "failed"].includes(req.query.status) ? req.query.status : "";
    const kind = ["free_signup", "order", "subscription"].includes(req.query.kind) ? req.query.kind : "";
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);

    const where = [];
    const params = [];
    if (search) { where.push("(name LIKE ? OR email LIKE ? OR phone LIKE ? OR ref LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    if (status) { where.push("status = ?"); params.push(status); }
    if (kind) { where.push("kind = ?"); params.push(kind); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const [[{ total }]] = await db.pool.query(`SELECT COUNT(*) AS total FROM registrations ${whereSql}`, params);
    const [rows] = await db.pool.query(
      `SELECT * FROM registrations ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, PAGE_SIZE, (pageNum - 1) * PAGE_SIZE]
    );
    const [[stats]] = await db.pool.query(`
      SELECT COUNT(*) AS total,
             SUM(status='paid') AS paid,
             SUM(kind='free_signup') AS free_signups,
             SUM(CASE WHEN status='paid' THEN amount_sen ELSE 0 END) AS revenue_sen
      FROM registrations`);

    res.send(page("Dashboard", dashboardShell(renderBody(rows, total, pageNum, req.query), stats)));
  } catch (err) {
    console.error("[admin dashboard error]", err.message);
    res.status(500).send(page("Dashboard", dashboardShell(`<div class="empty">Something went wrong loading the data.</div>`, null)));
  }
});

function dashboardShell(bodyHtml, stats) {
  const rm = sen => "RM" + ((sen || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const statsHtml = stats ? `
    <div class="stats">
      <div class="card stat"><div class="n">${stats.total || 0}</div><div class="l">Total signups</div></div>
      <div class="card stat"><div class="n">${stats.paid || 0}</div><div class="l">Paid orders</div></div>
      <div class="card stat"><div class="n">${stats.free_signups || 0}</div><div class="l">Free signups</div></div>
      <div class="card stat"><div class="n">${rm(stats.revenue_sen)}</div><div class="l">Total revenue</div></div>
    </div>` : "";
  return `
    <div class="topbar"><div class="wrap in">
      <img src="${LOGO}" alt="Share2.io" class="logo">
      <h1>Registrations</h1>
      <div class="sp"></div>
      <form method="POST" action="${SHOP_PREFIX}/admin/logout"><button type="submit" class="btn">Log out</button></form>
    </div></div>
    <div class="wrap" style="padding-top:26px;padding-bottom:60px">
      ${statsHtml}
      ${bodyHtml}
    </div>
    <script>
      document.querySelectorAll('tr.rowlink').forEach(function(tr){
        tr.addEventListener('click', function(){
          var d = document.getElementById('detail-' + tr.dataset.id);
          if (d) d.classList.toggle('open');
        });
      });
    </script>`;
}

function renderBody(rows, total, pageNum, q) {
  const search = esc(q.q || "");
  const statusSel = q.status || "";
  const kindSel = q.kind || "";
  const opt = (val, sel, label) => `<option value="${val}"${val === sel ? " selected" : ""}>${label}</option>`;
  const qs = (extra) => {
    const p = new URLSearchParams({ q: q.q || "", status: q.status || "", kind: q.kind || "", ...extra });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return "?" + p.toString();
  };

  const toolbar = `
    <form class="toolbar" method="GET" action="${SHOP_PREFIX}/admin">
      <input type="text" name="q" value="${search}" placeholder="Search name, email, phone, or ref…">
      <select name="status">
        ${opt("", statusSel, "All statuses")}${opt("paid", statusSel, "Paid")}${opt("pending", statusSel, "Pending")}${opt("signed_up", statusSel, "Signed up")}${opt("failed", statusSel, "Failed")}
      </select>
      <select name="kind">
        ${opt("", kindSel, "All types")}${opt("free_signup", kindSel, "Free signup")}${opt("order", kindSel, "One-time order")}${opt("subscription", kindSel, "Subscription")}
      </select>
      <button type="submit" class="btn btn-primary">Filter</button>
    </form>`;

  if (!rows.length) {
    return toolbar + `<div class="card"><div class="empty">No registrations match this filter yet.</div></div>`;
  }

  const rm = sen => sen == null ? "\u2014" : "RM" + (sen / 100).toLocaleString("en-MY", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const dt = d => new Date(d).toLocaleString("en-MY", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  const trs = rows.map(r => `
    <tr class="rowlink" data-id="${r.id}">
      <td>${dt(r.created_at)}</td>
      <td><b>${esc(r.name)}</b><br><span class="kind">${esc(r.email)}</span></td>
      <td><span class="kind">${esc(KIND_LABEL[r.kind] || r.kind)}</span></td>
      <td>${esc(r.plan ? r.plan[0].toUpperCase() + r.plan.slice(1) : "\u2014")}${r.card_type && r.card_type !== "none" ? " \u00b7 " + esc(r.card_type) : ""}</td>
      <td>${rm(r.amount_sen)}</td>
      <td><span class="badge badge-${esc(r.status)}">${esc(r.status.replace("_", " "))}</span></td>
    </tr>
    <tr class="detail" id="detail-${r.id}"><td colspan="6"><dl>
      <dt>Reference</dt><dd>${esc(r.ref)}</dd>
      <dt>Phone</dt><dd>${esc(r.phone)}</dd>
      ${r.company ? `<dt>Company</dt><dd>${esc(r.company)}${r.job_title ? " \u2014 " + esc(r.job_title) : ""}</dd>` : ""}
      ${r.addr1 ? `<dt>Ship to</dt><dd>${esc(r.addr1)}${r.addr2 ? ", " + esc(r.addr2) : ""}, ${esc(r.city)} ${esc(r.postcode)}, ${esc(r.state)}</dd>` : ""}
      ${r.design ? `<dt>Design</dt><dd>${esc(r.design)}${r.design_color ? " (" + esc(r.design_color) + ")" : ""}</dd>` : ""}
      ${r.notes ? `<dt>Notes</dt><dd>${esc(r.notes)}</dd>` : ""}
      ${r.razorpay_order_id ? `<dt>Order ID</dt><dd>${esc(r.razorpay_order_id)}</dd>` : ""}
      ${r.razorpay_subscription_id ? `<dt>Subscription ID</dt><dd>${esc(r.razorpay_subscription_id)}</dd>` : ""}
      ${r.razorpay_payment_id ? `<dt>Payment ID</dt><dd>${esc(r.razorpay_payment_id)}</dd>` : ""}
    </dl></td></tr>`).join("");

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pager = `<div class="pager">
    <span>${total} result${total === 1 ? "" : "s"} \u00b7 page ${pageNum} of ${totalPages}</span>
    <span>
      <a class="btn" href="${qs({ page: pageNum - 1 })}" ${pageNum <= 1 ? "disabled" : ""}>\u2190 Prev</a>
      <a class="btn" href="${qs({ page: pageNum + 1 })}" ${pageNum >= totalPages ? "disabled" : ""}>Next \u2192</a>
    </span>
  </div>`;

  return toolbar + `<div class="card"><table>
    <thead><tr><th>Date</th><th>Customer</th><th>Type</th><th>Plan</th><th>Amount</th><th>Status</th></tr></thead>
    <tbody>${trs}</tbody>
  </table></div>${pager}`;
}

module.exports = router;
