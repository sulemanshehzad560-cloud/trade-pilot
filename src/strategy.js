// Entry styles (all long-only; each is a well-known approach used by popular bots and open-source strategies):
//   pullback   – in an uptrend, buys after a short RSI dip when the price turns back up
//   breakout   – in an uptrend, buys a close above the highest high of the last N candles (Donchian / "turtle")
//   supertrend – buys when the Supertrend line flips from above the price to below it, above the 200 average
//   meanrev    – buys an oversold dip below the lower Bollinger band that closes back inside it; sells at the middle band
//   macd       – buys when MACD crosses above its signal line, with the price above the 200 average
//   adaptive   – reads trend strength (ADX): trending → pullback or breakout with a trailing stop,
//                sideways → Bollinger bounce with a fixed target
// Exit styles:
//   trail  – no fixed target; once a trade is up 1× the risk, a trailing stop follows the price up (lets winners run)
//   target – fixed take-profit (reward:risk × the stop distance, or the middle band for a Bollinger bounce)
// Each signal says which exit its trade uses, so one strategy can mix both (adaptive).
// The same rules are used live and in the backtest, so backtest numbers reflect what the bot actually does.
import { ema, rsi, atr, sma, bollinger, macd, supertrend, adx } from "./indicators.js";

export const DEFAULTS = {
  interval: "1h", entry: "pullback", exit: "trail",
  rsiDip: 42, rsiTrigger: 45, breakoutN: 20,
  atrStop: 2, minStopPct: 1.5, maxStopPct: 6,
  rr: 2, trailR: 2, breakevenR: 1.5, beLock: 0.004, maxHoldHours: 72,
  bbPeriod: 20, bbMult: 2, stPeriod: 10, stMult: 3, adxTrend: 25, adxRange: 20,
};
export const ENTRIES = ["pullback", "breakout", "supertrend", "meanrev", "macd", "adaptive"];
export const MIN_CANDLES = 230;

// Strategies the app can compare side by side (Backtest › Compare strategies).
export const PRESETS = [
  { id: "pb-trail-1h", name: "Pullback + trailing", desc: "Buys a dip in an uptrend, lets winners run · 1h", src: "The bot's default", p: { interval: "1h", entry: "pullback", exit: "trail", trailR: 2, breakevenR: 1.5, maxHoldHours: 72 } },
  { id: "pb-trail-4h", name: "Pullback + trailing", desc: "Buys a dip in an uptrend, lets winners run · 4h", src: "The bot's default, slower", p: { interval: "4h", entry: "pullback", exit: "trail", trailR: 2, breakevenR: 1.5, maxHoldHours: 240 } },
  { id: "orig-1h", name: "Pullback + fixed target", desc: "Buys a dip in an uptrend, sells at 2× the risk · 1h", src: "Trade Pilot's original rules", p: { interval: "1h", entry: "pullback", exit: "target", rr: 2, breakevenR: 1, beLock: 0.0025, maxHoldHours: 72 } },
  { id: "bo-trail-4h", name: "Breakout (Donchian)", desc: "Buys a new 20-candle high, wide trailing stop · 4h", src: "Classic \"turtle\" trend following", p: { interval: "4h", entry: "breakout", exit: "trail", trailR: 3, breakevenR: 2, maxHoldHours: 0 } },
  { id: "st-4h", name: "Supertrend", desc: "Buys when Supertrend (ATR 10 × 3) turns up · 4h", src: "Popular TradingView / 3Commas signal", p: { interval: "4h", entry: "supertrend", exit: "trail", trailR: 3, breakevenR: 2, maxHoldHours: 0 } },
  { id: "st-1h", name: "Supertrend", desc: "Buys when Supertrend (ATR 10 × 3) turns up · 1h", src: "Popular TradingView / 3Commas signal", p: { interval: "1h", entry: "supertrend", exit: "trail", trailR: 2.5, breakevenR: 1.5, maxHoldHours: 120 } },
  { id: "bb-1h", name: "Bollinger bounce", desc: "Buys an oversold dip below the lower band, sells at the middle band · 1h", src: "Mean reversion, a common open-source bot strategy", p: { interval: "1h", entry: "meanrev", exit: "target", breakevenR: 0, maxHoldHours: 48 } },
  { id: "macd-4h", name: "MACD momentum", desc: "Buys a MACD cross above the 200 average, trailing stop · 4h", src: "Classic momentum signal", p: { interval: "4h", entry: "macd", exit: "trail", trailR: 2.5, breakevenR: 1.5, maxHoldHours: 0 } },
  { id: "adapt-1h", name: "Adaptive", desc: "Trending: dip or breakout, trailing stop. Sideways: Bollinger bounce · 1h", src: "Switches style with trend strength (ADX)", p: { interval: "1h", entry: "adaptive", exit: "trail", trailR: 2, breakevenR: 1.5, maxHoldHours: 72 } },
  { id: "adapt-4h", name: "Adaptive", desc: "Trending: dip or breakout, trailing stop. Sideways: Bollinger bounce · 4h", src: "Switches style with trend strength (ADX)", p: { interval: "4h", entry: "adaptive", exit: "trail", trailR: 2.5, breakevenR: 1.5, maxHoldHours: 240 } },
];
export const presetOf = (id) => PRESETS.find((x) => x.id === id) || null;

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
  const pullSig = up && dipped && turning && volOk;
  // breakout
  const N = Math.max(5, Math.round(P.breakoutN));
  const hh = Math.max(...candles.slice(n - N, n).map((x) => x.h));
  const broke = price > hh && green && R < 80;
  const breakSig = up && broke && volOk;
  // trend strength
  const ax = adx(candles, 14), ADX = ax.adx[n] ?? 0, trending = ADX >= P.adxTrend && ax.pdi[n] > ax.mdi[n], sideways = ADX < P.adxRange;
  const regime = ADX >= P.adxTrend ? "trend" : sideways ? "range" : "mixed";
  // Bollinger bounce: yesterday closed below the lower band, today closes back inside it, oversold, not in a downtrend
  const bb = P.entry === "meanrev" || P.entry === "adaptive" ? bollinger(c, P.bbPeriod, P.bbMult) : null, bbRoom = bb ? bb.mid[n] - price : 0;
  const meanSig = !!bb && !down && c[n - 1] < bb.lo[n - 1] && price > bb.lo[n] && green && Math.min(r[n - 1], R) < 35 && bbRoom > 0;
  // Supertrend flip up, above the long average
  const st = P.entry === "supertrend" ? supertrend(candles, P.stPeriod, P.stMult) : null, stSig = !!st && st.dir[n] === 1 && st.dir[n - 1] === -1 && price > e200[n] && volOk;
  // MACD cross up, above the long average, below overbought
  const md = P.entry === "macd" ? macd(c) : null, macdSig = !!md && md.line[n] > md.signal[n] && md.line[n - 1] <= md.signal[n - 1] && price > e200[n] && R < 75;
  let signal = false, exit = P.exit, style = "";
  if (P.entry === "breakout") { signal = breakSig; style = "breakout"; }
  else if (P.entry === "supertrend") { signal = stSig; style = "supertrend"; }
  else if (P.entry === "meanrev") { signal = meanSig; style = "bounce"; exit = "target"; }
  else if (P.entry === "macd") { signal = macdSig; style = "MACD"; }
  else if (P.entry === "adaptive") {
    if (trending && (pullSig || breakSig)) { signal = true; style = pullSig ? "trend dip" : "trend breakout"; exit = "trail"; }
    else if (sideways && meanSig) { signal = true; style = "range bounce"; exit = "target"; }
  } else { signal = pullSig; style = "pullback"; }

  const trendPct = (e50[n] / e200[n] - 1) * 100;
  const mom = (price / c[Math.max(0, n - 24)] - 1) * 100;
  let score = 50 + Math.max(-25, Math.min(25, trendPct * 5)) + Math.max(-15, Math.min(15, mom * 2)) + (signal ? 15 : 0);
  score = Math.round(Math.max(0, Math.min(100, score)));
  const stopDist = Math.min(Math.max(P.atrStop * A, price * P.minStopPct / 100), price * P.maxStopPct / 100);
  // a bounce only makes sense if the middle band is at least ~0.8× the risk away
  if (signal && exit === "target" && (P.entry === "meanrev" || style === "range bounce") && bbRoom < stopDist * 0.8) signal = false;
  const tpDist = exit !== "target" ? null : (P.entry === "meanrev" || style === "range bounce") ? bbRoom : stopDist * P.rr;
  const reasons = [];
  reasons.push(up ? "Uptrend: price is above the 200-candle average and it's rising" : down ? "Downtrend: price is below the 200-candle average" : "No clear trend");
  reasons.push(`Trend strength (ADX) ${ADX.toFixed(0)}: ${regime === "trend" ? "trending" : regime === "range" ? "sideways" : "in between"}`);
  if (P.entry === "breakout") reasons.push(broke ? `Broke above the ${N}-candle high (${hh.toPrecision(6)})` : `Waiting to break the ${N}-candle high (${hh.toPrecision(6)})`);
  else if (P.entry === "supertrend") reasons.push(st.dir[n] === 1 ? (stSig ? "Supertrend just turned up" : "Supertrend is up; waiting for a fresh flip") : "Supertrend is down");
  else if (P.entry === "meanrev") reasons.push(meanSig ? `Bounced back inside the lower Bollinger band; target the middle band (${bb.mid[n].toPrecision(6)})` : price < bb.lo[n] ? "Below the lower Bollinger band; waiting for a close back inside" : "Inside the Bollinger bands; waiting for an oversold dip");
  else if (P.entry === "macd") reasons.push(md.line[n] > md.signal[n] ? (macdSig ? "MACD just crossed above its signal line" : "MACD is above its signal line; waiting for a fresh cross") : "MACD is below its signal line");
  else if (P.entry === "adaptive") reasons.push(signal ? `Adaptive: ${style} setup` : trending ? "Adaptive: trending, waiting for a dip or breakout" : sideways ? "Adaptive: sideways, waiting for an oversold Bollinger bounce" : "Adaptive: trend strength unclear, standing aside");
  else reasons.push(`RSI ${R.toFixed(0)}${dipped ? `, dipped to ${dipLow.toFixed(0)} recently` : ""}${turning ? " and turning up" : ""}`);
  if (up && (P.entry === "breakout" ? broke : P.entry === "pullback" ? dipped && turning : false) && !volOk) reasons.push("Volume too low to trust the move");
  let status = "neutral", label = "No clear trend";
  if (signal) { status = "buy"; label = P.entry === "adaptive" ? `Buy signal · ${style}` : "Buy signal"; }
  else if (up) { status = "watch"; label = P.entry === "breakout" ? "Uptrend – waiting for a breakout" : P.entry === "pullback" ? (dipped ? "Uptrend – dip, waiting for turn" : "Uptrend – waiting for a dip") : "Uptrend – waiting for a setup"; }
  else if (down) { status = "avoid"; label = "Downtrend – avoid"; }
  else if (P.entry === "meanrev" || (P.entry === "adaptive" && sideways)) { status = "watch"; label = "Sideways – waiting for a dip"; }
  return {
    status, label, signal, score, reasons, price, rsi: R, atr: A, trendPct, mom24: mom, adx: ADX, regime, exit, style,
    stopDist, tpDist, stopPct: stopDist / price * 100, bar: candles[n].t,
  };
}

// Decide what to do with an open position given the latest price range.
// pos: {entry, stop, tp, stopDist, peak, openedAt}. Returns {exit:false, moved} or {exit:true, price, reason}. Mutates pos.stop / pos.peak.
export function manage(pos, { high, low, price, now = Date.now() }, p = DEFAULTS) {
  const P = { ...DEFAULTS, ...p };
  const hi = high ?? price, lo = low ?? price, ex = pos.exit || P.exit;
  if (lo <= pos.stop) return { exit: true, price: pos.stop, reason: pos.trailed ? "Trailing stop" : pos.stop >= pos.entry ? "Breakeven stop" : "Stop-loss" };
  if (ex === "target" && pos.tp && hi >= pos.tp) return { exit: true, price: pos.tp, reason: "Take-profit" };
  pos.peak = Math.max(pos.peak || pos.entry, hi);
  const moved = [], R = pos.stopDist;
  // Breakeven: lock in enough to cover both fees + slippage, so a "breakeven" exit isn't a small loss.
  if (P.breakevenR && pos.peak >= pos.entry + P.breakevenR * R) { const be = pos.entry * (1 + P.beLock); if (be > pos.stop) { pos.stop = be; moved.push("breakeven"); } }
  // Trailing stop: after +1R, follow the highest price at trailR × risk. Moves in steps of ¼R to avoid constant order changes.
  if (ex === "trail" && pos.peak >= pos.entry + R) {
    const t = pos.peak - P.trailR * R;
    if (t > pos.stop + 0.25 * R) { pos.stop = t; pos.trailed = true; moved.push("trail"); }
  }
  // Time exit only for trades that never got going.
  if (P.maxHoldHours && now - pos.openedAt > P.maxHoldHours * 3600e3 && pos.peak < pos.entry + R && price < pos.entry * 1.005) return { exit: true, price, reason: `No progress after ${P.maxHoldHours}h` };
  return { exit: false, moved };
}
