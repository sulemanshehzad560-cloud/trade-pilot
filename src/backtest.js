// Replays the strategy over past candles, with Binance fees and slippage, one position per coin.
import { analyse, manage, MIN_CANDLES } from "./strategy.js";

export function backtestSymbol(candles, p, { tradeSize = 100, fee = 0.001, slip = 0.0005 } = {}) {
  const trades = []; let pos = null, equity = 0, peakEq = 0, maxDD = 0;
  const barMs = candles.length > 1 ? candles[1].t - candles[0].t : 3600e3;
  const closeTrade = (bar, px, reason) => {
    const exitPx = Math.min(px, bar.h) * (1 - slip);
    const pnl = pos.qty * exitPx * (1 - fee) - tradeSize;
    equity += pnl; trades.push({ entryT: pos.openedAt, exitT: bar.t, entry: pos.entry, exit: exitPx, pnl, pct: pnl / tradeSize * 100, reason });
    peakEq = Math.max(peakEq, equity); maxDD = Math.max(maxDD, peakEq - equity); pos = null;
  };
  for (let i = MIN_CANDLES; i < candles.length - 1; i++) {
    const bar = candles[i];
    if (pos) {
      const m = manage(pos, { high: bar.h, low: bar.l, price: bar.c, now: bar.t + barMs }, p);
      // If the candle opened below the stop (a gap), the sale happens at the open, not at the stop price.
      if (m.exit) { const isStop = /stop/i.test(m.reason); closeTrade(bar, isStop ? Math.min(m.price, bar.o) : m.price, m.reason); }
      continue;
    }
    const a = analyse(candles.slice(Math.max(0, i - 400), i + 1), p);
    if (a.signal) {
      const nx = candles[i + 1], entry = nx.o * (1 + slip), qty = tradeSize * (1 - fee) / entry;
      pos = { entry, qty, stopDist: a.stopDist, stop: entry - a.stopDist, tp: a.tpDist ? entry + a.tpDist : null, peak: entry, openedAt: nx.t };
      // the entry bar itself can hit the stop / target
      i++; const m = manage(pos, { high: nx.h, low: nx.l, price: nx.c, now: nx.t + barMs }, p);
      if (m.exit) closeTrade(nx, m.price, m.reason);
    }
  }
  // A trade still open at the end is valued at the last close.
  let open = 0;
  if (pos) { const last = candles[candles.length - 1]; open = pos.qty * last.c * (1 - slip) * (1 - fee) - tradeSize; }
  const wins = trades.filter((t) => t.pnl > 0).length;
  const first = candles[MIN_CANDLES]?.c, last = candles[candles.length - 1]?.c;
  const holdPct = first ? (last / first - 1) * 100 : 0;
  return {
    trades: trades.length, wins, winRate: trades.length ? wins / trades.length * 100 : 0,
    pnl: equity + open, closedPnl: equity, openPnl: open, pnlPct: (equity + open) / tradeSize * 100, maxDD, maxDDPct: maxDD / tradeSize * 100,
    holdPct, holdPnl: tradeSize * (holdPct / 100) - tradeSize * fee * 2,
    list: trades, from: candles[MIN_CANDLES]?.t, to: candles[candles.length - 1]?.t,
  };
}

// Combined worst dip across all coins, using trade exit times.
export function combinedDD(lists) {
  const all = lists.flat().sort((a, b) => a.exitT - b.exitT); let eq = 0, pk = 0, dd = 0;
  for (const t of all) { eq += t.pnl; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  return dd;
}
