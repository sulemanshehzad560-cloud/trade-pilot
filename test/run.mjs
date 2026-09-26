// End-to-end test: real server + bot against the strict fake Binance.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mock from "./mock-binance.mjs";
import * as bo from "./mock-bitoasis.mjs";
import { DEFAULTS as SDEF } from "../src/strategy.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MP = 9311, SP = 9312, BP = 9313, BASE = `http://127.0.0.1:${SP}`;
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

await mock.start(MP); await bo.start(BP);
const srv = spawn(process.execPath, ["src/server.js"], { cwd: ROOT, env: { ...process.env, PORT: SP, HOST: "127.0.0.1", DATA_DIR: DATA, BINANCE_BASE: `http://127.0.0.1:${MP}`, BITOASIS_BASE: `http://127.0.0.1:${BP}/v1`, TICK_MS: "1500", SETUP_CODE: "123456" }, stdio: ["ignore", "pipe", "pipe"] });
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
  ok(SDEF.exit !== "trail" || st.positions.every((p) => p.tp === null), "trailing-stop strategy shows no take-profit it won't use");

  console.log("Breakeven, stop-loss and sell now");
  // rise just past the strategy's breakeven level (breakevenR × the risk), but not far enough to start trailing
  mock.setPrice("SOLUSDT", sol.entry + sol.stopDist * (SDEF.breakevenR + 0.1));
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

  console.log("BitOasis (live in AED)");
  const binanceOrders = mock.state.orders.length;
  r = await api("settings", { liveExchange: "bitoasis" });
  ok(r.status === 200 && r.d.liveCcy === "AED" && r.d.accounts.live.budget === 550 && r.d.accounts.live.perTrade === 185, `switched live to BitOasis; budget converted to AED (${r.d.accounts && r.d.accounts.live.budget} / ${r.d.accounts && r.d.accounts.live.perTrade})`);
  ok((await api("settings", { accounts: { live: { budget: 400, perTrade: 20 } } })).status === 400, "per-trade below BitOasis minimum (25 AED) rejected");
  await api("settings", { accounts: { live: { budget: 400, perTrade: 150 } } });
  st = (await api("status?acct=live")).d;
  ok(st.ccy === "AED" && st.exName === "BitOasis" && st.trades === 0 && !st.hasKeys, "live now shows AED, a fresh BitOasis history and no token yet");
  r = await api("start", { acct: "live" });
  ok(r.status === 400 && /BitOasis/.test(r.d.error), "live can't start without a BitOasis token");
  r = await api("keys", { boToken: "wrong" });
  ok(!r.d.ok && /token/.test(r.d.error), "wrong BitOasis token reported clearly: " + r.d.error);
  r = await api("keys", { boToken: "Bearer botoken" });
  ok(r.d.ok && Math.abs(r.d.free - 1000) < 0.01, "token verified and AED balance read (nested balance format)");
  ok(!JSON.stringify((await api("settings")).d).includes("botoken"), "BitOasis token is never sent back to the browser");
  const scb = await until(async () => { const x = (await api("scan")).d; return x.rows && x.rows.some((y) => y.onBO !== undefined) && x; });
  ok(scb && scb.rows.find((x) => x.symbol === "BTCUSDT").onBO === false && scb.rows.find((x) => x.symbol === "SOLUSDT").onBO === true, "scanner knows which coins BitOasis lists (no BTC in the fake market)");
  await api("start", { acct: "live" });
  st = await until(async () => { const s = (await api("status?acct=live")).d; return s.positions.length === 2 && s.positions.every((p) => p.stopOrderId) && s; });
  ok(!!st, "BitOasis: bought SOL-AED and ETH-AED, each with a stop order on BitOasis");
  ok(bo.state.errors.length === 0, "BitOasis accepted every real order: " + (bo.state.errors.join("; ") || "no errors"));
  ok(bo.state.tests >= 4, `every real order was checked with ?test=true first (${bo.state.tests} checks)`);
  ok(mock.state.orders.length === binanceOrders, "no orders were sent to Binance");
  ok(st && st.committed <= 300.01 && st.positions.every((p) => p.pair.endsWith("-AED") && p.cost <= 150), `spent within 150 AED per trade (${st && st.committed.toFixed(2)} AED)`);
  ok(st && Math.abs(1000 - bo.state.bal.AED - st.committed) < 0.01, "cost recorded matches what left the AED wallet exactly");
  const bsol = st.positions.find((p) => p.symbol === "SOLUSDT"), beth = st.positions.find((p) => p.symbol === "ETHUSDT");
  mock.setPrice("SOLUSDT", bsol.entry / 3.6725 / 0.999 * (1 + bsol.stopDist / bsol.entry * (SDEF.breakevenR + 0.2)));
  st = await until(async () => { const s = (await api("status?acct=live")).d, p = s.positions.find((x) => x.symbol === "SOLUSDT"); return p && p.stop >= p.entry && p.stopOrderId !== bsol.stopOrderId && s; });
  const solStops = bo.state.orders.filter((o) => o.pair === "SOL-AED" && o.type === "stop");
  ok(!!st && solStops.length === 2 && solStops[0].status === "CANCELED" && solStops[1].status === "OPEN", "breakeven: old BitOasis stop cancelled, new one placed");
  mock.setPrice("SOLUSDT", bsol.entry / 3.6725 * 0.97);
  await until(async () => !(await api("status?acct=live")).d.positions.some((p) => p.symbol === "SOLUSDT"));
  const bt1 = (await api("trades?acct=live")).d.trades.find((t) => t.symbol === "SOLUSDT");
  ok(bt1 && /BitOasis/.test(bt1.reason), "stop filled on BitOasis and recorded: " + (bt1 && bt1.reason));
  ok((await api("settings", { liveExchange: "binance" })).status === 400, "can't switch exchange while a live trade is open");
  r = await api("close", { acct: "live", id: beth.id });
  ok(r.status === 200 && /Sold by you/.test(r.d.trade.reason) && r.d.trade.proceeds > 0, `Sell now sold ETH-AED at market (${r.d.trade && r.d.trade.pnl.toFixed(2)} AED)`);
  ok(!bo.state.orders.some((o) => o.type === "stop" && o.status === "OPEN"), "no stop orders left behind on BitOasis");
  ok((bo.state.bal.SOL || 0) < 0.001 && (bo.state.bal.ETH || 0) < 0.0001 && !(bo.state.locked.SOL > 1e-9), "no coins left over after selling");
  ok(bo.state.errors.length === 0, "still no rejected BitOasis orders");
  await api("stop", { acct: "live" });
  r = await api("settings", { liveExchange: "binance" });
  st = (await api("status?acct=live")).d;
  ok(r.status === 200 && st.ccy === "USDT" && st.trades === 2, "switching back to Binance brings back the Binance history (in USDT)");

  console.log("Backtest");
  r = await api("backtest", { acct: "demo", force: true });
  ok(r.status === 200 && r.d.symbols.length === 3 && r.d.symbols.every((s) => !s.error), `backtest ran on 3 coins: ${r.d.total.trades} trades, ${r.d.total.pnl.toFixed(2)} USDT`);

  console.log("Strategy Lab");
  const { PRESETS, manage } = await import("../src/strategy.js");
  r = await api("compare", { acct: "demo", force: true });
  ok(r.status === 200 && r.d.rows.length === PRESETS.length && r.d.rows.every((x, i, a) => !i || a[i - 1].pnl >= x.pnl), `compared ${r.d.rows && r.d.rows.length} strategies on the watched coins, ranked by profit (best: ${r.d.rows && r.d.rows[0].name} ${r.d.rows && r.d.rows[0].pnl} USDT)`);
  ok(r.d.rows.every((x) => typeof x.winRate === "number" && typeof x.maxDD === "number" && Array.isArray(x.curve)) && r.d.rows.filter((x) => x.current).length === 1, "every strategy has win rate, worst dip and a profit curve; exactly one is marked as in use");
  r = await api("settings", { strategy: { preset: "st-4h" } });
  ok(r.status === 200 && r.d.strategy.entry === "supertrend" && r.d.strategy.interval === "4h" && r.d.strategyInfo.name === "Supertrend", "choosing Supertrend switches the bot's entry rules and timeframe");
  ok(r.d.strategy.maxStopPct === 6 && r.d.dailyLossPct === 1, "choosing a strategy keeps the risk limits");
  ok((await api("settings", { strategy: { preset: "nope" } })).status === 400, "unknown strategy rejected");
  ok((await api("status?acct=demo")).d.strategy.name === "Supertrend", "status shows the strategy in use");
  await api("settings", { strategy: { preset: "pb-trail-1h" } });
  const tp = { entry: 100, stop: 97, tp: 104, stopDist: 3, peak: 100, openedAt: Date.now(), exit: "target" };
  ok(manage(tp, { high: 104.5, low: 101, price: 104 }).reason === "Take-profit", "a bounce trade sells at its own target even while the strategy trails");
  const tr = { entry: 100, stop: 97, tp: 104, stopDist: 3, peak: 100, openedAt: Date.now(), exit: "trail" };
  ok(!manage(tr, { high: 104.5, low: 101, price: 104 }).exit, "a trend trade ignores an old target and keeps trailing");

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
