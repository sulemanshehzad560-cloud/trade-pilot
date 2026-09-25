// End-to-end test: real server + bot against the strict fake Binance.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mock from "./mock-binance.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MP = 9311, SP = 9312, BASE = `http://127.0.0.1:${SP}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "tp-"));
let pass = 0, fail = 0, cookie = "";
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(p, body) {
  const r = await fetch(BASE + "/api/" + p, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-tp": "1", cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return { status: r.status, d: await r.json() };
}
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(300); } return null; }

await mock.start(MP);
const srv = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env: { ...process.env, PORT: SP, HOST: "127.0.0.1", DATA_DIR: DATA, BINANCE_BASE: `http://127.0.0.1:${MP}`, TICK_MS: "1500", SETUP_CODE: "123456" }, stdio: ["ignore", "pipe", "pipe"] });
let out = ""; srv.stdout.on("data", (d) => (out += d)); srv.stderr.on("data", (d) => (out += d));
await until(async () => { try { return (await fetch(BASE + "/api/ping")).ok; } catch { return false; } });

try {
  console.log("Login & security");
  ok((await api("status?acct=demo")).status === 401, "API refuses requests before sign-in");
  ok((await api("setup", { code: "000000", password: "longpassword" })).status === 401, "wrong setup code rejected");
  ok((await api("setup", { code: "123456", password: "longpassword" })).status === 200 && cookie, "setup code creates the password and signs in");
  ok((await api("setup", { code: "123456", password: "another123" })).status === 400, "setup can't be repeated");
  const r403 = await fetch(BASE + "/api/start", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
  ok(r403.status === 403, "POST without the app header is blocked (CSRF protection)");

  console.log("Settings");
  let r = await api("settings", { accounts: { demo: { budget: 200, perTrade: 100 }, live: { budget: 150, perTrade: 50 } }, maxOpen: 2, dailyLossPct: 1, watch: "SOL, ETH, BTC" });
  ok(r.status === 200 && r.d.watch.join() === "SOLUSDT,ETHUSDT,BTCUSDT", "watchlist saved as USDT pairs");
  ok((await api("settings", { accounts: { live: { perTrade: 500 } } })).status === 400, "per-trade above budget rejected");

  console.log("Scanner");
  const sc = await until(async () => { const x = (await api("scan")).d; return x.rows && x.rows.length === 3 && x; });
  ok(sc && sc.rows.filter((x) => x.signal).map((x) => x.symbol).sort().join() === "ETHUSDT,SOLUSDT", "buy signals found on SOL and ETH, not BTC");
  ok(sc && sc.rows.find((x) => x.symbol === "BTCUSDT").status === "avoid", "BTC downtrend labelled avoid");

  console.log("Demo account");
  ok((await api("start", { acct: "live" })).status === 400, "live can't start without API keys");
  await api("start", { acct: "demo" });
  let st = await until(async () => { const s = (await api("status?acct=demo")).d; return s.positions.length === 2 && s; });
  ok(!!st, "demo opened 2 trades (SOL + ETH)");
  ok(mock.state.orders.length === 0, "demo placed no real orders");
  ok(st && Math.abs(st.committed - 200) < 0.01 && st.available < 0.01, "demo budget fully used and not exceeded");

  console.log("Live account");
  r = await api("keys", { key: "testkey", secret: "wrong" });
  ok(!r.d.ok && /Signature/.test(r.d.error), "wrong secret reported clearly");
  r = await api("keys", { key: "testkey", secret: "testsecret" });
  ok(r.d.ok && Math.abs(r.d.usdt - 500) < 0.01 && r.d.warn.some((w) => /IP/.test(w)), "keys verified, balance read, IP-lock warning shown");
  ok(!JSON.stringify((await api("settings")).d).includes("testsecret"), "secret key is never sent back to the browser");
  ok((await api("settings")).d.accounts.live.perTrade === 50, "rejected settings change left the saved values untouched");
  mock.state.errors.length = 0;
  await api("start", { acct: "live" });
  st = await until(async () => { const s = (await api("status?acct=live")).d; return s.positions.length === 2 && s.positions.every((p) => p.stopOrderId) && s; });
  ok(!!st, "live opened 2 real orders, each protected by a stop-loss on Binance");
  ok(mock.state.errors.length === 0, "Binance accepted every order (steps, ticks, minimums): " + (mock.state.errors.join("; ") || "no errors"));
  ok(st && st.committed <= 150 + 0.01, "live spent within its 150 USDT budget");
  const sol = st.positions.find((p) => p.symbol === "SOLUSDT"), eth = st.positions.find((p) => p.symbol === "ETHUSDT");

  console.log("Breakeven, stop-loss and sell now");
  mock.setPrice("SOLUSDT", sol.entry + sol.stopDist * 1.6);
  st = await until(async () => { const s = (await api("status?acct=live")).d, p = s.positions.find((x) => x.symbol === "SOLUSDT"); return p && p.stop >= p.entry && s; });
  ok(!!st, "stop moved to breakeven after price rose");
  const solStop = mock.state.orders.filter((o) => o.symbol === "SOLUSDT" && o.type === "STOP_LOSS_LIMIT");
  ok(solStop.length === 2 && solStop[0].status === "CANCELED" && solStop[1].status === "NEW", "old exchange stop cancelled, new one placed at breakeven");
  mock.setPrice("SOLUSDT", sol.entry * 0.99);
  st = await until(async () => { const s = (await api("status?acct=live")).d; return !s.positions.some((p) => p.symbol === "SOLUSDT") && s; });
  const t1 = (await api("trades?acct=live")).d.trades.find((t) => t.symbol === "SOLUSDT");
  ok(t1 && /Binance/.test(t1.reason), "exchange stop filled and recorded: " + (t1 && t1.reason));
  const demoSol = (await api("trades?acct=demo")).d.trades.find((t) => t.symbol === "SOLUSDT");
  ok(demoSol && /Breakeven/.test(demoSol.reason), "demo closed SOL at its breakeven stop too");
  r = await api("close", { acct: "live", id: eth.id });
  ok(r.status === 200 && /Sold by you/.test(r.d.trade.reason), "Sell now closed live ETH at market");
  ok(!mock.state.orders.some((o) => o.type === "STOP_LOSS_LIMIT" && o.status === "NEW"), "no stop orders left behind on Binance");
  ok((mock.state.bal.SOL || 0) < 0.002 && (mock.state.bal.ETH || 0) < 0.0002, "no coins left over after selling (only rounding dust)");
  ok(mock.state.errors.length === 0, "still no rejected orders");

  console.log("Loss limits & sell all");
  const demoEth = (await api("status?acct=demo")).d.positions.find((p) => p.symbol === "ETHUSDT");
  mock.setPrice("ETHUSDT", demoEth.stop * 0.995);
  st = await until(async () => { const s = (await api("status?acct=demo")).d; return s.halt && s; });
  ok(st && st.halt.type === "daily", "demo daily loss limit (1%) paused new trades: " + (st && st.halt.reason));
  await api("reset-demo", {});
  st = (await api("status?acct=demo")).d;
  ok(st.trades === 0 && !st.running && !st.halt, "demo reset clears trades and stops the demo bot");
  const live = (await api("status?acct=live")).d;
  ok(live.trades === 2 && live.running, "live account unaffected by the demo reset");
  r = await api("sellall", { acct: "live" });
  ok(r.status === 200 && !r.d.status.running, "sell all stops the live bot");

  console.log("Backtest");
  r = await api("backtest", { acct: "demo", force: true });
  ok(r.status === 200 && r.d.symbols.length === 3 && r.d.symbols.every((s) => !s.error), `backtest ran on 3 coins: ${r.d.total.trades} trades, ${r.d.total.pnl.toFixed(2)} USDT`);

  console.log("Compare strategies");
  r = await api("compare", { acct: "demo" });
  ok(r.status === 200 && r.d.rows.length === 6 && r.d.rows.every((x) => isFinite(x.pnl) && isFinite(x.holdPnl)), `compared 6 strategies: ${r.status === 200 ? r.d.rows.map((x) => `${x.id} ${x.pnl.toFixed(1)}`).join(", ") : JSON.stringify(r.d)}`);
  ok(r.d.rows.filter((x) => x.current).length === 1 && r.d.rows.find((x) => x.current).id === "pb-trail-1h", "current strategy marked (pullback + trailing, 1h)");
  r = await api("preset", { id: "bo-trail-4h" });
  ok(r.status === 200 && r.d.strategy.interval === "4h" && r.d.strategy.entry === "breakout" && r.d.strategy.exit === "trail", "Use this: switched to breakout + trailing on 4h");
  ok((await api("preset", { id: "nope" })).status === 400, "unknown strategy rejected");
  ok((await api("settings", { strategy: { exit: "moon" } })).status === 400, "invalid exit style rejected");

  console.log("Password");
  ok((await api("password", { current: "nope", password: "newpassword1" })).status === 400, "wrong current password rejected");
  ok((await api("password", { current: "longpassword", password: "newpassword1" })).status === 200, "password changed");
  ok((await api("status?acct=demo")).status === 401, "old sessions signed out after password change");
  for (let i = 0; i < 5; i++) await api("login", { password: "bad" + i });
  ok((await api("login", { password: "newpassword1" })).status === 429, "5 wrong passwords lock sign-in for 15 minutes");
} catch (e) { fail++; console.log("  ✗ crashed:", e.stack); }
srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("\n--- server output ---\n" + out.slice(-3000)); process.exit(1); }
process.exit(0);
