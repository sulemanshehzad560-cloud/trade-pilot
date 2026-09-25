#!/bin/bash
# =====================================================================================
#  Trade Pilot – one-time server setup for an Oracle Cloud "Always Free" Ubuntu server.
#  Paste this whole file into:  Create instance › Advanced options › Management ›
#  "Paste cloud-init script". It installs and starts everything by itself (~5 minutes).
#  You can also run it by hand:  sudo bash oracle-setup.sh
# =====================================================================================

# ----------------------------- EDIT THESE 4 LINES ------------------------------------
REPO="https://github.com/YOUR-GITHUB-NAME/trade-pilot.git"   # your GitHub repository
SETUP_CODE="123456"                 # pick any 6 digits; you'll type it once in the app
DOMAIN=""                           # e.g. mybot.duckdns.org  (leave empty to skip HTTPS)
DUCKDNS_TOKEN=""                    # from duckdns.org (only if you use DOMAIN)
# For a PRIVATE repo use: https://YOUR-TOKEN@github.com/YOUR-NAME/trade-pilot.git
# -------------------------------------------------------------------------------------

set -euo pipefail
exec > >(tee -a /var/log/trade-pilot-setup.log) 2>&1
echo "=== Trade Pilot setup started $(date) ==="
export DEBIAN_FRONTEND=noninteractive
APP=/opt/trade-pilot DATA=/var/lib/trade-pilot

apt-get update -y
apt-get install -y git curl ca-certificates gnupg iptables-persistent

# Node.js 20
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# App user, code and data folder
id tradepilot >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin tradepilot
mkdir -p "$DATA"; chown tradepilot:tradepilot "$DATA"; chmod 700 "$DATA"
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else rm -rf "$APP"; git clone --depth 1 "$REPO" "$APP"; fi
chown -R tradepilot:tradepilot "$APP"

# Listen on 8080 publicly, or only locally behind HTTPS when a domain is set
HOSTBIND="0.0.0.0"; [ -n "$DOMAIN" ] && HOSTBIND="127.0.0.1"
cat > /etc/systemd/system/trade-pilot.service <<EOF
[Unit]
Description=Trade Pilot trading bot
After=network-online.target
Wants=network-online.target
[Service]
User=tradepilot
WorkingDirectory=$APP
Environment=PORT=8080 HOST=$HOSTBIND DATA_DIR=$DATA SETUP_CODE=$SETUP_CODE NODE_ENV=production
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
EOF

# Auto-update from GitHub every 30 minutes (restarts only when the code changed)
cat > /usr/local/bin/trade-pilot-update <<EOF
#!/bin/bash
cd $APP || exit 0
OLD=\$(git rev-parse HEAD)
sudo -u tradepilot git pull --ff-only -q || exit 0
if [ "\$OLD" != "\$(git rev-parse HEAD)" ]; then systemctl restart trade-pilot; echo "updated to \$(git rev-parse --short HEAD)"; fi
exit 0
EOF
chmod +x /usr/local/bin/trade-pilot-update
git config --system --add safe.directory "$APP"
cat > /etc/systemd/system/trade-pilot-update.service <<EOF
[Unit]
Description=Update Trade Pilot from GitHub
[Service]
Type=oneshot
ExecStart=/usr/local/bin/trade-pilot-update
EOF
cat > /etc/systemd/system/trade-pilot-update.timer <<EOF
[Unit]
Description=Check GitHub for Trade Pilot updates
[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
[Install]
WantedBy=timers.target
EOF

# Open the firewall (Oracle's Ubuntu image blocks everything except SSH by default)
open_port() { iptables -C INPUT -p tcp --dport "$1" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp -m state --state NEW --dport "$1" -j ACCEPT; }
if [ -n "$DOMAIN" ]; then open_port 80; open_port 443; else open_port 8080; fi
netfilter-persistent save

# Optional HTTPS with a free DuckDNS name + Caddy (automatic Let's Encrypt certificate)
if [ -n "$DOMAIN" ]; then
  if [ -n "$DUCKDNS_TOKEN" ]; then
    SUB="${DOMAIN%%.duckdns.org}"
    echo "*/10 * * * * root curl -fsS 'https://www.duckdns.org/update?domains=$SUB&token=$DUCKDNS_TOKEN&ip=' >/dev/null 2>&1" > /etc/cron.d/duckdns
    curl -fsS "https://www.duckdns.org/update?domains=$SUB&token=$DUCKDNS_TOKEN&ip=" || true
  fi
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
EOF
  systemctl restart caddy
fi

systemctl daemon-reload
systemctl enable --now trade-pilot trade-pilot-update.timer
sleep 3
systemctl --no-pager status trade-pilot | head -5 || true
IP=$(curl -fsS https://api.ipify.org || echo "YOUR-SERVER-IP")
URL="http://$IP:8080"; [ -n "$DOMAIN" ] && URL="https://$DOMAIN"
echo "=== Done. Dashboard: $URL  ·  Setup code: $SETUP_CODE  ·  Server IP (for Binance): $IP ==="
