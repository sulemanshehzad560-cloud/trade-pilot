# Trade Pilot

An automated crypto trading bot with a phone app to control it. Live trades go to **Binance Spot (USDT)** or **BitOasis (AED, UAE)**, whichever you choose in Settings.
It runs two accounts side by side:

| | Demo | Live on Binance | Live on BitOasis |
|---|---|---|---|
| Money | Pretend USDT | Real USDT in your Binance Spot wallet | Real AED in your BitOasis wallet |
| Signals from | Binance public prices | Binance public prices | Binance public prices (BitOasis has no chart API) |
| Orders | Simulated (fees included) | Real orders + stop-loss on Binance | Real orders + stop order on BitOasis |
| Needs | Nothing | Binance API key | BitOasis API token |

Each account has its own budget, trades, profit and Start/Stop button, so you can compare them.

> **Risk warning.** No bot can guarantee a profit, and most automated retail trading loses money.
> Start with the Demo account, run the Backtest, and only put in money you can afford to lose.
> Trade Pilot is a tool, not financial advice.

---

## How it trades

Every 5 minutes it scans your coins (BTC, ETH, SOL… against USDT) with free indicators, no paid AI, and buys only when the chosen strategy gives a signal. The default strategy is **Pullback + trailing (1h)**:

1. **Uptrend:** the price and the 50-candle average are above the 200-candle average, and that average is rising.
2. **Recent dip:** RSI fell below 42 in the last few candles.
3. **Turning back up:** RSI is back above 45 and rising, the candle closed green above the 20-candle average, and volume is normal.

**Every trade gets:**

- **A stop-loss:** 2 × ATR below the buy price (between 1.5% and your max %). In Live it's placed **on Binance itself**, so it protects you even if the server is down.
- **Breakeven:** once the price has risen by 1.5× the stop distance, the stop moves up just above the buy price.
- **A trailing stop** (most strategies): no fixed target; after +1× the risk the stop follows the price up, so winners can keep running.
  Strategies with a **fixed target** (Pullback + fixed target, Bollinger bounce) sell at their target instead.
- **A time exit:** it sells if there's no progress after the strategy's time limit (72 hours by default).

### Strategy Lab

Open **Lab** to compare 10 strategies on *your* coins over the last few months of real Binance prices, with fees and slippage, ranked by profit. Tap **Use this strategy** to switch; budgets and loss limits stay the same.

| Strategy | Idea | Works best when |
|---|---|---|
| Pullback + trailing (1h, 4h) | Buy a short dip in an uptrend | Steady uptrends |
| Pullback + fixed target (1h) | Same entry, sell at 2× the risk | Choppy uptrends |
| Breakout / Donchian (4h) | Buy a new 20-candle high (the classic "turtle" rule) | Strong trends |
| Supertrend (1h, 4h) | Buy when the ATR Supertrend line flips up (popular on TradingView and 3Commas) | Strong trends |
| MACD momentum (4h) | Buy a MACD cross above its signal line, above the 200 average | Trends starting |
| Bollinger bounce (1h) | Buy an oversold dip below the lower band, sell at the middle band (a common open-source bot strategy) | Sideways markets |
| Adaptive (1h, 4h) | Measures trend strength (ADX): trending → dip or breakout with a trailing stop; sideways → Bollinger bounce | Changing markets |

**Be careful with rankings.** No bot or strategy has a proven "highest success rate". Trend strategies lose in sideways markets and bounce strategies lose when a trend starts. A result with few trades is mostly luck, and past results don't predict the future. Try a new strategy on the Demo account for a few weeks before using it live.

**Safety limits:**

- **Budget cap per account.** Profits aren't reinvested automatically, and losses shrink the budget.
- **Max open trades** (2 by default).
- **Daily loss limit** (5% of budget). Once hit, no new trades until the next day (Dubai time).
- **Max total loss** (20%). Once hit, the bot stops completely until you tap **Reset limit**.
- **Cooldown:** a coin that just lost is skipped for 6 hours.
- **Controls:** **Stop bot** (open trades stay protected), **Sell now** per trade, **Sell all & stop**.
- **Spot only:** no leverage, no futures, no withdrawals.

---

## Why there are two parts

**Binance blocks servers in the US**, which is where Netlify and GitHub run. So:

- **The bot** runs on a **free Oracle Cloud server in Dubai or Abu Dhabi**, 24/7.
- **The app (dashboard)** is hosted on **Netlify**, so PWABuilder can turn it into an Android app. Netlify passes every `/api/` request to your bot server.

Everything here is free: GitHub, Netlify, Oracle Always Free, DuckDNS and Telegram. Binance charges its normal 0.1% trading fee.

---

## Setup (about 30–40 minutes, best done on a computer)

### Step 1 – Put the code on GitHub
1. github.com › **+** › **New repository** › name it `trade-pilot`.
   - **Public** is simplest. The code contains no passwords or keys; those stay on your server.
   - For **Private**, see the note in `deploy/oracle-setup.sh` about using a token.
2. **uploading an existing file** › drag in everything **inside** the unzipped `trade-pilot` folder › **Commit changes**.
   The repository should show `src`, `public`, `deploy`, `test`, `netlify.toml`, `package.json` and `README.md` at the top level.

### Step 2 – Get a free web address (DuckDNS)
1. Go to **duckdns.org** and sign in with Google or GitHub.
2. Create a sub-domain, e.g. `suleman-bot`. Your address becomes `suleman-bot.duckdns.org`.
3. Copy the **token** shown at the top of the page.

(You can skip this and use the server's IP address instead, but then the link between Netlify and the server isn't encrypted. HTTPS is strongly recommended.)

### Step 3 – Create the free Oracle server in the UAE
1. Sign up at **oracle.com/cloud/free**.
   - **Choose "UAE East (Dubai)" or "UAE Central (Abu Dhabi)" as your Home Region.** You can't change it later.
   - A card is needed for identity checks. Always Free resources aren't charged.
2. Open `deploy/oracle-setup.sh` in a text editor and fill in the 4 lines at the top:
   ```
   REPO="https://github.com/YOUR-GITHUB-NAME/trade-pilot.git"
   SETUP_CODE="482915"                 # any 6 digits you choose
   DOMAIN="suleman-bot.duckdns.org"    # from Step 2
   DUCKDNS_TOKEN="your-duckdns-token"  # from Step 2
   ```
3. In Oracle: **Menu › Compute › Instances › Create instance**
   - **Image:** Canonical **Ubuntu 22.04** (or 24.04)
   - **Shape:** **VM.Standard.E2.1.Micro** (marked "Always Free-eligible")
   - **Networking:** keep "Assign a public IPv4 address" on
   - **SSH keys:** keep "Generate a key pair" and save the private key somewhere safe
   - **Show advanced options › Management › Paste cloud-init script:** paste the **whole** edited `oracle-setup.sh`
   - Click **Create**. Setup runs by itself for about 5 minutes after the server starts.
4. **Open the web ports:** on the instance page, click the **Subnet** › **Default Security List** › **Add Ingress Rules**:
   - Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port Range `80,443`
   - (Without DuckDNS, use port `8080` instead.)
5. Note the instance's **Public IP address**. You need it for Binance in Step 5.
6. Check it works: open `https://suleman-bot.duckdns.org/api/ping` and you should see `{"ok":true,"app":"trade-pilot"}`.
   The first HTTPS certificate can take a minute or two.

### Step 4 – Put the app on Netlify
1. In your GitHub repository, open `netlify.toml` › pencil icon › change this line to your address:
   ```
   to = "https://suleman-bot.duckdns.org/api/:splat"
   ```
   (Without DuckDNS: `to = "http://YOUR-SERVER-IP:8080/api/:splat"`.) Then **Commit changes**.
2. Netlify › **Add new project › Import an existing project › GitHub** › choose `trade-pilot` › **Deploy**.
   Settings are read from `netlify.toml` automatically (publish folder `public`, no build command).
3. Open your Netlify site and enter your **setup code**, then create your password. It must be at least 8 characters.

### Step 5 – Connect Binance (for the Live account)
1. In Binance, go to **Profile › API Management › Create API › System generated**.
2. Permissions:
   - **Enable Spot & Margin Trading:** on
   - **Enable Withdrawals:** OFF
   - **Restrict access to trusted IPs only:** add your Oracle **Public IP**
3. In the app, go to **Settings › Binance API key**, paste the key and secret, then tap **Save & test**.
   The app warns you if the key can withdraw or isn't IP-locked.
4. Put USDT in your **Spot** wallet. You can buy USDT with AED on Binance. The live budget is in USDT (1 USDT ≈ 3.67 AED).

### Step 5b – Or connect BitOasis instead (UAE, AED)
Use this if your Binance account can't trade.
1. Log in to **bitoasis.net** on a computer (or the phone browser), then go to **Settings › Security › Token Management** and create a token.
   - Allow **trading** and **balance/read** access.
   - **Do NOT allow withdrawals.**
2. In the app, go to **Settings › Live account › Exchange** and tap **BitOasis · AED**.
   - Your live budget is converted to AED. Check it: the minimum is 25 AED per trade.
3. The **BitOasis API token** box appears. Paste the token and tap **Save & test**. You should see your AED balance.
4. Deposit AED into your BitOasis wallet (at least your live budget).

**Good to know about BitOasis:**
- Only coins listed on BitOasis are traded. The Scanner marks the others **Not on BitOasis**.
- BitOasis fees are higher than Binance's (roughly 0.5% per buy or sell, so about 1% per round trip). Use bigger trades, e.g. 150 AED or more, so fees eat less of the profit.
- Each exchange keeps its own live trade history. Switch back to Binance any time when no live trade is open.

### Step 6 – Start
1. **Settings:** set the Demo and Live budgets, the amount per trade and the limits.
2. **Backtest:** see how the strategy did on recent months of real prices.
3. **Home › Demo › Start bot.** Let it run for a week or two.
4. When you're comfortable, go to **Home › Live › Start bot** and confirm.

### Step 7 (optional) – Telegram alerts
1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token.
2. Send your new bot a message, then get your chat ID from **@userinfobot**.
3. Paste both in **Settings › Telegram alerts** › **Save & send test**.

---

## Android app (PWABuilder)
1. Go to **pwabuilder.com**, enter your Netlify address, then choose **Package for stores › Android**.
2. Use the package ID **`app.netlify.tradepilot.twa`**. It matches the included `assetlinks.json`.
3. Download the package. Inside it is an `assetlinks.json` with **your** signing fingerprint.
   Replace `public/assetlinks.json` in GitHub with that file (**Add file › Upload files**).
4. Wait for Netlify to redeploy. Check `https://YOUR-SITE.netlify.app/.well-known/assetlinks.json` shows your fingerprint.
5. Install the APK. If you installed it before this step, uninstall it and install it again.

---

## Updating
- **App:** change files on GitHub and Netlify redeploys in a minute or two.
- **Bot:** the server checks GitHub every 30 minutes and restarts with the new code.
  Open trades and history are kept, and live trades keep their stop-loss on Binance during the restart.

## Troubleshooting
| Message | Fix |
|---|---|
| *Can't reach your bot server* | Check `/api/ping` on your DuckDNS address, the Oracle ingress rules (Step 3.4), and the line in `netlify.toml`. |
| *Binance blocks this server's location* | The server isn't in the UAE. Oracle's home region must be Dubai or Abu Dhabi. |
| *Invalid API-key, IP, or permissions* | The key's trusted IP must match the Oracle Public IP, and Spot trading must be enabled. |
| *Not enough USDT in your Binance Spot wallet* | Move USDT from Funding to **Spot**, or lower the per-trade amount. |
| *below Binance's minimum* | Per trade must be at least about 6 USDT. |
| Forgot password | See "Resetting the password" below. |

**Resetting the password:** from the Oracle instance page, open **Console connection** or SSH in, then run:
```
sudo rm /var/lib/trade-pilot/auth.json && sudo systemctl restart trade-pilot
```
Then open the app and use your setup code again. Your trades and keys are kept.

**Server log:** run `sudo journalctl -u trade-pilot -f`. The setup log is in `/var/log/trade-pilot-setup.log`.

## For developers
- **Code:** Node.js 18+ with no npm dependencies.
  - `src/strategy.js` – signals and exits
  - `src/bot.js` – engine and limits
  - `src/binance.js` – signed REST client and filters
  - `src/bitoasis.js` – BitOasis client (Bearer token, AED orders; every order is checked with `?test=true` first and never retried)
  - `src/server.js` – login and API
- **Tests:** `npm test` runs the full end-to-end test against a strict fake Binance and a strict fake BitOasis in `test/`, which checks signatures, price ticks, lot steps, minimum order size and balances.
- **Run locally:** `npm start` serves the dashboard on port 8080. The setup code is printed in the console. Local runs work only from outside the US, because of Binance's location block.

## Design system

The dashboard UI is built on the **Night Gold** design system: tokens and components live in `public/design-system.css`, documented in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) (tokens also in `design-tokens.json`). Open `/design-system.html` on your dashboard for the live style guide.
