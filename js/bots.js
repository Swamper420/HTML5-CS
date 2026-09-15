// js/bots.js — AGENTS: Bot AI: creation/reset, target selection, objectives, think + per-frame update (plant/defend/defuse), shooting, hearing.
// Ownership: makeBot, resetBot, botThink, updateBot, botShoot, animateBotMesh. Pathing is in botnav.js.

import * as THREE from 'three';
import { AudioSys } from './audio.js';
import { BOMB_DEFUSE_TIME, BOMB_PLANT_TIME } from './config.js';
import { opts } from './settings.js';
import { clamp, rand, randPick } from './utils.js';
import { animateSoldier, damp, soldierFireKick } from './anim.js';
import {
  BOMB, bombAdvanceDefuse, bombAdvancePlant, bombClearMesh, bombDefuseBusy, bombPlantBusy,
  defuseBomb, plantBomb, siteAt, siteByName, updateBombHUD,
} from './bomb.js';
import { BOT_R, botDepenetrate, botDirFree, botOpenHeading, botSeparate, navSteer } from './botnav.js';
import { hasLOS, moveWithCollision } from './collision.js';
import { fireHitscan } from './combat.js';
import { restoreSoldierMesh } from './gibs.js';
import { botThrowNadeAt } from './grenades.js';
import { setSoldierGun } from './gunmodels.js';
import { announce } from './hud.js';
import { waypoints } from './map.js';
import { inFire } from './molotov.js';
import { isMultiplayer } from './multiplayer.js';
import { scene } from './render.js';
import { _smokePt, hasLOSClear, smokeBlocks, smokePushAt, smokeSlowAt } from './smoke.js';
import { makeBlob, makeSoldier, updateBlob } from './soldier.js';
import { botDefaultSlot, spawnPoint, spawnYawMesh } from './spawns.js';
import { G, bots, isFreeze, player } from './state.js';

export function makeBot(team, idx) {
  const mesh = makeSoldier(team);
  try { setSoldierGun(mesh, 'ak'); } catch (e) {}
  scene.add(mesh);
  const spawn = spawnPoint(team, idx + (team === (player.team || 'ct') ? 1 : 0), 0);
  const bot = {
    team, idx, mesh, pos: spawn.clone(), vel: new THREE.Vector3(),
    yaw: spawnYawMesh(team, spawn), hp: 100, alive: true,
    respawnAt: 0, speed: rand(3.4, 4.6), state: 'roam',
    wp: waypoints.length ? randPick(waypoints).clone() : spawn.clone(), target: null,
    nextThink: Math.random() * 0.5, nextShot: 0, burstLeft: 0, burstAt: 0,
    ammo: 30, reloadUntil: 0,
    strafeDir: 1, strafeAt: 0, flashAt: 0, walkPhase: Math.random() * 6,
    flinchT: 0, flinchHead: false, deathT: 0, blob: null,
    hasBomb: false, guardSite: team === 'ct' ? (idx < 2 ? 'A' : 'B') : null,
    siteOffset: new THREE.Vector3(rand(-2, 2), 0, rand(-2, 2)),
    planting: false, defusing: false,
    blindUntil: 0,
    nades: team === 't' ? { he: 1, flash: 1, smoke: 1, molotov: 0 } : { he: 1, flash: 1, smoke: 0, molotov: 1 },
    _nadeAt: 0, _smokeAt: 0, _molyAt: 0,
    name: (team === 'ct' ? ['Blaze', 'Falcon', 'Havoc', 'Ghost'][idx] : ['Viper', 'Rattler', 'Jackal', 'Scorpion'][idx]) + (team === 'ct' ? ' [CT]' : ' [T]'),
    short: team === 'ct' ? ['Blaze', 'Falcon', 'Havoc', 'Ghost'][idx] : ['Viper', 'Rattler', 'Jackal', 'Scorpion'][idx],
    kills: 0, deaths: 0, assists: 0,
  };
  mesh.position.copy(spawn);
  mesh.rotation.y = bot.yaw;
  try { bot.blob = makeBlob(1.25); if (bot.blob) bot.blob.position.set(spawn.x, 0.02, spawn.z); } catch (e) {}
  bots.push(bot);
  return bot;
}
export function resetBot(bot) {
  bot.pos.copy(spawnPoint(bot.team, botDefaultSlot(bot)));
  bot.yaw = spawnYawMesh(bot.team, bot.pos);
  bot.hp = 100; bot.alive = true;
  bot.flinchT = 0; bot.flinchHead = false; bot.deathT = 0; bot._thudded = false; bot.exploded = false;
  bot.ammo = 30; bot.reloadUntil = 0; bot._animPrev = null; bot._vx = 0; bot._vz = 0;
  if (bot.mesh && bot.mesh.userData) bot.mesh.userData.anim = null;
  bot.headless = false; bot.gibbed = false; bot.fall = null; bot.knock = null; bot.deathPos = null;
  bot.wp = waypoints.length ? randPick(waypoints).clone() : bot.pos.clone();
  bot.target = null; bot.state = 'roam'; bot.mesh.visible = true;
  bot.path = null; bot.pathI = 0; bot._stuckT = 0; bot._stuckN = 0; bot._unstick = null;
  bot.lastSeenPos = null; bot.lastSeenAt = 0; bot.heardPos = null; bot.huntPos = null; bot._tgtKey = null;
  bot.reactAt = 0; bot._lookAt = null; bot._moving = false; bot.viaDone = false; bot.viaI = 0;
  try { botDepenetrate(bot); } catch (e) {}
  bot.hasBomb = false; bot.planting = false; bot.defusing = false;
  bot.blindUntil = 0; bot._nadeAt = 0; bot._smokeAt = 0; bot._molyAt = 0;
  bot.nades = bot.team === 't' ? { he: 1, flash: 1, smoke: 1, molotov: 0 } : { he: 1, flash: 1, smoke: 0, molotov: 1 };
  bot.siteOffset.set(rand(-2, 2), 0, rand(-2, 2));
  // CTs split to guard A/B; T objective assigned per-round in bombResetRound().
  if (bot.team === 'ct') bot.guardSite = bot.idx % 2 === 0 ? 'A' : 'B';
  try { restoreSoldierMesh(bot.mesh); } catch (e) {}
  bot.mesh.rotation.set(0, bot.yaw, 0);
  bot.mesh.position.copy(bot.pos);
  try { if (bot.blob) { bot.blob.visible = true; bot.blob.position.set(bot.pos.x, 0.02, bot.pos.z); } } catch (e) {}
}

export function botEye(b) { return new THREE.Vector3(b.pos.x, b.pos.y + 1.55, b.pos.z); }
export function botChest(b) { return new THREE.Vector3(b.pos.x, b.pos.y + 1.1, b.pos.z); }

function nearestEnemy(bot) {
  // Flashed bots see nothing (they wander until vision returns).
  try { if (bot.blindUntil && performance.now() / 1000 < bot.blindUntil) return null; } catch (e) {}
  let best = null, bestD = 1e9;
  const eye = botEye(bot);
  // Dynamic smokes deny vision: walls + smoke volumes both block acquisition.
  const vis = (p) => hasLOSClear(eye, p);
  // player? team-based (PvP-safe): bots only acquire opposite-team locals.
  if (player.alive && (player.team || 'ct') !== bot.team) {
    const p = new THREE.Vector3(player.pos.x, player.pos.y + 1.3 - 0.36 * (player.crouch || 0), player.pos.z);
    const d = eye.distanceTo(p);
    if (d < 55 && vis(p) && d < bestD) { bestD = d; best = { type: 'player', d }; }
  }
  for (const o of bots) {
    if (!o.alive || o.team === bot.team) continue;
    if (o.team === 'ct' && bot.team === 'ct') continue;
    const p = botChest(o);
    const d = eye.distanceTo(p);
    const visRange = bot.team === 't' ? 55 : 50;
    if (d < visRange && d < bestD && vis(p)) { bestD = d; best = { type: 'bot', bot: o, d }; }
  }
  // Team-based: drop player target if same team (covers solo T vs CT bots).
  if (best && best.type === 'player' && (player.team || 'ct') === bot.team) best = null;
  return best;
}

export function objectiveWaypoint(bot) {
  // Defusal objectives — T pushes target site, CTs guard / retake.
  if (BOMB.planted && BOMB.pos) {
    // Both teams converge on the planted site (with personal offset so they don't stack).
    return new THREE.Vector3(BOMB.pos.x + bot.siteOffset.x * 0.7, 0, BOMB.pos.z + bot.siteOffset.z * 0.7);
  }
  if (bot.team === 't') {
    // Dropped bomb recovery: nearest living T goes to pick it up.
    if (BOMB.droppedPos && !BOMB.planted) {
      // Carrier-less Ts head for the dropped bomb; carrier itself never exists here.
      return BOMB.droppedPos.clone();
    }
    const tgt = siteByName(BOMB.targetSite || 'A');
    // Split the push like a real team: half take the side lane (long A / B tunnels),
    // half come through mid, then everyone collapses onto the site.
    if (!bot.viaDone) {
      const sz = tgt.z < 0 ? -1 : 1;
      const route = (bot.idx % 2 === 0)
        ? [[-26, 22], [0, 24], [20, 30]]   // outer lane (long A / B tunnels)
        : [[-10, 6], [4, 4]];              // through the middle
      let vi = bot.viaI || 0;
      while (vi < route.length) {
        const [vx, vz] = route[vi];
        if (Math.hypot(bot.pos.x - vx, bot.pos.z - sz * vz) < 3.5 || bot.pos.x > vx + 3) vi++; else break;
      }
      bot.viaI = vi;
      if (vi >= route.length) bot.viaDone = true;
      else return new THREE.Vector3(route[vi][0] + bot.siteOffset.x * 0.4, 0, sz * route[vi][1] + bot.siteOffset.z * 0.4);
    }
    if (bot.hasBomb) return new THREE.Vector3(tgt.x + rand(-1, 1), 0, tgt.z + rand(-1, 1));
    // Escorts: push the same site with a spread so the team arrives together.
    return new THREE.Vector3(tgt.x + bot.siteOffset.x * 1.6, 0, tgt.z + bot.siteOffset.z * 1.6);
  } else {
    // CT: hold assigned site pre-plant (slight patrol via think jitter).
    const g = siteByName(bot.guardSite || (bot.idx % 2 === 0 ? 'A' : 'B'));
    return new THREE.Vector3(g.x + bot.siteOffset.x * 1.4, 0, g.z + bot.siteOffset.z * 1.4);
  }
}

export function botThink(bot, t) {
  bot.nextThink = t + rand(0.22, 0.45);
  const prevKey = bot._tgtKey || null;
  bot.target = nearestEnemy(bot);
  if (bot.target) {
    const key = bot.target.type === 'player' ? 'player' : bot.target.bot;
    const tp = bot.target.type === 'player' ? player.pos : bot.target.bot.pos;
    // Fresh contact (not just a flicker of the same fight): human reaction delay + an
    // initial aim error that settles as the bot tracks.
    if (key !== prevKey && (!bot.lastSeenAt || t - bot.lastSeenAt > 1.2)) {
      const diff = opts.difficulty || 1;
      bot.reactAt = t + rand(0.18, 0.42) / diff;
      if (!bot.aimOff) bot.aimOff = new THREE.Vector3();
      const e = rand(0.5, 1.2) / diff;
      bot.aimOff.set(rand(-e, e), rand(-e * 0.5, e * 0.8), rand(-e, e));
    }
    bot._tgtKey = key;
    if (!bot.lastSeenPos) bot.lastSeenPos = new THREE.Vector3();
    bot.lastSeenPos.set(tp.x, 0, tp.z); bot.lastSeenAt = t;
    if (bot.state !== 'combat') { bot.strafeAt = t + rand(0.5, 1.4); if (Math.random() < 0.5) bot.strafeDir *= -1; }
    bot.state = 'combat';
    { const ow = objectiveWaypoint(bot); if (ow.distanceTo(bot.wp) > 3) bot.wp.copy(ow); } // keep route progress during long-range contact
  } else {
    bot._tgtKey = null;
    // Lost sight / heard shots: go check where the enemy was, instead of forgetting.
    const huntPos = (bot.lastSeenPos && t - bot.lastSeenAt < 6) ? bot.lastSeenPos
      : (bot.heardPos && t - bot.heardAt < 5) ? bot.heardPos : null;
    const busyObjective = bot.hasBomb || (BOMB.planted && bot.team === 'ct') || bot.planting || bot.defusing;
    // Pre-plant CTs only clear nearby angles — they don't abandon their site to chase.
    const leashOk = !huntPos || !(bot.team === 'ct' && !BOMB.planted) || (() => {
      const g = siteByName(bot.guardSite || 'A');
      return !g || Math.hypot(huntPos.x - g.x, huntPos.z - g.z) < 13;
    })();
    // Pre-plant Ts stick to their lane; they only check contacts close to them.
    const tLeash = !huntPos || bot.team !== 't' || BOMB.planted || bot.pos.distanceTo(huntPos) < 11;
    if (huntPos && !busyObjective && leashOk && tLeash && bot.pos.distanceTo(huntPos) < 22) {
      bot.state = 'hunt'; bot.huntPos = huntPos;
    } else {
      bot.state = 'objective';
      const ow = objectiveWaypoint(bot);
      // Only re-target when the objective really changed or we've arrived — constant
      // re-rolling made bots jitter between points.
      if (ow.distanceTo(bot.wp) > 3 || (bot.pos.distanceTo(bot.wp) < 1.6 && Math.random() < 0.25)) bot.wp.copy(ow);
      // Holding CTs shuffle a little every few seconds, like a person fidgeting on an angle.
      if (bot.team === 'ct' && !BOMB.planted && bot.pos.distanceTo(bot.wp) < 1.6 && t > (bot._shuffleAt || 0)) {
        bot._shuffleAt = t + rand(5, 11);
        bot.siteOffset.set(rand(-2.5, 2.5), 0, rand(-2.5, 2.5));
        bot.wp.copy(objectiveWaypoint(bot));
      }
    }
  }
  if (bot.target && Math.random() < 0.3) { bot.burstLeft = 2 + (Math.random() * 3 | 0); bot.burstAt = t; }
}

// Drive a bot's rig from how it actually moved this frame. Reading real
// displacement (rather than the AI's intent) means collisions, stuck-on-corner
// stalls and knockback all read correctly in the legs.
export function animateBotMesh(bot, dt, t) {
  const m = bot.mesh;
  if (!m || !m.userData || !m.userData.rig) return;
  if (!bot.alive) return; // ragdoll owns the mesh once dead
  if (!bot._animPrev) bot._animPrev = bot.pos.clone();
  const inv = dt > 1e-4 ? 1 / dt : 0;
  bot._vx = damp(bot._vx || 0, (bot.pos.x - bot._animPrev.x) * inv, 16, dt);
  bot._vz = damp(bot._vz || 0, (bot.pos.z - bot._animPrev.z) * inv, 16, dt);
  bot._animPrev.copy(bot.pos);
  // Look down the line to whatever it is aiming at.
  let pitch = 0;
  try {
    const tg = bot.target;
    const tp = tg ? (tg.type === 'player' ? player.pos : (tg.bot && tg.bot.alive ? tg.bot.pos : null)) : null;
    if (tp) {
      const dh = Math.hypot(tp.x - bot.pos.x, tp.z - bot.pos.z);
      pitch = clamp(Math.atan2((tp.y + 1.2) - (bot.pos.y + 1.55), Math.max(0.4, dh)), -1.1, 1.1);
    }
  } catch (e) {}
  animateSoldier(m, {
    vx: bot._vx, vz: bot._vz, yaw: m.rotation.y, pitch,
    grounded: true,
    crouch: !!bot.crouching,
    kneel: !!(bot.planting || bot.defusing),
    reloading: !!(bot.reloadUntil && t < bot.reloadUntil),
  }, dt, t);
}

function botShoot(bot, t, targetPos) {
  const diff = opts.difficulty;
  const interval = rand(0.35, 0.7) / diff;
  if (t < bot.nextShot) return;
  // Magazines: bots now run dry and reload, which is where the reload pose comes from.
  if (t < (bot.reloadUntil || 0)) return;
  if (bot.ammo <= 0) {
    bot.reloadUntil = t + rand(2.1, 2.6);
    bot.ammo = 30; bot.burstLeft = 0;
    try { AudioSys.step(new THREE.Vector3(bot.pos.x, 1.0, bot.pos.z), false); } catch (e) {}
    return;
  }
  bot.ammo--;
  bot.nextShot = t + interval;
  const from = botEye(bot);
  const dist = from.distanceTo(targetPos);
  // Like a real player: shots fired on the move are far less accurate than planted ones.
  const spread = clamp(0.02 + dist * 0.0016, 0.02, 0.09) / Math.sqrt(diff) * (bot._moving ? 1.5 : 1);
  const dir = targetPos.clone().sub(from).normalize();
  dir.x += rand(-spread, spread); dir.y += rand(-spread, spread); dir.z += rand(-spread, spread);
  dir.normalize();
  fireHitscan({ team: bot.team, isPlayer: false, bot }, from, dir, { name: 'AK-47', damage: 11 * diff, headMult: 2.2, range: 90, tracer: 0xff9a5c, sound: 'rifle' }, t);
  bot.flashAt = t + 0.05;
  soldierFireKick(bot.mesh, 0.85);
}
// Gunfire gives away position: nearby enemy bots turn toward it and may go check.
export function botsHearShot(shooter, origin, t) {
  if (!shooter || isMultiplayer()) return;
  for (const b of bots) {
    if (!b.alive || b.team === shooter.team || (shooter.bot && shooter.bot === b)) continue;
    const d = Math.hypot(b.pos.x - origin.x, b.pos.z - origin.z);
    if (d > 40) continue;
    b._lookAt = new THREE.Vector3(origin.x, 0, origin.z);
    b._lookUntil = t + rand(1.5, 3);
    if (!b.target && (!b.lastSeenAt || t - b.lastSeenAt > 2)) {
      const err = d * 0.12;
      b.heardPos = new THREE.Vector3(origin.x + rand(-err, err), 0, origin.z + rand(-err, err));
      b.heardAt = t;
    }
    if (b.nextThink > t + 0.25) b.nextThink = t + rand(0.12, 0.3); // reaction, not telepathy
  }
}

// bot per-frame update (defusal-aware: plant / defend / defuse / recover)
export function updateBot(bot, dt, t) {
  const m = bot.mesh;
  if (isMultiplayer()) return; // pure PvP — bots stay hidden/dead
  if (!bot.alive) return; // CS: no mid-round respawns — wait for next round
  if (isFreeze()) { // frozen: hold position, no thinking/shooting
    m.position.copy(bot.pos);
    bot.planting = false; bot.defusing = false;
    return;
  }
  botDepenetrate(bot);
  if (t >= bot.nextThink) botThink(bot, t);
  let moveDir = null, speed = bot.speed;

  // --- Flash blindness: stagger in place, no shooting/thinking (CS full white) ---
  if (bot.blindUntil && t < bot.blindUntil) {
    // drift + cover eyes: slow stumble, yaw wanders
    bot.yaw += Math.sin(t * 3.1 + bot.idx * 2) * dt * 1.6;
    bot.target = null;
    m.position.copy(bot.pos);
    let dyB = bot.yaw - m.rotation.y;
    while (dyB > Math.PI) dyB -= Math.PI * 2; while (dyB < -Math.PI) dyB += Math.PI * 2;
    m.rotation.y += dyB * Math.min(1, dt * 4);
    try { updateBlob(bot, bot.pos.x, bot.pos.z, true, false); } catch (e) {}
    return;
  }

  // --- Molotov avoidance: never path through fire; flee if standing in it ---
  let fleeingFire = null;
  try {
    const myFire = inFire(bot.pos, 0.2);
    if (myFire) {
      const ax = bot.pos.x - myFire.pos.x, az = bot.pos.z - myFire.pos.z;
      const ad = Math.hypot(ax, az) || 1;
      moveDir = new THREE.Vector3(ax / ad, 0, az / ad);
      fleeingFire = moveDir.clone();
      speed = bot.speed * 1.25; // run out of the flames
      bot.wp.copy(objectiveWaypoint(bot)); // repath after escaping
    } else if (bot.wp && inFire(bot.wp, 0.6)) {
      // waypoint inside flames — sidestep to a free neighbor instead of walking in
      bot.wp.copy(objectiveWaypoint(bot));
      if (Math.random() < 0.6 && waypoints.length) {
        for (let tries = 0; tries < 6; tries++) {
          const cand = randPick(waypoints);
          if (!inFire(cand, 0.8)) { bot.wp.copy(cand); break; }
        }
      }
    }
    // CT molotov area-denial: toss at chokes when Ts push the guarded site
    if (!myFire && bot.team === 'ct' && (bot.nades.molotov || 0) > 0 && !BOMB.planted && !G.roundEnding && t > (bot._molyAt || 0)) {
      const guard = siteByName(bot.guardSite || 'A');
      let tNear = null;
      for (const o of bots) {
        if (!o.alive || o.team !== 't') continue;
        if (guard && Math.hypot(o.pos.x - guard.x, o.pos.z - guard.z) < 14) { tNear = o; break; }
      }
      if (tNear && bot.pos.distanceTo(tNear.pos) < 20 && bot.pos.distanceTo(tNear.pos) > 6) {
        bot.nades.molotov--;
        bot._molyAt = t + rand(18, 30);
        const aim = tNear.pos.clone().add(new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1)));
        botThrowNadeAt(bot, 'molotov', aim);
      }
    }
    // T smoke cover: pop site entries while pushing (once per push, mid-range)
    if (!myFire && bot.team === 't' && (bot.nades.smoke || 0) > 0 && !BOMB.planted && !G.roundEnding && t > (bot._smokeAt || 0)) {
      const tgt = siteByName(BOMB.targetSite || 'A');
      if (tgt) {
        const dSite = Math.hypot(bot.pos.x - tgt.x, bot.pos.z - tgt.z);
        if (dSite < 18 && dSite > 6) {
          bot.nades.smoke--;
          bot._smokeAt = t + rand(20, 34);
          botThrowNadeAt(bot, 'smoke', new THREE.Vector3(tgt.x + rand(-2, 2), 0, tgt.z + rand(-2, 2)));
        }
      }
    }
  } catch (e) {}

  // --- Bomb pickup (T walks over dropped bomb) ---
  if (bot.team === 't' && !BOMB.planted && BOMB.droppedPos && !BOMB.carrier) {
    if (bot.pos.distanceTo(BOMB.droppedPos) < 1.6) {
      BOMB.carrier = bot; bot.hasBomb = true; BOMB.droppedPos = null;
      bombClearMesh();
      announce(`${bot.short} PICKED UP THE BOMB`, 1400);
      AudioSys.plantBeep();
      bot.wp.copy(objectiveWaypoint(bot));
      updateBombHUD(t);
    }
  }

  // --- Plant attempt (carrier standing in ANY bombsite, holds still) ---
  // Was: only BOMB.targetSite counted, so a carrier that rotated to the other site
  // could stand on the plant spot forever and never arm. Any site is a legal plant.
  let isPlanting = false;
  if (bot.team === 't' && bot.hasBomb && !BOMB.planted && !G.roundEnding && !isFreeze()) {
    const tgt = siteAt(bot.pos);
    if (tgt) {
      // Only a point-blank fight aborts it. At 12m the carrier basically never
      // committed, so Ts routinely ran the clock out standing on the site.
      const enemyClose = bot.target && bot.target.d < 5;
      if (!enemyClose && !bombPlantBusy(bot, t)) {
        isPlanting = true;
        bot.planting = true;
        BOMB.plantingBot = bot;
        // Face site center while planting.
        bot.yaw = Math.atan2(tgt.x - bot.pos.x, tgt.z - bot.pos.z);
        bombAdvancePlant(bot, tgt, dt, t);
        // Audio tick each ~0.8s while planting (positional so CTs can hear it).
        if (!bot._plantTick || t - bot._plantTick > 0.8) {
          bot._plantTick = t;
          try { AudioSys.click(980, 0.06, 0.3, new THREE.Vector3(bot.pos.x, 1.2, bot.pos.z)); }
          catch (e) { AudioSys.click(980, 0.06, 0.3); }
        }
        if (BOMB.plantProgress >= BOMB_PLANT_TIME) {
          plantBomb(bot, tgt, t);
          bot.planting = false;
          return; // planted — next frames defend.
        }
      }
    }
  }
  if (!isPlanting && BOMB.plantingBot === bot) { BOMB.plantingBot = null; }
  if (!isPlanting) bot.planting = false;
  // Decay now happens once per frame in updateBomb(). Doing it here drained the bar
  // once per living bot, so an interrupted plant reset ~10x too fast on a full server.

  // --- Defuse attempt (CT near planted bomb, holds still) ---
  let isDefusing = false;
  if (bot.team === 'ct' && BOMB.planted && BOMB.pos && !G.roundEnding) {
    const dBomb = bot.pos.distanceTo(BOMB.pos);
    if (dBomb < 2.6) {
      const tAlive = bots.some((o) => o.alive && o.team === 't');
      const enemyClose = bot.target && bot.target.d < 6 && tAlive;
      // Only the closest CT defuses; others cover. If no defuser yet, claim it.
      // `!BOMB.defuser.alive` was true when the defuser was the string 'player',
      // so bots happily stole the bar out from under a defusing human.
      const claimable = !bombDefuseBusy(bot, t);
      if (!enemyClose && claimable) {
        // Check this bot is (one of) the closest — avoids 3 bots stacking on bomb.
        let closest = bot, bestD = dBomb;
        for (const o of bots) {
          if (!o.alive || o.team !== 'ct' || o === bot) continue;
          const dd = o.pos.distanceTo(BOMB.pos);
          if (dd < bestD) { bestD = dd; closest = o; }
        }
        if (closest === bot) {
          isDefusing = true;
          bot.defusing = true;
          bot.yaw = Math.atan2(BOMB.pos.x - bot.pos.x, BOMB.pos.z - bot.pos.z);
          // NB: don't set BOMB.defuser here — bombAdvanceDefuse() must see the owner
          // change so taking over from someone else restarts the bar.
          bombAdvanceDefuse(bot, dt, t);
          if (!bot._defTick || t - bot._defTick > 0.5) { bot._defTick = t; AudioSys.defuseTick(BOMB.pos); }
          if (BOMB.defuseProgress >= BOMB_DEFUSE_TIME) {
            defuseBomb(false, t);
            return;
          }
        }
      }
    }
  }
  // Ownership is sticky and decays in updateBomb(); clearing it here threw away a
  // nearly-finished defuse the instant the bot flinched off the bomb for one frame.
  if (!isDefusing) bot.defusing = false;

  // Planting / defusing bots stand still and don't shoot (CS interaction locks weapon).
  if (isPlanting || isDefusing) {
    m.position.copy(bot.pos);
    let dy0 = bot.yaw - m.rotation.y;
    while (dy0 > Math.PI) dy0 -= Math.PI * 2; while (dy0 < -Math.PI) dy0 += Math.PI * 2;
    m.rotation.y += dy0 * Math.min(1, dt * 10);
    return; // the kneel pose is driven by animateBotMesh()
  }

  if (bot.state === 'combat' && bot.target) {
    // burning bots don't strafe-shoot — they run
    if (fleeingFire) {
      moveDir = fleeingFire;
      speed = bot.speed * 1.25;
      bot.yaw = Math.atan2(moveDir.x, moveDir.z);
    } else {
    let tp = null;
    if (bot.target.type === 'player') tp = new THREE.Vector3(player.pos.x, player.pos.y + 1.2 - 0.36 * (player.crouch || 0), player.pos.z);
    else if (bot.target.bot.alive) tp = botChest(bot.target.bot);
    else { bot.target = null; bot.state = 'objective'; }
    if (tp) {
      // face target
      const dx = tp.x - bot.pos.x, dz = tp.z - bot.pos.z;
      bot.yaw = Math.atan2(dx, dz);
      const dist = Math.hypot(dx, dz);
      // Carrier with bomb prefers to break contact and run to site if enemy is far;
      // if enemy is close, fight normally.
      const carrierFleeing = bot.hasBomb && !BOMB.planted && dist > 16;
      if (carrierFleeing) {
        const tgt = siteByName(BOMB.targetSite || 'A');
        const nd = navSteer(bot, new THREE.Vector3(tgt.x, 0, tgt.z), t, 1.0);
        if (nd) moveDir = new THREE.Vector3(nd.x, 0, nd.z);
        // Still snap-shoot while fleeing if very close? No — run.
      } else if (dist > 24 && bot.state === 'combat' && (bot.team === 't' || !BOMB.planted)) {
        // Long range: nobody sane stands in the open trading at 25m+. Keep moving to
        // the objective/lane (the route hugs cover) and take shots when they line up.
        const nd = navSteer(bot, bot.wp, t, 1.5);
        if (nd) { moveDir = new THREE.Vector3(nd.x, 0, nd.z); speed *= 0.85; }
        if (dist < 50) {
          const eye = botEye(bot);
          if (hasLOSClear(eye, tp)) {
            if (bot.aimOff) bot.aimOff.multiplyScalar(Math.exp(-dt * 2.6));
            if (t >= (bot.reactAt || 0)) botShoot(bot, t, bot.aimOff ? tp.clone().add(bot.aimOff) : tp.clone());
          }
        }
      } else {
        // strafe perpendicular, keep ideal range 8-18
        if (t > bot.strafeAt) { bot.strafeAt = t + rand(0.6, 1.5); bot.strafeDir *= -1; }
        const nx = dx / (dist || 1), nz = dz / (dist || 1);
        let mx = -nz * bot.strafeDir, mz = nx * bot.strafeDir;
        if (dist > 18) { mx += nx * 0.9; mz += nz * 0.9; }
        else if (dist < 7) { mx -= nx; mz -= nz; }
        moveDir = new THREE.Vector3(mx, 0, mz).normalize();
        // Don't strafe into a wall: reverse, and if both sides are blocked just hold.
        if (!botDirFree(bot, moveDir.x, moveDir.z)) {
          bot.strafeDir *= -1; bot.strafeAt = t + rand(0.6, 1.2);
          mx = -nz * bot.strafeDir; mz = nx * bot.strafeDir;
          if (dist > 18) { mx += nx * 0.9; mz += nz * 0.9; } else if (dist < 7) { mx -= nx; mz -= nz; }
          moveDir.set(mx, 0, mz).normalize();
          if (!botDirFree(bot, moveDir.x, moveDir.z)) moveDir = null;
        }
        // Counter-strafe rhythm: shift, stop, shoot, shift again.
        if (t > (bot._stopPhaseT || 0)) {
          bot._stopShoot = !bot._stopShoot;
          bot._stopPhaseT = t + (bot._stopShoot ? rand(0.35, 0.8) : rand(0.35, 0.9));
        }
        if (bot._stopShoot && dist < 35) moveDir = null;
        speed *= 0.7;
        // shoot if roughly LOS + aimed — smokes deny the shot (vision blocked)
        // combat HE/flash: close-range bots sometimes trade bullets for utility
        try {
          if ((bot.nades.he || 0) > 0 && dist > 9 && dist < 24 && Math.random() < dt * 0.10 && t > (bot._nadeAt || 0)) {
            bot.nades.he--;
            botThrowNadeAt(bot, 'he', tp.clone());
          } else if ((bot.nades.flash || 0) > 0 && dist > 8 && dist < 26 && Math.random() < dt * 0.08 && t > (bot._nadeAt || 0)) {
            bot.nades.flash--;
            // pop-flash above the enemy so it bursts in their face, then peek
            const pop = tp.clone().add(new THREE.Vector3(rand(-1, 1), 1.6, rand(-1, 1)));
            botThrowNadeAt(bot, 'flash', pop);
          }
        } catch (e) {}
        if (dist < 50) {
          const eye = botEye(bot);
          if (hasLOSClear(eye, tp)) {
            if (bot.aimOff) bot.aimOff.multiplyScalar(Math.exp(-dt * 2.6)); // aim settles while tracking
            const aimAt = bot.aimOff ? tp.clone().add(bot.aimOff) : tp.clone();
            if (t >= (bot.reactAt || 0)) botShoot(bot, t, aimAt);
          } else if (smokeBlocks(eye, tp) && Math.random() < dt * 0.5) {
            // blind-fire suppression through smoke: rare, wild, scary (no wallbang damage here)
            if (Math.random() < 0.3) botShoot(bot, t, tp.clone().add(new THREE.Vector3(rand(-2, 2), rand(-0.5, 1), rand(-2, 2))));
          }
        }
      }
    }
    } // end non-burning combat
  } else if (fleeingFire) {
    moveDir = fleeingFire;
    speed = bot.speed * 1.25;
    bot.yaw = Math.atan2(moveDir.x, moveDir.z);
  } else if (bot.state === 'hunt' && bot.huntPos) {
    // Clear the spot the enemy was last seen/heard, weapon up and facing it.
    const nd = navSteer(bot, bot.huntPos, t, 1.4);
    if (nd) {
      moveDir = new THREE.Vector3(nd.x, 0, nd.z);
      speed *= 0.8;
      const lx = bot.huntPos.x - bot.pos.x, lz = bot.huntPos.z - bot.pos.z;
      const lookFwd = bot._navLook || bot.huntPos;
      // face the threat when it's roughly ahead; otherwise look where we're walking
      const fx = lookFwd.x - bot.pos.x, fz = lookFwd.z - bot.pos.z;
      bot.yaw = (lx * fx + lz * fz) > 0 && hasLOS(botEye(bot), new THREE.Vector3(bot.huntPos.x, 1.4, bot.huntPos.z))
        ? Math.atan2(lx, lz) : Math.atan2(fx, fz);
    } else {
      bot.lastSeenPos = null; bot.heardPos = null; bot.huntPos = null;
      bot.state = 'objective'; bot.nextThink = t + rand(0.3, 0.8);
      bot.yaw += rand(-1.2, 1.2); // glance around
    }
  } else {
    const nd = navSteer(bot, bot.wp, t, 1.5);
    if (nd) {
      moveDir = new THREE.Vector3(nd.x, 0, nd.z);
      const lk = bot._navLook || bot.wp;
      bot.yaw = Math.atan2(lk.x - bot.pos.x, lk.z - bot.pos.z);
      // turn toward recent gunfire while walking
      if (bot._lookAt && t < (bot._lookUntil || 0)) bot.yaw = Math.atan2(bot._lookAt.x - bot.pos.x, bot._lookAt.z - bot.pos.z);
      // Walk (quieter, steadier) for the last stretch into a contested site.
      const site = bot.team === 't' && !BOMB.planted ? siteByName(BOMB.targetSite || 'A') : null;
      if (site && !bot.hasBomb && Math.hypot(site.x - bot.pos.x, site.z - bot.pos.z) < 12) speed *= 0.82;
    } else {
      // Reached objective: CTs hold an angle toward where Ts come from, Ts push on.
      if (bot._lookAt && t < (bot._lookUntil || 0)) {
        bot.yaw = Math.atan2(bot._lookAt.x - bot.pos.x, bot._lookAt.z - bot.pos.z);
      } else if (bot.team === 'ct' && !BOMB.planted) {
        const base = Math.atan2(-20 - bot.pos.x, (bot.pos.z * 0.4) - bot.pos.z);
        bot.yaw = base + Math.sin(t * 0.45 + bot.idx * 1.7) * 0.75;
      } else if (BOMB.planted) {
        const base = Math.atan2(-bot.pos.x, -bot.pos.z);
        bot.yaw = base + Math.sin(t * 0.5 + bot.idx * 2.3) * 1.1;
      } else if (waypoints.length && Math.random() < 0.02) {
        bot.wp.copy(objectiveWaypoint(bot));
      }
    }
  }
  if (moveDir && bot._unstick && t < bot._unstick.until) moveDir.set(bot._unstick.x, 0, bot._unstick.z);
  if (moveDir) {
    const sep = botSeparate(bot, moveDir);
    moveDir.set(sep.x, 0, sep.z);
    const step = moveDir.clone().multiplyScalar(speed * smokeSlowAt(_smokePt.set(bot.pos.x, bot.pos.y + 1, bot.pos.z)) * dt);
    smokePushAt(_smokePt.set(bot.pos.x, bot.pos.y + 1, bot.pos.z), moveDir.x * speed * dt * 8, moveDir.z * speed * dt * 8, 1);
    const ox = bot.pos.x, oz = bot.pos.z;
    moveWithCollision(bot.pos, step.x, step.z, BOT_R);
    // Progress watchdog: if we're pushing but barely moving, re-plan, then peel off
    // the obstacle, and as a last resort pick a different spot to go to.
    const moved = Math.hypot(bot.pos.x - ox, bot.pos.z - oz), want = speed * dt;
    if (want > 1e-4 && moved < want * 0.35) bot._stuckT = (bot._stuckT || 0) + dt;
    else { bot._stuckT = Math.max(0, (bot._stuckT || 0) - dt * 2); if (moved > want * 0.7) bot._stuckN = Math.max(0, (bot._stuckN || 0) - dt * 0.4); }
    if (bot._stuckT > 0.3) {
      bot._stuckT = 0; bot._stuckN = (bot._stuckN || 0) + 1;
      bot.path = null;
      const side = Math.random() < 0.5 ? 1 : -1;
      const h = botOpenHeading(bot, Math.atan2(moveDir.x, moveDir.z) + side * Math.PI / 2);
      if (h) bot._unstick = { x: h.x, z: h.z, until: t + rand(0.25, 0.5) };
      if (bot.state === 'combat') bot.strafeDir *= -1;
      if (bot._stuckN >= 3) {
        bot._stuckN = 0;
        bot.siteOffset.set(rand(-2, 2), 0, rand(-2, 2));
        if (bot.state === 'hunt') { bot.huntPos = null; bot.lastSeenPos = null; bot.heardPos = null; bot.state = 'objective'; }
        bot.wp.copy(objectiveWaypoint(bot));
      }
    }
    bot.walkPhase += dt * 9;
    // audible boots: interval scales with speed, fully 3D (distance + occlusion)
    if (bot._stepAt === undefined) bot._stepAt = 0;
    if (t > bot._stepAt) {
      bot._stepAt = t + clamp(2.1 / (speed || 4), 0.32, 0.55) * rand(0.9, 1.1);
      try { AudioSys.step(new THREE.Vector3(bot.pos.x, 0.9, bot.pos.z), false); } catch (e) {}
    }
  }
  bot._moving = !!moveDir && speed > 0.5;
  m.position.copy(bot.pos);
  // smooth yaw (people turn quickly but not instantly)
  let dy = bot.yaw - m.rotation.y;
  while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
  m.rotation.y += dy * Math.min(1, dt * 8);
  // Body pose (gait, aim, recoil, flinch, kneel) is driven once per frame by
  // animateBotMesh() from the loop, so every early-return path above still animates.
  if (bot.flinchT > 0) bot.flinchT = Math.max(0, bot.flinchT - dt);
  updateBlob(bot, bot.pos.x, bot.pos.z, true, !!moveDir);
}

