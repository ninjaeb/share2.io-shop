// Pre-merge checks: syntax, matching prices, and a server smoke test.
const fs = require("fs");
const assert = require("assert");
const { execFileSync, spawn } = require("child_process");

for (const f of ["server.js", "admin.js", "db.js"]) execFileSync(process.execPath, ["--check", f]);

const html = fs.readFileSync("public/index.html", "utf8");
for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);

const plan = new Function("return " + html.match(/const PLAN = (\{.*?\});/)[1])();
const card = new Function("return " + html.match(/const CARD = (\{.*?\});/)[1])();
const server = fs.readFileSync("server.js", "utf8");
const price = id => {
  const m = server.match(new RegExp("\\b" + id + ":\\s*\\{[^}]*price_sen:\\s*(\\d+)"));
  assert(m, "server.js has no product " + id);
  return Number(m[1]);
};
for (const [name, cycles] of Object.entries(plan))
  for (const [cycle, sen] of Object.entries(cycles))
    assert.strictEqual(price(`plan_${name}_${cycle}`), sen, `price mismatch: ${name} ${cycle}`);
for (const [type, id] of [["template", "card_template_only"], ["custom", "card_custom_only"], ["setup", "setup_only"]])
  assert.strictEqual(price(id), card[type], "price mismatch: " + type);

const PORT = "3999";
const app = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT, RZP_KEY_ID: "ci_dummy", RZP_KEY_SECRET: "ci_dummy" }, stdio: "inherit"
});
(async () => {
  const base = `http://127.0.0.1:${PORT}/shop`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + "/health"); break; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  assert.strictEqual((await (await fetch(base + "/health")).json()).ok, true);
  assert.strictEqual((await fetch(base + "/")).status, 200);
  const noPlan = await fetch(base + "/create-order", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ id: "card_template_only", qty: 1 }] })
  });
  assert.strictEqual(noPlan.status, 400, "an order without a plan must be rejected");
  console.log("All checks passed.");
})().then(() => { app.kill(); }, err => { console.error(err); app.kill(); process.exit(1); });
