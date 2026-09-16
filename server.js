// HTML5-CS — Strike Zone multiplayer server.
// Serves the static game + relays snapshots/events over WebSocket.
// Rule: when 2+ real players are online, clients disable bots (pure PvP).
// Hitscan/movement are client-side and relayed; match flow (rounds, clocks, score,
// K/D/A, bomb) is server-authoritative in server-match.js.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createMatch } from './server-match.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function parsePort() {
  const i = process.argv.indexOf('--port');
  if (i !== -1 && process.argv[i + 1]) {
    const p = parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(p)) return p;
  }
  // npm passes extra args after `--`, e.g. `npm start -- --port 8081`
  const eq = process.argv.find((a) => a.startsWith('--port='));
  if (eq) {
    const p = parseInt(eq.split('=')[1], 10);
    if (Number.isFinite(p)) return p;
  }
  const env = parseInt(process.env.PORT || '', 10);
  if (Number.isFinite(env)) return env;
  return 8080;
}
const PORT = parsePort();
// Bind address. Behind a reverse proxy (nginx/Caddy doing TLS) use HOST=127.0.0.1.
const HOST = process.env.HOST || '0.0.0.0';
// Set TRUST_PROXY=1 only when a reverse proxy you control sets X-Forwarded-For.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// Send HSTS only when the site is served over HTTPS (HSTS=1).
const HSTS = process.env.HSTS === '1';
// Comma-separated extra WebSocket origins allowed to connect, e.g. "https://game.example.org".
// Same-host pages are always allowed.
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));
// Extra CSP connect-src entries if players should reach relays on other hosts (e.g. "wss://relay.example.org").
const CSP_CONNECT_EXTRA = (process.env.CSP_CONNECT_EXTRA || '').replace(/[^\w:/.\-* ]/g, '');
const MAX_CLIENTS = Math.max(1, parseInt(process.env.MAX_CLIENTS || '32', 10) || 32);
const MAX_PER_IP = Math.max(1, parseInt(process.env.MAX_PER_IP || '4', 10) || 4);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

// Public files only. Anything not matched here (server.js, package*.json, *.md,
// node_modules, .git, backups, editor swap files...) is never served.
const PUBLIC_RULES = [
  /^\/index\.html$/,
  /^\/style\.css$/,
  /^\/(main|net)\.js$/,
  /^\/js\/[A-Za-z0-9_-]+\.js$/,
  /^\/vendor\/[A-Za-z0-9._-]+\.(js|txt)$/,
  /^\/sounds\/[A-Za-z0-9._-]+\.(mp3|ogg|wav|txt)$/,
  /^\/favicon\.ico$/,
];
const ROOT = fs.realpathSync(__dirname);

// CSP: the only inline script is the importmap in index.html; hash it at startup
// so editing index.html never silently breaks the page.
function buildCsp() {
  let hashes = '';
  try {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let mm;
    while ((mm = re.exec(html))) {
      hashes += ` 'sha256-${crypto.createHash('sha256').update(mm[1], 'utf8').digest('base64')}'`;
    }
  } catch {}
  return [
    "default-src 'none'",
    `script-src 'self'${hashes}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    `connect-src 'self'${CSP_CONNECT_EXTRA ? ' ' + CSP_CONNECT_EXTRA : ''}`,
    "font-src 'self'",
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}
const CSP = buildCsp();

function securityHeaders(extra = {}) {
  const h = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  };
  if (HSTS) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

function plain(res, code, text) {
  res.writeHead(code, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }));
  res.end(text);
}

const server = http.createServer((req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      plain(res, 405, 'method not allowed'); return;
    }
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { plain(res, 400, 'bad request'); return; }
    if (urlPath === '/') urlPath = '/index.html';
    if (urlPath.includes('\0') || urlPath.includes('..') || !PUBLIC_RULES.some((r) => r.test(urlPath))) {
      plain(res, 404, 'not found'); return;
    }
    let filePath;
    try { filePath = fs.realpathSync(path.join(ROOT, urlPath.slice(1))); }
    catch { plain(res, 404, 'not found'); return; }
    // Block symlinks that point outside the game folder.
    if (!filePath.startsWith(ROOT + path.sep)) { plain(res, 404, 'not found'); return; }
    const st = fs.statSync(filePath);
    if (!st.isFile()) { plain(res, 404, 'not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, securityHeaders({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.mp3' || urlPath.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
    }));
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    try { plain(res, 500, 'server error'); } catch { res.destroy(); }
  }
});
// Slowloris / idle-connection limits.
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;
server.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}
const ipCounts = new Map();

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false; // browsers always send Origin on WebSocket upgrades
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// No per-message compression: tiny JSON packets gain nothing and deflate adds latency.
const wss = new WebSocketServer({
  server, path: '/ws', perMessageDeflate: false, maxPayload: 16 * 1024,
  verifyClient: ({ req }, done) => {
    if (!originAllowed(req)) return done(false, 403, 'forbidden origin');
    if (clients.size >= MAX_CLIENTS) return done(false, 503, 'server full');
    if ((ipCounts.get(clientIp(req)) || 0) >= MAX_PER_IP) return done(false, 429, 'too many connections');
    done(true);
  },
});

// Strip control chars and bidi overrides so names/chat can't spoof UI or logs.
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max);

let nextId = 1;
const RATE_PER_SEC = 120; // sustained messages/second per client
const RATE_BURST = 240;
// Dropped weapons on the floor: wid -> { wid, key, mag, reserve, x, y, z, ry, at }.
// The server arbitrates pickups so two players can never grab the same gun.
const drops = new Map();
const WEAPON_KEYS = new Set(['ak', 'deagle', 'awp', 'p90']);
// id -> { ws, id, name, team, state, lastSeen }
const clients = new Map();

function teamCounts() {
  let ct = 0, t = 0;
  for (const c of clients.values()) {
    if (c.team === 'ct') ct++;
    else if (c.team === 't') t++;
  }
  return { ct, t };
}

function pickTeam(want) {
  if (want === 'ct' || want === 't') {
    // Honor explicit pick unless it would unbalance by >1 (then balance anyway)
    const { ct, t } = teamCounts();
    if (want === 'ct' && ct > t + 1) return 't';
    if (want === 't' && t > ct + 1) return 'ct';
    return want;
  }
  const { ct, t } = teamCounts();
  return t < ct ? 't' : 'ct';
}

function roster() {
  return [...clients.values()].map((c) => ({ id: c.id, name: c.name, team: c.team }));
}

function broadcast(obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  for (const c of clients.values()) {
    if (c.id === exceptId) continue;
    if (c.ws.readyState === 1) c.ws.send(msg);
  }
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

const match = createMatch({
  clients, broadcast, send,
  onRoundStart: () => { const now = Date.now(); for (const [k, d] of drops) if (now - d.at > 2000) drops.delete(k); },
});

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
  const id = nextId++;
  const client = { ws, id, ip, name: `Player${id}`, team: null, state: null, lastSeen: Date.now(), alive: true, lastStateAt: 0, lastChatAt: 0, lastPos: null, kills: 0, deaths: 0, assists: 0, mAlive: false,
    tokens: RATE_BURST, lastRefill: Date.now(), strikes: 0 };
  try { ws._socket.setNoDelay(true); } catch {} // never let Nagle batch game packets
  ws.on('pong', () => { client.alive = true; });
  clients.set(id, client);
  console.log(`[+] client ${id} connected (${clients.size} online)`);

  ws.on('message', (buf) => {
    // Token bucket: normal play is ~30-60 msg/s; floods get dropped, then kicked.
    const nowR = Date.now();
    client.tokens = Math.min(RATE_BURST, client.tokens + ((nowR - client.lastRefill) / 1000) * RATE_PER_SEC);
    client.lastRefill = nowR;
    if (client.tokens < 1) {
      if (++client.strikes > 200) { try { ws.close(1008, 'rate limit'); } catch {} }
      return;
    }
    client.tokens -= 1;
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.type !== 'string') return;
    client.lastSeen = nowR;

    switch (m.type) {
      case 'hello': {
        const cleanName = cleanText(m.name || `Player${id}`, 64).replace(/[<>&"'`\\]/g, '').trim().slice(0, 16) || `Player${id}`;
        client.name = cleanName;
        const name = cleanName;
        if (client.team) break; // once-guard — hello is only processed once per connection
        client.team = pickTeam(m.wantTeam);
        console.log(`[+] #${id} "${name}" joined as ${client.team.toUpperCase()} (${clients.size} online)`);
        // Decide alive/match activation first so the welcome carries the real state.
        match.join(client);
        send(ws, { type: 'welcome', id, team: client.team, name, players: roster(), realPlayers: clients.size, match: match.state('welcome') });
        broadcast({ type: 'player_joined', id, name, team: client.team, realPlayers: clients.size }, id);
        // Immediately push a roster snapshot so everyone can apply the no-bots rule
        broadcast({ type: 'roster', players: roster(), realPlayers: clients.size });
        if (drops.size) send(ws, { type: 'weapon', action: 'sync', drops: [...drops.values()] });
        break;
      }
      case 'weapon': {
        const wid = String(m.wid || '').slice(0, 64);
        if (!wid || !/^[A-Za-z0-9._-]{1,64}$/.test(wid)) break;
        if (m.action === 'drop') {
          if (!WEAPON_KEYS.has(m.key) || drops.has(wid)) break;
          if (drops.size >= 32) { const oldest = drops.keys().next().value; drops.delete(oldest); }
          const cx = +m.x || 0, cy = +m.y || 0, cz = +m.z || 0;
          if (!Number.isFinite(cx + cy + cz) || Math.abs(cx) > 45 || Math.abs(cz) > 45) break;
          const d = { wid, key: m.key, mag: Math.max(0, Math.min(50, m.mag | 0)), reserve: Math.max(0, Math.min(250, m.reserve | 0)),
            x: cx, y: Math.max(-1, Math.min(12, cy)), z: cz, ry: +m.ry || 0, at: Date.now() };
          drops.set(wid, d);
          broadcast({ type: 'weapon', action: 'drop', ...d, vx: +m.vx || 0, vy: +m.vy || 0, vz: +m.vz || 0, fromId: id }, id);
        } else if (m.action === 'rest') {
          const d = drops.get(wid);
          if (!d) break;
          const rx = +m.x || 0, ry2 = +m.y || 0, rz = +m.z || 0;
          if (!Number.isFinite(rx + ry2 + rz) || Math.abs(rx) > 45 || Math.abs(rz) > 45) break;
          d.x = rx; d.y = Math.max(-1, Math.min(12, ry2)); d.z = rz; d.ry = +m.ry || 0;
          broadcast({ type: 'weapon', action: 'rest', wid, x: d.x, y: d.y, z: d.z, ry: d.ry }, id);
        } else if (m.action === 'pickup') {
          const d = drops.get(wid);
          if (!d) { send(ws, { type: 'weapon', action: 'deny', wid }); break; }
          drops.delete(wid);
          // everyone (including the winner) learns who got it
          broadcast({ type: 'weapon', action: 'pickup', wid, key: d.key, mag: d.mag, reserve: d.reserve, byId: id });
        }
        break;
      }
      case 'state': {
        // ~30Hz positional state — relayed to everyone else IMMEDIATELY (no server tick
        // holding it back), and kept for the 1Hz full keepalive snapshot.
        const nowS = Date.now();
        if (nowS - client.lastStateAt < 20) break; // rate-limit: 50Hz max
        client.lastStateAt = nowS;
        const sx = +m.x || 0, sy = +m.y || 0, sz = +m.z || 0;
        if (!Number.isFinite(sx + sy + sz + (+m.yaw || 0) + (+m.pitch || 0))) break;
        if (Math.abs(sx) > 45 || Math.abs(sz) > 45 || sy < -2 || sy > 15) break;
        if (!client.team) break;
        client.lastPos = { x: sx, y: sy, z: sz };
        client.state = {
          id, ct: +m.ct || 0,
          x: sx, y: sy, z: sz,
          yaw: +m.yaw || 0, pitch: +m.pitch || 0,
          hp: Math.max(0, Math.min(100, +m.hp || 100)),
          alive: match.onState(client, !!m.alive, m.rid),
          weapon: String(m.weapon || 'deagle').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12),
          aiming: !!m.aiming,
          moving: !!m.moving,
          crouch: !!m.crouch,                      // crouched hull / lowered hitbox
          gnd: m.gnd !== false,                    // standing on ground or a box top
          wr: Math.max(-1, Math.min(1, m.wr | 0)), // wall run: -1 wall on left, 1 right, 0 none
          dual: !!m.dual,                          // dual wielding the current weapon
          planting: !!m.planting,                  // kneel anim while working the bomb
          defusing: !!m.defusing,
          ping: Math.max(0, Math.min(9999, Math.round(+m.ping) || 0)),
        };
        if (client.team) {
          const msg = JSON.stringify({ type: 'snapshot', players: [{ ...client.state, name: client.name, team: client.team }] });
          for (const c of clients.values()) if (c.id !== id && c.ws.readyState === 1) c.ws.send(msg);
        }
        break;
      }
      case 'bomb':
        match.handleBomb(client, m);
        break;
      case 'shot':
      case 'hit':
      case 'killed':
      case 'nade':
      case 'chat': {
        // Relay gameplay events to everyone else; stamp sender id.
        if (m.type === 'chat') {
          if (Date.now() - client.lastChatAt < 800) break;
          client.lastChatAt = Date.now();
          m.text = cleanText(m.text || '', 200);
        }
        if (m.type === 'killed') {
          if (m.victimId !== id) break; // only the victim reports its own death
          m.killerName = cleanText(m.killerName, 16); m.victimName = client.name;
          m.weapon = cleanText(m.weapon, 24); m.victimTeam = client.team;
          if (m.killerTeam !== 'ct' && m.killerTeam !== 't') delete m.killerTeam;
          match.onKilled(client, m);
        }
        if (m.type === 'hit' && m.dmg !== undefined) {
          const d = +m.dmg;
          if (!Number.isFinite(d)) break;
          m.dmg = Math.max(0, Math.min(100, d));
        }
        if ((m.type === 'nade' || m.type === 'shot') && (m.x !== undefined || m.y !== undefined || m.z !== undefined)) {
          if (!Number.isFinite(+m.x + +m.y + +m.z)) break;
          if (Math.abs(+m.x) > 45 || Math.abs(+m.z) > 45) break;
        }
        m.fromId = id;
        m.fromName = client.name;
        m.fromTeam = client.team;
        broadcast(m, id);
        break;
      }
      case 'dmg': {
        // Damage ack: the victim tells its attacker how much HP a hit really took
        // (armor, remaining HP). Sent only to that attacker, never broadcast.
        const to = clients.get(+m.toId);
        if (!to || to.id === id || !client.team) break;
        const d = +m.dmg;
        if (!Number.isFinite(d)) break;
        send(to.ws, {
          type: 'dmg', toId: to.id, fromId: id, fromName: client.name, fromTeam: client.team,
          dmg: Math.max(0, Math.min(100, d)), hits: Math.max(0, Math.min(30, m.hits | 0)),
          killed: !!m.killed, rid: m.rid | 0,
        });
        break;
      }
      case 'ping': {
        send(ws, { type: 'pong', t: m.t });
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    const left = (ipCounts.get(ip) || 1) - 1;
    if (left > 0) ipCounts.set(ip, left); else ipCounts.delete(ip);
    if (!clients.size) drops.clear();
    console.log(`[-] client ${id} left (${clients.size} online)`);
    broadcast({ type: 'player_left', id, realPlayers: clients.size });
    broadcast({ type: 'roster', players: roster(), realPlayers: clients.size });
    if (client.team) match.leave(client);
  });

  ws.on('error', () => { try { ws.close(); } catch {} });
});

// Reap dead connections (laptop lid closed, Wi-Fi dropped) so ghosts don't linger.
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { try { c.ws.terminate(); } catch {} continue; }
    c.alive = false;
    try { c.ws.ping(); } catch {}
  }
}, 5000);

// 1Hz full snapshot: keepalive + names/teams + player count. Clients ignore
// positions they already have (same ct), so this never causes a rubber-band.
setInterval(() => {
  if (!clients.size) return;
  const players = [];
  for (const c of clients.values()) {
    if (!c.state) continue;
    players.push({ ...c.state, name: c.name, team: c.team });
  }
  match.sync(); // keeps late joiners and drifting clocks honest
  if (!players.length) return;
  const msg = JSON.stringify({ type: 'snapshot', players, realPlayers: clients.size, t: Date.now() });
  for (const c of clients.values()) {
    if (c.ws.readyState === 1) c.ws.send(msg);
  }
}, 1000);

// Prevent unhandled 'error' crash from the ws wrapper (it re-emits listen errors).
wss.on('error', () => {});
function listenOn(port, attemptsLeft = 10) {
  const onErr = (err) => {
    if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.warn(`Port ${port} in use — trying ${port + 1}… (or run PORT=<free> npm start)`);
      setTimeout(() => listenOn(port + 1, attemptsLeft - 1), 150);
    } else {
      console.error(`Failed to listen on port ${port}:`, err?.message || err);
      console.error('Tip: run with a free port, e.g.  PORT=8081 npm start  or  npm start -- --port 8081');
      process.exit(1);
    }
  };
  const onListen = () => {
    server.removeListener('error', wrappedErr);
    // Keep a permanent handler so post-listen async errors log instead of crashing.
    server.on('error', (e) => console.error('[server] error:', e?.message || e));
    const addr = server.address();
    const actual = (addr && typeof addr === 'object' && addr.port) || port;
    console.log(`HTML5-CS server on http://${HOST}:${actual}  (ws path /ws, max ${MAX_CLIENTS} players, ${MAX_PER_IP}/IP)`);
    console.log('Rule: clients disable bots when 2+ real players are online.');
  };
  const wrappedErr = (err) => {
    server.removeListener('listening', onListen);
    onErr(err);
  };
  server.once('error', wrappedErr);
  server.once('listening', onListen);
  server.listen(port, HOST);
}
listenOn(PORT);
