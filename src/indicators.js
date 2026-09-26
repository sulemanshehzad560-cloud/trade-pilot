// Classic indicators. Each returns an array aligned with the input (null until enough data).
export function ema(values, period) {
  const out = new Array(values.length).fill(null); if (values.length < period) return out;
  const k = 2 / (period + 1); let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period; out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
export function sma(values, period) {
  const out = new Array(values.length).fill(null); let sum = 0;
  for (let i = 0; i < values.length; i++) { sum += values[i]; if (i >= period) sum -= values[i - period]; if (i >= period - 1) out[i] = sum / period; }
  return out;
}
// Wilder's RSI
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null); if (closes.length <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= period; l /= period; out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]; g = (g * (period - 1) + Math.max(d, 0)) / period; l = (l * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
// Wilder's ATR
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null); if (candles.length <= period) return out;
  const tr = candles.map((c, i) => i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c)));
  let a = tr.slice(1, period + 1).reduce((x, y) => x + y, 0) / period; out[period] = a;
  for (let i = period + 1; i < candles.length; i++) { a = (a * (period - 1) + tr[i]) / period; out[i] = a; }
  return out;
}
// Bollinger Bands: middle = SMA, upper/lower = middle ± mult × standard deviation
export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period), up = new Array(values.length).fill(null), lo = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let v = 0; for (let j = i - period + 1; j <= i; j++) v += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / period); up[i] = mid[i] + mult * sd; lo[i] = mid[i] - mult * sd;
  }
  return { mid, up, lo };
}
// MACD: fast EMA − slow EMA, its signal line, and the histogram (difference)
export function macd(values, fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast), s = ema(values, slow), line = values.map((_, i) => f[i] != null && s[i] != null ? f[i] - s[i] : null);
  const start = line.findIndex((x) => x != null), sig = new Array(values.length).fill(null);
  if (start >= 0) { const e = ema(line.slice(start), signal); e.forEach((x, i) => { sig[start + i] = x; }); }
  return { line, signal: sig, hist: line.map((x, i) => x != null && sig[i] != null ? x - sig[i] : null) };
}
// Supertrend: an ATR band that flips below price in an uptrend (dir 1) and above it in a downtrend (dir -1)
export function supertrend(candles, period = 10, mult = 3) {
  const a = atr(candles, period), n = candles.length, line = new Array(n).fill(null), dir = new Array(n).fill(null);
  let fu = null, fl = null, d = 1;
  for (let i = 0; i < n; i++) {
    if (a[i] == null) continue;
    const c = candles[i], hl2 = (c.h + c.l) / 2, bu = hl2 + mult * a[i], bl = hl2 - mult * a[i], pc = i ? candles[i - 1].c : c.c;
    fu = fu == null || bu < fu || pc > fu ? bu : fu;
    fl = fl == null || bl > fl || pc < fl ? bl : fl;
    if (d === 1 && c.c < fl) d = -1; else if (d === -1 && c.c > fu) d = 1;
    dir[i] = d; line[i] = d === 1 ? fl : fu;
  }
  return { line, dir };
}
// Wilder's ADX: trend strength 0–100 (above ~25 = trending, below ~20 = sideways), plus +DI / −DI direction
export function adx(candles, period = 14) {
  const n = candles.length, out = new Array(n).fill(null), pdi = new Array(n).fill(null), mdi = new Array(n).fill(null);
  if (n <= period * 2) return { adx: out, pdi, mdi };
  let tr = 0, pd = 0, md = 0, dxs = [], ax = null;
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1], up = c.h - p.h, dn = p.l - c.l;
    const t = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)), plus = up > dn && up > 0 ? up : 0, minus = dn > up && dn > 0 ? dn : 0;
    if (i <= period) { tr += t; pd += plus; md += minus; if (i < period) continue; }
    else { tr = tr - tr / period + t; pd = pd - pd / period + plus; md = md - md / period + minus; }
    const P = tr ? 100 * pd / tr : 0, M = tr ? 100 * md / tr : 0, dx = P + M ? 100 * Math.abs(P - M) / (P + M) : 0;
    pdi[i] = P; mdi[i] = M;
    if (ax == null) { dxs.push(dx); if (dxs.length === period) { ax = dxs.reduce((x, y) => x + y, 0) / period; out[i] = ax; } }
    else { ax = (ax * (period - 1) + dx) / period; out[i] = ax; }
  }
  return { adx: out, pdi, mdi };
}
