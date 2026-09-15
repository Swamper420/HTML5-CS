// js/multiplayer.js — AGENTS: Client multiplayer glue: remote player meshes + interpolation, Net event wiring, bots on/off for PvP.
// Ownership: remotes Map, isOnline/isMultiplayer/isServerMatch, wireMultiplayer, updateRemoteMeshes. Protocol lives in ../net.js.

import * as THREE from 'three';
import { Net } from '../net.js';
import { AudioSys } from './audio.js';
import { CROUCH_EYE_DROP, MAP_HALF, MONEY_KILL, NADE_DEFS, WALLRUN, WEAPONS } from './config.js';
import { $, clamp, rand } from './utils.js';
import { animateSoldier, damp, soldierFireKick } from './anim.js';
import { BOMB, applyRemoteBomb, bombResetRound, spawnBombMesh, updateBombHUD } from './bomb.js';
import { resetBot } from './bots.js';
import { damagePlayer } from './combat.js';
import { onDamageAck } from './dmgreport.js';
import { spawnBloodPool, spawnBurst, spawnSmoke, spawnTracer, spawnWorldFlash } from './effects.js';
import { restoreSoldierMesh } from './gibs.js';
import {
  corpseK, goreRemoteDeath, pickFallParams, poseCorpseLimbs, slideCorpseOut, updateRagdoll,
} from './gore.js';
import { detonateFlash, detonateHE, throwNade } from './grenades.js';
import { setSoldierDual, setSoldierGun } from './gunmodels.js';
import { addKillfeed, announce, playerHitmark, updateHUD } from './hud.js';
import { igniteMolotov } from './molotov.js';
import { applyRemoteWeapon } from './pickups.js';
import { camera, scene } from './render.js';
import { applyMatchState, checkRoundEnd } from './rounds.js';
import { renderScoreboard, scoreboardVisible } from './scoreboard.js';
import { deploySmoke } from './smoke.js';
import { makeSoldier, updateBlob } from './soldier.js';
import { mySpawnSlot, spawnPoint, spawnYawPlayer } from './spawns.js';
import { spectateCurrent, updateSpectateOverlay } from './spectate.js';
import { G, addMoney, bots, player } from './state.js';
import { statsHolder } from './stats.js';

// Rule: Net.hasRealOpponents === true  =>  pure PvP, bots hidden & skipped.
// Solo / alone-on-server => bots stay exactly as before.
export const remotes = new Map(); // netId -> { data, mesh, pos:Vector3, yaw, targetPos, walkPhase, flashAt }
let mpStatusEl = null;
export function isOnline() { try { return Net.active; } catch { return false; } }
// Server owns rounds/score/bomb (2+ players on the server). See server-match.js.
export function isServerMatch() { try { return Net.active && !!(Net.match && Net.match.active); } catch { return false; } }
export function isMultiplayer() { try { return Net.active && (isServerMatch() || Net.hasRealOpponents); } catch { return false; } }

function addRemoteMesh(r) {
  if (remotes.has(r.id) || typeof scene === 'undefined' || !scene) return;
  const mesh = makeSoldier(r.team === 'ct' ? 'ct' : 't');
  try { setSoldierGun(mesh, WEAPONS[r.weapon] ? r.weapon : 'ak'); } catch (e) {}
  // No floating name tags: they render through walls and give away positions.
  mesh.position.set(r.x || 0, r.y || 0, r.z || 0);
  scene.add(mesh);
  remotes.set(r.id, {
    data: { ...r }, mesh,
    pos: new THREE.Vector3(r.x || 0, r.y || 0, r.z || 0),
    targetPos: new THREE.Vector3(r.x || 0, r.y || 0, r.z || 0),
    yaw: r.yaw || 0, targetYaw: r.yaw || 0,
    walkPhase: Math.random() * 6, flashAt: 0, lastShotAt: 0, team: r.team === 'ct' ? 'ct' : 't',
  });
}

export function removeRemoteMesh(id) {
  const e = remotes.get(id);
  if (!e) return;
  try { scene.remove(e.mesh); } catch {}
  try { if (e.blob) scene.remove(e.blob); } catch {}
  remotes.delete(id);
  if (player.specTarget && player.specTarget.__remoteId === id) {
    player.specTarget = null;
    try { spectateCurrent(); updateSpectateOverlay(); } catch {}
  }
}

function syncRemoteMeshes() {
  // Create meshes for newcomers, drop leavers.
  try {
    for (const r of Net.remoteList()) {
      const e = remotes.get(r.id);
      // Auto-balance moved them: rebuild with the right uniform.
      if (e && e.team !== (r.team === 'ct' ? 'ct' : 't')) removeRemoteMesh(r.id);
      if (!remotes.has(r.id)) addRemoteMesh(r);
    }
    for (const id of [...remotes.keys()]) {
      if (!Net.remotes.has(id)) removeRemoteMesh(id);
    }
  } catch {}
}

export function clearBotsForMP() {
  // Hide + deactivate bots while real players share the server.
  for (const b of bots) {
    b.alive = false; b.hp = 0;
    try { b.mesh.visible = false; } catch {}
    try { if (b.blob) b.blob.visible = false; } catch {}
    b.planting = false; b.defusing = false;
  }
  if (BOMB.carrier && BOMB.carrier.hasBomb !== undefined) { /* carrier was a bot — bomb goes neutral */ }
  if (BOMB.carrier && typeof BOMB.carrier === 'object' && BOMB.carrier.short) {
    BOMB.carrier = null;
    if (!BOMB.planted && !BOMB.droppedPos) {
      // Drop neutral bomb mid-map so T players can still play the objective.
      BOMB.droppedPos = new THREE.Vector3(0, 0, 0);
      try { spawnBombMesh(BOMB.droppedPos, false); } catch {}
    }
  }
  try { updateBombHUD(performance.now() / 1000); } catch {}
}

function restoreBotsForSolo() {
  // Re-enable bots when the last remote leaves / we disconnect.
  if (G.phase !== 'playing') return;
  let anyAlive = false;
  for (const b of bots) if (b.alive) { anyAlive = true; break; }
  if (anyAlive) return;
  for (const b of bots) {
    try { resetBot(b); } catch {}
  }
  try { bombResetRound(); } catch {}
}

function refreshBotsForMP() {
  if (isMultiplayer()) clearBotsForMP();
  else if (isOnline() && remotes.size === 0 && Net.remotes.size === 0) {
    // Alone on server: keep bots (do nothing — they were never cleared).
  }
  try { updateHUD(); } catch {}
}

export function remoteEye(e) { return new THREE.Vector3(e.pos.x, e.pos.y + 1.55 - CROUCH_EYE_DROP * (e.crouchK || 0), e.pos.z); }
function remoteChest(e) { return new THREE.Vector3(e.pos.x, e.pos.y + 1.1 - 0.36 * (e.crouchK || 0), e.pos.z); }

const _remSample = {};
export function updateRemoteMeshes(dt, t) {
  syncRemoteMeshes();
  const nowMs = performance.now();
  for (const [id, e] of remotes) {
    const r = Net.remotes.get(id);
    if (!r) continue;
    e.data = r;
    try { if (WEAPONS[r.weapon]) setSoldierGun(e.mesh, r.weapon); } catch (err) {}
    try { setSoldierDual(e.mesh, r.weapon, !!r.dual && !!r.alive); } catch (err) {}
    // Buffered snapshot interpolation (net.js): exact, jitter-free motion at any frame rate,
    // rendered a few tens of ms in the past. Hit tests use e.pos, i.e. what you actually see.
    const smp = Net.sample(r, nowMs, _remSample);
    e.targetPos.set(r.x || 0, r.y || 0, r.z || 0);
    if (r.alive || !e.fall) e.pos.set(smp.x, smp.y, smp.z);
    e.yaw = smp.yaw; e.pitch = smp.pitch;
    e.targetYaw = r.yaw || 0;
    const m = e.mesh;
    m.position.copy(e.pos);
    // Face movement model uses same yaw convention as bots (atan2(dx,dz)).
    m.rotation.y = e.yaw + Math.PI;
    // Walk anim when moving.
    const moving = !!r.moving || Math.hypot(e.vx || 0, e.vz || 0) > 0.4;
    if (moving) e.walkPhase += dt * 9;
    const sw = moving ? Math.sin(e.walkPhase) * 0.5 : 0;
    try {
      // revive: round reset — restore head/helmet/limbs cleared by goreRemoteDeath
      if (r.alive && (e.fall || e.headless)) {
        try { restoreSoldierMesh(m); } catch (err) {}
        e.fall = null; e.knock = null; e.deathPos = null; e.deathT = 0; e.headless = false; e._thudded = false;
        m.rotation.set(0, e.yaw + Math.PI, 0);
      }
      // Dead => momentum ragdoll like bots (fall away from killer, limbs sprawl).
      if (!r.alive) {
        // snapshot-only death (blast / suicide with no 'killed' gore yet): generic fall + pool
        if (!e.fall) {
          try {
            e.fall = pickFallParams(e.pos, null, 1);
            e.deathPos = e.pos.clone();
            e.knock = new THREE.Vector3(rand(-0.4, 0.4), 0, rand(-0.4, 0.4));
            e.deathT = 0; e._thudded = false; e.headless = false;
            spawnBloodPool(e.pos.x, e.pos.z, true);
            poseCorpseLimbs(m, e.fall.sprawl, e.fall.power);
          } catch (err) {}
        }
        e.deathT = Math.min(1.6, (e.deathT || 0) + dt);
        updateRagdoll(m, dt);
        const { k: dk, e: dease } = corpseK(e.deathT);
        const ef = e.fall || { dirX: 0, dirZ: 1, spin: 0, roll: 0, power: 1 };
        try {
          if (e.deathPos && e.knock) {
            m.position.set(
              e.deathPos.x + e.knock.x * dease,
              Math.max(0.05, e.deathPos.y + Math.sin(Math.min(1, dk * 1.3) * Math.PI) * 0.10 * (ef.power || 1) * (1 - dk)),
              e.deathPos.z + e.knock.z * dease
            );
            try { slideCorpseOut(m, 0.5); } catch (err) {}
            e.pos.set(m.position.x, e.deathPos.y, m.position.z);
          } else {
            m.position.y = Math.max(0.2, m.position.y);
          }
          const baseYaw = (e.yaw || 0) + Math.PI;
          const fX = Math.sin(baseYaw), fZ = Math.cos(baseYaw);
          const fDot = (ef.dirX || 0) * fX + (ef.dirZ || 0) * fZ;
          const sDot = (ef.dirX || 0) * fZ - (ef.dirZ || 0) * fX;
          const tip = Math.PI / 2 * 0.95;
          m.rotation.x = (fDot >= 0 ? tip : -tip) * (0.75 + Math.abs(fDot) * 0.45) * dease;
          m.rotation.z = clamp(-sDot * tip * 0.9 + (ef.roll || 0), -1.2, 1.2) * dease;
          m.rotation.y = baseYaw + (ef.spin || 0) * dease;
          if (e.headless && e.deathT < 0.9 && Math.random() < dt * 14) {
            try { spawnBurst(new THREE.Vector3(e.pos.x, 1.0 - dease * 0.75, e.pos.z), 0xa00d10, 2, 1.6, 0.4, 0.08); } catch (err) {}
          }
          if (!e._thudded && dk >= 1) {
            e._thudded = true;
            try { spawnSmoke(new THREE.Vector3(e.pos.x, 0.25, e.pos.z), 0.7, 0.9, 0xbfae8e); } catch (err) {}
          }
        } catch (err) {}
        m.visible = !(player.specTarget && player.specTarget.__remoteId === id && player.specMode === 'first' && !player.alive);
      } else {
        // alive: walk swing + gun pitch + ease back upright from any old tip
        try {
          // Full rig: gait comes from how fast the interpolated position is actually
          // moving, so a remote walks, runs and backpedals like a local bot.
          m.position.y = e.pos.y;
          const inv = dt > 1e-4 ? 1 / dt : 0;
          e.vx = damp(e.vx || 0, (e.pos.x - (e.prevX !== undefined ? e.prevX : e.pos.x)) * inv, 14, dt);
          e.vz = damp(e.vz || 0, (e.pos.z - (e.prevZ !== undefined ? e.prevZ : e.pos.z)) * inv, 14, dt);
          e.prevX = e.pos.x; e.prevZ = e.pos.z;
          e.crouchK = damp(e.crouchK || 0, r.crouch ? 1 : 0, 11, dt);
          const wallSide = r.wr ? Math.sign(r.wr) : 0;
          animateSoldier(m, {
            vx: e.vx, vz: e.vz, yaw: m.rotation.y, pitch: (e.pitch !== undefined ? e.pitch : (r.pitch || 0)),
            grounded: r.gnd !== undefined ? (!!r.gnd || !!wallSide) : (r.y || 0) < 0.06, crouch: !!r.crouch,
            kneel: !!r.planting || !!r.defusing, reloading: !!r.reloading, wall: wallSide,
          }, dt, t);
        } catch (err) {}
        if (Math.abs(m.rotation.x) > 0.01) m.rotation.x *= Math.max(0, 1 - dt * 6);
        // wall run: lean the body away from the wall, feet toward it (tip recovery decays the same channel otherwise)
        e.wallLean = damp(e.wallLean || 0, -(r.wr ? Math.sign(r.wr) : 0) * WALLRUN.bodyLean, 10, dt);
        e.wallRoll = damp(e.wallRoll || 0, (r.wr ? Math.sign(r.wr) : 0) * WALLRUN.camRoll, 10, dt);
        if (Math.abs(e.wallLean) > 0.005) m.rotation.z = e.wallLean;
        else if (Math.abs(m.rotation.z || 0) > 0.01) m.rotation.z *= Math.max(0, 1 - dt * 6);
        m.visible = !(player.specTarget && player.specTarget.__remoteId === id && player.specMode === 'first' && !player.alive);
      }
      updateBlob(e, e.pos.x, e.pos.z, !!r.alive, moving);
    } catch {}
  }
}

// Outgoing state @ ~20Hz + incoming event wiring (called once from boot).
let _mpWired = false;
export function wireMultiplayer() {
  if (_mpWired) return; _mpWired = true;
  mpStatusEl = document.getElementById('mp-status');

  Net.on('welcome', (m) => {
    player.team = (m.team === 't') ? 't' : 'ct';
    player.name = Net.name || 'YOU';
    announce(`ONLINE AS ${player.team.toUpperCase()} — ${player.name}`, 1800);
    refreshBotsForMP();
    updateMPStatus();
    if (G.phase === 'playing' || G.phase === 'over') {
      if (isServerMatch()) { try { applyMatchState(Net.match); } catch (e) { console.warn('welcome match', e); } }
      else {
        // Re-spawn on our team's side with the new team.
        try {
          const team = player.team || 'ct';
          player.pos.copy(spawnPoint(team, mySpawnSlot())); player.yaw = spawnYawPlayer(team, player.pos);
        } catch {}
      }
    }
  });
  Net.on('match', (m) => {
    try { applyMatchState(m); } catch (e) { console.warn('match msg', e); }
    refreshBotsForMP(); updateMPStatus();
  });
  Net.on('team', (m) => {
    // Takes effect at the round start that follows (server balances right before it).
    announce(`AUTO-BALANCE: YOU ARE NOW ${String(m.team).toUpperCase()}`, 2200);
  });
  Net.on('player_joined', () => { refreshBotsForMP(); updateMPStatus(); try { updateHUD(); } catch {} });
  Net.on('player_left', (m) => {
    try { removeRemoteMesh(m.id); } catch {}
    // If nobody real is left, bring bots back so solo-on-server still plays.
    if (Net.remotes.size === 0) { try { restoreBotsForSolo(); } catch {} }
    refreshBotsForMP(); updateMPStatus();
    try { updateHUD(); } catch {}
  });
  Net.on('disconnect', () => {
    for (const id of [...remotes.keys()]) try { removeRemoteMesh(id); } catch {}
    try { applyMatchState({ active: false }); } catch {} // server gone mid-match: back to solo
    try { restoreBotsForSolo(); } catch {}
    updateMPStatus();
  });

  Net.on('shot', (m) => {
    // Remote tracer + positional gun sound.
    try {
      const e = remotes.get(m.fromId);
      const from = new THREE.Vector3(m.ox, m.oy, m.oz);
      const dir = new THREE.Vector3(m.dx, m.dy, m.dz).normalize();
      const end = from.clone().addScaledVector(dir, 30);
      spawnTracer(from, end, m.tracer || 0xff9a5c);
      spawnWorldFlash(from, m.tracer || 0xff9a5c, m.sound === 'sniper' ? 1.5 : 0.85);
      AudioSys.shoot(m.sound || 'rifle', from);
      if (e) { e.flashAt = performance.now() / 1000 + 0.05; soldierFireKick(e.mesh, 0.85); }
      // Near-miss crack for remote shots.
      if (player.alive && camera) {
        const lp = camera.position;
        const ox = lp.x - from.x, oy = lp.y - from.y, oz = lp.z - from.z;
        const along = ox * dir.x + oy * dir.y + oz * dir.z;
        if (along > 0 && along < 45) {
          const px = from.x + dir.x * along - lp.x;
          const py = from.y + dir.y * along - lp.y;
          const pz = from.z + dir.z * along - lp.z;
          if (Math.sqrt(px * px + py * py + pz * pz) < 2.6 && Math.random() < 0.85)
            setTimeout(() => AudioSys.crack(), along / 343 * 1000);
        }
      }
    } catch {}
  });

  Net.on('hit', (m) => {
    // Someone shot *us* (authoritative damage applied by victim).
    try {
      if (m.targetId !== Net.id) return;
      if (!player.alive || G.phase !== 'playing') return;
      const e = remotes.get(m.fromId);
      if (m.fromId != null && !e) return; // unknown sender — drop forged hits
      const shooter = {
        isPlayer: false, team: m.fromTeam || (e ? e.data.team : 't'),
        bot: null, remote: e || null,
        remoteName: m.fromName || (e ? e.data.name : 'Enemy'),
        remotePos: e ? e.pos.clone() : null,
        weaponName: m.weapon || 'AK-47',
      };
      let dmg = Number(m.dmg);
      if (!isFinite(dmg)) return;
      dmg = clamp(dmg, 0, 100); // per-hit cap — no remote one-shots via spoofed dmg
      // damagePlayer reports our death (once) to the server; don't send a second 'killed' here.
      damagePlayer(dmg, shooter, !!m.head);
      // Hit direction arrow from remote position.
      if (e && typeof flashDamageRemote === 'function') flashDamageRemote(e.pos);
    } catch {}
  });

  Net.on('dmg', (m) => { onDamageAck(m); });

  Net.on('killed', (m) => {
    try {
      // Remote-vs-remote or remote-vs-us killfeed + round check.
      if (m.victimId === Net.id) return; // already handled locally in damagePlayer
      const e = remotes.get(m.victimId);
      const wasAlive = !!(e && e.data.alive);
      if (e) {
        e.data.alive = false; e.data.hp = 0;
        // gore: head-pop / ragdoll on the victim's mesh, directed away from the killer
        try {
          let sdir = null;
          if (m.killerId === Net.id && typeof camera !== 'undefined' && camera) {
            sdir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
          } else if (m.killerId != null && remotes.get(m.killerId)) {
            const k = remotes.get(m.killerId);
            sdir = new THREE.Vector3(e.pos.x - k.pos.x, 0, e.pos.z - k.pos.z);
            if (sdir.lengthSq() < 0.01) sdir.set(rand(-1, 1), 0, rand(-1, 1));
            sdir.normalize();
          }
          goreRemoteDeath(e, !!m.head, m.weapon || 'AK-47', sdir);
        } catch (err) {}
      }
      addKillfeed(m.killerName || '???', m.killerTeam || 't', m.victimName || '???', m.victimTeam || 'ct', m.weapon || 'AK-47', !!m.head);
      try {
        if (m.killerId !== null && m.killerId !== undefined && m.killerId !== Net.id) statsHolder('remote:' + m.killerId).kills++;
        if (m.victimId !== null && m.victimId !== undefined && m.victimId !== Net.id) statsHolder('remote:' + m.victimId).deaths++;
      } catch {}
      if (m.killerId === Net.id) {
        if (!wasAlive) return;
        // K/D is server-owned in a server match (applied from 'match'); money + feedback stay local.
        G.kills++; player.kills++; addMoney(MONEY_KILL); playerHitmark(m.head, true);
        AudioSys.kill();
        if (m.head) announce('HEADSHOT +$' + MONEY_KILL, 700);
        try { updateHUD(); } catch {}
      }
      try { if (scoreboardVisible()) renderScoreboard(); } catch {}
      checkRoundEnd();
    } catch {}
  });

  Net.on('bomb', (m) => {
    try { applyRemoteBomb(m); } catch (e) { console.warn('bomb msg', e); }
  });
  Net.on('nade', (m) => {
    try { applyRemoteNade(m); } catch (e) { console.warn('nade msg', e); }
  });
  Net.on('weapon', (m) => {
    try { applyRemoteWeapon(m); } catch (e) { console.warn('weapon msg', e); }
  });
}
function applyRemoteNade(m) {
  if (G.phase !== 'playing') return;
  const t = performance.now() / 1000;
  if (m.fromId != null && !remotes.get(m.fromId)) return; // unknown sender
  const owner = {
    isPlayer: false, team: m.fromTeam || 't',
    bot: null, remoteName: m.fromName || ('Player' + (m.fromId ?? '?')),
    remoteId: m.fromId ?? null, weaponName: (NADE_DEFS[m.nade] || {}).name || 'GRENADE',
  };
  // Host-relayed bot utility (solo-with-guests spectating): attribute to a display name.
  if (m.botShort) owner.remoteName = `${m.botShort} (BOT)`;
  const inMap = (x, y, z) => isFinite(x) && isFinite(y) && isFinite(z) && Math.abs(x) <= MAP_HALF + 6 && Math.abs(z) <= MAP_HALF + 6 && y >= -1 && y <= 12;
  if (m.action === 'throw' && NADE_DEFS[m.nade]) {
    const ox = +m.x || 0, oy = +m.y || 1.4, oz = +m.z || 0;
    const vx = +m.vx || 0, vy = +m.vy || 0, vz = +m.vz || 0;
    if (!inMap(ox, oy, oz)) return;
    const origin = new THREE.Vector3(ox, oy, oz);
    const vel = new THREE.Vector3(vx, vy, vz);
    if (!isFinite(vel.x + vel.y + vel.z) || vel.length() > 32) return;
    if (vel.lengthSq() < 0.01) vel.set(0, 2, 0);
    let fuse = +m.fuse || NADE_DEFS[m.nade].fuse;
    if (!isFinite(fuse)) return;
    fuse = clamp(fuse, 0.2, NADE_DEFS[m.nade].fuse + 1.0);
    throwNade(m.nade, origin, vel, owner, fuse, true);
  } else if (m.action === 'boom') {
    // in-hand cook from a remote player — detonate at the broadcast position
    const ax = +m.x || 0, ay = +m.y || 1.3, az = +m.z || 0;
    if (!inMap(ax, ay, az)) return;
    const at = new THREE.Vector3(ax, ay, az);
    if (m.nade === 'he') detonateHE(at, owner, t, true);
    else if (m.nade === 'flash') detonateFlash(at, owner, t, true);
    else if (m.nade === 'smoke') deploySmoke(at, owner, t);
    else if (m.nade === 'molotov') igniteMolotov(at, owner, t);
  }
}

export function updateMPStatus() {
  if (!mpStatusEl) mpStatusEl = document.getElementById('mp-status');
  if (!mpStatusEl) return;
  // Short on purpose: it sits under the minimap.
  if (!Net.active) { mpStatusEl.textContent = 'OFFLINE · BOTS'; mpStatusEl.className = 'offline'; mpStatusEl.title = 'Solo vs bots'; }
  else if (Net.hasRealOpponents) {
    mpStatusEl.textContent = `ONLINE · ${Net.realPlayers}P · PVP`;
    mpStatusEl.className = 'online pvp'; mpStatusEl.title = 'Real players online — bots disabled';
  } else {
    mpStatusEl.textContent = 'ONLINE · WAITING · BOTS';
    mpStatusEl.className = 'online solo'; mpStatusEl.title = 'Alone on server — bots active until players join';
  }
}
export function flashDamageRemote(remotePos) {
  try {
    const dx = remotePos.x - player.pos.x, dz = remotePos.z - player.pos.z;
    const worldAng = Math.atan2(dx, dz);
    const facing = player.yaw + Math.PI;
    const rel = worldAng - facing;
    const el = document.createElement('div');
    el.className = 'dmg-arrow';
    el.style.transform = `rotate(${-rel}rad)`;
    const di = $('direction-indicator');
    di.innerHTML = ''; di.appendChild(el); di.style.opacity = 1;
    setTimeout(() => di.style.opacity = 0, 600);
  } catch {}
}

