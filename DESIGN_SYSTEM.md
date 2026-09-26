# Trade Pilot Design System — "Night Gold" v1.0

The dashboard's visual language, extracted from `public/index.html` into a
reusable, token-based system.

| File | Purpose |
| --- | --- |
| `public/design-system.css` | The implementation: tokens, base styles, components, utilities. Loaded by the app. |
| `design-tokens.json` | The same tokens in W3C Design Tokens format, for Figma / Style Dictionary / other apps. |
| `public/design-system.html` | Live style guide — open `/design-system.html` on the running dashboard. |

## Principles

1. **Dark first, glanceable.** Near-black background, bright text, one brand accent. Numbers must read at arm's length on a phone.
2. **Colour means money.** Green = profit / buy, red = loss / danger / live money, gold = brand & primary action, blue = demo / info, amber = warning. Never use these for decoration.
3. **Real money is loud.** Anything that touches the live account uses the red treatment (`.chip.avoid`, `.pill.live`, `.btn.red`, `.acctsw button.live`).
4. **Thumb-sized.** Controls are at least 46px tall (36px for `.sm`), layouts are single-column up to 720px, and bars respect safe-area insets.

## Token layers

```
Primitives  --tp-ink-900, --tp-gold-500 …        raw palette — never used directly by components
Semantic    --color-surface, --space-4, --radius-xl …   what components use
Components  .btn, .card, .chip …
Utilities   .mt-3, .m-0, .up, .num …
```

Change the look by editing **semantic** tokens (or the primitives they point to); components pick it up automatically.

### Colour

| Token | Value | Use |
| --- | --- | --- |
| `--color-bg` | `#07080a` | Page background |
| `--color-surface` | `#101217` | Cards, sheets, position rows |
| `--color-surface-raised` | `#171a21` | KPI tiles, tracks, secondary buttons, segmented controls |
| `--color-surface-overlay` | `#1b1e25` | Toasts |
| `--color-field` | `#0b0c10` | Text inputs |
| `--color-border` / `-strong` | `#252932` / `#3a3f4b` | Hairlines / inactive indicators |
| `--color-text` / `-soft` / `-muted` | `#eef0f3` / `#c6cbd5` / `#8d94a3` | Primary / body-secondary / captions |
| `--color-accent` (`-hi`, `-lo`) | `#d8b25e` (`#f3d796`, `#b28a36`) | Brand gold, primary action, focus |
| `--color-on-accent` | `#17130a` | Text on gold |
| `--color-positive` | `#23c68b` | Profit, buy signal, running |
| `--color-negative` | `#ff6161` | Loss, stop, danger |
| `--color-warning` | `#f0a93b` | Warnings, errors in data |
| `--color-info` | `#6ea8ff` | Demo / informational |

Tints for banners, chips and pills are provided as `--color-*-tint` and `--color-*-border`.
Every primitive hue also exposes an `--tp-*-rgb` channel triplet, so new tints are `rgba(var(--tp-gold-rgb), .2)`.

### Typography

System font stack (`--font-sans`), base 15px / 1.45. Use `.num` on every number (tabular figures).

| Token | Size | Use |
| --- | --- | --- |
| `--font-size-2xs` | 11.5px | Chips, pills, nav labels, KPI captions |
| `--font-size-xs` | 12.5px | Labels, hints, timestamps (`.tiny`) |
| `--font-size-sm` | 13.5px | Secondary copy, tables, small buttons (`.small`) |
| `--font-size-md` | 14px | Banners, toasts, dialogs |
| `--font-size-base` | 15px | Body, buttons |
| `--font-size-lg` | 16px | Card titles, inputs, coin symbols |
| `--font-size-xl` | 17.5px | Page titles, app bar, P/L % |
| `--font-size-2xl` | 20px | Brand, sign-in heading |
| `--font-size-display` | 36px | Hero total |

Weights: `--font-weight-medium` 600, `-bold` 700, `-heavy` 800.

### Spacing, radius, elevation

- **Space** (4px grid with 2px half-steps): `--space-0-5` 2 · `1` 4 · `1-5` 6 · `2` 8 · `2-5` 10 · `3` 12 · `3-5` 14 · `4` 16 · `5` 20 · `6` 24 · `7` 28.
- **Radius**: `xs` 4 · `sm` 10 (small buttons, segments) · `md` 12 (inputs, buttons, KPI) · `lg` 14 (banners, rows) · `xl` 18 (cards) · `2xl` 22 (sheets, sign-in) · `full` (pills, chips).
- **Elevation**: `--shadow-sm` (selected segment), `--shadow-lg` (sign-in card), `--ring-focus` (focused input). Depth otherwise comes from surface steps, not shadows.
- **Layers**: `--z-subbar` 19 · `--z-topbar` 20 · `--z-nav` 30 · `--z-gate` 50 · `--z-toast` 80 · `--z-modal` 90.

## Components

| Component | Markup | Variants |
| --- | --- | --- |
| Button | `<button class="btn">` | `.gold` primary · `.green` confirm · `.red` destructive · `.sm` · `.full` |
| Button pair | `<div class="actions">` | two equal columns |
| Card | `<div class="card"><h3>…` | `.hero` (gold glow) |
| KPI tiles | `<div class="kpis"><div class="kpi"><b>…</b><span>…</span>` | — |
| Status pill | `<span class="pill"><i></i>…` | `.on` · `.live` · `.sim` |
| Chip | `<span class="chip">` | `.buy` · `.watch` · `.avoid` · `.error` · `.tight` |
| Choice chips | `<div class="chips"><button aria-pressed>` | — |
| Segmented control | `.acctsw` (tabs, `aria-selected`) · `.seg` (toggle, `aria-pressed`) | `.live` on a button |
| Banner | `<div class="banner warn">` | `.warn` · `.bad` · `.info` · `.inline` |
| Position card | `.pos` with `.sym`, `.pct`, `.range` | — |
| Scanner row | `.srow` with `.score` | `.sig` |
| Progress bar | `<div class="bar"><i class="fill"><i class="rest">` | — |
| Section heading | `<div class="section-head"><h2 class="page-title">` | `.spaced` |
| Form | `label` + `input`, `.g2` two-up grid, `.hint`, `.err`, `.chk` | — |
| Lists | `.trow`, `.loginfo`, `.tbl > table`, `.empty` | `.lv-trade/alert/error` |
| Chrome | `.top`, `.acctbar`, `.nav`, `.toast`, `.modal > .mbox`, `.gate > .gcard` | — |

## Utilities

`.num` `.up` `.down` `.mut` `.accent` `.small` `.tiny` `.left` ·
margins `.m-0` `.mt-0` `.mt-1` `.mt-1-5` `.mt-2-5` `.mt-3` `.mt-3-5` `.mt-4` `.mb-3` `.mr-1` `.ml-1-5` `.stack-top` `.stack-top-lg`.

## Rules for contributors

- No hex colours or `style="…"` in markup — use a token or a utility. The only inline styles left are data-driven positions/widths (`.range` markers, `.score` fill).
- Charts drawn in JS read colours from tokens: `getComputedStyle(document.documentElement).getPropertyValue("--color-positive")`.
- New components go in `public/design-system.css` under **Components**, built from semantic tokens only, and get an entry in the table above and in `design-system.html`.
- Keep `design-tokens.json` in sync when a token changes.
