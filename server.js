// HTML5-CS — Strike Zone multiplayer server.
// Serves the static game + relays snapshots/events over WebSocket.
// Rule: when 2+ real players are online, clients disable bots (pure PvP).
// Server is a dumb relay + team balancer; simulation (hitscan, bomb, rounds)
// runs on clients with host (lowest id) authoritative for round flow.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

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
};

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (urlPath === '/') urlPath = '/index.html';
    // Never serve .git or hidden files
    if (urlPath.includes('..') || urlPath.includes('/.git')) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const filePath = path.join(__dirname, urlPath.slice(1));
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(500); res.end('server error');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

let nextId = 1;
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
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  const id = nextId++;
  const client = { ws, id, name: `Player${id}`, team: null, state: null, lastSeen: Date.now() };
  clients.set(id, client);
  console.log(`[+] client ${id} connected (${clients.size} online)`);

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    client.lastSeen = Date.now();

    switch (m.type) {
      case 'hello': {
        const name = String(m.name || `Player${id}`).slice(0, 16);
        client.name = name;
        client.team = pickTeam(m.wantTeam);
        console.log(`[+] #${id} "${name}" joined as ${client.team.toUpperCase()} (${clients.size} online)`);
        send(ws, { type: 'welcome', id, team: client.team, name, players: roster(), realPlayers: clients.size });
        broadcast({ type: 'player_joined', id, name, team: client.team, realPlayers: clients.size }, id);
        // Immediately push a roster snapshot so everyone can apply the no-bots rule
        broadcast({ type: 'roster', players: roster(), realPlayers: clients.size });
        if (drops.size) send(ws, { type: 'weapon', action: 'sync', drops: [...drops.values()] });
        break;
      }
      case 'weapon': {
        const wid = String(m.wid || '').slice(0, 64);
        if (!wid) break;
        if (m.action === 'drop') {
          if (!WEAPON_KEYS.has(m.key) || drops.has(wid)) break;
          const d = { wid, key: m.key, mag: Math.max(0, Math.min(50, m.mag | 0)), reserve: Math.max(0, Math.min(250, m.reserve | 0)),
            x: +m.x || 0, y: +m.y || 0, z: +m.z || 0, ry: +m.ry || 0, at: Date.now() };
          drops.set(wid, d);
          broadcast({ type: 'weapon', action: 'drop', ...d, vx: +m.vx || 0, vy: +m.vy || 0, vz: +m.vz || 0, fromId: id }, id);
        } else if (m.action === 'rest') {
          const d = drops.get(wid);
          if (!d) break;
          d.x = +m.x || 0; d.y = +m.y || 0; d.z = +m.z || 0; d.ry = +m.ry || 0;
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
        // 20Hz positional snapshot — stored, rebroadcast in bulk (never echoed back)
        client.state = {
          id,
          x: +m.x || 0, y: +m.y || 0, z: +m.z || 0,
          yaw: +m.yaw || 0, pitch: +m.pitch || 0,
          hp: Math.max(0, Math.min(100, +m.hp || 100)),
          alive: !!m.alive,
          weapon: String(m.weapon || 'deagle').slice(0, 12),
          aiming: !!m.aiming,
          moving: !!m.moving,
          crouch: !!m.crouch,                      // crouched hull / lowered hitbox
          gnd: m.gnd !== false,                    // standing on ground or a box top
          wr: Math.max(-1, Math.min(1, m.wr | 0)), // wall run: -1 wall on left, 1 right, 0 none
          dual: !!m.dual,                          // dual wielding the current weapon
        };
        break;
      }
      case 'round':
        // a new round wipes the floor (keep anything dropped in the last 2s — it belongs to the new round)
        if (m.action === 'start') { const now = Date.now(); for (const [k, d] of drops) if (now - d.at > 2000) drops.delete(k); }
        m.fromId = id; m.fromName = client.name; m.fromTeam = client.team;
        broadcast(m, id);
        break;
      case 'shot':
      case 'hit':
      case 'killed':
      case 'bomb':
      case 'nade':
      case 'chat': {
        // Relay gameplay events to everyone else; stamp sender id.
        m.fromId = id;
        m.fromName = client.name;
        m.fromTeam = client.team;
        broadcast(m, id);
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
    if (!clients.size) drops.clear();
    console.log(`[-] client ${id} left (${clients.size} online)`);
    broadcast({ type: 'player_left', id, realPlayers: clients.size });
    broadcast({ type: 'roster', players: roster(), realPlayers: clients.size });
  });

  ws.on('error', () => { try { ws.close(); } catch {} });
});

// 15Hz snapshot broadcast — the only per-frame server work.
setInterval(() => {
  if (!clients.size) return;
  const players = [];
  for (const c of clients.values()) {
    if (!c.state) continue;
    players.push({ ...c.state, name: c.name, team: c.team });
  }
  if (!players.length) return;
  const msg = JSON.stringify({ type: 'snapshot', players, realPlayers: clients.size, t: Date.now() });
  for (const c of clients.values()) {
    if (c.ws.readyState === 1) c.ws.send(msg);
  }
}, 1000 / 15);

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
    console.log(`HTML5-CS server on http://localhost:${actual}  (ws://localhost:${actual}/ws)`);
    console.log('Rule: clients disable bots when 2+ real players are online.');
  };
  const wrappedErr = (err) => {
    server.removeListener('listening', onListen);
    onErr(err);
  };
  server.once('error', wrappedErr);
  server.once('listening', onListen);
  server.listen(port);
}
listenOn(PORT);
