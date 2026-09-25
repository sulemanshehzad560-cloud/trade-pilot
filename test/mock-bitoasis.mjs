// A strict fake BitOasis for testing: Bearer token, ?test=true validation, amount decimals,
// wallet balances in AED, market orders, stop orders that trigger when the price falls, cancel.
// AED prices follow the fake Binance prices × 3.6725 (bid 0.1% below, ask 0.1% above).
import http from "node:http";
import { state as bn } from "./mock-binance.mjs";

const TOKEN = "botoken", FEE = 0.005;
const PAIRS = { "SOL-AED": { sym: "SOLUSDT", dec: 3 }, "ETH-AED": { sym: "ETHUSDT", dec: 4 } };   // no BTC on purpose
export const state = { bal: { AED: 1000 }, locked: {}, orders: [], nextId: 1, errors: [], tests: 0 };
const px = (pair) => { const m = bn.price[PAIRS[pair].sym] * 3.6725; return { bid: m * 0.999, ask: m * 1.001, last: m }; };
const decs = (s) => (String(s).split(".")[1] || "").length;

function triggerStops() {
  for (const o of state.orders) if (o.type === "stop" && o.status === "OPEN" && px(o.pair).bid <= +o.stop_price) {
    const coin = o.pair.split("-")[0], b = px(o.pair).bid;
    state.locked[coin] -= +o.amount; state.bal.AED += +o.amount * b * (1 - FEE); o.status = "DONE"; o.avg = b;
  }
}
const send = (res, code, d) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(d)); };

export function start(port) {
  const srv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const u = new URL(req.url, "http://x"), p = u.pathname.replace(/^\/v1/, "");
      triggerStops();
      let m;
      if (req.method === "GET" && p === "/exchange/markets") return send(res, 200, { markets: Object.keys(PAIRS).map((pair) => ({ pair, status: "active" })) });
      if (req.method === "GET" && (m = /^\/exchange\/ticker\/(.+)$/.exec(p))) {
        if (!PAIRS[m[1]]) return send(res, 404, { message: "Pair not found" });
        const t = px(m[1]); return send(res, 200, { ticker: { pair: m[1], bid: t.bid.toFixed(2), ask: t.ask.toFixed(2), last_price: t.last.toFixed(2) } });
      }
      if (req.headers.authorization !== "Bearer " + TOKEN) return send(res, 401, { message: "Unauthorized" });
      if (req.method === "GET" && p === "/exchange/balances")
        return send(res, 200, { balances: Object.fromEntries(Object.entries(state.bal).map(([c, v]) => [c, { available: v.toFixed(8), total: (v + (state.locked[c] || 0)).toFixed(8) }])) });
      if (req.method === "GET" && (m = /^\/exchange\/order\/(\d+)$/.exec(p))) {
        const o = state.orders.find((x) => x.id === +m[1]); return o ? send(res, 200, { order: o }) : send(res, 404, { message: "Order not found" });
      }
      let q = {}; try { q = JSON.parse(body || "{}"); } catch {}
      if (req.method === "POST" && p === "/exchange/cancel-order") {
        const o = state.orders.find((x) => x.id === q.id);
        if (!o || o.status !== "OPEN") return send(res, 400, { message: "Order can't be cancelled" });
        o.status = "CANCELED"; const coin = o.pair.split("-")[0]; state.locked[coin] -= +o.amount; state.bal[coin] += +o.amount; return send(res, 200, { order: o });
      }
      if (req.method === "POST" && p === "/exchange/order") {
        const test = u.searchParams.get("test") === "true", P = PAIRS[q.pair], coin = String(q.pair || "").split("-")[0];
        const bad = (msg) => { if (!test) state.errors.push(msg); return send(res, 400, { message: msg }); };
        if (!P) return bad("Unknown pair");
        if (typeof q.amount !== "string" || !(+q.amount > 0)) return bad("amount must be a positive string");
        if (decs(q.amount) > P.dec) return bad("Invalid amount precision");
        if (!["buy", "sell"].includes(q.side) || !["market", "stop"].includes(q.type)) return bad("bad side/type");
        const t = px(q.pair), amt = +q.amount;
        if (q.side === "buy" && amt * t.ask * (1 + FEE) > state.bal.AED + 1e-9) return bad("Insufficient AED balance");
        if (q.side === "sell" && amt > (state.bal[coin] || 0) + 1e-12) return bad("Insufficient balance");
        if (q.type === "stop" && (!q.stop_price || decs(q.stop_price) > 2 || +q.stop_price >= t.bid)) return bad("Invalid stop_price");
        if (amt * t.last < 10) return bad("Order value below minimum");
        if (test) { state.tests++; return send(res, 200, { order: { pair: q.pair, side: q.side, type: q.type, amount: q.amount, status: "TEST" } }); }
        const o = { id: state.nextId++, pair: q.pair, side: q.side, type: q.type, amount: q.amount, stop_price: q.stop_price, status: "OPEN" };
        state.orders.push(o);
        if (q.type === "market") {
          if (q.side === "buy") { state.bal.AED -= amt * t.ask * (1 + FEE); state.bal[coin] = (state.bal[coin] || 0) + amt; o.avg = t.ask; }
          else { state.bal[coin] -= amt; state.bal.AED += amt * t.bid * (1 - FEE); o.avg = t.bid; }
          o.status = "DONE";
        } else { state.bal[coin] -= amt; state.locked[coin] = (state.locked[coin] || 0) + amt; }
        return send(res, 200, { order: { id: o.id, pair: o.pair, side: o.side, type: o.type, amount: o.amount, status: o.status } });
      }
      send(res, 404, { message: "Not found" });
    });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
