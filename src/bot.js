// Trading engine with two accounts that run side by side:
//   demo – pretend money on live Binance prices (no keys needed)
//   live – real orders on Binance (USDT) or BitOasis (AED), chosen in Settings
// Each account has its own budget, trades, profit and Start/Stop. Strategy and safety rules are shared.
// Signals always come from Binance's public price charts (no account needed); BitOasis has no chart API.
import { Binance, floorToStep, roundToStep, fillSummary } from "./binance.js";
import { BitOasis, toPair, orderStatus } from "./bitoasis.js";
import { analyse, manage, DEFAULTS as SDEF, PRESETS, presetOf, ENTRIES } from "./strategy.js";
import { backtestSymbol, combinedDD } from "./backtest.js";
import { load, save } from "./store.js";

export const AED = 3.6725;
export const ACCTS = ["demo", "live"];
const FEE = 0.001, SLIP = 0.0005, BO_FEE = 0.005, BO_BUFFER = 0.012;
const EXCH = ["binance", "bitoasis"], EXNAME = { binance: "Binance", bitoasis: "BitOasis" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACCT_DEF = { running: false, budget: 150, perTrade: 50 };
const SETTINGS_DEF = {
  accounts: { demo: { ...ACCT_DEF, budget: 1000, perTrade: 100 }, live: { ...ACCT_DEF } },
  liveExchange: "binance", maxOpen: 2, dailyLossPct: 5, maxLossPct: 20, cooldownHours: 6,
  watch: ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT"],
  strategy: { preset: "pb-trail-1h", interval: "1h", rr: 2, maxStopPct: 6, maxHoldHours: 72 },
};
const BOOK_DEF = { positions: [], trades: [], realized: 0, day: { key: "", pnl: 0 }, halt: null, lastBar: {}, cooldown: {}, equity: [] };
const dubaiDay = (t = Date.now()) => new Date(t + 4 * 3600e3).toISOString().slice(0, 10);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmtPx = (x) => x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(4);
const NAME = { demo: "Demo", live: "LIVE" };

export class Bot {
  constructor({ base = process.env.BINANCE_BASE || "https://api.binance.com", boBase = process.env.BITOASIS_BASE || "https://api.bitoasis.net/v1", fetchImpl } = {}) {
    const st = load("settings", SETTINGS_DEF);
    this.settings = { ...SETTINGS_DEF, ...st, strategy: { ...SETTINGS_DEF.strategy, ...(st.strategy || {}) } };
    this.settings.accounts = { demo: { ...SETTINGS_DEF.accounts.demo, ...(st.accounts || {}).demo }, live: { ...SETTINGS_DEF.accounts.live, ...(st.accounts || {}).live } };
    if (!EXCH.includes(this.settings.liveExchange)) this.settings.liveExchange = "binance";
    this.secrets = { key: "", secret: "", tgToken: "", tgChat: "", boToken: "", ...load("secrets", {}) };
    this.books = {}; for (const a of ACCTS) this.loadBook(a);
    this.logs = load("log", []);
    this.base = base; this.fetchImpl = fetchImpl; this.boBase = boBase;
    this.api = new Binance({ key: this.secrets.key, secret: this.secrets.secret, base, fetchImpl });
    this.bo = new BitOasis({ token: this.secrets.boToken, base: boBase, fetchImpl });
    this.boPx = {}; this.boPairs = null;
    this.scan = {}; this.scanAt = 0; this.prices = {}; this.busy = false; this.lastError = null; this.errCount = 0; this.bt = null; this.btAt = 0;
  }
  acct(a) { if (!ACCTS.includes(a)) throw new Error("Unknown account"); return this.settings.accounts[a]; }
  saveSettings() { save("settings", this.settings); }
  // The live account keeps a separate history per exchange, so USDT and AED results never mix.
  bookKey(a) { return a === "live" && this.settings.liveExchange === "bitoasis" ? "book-live-bitoasis" : "book-" + a; }
  loadBook(a) { this.books[a] = { ...structuredClone(BOOK_DEF), ...load(this.bookKey(a), BOOK_DEF) }; }
  saveBook(a) { save(this.bookKey(a), this.books[a]); }
  isBO(a) { return a === "live" && this.settings.liveExchange === "bitoasis"; }
  ccy(a) { return this.isBO(a) ? "AED" : "USDT"; }
  exName(a) { return a === "live" ? EXNAME[this.settings.liveExchange] : "Demo"; }
  minTrade(a) { return this.isBO(a) ? 25 : 6; }
  hasKeys(a) { return a !== "live" || (this.isBO(a) ? this.bo.hasKeys : this.api.hasKeys); }
  // Price used to value/manage a position: BitOasis bid (what you'd get selling) or Binance last price.
  pxOf(p) { if (p.ex === "bitoasis") { const t = this.boPx[p.symbol]; return t ? t.bid : undefined; } return this.prices[p.symbol]; }
  feeOf(p) { return p.ex === "bitoasis" ? BO_FEE : FEE; }
  // One trading action at a time (the loop, "Sell now" and "Sell all" never overlap).
  async exclusive(fn) { const t = Date.now(); while (this.busy) { if (Date.now() - t > 60e3) throw new Error("The bot is busy, try again in a minute"); await sleep(150); } this.busy = true; try { return await fn(); } finally { this.busy = false; } }
  log(level, msg, a) {
    const e = { t: Date.now(), level, msg, acct: a || null }; this.logs.push(e); if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    save("log", this.logs); console.log(`[${new Date().toISOString()}] ${level.toUpperCase()}${a ? " " + NAME[a] : ""} ${msg}`);
    if (level === "trade" || level === "alert") this.notify(`${a ? `[${NAME[a]}] ` : ""}${msg}`);
  }
  async notify(text) {
    const { tgToken, tgChat } = this.secrets; if (!tgToken || !tgChat) return false;
    try { const r = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: tgChat, text: `🤖 Trade Pilot\n${text}` }), signal: AbortSignal.timeout(8000) }); return r.ok; }
    catch { return false; }
  }
  setKeys({ key, secret, boToken }) {
    if (key !== undefined && key !== "") this.secrets.key = String(key).trim();
    if (secret !== undefined && secret !== "") this.secrets.secret = String(secret).trim();
    if (boToken !== undefined && boToken !== "") this.secrets.boToken = String(boToken).trim().replace(/^Bearer\s+/i, "");
    save("secrets", this.secrets, true);
    this.api = new Binance({ key: this.secrets.key, secret: this.secrets.secret, base: this.base, fetchImpl: this.fetchImpl });
    this.bo = new BitOasis({ token: this.secrets.boToken, base: this.boBase, fetchImpl: this.fetchImpl });
  }
  removeKeys(which = "binance") {
    const current = this.settings.liveExchange === which;
    if (current && this.books.live.positions.length) throw new Error("Close the open live trades first");
    if (current && this.acct("live").running) this.stop("live", `${EXNAME[which]} keys removed`);
    if (which === "bitoasis") this.secrets.boToken = ""; else { this.secrets.key = ""; this.secrets.secret = ""; }
    save("secrets", this.secrets, true); this.setKeys({});
  }
  setTelegram({ token, chat }) { if (token) this.secrets.tgToken = String(token).trim(); if (chat !== undefined) this.secrets.tgChat = String(chat).trim(); save("secrets", this.secrets, true); }

  // ---------- settings ----------
  // All-or-nothing: changes are checked on a copy, and only saved if every value is valid.
  update(p) {
    const copy = structuredClone(this.settings), before = { watch: copy.watch.join(), interval: copy.strategy.interval };
    const ex = p.liveExchange, switching = ex !== undefined && ex !== copy.liveExchange;
    if (switching) {
      if (!EXCH.includes(ex)) throw new Error("Unknown exchange");
      if (this.books.live.positions.length) throw new Error("Close the open live trades before changing exchange");
      if (copy.accounts.live.running) throw new Error("Stop the live bot before changing exchange");
      // Keep the same real-money size when the currency changes (1 USDT ≈ 3.67 AED)
      const k = ex === "bitoasis" ? AED : 1 / AED, r = (x) => Math.max(ex === "bitoasis" ? 25 : 6, Math.round(x * k / 5) * 5 || 0);
      if (!(p.accounts && p.accounts.live)) { copy.accounts.live.budget = r(copy.accounts.live.budget); copy.accounts.live.perTrade = Math.min(r(copy.accounts.live.perTrade), copy.accounts.live.budget); }
      copy.liveExchange = ex;
    }
    this._apply(copy, p);
    this.settings = copy;
    if (switching) { this.loadBook("live"); this.boPx = {}; this.scanAt = 0; this.log("info", `Live account now trades on ${EXNAME[ex]} (${this.ccy("live")})`, "live"); }
    if (copy.watch.join() !== before.watch || copy.strategy.interval !== before.interval) { this.scanAt = 0; this.scan = {}; }
    this.bt = null; if (this.cmp) this.cmp.rows.forEach((r) => { r.current = r.id === copy.strategy.preset; }); this.saveSettings();
  }
  _apply(s, p) {
    const num =(v, lo, hi, name) => { const n = Number(v); if (!isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be between ${lo} and ${hi}`); return n; };
    for (const a of ACCTS) {
      const q = p.accounts && p.accounts[a]; if (!q) continue; const t = s.accounts[a];
      if (q.budget !== undefined) t.budget = num(q.budget, 10, 1e7, `${NAME[a]} budget`);
      const min = a === "live" && s.liveExchange === "bitoasis" ? 25 : 6;
      if (q.perTrade !== undefined) t.perTrade = num(q.perTrade, min, 1e7, `${NAME[a]} amount per trade`);
      if (t.perTrade > t.budget) throw new Error(`${NAME[a]}: amount per trade can't be more than the budget`);
    }
    if (p.maxOpen !== undefined) s.maxOpen = Math.round(num(p.maxOpen, 1, 10, "Max open trades"));
    if (p.dailyLossPct !== undefined) s.dailyLossPct = num(p.dailyLossPct, 1, 50, "Daily loss limit");
    if (p.maxLossPct !== undefined) s.maxLossPct = num(p.maxLossPct, 2, 90, "Max total loss");
    if (p.cooldownHours !== undefined) s.cooldownHours = num(p.cooldownHours, 0, 168, "Pause after a loss");
    if (p.watch !== undefined) {
      const w = [...new Set((Array.isArray(p.watch) ? p.watch : String(p.watch).split(/[\s,]+/)).map((x) => String(x).toUpperCase().replace(/[^A-Z0-9]/g, "")).filter(Boolean))].map((x) => x.endsWith("USDT") ? x : x + "USDT");
      if (!w.length || w.length > 15) throw new Error("Watch between 1 and 15 coins");
      s.watch = w;
    }
    if (p.strategy) {
      const st = s.strategy, q = p.strategy;
      if (q.interval !== undefined) { if (!["15m", "1h", "4h"].includes(q.interval)) throw new Error("Timeframe must be 15m, 1h or 4h"); st.interval = q.interval; }
      if (q.rr !== undefined) st.rr = num(q.rr, 1, 5, "Reward:risk");
      if (q.maxStopPct !== undefined) st.maxStopPct = num(q.maxStopPct, 1, 20, "Max stop-loss");
      if (q.maxHoldHours !== undefined) st.maxHoldHours = num(q.maxHoldHours, 0, 720, "Max hold time");
      // Choosing a strategy from the Strategy Lab: take its entry/exit rules and timeframe, keep the risk limits.
      if (q.preset !== undefined) {
        const pr = presetOf(q.preset); if (!pr) throw new Error("Unknown strategy");
        for (const k of ["entry", "exit", "trailR", "breakevenR", "beLock", "rr"]) delete st[k];
        Object.assign(st, pr.p, { preset: pr.id });
      }
      if (st.entry !== undefined && !ENTRIES.includes(st.entry)) throw new Error("Unknown entry style");
    }
  }
  start(a) {
    const b = this.books[a];
    if (b.halt && b.halt.type === "maxloss") throw new Error("The max-loss limit was hit. Review your settings and tap Reset limit first.");
    if (!this.hasKeys(a)) throw new Error(this.isBO(a) ? "Add your BitOasis API token in Settings first" : "Add your Binance API keys in Settings first");
    this.acct(a).running = true; this.saveSettings(); this.log("info", "Bot started", a);
  }
  stop(a, reason = "Stopped by you") { this.acct(a).running = false; this.saveSettings(); this.log("info", `Bot stopped (${reason}). Open trades stay protected by their stop-loss.`, a); }
  resetHalt(a) { this.books[a].halt = null; this.saveBook(a); this.log("info", "Loss limit reset by you", a); }
  resetDemo() {
    if (this.acct("demo").running) this.stop("demo", "Demo account reset");
    this.books.demo = structuredClone(BOOK_DEF); this.saveBook("demo"); this.log("info", "Demo account reset to a fresh start", "demo");
  }

  async testKeys(which = this.settings.liveExchange) {
    if (which === "bitoasis") {
      try {
        const b = await this.bo.balances(), coins = Object.entries(b).filter(([c, v]) => c !== "AED" && v > 0).map(([c, v]) => `${c} ${+v.toPrecision(6)}`);
        return { ok: true, exchange: "bitoasis", ccy: "AED", free: b.AED || 0, coins, warn: ["Make sure this token has NO withdrawal permission. It only needs trading and balance access."] };
      } catch (e) { return { ok: false, exchange: "bitoasis", error: e.message }; }
    }
    try {
      const acc = await this.api.account();
      const usdt = (acc.balances || []).find((x) => x.asset === "USDT");
      let r = null; try { r = await this.api._req("GET", "/sapi/v1/account/apiRestrictions", {}, true); } catch {}
      const warn = [];
      if (r && r.enableWithdrawals) warn.push("This key can WITHDRAW funds. Edit it on Binance and untick 'Enable Withdrawals'.");
      if (r && r.ipRestrict === false) warn.push("This key isn't locked to your server's IP. Restricting it makes it much safer.");
      if (acc.canTrade === false || (r && r.enableSpotAndMarginTrading === false)) return { ok: false, error: "This key doesn't have 'Enable Spot & Margin Trading' switched on." };
      return { ok: true, exchange: "binance", ccy: "USDT", usdt: usdt ? +usdt.free : 0, free: usdt ? +usdt.free : 0, warn };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ---------- loop ----------
  run(everyMs = 20000) { this.timer = setInterval(() => this.tick().catch((e) => this.fail(e)), everyMs); setTimeout(() => this.tick().catch((e) => this.fail(e)), 1500); }
  fail(e) { this.errCount++; this.lastError = { t: Date.now(), msg: e.message }; if (this.errCount <= 3 || this.errCount % 30 === 0) this.log(this.errCount > 5 ? "alert" : "error", e.message); }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      for (const a of ACCTS) { const b = this.books[a]; if (b.day.key !== dubaiDay()) { b.day = { key: dubaiDay(), pnl: 0 }; if (b.halt && b.halt.type === "daily") { b.halt = null; this.log("info", "New day: daily loss limit reset", a); } this.saveBook(a); } }
      if (Date.now() - this.scanAt > 5 * 60e3) await this.doScan();
      const syms = [...new Set([...this.settings.watch, ...ACCTS.flatMap((a) => this.books[a].positions.map((p) => p.symbol))])];
      this.prices = { ...this.prices, ...(await this.api.prices(syms)) };
      const boPos = this.books.live.positions.filter((p) => p.ex === "bitoasis");
      if (this.isBO("live") && (this.acct("live").running || boPos.length)) {
        const want = [...new Set([...(this.acct("live").running ? this.settings.watch.filter((x) => this.onBO(x) !== false) : []), ...boPos.map((p) => p.symbol)])];
        try { Object.assign(this.boPx, await this.bo.prices(want)); } catch (e) { this.log("error", e.message, "live"); }
      }
      for (const a of ACCTS) {
        for (const p of [...this.books[a].positions]) { try { await this.managePos(a, p); } catch (e) { this.log("error", `${p.symbol}: ${e.message}`, a); } }
        this.checkLimits(a);
        if (this.acct(a).running && !this.books[a].halt) await this.lookForEntries(a);
      }
      this.errCount = 0;
    } finally { this.busy = false; }
  }
  async doScan() {
    const s = this.settings, out = {}, now = Date.now();
    for (const sym of s.watch) {
      try {
        let k = await this.api.klines(sym, s.strategy.interval, 320);
        if (k.length && k[k.length - 1].ct > now) k = k.slice(0, -1);
        out[sym] = { symbol: sym, ...analyse(k, { ...SDEF, ...s.strategy }), spark: k.slice(-48).map((x) => x.c), at: now };
      } catch (e) { if (e.status === 451) throw e; out[sym] = { symbol: sym, status: "error", label: "Couldn't load", reasons: [e.message], score: 0, at: now }; }
    }
    if (this.isBO("live")) {
      try { this.boPairs = await this.bo.listPairs(); } catch { /* keep the last known list */ }
      for (const r of Object.values(out)) r.onBO = this.onBO(r.symbol);
    }
    this.scan = out; this.scanAt = now;
  }
  onBO(sym) { return this.boPairs && this.boPairs.size ? this.boPairs.has(toPair(sym)) : null; }
  unrealized(a) { return this.books[a].positions.reduce((x, p) => { const px = this.pxOf(p) ?? p.entry; return x + (p.qty * px * (1 - this.feeOf(p)) - p.cost); }, 0); }
  checkLimits(a) {
    const b = this.books[a], s = this.settings, bud = this.acct(a).budget;
    if (!b.halt && b.day.pnl <= -bud * s.dailyLossPct / 100) { b.halt = { type: "daily", at: Date.now(), reason: `Daily loss limit reached (${round(b.day.pnl)} ${this.ccy(a)}). No new trades until tomorrow.` }; this.saveBook(a); this.log("alert", b.halt.reason, a); }
    const total = b.realized + this.unrealized(a);
    if ((!b.halt || b.halt.type !== "maxloss") && total <= -bud * s.maxLossPct / 100) {
      b.halt = { type: "maxloss", at: Date.now(), reason: `Max loss limit reached (${round(total)} ${this.ccy(a)}). Bot stopped.` }; this.saveBook(a);
      if (this.acct(a).running) { this.acct(a).running = false; this.saveSettings(); }
      this.log("alert", b.halt.reason + " Open trades keep their stop-loss.", a);
    }
  }
  capital(a) { const bud = this.acct(a).budget; return Math.min(bud, bud + this.books[a].realized); }
  async lookForEntries(a) {
    const b = this.books[a], s = this.settings, now = Date.now();
    if (b.positions.length >= s.maxOpen) return;
    const bo = this.isBO(a);
    const cands = Object.values(this.scan).filter((x) => x.signal && now - x.at < 10 * 60e3 && !b.positions.some((p) => p.symbol === x.symbol) && b.lastBar[x.symbol] !== x.bar && !(b.cooldown[x.symbol] > now)).sort((x, y) => y.score - x.score);
    for (const sig of cands) {
      if (b.positions.length >= s.maxOpen) break;
      const avail = this.capital(a) - b.positions.reduce((x, p) => x + p.cost, 0), size = Math.min(this.acct(a).perTrade, avail);
      b.lastBar[sig.symbol] = sig.bar;
      if (bo && this.onBO(sig.symbol) === false) { this.log("info", `${toPair(sig.symbol)}: buy signal skipped, this coin isn't traded on BitOasis`, a); this.saveBook(a); continue; }
      if (size < this.minTrade(a)) { this.log("info", `${sig.symbol}: buy signal skipped, only ${round(avail)} ${this.ccy(a)} of budget left`, a); this.saveBook(a); continue; }
      try { await this.open(a, sig, size); } catch (e) { this.log("error", `${sig.symbol}: couldn't buy. ${e.message}`, a); }
      this.saveBook(a);
    }
  }
  async open(a, sig, size) {
    if (this.isBO(a)) return this.boOpen(a, sig, size);
    const s = this.settings, b = this.books[a], sym = sig.symbol, live = a === "live";
    const f = (await this.api.loadFilters([sym]))[sym];
    if (!f || f.status !== "TRADING") throw new Error("Not tradable right now");
    if (size < f.minNotional * 1.2) throw new Error(`Trade size ${size} USDT is below Binance's minimum (${f.minNotional} USDT)`);
    let entry, qty, cost;
    if (live) {
      const bal = await this.api.balance(f.quote);
      if (bal.free < size) throw new Error(`Not enough ${f.quote} in your Binance Spot wallet (${round(bal.free)} free, need ${size})`);
      const o = await this.api.marketBuyQuote(sym, size), fs = fillSummary(o, f.base);
      if (!fs.qty) throw new Error("Order wasn't filled");
      entry = fs.avg; cost = fs.quote + fs.feeQuote; qty = +floorToStep(fs.netQty, f.step);
    } else { const px = this.prices[sym] || sig.price; entry = px * (1 + SLIP); cost = size; qty = size * (1 - FEE) / entry; }
    const stopDist = Math.min(sig.stopDist, entry * s.strategy.maxStopPct / 100);
    const pos = { id: uid(), ex: live ? "binance" : "demo", symbol: sym, base: f.base, entry, qty, cost, stopDist, stop: entry - stopDist, tp: this.tpFor(sig, entry, stopDist), exit: sig.exit || "trail", peak: entry, openedAt: Date.now(), why: sig.reasons.join(". "), stopOrderId: null };
    b.positions.push(pos); this.saveBook(a);
    if (live) await this.placeStop(pos, f);
    this.log("trade", `BOUGHT ${sym}: ${round(cost)} USDT at ${fmtPx(entry)}. Stop-loss ${fmtPx(pos.stop)} (−${round(stopDist / entry * 100, 1)}%), ${pos.tp ? `target ${fmtPx(pos.tp)} (+${round((pos.tp / entry - 1) * 100, 1)}%)` : "no fixed target, trailing stop once in profit"}`, a);
  }
  async placeStop(pos, f) {
    if (pos.ex === "bitoasis") return this.boPlaceStop(pos);
    f = f || (await this.api.loadFilters([pos.symbol]))[pos.symbol];
    if (!f.stopOk) { this.log("info", `${pos.symbol}: exchange stop orders not supported; the bot watches the stop itself`, "live"); return; }
    const qty = floorToStep(pos.qty, f.step), stopPrice = roundToStep(pos.stop, f.tick), price = roundToStep(pos.stop * 0.995, f.tick);
    if (+qty * +price < f.minNotional) { this.log("info", `${pos.symbol}: position too small for an exchange stop; the bot watches the stop itself`, "live"); return; }
    try { const o = await this.api.stopLossLimit(pos.symbol, qty, stopPrice, price); pos.stopOrderId = o.orderId; this.saveBook("live"); }
    catch (e) { this.log("error", `${pos.symbol}: couldn't place the exchange stop-loss (${e.message}). The bot will watch the stop itself.`, "live"); }
  }
  async cancelStop(pos) {
    if (!pos.stopOrderId) return { filled: false };
    if (pos.ex === "bitoasis") return this.boCancelStop(pos);
    try { await this.api.cancelOrder(pos.symbol, pos.stopOrderId); pos.stopOrderId = null; return { filled: false }; }
    catch (e) {
      const o = await this.api.getOrder(pos.symbol, pos.stopOrderId).catch(() => null);
      if (o && (o.status === "FILLED" || o.status === "PARTIALLY_FILLED")) return { filled: true, order: o };
      pos.stopOrderId = null; return { filled: false };
    }
  }
  fromStopOrder(pos, o) { if (pos.ex === "bitoasis") return this.boFromStop(pos, o); const q = +o.executedQty, qt = +o.cummulativeQuoteQty; return this.record("live", pos, qt / q, qt * (1 - FEE), "Stop-loss (on Binance)"); }
  // Only the "target" exit sells at a fixed take-profit; the default "trail" exit rides a trailing stop instead.
  usesTarget() { return ({ ...SDEF, ...this.settings.strategy }).exit === "target"; }
  // Trades remember their own exit style; older trades without one follow the current strategy.
  exitOf(p) { return p.exit || (this.usesTarget() ? "target" : "trail"); }
  // Take-profit for a new trade: the signal's own target (e.g. the Bollinger middle band) or reward:risk × stop.
  tpFor(sig, entry, stopDist) { if (sig.exit !== "target") return null; const d = sig.tpDist ? sig.tpDist / sig.price * entry : stopDist * this.settings.strategy.rr; return entry + d; }
  async managePos(a, pos) {
    const s = this.settings, live = a === "live", px = this.pxOf(pos);
    if (!px) return;
    if (live && pos.ex === "bitoasis" && pos.stopOrderId) {
      let st = ""; try { st = orderStatus(await this.bo.getOrder(pos.stopOrderId)); } catch {}
      if (st === "DONE" || st === "FILLED") return this.boFromStop(pos, null);
      if (st === "CANCELED" || st === "CANCELLED" || st === "REJECTED") { pos.stopOrderId = null; this.log("info", `${pos.pair}: exchange stop was ${st.toLowerCase()}; placing it again`, a); await this.boPlaceStop(pos); }
    } else if (live && pos.stopOrderId) {
      const o = await this.api.getOrder(pos.symbol, pos.stopOrderId).catch(() => null);
      if (o && o.status === "FILLED") return this.fromStopOrder(pos, o);
      if (o && ["CANCELED", "EXPIRED", "REJECTED"].includes(o.status)) { pos.stopOrderId = null; this.log("info", `${pos.symbol}: exchange stop was ${o.status.toLowerCase()}; placing it again`, a); await this.placeStop(pos); }
    }
    const before = pos.stop, m = manage(pos, { high: px, low: px, price: px }, { ...SDEF, ...s.strategy });
    if (m.exit) return this.close(a, pos, m.reason);
    if (pos.stop !== before) {
      this.log("info", `${pos.symbol}: price is up, ${m.moved.includes("trail") ? "trailing stop raised" : "stop-loss moved to breakeven"} (${fmtPx(pos.stop)})`, a);
      if (live) { const c = await this.cancelStop(pos); if (c.filled) return this.fromStopOrder(pos, c.order); await this.placeStop(pos); }
    }
    this.saveBook(a);
  }
  async close(a, pos, reason) {
    if (pos.ex === "bitoasis") return this.boClose(a, pos, reason);
    if (a !== "live") { const px = (this.prices[pos.symbol] || pos.entry) * (1 - SLIP); return this.record(a, pos, px, pos.qty * px * (1 - FEE), reason); }
    const c = await this.cancelStop(pos); if (c.filled) return this.fromStopOrder(pos, c.order);
    const f = (await this.api.loadFilters([pos.symbol]))[pos.symbol];
    const bal = await this.api.balance(pos.base), px = this.prices[pos.symbol] || pos.entry;
    const qty = +floorToStep(Math.min(pos.qty, bal.free), f.mStep);
    if (!qty || qty * px < f.minNotional || qty < f.mMinQty) {
      this.log("alert", `${pos.symbol}: can't sell, amount (${qty}) is below Binance's minimum. Removed from the bot; sell it in the Binance app if needed.`, a);
      return this.record(a, pos, px, qty * px, reason + " (not sold: too small)");
    }
    const o = await this.api.marketSell(pos.symbol, floorToStep(qty, f.mStep)), fs = fillSummary(o, pos.base);
    return this.record(a, pos, fs.avg, fs.quote - fs.feeQuote, reason);
  }
  record(a, pos, exitPx, proceeds, reason) {
    const b = this.books[a], pnl = proceeds - pos.cost;
    b.positions = b.positions.filter((p) => p.id !== pos.id);
    const t = { id: pos.id, symbol: pos.symbol, entry: pos.entry, exit: exitPx, qty: pos.qty, cost: pos.cost, proceeds, pnl, pct: pnl / pos.cost * 100, openedAt: pos.openedAt, closedAt: Date.now(), reason };
    b.trades.unshift(t); if (b.trades.length > 1000) b.trades.length = 1000;
    b.realized += pnl; b.day.pnl += pnl; b.equity.push({ t: t.closedAt, v: round(b.realized, 4) }); if (b.equity.length > 1000) b.equity.shift();
    if (pnl < 0 && this.settings.cooldownHours) b.cooldown[pos.symbol] = Date.now() + this.settings.cooldownHours * 3600e3;
    this.saveBook(a);
    this.log("trade", `SOLD ${pos.pair || pos.symbol} at ${fmtPx(exitPx)}: ${pnl >= 0 ? "+" : ""}${round(pnl)} ${this.ccy(a)} (${pnl >= 0 ? "+" : ""}${round(t.pct, 1)}%) · ${reason}`, a);
    return t;
  }
  async freshPx(p) {
    if (p.ex === "bitoasis") { this.boPx[p.symbol] = await this.bo.ticker(p.pair); return; }
    if (!this.prices[p.symbol]) this.prices[p.symbol] = await this.api.price(p.symbol);
  }
  closeOne(a, id) {
    return this.exclusive(async () => { const p = this.books[a].positions.find((x) => x.id === id); if (!p) throw new Error("Trade not found (maybe it was just sold)"); await this.freshPx(p); return this.close(a, p, "Sold by you"); });
  }
  sellAll(a) {
    this.stop(a, "Stop & sell all");
    return this.exclusive(async () => {
      const out = [];
      for (const p of [...this.books[a].positions]) { try { await this.freshPx(p); out.push(await this.close(a, p, "Sold by you (sell all)")); } catch (e) { this.log("error", `${p.pair || p.symbol}: couldn't sell. ${e.message}`, a); } }
      return out;
    });
  }

  // ---------- BitOasis (live, AED) ----------
  // BitOasis doesn't return fill details we can rely on, so fills are measured from the
  // wallet balance before and after each order. Orders are never retried automatically.
  async boOpen(a, sig, size) {
    const s = this.settings, b = this.books[a], sym = sig.symbol, pair = toPair(sym), coin = sym.replace(/USDT$/, "");
    const t = await this.bo.ticker(pair); this.boPx[sym] = t;
    const before = await this.bo.balances();
    if ((before.AED || 0) < size) throw new Error(`Not enough AED in your BitOasis wallet (${round(before.AED || 0)} free, need ${size})`);
    const o = await this.bo.order(pair, "buy", "market", size * (1 - BO_BUFFER) / t.ask);
    const st = o.id ? await this.bo.waitDone(o.id) : "";
    const after = await this.bo.balances();
    let qty = (after[coin] || 0) - (before[coin] || 0), cost = (before.AED || 0) - (after.AED || 0);
    if (!(qty > 0)) {
      if (st === "OPEN") { try { await this.bo.cancelOrder(o.id); } catch {} throw new Error(`BitOasis didn't fill the buy order (status ${st}); it was cancelled`); }
      qty = o.amount * (1 - BO_FEE); this.log("info", `${pair}: couldn't read the fill from your balance; using the order amount`, a);
    }
    if (!(cost > 0) || cost > size * 1.5) cost = o.amount * t.ask * (1 + BO_FEE);
    const entry = cost / qty, pct = Math.min(sig.stopDist / sig.price, s.strategy.maxStopPct / 100), stopDist = entry * pct;
    const pos = { id: uid(), ex: "bitoasis", symbol: sym, pair, base: coin, entry, qty, cost, stopDist, stop: entry - stopDist, tp: this.tpFor(sig, entry, stopDist), exit: sig.exit || "trail", peak: entry, openedAt: Date.now(), why: sig.reasons.join(". "), stopOrderId: null, buyOrderId: o.id || null };
    b.positions.push(pos); this.saveBook(a);
    await this.boPlaceStop(pos);
    this.log("trade", `BOUGHT ${pair}: ${round(cost)} AED at ${fmtPx(entry)}. Stop-loss ${fmtPx(pos.stop)} (−${round(pct * 100, 1)}%), ${pos.tp ? `target ${fmtPx(pos.tp)} (+${round((pos.tp / entry - 1) * 100, 1)}%)` : "no fixed target, trailing stop once in profit"}`, a);
  }
  async boPlaceStop(pos) {
    const d = pos.stop >= 1000 ? 0 : pos.stop >= 10 ? 2 : pos.stop >= 0.1 ? 4 : 6;
    try { const o = await this.bo.order(pos.pair, "sell", "stop", pos.qty, { stop_price: pos.stop.toFixed(d) }); pos.stopOrderId = o.id || null; this.saveBook("live"); if (!o.id) throw new Error("no order id returned"); }
    catch (e) { this.log("error", `${pos.pair}: couldn't place the stop-loss on BitOasis (${e.message}). The bot will watch the stop itself.`, "live"); }
  }
  async boCancelStop(pos) {
    try { await this.bo.cancelOrder(pos.stopOrderId); pos.stopOrderId = null; return { filled: false }; }
    catch {
      let st = ""; try { st = orderStatus(await this.bo.getOrder(pos.stopOrderId)); } catch {}
      if (st === "DONE" || st === "FILLED") return { filled: true, order: null };
      pos.stopOrderId = null; return { filled: false };
    }
  }
  // The stop sold on BitOasis while we weren't looking: book it at the stop price, less fees.
  boFromStop(pos) { return this.record("live", pos, pos.stop, pos.qty * pos.stop * (1 - BO_FEE), "Stop-loss (on BitOasis)"); }
  async boClose(a, pos, reason) {
    const c = await this.boCancelStop(pos); if (c.filled) return this.boFromStop(pos);
    const t = this.boPx[pos.symbol] || await this.bo.ticker(pos.pair);
    const before = await this.bo.balances(), qty = Math.min(pos.qty, before[pos.base] || 0);
    if (!(qty > 0) || qty * t.bid < 10) {
      this.log("alert", `${pos.pair}: can't sell, only ${qty} ${pos.base} left in your BitOasis wallet. Removed from the bot; check the BitOasis app.`, a);
      return this.record(a, pos, t.bid, qty * t.bid, reason + " (not sold: too small)");
    }
    let o;
    try { o = await this.bo.order(pos.pair, "sell", "market", qty); }
    catch (e) { if (pos.ex === "bitoasis" && !pos.stopOrderId) await this.boPlaceStop(pos); throw e; }
    if (o.id) await this.bo.waitDone(o.id);
    const after = await this.bo.balances();
    let proceeds = (after.AED || 0) - (before.AED || 0);
    if (!(proceeds > 0) || proceeds > o.amount * t.bid * 1.5) proceeds = o.amount * t.bid * (1 - BO_FEE);
    return this.record(a, pos, proceeds / o.amount / (1 - BO_FEE), proceeds, reason);
  }

  // ---------- reporting ----------
  status(a) {
    const b = this.books[a], ac = this.acct(a), tr = b.trades, wins = tr.filter((t) => t.pnl > 0).length;
    // a trade with a trailing exit never sells at a target, even if an older one was saved with it
    const positions = b.positions.map((p) => { const px = this.pxOf(p) ?? p.entry, val = p.qty * px * (1 - this.feeOf(p)); return { ...p, tp: this.exitOf(p) === "target" ? p.tp : null, price: px, value: val, pnl: val - p.cost, pct: (val / p.cost - 1) * 100 }; });
    const committed = b.positions.reduce((x, p) => x + p.cost, 0);
    return {
      acct: a, running: ac.running, halt: b.halt, hasKeys: this.hasKeys(a), exchange: a === "live" ? this.settings.liveExchange : "demo", exName: this.exName(a), ccy: this.ccy(a), minTrade: this.minTrade(a), tg: !!(this.secrets.tgToken && this.secrets.tgChat), aed: AED,
      budget: ac.budget, perTrade: ac.perTrade, committed, available: Math.max(0, this.capital(a) - committed),
      realized: b.realized, unrealized: positions.reduce((x, p) => x + p.pnl, 0), today: b.day.pnl, trades: tr.length, wins, winRate: tr.length ? wins / tr.length * 100 : 0,
      positions, equity: b.equity.slice(-200), lastError: this.lastError, scanAt: this.scanAt,
      limits: { dailyLossPct: this.settings.dailyLossPct, maxLossPct: this.settings.maxLossPct, maxOpen: this.settings.maxOpen }, strategy: this.strategyInfo(),
      other: Object.fromEntries(ACCTS.map((x) => [x, { running: this.acct(x).running, open: this.books[x].positions.length, total: this.books[x].realized + this.unrealized(x), halt: !!this.books[x].halt }])),
    };
  }
  strategyInfo() { const st = this.settings.strategy, pr = presetOf(st.preset); return { id: pr ? pr.id : "custom", name: pr ? pr.name : "Custom", desc: pr ? pr.desc : "", interval: st.interval }; }
  // Strategy Lab: backtest every preset on the watched coins (same fees, slippage and trade size) and rank them.
  // Candles are fetched once per coin and timeframe; the work yields between coins so trading never stalls.
  compare(force = false, perTrade = 100, budget = 1000) {
    if (!force && this.cmp && Date.now() - this.cmpAt < 30 * 60e3) return this.cmp;
    if (this.cmpBusy) return this.cmpBusy;
    this.cmpBusy = (async () => {
      try {
        const s = this.settings, cache = {}, rows = [], yieldNow = () => new Promise((r) => setImmediate(r));
        const candles = async (sym, iv) => {
          const key = sym + iv; if (cache[key]) return cache[key];
          let all = [], end;
          for (let i = 0; i < 3; i++) { const k = await this.api.klines(sym, iv, 1000, end); if (!k.length) break; all = k.concat(all); end = k[0].t - 1; if (k.length < 1000) break; }
          if (all.length && all[all.length - 1].ct > Date.now()) all.pop();
          return (cache[key] = all);
        };
        for (const pr of PRESETS) {
          const P = { ...SDEF, maxStopPct: s.strategy.maxStopPct, rr: s.strategy.rr, ...pr.p }, per = [];
          for (const sym of s.watch) {
            try { per.push(backtestSymbol(await candles(sym, pr.p.interval), P, { tradeSize: perTrade, fee: FEE, slip: SLIP })); }
            catch (e) { if (e.status === 451) throw e; }
            await yieldNow();
          }
          const list = per.flatMap((r) => r.list).sort((x, y) => x.exitT - y.exitT), pnl = per.reduce((x, r) => x + r.pnl, 0);
          const gross = list.filter((t) => t.pnl > 0).reduce((x, t) => x + t.pnl, 0), loss = -list.filter((t) => t.pnl <= 0).reduce((x, t) => x + t.pnl, 0);
          let eq = 0; const curve = list.map((t) => (eq += t.pnl)), step = Math.max(1, Math.ceil(curve.length / 40));
          const from = Math.min(...per.map((r) => r.from || Infinity)), to = Math.max(...per.map((r) => r.to || 0)), dd = combinedDD(per.map((r) => r.list));
          rows.push({ id: pr.id, name: pr.name, desc: pr.desc, src: pr.src, interval: pr.p.interval, pnl: round(pnl), pnlPct: round(pnl / budget * 100, 1),
            trades: list.length, winRate: list.length ? round(list.filter((t) => t.pnl > 0).length / list.length * 100, 0) : 0,
            profitFactor: loss ? round(gross / loss) : null, maxDD: round(dd), maxDDPct: round(dd / budget * 100, 1),
            holdPct: per.length ? round(per.reduce((x, r) => x + r.holdPct, 0) / per.length, 1) : 0,
            days: isFinite(from) && to ? Math.round((to - from) / 864e5) : 0, curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1).map((v) => round(v)),
            current: pr.id === s.strategy.preset });
        }
        rows.sort((x, y) => y.pnl - x.pnl);
        this.cmp = { at: Date.now(), perTrade, budget, coins: s.watch.map((x) => x.replace(/USDT$/, "")), rows }; this.cmpAt = Date.now();
        return this.cmp;
      } finally { this.cmpBusy = null; }
    })();
    return this.cmpBusy;
  }
  publicSettings() {
    const s = this.settings, mask = (k) => (k ? k.slice(0, 4) + "…" + k.slice(-4) : "");
    return { ...s, liveCcy: this.ccy("live"), strategyInfo: this.strategyInfo(), presets: PRESETS.map(({ id, name, desc, src, p }) => ({ id, name, desc, src, interval: p.interval })), keys: { key: mask(this.secrets.key), secret: !!this.secrets.secret }, bitoasis: { token: mask(this.secrets.boToken) }, telegram: { token: !!this.secrets.tgToken, chat: this.secrets.tgChat } };
  }
  async backtest(force = false, perTrade = 100, budget = 1000) {
    if (!force && this.bt && Date.now() - this.btAt < 30 * 60e3) return this.bt;
    const s = this.settings, res = [];
    for (const sym of s.watch) {
      try {
        let all = [], end;
        for (let i = 0; i < 3; i++) { const k = await this.api.klines(sym, s.strategy.interval, 1000, end); if (!k.length) break; all = k.concat(all); end = k[0].t - 1; if (k.length < 1000) break; }
        if (all.length && all[all.length - 1].ct > Date.now()) all.pop();
        res.push({ symbol: sym, candles: all.length, ...backtestSymbol(all, { ...SDEF, ...s.strategy }, { tradeSize: perTrade, fee: FEE, slip: SLIP }) });
      } catch (e) { if (e.status === 451) throw e; res.push({ symbol: sym, error: e.message }); }
    }
    const ok = res.filter((r) => !r.error), tot = ok.reduce((x, r) => ({ trades: x.trades + r.trades, wins: x.wins + r.wins, pnl: x.pnl + r.pnl }), { trades: 0, wins: 0, pnl: 0 });
    this.bt = { at: Date.now(), interval: s.strategy.interval, perTrade, symbols: res.map(({ list, ...r }) => r), total: { ...tot, winRate: tot.trades ? tot.wins / tot.trades * 100 : 0, pnlPctOfBudget: tot.pnl / budget * 100 }, from: Math.min(...ok.map((r) => r.from || Infinity)), to: Math.max(...ok.map((r) => r.to || 0)) };
    this.btAt = Date.now(); return this.bt;
  }
}
