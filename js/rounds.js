// js/rounds.js — AGENTS: Match/round flow: start/end round & match, win checks, round timers, server match state apply (online), pause/resume.
// Ownership: startMatch, startRound, checkRoundEnd, endRound, endMatch, updateRoundTimers, applyMatchState, pauseGame, resumeGame, lockPointer.
// Online with 2+ players the server (server-match.js) decides everything; this file only renders its 'match' state.

import { beginRoundReport } from './dmgreport.js';
import { Net } from '../net.js';
import { AudioSys } from './audio.js';
import {
  BUY_TIME, FREEZE_TIME, MONEY_DRAW, MONEY_LOSS, MONEY_START, MONEY_WIN, ROUNDS_TO_WIN_MATCH,
  ROUND_TIME, SLOT_ORDER, isNadeKey,
} from './config.js';
import { $ } from './utils.js';
import { BOMB, bombResetRound, explodeBomb, syncBombFromServer, updateInteractHUD } from './bomb.js';
import { resetBot } from './bots.js';
import { buyCursorSync, toggleBuy, updateBuyTimer } from './buymenu.js';
import {
  clearDecals, debrisChunks, particles, shockwaves, smokes, tracers, worldFlashes,
} from './effects.js';
import { clearGibs } from './gibs.js';
import { clearNades } from './grenades.js';
import { announce, announceRoundEnd, updateHUD } from './hud.js';
import { setRmbDown } from './input.js';
import { clearBotsForMP, isMultiplayer, isOnline, isServerMatch, killCoilLights, remotes } from './multiplayer.js';
import { clearWorldWeapons, setPickupHint } from './pickups.js';
import { resetWeed } from './weed.js';
import { resetYaris } from './yaris.js';
import { resetPlayerBody } from './playerbody.js';
import { coilLight, renderer, scene } from './render.js';
import { mySpawnSlot, spawnList, spawnPoint, spawnYawMesh, spawnYawPlayer } from './spawns.js';
import { G, addMoney, bots, isFreeze, keys, newLoadout, player } from './state.js';
import { spectateCurrent, updateSpectateOverlay } from './spectate.js';
import { esc, remoteStats, statsHolder } from './stats.js';
import { buildViewmodel, viewmodel, vmRig } from './viewmodel.js';

export function applyServerScore(m) {
  // Server is score authority: adopt its tally, never diverge on duplicates.
  if (m && m.score && typeof m.score.ct === 'number' && typeof m.score.t === 'number') {
    G.score.ct = m.score.ct; G.score.t = m.score.t;
    try { updateHUD(); } catch {}
  }
}
function applyServerStats(m) {
  for (const p of (m.players || [])) {
    const h = p.id === Net.id ? player : statsHolder('remote:' + p.id);
    if (!h) continue;
    h.kills = p.kills | 0; h.deaths = p.deaths | 0; h.assists = p.assists | 0;
  }
}
// Deadlines in local performance-seconds; only re-anchor on real drift so clocks never jitter.
function anchorTimers(m) {
  const set = (k, ms) => { const end = Net.deadline(ms); if (!(Math.abs((G.srvT[k] || 0) - end) < 0.25)) G.srvT[k] = end; };
  set('freeze', m.freezeLeft); set('buy', m.buyLeft); set('round', m.roundLeft);
}
// Joined mid-round: no body, no corpse — just spectate until the next round.
function joinAsSpectator() {
  player.alive = false; player.hp = 0; player.spectatorOnly = true; player.hasBomb = false;
  player.cook = null; player.aiming = false; player.specTarget = null;
  if (viewmodel) viewmodel.visible = false;
  $('respawn-killer').textContent = 'JOINED MID-ROUND';
  $('respawn-timer').textContent = 'You spawn next round — spectating for now.';
  $('respawn-overlay').classList.remove('hidden');
  try { spectateCurrent(); updateSpectateOverlay(); } catch {}
}
// Every server 'match' message lands here (event: round_start | live | death | round_end | match_over | sync | join | leave | stopped).
export function applyMatchState(m) {
  if (!m || G.phase === 'menu') return; // not deployed yet — startMatch() reads Net.match
  if (!m.active) {
    // Dropped below 2 players: back to solo practice with bots.
    if (G.srvMatchId) {
      G.srvMatchId = 0; G.srvRoundId = 0; Net.roundId = 0;
      if (G.phase === 'playing' || G.phase === 'over') { startMatch(); announce('WAITING FOR PLAYERS — PRACTICE VS BOTS', 2600); }
    }
    return;
  }
  const me = (m.players || []).find((p) => p.id === Net.id);
  const newMatch = m.id !== G.srvMatchId;
  const newRound = newMatch || m.roundId !== G.srvRoundId;
  if (newMatch) { resetLocalMatch(); G.srvMatchId = m.id; }
  applyServerScore(m);
  applyServerStats(m);
  if (newRound) {
    G.srvRoundId = m.roundId; Net.roundId = m.roundId;
    G.round = m.round | 0 || 1;
    if (me && (me.team === 'ct' || me.team === 't')) player.team = me.team;
    if (m.phase === 'over') {
      if (G.phase !== 'over') endMatch();
      return;
    }
    if (G.phase === 'over') resetLocalMatch(); // server started a new round after the end screen
    startRound(G.round === 1 && newMatch, true);
    anchorTimers(m);
    BOMB.targetSite = m.site === 'B' ? 'B' : 'A';
    syncBombFromServer(m.bomb, true);
    if (me && !me.alive) joinAsSpectator();
    if (m.phase === 'post') { G.roundEnding = true; G.buyLeft = 0; }
  } else {
    anchorTimers(m);
    if (!G.roundEnding) syncBombFromServer(m.bomb, false);
  }
  if ((m.event === 'round_end' || m.event === 'match_over') && G.phase === 'playing') {
    const w = m.winner === 'ct' ? 'ct' : m.winner === 't' ? 't' : 'draw';
    endRound(w, String(m.reason || '').slice(0, 80), true, m.score);
    if (m.event === 'match_over') endMatch();
  }
  try { updateHUD(); } catch {}
}

function aliveCounts() {
  const myTeam = player.team || 'ct';
  let ct = ((player.alive && myTeam === 'ct') ? 1 : 0) + bots.filter((b) => b.alive && b.team === 'ct').length;
  let t = ((player.alive && myTeam === 't') ? 1 : 0) + bots.filter((b) => b.alive && b.team === 't').length;
  try {
    if (isOnline()) {
      for (const r of Net.remoteList()) {
        if (!r.alive) continue;
        if ((r.team || 't') === 'ct') ct++; else t++;
      }
    }
  } catch {}
  return { ct, t };
}
export function isRoundHost() {
  // Lowest net id hosts round flow + bomb timer to keep clients in sync.
  try {
    if (!isOnline() || Net.id == null) return true;
    for (const r of Net.remoteList()) if (r.id < Net.id) return false;
    return true;
  } catch { return true; }
}
// Local match reset (money, loadout, stats, menus). Online the server then supplies round/score.
function resetLocalMatch() {
  AudioSys.stopMusic(0.2);
  G.phase = 'playing'; G.round = 1; G.score = { ct: 0, t: 0 };
  G.kills = 0; G.deaths = 0; G.headshots = 0; G.shots = 0; G.hits = 0;
  G.startTime = performance.now();
  player.money = MONEY_START; player.kills = 0; player.deaths = 0; player.assists = 0;
  player._lastId = null; player._assistId = null;
  try { for (const b of bots) { b.kills = 0; b.deaths = 0; b.assists = 0; b._lastId = null; b._assistId = null; } } catch {}
  try { remoteStats.clear(); } catch {}
  player.armor = 0;
  player.weapons = newLoadout();
  player.cur = 'deagle'; player.last = 'ak';
  $('main-menu').classList.add('hidden');
  $('end-screen').classList.add('hidden');
  $('pause-menu').classList.add('hidden'); G.menuOpen = false;
  $('hud').classList.remove('hidden');
}
export function startMatch() {
  resetLocalMatch();
  G.srvMatchId = 0; G.srvRoundId = 0;
  if (isServerMatch()) applyMatchState(Net.match);
  else startRound(true);
  lockPointer();
}
function startRound(first = false, fromNet = false) {
  const diedLastRound = !first && !player.alive;
  G.roundKills = { ct: 0, t: 0 };
  G.timeLeft = ROUND_TIME; G.buyOpen = false; G.roundEnding = false;
  G.freezeLeft = FREEZE_TIME; G.buyLeft = BUY_TIME;
  try { AudioSys.whistle(); } catch (e) {}
  try { beginRoundReport(); } catch (e) {}
  $('buy-menu').classList.remove('open'); buyCursorSync();
  $('killfeed').innerHTML = '';
  // fresh battlefield: fade out tracers/smoke/debris, wipe decals (blood, holes, scorch)
  try { clearWorldWeapons(); setPickupHint(''); } catch (e) {}
  setRmbDown(false);
  try {
    clearDecals();
    clearNades();
    try { clearGibs(); } catch (e2) {}
    for (const arr of [tracers, particles, smokes, shockwaves, worldFlashes, debrisChunks]) {
      for (const e of arr) { try { scene.remove(e.mesh); } catch (err) {} }
      arr.length = 0;
    }
    try { const fl = $('flash-overlay'); if (fl) fl.style.opacity = 0; } catch (e2) {}
    try { const bo = $('burn-overlay'); if (bo) bo.style.opacity = 0; } catch (e2) {}
  } catch (e) {}
  // CS loadout rules: survivors keep guns/ammo/armor, dead reset to pistol + no armor
  // Nades never carry over — rebuy every round (CS economy).
  player.nades = { he: 0, flash: 0, smoke: 0, molotov: 0, nuke: 0 };
  player.carryingNuke = false; player.nukeArmedAt = 0; player._moveBlocked = false;
  player.cook = null; player.flashUntil = 0; player.flashMax = 0; player.burnT = 0;
  // CS loadout rules: survivors keep guns/ammo/armor, dead reset to pistol + no armor
  if (first || diedLastRound) {
    if (!first) {
      player.weapons = newLoadout();
      player.cur = 'deagle'; player.last = 'ak';
      player.armor = 0;
    }
  }
  // reset actors — team-aware spawns (CT east-central, T west far).
  player.hp = 100;
  player.alive = true; player.reloading = 0; player.spectatorOnly = false;
  try { AudioSys.helixWhine(0); vmRig.helixRate = 0; } catch {}
  try { AudioSys.tarzanLoop(false); } catch {}
  player.specTarget = null;
  player.hasBomb = false;
  player.bloom = 0; player.sprayIdx = 0; player.lastShotT = -9; player.aiming = false;
  vmRig.punchP = 0; vmRig.punchY = 0; vmRig.shake = 0; vmRig.fovKick = 0; vmRig.aimK = 0;
  const spawnTaken = { ct: new Set(), t: new Set() };
  {
    const team = player.team || 'ct', slot = mySpawnSlot();
    spawnTaken[team].add(slot % spawnList(team).length);
    player.pos.copy(spawnPoint(team, slot));
    player.yaw = spawnYawPlayer(team, player.pos);
  }
  player.vel.set(0, 0, 0); player.pitch = 0;
  player.crouching = false; player.crouch = 0; player.exploded = false;
  player.airTuck = false; player.crouchWant = false; player.wallRun = null; player.wallCd = 0; player.lastWallBox = null; player.wallRoll = 0; player.wallLean = 0;
  player.onGround = true;
  try { resetPlayerBody(); } catch (e) { console.warn('player body reset', e); }
  if (!isNadeKey(player.cur) && (!player.weapons[player.cur] || !player.weapons[player.cur].owned)) player.cur = player.weapons.deagle.owned ? 'deagle' : SLOT_ORDER.find((k) => player.weapons[k].owned) || 'deagle';
  if (isNadeKey(player.cur) && (player.nades[player.cur] || 0) <= 0) player.cur = 'deagle';
  buildViewmodel(player.cur);
  if (viewmodel) viewmodel.visible = true;
  if (!isMultiplayer()) { for (const b of bots) { resetBot(b); b.mesh.visible = true; } }
  else { clearBotsForMP(); }
  // scatter bots to their spawns (face center) — skipped in pure PvP.
  if (!isMultiplayer()) {
    // Free slot per bot; CTs prefer the pocket on the side of the site they guard.
    const takeSlot = (team, parity) => {
      const n = spawnList(team).length, taken = spawnTaken[team];
      for (let pass = 0; pass < 2; pass++)
        for (let i = 0; i < n; i++) {
          if (taken.has(i) || (pass === 0 && parity != null && i % 2 !== parity)) continue;
          taken.add(i); return i;
        }
      return taken.size; // more actors than slots: wrap (jitter keeps them apart)
    };
    for (const b of bots) {
      if (!b.alive && !b.mesh.visible) continue;
      const slot = takeSlot(b.team, b.team === 'ct' ? (b.guardSite === 'B' ? 1 : 0) : null);
      b.pos.copy(spawnPoint(b.team, slot));
      b.yaw = spawnYawMesh(b.team, b.pos); b.mesh.rotation.y = b.yaw; b.mesh.position.copy(b.pos);
      if (b.blob) b.blob.position.set(b.pos.x, 0.02, b.pos.z);
    }
  }
  try { for (const [, e] of remotes) { if (e.data) { e.data.alive = true; e.data.hp = 100; } } } catch {}
  try { player._lastId = null; player._assistId = null; for (const b of bots) { b._lastId = null; b._assistId = null; } } catch {}
  try { const sb = $('scoreboard'); if (sb) sb.classList.add('hidden'); } catch {}
  bombResetRound(); // online: the server names the single carrier (syncBombFromServer)
  try { resetWeed(); } catch (e) {}
  try { resetYaris(); } catch (e) {}
  const tSite = BOMB.targetSite || 'A';
  const carrierName = BOMB.carrier ? BOMB.carrier.short : ((player.team === 't' && player.hasBomb) ? (player.name || 'YOU') : 'T');
  $('respawn-overlay').classList.add('hidden');
  if (isMultiplayer()) {
    const n = (Net.realPlayers || (remotes.size + 1));
    announce(first ? `ROUND 1 — PVP - ${n} PLAYERS - NO BOTS (${(player.team || 'ct').toUpperCase()})` : `ROUND ${G.round} — PVP - ${(player.team || 'ct').toUpperCase()} - ${n}P`, 2200);
  } else {
    announce(first ? `ROUND 1 — PISTOL - T PUSH ${tSite} (${carrierName} HAS BOMB)` : `ROUND ${G.round} — T PUSH ${tSite} - HOLD THE SITES`, 2200);
  }
  updateBuyTimer();
  updateHUD();
}
export function checkRoundEnd() {
  if (isServerMatch()) return; // server decides
  if (G.phase !== 'playing' || G.roundEnding || isFreeze()) return;
  const { ct, t } = aliveCounts();
  // Bomb planted changes everything (CS rules):
  // - killing all Ts does NOT win — CTs must still defuse before it blows.
  // - killing all CTs while planted still waits for detonation (handled via quick fuse below).
  if (BOMB.planted) {
    if (ct <= 0 && t <= 0) { // mutual wipe after plant — bomb still blows, T wins.
      explodeBomb(performance.now() / 1000);
      return;
    }
    if (ct <= 0) {
      // No one left to defuse — fast-forward to detonation for pacing (once).
      if (!BOMB._fastFused) {
        BOMB._fastFused = true;
        BOMB.explodeAt = Math.min(BOMB.explodeAt, performance.now() / 1000 + 2.5);
        announce('ALL CT DOWN — BOMB WILL DETONATE', 1800);
      }
      return;
    }
    return; // Ts all dead but bomb ticking — play the defuse!
  }
  if (t <= 0 && ct <= 0) endRound('draw');
  else if (t <= 0) endRound('ct', BOMB.droppedPos ? 'T WIPED — SITE HELD' : 'T WIPED');
  else if (ct <= 0) endRound('t', 'CT WIPED');
}
export function endRound(winner, reason, fromNet = false, serverScore = null) { // 'ct' | 't' | 'draw'
  if (G.phase !== 'playing' || G.roundEnding) return;
  const srv = isServerMatch();
  if (srv && !fromNet) return; // only the server ends rounds online
  G.roundEnding = true;
  if (G.buyOpen) toggleBuy(false);
  player.cook = null;
  updateInteractHUD(null);
  for (const b of bots) { b.planting = false; b.defusing = false; }

  const myTeam = player.team || 'ct';
  let track = null;
  if (serverScore && typeof serverScore.ct === 'number' && typeof serverScore.t === 'number') {
    G.score.ct = serverScore.ct; G.score.t = serverScore.t; // authority already counted it
  }
  else if (winner === 'ct') { G.score.ct++; }
  else if (winner === 't') { G.score.t++; }

  if (winner === 'draw') {
    addMoney(MONEY_DRAW);
    track = AudioSys.roundLose(reason);
    announceRoundEnd(reason || 'ROUND DRAW', '+$' + MONEY_DRAW, track, 3400);
  } else if (winner === myTeam) {
    addMoney(MONEY_WIN);
    track = AudioSys.roundWin(reason);
    announceRoundEnd(reason || 'ROUND WON', '+$' + MONEY_WIN, track, 3400);
  } else {
    addMoney(MONEY_LOSS);
    track = AudioSys.roundLose(reason);
    announceRoundEnd(reason || 'ROUND LOST', '+$' + MONEY_LOSS, track, 3400);
  }
  // bot economy irrelevant
  updateHUD();
  if (srv) return; // next round / match end arrive from the server
  if (G.score.ct >= ROUNDS_TO_WIN_MATCH || G.score.t >= ROUNDS_TO_WIN_MATCH) { endMatch(); return; }
  G.round++;
  setTimeout(() => { if (G.phase === 'playing' && G.roundEnding && !isServerMatch()) startRound(); }, 3800);
}
// CS timers: freeze first (round clock paused), then live; buy window ticks throughout.
// Solo counts down locally; a server match reads the server's deadlines.
export function updateRoundTimers(dt, t) {
  const prevFreeze = G.freezeLeft;
  if (isServerMatch()) {
    G.freezeLeft = Math.max(0, (G.srvT.freeze || 0) - t);
    G.buyLeft = Math.max(0, (G.srvT.buy || 0) - t);
    if (!G.roundEnding) G.timeLeft = BOMB.planted ? 0 : Math.max(0, Math.min(ROUND_TIME, (G.srvT.round || 0) - t));
  } else {
    if (G.freezeLeft > 0) G.freezeLeft = Math.max(0, G.freezeLeft - dt);
    else if (!G.roundEnding) {
      if (BOMB.planted) G.timeLeft = 0; // bomb live — plays to boom/defuse
      else {
        G.timeLeft -= dt;
        if (G.timeLeft <= 0) { G.timeLeft = 0; endRound('ct', 'TIME — CT WINS'); } // defense wins on time
      }
    }
    if (G.buyLeft > 0) G.buyLeft = Math.max(0, G.buyLeft - dt);
  }
  if (prevFreeze > 0 && G.freezeLeft <= 0 && !G.roundEnding) {
    announce('GO GO GO', 900);
    AudioSys.stopMusic(1.5);
    AudioSys.click(880, 0.12, 0.4);
    setTimeout(() => AudioSys.click(1174, 0.14, 0.4), 130);
  }
  if (G.buyLeft <= 0 && G.buyOpen) toggleBuy(false);
}
function endMatch() {
  G.phase = 'over';
  try { AudioSys.helixWhine(0); vmRig.helixRate = 0; } catch {}
  try { AudioSys.tarzanLoop(false); } catch {}
  try { if (coilLight) coilLight.intensity = 0; } catch {}
  try { killCoilLights(); } catch {}
  updateInteractHUD(null);
  for (const b of bots) if (b.alive) b.mesh.visible = true; // unhide first-person spectate target
  if ($('bomb-status')) $('bomb-status').classList.add('hidden');
  document.exitPointerLock && document.exitPointerLock();
  const myTeam = player.team || 'ct';
  const win = myTeam === 't' ? (G.score.t > G.score.ct) : (G.score.ct > G.score.t);
  $('end-title').textContent = win ? '🏆 VICTORY' : '💀 DEFEAT';
  $('end-title').style.color = win ? '#7dff9a' : '#ff6b6b';
  const acc = G.shots ? Math.round((G.hits / G.shots) * 100) : 0;
  const mins = ((performance.now() - G.startTime) / 60000).toFixed(1);
  $('end-sub').textContent = `Final: CT ${G.score.ct} — ${G.score.t} T · ${mins} min` + (isServerMatch() ? ' · next match starts automatically' : '');
  if ($('again-btn')) $('again-btn').classList.toggle('hidden', isServerMatch());
  const track = win ? AudioSys.roundWin('MATCH_WIN') : AudioSys.roundLose('MATCH_LOSS');
  const trackInfo = track ? `<br><span style="color:#ffd76d;font-size:14px;letter-spacing:1px;font-weight:700;">🎵 ${esc(track.title)}</span>` : '';
  $('end-stats').innerHTML = `Kills <b>${G.kills | 0}</b> · Deaths <b>${player.deaths | 0}</b> · Headshots <b>${G.headshots | 0}</b><br>Accuracy <b>${acc | 0}%</b> (${G.hits | 0}/${G.shots | 0}) · Cash <b>$${player.money | 0}</b>${trackInfo}`;
  $('end-screen').classList.remove('hidden');
}
// Online the world can't stop for one player: the menu is an overlay and the game keeps running.
export function pauseGame() {
  if (G.phase !== 'playing') return;
  try { AudioSys.helixWhine(0); } catch {} // never drone under the menu
  try { AudioSys.tarzanLoop(false); } catch {}
  const online = isOnline();
  const title = document.querySelector('#pause-menu h2'), note = document.querySelector('#pause-menu p');
  if (title) title.textContent = online ? 'MENU' : 'PAUSED';
  if (note) note.textContent = online ? 'Online match is still running — you can be shot. Click resume to re-lock pointer.' : 'Mouse released. Click resume to re-lock pointer.';
  if ($('restart-btn')) $('restart-btn').classList.toggle('hidden', online);
  if (online) {
    G.menuOpen = true;
    for (const k in keys) keys[k] = false; // don't keep running forward with the menu open
  } else G.phase = 'paused';
  $('pause-menu').classList.remove('hidden');
}
export function resumeGame() {
  if (G.menuOpen) { G.menuOpen = false; $('pause-menu').classList.add('hidden'); lockPointer(); return; }
  if (G.phase !== 'paused') return;
  G.phase = 'playing';
  $('pause-menu').classList.add('hidden');
  lockPointer();
}
export function lockPointer() {
  AudioSys.init(); AudioSys.resume();
  if (renderer.domElement.requestPointerLock) {
    try { const p = renderer.domElement.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }
}

