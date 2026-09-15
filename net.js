// HTML5-CS client net layer — WebSocket relay protocol.
// No three.js here: main.js owns all meshes and passes snapshots through.
// Protocol (JSON, see server.js):
//   c->s: hello{name,wantTeam} | state{...30Hz, ct=sender clock} | shot | hit | killed | bomb | round | nade | chat | ping
//   s->c: welcome | roster | player_joined | player_left | snapshot (relayed instantly per state + 1Hz full) | shot|hit|killed|bomb|round|nade|chat
//
// Smoothness: every remote keeps a short buffer of timestamped states (stamped with the
// SENDER's clock, so relay/network jitter never distorts the motion) and is rendered a
// small, adaptive delay in the past with linear interpolation (Source-engine style).

export const Net = {
  ws: null,
  url: null,
  connected: false,
  id: null,
  team: null,
  name: 'YOU',
  realPlayers: 1,          // includes self once connected
  remotes: new Map(),      // id -> {id,name,team,x,y,z,yaw,pitch,hp,alive,weapon,aiming,moving,crouch,gnd,wr,lastSeen}
  handlers: {},            // event -> [fn]
  _sendAt: 0,
  _pingAt: 0,
  _lastAlive: null,
  sendHz: 30,              // outgoing state rate
  rtt: 0,                  // smoothed round-trip time to server (ms)
  _pingTimer: null,

  on(evt, fn) {
    (this.handlers[evt] = this.handlers[evt] || []).push(fn);
    return () => { this.handlers[evt] = this.handlers[evt].filter((f) => f !== fn); };
  },
  emit(evt, data) {
    const list = this.handlers[evt];
    if (list) for (const fn of list) { try { fn(data); } catch (e) { console.warn('[net]', evt, e); } }
  },

  get active() { return this.connected && !!this.ws; },
  // Core rule: when real players share the server, bots go away (pure PvP).
  get hasRealOpponents() {
    if (!this.active) return false;
    // remotes.size > 0 means at least one other human is online.
    return this.remotes.size > 0;
  },
  remoteList() { return [...this.remotes.values()]; },
  remoteEnemies(myTeam) { return this.remoteList().filter((r) => r.team !== myTeam && r.alive); },

  connect(url, name, wantTeam) {
    this.disconnect();
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      this.url = url;
      this.name = (name || 'Player').slice(0, 16);
      let settled = false;
      const to = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error('connect timeout')); } }, 6000);

      ws.onopen = () => {
        this.ws = ws;
        clearInterval(this._pingTimer);
        this.rtt = 0;
        this._ping();
        this._pingTimer = setInterval(() => this._ping(), 2000);
        ws.send(JSON.stringify({ type: 'hello', name: this.name, wantTeam: wantTeam || 'auto' }));
      };
      ws.onmessage = (ev) => this._onMessage(ev.data, resolve, settled, (v) => { settled = v; }, to);
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(to); reject(new Error('websocket error')); } this.emit('error'); };
      ws.onclose = () => {
        clearTimeout(to);
        if (this.ws && this.ws !== ws) return; // an old socket closing after a reconnect
        clearInterval(this._pingTimer);
        const was = this.connected;
        this.connected = false; this.ws = null; this.id = null;
        this.remotes.clear();
        this.emit('disconnect');
        if (was) this.emit('roster', { players: [], realPlayers: 0 });
        if (!settled) { settled = true; reject(new Error('connection closed')); }
      };
    });
  },

  _onMessage(raw, resolve, settled, setSettled, to) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case 'welcome': {
        this.id = m.id; this.team = m.team; this.connected = true;
        this.realPlayers = m.realPlayers || 1;
        if (!settled) { setSettled(true); clearTimeout(to); resolve({ id: m.id, team: m.team }); }
        this.emit('welcome', m);
        this.emit('roster', { players: m.players || [], realPlayers: this.realPlayers });
        break;
      }
      case 'roster': {
        this.realPlayers = m.realPlayers || (this.remotes.size + 1);
        this._syncRoster(m.players || []);
        this.emit('roster', m);
        break;
      }
      case 'player_joined': {
        if (m.id !== this.id && !this.remotes.has(m.id)) {
          this.remotes.set(m.id, {
            id: m.id, name: m.name || `Player${m.id}`, team: m.team || 't',
            x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, alive: true,
            weapon: 'ak', aiming: false, moving: false, crouch: false, gnd: true, wr: 0, dual: false, lastSeen: performance.now(), ping: 0,
          });
        }
        this.realPlayers = m.realPlayers || (this.remotes.size + 1);
        this.emit('player_joined', m);
        this.emit('roster', { players: null, realPlayers: this.realPlayers });
        break;
      }
      case 'player_left': {
        this.remotes.delete(m.id);
        this.realPlayers = m.realPlayers || (this.remotes.size + 1);
        this.emit('player_left', m);
        this.emit('roster', { players: null, realPlayers: this.realPlayers });
        break;
      }
      case 'snapshot': {
        this.realPlayers = m.realPlayers || this.realPlayers;
        const now = performance.now();
        for (const p of (m.players || [])) {
          if (p.id === this.id) continue;
          let r = this.remotes.get(p.id);
          if (!r) {
            r = { id: p.id, name: p.name || `Player${p.id}`, team: p.team || 't', lastSeen: now, ping: 0 };
            this.remotes.set(p.id, r);
            this.emit('player_joined', { id: p.id, name: r.name, team: r.team });
          }
          r.lastSeen = now;
          if (p.ping !== undefined && p.ping !== null) {
            const pg = Math.round(+p.ping);
            if (isFinite(pg) && pg >= 0) r.ping = Math.min(9999, pg);
          }
          // Same state again (1Hz keepalive) or an out-of-order packet: nothing new.
          const ct = +p.ct || 0;
          if (ct && r.lastCt && ct <= r.lastCt) continue;
          if (ct) r.lastCt = ct;
          Object.assign(r, {
            name: p.name || r.name, team: p.team || r.team,
            x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
            hp: p.hp, alive: p.alive, weapon: p.weapon,
            aiming: !!p.aiming, moving: !!p.moving,
            crouch: !!p.crouch, gnd: p.gnd !== false, wr: p.wr | 0, dual: !!p.dual,
          });
          this._pushSample(r, ct || now, now, p);
        }
        // Prune stale remotes (>4s without snapshot and not in roster)
        for (const [id, r] of this.remotes) {
          if (now - r.lastSeen > 4000) { this.remotes.delete(id); this.emit('player_left', { id }); }
        }
        this.emit('snapshot', m);
        break;
      }
      case 'shot': this.emit('shot', m); break;
      case 'hit': this.emit('hit', m); break;
      case 'killed': this.emit('killed', m); break;
      case 'bomb': this.emit('bomb', m); break;
      case 'round': this.emit('round', m); break;
      case 'round_echo': this.emit('round_echo', m); break;
      case 'nade': this.emit('nade', m); break;
      case 'weapon': this.emit('weapon', m); break;
      case 'chat': this.emit('chat', m); break;
      case 'pong': {
        const sample = performance.now() - (+m.t || 0);
        if (sample >= 0 && sample < 5000) this.rtt = this.rtt ? this.rtt + (sample - this.rtt) * 0.3 : sample;
        this.emit('pong', m);
        break;
      }
      default: break;
    }
  },

  _ping() { this._send({ type: 'ping', t: performance.now() }); },

  // ---- snapshot interpolation ----
  _pushSample(r, ct, now, p) {
    if (!r.buf) { r.buf = []; r.off = now - ct; r.jit = 0; }
    // Clock offset between the sender's clock and ours. Track the fastest arrival
    // (lowest offset) and let it creep upward slowly so clock drift is absorbed.
    const off = now - ct;
    if (off < r.off) r.off = off; else r.off += (off - r.off) * 0.01;
    r.jit += (Math.min(250, off - r.off) - r.jit) * 0.1; // lateness EWMA = jitter
    const s = { t: ct, x: +p.x || 0, y: +p.y || 0, z: +p.z || 0, yaw: +p.yaw || 0, pitch: +p.pitch || 0 };
    const last = r.buf[r.buf.length - 1];
    // Teleport (respawn / round reset): don't slide across the map.
    if (last && (Math.abs(s.x - last.x) + Math.abs(s.z - last.z) > 6 || Math.abs(s.y - last.y) > 4)) { r.buf.length = 0; s.snap = true; }
    r.buf.push(s);
    if (r.buf.length > 40) r.buf.splice(0, r.buf.length - 40);
  },

  // Interpolation delay: ~1.5 send intervals plus measured jitter, clamped.
  interpDelay(r) {
    const base = 1000 / this.sendHz * 1.5;
    return Math.max(base, Math.min(250, base + (r && r.jit ? r.jit * 2 : 0)));
  },

  // Returns {x,y,z,yaw,pitch} for remote r at local time `now` (performance.now()).
  sample(r, now, out = {}) {
    const buf = r.buf;
    if (!buf || !buf.length) {
      out.x = r.x || 0; out.y = r.y || 0; out.z = r.z || 0; out.yaw = r.yaw || 0; out.pitch = r.pitch || 0;
      return out;
    }
    const rt = now - r.off - this.interpDelay(r); // render time in the sender's clock
    // drop samples that are fully in the past (keep one before rt)
    while (buf.length > 2 && buf[1].t <= rt) buf.shift();
    const a = buf[0], b = buf[1];
    if (!b || rt <= a.t) { // single sample, or render time before the buffer: hold
      out.x = a.x; out.y = a.y; out.z = a.z; out.yaw = a.yaw; out.pitch = a.pitch;
      return out;
    }
    if (rt > b.t) {
      // Buffer ran dry (late packet): extrapolate up to 100ms along the last segment, then hold.
      const k = 1 + Math.min(rt - b.t, 100) / Math.max(1, b.t - a.t);
      out.x = a.x + (b.x - a.x) * k; out.y = a.y + (b.y - a.y) * k; out.z = a.z + (b.z - a.z) * k;
      if (b.snap) { out.x = b.x; out.y = b.y; out.z = b.z; }
      out.yaw = b.yaw; out.pitch = b.pitch;
      return out;
    }
    const k = Math.max(0, Math.min(1, (rt - a.t) / Math.max(1, b.t - a.t)));
    out.x = a.x + (b.x - a.x) * k; out.y = a.y + (b.y - a.y) * k; out.z = a.z + (b.z - a.z) * k;
    let dy = b.yaw - a.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
    out.yaw = a.yaw + dy * k;
    out.pitch = a.pitch + (b.pitch - a.pitch) * k;
    return out;
  },

  _syncRoster(players) {
    // Remove remotes that the server no longer lists (clean disconnects).
    if (!players || !players.length) return;
    const ids = new Set(players.map((p) => p.id));
    for (const id of [...this.remotes.keys()]) {
      if (id !== this.id && !ids.has(id)) {
        this.remotes.delete(id);
        this.emit('player_left', { id });
      }
    }
    for (const p of players) {
      if (p.id === this.id) continue;
      if (!this.remotes.has(p.id)) {
        this.remotes.set(p.id, {
          id: p.id, name: p.name, team: p.team,
          x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, alive: true,
          weapon: 'ak', aiming: false, moving: false, crouch: false, gnd: true, wr: 0, dual: false, lastSeen: performance.now(), ping: 0,
        });
        this.emit('player_joined', p);
      } else {
        const r = this.remotes.get(p.id);
        r.name = p.name; r.team = p.team;
      }
    }
  },

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch {}
    }
  },

  // main.js calls this every frame; the gate keeps it at sendHz. Life/death changes
  // go out immediately so nobody sees a corpse still running.
  sendState(s) {
    const now = performance.now();
    const aliveChanged = this._lastAlive !== null && this._lastAlive !== !!s.alive;
    if (!aliveChanged && now - this._sendAt < 1000 / this.sendHz - 1) return;
    this._sendAt = now; this._lastAlive = !!s.alive;
    const r3 = (v) => Math.round((+v || 0) * 1000) / 1000;
    this._send({
      type: 'state', ...s, ct: Math.round(now * 10) / 10,
      x: r3(s.x), y: r3(s.y), z: r3(s.z), yaw: Math.round((+s.yaw || 0) * 1e4) / 1e4, pitch: Math.round((+s.pitch || 0) * 1e4) / 1e4,
      ping: Math.max(0, Math.min(9999, Math.round(this.rtt) || 0)),
    });
  },
  sendShot(shot) { this._send({ type: 'shot', ...shot }); },
  sendHit(hit) { this._send({ type: 'hit', ...hit }); },
  sendKilled(k) { this._send({ type: 'killed', ...k }); },
  sendBomb(b) { this._send({ type: 'bomb', ...b }); },
  sendRound(r) { this._send({ type: 'round', ...r }); },
  sendNade(n) { this._send({ type: 'nade', ...n }); },
  sendWeapon(w) { this._send({ type: 'weapon', ...w }); },
  sendChat(text) { this._send({ type: 'chat', text: String(text).slice(0, 200) }); },

  disconnect() {
    clearInterval(this._pingTimer); this.rtt = 0; this._lastAlive = null;
    try { if (this.ws) this.ws.close(); } catch {}
    this.ws = null; this.connected = false; this.id = null;
    this.remotes.clear();
  },
};
