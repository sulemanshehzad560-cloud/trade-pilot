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
