// BitOasis (UAE) REST client for the Live account.
// Official API: https://api.bitoasis.net/v1  ·  Auth: "Authorization: Bearer <token>"
// BitOasis has no candle/chart endpoint, so signals still come from Binance's public prices;
// only the real orders (in AED) go to BitOasis.
//
// Rules this client follows because BitOasis has no idempotency key:
//   * an order POST is NEVER retried automatically
//   * every real order is first validated with ?test=true
export class BitOasisError extends Error {
  constructor(msg, { status = 0 } = {}) { super(msg); this.status = status; }
}

export const QUOTE = "AED";
export const toPair = (sym) => sym.replace(/USDT$/, "") + "-" + QUOTE;   // SOLUSDT -> SOL-AED
const n = (v) => { const x = Number(v); return isFinite(x) ? x : 0; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull a number out of whatever shape a balance entry has: "12.5", {available:"12.5", total:"13"}, ...
function amountOf(v) {
  if (v == null) return 0;
  if (typeof v !== "object") return n(v);
  for (const k of ["available", "free", "available_balance", "balance", "amount", "total"]) if (v[k] !== undefined) return amountOf(v[k]);
  return 0;
}
// Balances response -> { AED: 100, BTC: 0.01, ... } (accepts a map, a nested map or an array)
export function parseBalances(d) {
  let src = d && (d.balances ?? d.data ?? d.balance ?? d);
  const out = {};
  if (Array.isArray(src)) {
    for (const x of src) { const c = String(x.currency || x.asset || x.code || x.symbol || "").toUpperCase(); if (c) out[c] = amountOf(x); }
  } else if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src)) if (/^[A-Za-z0-9]{2,12}$/.test(k)) out[k.toUpperCase()] = amountOf(v);
  }
  return out;
}
// Find the first value of a key anywhere in a (small) JSON response.
function dig(o, keys, depth = 0) {
  if (!o || typeof o !== "object" || depth > 4) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && typeof o[k] !== "object") return o[k];
  for (const v of Object.values(o)) { const r = dig(v, keys, depth + 1); if (r !== undefined) return r; }
  return undefined;
}
export const orderId = (r) => dig(r, ["id", "order_id", "orderId"]);
export const orderStatus = (r) => String(dig(r, ["status", "state"]) || "").toUpperCase();

export class BitOasis {
  constructor({ token = "", base = "https://api.bitoasis.net/v1", fetchImpl = globalThis.fetch } = {}) {
    this.token = token; this.base = base.replace(/\/$/, ""); this.fetch = fetchImpl;
    this.markets = null; this.marketsAt = 0; this.dec = {};
  }
  get hasKeys() { return !!this.token; }

  async _req(method, path, { query, body, auth = false } = {}) {
    if (auth && !this.token) throw new BitOasisError("BitOasis API token is not set");
    const q = query ? "?" + new URLSearchParams(query) : "";
    const headers = { accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
    if (auth) headers.authorization = "Bearer " + this.token;
    let r;
    try { r = await this.fetch(this.base + path + q, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); }
    catch (e) { throw new BitOasisError(`Can't reach BitOasis (${e.name === "TimeoutError" ? "timeout" : e.message})`); }
    const text = await r.text(); let d; try { d = JSON.parse(text); } catch { d = { message: text.slice(0, 200) }; }
    if (!r.ok) {
      const why = (d && (d.message || d.error || d.detail || (d.errors && JSON.stringify(d.errors)))) || "";
      const msg = r.status === 401 ? "BitOasis refused the API token (wrong, expired or missing permission)"
        : r.status === 429 ? "BitOasis rate limit hit, will try again shortly"
        : r.status === 404 ? `BitOasis: not found${why ? " (" + why + ")" : ""}`
        : `BitOasis: ${typeof why === "string" && why ? why : "HTTP " + r.status}`;
      throw new BitOasisError(msg.slice(0, 300), { status: r.status });
    }
    return d;
  }

  // ---- public market data ----
  async listPairs() {
    if (this.markets && Date.now() - this.marketsAt < 3600e3) return this.markets;
    const d = await this._req("GET", "/exchange/markets");
    const found = new Set((JSON.stringify(d).match(/"[A-Z0-9]{2,10}-[A-Z]{3,4}"/g) || []).map((s) => s.slice(1, -1)));
    this.markets = found; this.marketsAt = Date.now(); return found;
  }
  async ticker(pair) {
    const d = await this._req("GET", `/exchange/ticker/${pair}`), t = d.ticker || d;
    const last = n(t.last_price ?? t.last), bid = n(t.bid) || last, ask = n(t.ask) || last;
    if (!bid || !ask) throw new BitOasisError(`BitOasis has no price for ${pair}`);
    return { pair, bid, ask, last: last || (bid + ask) / 2 };
  }
  // { SOLUSDT: {bid, ask, last} } for the Binance-style symbols given (missing pairs are skipped)
  async prices(symbols) {
    const out = {};
    for (const sym of symbols) { try { out[sym] = await this.ticker(toPair(sym)); } catch (e) { if (e.status === 401 || e.status === 429) throw e; } }
    return out;
  }

  // ---- private ----
  async balances() { return parseBalances(await this._req("GET", "/exchange/balances", { auth: true })); }
  async balance(cur) { return (await this.balances())[cur.toUpperCase()] || 0; }
  getOrder(id) { return this._req("GET", `/exchange/order/${id}`, { auth: true }); }
  cancelOrder(id) { return this._req("POST", "/exchange/cancel-order", { body: { id: Number(id) }, auth: true }); }

  // Places an order after checking it with ?test=true. The amount (always in the coin, not AED)
  // is rounded down; if BitOasis rejects the number of decimals we try fewer (test orders only).
  async order(pair, side, type, amount, extra = {}) {
    const tries = this.dec[pair] !== undefined ? [this.dec[pair]] : [8, 6, 5, 4, 3, 2, 1, 0];
    let lastErr;
    for (const d of tries) {
      const amt = floorDec(amount, d); if (!(+amt > 0)) break;
      const body = { pair, side, type, amount: amt, ...extra };
      try { await this._req("POST", "/exchange/order", { query: { test: "true" }, body, auth: true }); }
      catch (e) { lastErr = e; if (e.status === 400) continue; throw e; }
      this.dec[pair] = d;
      const r = await this._req("POST", "/exchange/order", { body, auth: true });   // real order, never retried
      return { id: orderId(r), amount: +amt, raw: r };
    }
    throw lastErr || new BitOasisError(`Amount too small for ${pair}`);
  }
  // Waits (up to ~12 s) for an order to leave OPEN; returns the last status seen.
  async waitDone(id, ms = 12000) {
    const t = Date.now(); let st = "";
    while (Date.now() - t < ms) { try { st = orderStatus(await this.getOrder(id)); } catch {} if (st && st !== "OPEN" && st !== "NEW" && st !== "PENDING") return st; await sleep(800); }
    return st || "UNKNOWN";
  }
}

export function floorDec(x, d) { const f = 10 ** d; return (Math.floor(Number(x) * f + 1e-9) / f).toFixed(d); }
