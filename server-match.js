// server-match.js — AGENTS: Server-authoritative match flow for online PvP (not served to browsers).
// Ownership: round phases + timers, score, per-player alive/K/D/A, bomb carrier/plant/defuse/explode, team balance.
//
// Active whenever 2+ players with a team are connected. Clients never decide rounds:
// they send requests (bomb plant/defuse/pickup) and death reports ('killed' / state
// alive=false), and render whatever the server broadcasts. A late joiner receives the
// full state in 'welcome', so round, score, clocks and bomb are right immediately.
//
// s->c  match { active, id, roundId, round, phase, score, freezeLeft, buyLeft, roundLeft, postLeft,
//               site, winner, reason, event, maxWins, bomb{...}, players[{id,name,team,alive,kills,deaths,assists}] }
//       bomb  { srv:1, action: plant|defuse|drop|pickup|explode|fuse|deny, ... }
// Times are milliseconds remaining at send time, so no clock sync is needed.

import {
  BOMB_DEFUSE_TIME, BOMB_PLANT_TIME, BOMB_TIMER, BUY_TIME, FREEZE_TIME, ROUNDS_TO_WIN_MATCH, ROUND_TIME, SITES,
} from './js/config.js';

const POST_ROUND_MS = 4000;   // round-end banner before the next freeze
const MATCH_OVER_MS = 10000;  // end screen before a fresh match
const FAST_FUSE_MS = 2500;    // all CTs dead after plant: bomb goes early
const HOLD_SLACK_MS = 700;    // network jitter allowance for plant/defuse hold times
const MIN_PLAYERS = 2;

export function createMatch({ clients, broadcast, send, onRoundStart }) {
  const M = {
    active: false, id: 0, roundId: 0, round: 0, phase: 'waiting',
    score: { ct: 0, t: 0 }, freezeEnd: 0, buyEnd: 0, roundEnd: 0, postEnd: 0, overEnd: 0,
    site: 'A', winner: null, reason: '', bomb: freshBomb(),
  };
  function freshBomb() {
    return { carrierId: null, planted: false, site: null, x: 0, z: 0, explodeAt: 0, dropped: null,
      exploded: false, defused: false, fastFused: false, plantHold: null, defuseHold: null };
  }
  const teamed = () => [...clients.values()].filter((c) => c.team === 'ct' || c.team === 't');
  const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
  // Last-damage ledger: victimId -> [{by, at}]. Server stamps hit senders,
  // so killerId claims can be checked against who actually hit the victim.
  const dmgLog = new Map(); // victimId -> [{by, at}]
  function noteHit(victimId, attackerId) {
    if (!Number.isInteger(victimId) || !Number.isInteger(attackerId)) return;
    if (victimId === attackerId) return;
    const now = Date.now();
    let a = dmgLog.get(victimId);
    if (!a) { a = []; dmgLog.set(victimId, a); }
    a.push({ by: attackerId, at: now });
    while (a.length && now - a[0].at > 5000) a.shift();
    if (a.length > 12) a.splice(0, a.length - 12);
  }
  function recentHitters(victimId) {
    const now = Date.now();
    const a = dmgLog.get(victimId) || [];
    while (a.length && now - a[0].at > 5000) a.shift();
    return a;
  }

  function state(event) {
    const now = Date.now(), b = M.bomb;
    return {
      type: 'match', event: event || 'sync', active: M.active, id: M.id, roundId: M.roundId, round: M.round,
      phase: M.phase, score: { ct: M.score.ct, t: M.score.t }, maxWins: ROUNDS_TO_WIN_MATCH,
      freezeLeft: Math.max(0, M.freezeEnd - now), buyLeft: Math.max(0, M.buyEnd - now),
      roundLeft: Math.max(0, M.roundEnd - now), postLeft: Math.max(0, (M.phase === 'over' ? M.overEnd : M.postEnd) - now),
      site: M.site, winner: M.winner, reason: M.reason,
      bomb: {
        carrierId: b.carrierId, planted: b.planted, site: b.site, x: b.x, z: b.z, exploded: b.exploded, defused: b.defused,
        explodeIn: b.planted ? Math.max(0, b.explodeAt - now) : 0, dropped: b.dropped ? { x: b.dropped.x, z: b.dropped.z } : null,
      },
      players: teamed().map((c) => ({ id: c.id, name: c.name, team: c.team, alive: !!c.mAlive, kills: c.kills | 0, deaths: c.deaths | 0, assists: c.assists | 0 })),
    };
  }
  const push = (event) => broadcast(state(event));

  function resetStats(c) { c.kills = 0; c.deaths = 0; c.assists = 0; }

  // Keep teams within one player of each other; newest joiners move first.
  function balanceTeams() {
    const list = teamed().sort((a, b) => b.id - a.id);
    for (;;) {
      const ct = list.filter((c) => c.team === 'ct'), t = list.filter((c) => c.team === 't');
      if (Math.abs(ct.length - t.length) <= 1) break;
      const from = ct.length > t.length ? ct : t;
      from[0].team = from[0].team === 'ct' ? 't' : 'ct';
      send(from[0].ws, { type: 'team', team: from[0].team });
    }
  }

  function startMatch() {
    M.active = true; M.id++; M.round = 0; M.score = { ct: 0, t: 0 };
    for (const c of teamed()) resetStats(c);
    startRound();
  }
  function stopMatch() {
    M.active = false; M.phase = 'waiting'; M.round = 0; M.score = { ct: 0, t: 0 };
    M.bomb = freshBomb(); M.winner = null; M.reason = '';
    push('stopped');
  }
  function startRound() {
    const now = Date.now();
    M.round++; M.roundId++;
    balanceTeams();
    for (const c of teamed()) c.mAlive = true;
    M.phase = 'freeze'; M.winner = null; M.reason = '';
    M.freezeEnd = now + FREEZE_TIME * 1000;
    M.buyEnd = now + BUY_TIME * 1000;
    M.roundEnd = M.freezeEnd + ROUND_TIME * 1000;
    M.site = Math.random() < 0.5 ? 'A' : 'B';
    M.bomb = freshBomb();
    const ts = teamed().filter((c) => c.team === 't');
    if (ts.length) M.bomb.carrierId = ts[(Math.random() * ts.length) | 0].id;
    try { onRoundStart && onRoundStart(); } catch {}
    push('round_start');
  }
  function endRound(winner, reason) {
    if (M.phase !== 'freeze' && M.phase !== 'live') return;
    if (winner === 'ct') M.score.ct++; else if (winner === 't') M.score.t++;
    M.winner = winner; M.reason = reason || '';
    M.bomb.plantHold = null; M.bomb.defuseHold = null;
    if (M.score.ct >= ROUNDS_TO_WIN_MATCH || M.score.t >= ROUNDS_TO_WIN_MATCH) {
      M.phase = 'over'; M.overEnd = Date.now() + MATCH_OVER_MS;
      push('match_over');
    } else {
      M.phase = 'post'; M.postEnd = Date.now() + POST_ROUND_MS;
      push('round_end');
    }
  }
  function aliveCounts() {
    let ct = 0, t = 0;
    for (const c of teamed()) if (c.mAlive) { if (c.team === 'ct') ct++; else t++; }
    return { ct, t };
  }
  function checkRoundEnd() {
    if (!M.active || (M.phase !== 'freeze' && M.phase !== 'live')) return;
    const { ct, t } = aliveCounts();
    const b = M.bomb;
    if (b.planted) {
      // CTs must still defuse even if every T is dead; no CTs left = bomb goes early.
      if (ct <= 0 && !b.fastFused) {
        b.fastFused = true;
        b.explodeAt = Math.min(b.explodeAt, Date.now() + FAST_FUSE_MS);
        broadcast({ type: 'bomb', srv: 1, action: 'fuse', explodeIn: Math.max(0, b.explodeAt - Date.now()) });
      }
      return;
    }
    if (t <= 0 && ct <= 0) endRound('draw', 'BOTH TEAMS WIPED');
    else if (t <= 0) endRound('ct', 'T WIPED');
    else if (ct <= 0) endRound('t', 'CT WIPED');
  }

  function dropBomb(c) {
    const b = M.bomb;
    if (b.carrierId !== c.id || b.planted) return;
    const p = c.lastPos || { x: 0, z: 0 };
    b.carrierId = null; b.dropped = { x: p.x, z: p.z }; b.plantHold = null;
    broadcast({ type: 'bomb', srv: 1, action: 'drop', byId: c.id, byName: c.name, x: p.x, z: p.z });
  }

  // Victim-reported death (or state alive=false). Idempotent: only the first report counts.
  function markDead(c, killerId, assistId) {
    if (!M.active || !c.mAlive || M.phase === 'waiting') return false;
    c.mAlive = false;
    c.deaths = (c.deaths | 0) + 1;
    const killer = killerId != null ? clients.get(killerId) : null;
    if (killer && killer !== c && killer.team && killer.team !== c.team) killer.kills = (killer.kills | 0) + 1;
    const assister = assistId != null ? clients.get(assistId) : null;
    if (assister && assister !== killer && assister !== c && assister.team && assister.team !== c.team) assister.assists = (assister.assists | 0) + 1;
    dropBomb(c);
    if (M.bomb.plantHold && M.bomb.plantHold.id === c.id) M.bomb.plantHold = null;
    if (M.bomb.defuseHold && M.bomb.defuseHold.id === c.id) M.bomb.defuseHold = null;
    checkRoundEnd();
    if (M.phase !== 'post' && M.phase !== 'over') push('death');
    return true;
  }

  function explode() {
    const b = M.bomb;
    b.exploded = true; b.planted = false;
    broadcast({ type: 'bomb', srv: 1, action: 'explode', x: b.x, z: b.z, site: b.site });
    endRound('t', '💥 BOMB DETONATED');
  }

  function handleBomb(c, m) {
    if (!M.active || !c.team) return;
    const now = Date.now(), b = M.bomb;
    const p = c.lastPos;
    const deny = (what) => send(c.ws, { type: 'bomb', srv: 1, action: 'deny', what });
    switch (m.action) {
      case 'plant_start':
        if (M.phase === 'live' && c.mAlive && c.team === 't' && b.carrierId === c.id && !b.planted) {
          // Must stand near a site to start planting (lastPos is server-stamped from state).
          if (!p) { deny('plant_start'); break; }
          const near = SITES.some((s) => dist2(p.x, p.z, s.x, s.z) <= s.r + 4);
          if (!near) { deny('plant_start'); break; }
          b.plantHold = { id: c.id, at: now };
        }
        break;
      case 'plant_stop':
        if (b.plantHold && b.plantHold.id === c.id) b.plantHold = null;
        break;
      case 'defuse_start':
        if (M.phase === 'live' && c.mAlive && c.team === 'ct' && b.planted) {
          // Must stand next to the planted bomb to start defusing (<4m XZ).
          if (!p || dist2(p.x, p.z, b.x, b.z) > 4) { deny('defuse_start'); break; }
          b.defuseHold = { id: c.id, at: now };
        }
        break;
      case 'defuse_stop':
        if (b.defuseHold && b.defuseHold.id === c.id) b.defuseHold = null;
        break;
      case 'plant': {
        const site = SITES.find((s) => s.name === m.site);
        const held = b.plantHold && b.plantHold.id === c.id && now - b.plantHold.at >= BOMB_PLANT_TIME * 1000 - HOLD_SLACK_MS;
        let x = +m.x, z = +m.z;
        if (!Number.isFinite(x + z) || !p || dist2(x, z, p.x, p.z) > 2.5) { x = p ? p.x : NaN; z = p ? p.z : NaN; }
        if (M.phase !== 'live' || b.planted || b.carrierId !== c.id || !c.mAlive || c.team !== 't' || !site || !held
          || !Number.isFinite(x + z) || dist2(x, z, site.x, site.z) > site.r + 1) { deny('plant'); break; }
        Object.assign(b, { planted: true, site: site.name, x, z, explodeAt: now + BOMB_TIMER * 1000, carrierId: null, dropped: null, plantHold: null });
        broadcast({ type: 'bomb', srv: 1, action: 'plant', byId: c.id, byName: c.name, site: site.name, x, z, explodeIn: BOMB_TIMER * 1000 });
        checkRoundEnd(); // planting with no CTs alive starts the fast fuse
        push('plant');
        break;
      }
      case 'defuse': {
        const held = b.defuseHold && b.defuseHold.id === c.id && now - b.defuseHold.at >= BOMB_DEFUSE_TIME * 1000 - HOLD_SLACK_MS;
        if (M.phase !== 'live' || !b.planted || b.exploded || now >= b.explodeAt || !c.mAlive || c.team !== 'ct' || !held
          || !p || dist2(p.x, p.z, b.x, b.z) > 3.6) { deny('defuse'); break; }
        b.planted = false; b.defused = true; b.defuseHold = null;
        broadcast({ type: 'bomb', srv: 1, action: 'defuse', byId: c.id, byName: c.name });
        endRound('ct', `BOMB DEFUSED BY ${c.name}`);
        break;
      }
      case 'pickup': {
        if ((M.phase !== 'live' && M.phase !== 'freeze') || b.planted || !b.dropped || !c.mAlive || c.team !== 't'
          || !p || dist2(p.x, p.z, b.dropped.x, b.dropped.z) > 2.6) { deny('pickup'); break; }
        b.dropped = null; b.carrierId = c.id;
        broadcast({ type: 'bomb', srv: 1, action: 'pickup', byId: c.id, byName: c.name });
        push('pickup');
        break;
      }
      default: break;
    }
  }

  function tick() {
    if (!M.active) return;
    const now = Date.now();
    if (M.phase === 'freeze' && now >= M.freezeEnd) { M.phase = 'live'; push('live'); }
    if (M.phase === 'live') {
      if (M.bomb.planted) { if (now >= M.bomb.explodeAt) explode(); }
      else if (now >= M.roundEnd) endRound('ct', 'TIME — CT WINS');
    } else if (M.phase === 'post' && now >= M.postEnd) startRound();
    else if (M.phase === 'over' && now >= M.overEnd) startMatch();
  }
  setInterval(tick, 50);

  function checkActive() {
    const n = teamed().length;
    if (!M.active && n >= MIN_PLAYERS) startMatch();
    else if (M.active && n < MIN_PLAYERS) stopMatch();
  }

  return {
    state,
    get active() { return M.active; },
    join(c) {
      resetStats(c);
      // Freeze time is still "before the round": you get to play it. Later you spectate until next round.
      c.mAlive = !M.active || M.phase === 'freeze';
      checkActive();
      if (M.active) push('join');
    },
    leave(c) {
      if (M.active) {
        c.mAlive = false;
        dropBomb(c);
        if (M.bomb.plantHold && M.bomb.plantHold.id === c.id) M.bomb.plantHold = null;
        if (M.bomb.defuseHold && M.bomb.defuseHold.id === c.id) M.bomb.defuseHold = null;
      }
      checkActive();
      if (M.active) { checkRoundEnd(); push('leave'); }
    },
    // Called with every accepted state packet. Returns the alive flag to relay to others.
    // rid = the round the client believed it was in; stale packets from last round never kill you.
    onState(c, alive, rid) {
      if (!M.active) return alive;
      if (c.mAlive && !alive && rid === M.roundId) markDead(c, null, null);
      return alive && !!c.mAlive;
    },
    onKilled(c, m) {
      if (m.rid !== M.roundId) return false;
      let kid = Number.isInteger(m.killerId) ? m.killerId : null;
      let aid = Number.isInteger(m.assistId) ? m.assistId : null;
      // Victim-supplied ids are untrusted: only credit hitters the server saw via 'hit'.
      const hits = recentHitters(c.id);
      const byIds = new Set(hits.map((h) => h.by));
      if (kid !== null && !byIds.has(kid)) kid = null; // forged killer — no credit, death still counts
      if (aid !== null && (aid === kid || !byIds.has(aid))) aid = null;
      // Overwrite client-supplied names/teams with server truth (set by caller in server.js too).
      dmgLog.delete(c.id);
      return markDead(c, kid, aid);
    },
    noteHit,
    handleBomb,
    sync() { if (M.active) push('sync'); },
  };
}
