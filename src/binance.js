// Binance Spot REST client: public data, signed trading, symbol filters and rounding.
import crypto from "node:crypto";

export class BinanceError extends Error {
  constructor(msg, { code = null, status = 0 } = {}) { super(msg); this.code = code; this.status = status; }
}

// ---- decimal helpers (Binance rejects quantities/prices that aren't exact multiples of the step) ----
const decimalsOf = (step) => { const s = String(step); if (!s.includes(".")) return 0; return s.replace(/0+$/, "").split(".")[1].length; };
export function floorToStep(value, step) {
  const st = Number(step); if (!st) return String(value);
  const d = decimalsOf(step); const n = Math.floor(Number(value) / st + 1e-9);
  return (n * st).toFixed(d);
}
export function roundToStep(value, step) {
  const st = Number(step); if (!st) return String(value);
  const d = decimalsOf(step); const n = Math.round(Number(value) / st);
  return (n * st).toFixed(d);
}

export class Binance {
  constructor({ key = "", secret = "", base = "https://api.binance.com", fetchImpl = globalThis.fetch } = {}) {
    this.key = key; this.secret = secret; this.base = base.replace(/\/$/, ""); this.fetch = fetchImpl;
    this.offset = 0; this.synced = 0; this.filters = {}; this.filtersAt = 0;
  }
  get hasKeys() { return !!(this.key && this.secret); }

  async _req(method, path, params = {}, signed = false, retry = true) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.append(k, String(v));
    const headers = {};
    if (signed) {
      if (!this.hasKeys) throw new BinanceError("Binance API key and secret are not set");
      if (Date.now() - this.synced > 30 * 60e3) await this.syncTime();
      q.append("timestamp", String(Date.now() + this.offset));
      q.append("recvWindow", "5000");
      q.append("signature", crypto.createHmac("sha256", this.secret).update(q.toString()).digest("hex"));
      headers["X-MBX-APIKEY"] = this.key;
    }
    const url = `${this.base}${path}${q.toString() ? "?" + q : ""}`;
    let r;
    try { r = await this.fetch(url, { method, headers, signal: AbortSignal.timeout(15000) }); }
    catch (e) { throw new BinanceError(`Can't reach Binance (${e.name === "TimeoutError" ? "timeout" : e.message})`); }
    const text = await r.text(); let d; try { d = JSON.parse(text); } catch { d = { msg: text.slice(0, 200) }; }
    if (r.status === 451 || r.status === 403 && /restricted location|eligibility/i.test(text))
      throw new BinanceError("Binance blocks this server's location. Run the bot on a server outside the US (e.g. Oracle Cloud Dubai).", { status: r.status });
    if (!r.ok) {
      if (d && d.code === -1021 && retry) { await this.syncTime(); return this._req(method, path, params, signed, false); }
      throw new BinanceError(`Binance: ${d && d.msg ? d.msg : "HTTP " + r.status}`, { code: d && d.code, status: r.status });
    }
    return d;
  }
  async syncTime() { const t0 = Date.now(); const d = await this._req("GET", "/api/v3/time"); this.offset = d.serverTime - Math.round((t0 + Date.now()) / 2); this.synced = Date.now(); }

  // ---- public ----
  async klines(symbol, interval, limit = 300, endTime) {
    const rows = await this._req("GET", "/api/v3/klines", { symbol, interval, limit, endTime });
    return rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: k[6] }));
  }
  async price(symbol) { return +(await this._req("GET", "/api/v3/ticker/price", { symbol })).price; }
  async prices(symbols) {
    if (!symbols.length) return {};
    const d = await this._req("GET", "/api/v3/ticker/price", { symbols: JSON.stringify(symbols) });
    return Object.fromEntries(d.map((x) => [x.symbol, +x.price]));
  }
  async loadFilters(symbols, force = false) {
    const missing = symbols.filter((s) => !this.filters[s]);
    if (!force && !missing.length && Date.now() - this.filtersAt < 3600e3) return this.filters;
    const d = await this._req("GET", "/api/v3/exchangeInfo", { symbols: JSON.stringify(symbols) });
    for (const s of d.symbols) {
      const f = Object.fromEntries(s.filters.map((x) => [x.filterType, x]));
      const lot = f.LOT_SIZE || {}, mlot = f.MARKET_LOT_SIZE || {}, notional = f.NOTIONAL || f.MIN_NOTIONAL || {};
      this.filters[s.symbol] = {
        symbol: s.symbol, status: s.status, base: s.baseAsset, quote: s.quoteAsset,
        tick: (f.PRICE_FILTER || {}).tickSize || "0.00000001",
        step: lot.stepSize || "0.00000001", minQty: +(lot.minQty || 0),
        mStep: +mlot.stepSize ? mlot.stepSize : lot.stepSize || "0.00000001", mMinQty: +(mlot.minQty || lot.minQty || 0), mMaxQty: +(mlot.maxQty || 0) || Infinity,
        minNotional: +(notional.minNotional || 5),
        stopOk: (s.orderTypes || []).includes("STOP_LOSS_LIMIT"),
      };
    }
    this.filtersAt = Date.now();
    return this.filters;
  }

  // ---- signed ----
  account() { return this._req("GET", "/api/v3/account", { omitZeroBalances: "true" }, true); }
  async balance(asset) { const a = await this.account(); const b = (a.balances || []).find((x) => x.asset === asset); return b ? { free: +b.free, locked: +b.locked } : { free: 0, locked: 0 }; }
  marketBuyQuote(symbol, quoteQty, tick = "0.01") {
    return this._req("POST", "/api/v3/order", { symbol, side: "BUY", type: "MARKET", quoteOrderQty: floorToStep(quoteQty, "0.01"), newOrderRespType: "FULL" }, true);
  }
  marketSell(symbol, quantity) { return this._req("POST", "/api/v3/order", { symbol, side: "SELL", type: "MARKET", quantity, newOrderRespType: "FULL" }, true); }
  stopLossLimit(symbol, quantity, stopPrice, price) {
    return this._req("POST", "/api/v3/order", { symbol, side: "SELL", type: "STOP_LOSS_LIMIT", timeInForce: "GTC", quantity, stopPrice, price, newOrderRespType: "RESULT" }, true);
  }
  getOrder(symbol, orderId) { return this._req("GET", "/api/v3/order", { symbol, orderId }, true); }
  cancelOrder(symbol, orderId) { return this._req("DELETE", "/api/v3/order", { symbol, orderId }, true); }
}

// Average fill price and net base quantity (after fees taken in the base asset) from a FULL order response.
export function fillSummary(order, baseAsset) {
  const qty = +order.executedQty || 0, quote = +order.cummulativeQuoteQty || 0;
  let feeBase = 0, feeQuote = 0, feeOther = 0;
  for (const f of order.fills || []) {
    if (f.commissionAsset === baseAsset) feeBase += +f.commission;
    else if (/USD/.test(f.commissionAsset)) feeQuote += +f.commission;
    else feeOther += +f.commission;
  }
  return { qty, quote, avg: qty ? quote / qty : 0, netQty: Math.max(0, qty - feeBase), feeBase, feeQuote, feeOther };
}
