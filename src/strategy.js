// "Trend pullback" strategy: only buys coins in a clear uptrend, after a short dip, when the price turns back up.
// The same exit rules are used live and in the backtest, so backtest numbers reflect what the bot actually does.
import { ema, rsi, atr, sma } from "./indicators.js";

export const DEFAULTS = {
  interval: "1h", rsiDip: 42, rsiTrigger: 45, atrStop: 2, minStopPct: 1.5, maxStopPct: 6, rr: 2, breakevenR: 1, maxHoldHours: 72,
};
export const MIN_CANDLES = 230;

export function analyse(candles, p = DEFAULTS) {
  const P = { ...DEFAULTS, ...p };
  if (!candles || candles.length < MIN_CANDLES) return { status: "nodata", label: "Not enough data", score: 0, signal: false, reasons: ["Needs about 10 days of price history"] };
  const c = candles.map((x) => x.c), n = c.length - 1;
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200), r = rsi(c, 14), a = atr(candles, 14), v20 = sma(candles.map((x) => x.v), 20);
  const price = c[n], R = r[n], A = a[n];
  const up = price > e200[n] && e50[n] > e200[n] && e200[n] > e200[n - 10];
  const down = price < e200[n] && e50[n] < e200[n];
  const dipLow = Math.min(...r.slice(n - 5, n).filter((x) => x != null));
  const dipped = dipLow < P.rsiDip;
  const turning = R > P.rsiTrigger && R > r[n - 1] && price > e20[n] && candles[n].c > candles[n].o;
  const volOk = candles[n].v >= 0.8 * v20[n];
  const signal = up && dipped && turning && volOk;
  const trendPct = (e50[n] / e200[n] - 1) * 100;
  const mom = (price / c[n - 24] - 1) * 100;
  let score = 50 + Math.max(-25, Math.min(25, trendPct * 5)) + Math.max(-15, Math.min(15, mom * 2)) + (signal ? 15 : 0);
  score = Math.round(Math.max(0, Math.min(100, score)));
  const stopDist = Math.min(Math.max(P.atrStop * A, price * P.minStopPct / 100), price * P.maxStopPct / 100);
  const reasons = [];
  reasons.push(up ? "Uptrend: price is above the 200-candle average and it's rising" : down ? "Downtrend: price is below the 200-candle average" : "No clear trend");
  reasons.push(`RSI ${R.toFixed(0)}${dipped ? `, dipped to ${dipLow.toFixed(0)} recently` : ""}${turning ? " and turning up" : ""}`);
  if (up && dipped && turning && !volOk) reasons.push("Volume too low to trust the bounce");
  let status = "neutral", label = "No clear trend";
  if (signal) { status = "buy"; label = "Buy signal"; }
  else if (up) { status = "watch"; label = dipped ? "Uptrend – dip, waiting for turn" : "Uptrend – waiting for a dip"; }
  else if (down) { status = "avoid"; label = "Downtrend – avoid"; }
  return {
    status, label, signal, score, reasons, price, rsi: R, atr: A, trendPct, mom24: mom,
    stopDist, tpDist: stopDist * P.rr, stopPct: stopDist / price * 100, bar: candles[n].t,
  };
}

// Decide what to do with an open position given the latest price range.
// pos: {entry, stop, tp, stopDist, peak, openedAt}. Returns {exit:false} or {exit:true, price, reason}. Mutates pos.stop / pos.peak.
export function manage(pos, { high, low, price, now = Date.now() }, p = DEFAULTS) {
  const P = { ...DEFAULTS, ...p };
  pos.peak = Math.max(pos.peak || pos.entry, high ?? price);
  if ((low ?? price) <= pos.stop) return { exit: true, price: pos.stop, reason: pos.stop >= pos.entry ? "Breakeven stop" : "Stop-loss" };
  if ((high ?? price) >= pos.tp) return { exit: true, price: pos.tp, reason: "Take-profit" };
  const moved = [];
  if (pos.peak >= pos.entry + P.breakevenR * pos.stopDist) { const be = pos.entry * 1.0025; if (be > pos.stop) { pos.stop = be; moved.push("breakeven"); } }
  if (P.maxHoldHours && now - pos.openedAt > P.maxHoldHours * 3600e3 && price < pos.entry * 1.005) return { exit: true, price, reason: `No progress after ${P.maxHoldHours}h` };
  return { exit: false, moved };
}
