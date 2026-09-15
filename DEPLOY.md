# Deploying HTML5-CS safely

`server.js` is hardened for public hosting:

- **Allow-list static serving.** Only `index.html`, `style.css`, `main.js`, `net.js`, `js/*.js`, `vendor/*`, `sounds/*` are served. `server.js`, `package*.json`, `*.md`, `node_modules/`, `.git/` all return 404. Symlinks pointing outside the folder are blocked. Only GET/HEAD are accepted.
- **Security headers.** Strict CSP (no third-party hosts; the inline importmap is hashed automatically at startup), `nosniff`, `frame-ancestors 'none'`, `no-referrer`, COOP/CORP, Permissions-Policy. HSTS is optional.
- **No CDN.** three.js 0.160.0 is vendored in `vendor/` (npm integrity verified), so players' browsers make no third-party requests.
- **WebSocket limits.** Origin check (same host only by default), max players, max connections per IP, 16 KB message cap, per-client token-bucket rate limit (floods get kicked), control/bidi characters stripped from names and chat. Match flow is server-authoritative (`server-match.js`): clients can't start/end rounds, change the score, or plant/defuse without passing the server's team, position and hold-time checks. `server-match.js` is never served (and must be deployed next to `server.js`).
- **HTTP timeouts** against slowloris.

## Environment variables
| Var | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | Listen port |
| `HOST` | 0.0.0.0 | Bind address. Use `127.0.0.1` behind a reverse proxy |
| `TRUST_PROXY` | off | `1` = read client IP from `X-Forwarded-For` (only behind your own proxy) |
| `HSTS` | off | `1` = send Strict-Transport-Security (only when served over HTTPS) |
| `MAX_CLIENTS` | 32 | Max simultaneous players |
| `MAX_PER_IP` | 4 | Max connections per IP |
| `ALLOWED_ORIGINS` | none | Extra page origins allowed to open the WebSocket (comma-separated) |
| `CSP_CONNECT_EXTRA` | none | Extra `connect-src` entries if the page must reach relays on other hosts |

## Quick local play (Arch or Ubuntu)
```sh
# Arch
sudo pacman -S --needed nodejs npm git
# Ubuntu
sudo apt update && sudo apt install -y nodejs npm git

cd HTML5-CS
npm ci --omit=dev
npm start            # open http://localhost:8080
```
Ubuntu 22.04's packaged Node is too old (12). Ubuntu 24.04+ ships Node 18, which works. On 22.04, install Node 18+ from NodeSource or with `nvm` first.

---

## Public server: Node behind nginx with HTTPS
The layout is the same on both distros:
1. The game runs as its own unprivileged user, on `127.0.0.1:8080` only.
2. nginx listens on ports 80 and 443, handles TLS (Let's Encrypt via certbot) and proxies HTTP and WebSocket to the game.
3. The firewall allows only SSH, 80 and 443.

Replace `game.example.org` with your domain. Its DNS A/AAAA records must point at the server before you run certbot.

### 1. Install packages
**Arch**
```sh
sudo pacman -Syu --needed nodejs npm nginx certbot certbot-nginx ufw rsync
```
**Ubuntu**
```sh
sudo apt update
sudo apt install -y nodejs npm nginx certbot python3-certbot-nginx ufw rsync
```

### 2. Create the service user and copy the game (both distros)
```sh
sudo useradd --system --home-dir /srv/html5-cs --shell /usr/bin/nologin html5cs   # Ubuntu: /usr/sbin/nologin
sudo mkdir -p /srv/html5-cs
# Copy from your dev machine. .git, _to_delete and node_modules are left out:
rsync -av --delete --exclude .git --exclude _to_delete --exclude node_modules ./ you@server:/tmp/html5-cs/
# then on the server:
sudo rsync -a --delete /tmp/html5-cs/ /srv/html5-cs/
cd /srv/html5-cs && sudo npm ci --omit=dev
sudo chown -R root:root /srv/html5-cs && sudo chmod -R a+rX,go-w /srv/html5-cs
```
The game user can read the files but not change them.

### 3. systemd service (both distros)
`/etc/systemd/system/html5cs.service`:
```ini
[Unit]
Description=HTML5-CS Strike Zone game server
After=network.target

[Service]
User=html5cs
Group=html5cs
WorkingDirectory=/srv/html5-cs
ExecStart=/usr/bin/node /srv/html5-cs/server.js
Environment=HOST=127.0.0.1 PORT=8080 TRUST_PROXY=1 HSTS=1
Restart=on-failure

# Sandboxing
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
CapabilityBoundingSet=
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```
```sh
sudo systemctl daemon-reload
sudo systemctl enable --now html5cs
systemctl status html5cs
journalctl -u html5cs -f
```
Don't use `MemoryDenyWriteExecute=true`, because Node's JIT needs to write executable memory.

### 4. nginx site
Site config (same content on both distros):
```nginx
server {
    listen 80;
    listen [::]:80;
    server_name game.example.org;
    server_tokens off;
    client_max_body_size 1k;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;                       # required: the WebSocket Origin check compares against Host
        proxy_set_header X-Forwarded-For $remote_addr;     # overwrite, don't append: clients can't spoof their IP
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 120s;
    }
}
```
Put this once in the `http { }` block (Arch: `/etc/nginx/nginx.conf`; Ubuntu: `/etc/nginx/conf.d/websocket.conf`):
```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

**Arch.** There's no sites directory by default, so create one:
```sh
sudo mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
sudoedit /etc/nginx/sites-available/html5cs.conf          # paste the server block
sudo ln -s /etc/nginx/sites-available/html5cs.conf /etc/nginx/sites-enabled/
# in /etc/nginx/nginx.conf, inside http { }, add:
#   include /etc/nginx/sites-enabled/*;
#   (plus the map line above)
sudo nginx -t && sudo systemctl enable --now nginx
```
**Ubuntu**
```sh
sudoedit /etc/nginx/sites-available/html5cs               # paste the server block
sudo ln -s /etc/nginx/sites-available/html5cs /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 5. HTTPS (both distros)
```sh
sudo certbot --nginx -d game.example.org --redirect --agree-tos -m you@example.org
```
Renewal is automatic. Ubuntu installs a `certbot.timer`. On Arch, enable it yourself:
```sh
sudo systemctl enable --now certbot-renew.timer
```
Test renewal with `sudo certbot renew --dry-run`.

Set `HSTS=1` in the service only after HTTPS works.

### 6. Firewall (both distros)
```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH        # Arch: sudo ufw allow 22/tcp
sudo ufw allow 80,443/tcp
sudo ufw enable
sudo systemctl enable ufw     # Arch only (Ubuntu enables it already)
```
Port 8080 stays closed, so the game is reachable only through nginx.

### 7. Check it
```sh
curl -sI https://game.example.org/ | grep -i content-security   # CSP header is present
curl -s -o /dev/null -w '%{http_code}\n' https://game.example.org/server.js   # 404
```
Open the site, click **Online** and join.

### Updating
Re-run the rsync from step 2, then `sudo npm ci --omit=dev`, then `sudo systemctl restart html5cs`. Keep the OS patched (`pacman -Syu` / `apt upgrade`) and run `npm audit` now and then.
