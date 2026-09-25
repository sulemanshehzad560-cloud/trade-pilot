// A strict fake Binance for testing: checks signatures, timestamps, tick/step sizes, minimum notional and balances,
// fills market orders, and triggers stop-loss orders when the price falls to them.
import http from "node:http";
import crypto from "node:crypto";
import { analyse } from "../src/strategy.js";

const KEY = "testkey", SECRET = "testsecret", H = 3600e3;
const F = {
  BTCUSDT: { tick: "0.01", step: "0.00001", minN: 5, p0: 60000 },
  ETHUSDT: { tick: "0.01", step: "0.0001", minN: 5, p0: 3000 },
  SOLUSDT: { tick: "0.01", step: "0.001", minN: 5, p0: 150 },
};
export const state = { series: {}, price: {}, bal: { USDT: 500 }, locked: {}, orders: [], nextId: 1000, calls: [], errors: [] };
const dec = (s) => (s.split(".")[1] || "").replace(/0+$/, "").length;
const isMult = (v, step) => { const n = +v / +step; return Math.abs(n - Math.round(n)) < 1e-6 && dec(String(v)) <= dec(step); };

// Build a series whose last closed candle is a buy signal (search a random uptrend for one).
function seeded(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
function build(sym, wantSignal, seed) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rnd = seeded(seed + attempt * 7919), c = []; let p = F[sym].p0 * 0.7;
    const now = Math.floor(Date.now() / H) * H, start = now - 700 * H;
    for (let i = 0; i < 700; i++) {
      const drift = wantSignal ? 0.0009 : -0.0006, cyc = Math.sin(i / 9) * 0.004;
      const o = p, cl = o * (1 + drift + cyc + (rnd() - 0.5) * 0.01);
      c.push({ t: start + i * H, o, h: Math.max(o, cl) * (1 + rnd() * 0.003), l: Math.min(o, cl) * (1 - rnd() * 0.003), c: cl, v: 100 + rnd() * 50 }); p = cl;
    }
    if (!wantSignal) return c;
    for (let i = 699; i > 400; i--) if (analyse(c.slice(0, i + 1)).signal) {
      const cut = c.slice(0, i + 1), shift = now - H - cut[cut.length - 1].t; // last closed candle = previous hour
      return cut.map((k) => ({ ...k, t: k.t + shift }));
    }
  }
  throw new Error("no signal series");
}
export function reset() {
  state.series = { SOLUSDT: build("SOLUSDT", true, 11), ETHUSDT: build("ETHUSDT", true, 29), BTCUSDT: build("BTCUSDT", false, 5) };
  for (const s in state.series) { const k = state.series[s]; state.price[s] = k[k.length - 1].c; }
}
reset();

function orderCheck(q, f) {
  if (q.type === "MARKET") { if (q.quantity && !isMult(q.quantity, f.step)) return "Filter failure: LOT_SIZE"; if (q.quoteOrderQty && dec(q.quoteOrderQty) > 8) return "bad quoteOrderQty"; }
  if (q.type === "STOP_LOSS_LIMIT") {
    for (const k of ["timeInForce", "quantity", "price", "stopPrice"]) if (!q[k]) return `Mandatory parameter '${k}' was not sent`;
    if (!isMult(q.price, f.tick) || !isMult(q.stopPrice, f.tick)) return "Filter failure: PRICE_FILTER";
    if (!isMult(q.quantity, f.step)) return "Filter failure: LOT_SIZE";
    if (+q.quantity * +q.price < f.minN) return "Filter failure: NOTIONAL";
  }
  return null;
}
function fill(sym, side, qty, px) {
  const base = sym.replace("USDT", ""), fee = qty * 0.001;
  if (side === "BUY") { state.bal.USDT -= qty * px; state.bal[base] = (state.bal[base] || 0) + qty - fee; return { commission: fee.toFixed(8), commissionAsset: base }; }
  state.bal[base] -= qty; state.bal.USDT += qty * px * 0.999; return { commission: (qty * px * 0.001).toFixed(8), commissionAsset: "USDT" };
}
export function setPrice(sym, px) {
  state.price[sym] = px;
  for (const o of state.orders) if (o.symbol === sym && o.type === "STOP_LOSS_LIMIT" && o.status === "NEW" && px <= +o.stopPrice) {
    const base = sym.replace("USDT", ""); state.locked[base] -= +o.origQty; state.bal[base] += +o.origQty;
    fill(sym, "SELL", +o.origQty, +o.price); o.status = "FILLED"; o.executedQty = o.origQty; o.cummulativeQuoteQty = (+o.origQty * +o.price).toFixed(8);
  }
}
const send = (res, code, d) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(d)); };
export function start(port) {
  return new Promise((ok) => http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), q = Object.fromEntries(u.searchParams), P = u.pathname;
    state.calls.push(`${req.method} ${P}`);
    const err = (msg, code = -1013) => { state.errors.push(msg); send(res, 400, { code, msg }); };
    if (P === "/mock/price") { setPrice(q.symbol, +q.price); return send(res, 200, { ok: true }); }
    if (P === "/api/v3/time") return send(res, 200, { serverTime: Date.now() });
    if (P === "/api/v3/klines") {
      let k = state.series[q.symbol]; if (!k) return err("Invalid symbol.", -1121);
      const now = Math.floor(Date.now() / H) * H, last = k[k.length - 1];
      const live = { t: now, o: last.c, h: Math.max(last.c, state.price[q.symbol]), l: Math.min(last.c, state.price[q.symbol]), c: state.price[q.symbol], v: 10 };
      let rows = [...k, live]; if (q.endTime) rows = rows.filter((x) => x.t <= +q.endTime); rows = rows.slice(-(+q.limit || 500));
      return send(res, 200, rows.map((x) => [x.t, String(x.o), String(x.h), String(x.l), String(x.c), String(x.v), x.t + H - 1, "0", 1, "0", "0", "0"]));
    }
    if (P === "/api/v3/ticker/price") {
      if (q.symbols) return send(res, 200, JSON.parse(q.symbols).map((s) => ({ symbol: s, price: String(state.price[s]) })));
      return send(res, 200, { symbol: q.symbol, price: String(state.price[q.symbol]) });
    }
    if (P === "/api/v3/exchangeInfo") {
      const syms = JSON.parse(q.symbols);
      return send(res, 200, { symbols: syms.map((s) => ({ symbol: s, status: "TRADING", baseAsset: s.replace("USDT", ""), quoteAsset: "USDT", orderTypes: ["LIMIT", "MARKET", "STOP_LOSS_LIMIT"],
        filters: [{ filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000", tickSize: F[s].tick }, { filterType: "LOT_SIZE", minQty: F[s].step, maxQty: "9000", stepSize: F[s].step }, { filterType: "MARKET_LOT_SIZE", minQty: "0.00000000", maxQty: "5000", stepSize: "0.00000000" }, { filterType: "NOTIONAL", minNotional: String(F[s].minN), applyMinToMarket: true, maxNotional: "9000000", applyMaxToMarket: false, avgPriceMins: 5 }] })) });
    }
    // ---- signed endpoints ----
    if (req.headers["x-mbx-apikey"] !== KEY) return send(res, 401, { code: -2015, msg: "Invalid API-key, IP, or permissions for action." });
    const raw = u.search.slice(1), i = raw.lastIndexOf("&signature="), payload = raw.slice(0, i), sig = raw.slice(i + 11);
    if (crypto.createHmac("sha256", SECRET).update(payload).digest("hex") !== sig) return err("Signature for this request is not valid.", -1022);
    if (Math.abs(Date.now() - +q.timestamp) > +(q.recvWindow || 5000)) return err("Timestamp for this request is outside of the recvWindow.", -1021);
    if (P === "/api/v3/account") return send(res, 200, { canTrade: true, balances: Object.keys(state.bal).map((a) => ({ asset: a, free: state.bal[a].toFixed(8), locked: (state.locked[a] || 0).toFixed(8) })) });
    if (P === "/sapi/v1/account/apiRestrictions") return send(res, 200, { ipRestrict: false, enableWithdrawals: false, enableSpotAndMarginTrading: true, enableReading: true });
    if (P === "/api/v3/order" && req.method === "POST") {
      const f = F[q.symbol], e = orderCheck(q, f); if (e) return err(e);
      const px = state.price[q.symbol], base = q.symbol.replace("USDT", ""), id = state.nextId++;
      if (q.type === "MARKET" && q.side === "BUY") {
        const spend = +q.quoteOrderQty; if (spend > state.bal.USDT) return err("Account has insufficient balance for requested action.", -2010);
        const qty = +(Math.floor(spend / px / +f.step) * +f.step).toFixed(dec(f.step)); const fe = fill(q.symbol, "BUY", qty, px);
        const o = { symbol: q.symbol, orderId: id, type: "MARKET", side: "BUY", status: "FILLED", executedQty: qty.toFixed(8), cummulativeQuoteQty: (qty * px).toFixed(8), fills: [{ price: String(px), qty: qty.toFixed(8), ...fe }] };
        state.orders.push(o); return send(res, 200, o);
      }
      if (q.type === "MARKET" && q.side === "SELL") {
        const qty = +q.quantity; if (qty > (state.bal[base] || 0) + 1e-9) return err("Account has insufficient balance for requested action.", -2010);
        const fe = fill(q.symbol, "SELL", qty, px); const o = { symbol: q.symbol, orderId: id, type: "MARKET", side: "SELL", status: "FILLED", executedQty: qty.toFixed(8), cummulativeQuoteQty: (qty * px).toFixed(8), fills: [{ price: String(px), qty: String(qty), ...fe }] };
        state.orders.push(o); return send(res, 200, o);
      }
      if (q.type === "STOP_LOSS_LIMIT") {
        const qty = +q.quantity; if (qty > (state.bal[base] || 0) + 1e-9) return err("Account has insufficient balance for requested action.", -2010);
        if (+q.stopPrice >= px) return err("Stop price would trigger immediately.", -2010);
        state.bal[base] -= qty; state.locked[base] = (state.locked[base] || 0) + qty;
        const o = { symbol: q.symbol, orderId: id, type: "STOP_LOSS_LIMIT", side: "SELL", status: "NEW", origQty: q.quantity, price: q.price, stopPrice: q.stopPrice, executedQty: "0", cummulativeQuoteQty: "0" };
        state.orders.push(o); return send(res, 200, o);
      }
      return err("Unsupported order");
    }
    if (P === "/api/v3/order") {
      const o = state.orders.find((x) => x.orderId === +q.orderId && x.symbol === q.symbol); if (!o) return err("Order does not exist.", -2013);
      if (req.method === "GET") return send(res, 200, o);
      if (req.method === "DELETE") {
        if (o.status !== "NEW") return err("Unknown order sent.", -2011);
        const base = q.symbol.replace("USDT", ""); state.locked[base] -= +o.origQty; state.bal[base] += +o.origQty; o.status = "CANCELED"; return send(res, 200, o);
      }
    }
    send(res, 404, { msg: "not mocked " + P });
  }).listen(port, "127.0.0.1", ok));
}
