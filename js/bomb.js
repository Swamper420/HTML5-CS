// js/bomb.js — AGENTS: Defusal bomb: BOMB round state, sites, single-owner plant/defuse progress, mesh, explode/defuse, server bomb sync, bomb HUD, per-frame updateBomb.
// Ownership: BOMB object + everything bomb-related. Timings in config.js.
// Online server match: the server owns carrier/plant/defuse/explode. Clients run the hold-E bars, send
// requests (plant_start/plant, defuse_start/defuse, pickup) and apply the server's 'bomb' broadcasts.

import * as THREE from 'three';
import { Net } from '../net.js';
import { AudioSys } from './audio.js';
import { BOMB_DEFUSE_TIME, BOMB_PLANT_TIME, BOMB_TIMER, MAP_HALF, SITES } from './config.js';
import { opts } from './settings.js';
import { $, clamp, rand, randPick } from './utils.js';
import { botChest, objectiveWaypoint } from './bots.js';
import { damageBot, damagePlayer } from './combat.js';
import { spawnBurst, spawnDebris, spawnDecal, spawnFireball, spawnShockwave, spawnSmoke } from './effects.js';
import { addKillfeed, announce, flashExplosionOverlay } from './hud.js';
import { isMultiplayer, isServerMatch } from './multiplayer.js';
import { camera, muzzleLight, scene } from './render.js';
import { checkRoundEnd, endRound } from './rounds.js';
import { G, bots, isFreeze, keys, player } from './state.js';
import { vmRig } from './viewmodel.js';

// Timings in js/config.js; mutable round state stays here.
export const BOMB = {
  carrier: null,        // bot ref carrying the bomb
  droppedPos: null,     // THREE.Vector3 when dropped on the ground
  planted: false,
  site: null,           // 'A' | 'B' once planted
  pos: null,            // planted Vector3
  targetSite: null,     // 'A' | 'B' — T objective for this round
  plantProgress: 0,
  plantingBot: null,
  planter: null,        // 'player' | bot ref — owns plantProgress (handing off restarts the bar)
  plantSite: null,      // site name the current plant progress belongs to
  defuseProgress: 0,
  defuser: null,        // 'player' | bot ref
  _plantAdvT: -1,       // sim time plantProgress last advanced — one advance per frame, one actor
  _defuseAdvT: -1,      // same guard for defuseProgress
  explodeAt: 0,         // performance-time seconds
  mesh: null,
  light: null,
  beepAt: 0,
  exploded: false,
  carrierId: null,      // online: net id of the T carrying it (server-owned)
  _netHold: null,       // online: 'plant' | 'defuse' while we've told the server we're holding E
  _reqAt: -9,           // online: last plant/defuse/pickup completion request (perf seconds)
};
// ---- Online request helpers ----
function netHold(kind) { // kind: 'plant' | 'defuse' | null
  if (BOMB._netHold === kind) return;
  if (BOMB._netHold) Net.sendBomb({ action: BOMB._netHold + '_stop' });
  BOMB._netHold = kind;
  if (kind) Net.sendBomb({ action: kind + '_start' });
}
function netRequest(msg, t) {
  if (t - BOMB._reqAt < 0.6) return; // one request per ~RTT; the server's answer resolves it
  BOMB._reqAt = t;
  Net.sendBomb(msg);
}
export function siteByName(n) { return SITES.find((s) => s.name === n); }
export function isInSite(pos, site) {
  const dx = pos.x - site.x, dz = pos.z - site.z;
  return Math.hypot(dx, dz) < site.r;
}
// Which bombsite is this position standing in? (any site, not just the round's target)
export function siteAt(pos) { for (const s of SITES) { if (isInSite(pos, s)) return s; } return null; }

// ---- Single-owner plant/defuse progress ----
// CS rule: one actor works the bomb at a time, and a hand-off restarts the bar.
// updateBot() and updateBomb() both run inside the same frame, so without the
// time stamp a bot and the player could each add dt to the *same* bar and finish
// a 2s plant in 1s. The stamp also tells us when nobody is working it, which
// is what drives decay.
export function bombAdvancePlant(owner, site, dt, t) {
  const siteName = site ? site.name : null;
  if (BOMB.planter !== owner || BOMB.plantSite !== siteName) {
    BOMB.planter = owner; BOMB.plantSite = siteName; BOMB.plantProgress = 0;
  }
  if (BOMB._plantAdvT === t) return BOMB.plantProgress;
  BOMB._plantAdvT = t;
  BOMB.plantProgress += dt;
  return BOMB.plantProgress;
}
export function bombAdvanceDefuse(owner, dt, t) {
  if (BOMB.defuser !== owner) { BOMB.defuser = owner; BOMB.defuseProgress = 0; }
  if (BOMB._defuseAdvT === t) return BOMB.defuseProgress;
  BOMB._defuseAdvT = t;
  BOMB.defuseProgress += dt;
  return BOMB.defuseProgress;
}
// Is someone other than `me` actively working the bomb right now?
export function bombPlantBusy(me, t) { return !!BOMB.planter && BOMB.planter !== me && (t - BOMB._plantAdvT) < 0.25; }
export function bombDefuseBusy(me, t) { return !!BOMB.defuser && BOMB.defuser !== me && (t - BOMB._defuseAdvT) < 0.25; }
// Bleed plant progress when nobody advanced it this frame (walked out, died, mid-air).
function bombDecayPlant(dt, t) {
  if (BOMB.planted || BOMB.plantProgress <= 0 || BOMB._plantAdvT === t) return;
  BOMB.plantProgress = Math.max(0, BOMB.plantProgress - dt * 1.5);
  if (BOMB.plantProgress <= 0) { BOMB.planter = null; BOMB.plantSite = null; }
}

export function bombClearMesh() {
  if (BOMB.mesh) { scene.remove(BOMB.mesh); BOMB.mesh = null; }
  if (BOMB.light) { scene.remove(BOMB.light); BOMB.light = null; }
}
export function bombResetRound() {
  bombClearMesh();
  BOMB.carrier = null; BOMB.droppedPos = null; BOMB.planted = false;
  BOMB.site = null; BOMB.pos = null; BOMB.targetSite = Math.random() < 0.5 ? 'A' : 'B';
  BOMB.plantProgress = 0; BOMB.plantingBot = null; BOMB.planter = null; BOMB.plantSite = null;
  BOMB.defuseProgress = 0; BOMB.defuser = null;
  BOMB._plantAdvT = -1; BOMB._defuseAdvT = -1;
  BOMB.explodeAt = 0; BOMB.exploded = false; BOMB.beepAt = 0; BOMB._tenSecWarned = false; BOMB._fastFused = false;
  BOMB.carrierId = null; BOMB._netHold = null; BOMB._reqAt = -9;
  if (isMultiplayer()) {
    // Pure PvP: no bot carrier — the server names one T player (syncBombFromServer).
    for (const b of bots) b.hasBomb = false;
    player.hasBomb = false;
    updateBombHUD(0);
    return;
  }
  // Solo: if player is T they carry the bomb; otherwise give it to a random T bot.
  for (const b of bots) b.hasBomb = false;
  if ((player.team || 'ct') === 't') {
    player.hasBomb = true;
    // No bot carrier when player is the T.
  } else {
    const aliveT = bots.filter((b) => b.team === 't');
    if (aliveT.length) {
      BOMB.carrier = randPick(aliveT);
      for (const b of aliveT) b.hasBomb = (b === BOMB.carrier);
    }
  }
  for (const b of bots) if (b.team === 'ct') { b.guardSite = b.idx % 2 === 0 ? 'A' : 'B'; b.wp.copy(objectiveWaypoint(b)); }
  for (const b of bots) if (b.team === 't') b.wp.copy(objectiveWaypoint(b));
  updateBombHUD(0);
}
export function bombDropAt(pos, fromNet = false) {
  BOMB.droppedPos = pos.clone(); BOMB.droppedPos.y = 0;
  BOMB.carrier = null; BOMB.plantProgress = 0; BOMB.plantingBot = null; BOMB.planter = null; BOMB.plantSite = null;
  spawnBombMesh(BOMB.droppedPos, false);
  announce('BOMB DROPPED', 1400);
  updateBombHUD(performance.now() / 1000);
}
export function spawnBombMesh(pos, planted) {
  bombClearMesh();
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.28, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.5, metalness: 0.5 }));
  body.position.y = 0.16; body.castShadow = true; g.add(body);
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xff2222, emissiveIntensity: 2 }));
  led.position.set(0.12, 0.33, 0); g.add(led);
  g.userData.led = led;
  g.position.copy(pos); g.position.y = 0;
  scene.add(g);
  BOMB.mesh = g;
  if (planted) {
    BOMB.light = new THREE.PointLight(0xff3333, 2, 9, 2);
    BOMB.light.position.copy(pos).add(new THREE.Vector3(0, 1, 0));
    scene.add(BOMB.light);
  }
}
export function plantBomb(bot, site, t, fromNet = false) {
  const isPlayerPlanter = bot && bot.isPlayerPlanter;
  BOMB.planted = true; BOMB.site = site.name;
  BOMB.pos = (bot.pos || bot).clone ? (bot.pos ? bot.pos.clone() : bot.clone()) : new THREE.Vector3(bot.x, 0, bot.z);
  BOMB.pos.y = 0;
  BOMB.carrier = null;
  try { if (bot) bot.hasBomb = false; } catch {}
  if (isPlayerPlanter) player.hasBomb = false;
  BOMB.droppedPos = null; BOMB.plantProgress = 0; BOMB.plantingBot = null; BOMB.planter = null; BOMB.plantSite = null;
  BOMB.explodeAt = t + BOMB_TIMER; BOMB.beepAt = t;
  BOMB.defuseProgress = 0; BOMB.defuser = null;
  spawnBombMesh(BOMB.pos, true);
  AudioSys.plantedConfirm();
  announce(`BOMB PLANTED ON ${site.name} — DEFUSE IT!`, 2600);
  const planterName = isPlayerPlanter ? (player.name || 'YOU') : (bot.short || 'T');
  addKillfeed(planterName, 't', 'SITE ' + site.name, 'ct', '💣 C4', false);
  updateBombHUD(t);
}
function plantBombByPlayer(site, t) {
  plantBomb({ isPlayerPlanter: true, pos: player.pos, hasBomb: player.hasBomb }, site, t, false);
}
export function bombDroppedHit(origin, dir, maxT) {
  // Ray vs dropped C4 only — planted C4 is bulletproof by design.
  // Returns distance or null. Small ground target: sphere at y~0.3, r~0.55.
  // Online the dropped C4 is a server object — shooting it would desync every client.
  if (BOMB.planted || !BOMB.droppedPos || G.roundEnding || G.phase !== 'playing' || isServerMatch()) return null;
  const cx = BOMB.droppedPos.x, cy = 0.3, cz = BOMB.droppedPos.z;
  const r = 0.55;
  const ox = origin.x - cx, oy = origin.y - cy, oz = origin.z - cz;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const tt = -b - Math.sqrt(disc);
  if (tt > 0.3 && tt < maxT) return tt;
  return null;
}
export function explodeBomb(t, reason, fromNet = false) {
  if (BOMB.exploded || G.roundEnding) return;
  if (isServerMatch() && !fromNet) return; // only the server detonates online
  BOMB.exploded = true;
  const groundZero = BOMB.planted && BOMB.pos ? BOMB.pos : BOMB.droppedPos;
  const p = groundZero ? groundZero.clone().add(new THREE.Vector3(0, 1, 0)) : new THREE.Vector3(24, 1, 0);
  AudioSys.explode(p);
  spawnBurst(p, 0xffd27a, 40, 12, 0.9, 0.22);
  spawnBurst(p, 0xff6a2a, 30, 9, 1.1, 0.3);
  spawnBurst(p, 0x555555, 24, 6, 1.6, 0.35);
  spawnSmoke(p, 1.6, 2.2, 0x444444);
  // cinematic layers: core fireball, rolling fireballs, shockwave, debris, dust column, scorch
  spawnFireball(p, 5.5, 0.5);
  spawnFireball(p.clone().add(new THREE.Vector3(rand(-1, 1), 1.2, rand(-1, 1))), 3.4, 0.7);
  spawnFireball(p.clone().add(new THREE.Vector3(rand(-1.5, 1.5), 0.4, rand(-1.5, 1.5))), 2.6, 0.9);
  spawnShockwave(p, 11, 0.55);
  setTimeout(() => { try { spawnShockwave(p, 7, 0.4, 0xc8b090); } catch (e) {} }, 120);
  spawnDebris(p, opts.quality ? 16 : 8, 10, 10);
  for (let i = 0; i < 5; i++) {
    const c = p.clone().add(new THREE.Vector3(rand(-2.5, 2.5), rand(0, 2), rand(-2.5, 2.5)));
    spawnSmoke(c, rand(0.8, 1.4), rand(1.4, 2.4), i % 2 ? 0x555555 : 0x8a7a64);
  }
  try {
    const gz = groundZero ? groundZero.clone() : p.clone().setY(0);
    spawnDecal('scorch', new THREE.Vector3(gz.x, 0.06, gz.z), new THREE.Vector3(0, 1, 0), 7.5, 1);
    spawnDecal('scorch', new THREE.Vector3(gz.x + rand(-1, 1), 0.055, gz.z + rand(-1, 1)), new THREE.Vector3(0, 1, 0), 4, 0.8);
  } catch (e) {}
  try { flashExplosionOverlay(); } catch (e) {}
  muzzleLight.position.copy(p); muzzleLight.intensity = 14; muzzleLight.distance = 55;
  if (camera) {
    const d = camera.position.distanceTo(p);
    vmRig.shake += clamp(0.09 * (1 - d / 50), 0.01, 0.09);
    vmRig.fovKick += clamp(6 * (1 - d / 50), 0, 6);
  }
  setTimeout(() => bombClearMesh(), 2500);
  const wasPlanted = BOMB.planted;
  BOMB.planted = false; // stop the HUD timer — round is decided, mesh burns out visually
  BOMB.droppedPos = null; BOMB.carrier = null; BOMB.plantingBot = null; BOMB.planter = null; BOMB.plantSite = null;
  BOMB.defuser = null;
  AudioSys.bombDetonated();
  // Resolve the round BEFORE applying damage, so blast kills can't make
  // checkRoundEnd() hand the round to the wrong team mid-explosion.
  if (wasPlanted) {
    if (!isServerMatch()) endRound('t', reason || '💥 BOMB DETONATED'); // online: server's round_end follows
  } else {
    // A dropped C4 shot on the ground is not a T objective win — it destroys the
    // objective. Shooting it used to literally hand T the round.
    announce('💥 DROPPED C4 DESTROYED', 1800);
  }
  // The blast was pure VFX before: you could stand on the C4 through detonation
  // without losing a single HP.
  try {
    const gz = groundZero ? groundZero.clone() : p.clone().setY(0);
    const blastR = 12, killR = 6;
    const dmgAt = (d) => (d <= killR ? 500 : Math.round(500 * Math.max(0, 1 - (d - killR) / (blastR - killR))));
    // remotePos makes the damage indicator point at the blast; remoteName is what
    // the death screen credits the kill to.
    const src = { isPlayer: false, team: 't', weaponName: '💣 C4', remoteName: '💣 C4', remotePos: gz };
    for (const b of bots.slice()) {
      if (!b.alive) continue;
      const d = Math.hypot(b.pos.x - gz.x, b.pos.z - gz.z);
      if (d < blastR) damageBot(b, dmgAt(d), src, false, botChest(b), { explosive: true, weapon: 'C4', power: 2.4 });
    }
    if (player.alive) {
      const d = Math.hypot(player.pos.x - gz.x, player.pos.z - gz.z);
      if (d < blastR) damagePlayer(dmgAt(d), src, false);
    }
  } catch (e) { console.warn('c4 blast', e); }
  if (!wasPlanted) { try { checkRoundEnd(); } catch (e) {} }
}
export function defuseBomb(byPlayer, t, fromNet = false) {
  if (G.roundEnding || isServerMatch()) return;
  bombClearMesh();
  BOMB.planted = false; BOMB.pos = null; BOMB.site = null;
  BOMB.defuseProgress = 0; BOMB.defuser = null;
  endRound('ct', byPlayer ? 'BOMB DEFUSED — YOU SAVED THE SITE!' : 'BOMB DEFUSED — CT WINS');
}
// ---- Server bomb state (online) ----
function setPlanted(siteName, x, z, explodeIn, t, quiet) {
  const site = siteByName(siteName) || SITES[0];
  BOMB.planted = true; BOMB.site = site.name; BOMB.exploded = false;
  BOMB.pos = new THREE.Vector3(+x || site.x, 0, +z || site.z);
  BOMB.carrier = null; BOMB.carrierId = null; BOMB.droppedPos = null;
  BOMB.plantProgress = 0; BOMB.plantingBot = null; BOMB.planter = null; BOMB.plantSite = null;
  BOMB.explodeAt = Net.deadline(explodeIn); BOMB.beepAt = t;
  BOMB.defuseProgress = 0; BOMB.defuser = null;
  player.hasBomb = false;
  if (BOMB._netHold === 'plant') BOMB._netHold = null;
  spawnBombMesh(BOMB.pos, true);
  if (!quiet) AudioSys.plantedConfirm();
}
function setDropped(x, z) {
  BOMB.droppedPos = new THREE.Vector3(+x || 0, 0, +z || 0);
  BOMB.carrier = null; BOMB.carrierId = null; BOMB.plantProgress = 0; BOMB.planter = null; BOMB.plantSite = null;
  spawnBombMesh(BOMB.droppedPos, false);
}
// Full-state reconcile from a 'match' message (late join, new round, missed packet).
export function syncBombFromServer(b, fresh) {
  if (!b || G.roundEnding) return;
  const t = performance.now() / 1000;
  BOMB.carrierId = b.carrierId ?? null;
  const mine = b.carrierId != null && b.carrierId === Net.id;
  if (mine !== !!player.hasBomb) {
    player.hasBomb = mine;
    if (mine && fresh) announce('YOU HAVE THE BOMB — PLANT ON A OR B (HOLD E)', 2200);
  }
  if (b.planted && !b.exploded) {
    if (!BOMB.planted) setPlanted(b.site, b.x, b.z, b.explodeIn, t, !fresh);
    const end = Net.deadline(b.explodeIn);
    if (Math.abs(BOMB.explodeAt - end) > 0.25) BOMB.explodeAt = end;
  } else if (b.dropped) {
    if (!BOMB.droppedPos || Math.hypot(BOMB.droppedPos.x - b.dropped.x, BOMB.droppedPos.z - b.dropped.z) > 0.5) setDropped(b.dropped.x, b.dropped.z);
  } else if (!BOMB.planted && BOMB.droppedPos) {
    BOMB.droppedPos = null; bombClearMesh();
  }
  updateBombHUD(t);
}
// Server 'bomb' broadcasts (srv:1). Client-to-client bomb messages no longer exist.
export function applyRemoteBomb(m) {
  if (!m || !m.srv || !isServerMatch()) return;
  const t = performance.now() / 1000;
  const mine = m.byId != null && m.byId === Net.id;
  const who = mine ? 'YOU' : String(m.byName || (m.action === 'defuse' ? 'CT' : 'T')).slice(0, 16);
  switch (m.action) {
    case 'plant':
      if (G.roundEnding) return;
      setPlanted(m.site, m.x, m.z, m.explodeIn, t, false);
      announce(`BOMB PLANTED ON ${BOMB.site} — DEFUSE IT!`, 2600);
      addKillfeed(who, 't', 'SITE ' + BOMB.site, 'ct', '💣 C4', false);
      break;
    case 'defuse':
      bombClearMesh();
      BOMB.planted = false; BOMB.pos = null; BOMB.site = null;
      BOMB.defuseProgress = 0; BOMB.defuser = null; BOMB._netHold = null;
      updateInteractHUD(null);
      break; // the server's round_end carries the banner
    case 'drop':
      if (BOMB.planted) return;
      if (mine) player.hasBomb = false;
      setDropped(m.x, m.z);
      if ((player.team || 'ct') === 't') announce(mine ? 'YOU DROPPED THE BOMB' : 'BOMB DROPPED — PICK IT UP', 1400);
      break;
    case 'pickup':
      BOMB.droppedPos = null; bombClearMesh();
      BOMB.carrierId = m.byId ?? null;
      player.hasBomb = mine;
      if (mine) { announce('YOU PICKED UP THE BOMB — PLANT ON A OR B (HOLD E)', 1800); AudioSys.plantBeep(); }
      else if ((player.team || 'ct') === 't') announce(`${who} PICKED UP THE BOMB`, 1200);
      break;
    case 'fuse': {
      BOMB.explodeAt = Math.min(BOMB.explodeAt || Infinity, Net.deadline(m.explodeIn));
      announce('ALL CT DOWN — BOMB WILL DETONATE', 1800);
      break;
    }
    case 'explode':
      if (BOMB.exploded) return;
      if (!BOMB.planted) { // missed the plant somehow — still blow up in the right place
        BOMB.planted = true; BOMB.pos = new THREE.Vector3(+m.x || 0, 0, +m.z || 0);
      }
      explodeBomb(t, '💥 BOMB DETONATED', true);
      break;
    case 'deny':
      // Server refused (timing/position/someone else got it): reset our bar.
      if (m.what === 'plant') { BOMB.plantProgress = 0; BOMB.planter = null; }
      if (m.what === 'defuse') { BOMB.defuseProgress = 0; BOMB.defuser = null; }
      BOMB._netHold = null; BOMB._reqAt = -9;
      break;
    default: break;
  }
  updateBombHUD(t);
}
export function updateBombHUD(t) {
  const bar = $('bomb-status'), txt = $('bomb-text'), tmr = $('bomb-timer');
  if (!bar) return;
  if (G.phase !== 'playing') { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.classList.remove('planted', 'ct');
  if (BOMB.exploded) {
    bar.classList.add('planted');
    txt.textContent = '💥 C4 DETONATED';
    tmr.textContent = '0.0s';
    return;
  }
  if (BOMB.planted && BOMB.pos) {
    const left = Math.max(0, BOMB.explodeAt - t);
    if (left <= 10.0 && left > 0 && !BOMB._tenSecWarned && !G.roundEnding) {
      BOMB._tenSecWarned = true;
      AudioSys.tenSecWarning();
    }
    bar.classList.add('planted');
    txt.textContent = `💣 BOMB ON ${BOMB.site} — DEFUSE!`;
    tmr.textContent = left.toFixed(1) + 's';
  } else if (BOMB.droppedPos) {
    txt.textContent = `BOMB DROPPED — UNSTABLE, DO NOT SHOOT`;
    tmr.textContent = 'SITE ' + (BOMB.targetSite || 'A');
  } else if (BOMB.carrier && BOMB.carrier.alive) {
    bar.classList.add('ct');
    txt.textContent = `💣 ${BOMB.carrier.short} heading ${BOMB.targetSite}`;
    tmr.textContent = 'STOP THE PLANT';
  } else if (player.hasBomb && !BOMB.planted && (player.team || 'ct') === 't') {
    bar.classList.add('ct');
    txt.textContent = `💣 YOU — PLANT ON A / B`;
    tmr.textContent = 'HOLD E IN SITE';
  } else if (BOMB.carrierId != null && (player.team || 'ct') === 't' && Net.remotes.get(BOMB.carrierId)) {
    txt.textContent = `💣 ${String(Net.remotes.get(BOMB.carrierId).name || 'T').slice(0, 16)} HAS THE BOMB`;
    tmr.textContent = 'SITE ' + (BOMB.targetSite || 'A');
  } else {
    txt.textContent = 'BOMB IN PLAY';
    tmr.textContent = 'SITE ' + (BOMB.targetSite || 'A');
  }
}
export function updateInteractHUD(label, frac, isDefuse) {
  const bar = $('interact-bar');
  if (!bar) return;
  if (!label) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('interact-label').textContent = label;
  const f = $('interact-fill');
  f.style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
  f.classList.toggle('defuse', !!isDefuse);
}

// Per-frame bomb tick: beeps, LED pulse, explosion, player defuse, HUD.
let _held = null; // 'plant' | 'defuse' when the local player held E on the bomb this frame
export function updateBomb(dt, t) {
  _held = null;
  updateBombInner(dt, t);
  // Online: let go of E / walked off / died → tell the server and restart the bar (CS rule).
  if (BOMB._netHold && BOMB._netHold !== _held) {
    if (BOMB._netHold === 'plant' && BOMB.planter === 'player') { BOMB.plantProgress = 0; BOMB.planter = null; BOMB.plantSite = null; }
    if (BOMB._netHold === 'defuse' && BOMB.defuser === 'player') { BOMB.defuseProgress = 0; BOMB.defuser = null; }
    try { netHold(null); } catch {}
  }
}
function updateBombInner(dt, t) {
  const srv = isServerMatch();
  if (G.phase !== 'playing') { updateInteractHUD(null); return; }
  // Planted: beeping accelerates + LED pulse + explosion on timer.
  if (BOMB.planted && BOMB.pos && !G.roundEnding) {
    const left = BOMB.explodeAt - t;
    if (left <= 0 && !srv) { explodeBomb(t); updateInteractHUD(null); return; } // online: wait for the server's 'explode'
    // Beep interval shrinks as detonation nears (CS-like urgency).
    const interval = left > 20 ? 1.0 : left > 10 ? 0.55 : 0.28;
    if (t - BOMB.beepAt > interval) {
      BOMB.beepAt = t;
      AudioSys.beep(left < 10, BOMB.pos);
      if (BOMB.mesh && BOMB.mesh.userData.led) {
        BOMB.mesh.userData.led.material.emissiveIntensity = 4;
        setTimeout(() => { if (BOMB.mesh && BOMB.mesh.userData.led) BOMB.mesh.userData.led.material.emissiveIntensity = 1.2; }, 120);
      }
      if (BOMB.light) BOMB.light.intensity = left < 10 ? 3.2 : 1.8;
    }
    // --- Player defuse (CT only, hold E near bomb) ---
    let showDefuse = false;
    if (player.alive && !G.roundEnding && (player.team || 'ct') === 'ct') {
      const d = Math.hypot(player.pos.x - BOMB.pos.x, player.pos.z - BOMB.pos.z);
      if (d < 2.8 && player.onGround) {
        if (keys['KeyE']) {
          // One defuser at a time. Taking over from a bot restarts the bar (CS rule),
          // and the frame stamp stops player + bot both advancing the same bar.
          bombAdvanceDefuse('player', dt, t);
          showDefuse = true; _held = 'defuse';
          if (srv) netHold('defuse');
          if (Math.floor(t * 2) !== Math.floor((t - dt) * 2)) AudioSys.defuseTick(BOMB.pos);
          updateInteractHUD('DEFUSING…', BOMB.defuseProgress / BOMB_DEFUSE_TIME, true);
          if (BOMB.defuseProgress >= BOMB_DEFUSE_TIME) {
            if (srv) { // server confirms (or denies) — keep the full bar while we wait
              BOMB.defuseProgress = BOMB_DEFUSE_TIME;
              netRequest({ action: 'defuse' }, t);
              updateBombHUD(t);
              return;
            }
            updateInteractHUD(null);
            defuseBomb(true, t);
            return;
          }
        } else {
          // In range but not holding E — prompt.
          updateInteractHUD('HOLD E TO DEFUSE', BOMB.defuseProgress / BOMB_DEFUSE_TIME, true);
          showDefuse = true;
          // Released E: keep the bar *and* the ownership. Clearing the owner here
          // meant resuming silently restarted the defuse from zero.
        }
      }
    }
    // --- Bot defuse progress bar (when a CT bot is defusing and player isn't) ---
    if (!showDefuse) {
      if (BOMB.defuser && BOMB.defuser !== 'player' && BOMB.defuser.alive) {
        const dd = BOMB.defuser.pos.distanceTo(BOMB.pos);
        if (dd < 3.2) updateInteractHUD(`${BOMB.defuser.short.toUpperCase()} DEFUSING…`, BOMB.defuseProgress / BOMB_DEFUSE_TIME, true);
        else updateInteractHUD(null);
      } else if (BOMB.plantingBot && BOMB.plantingBot.alive && !BOMB.planted) {
        // handled below
      } else {
        updateInteractHUD(null);
      }
    }
    // Nobody advanced the bar this frame (died, walked off, let go of E) — decay it.
    // The old `!showDefuse` guard meant a CT standing on the bomb *not* defusing
    // froze the bar at 99% indefinitely, so any teammate could finish it instantly.
    if (BOMB.defuseProgress > 0 && BOMB._defuseAdvT !== t) {
      BOMB.defuseProgress = Math.max(0, BOMB.defuseProgress - dt * 0.6);
      if (BOMB.defuseProgress <= 0) BOMB.defuser = null;
    }
    updateBombHUD(t);
    return;
  }
  // --- T-side player pickup + plant (hold E inside a site) — works in solo and PvP ---
  if (!BOMB.planted && !G.roundEnding && player.alive && (player.team || 'ct') === 't') {
    // Pickup dropped bomb by walking over it.
    if (BOMB.droppedPos && !player.hasBomb) {
      if (srv) { if (player.pos.distanceTo(BOMB.droppedPos) < 1.8) netRequest({ action: 'pickup' }, t); }
      else if (player.pos.distanceTo(BOMB.droppedPos) < 1.8) {
        player.hasBomb = true; BOMB.droppedPos = null;
        bombClearMesh();
        announce('YOU PICKED UP THE BOMB — PLANT ON A OR B (HOLD E)', 1800);
        AudioSys.plantBeep();
        updateBombHUD(t);
      }
    }
    // Plant inside either site while holding E.
    if (player.hasBomb && !BOMB.planted && !isFreeze()) {
      const inSite = siteAt(player.pos);
      // THE bug: the old code refused to even start the bar whenever any CT stood
      // within 10m — and said nothing, so holding E on the site just did nothing.
      // CS lets you plant under fire; getting shot is the interrupt, not proximity.
      if (inSite && !bombPlantBusy('player', t)) {
        if (!player.onGround) {
          // No mid-air plants.
          updateInteractHUD('LAND TO PLANT', BOMB.plantProgress / BOMB_PLANT_TIME, false);
          bombDecayPlant(dt, t);
          updateBombHUD(t);
          return;
        }
        if (keys['KeyE']) {
          const prog = bombAdvancePlant('player', inSite, dt, t);
          _held = 'plant';
          if (srv) netHold('plant');
          updateInteractHUD(`PLANTING ON ${inSite.name}…`, prog / BOMB_PLANT_TIME, false);
          if (Math.floor(t * 4) !== Math.floor((t - dt) * 4)) AudioSys.defuseTick(inSite.pos);
          if (prog >= BOMB_PLANT_TIME) {
            if (srv) {
              BOMB.plantProgress = BOMB_PLANT_TIME;
              netRequest({ action: 'plant', site: inSite.name, x: player.pos.x, z: player.pos.z }, t);
              updateBombHUD(t);
              return;
            }
            updateInteractHUD(null);
            plantBombByPlayer(inSite, t);
            return;
          }
          updateBombHUD(t);
          return;
        }
        updateInteractHUD(`HOLD E TO PLANT ON ${inSite.name}`, BOMB.plantProgress / BOMB_PLANT_TIME, false);
        bombDecayPlant(dt, t);
        updateBombHUD(t);
        return;
      }
    }
  }
  // Walked out of the site / died / lost the bomb: bleed the bar off. Previously it
  // just froze, so you could bank 3.1s of plant, leave, and finish instantly later.
  bombDecayPlant(dt, t);
  // Not planted: show carrier plant progress if actively planting.
  // Cooking a nade owns the interact bar — don't let the bomb tick wipe it.
  if (BOMB.plantingBot && BOMB.plantingBot.alive && BOMB.plantProgress > 0.05) {
    updateInteractHUD(`BOMB PLANTING ON ${BOMB.targetSite} — STOP THEM!`, BOMB.plantProgress / BOMB_PLANT_TIME, false);
  } else {
    // Player near dropped bomb? Just informational (CT can't pick up).
    if (!(isMultiplayer() && (player.team || 'ct') === 't' && player.hasBomb)) updateInteractHUD(null);
  }
  updateBombHUD(t);
}

