/* -----------------------------------------------------------------
   MySQL connection pool for registrations / orders.

   Reads credentials from environment variables (set these in cPanel
   under Setup Node.js App → Environment Variables, same place as the
   RZP_KEY_ID / RZP_KEY_SECRET vars):

     DB_HOST      e.g. localhost
     DB_PORT      optional, defaults to 3306
     DB_USER      the MySQL user cPanel created for this database
     DB_PASSWORD  that user's password
     DB_NAME      the database name (create it in cPanel → MySQL
                  Databases, then run schema.sql against it once via
                  phpMyAdmin)

   If these aren't set, `pool` is null and every db.js function below
   becomes a safe no-op that logs a warning instead of throwing — so
   the shop keeps working (checkout, free-signup, everything) even
   before the database is configured. Nothing breaks; you just don't
   get persistence until the env vars are added.
------------------------------------------------------------------ */
const mysql = require("mysql2/promise");

const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
const configured = !!(DB_HOST && DB_USER && DB_NAME);

let pool = null;
if (configured) {
  pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT ? Number(DB_PORT) : 3306,
    user: DB_USER,
    password: DB_PASSWORD || "",
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    charset: "utf8mb4_unicode_ci"
  });
  console.log("[db] MySQL pool configured for", DB_NAME + "@" + DB_HOST);
} else {
  console.warn("[db] DB_HOST / DB_USER / DB_NAME not set — registrations will not be saved to MySQL. " +
    "Add those env vars in cPanel and run schema.sql to enable this.");
}

/* Insert a new registration/order row. Returns the inserted row's id,
   or null if the database isn't configured or the insert fails (this
   never throws — a DB hiccup should not block a checkout). */
async function insertRegistration(row) {
  if (!pool) return null;
  try {
    const cols = [
      "ref", "kind", "status", "plan", "billing_cycle", "card_type", "qty", "amount_sen",
      "name", "email", "phone", "print_name", "job_title", "company",
      "addr1", "addr2", "city", "postcode", "state",
      "design", "design_color", "notes",
      "razorpay_order_id", "razorpay_subscription_id", "razorpay_payment_id"
    ];
    const values = cols.map(c => (row[c] === undefined ? null : row[c]));
    const placeholders = cols.map(() => "?").join(",");
    const [result] = await pool.query(
      `INSERT INTO registrations (${cols.join(",")}) VALUES (${placeholders})`,
      values
    );
    return result.insertId;
  } catch (err) {
    console.error("[db] insertRegistration failed:", err.message);
    return null;
  }
}

/* Update a registration's status (and optionally the Razorpay payment id)
   once a payment/subscription is verified. Matches by ref. Never throws. */
async function markPaid(ref, extra) {
  if (!pool) return false;
  try {
    const fields = ["status = 'paid'"];
    const values = [];
    if (extra && extra.razorpay_payment_id) {
      fields.push("razorpay_payment_id = ?");
      values.push(extra.razorpay_payment_id);
    }
    values.push(ref);
    const [result] = await pool.query(
      `UPDATE registrations SET ${fields.join(", ")} WHERE ref = ?`,
      values
    );
    return result.affectedRows > 0;
  } catch (err) {
    console.error("[db] markPaid failed:", err.message);
    return false;
  }
}

module.exports = { pool, configured, insertRegistration, markPaid };
