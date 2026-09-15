// HTML5-CS client net layer — WebSocket relay protocol.
// No three.js here: main.js owns all meshes and passes snapshots through.
// Protocol (JSON, see server.js):
//   c->s: hello{name,wantTeam} | state{...20Hz} | shot | hit | killed | bomb | round | nade | chat | ping
//   s->c: welcome | roster | player_joined | player_left | snapshot@15Hz | shot|hit|killed|bomb|round|nade|chat

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
        ws.send(JSON.stringify({ type: 'hello', name: this.name, wantTeam: wantTeam || 'auto' }));
      };
      ws.onmessage = (ev) => this._onMessage(ev.data, resolve, settled, (v) => { settled = v; }, to);
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(to); reject(new Error('websocket error')); } this.emit('error'); };
      ws.onclose = () => {
        clearTimeout(to);
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
            weapon: 'ak', aiming: false, moving: false, crouch: false, gnd: true, wr: 0, dual: false, lastSeen: performance.now(),
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
            r = { id: p.id, name: p.name || `Player${p.id}`, team: p.team || 't', lastSeen: now };
            this.remotes.set(p.id, r);
            this.emit('player_joined', { id: p.id, name: r.name, team: r.team });
          }
          Object.assign(r, {
            name: p.name || r.name, team: p.team || r.team,
            x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
            hp: p.hp, alive: p.alive, weapon: p.weapon,
            aiming: !!p.aiming, moving: !!p.moving,
            crouch: !!p.crouch, gnd: p.gnd !== false, wr: p.wr | 0, dual: !!p.dual, lastSeen: now,
          });
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
      case 'nade': this.emit('nade', m); break;
      case 'weapon': this.emit('weapon', m); break;
      case 'chat': this.emit('chat', m); break;
      case 'pong': this.emit('pong', m); break;
      default: break;
    }
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
          weapon: 'ak', aiming: false, moving: false, crouch: false, gnd: true, wr: 0, dual: false, lastSeen: performance.now(),
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

  // Throttled to ~20Hz by main.js calling each frame; internal gate keeps rate.
  sendState(s) {
    const now = performance.now();
    if (now - this._sendAt < 50) return;
    this._sendAt = now;
    this._send({ type: 'state', ...s });
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
    try { if (this.ws) this.ws.close(); } catch {}
    this.ws = null; this.connected = false; this.id = null;
    this.remotes.clear();
  },
};
