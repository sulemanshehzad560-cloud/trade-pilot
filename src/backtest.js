// Replays the strategy over past candles, with Binance fees and slippage, one position per coin.
import { analyse, manage, MIN_CANDLES } from "./strategy.js";

export function backtestSymbol(candles, p, { tradeSize = 100, fee = 0.001, slip = 0.0005 } = {}) {
  const trades = []; let pos = null, equity = 0, peakEq = 0, maxDD = 0;
  const hourMs = candles.length > 1 ? candles[1].t - candles[0].t : 3600e3;
  for (let i = MIN_CANDLES; i < candles.length - 1; i++) {
    const bar = candles[i];
    if (pos) {
      const m = manage(pos, { high: bar.h, low: bar.l, price: bar.c, now: bar.t + hourMs }, p);
      if (m.exit) {
        const exitPx = Math.min(m.price, bar.h) * (1 - slip);
        const gross = pos.qty * exitPx, pnl = gross * (1 - fee) - tradeSize;
        equity += pnl; trades.push({ entryT: pos.openedAt, exitT: bar.t, entry: pos.entry, exit: exitPx, pnl, pct: pnl / tradeSize * 100, reason: m.reason });
        peakEq = Math.max(peakEq, equity); maxDD = Math.max(maxDD, peakEq - equity); pos = null;
      }
      continue;
    }
    const a = analyse(candles.slice(Math.max(0, i - 400), i + 1), p);
    if (a.signal) {
      const nx = candles[i + 1], entry = nx.o * (1 + slip), qty = tradeSize * (1 - fee) / entry;
      pos = { entry, qty, stopDist: a.stopDist, stop: entry - a.stopDist, tp: entry + a.tpDist, peak: entry, openedAt: nx.t };
      // the entry bar itself can hit stop/tp
      i++; const m = manage(pos, { high: nx.h, low: nx.l, price: nx.c, now: nx.t + hourMs }, p);
      if (m.exit) { const exitPx = m.price * (1 - slip), pnl = qty * exitPx * (1 - fee) - tradeSize; equity += pnl; trades.push({ entryT: nx.t, exitT: nx.t, entry, exit: exitPx, pnl, pct: pnl / tradeSize * 100, reason: m.reason }); peakEq = Math.max(peakEq, equity); maxDD = Math.max(maxDD, peakEq - equity); pos = null; }
    }
  }
  const wins = trades.filter((t) => t.pnl > 0).length;
  const first = candles[MIN_CANDLES]?.c, last = candles[candles.length - 1]?.c;
  return {
    trades: trades.length, wins, winRate: trades.length ? wins / trades.length * 100 : 0,
    pnl: equity, pnlPct: equity / tradeSize * 100, maxDD, maxDDPct: maxDD / tradeSize * 100,
    holdPct: first ? (last / first - 1) * 100 : 0, list: trades.slice(-50), from: candles[MIN_CANDLES]?.t, to: candles[candles.length - 1]?.t,
  };
}
