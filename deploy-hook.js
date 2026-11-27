/* -----------------------------------------------------------------
   GitHub deploy webhook — POST /shop/github-deploy

   When a commit lands on the deploy branch (default: main), GitHub calls
   this endpoint and the server updates itself:

     1. verifies the X-Hub-Signature-256 header (HMAC-SHA256 of the raw body
        using DEPLOY_WEBHOOK_SECRET) — anything unsigned or wrongly signed is
        rejected before any other work happens
     2. runs   git fetch + git merge --ff-only   in the app folder
     3. touches tmp/restart.txt so Passenger restarts the app on the next hit

   It only ever runs those fixed commands; nothing from the request body is
   put into a command line. A fast-forward-only merge means a checkout with
   local edits or a diverged history fails loudly instead of being overwritten.

   Environment variables (set next to the RZP_* / DB_* ones in cPanel):
     DEPLOY_WEBHOOK_SECRET   required. A long random string; the same value goes
                             in the GitHub webhook's "Secret" box. If it is not
                             set, this endpoint answers 404 and does nothing.
                               node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     DEPLOY_BRANCH           optional, default "main".
     DEPLOY_DIR              optional, default: the folder this file is in. Must
                             be a git checkout of the repository.
------------------------------------------------------------------ */
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const SECRET = process.env.DEPLOY_WEBHOOK_SECRET;
const BRANCH = process.env.DEPLOY_BRANCH || "main";
const DIR = process.env.DEPLOY_DIR || __dirname;

const router = express.Router();

const git = (args) =>
  new Promise((resolve, reject) =>
    execFile("git", args, { cwd: DIR, timeout: 120000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())
    )
  );

let running = false;
let again = false;

async function deploy() {
  running = true;
  try {
    do {
      again = false;
      await git(["fetch", "--quiet", "origin", BRANCH]);
      await git(["merge", "--ff-only", "FETCH_HEAD"]);
      const head = await git(["rev-parse", "--short", "HEAD"]);
      // Passenger restarts the app when this file's modified time changes.
      const tmp = path.join(__dirname, "tmp");
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, "restart.txt"), new Date().toISOString() + "\n");
      console.log("[deploy] updated to " + head + " — restart requested.");
    } while (again); // another push arrived mid-update: go round once more
  } catch (err) {
    console.error("[deploy] FAILED: " + err.message);
  } finally {
    running = false;
  }
}

router.post("/", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
  if (!SECRET) return res.status(404).send("Not found");

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const got = Buffer.from(String(req.get("x-hub-signature-256") || ""));
  const want = Buffer.from("sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex"));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return res.status(401).send("Bad signature");
  }

  const event = req.get("x-github-event");
  if (event === "ping") return res.send("pong");
  if (event !== "push") return res.status(202).send("Ignored event");

  let payload;
  try { payload = JSON.parse(body.toString("utf8")); } catch { return res.status(400).send("Bad JSON"); }
  if (payload.ref !== "refs/heads/" + BRANCH) return res.status(202).send("Ignored branch");

  if (running) { again = true; return res.status(202).send("Update queued"); }
  res.status(202).send("Updating");
  deploy();
});

module.exports = router;
