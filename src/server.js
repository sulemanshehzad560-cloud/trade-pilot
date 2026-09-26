// Web server: password-protected dashboard + JSON API for the bot.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Bot, AED } from "./bot.js";
import { load, save, DATA_DIR } from "./store.js";

const PORT = +process.env.PORT || 8080, HOST = process.env.HOST || "0.0.0.0";
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const bot = new Bot();

// ---------- auth ----------
let auth = load("auth", null);
if (!auth) { auth = { secret: crypto.randomBytes(32).toString("hex"), hash: "", salt: "", v: 1, setupCode: process.env.SETUP_CODE || crypto.randomInt(100000, 999999).toString() }; save("auth", auth, true); }
if (!auth.hash) {
  fs.writeFileSync(path.join(DATA_DIR, "setup-code.txt"), auth.setupCode + "\n", { mode: 0o600 });
  console.log(`\n==============================================\n  First-time setup code: ${auth.setupCode}\n  Open the dashboard and enter this code to create your password.\n==============================================\n`);
}
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sign = (p) => crypto.createHmac("sha256", auth.secret).update(p).digest("base64url");
const makeSession = (days) => { const p = Buffer.from(JSON.stringify({ exp: Date.now() + days * 864e5, v: auth.v })).toString("base64url"); return p + "." + sign(p); };
function authed(req) {
  const m = /(?:^|;\s*)tp_s=([^;]+)/.exec(req.headers.cookie || ""); if (!m) return false;
  const [p, s] = m[1].split("."); if (!p || !s || !safeEq(s, sign(p))) return false;
  try { const d = JSON.parse(Buffer.from(p, "base64url").toString()); return d.exp > Date.now() && d.v === auth.v; } catch { return false; }
}
const fails = new Map();
function locked(ip) { const f = fails.get(ip); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; }
function failed(ip) { const f = fails.get(ip) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 15 * 60e3; } fails.set(ip, f); }
const validPw = (pw) => typeof pw === "string" && pw.length >= 8 ? null : "Password must be at least 8 characters";

// ---------- helpers ----------
const send = (res, code, data, headers = {}) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(data)); };
const readBody = (req) => new Promise((ok, bad) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e5) { bad(new Error("Too large")); req.destroy(); } }); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } }); });
const cookie = (req, val, maxAge) => `tp_s=${val}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted ? "; Secure" : ""}`;
const SEC = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'" };

const A = (x) => (["demo", "live"].includes(x) ? x : "demo");
const routes = {
  "GET /api/status": (b, q) => bot.status(A(q.get("acct"))),
  "GET /api/scan": () => ({ at: bot.scanAt, rows: Object.values(bot.scan).sort((a, b) => (b.signal - a.signal) || b.score - a.score) }),
  "GET /api/trades": (b, q) => ({ trades: bot.books[A(q.get("acct"))].trades.slice(0, 300) }),
  "GET /api/settings": () => bot.publicSettings(),
  "GET /api/log": (b, q) => ({ log: bot.logs.filter((l) => !q.get("acct") || !l.acct || l.acct === q.get("acct")).slice(-200).reverse() }),
  "POST /api/settings": (b) => { bot.update(b); return bot.publicSettings(); },
  "POST /api/keys": async (b) => { bot.setKeys(b); return { ...(await bot.testKeys(b.boToken ? "bitoasis" : b.key || b.secret ? "binance" : b.which)), settings: bot.publicSettings() }; },
  "POST /api/keys/test": (b) => bot.testKeys(b.which === "bitoasis" || b.which === "binance" ? b.which : undefined),
  "POST /api/keys/remove": (b) => { bot.removeKeys(b.which === "bitoasis" ? "bitoasis" : "binance"); return bot.publicSettings(); },
  "POST /api/telegram": async (b) => { bot.setTelegram(b); return { ok: await bot.notify("Test message: alerts are working ✅") }; },
  "POST /api/start": (b) => { bot.start(A(b.acct)); return bot.status(A(b.acct)); },
  "POST /api/stop": (b) => { bot.stop(A(b.acct)); return bot.status(A(b.acct)); },
  "POST /api/sellall": async (b) => ({ sold: await bot.sellAll(A(b.acct)), status: bot.status(A(b.acct)) }),
  "POST /api/close": async (b) => ({ trade: await bot.closeOne(A(b.acct), b.id), status: bot.status(A(b.acct)) }),
  "POST /api/reset-halt": (b) => { bot.resetHalt(A(b.acct)); return bot.status(A(b.acct)); },
  "POST /api/reset-demo": () => { bot.resetDemo(); return bot.status("demo"); },
  // Netlify's proxy gives up after ~26 s, so a long comparison answers "pending" and the app asks again.
  "POST /api/compare": (b) => { const a = A(b.acct), ac = bot.settings.accounts[a], k = bot.isBO(a) ? 1 / AED : 1; const job = bot.compare(!!b.force, ac.perTrade * k, ac.budget * k);
    return Promise.race([job, new Promise((r) => setTimeout(() => r({ pending: true }), 20000))]); },
  "POST /api/backtest": (b) => { const a = A(b.acct), ac = bot.settings.accounts[a], k = bot.isBO(a) ? 1 / AED : 1; return bot.backtest(!!b.force, ac.perTrade * k, ac.budget * k); },
  "POST /api/password": (b) => {
    if (!safeEq(hashPw(b.current || "", auth.salt), auth.hash)) throw new Error("Current password is wrong");
    const e = validPw(b.password); if (e) throw new Error(e);
    auth.salt = crypto.randomBytes(16).toString("hex"); auth.hash = hashPw(b.password, auth.salt); auth.v++; save("auth", auth, true); return { ok: true, relogin: true };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x"), ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  try {
    if (!url.pathname.startsWith("/api/")) {
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^[\w.-]+$/.test(file)) { res.writeHead(404); return res.end(); }
      const fp = path.join(PUB, file); if (!fs.existsSync(fp)) { res.writeHead(404); return res.end("Not found"); }
      const type = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".js": "text/javascript", ".css": "text/css; charset=utf-8", ".webmanifest": "application/manifest+json" }[path.extname(fp)] || "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache", ...SEC }); return fs.createReadStream(fp).pipe(res);
    }
    const key = `${req.method} ${url.pathname}`;
    if (req.method === "POST" && req.headers["x-tp"] !== "1") return send(res, 403, { error: "Bad request" });
    const body = req.method === "POST" ? await readBody(req) : {};
    if (key === "GET /api/ping") return send(res, 200, { ok: true, app: "trade-pilot" });
    if (key === "GET /api/auth") return send(res, 200, { setup: !auth.hash, authed: authed(req) });
    if (key === "POST /api/setup") {
      if (auth.hash) return send(res, 400, { error: "Password already created" });
      const lk = locked(ip); if (lk) return send(res, 429, { error: `Too many attempts. Try again in ${lk} min.` });
      if (!safeEq(String(body.code || "").trim(), auth.setupCode)) { failed(ip); return send(res, 401, { error: "Wrong setup code" }); }
      const e = validPw(body.password); if (e) return send(res, 400, { error: e });
      auth.salt = crypto.randomBytes(16).toString("hex"); auth.hash = hashPw(body.password, auth.salt); delete auth.setupCode; save("auth", auth, true);
      try { fs.unlinkSync(path.join(DATA_DIR, "setup-code.txt")); } catch {}
      return send(res, 200, { ok: true }, { "set-cookie": cookie(req, makeSession(30), 30 * 86400) });
    }
    if (key === "POST /api/login") {
      const lk = locked(ip); if (lk) return send(res, 429, { error: `Too many attempts. Try again in ${lk} min.` });
      if (!auth.hash || !safeEq(hashPw(body.password || "", auth.salt), auth.hash)) { failed(ip); await new Promise((r) => setTimeout(r, 700)); return send(res, 401, { error: "Wrong password" }); }
      fails.delete(ip); const days = body.remember ? 30 : 1;
      return send(res, 200, { ok: true }, { "set-cookie": cookie(req, makeSession(days), days * 86400) });
    }
    if (key === "POST /api/logout") return send(res, 200, { ok: true }, { "set-cookie": cookie(req, "", 0) });
    if (!authed(req)) return send(res, 401, { error: "Please sign in" });
    const fn = routes[key]; if (!fn) return send(res, 404, { error: "Not found" });
    send(res, 200, await fn(body, url.searchParams));
  } catch (e) { send(res, 400, { error: e.message || "Error" }); }
});
server.listen(PORT, HOST, () => console.log(`Trade Pilot dashboard on http://${HOST}:${PORT}  (data: ${DATA_DIR})`));
bot.run(+process.env.TICK_MS || 20000);
const shutdown = () => { console.log("Shutting down"); server.close(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
