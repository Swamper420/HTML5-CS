# Deploying HTML5-CS safely

`server.js` is hardened for public hosting:

- **Allow-list static serving.** Only `index.html`, `style.css`, `main.js`, `net.js`, `js/*.js`, `vendor/*`, `sounds/*` are served. `server.js`, `package*.json`, `*.md`, `node_modules/`, `.git/` all return 404. Symlinks pointing outside the folder are blocked. Only GET/HEAD are accepted.
- **Security headers.** Strict CSP (no third-party hosts; the inline importmap is hashed automatically at startup), `nosniff`, `frame-ancestors 'none'`, `no-referrer`, COOP/CORP, Permissions-Policy. HSTS is optional.
- **No CDN.** three.js 0.160.0 is vendored in `vendor/` (npm integrity verified), so players' browsers make no third-party requests.
- **WebSocket limits.** Origin check (same host only by default), max players, max connections per IP, 16 KB message cap, per-client token-bucket rate limit (floods get kicked), control/bidi characters stripped from names and chat. Only the round host (lowest id) can start or reset a match.
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

## Recommended: reverse proxy with TLS (NixOS)
Run the game as an unprivileged service on localhost and let nginx do HTTPS (Let's Encrypt).

```nix
{ pkgs, ... }: {
  users.users.html5cs = { isSystemUser = true; group = "html5cs"; };
  users.groups.html5cs = {};

  systemd.services.html5cs = {
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    environment = { HOST = "127.0.0.1"; PORT = "8080"; TRUST_PROXY = "1"; HSTS = "1"; };
    serviceConfig = {
      ExecStart = "${pkgs.nodejs_22}/bin/node /srv/html5-cs/server.js";
      WorkingDirectory = "/srv/html5-cs";
      User = "html5cs"; Group = "html5cs";
      Restart = "on-failure";
      NoNewPrivileges = true; ProtectSystem = "strict"; ProtectHome = true;
      PrivateTmp = true; PrivateDevices = true; ReadOnlyPaths = [ "/srv/html5-cs" ];
      RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
      MemoryMax = "512M";
    };
  };

  security.acme = { acceptTerms = true; defaults.email = "you@example.org"; };
  services.nginx = {
    enable = true;
    recommendedProxySettings = true;   # passes Host + X-Forwarded-For (needed for the Origin check)
    recommendedTlsSettings = true;
    virtualHosts."game.example.org" = {
      enableACME = true; forceSSL = true;
      locations."/" = { proxyPass = "http://127.0.0.1:8080"; proxyWebsockets = true; };
    };
  };
  networking.firewall.allowedTCPPorts = [ 80 443 ];
}
```

Deploy with `npm ci --omit=dev` and do not copy `.git/` to the server. Keep `ws` updated (`npm audit`).
