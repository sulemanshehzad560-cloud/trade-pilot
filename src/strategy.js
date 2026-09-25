// Two entry styles, both only in a clear uptrend:
//   pullback – buys after a short dip, when the price turns back up
//   breakout – buys when the price closes above the highest high of the last N candles
// Two exit styles:
//   trail  – no fixed target; once a trade is up 1× the risk, a trailing stop follows the price up (lets winners run)
//   target – fixed take-profit at reward:risk × the stop distance (the original behaviour)
// The same rules are used live and in the backtest, so backtest numbers reflect what the bot actually does.
import { ema, rsi, atr, sma } from "./indicators.js";

export const DEFAULTS = {
  interval: "1h", entry: "pullback", exit: "trail",
  rsiDip: 42, rsiTrigger: 45, breakoutN: 20,
  atrStop: 2, minStopPct: 1.5, maxStopPct: 6,
  rr: 2, trailR: 2, breakevenR: 1.5, beLock: 0.004, maxHoldHours: 72,
};
export const MIN_CANDLES = 230;

// Strategies the app can compare side by side (Backtest › Compare strategies).
export const PRESETS = [
  { id: "orig-1h", name: "Original", desc: "Pullback entry · fixed target · 1h", p: { interval: "1h", entry: "pullback", exit: "target", rr: 2, breakevenR: 1, beLock: 0.0025, maxHoldHours: 72 } },
  { id: "pb-trail-1h", name: "Pullback + trailing", desc: "Pullback entry · trailing stop · 1h", p: { interval: "1h", entry: "pullback", exit: "trail", trailR: 2, breakevenR: 1.5, maxHoldHours: 72 } },
  { id: "pb-trail-4h", name: "Pullback + trailing", desc: "Pullback entry · trailing stop · 4h", p: { interval: "4h", entry: "pullback", exit: "trail", trailR: 2, breakevenR: 1.5, maxHoldHours: 240 } },
  { id: "bo-trail-1h", name: "Breakout + trailing", desc: "Breakout entry · wide trailing stop · 1h", p: { interval: "1h", entry: "breakout", exit: "trail", trailR: 3, breakevenR: 2, maxHoldHours: 0 } },
  { id: "bo-trail-4h", name: "Breakout + trailing", desc: "Breakout entry · wide trailing stop · 4h", p: { interval: "4h", entry: "breakout", exit: "trail", trailR: 3, breakevenR: 2, maxHoldHours: 0 } },
  { id: "pb-target-4h", name: "Pullback + big target", desc: "Pullback entry · 3× target · 4h", p: { interval: "4h", entry: "pullback", exit: "target", rr: 3, breakevenR: 1.5, maxHoldHours: 240 } },
];

export function analyse(candles, p = DEFAULTS) {
  const P = { ...DEFAULTS, ...p };
  if (!candles || candles.length < MIN_CANDLES) return { status: "nodata", label: "Not enough data", score: 0, signal: false, reasons: ["Needs more price history"] };
  const c = candles.map((x) => x.c), n = c.length - 1;
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200), r = rsi(c, 14), a = atr(candles, 14), v20 = sma(candles.map((x) => x.v), 20);
  const price = c[n], R = r[n], A = a[n], green = candles[n].c > candles[n].o;
  const up = price > e200[n] && e50[n] > e200[n] && e200[n] > e200[n - 10];
  const down = price < e200[n] && e50[n] < e200[n];
  const volOk = candles[n].v >= 0.8 * v20[n];
  // pullback
  const dipLow = Math.min(...r.slice(n - 5, n).filter((x) => x != null));
  const dipped = dipLow < P.rsiDip;
  const turning = R > P.rsiTrigger && R > r[n - 1] && price > e20[n] && green;
  // breakout
  const N = Math.max(5, Math.round(P.breakoutN));
  const hh = Math.max(...candles.slice(n - N, n).map((x) => x.h));
  const broke = price > hh && green && R < 80;
  const signal = P.entry === "breakout" ? up && broke && volOk : up && dipped && turning && volOk;

  const trendPct = (e50[n] / e200[n] - 1) * 100;
  const mom = (price / c[Math.max(0, n - 24)] - 1) * 100;
  let score = 50 + Math.max(-25, Math.min(25, trendPct * 5)) + Math.max(-15, Math.min(15, mom * 2)) + (signal ? 15 : 0);
  score = Math.round(Math.max(0, Math.min(100, score)));
  const stopDist = Math.min(Math.max(P.atrStop * A, price * P.minStopPct / 100), price * P.maxStopPct / 100);
  const reasons = [];
  reasons.push(up ? "Uptrend: price is above the 200-candle average and it's rising" : down ? "Downtrend: price is below the 200-candle average" : "No clear trend");
  if (P.entry === "breakout") reasons.push(broke ? `Broke above the ${N}-candle high (${hh.toPrecision(6)})` : `Waiting to break the ${N}-candle high (${hh.toPrecision(6)})`);
  else reasons.push(`RSI ${R.toFixed(0)}${dipped ? `, dipped to ${dipLow.toFixed(0)} recently` : ""}${turning ? " and turning up" : ""}`);
  if (up && (P.entry === "breakout" ? broke : dipped && turning) && !volOk) reasons.push("Volume too low to trust the move");
  let status = "neutral", label = "No clear trend";
  if (signal) { status = "buy"; label = "Buy signal"; }
  else if (up) { status = "watch"; label = P.entry === "breakout" ? "Uptrend – waiting for a breakout" : dipped ? "Uptrend – dip, waiting for turn" : "Uptrend – waiting for a dip"; }
  else if (down) { status = "avoid"; label = "Downtrend – avoid"; }
  return {
    status, label, signal, score, reasons, price, rsi: R, atr: A, trendPct, mom24: mom,
    stopDist, tpDist: P.exit === "target" ? stopDist * P.rr : null, stopPct: stopDist / price * 100, bar: candles[n].t,
  };
}

// Decide what to do with an open position given the latest price range.
// pos: {entry, stop, tp, stopDist, peak, openedAt}. Returns {exit:false, moved} or {exit:true, price, reason}. Mutates pos.stop / pos.peak.
export function manage(pos, { high, low, price, now = Date.now() }, p = DEFAULTS) {
  const P = { ...DEFAULTS, ...p };
  const hi = high ?? price, lo = low ?? price;
  if (lo <= pos.stop) return { exit: true, price: pos.stop, reason: pos.trailed ? "Trailing stop" : pos.stop >= pos.entry ? "Breakeven stop" : "Stop-loss" };
  if (P.exit === "target" && pos.tp && hi >= pos.tp) return { exit: true, price: pos.tp, reason: "Take-profit" };
  pos.peak = Math.max(pos.peak || pos.entry, hi);
  const moved = [], R = pos.stopDist;
  // Breakeven: lock in enough to cover both fees + slippage, so a "breakeven" exit isn't a small loss.
  if (P.breakevenR && pos.peak >= pos.entry + P.breakevenR * R) { const be = pos.entry * (1 + P.beLock); if (be > pos.stop) { pos.stop = be; moved.push("breakeven"); } }
  // Trailing stop: after +1R, follow the highest price at trailR × risk. Moves in steps of ¼R to avoid constant order changes.
  if (P.exit === "trail" && pos.peak >= pos.entry + R) {
    const t = pos.peak - P.trailR * R;
    if (t > pos.stop + 0.25 * R) { pos.stop = t; pos.trailed = true; moved.push("trail"); }
  }
  // Time exit only for trades that never got going.
  if (P.maxHoldHours && now - pos.openedAt > P.maxHoldHours * 3600e3 && pos.peak < pos.entry + R && price < pos.entry * 1.005) return { exit: true, price, reason: `No progress after ${P.maxHoldHours}h` };
  return { exit: false, moved };
}
