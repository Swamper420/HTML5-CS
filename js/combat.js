// js/combat.js — AGENTS: Damage model: hitscan traces (walls, smoke, bodies, headshots), damageBot, damagePlayer, kill handling.
// Ownership: fireHitscan, damageBot, damagePlayer. Player trigger/recoil is in shooting.js.

import * as THREE from 'three';
import { noteDamageTaken } from './dmgreport.js';
import { Net } from '../net.js';
import { AudioSys } from './audio.js';
import { CROUCH_EYE_DROP, MONEY_KILL, NADE_DEFS, SITES, WEAPONS, isNadeKey } from './config.js';
import { opts } from './settings.js';
import { $, clamp, rand } from './utils.js';
import { soldierFlinch } from './anim.js';
import { BOMB, bombDropAt, bombDroppedHit, explodeBomb, isInSite, updateInteractHUD } from './bomb.js';
import { botChest, botsHearShot, objectiveWaypoint } from './bots.js';
import { toggleBuy } from './buymenu.js';
import { tracePortalPath } from './portals.js';
import {
  decalTextures, spawnBloodPool, spawnBurst, spawnDebris, spawnDecal, spawnSmoke, spawnTracer,
  spawnWorldFlash, worldFlashes,
} from './effects.js';
import { bisectDiagonal, explodeHead, spawnBloodSpray, tearLimbGib } from './gibs.js';
import {
  GK, bloodSplatterRays, explodeBody, goreN, pickFallParams, poseCorpseLimbs, screenGore, woundPart,
} from './gore.js';
import { detonateNuke, tacticalSmokes } from './grenades.js';
import { addKillfeed, announce, flashDamage, playerHitmark, updateHUD } from './hud.js';
import { flashDamageRemote, isOnline, isServerMatch, remotes } from './multiplayer.js';
import { dropAllOnDeath, newWid, spawnWorldWeapon } from './pickups.js';
import { playerMesh, setPlayerBodyFirstPerson } from './playerbody.js';
import { camera, muzzleLight, scene } from './render.js';
import { checkRoundEnd } from './rounds.js';
import { _smokePt, smokePushAt } from './smoke.js';
import { spectateCurrent, updateSpectateOverlay } from './spectate.js';
import { G, addMoney, bots, player } from './state.js';
import { awardAssist, creditKill, noteDamage, shooterId } from './stats.js';
import { viewmodel } from './viewmodel.js';

const _dir = new THREE.Vector3();
export function fireHitscan(shooter, origin, dir, wdef, t) {
  try { botsHearShot(shooter, origin, t); } catch (e) {}
  const maxD = wdef.range;
  // Portal-bent path: bullets travel through linked portals (all shooters, online too).
  const path = tracePortalPath(origin, dir, maxD);
  let bestTravel = 0;
  for (const S of path.segs) bestTravel += S.len;
  let hitBot = null, hitPlayer = false, head = false;

  // Ray vs person approximation, along one segment: head sphere + two body spheres.
  const checkSeg = (O, D, px, pz, feetY, ck, segBest) => {
    const o = O, d = D;
    const hx = px, hy = feetY + 1.7 - CROUCH_EYE_DROP * ck, hz = pz;
    const hr = 0.30;
    let best = null;
    // ray-sphere
    const ox = o.x - hx, oy = o.y - hy, oz = o.z - hz;
    const b = ox * d.x + oy * d.y + oz * d.z;
    const c = ox * ox + oy * oy + oz * oz - hr * hr;
    const disc = b * b - c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      let tt = -b - sq;
      if (tt > 0.3 && tt < segBest) best = { d: tt, head: true };
    }
    // body: approximate as sphere at chest r=0.55 + lower sphere r=0.5
    for (const [by, br] of [[feetY + 1.05 - 0.36 * ck, 0.62 - 0.06 * ck], [feetY + 0.45 - 0.08 * ck, 0.5]]) {
      const ox2 = o.x - px, oy2 = o.y - by, oz2 = o.z - pz;
      const b2 = ox2 * d.x + oy2 * d.y + oz2 * d.z;
      const c2 = ox2 * ox2 + oy2 * oy2 + oz2 * oz2 - br * br;
      const disc2 = b2 * b2 - c2;
      if (disc2 >= 0) {
        const tt = -b2 - Math.sqrt(disc2);
        if (tt > 0.3 && tt < segBest && (!best || tt < best.d)) best = { d: tt, head: false };
      }
    }
    return best;
  };
  // Nearest person hit along the whole bent path (travel = distance along path).
  const checkPerson = (px, pz, feetY, crouchK = 0) => {
    const ck = clamp(crouchK || 0, 0, 1);
    let best = null, travel = 0;
    for (const S of path.segs) {
      const span = Math.min(S.len, bestTravel - travel);
      if (span > 0.3) {
        const r = checkSeg(S.o, S.d, px, pz, feetY, ck, span);
        if (r) { bestTravel = travel + r.d; best = { travel: bestTravel, head: r.head }; }
      }
      travel += S.len;
      if (travel >= bestTravel) break;
    }
    return best;
  };

  // Hit enemy bots (no friendly fire: skip same team and self).
  // In multiplayer (pure PvP) bots are cleared, so this loop is a no-op — kept for solo.
  for (const b of bots) {
    if (!b.alive) continue;
    if (b.team === shooter.team) continue;
    if (shooter.bot === b) continue;
    if (shooter.isPlayer) {
      // Solo: player (CT) only fights T. Online: team-based friendly fire off.
      const myTeam = player.team || 'ct';
      if (b.team === myTeam) continue;
    }
    const r = checkPerson(b.pos.x, b.pos.z, b.pos.y, b.crouching ? 1 : 0);
    if (r) { hitBot = b; head = r.head; hitPlayer = false; }
  }
  // Remote real players as hit targets (PvP, team-based, no friendly fire).
  let hitRemote = null;
  if (shooter.isPlayer) {
    try {
      const myTeam = player.team || 'ct';
      for (const [rid, e] of remotes) {
        const rd = e.data; if (!rd || !rd.alive) continue;
        if ((rd.team || 't') === myTeam) continue; // no friendly fire
        const r = checkPerson(e.pos.x, e.pos.z, e.pos.y, e.crouchK || 0);
        if (r) { hitRemote = { id: rid, entry: e }; hitBot = null; head = r.head; hitPlayer = false; }
      }
    } catch {}
  }
  // can bots hit player? + can player hit self? no. Can teammates hit player? no friendly fire.
  if (!shooter.isPlayer && shooter.team !== (player.team || 'ct') && player.alive) {
    // Bots only damage the local player when on opposite teams (solo CT vs T).
    // Remote shooters never reach here — they send 'hit' msgs applied victim-side.
    const r = checkPerson(player.pos.x, player.pos.z, player.pos.y, player.crouch || 0);
    if (r) { hitPlayer = true; hitBot = null; hitRemote = null; head = r.head; }
  }
  // teammates (CT bots) can be hit by... nobody (no friendly fire) — skip.

  // Position / disjoint legs at a travel distance along the bent path.
  // Legs break at portal hops (teleport jumps are not drawn as lines).
  const pathPoint = (travel) => {
    let td = travel;
    for (const S of path.segs) { if (td <= S.len) return S.o.clone().addScaledVector(S.d, td); td -= S.len; }
    const L = path.segs[path.segs.length - 1];
    return L.o.clone().addScaledVector(L.d, L.len);
  };
  const pathLegsUpTo = (travel) => {
    const out = [];
    let td = travel;
    for (const S of path.segs) {
      if (td <= 0) break;
      const k = Math.min(S.len, td);
      out.push([S.o.clone(), S.o.clone().addScaledVector(S.d, k)]);
      td -= S.len;
    }
    return out;
  };

  // Dropped C4 is shoot-to-detonate (planted C4 is bulletproof — bombDroppedHit
  // returns null when planted). Closest-hit wins: body/wall in front still blocks.
  let bombAt = -1;
  {
    let travel = 0;
    for (const S of path.segs) {
      const span = Math.min(S.len, bestTravel - travel);
      if (span > 0.05) {
        const bt = bombDroppedHit(S.o, S.d, span);
        if (bt !== null) { bombAt = travel + bt; break; }
      }
      travel += S.len;
      if (travel >= bestTravel) break;
    }
  }
  if (bombAt >= 0) {
    const bombEnd = pathPoint(bombAt);
    const bombLegs = pathLegsUpTo(bombAt);
    for (const [a, b] of bombLegs) spawnTracer(a, b, wdef.tracer);
    if (shooter.isPlayer) {
      muzzleLight.position.copy(origin).add(dir.clone().multiplyScalar(0.6));
      muzzleLight.intensity = wdef.sound === 'sniper' ? 5 : 3.2;
      muzzleLight.distance = wdef.sound === 'sniper' ? 20 : 14;
    }
    if (shooter.isPlayer) AudioSys.shoot(wdef.sound);
    else AudioSys.shoot(wdef.sound, origin);
    spawnBurst(bombEnd, 0xffd27a, 10, 6, 0.4, 0.1);
    const shooterName = shooter.isPlayer ? (player.name || 'YOU') : (shooter.bot ? shooter.bot.short : (shooter.remoteName || '???'));
    const shooterTeam = shooter.isPlayer ? (player.team || 'ct') : shooter.team;
    addKillfeed(shooterName, shooterTeam, 'DROPPED BOMB', 't', '💥 C4', false);
    explodeBomb(t, '💥 C4 SHOT — DETONATED');
    return { hit: true, d: bombAt, bombDetonated: true, points: bombLegs };
  }

  const end = pathPoint(bestTravel);
  const legs = pathLegsUpTo(bestTravel);
  const legDir = (li, out) => out.copy(legs[li][1]).sub(legs[li][0]).normalize();
  if (tacticalSmokes.length) {
    let dent = null, dentK = 0;
    const pts = [];
    const _ld = new THREE.Vector3();
    for (let li = 0; li < legs.length; li++) {
      legDir(li, _ld);
      const a = legs[li][0], b = legs[li][1];
      if (a.distanceTo(b) < 0.3) continue;
      for (let i = 1; i <= 3; i++) {
        _smokePt.lerpVectors(a, b, i / 3);
        const k = smokePushAt(_smokePt, _ld.x * 12, _ld.z * 12, 0.7); // supersonic tunnel through the cloud
        if (k > 0) pts.push(Math.round(_smokePt.x * 100) / 100, Math.round(_smokePt.y * 100) / 100, Math.round(_smokePt.z * 100) / 100);
        if (k > dentK) { dentK = k; dent = _smokePt.clone(); }
      }
    }
    if (dent && dentK > 0.2) {
      try { spawnSmoke(dent, 0.55, 0.8, 0xd8d4cb); } catch (e) {} // visible punch mark
      // server-sided via relay: receivers replay the same sample pushes in order (see applyRemoteNade)
      try { if (shooter.isPlayer && isOnline() && pts.length) Net.sendNade({ action: 'smoke_push', x: dent.x, y: dent.y, z: dent.z, vx: dir.x * 12, vz: dir.z * 12, power: 0.7, pts }); } catch (e) {}
    }
  }
  // effects
  for (const [a, b] of legs) spawnTracer(a, b, wdef.tracer);
  if (shooter.isPlayer) {
    muzzleLight.position.copy(origin).add(dir.clone().multiplyScalar(0.6));
    muzzleLight.intensity = wdef.sound === 'sniper' ? 5 : 3.2;
    muzzleLight.distance = wdef.sound === 'sniper' ? 20 : 14;
  } else if (bestTravel < 60) {
    muzzleLight.position.copy(origin); muzzleLight.intensity = Math.max(muzzleLight.intensity, 1.5);
    spawnWorldFlash(origin, wdef.tracer || 0xffc36b, wdef.sound === 'sniper' ? 1.5 : 0.85);
  }
  if (shooter.isPlayer) AudioSys.shoot(wdef.sound);
  else AudioSys.shoot(wdef.sound, origin);
  // supersonic snap when an enemy round whizzes past the camera (near miss, every leg)
  if (!shooter.isPlayer && !hitBot && !hitPlayer && player.alive && camera) {
    try {
      const lp = camera.position;
      const _cd = new THREE.Vector3();
      for (let li = 0; li < legs.length; li++) {
        legDir(li, _cd);
        const a = legs[li][0];
        const ox = lp.x - a.x, oy = lp.y - a.y, oz = lp.z - a.z;
        const along = ox * _cd.x + oy * _cd.y + oz * _cd.z;
        if (along > 0 && along < 45) {
          const px = a.x + _cd.x * along - lp.x;
          const py = a.y + _cd.y * along - lp.y;
          const pz = a.z + _cd.z * along - lp.z;
          const miss = Math.sqrt(px * px + py * py + pz * pz);
          if (miss < 2.6 && Math.random() < 0.85) setTimeout(() => AudioSys.crack(), along / 343 * 1000);
        }
      }
    } catch (e) {}
  }

  // damage falloff with distance (keeps AWP lethal far, rifles fade)
  const fall = wdef.falloff !== undefined ? wdef.falloff : 0.35;
  const fallK = 1 - fall * clamp(bestTravel / wdef.range, 0, 1);
  if (hitRemote) {
    // PvP: shooter predicts the hit locally for feedback, victim applies it.
    let dmg = wdef.damage * fallK * (head ? wdef.headMult : 1) * rand(0.9, 1.1);
    dmg = Math.round(dmg * 10) / 10;
    G.hits++; playerHitmark(head, false); AudioSys.hit(head);
    spawnBurst(end, 0xb00000, head ? 12 : 8, 4, 0.5);
    try {
      Net.sendHit({
        targetId: hitRemote.id, dmg, head,
        weapon: WEAPONS[player.cur] ? WEAPONS[player.cur].name : 'AK-47',
      });
    } catch {}
    // Optimistic local feedback; authoritative death arrives via 'killed' or snapshot.
    return { hit: true, d: bestTravel, points: legs };
  } else if (hitBot) {
    let dmg = wdef.damage * fallK * (head ? wdef.headMult : 1) * rand(0.9, 1.1);
    try {
      const wk = (wdef && wdef.name) || currentWeaponName(shooter);
      damageBot(hitBot, dmg, shooter, head, end, { dir: dir.clone(), weapon: wk });
    } catch (e) { damageBot(hitBot, dmg, shooter, head, end); }
    return { hit: true, d: bestTravel, points: legs };
  } else if (hitPlayer) {
    let dmg = wdef.damage * fallK * (head ? wdef.headMult : 1) * rand(0.85, 1.1);
    damagePlayer(dmg, shooter, head);
    spawnBurst(end, 0xaa0000, 6, 3, 0.4);
    return { hit: true, d: bestTravel, points: legs };
  } else if (bestTravel < maxD - 0.01) {
    // wall impact: spark + dust + chip + smoke wisp + positional thwack/ring
    spawnBurst(end, 0xffd27a, 8, 5, 0.3, 0.07);
    spawnBurst(end, 0x9a8f7a, 5, 2.2, 0.55, 0.08);
    spawnSmoke(end, 0.22, 0.6);
    if (opts.quality) spawnDebris(end, 2, 3, 3);
    // persistent bullet hole facing back along the shot (last leg through portals)
    try { spawnDecal('hole', end, legDir(legs.length - 1, new THREE.Vector3()).negate(), 0.22 + Math.random() * 0.14); } catch (e) {}
    // hot impact glint so far hits read at distance
    try {
      const T = decalTextures();
      const glint = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xffd9a0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      glint.position.copy(end); glint.scale.setScalar(0.4);
      scene.add(glint);
      worldFlashes.push({ mesh: glint, life: 0.08, max: 0.08 });
    } catch (e) {}
    AudioSys.impact(end, wdef.sound === 'sniper');
    return { hit: false, d: bestTravel, points: legs };
  }
  return { hit: false, d: bestTravel, points: legs };
}

export function damageBot(bot, dmg, shooter, head, hitPos, gore = {}) {
  if (!bot.alive || G.phase !== 'playing') return;
  // armor-lite: bots have no armor
  bot.hp -= dmg;
  const _hp = hitPos || botChest(bot);
  // resolve shot direction for directional gore (bullet travel dir, horizontal-ish)
  let _sdir = gore.dir || null;
  try {
    if (!_sdir) {
      if (shooter && shooter.isPlayer && typeof camera !== 'undefined' && camera) {
        _sdir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
      } else if (shooter && shooter.bot) {
        _sdir = bot.pos.clone().sub(shooter.bot.pos).setY(0);
        if (_sdir.lengthSq() < 0.01) _sdir.set(rand(-1, 1), 0, rand(-1, 1));
        _sdir.normalize();
      } else if (shooter && (shooter.remotePos || (shooter.remote && shooter.remote.pos))) {
        const rp = shooter.remotePos || shooter.remote.pos;
        _sdir = new THREE.Vector3(bot.pos.x - rp.x, 0, bot.pos.z - rp.z);
        if (_sdir.lengthSq() < 0.01) _sdir.set(rand(-1, 1), 0, rand(-1, 1));
        _sdir.normalize();
      }
    }
  } catch (e) { _sdir = null; }
  spawnBurst(_hp, 0xb00000, head ? 12 : 8, 4, 0.5);
  spawnBurst(_hp, 0x7a0a0c, 6, 2.5, 0.7, 0.12); // dark arterial spray
  // directional mist + ground spatter so firefights stain the lane
  try {
    const d = _sdir ? _sdir.clone() : (shooter && shooter.isPlayer && camera
      ? new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
      : (shooter && shooter.bot ? shooter.bot.pos.clone().sub(bot.pos).setY(0).normalize() : new THREE.Vector3(1, 0, 0)));
    const mist = _hp.clone().addScaledVector(d, 0.5); mist.y = Math.max(0.3, mist.y - 0.2);
    spawnSmoke(mist, 0.3, 0.7, 0x8a1518);
    if (Math.random() < 0.5) spawnDecal('blood', new THREE.Vector3(bot.pos.x, 0.06, bot.pos.z), new THREE.Vector3(0, 1, 0), 0.9 + Math.random() * 0.7, 0.55);
    // exit spray: throw blood past the victim and stain whatever is behind them
    bloodSplatterRays(_hp, d, head ? 7 : 4, 0.75, 7);
    spawnBurst(_hp, 0xa00d10, goreN(5) + 2, 4.5, 0.5, 0.1);
  } catch (e) {}
  // visible hit-flinch (springs back in updateBot via flinchT decay)
  bot.flinchT = 0.22; bot.flinchHead = !!head;
  soldierFlinch(bot.mesh, head ? 1 : 0.65);
  try { noteDamage(bot, shooter); } catch {}
  const killerIsPlayer = shooter.isPlayer;
  if (killerIsPlayer) {
    G.hits++; playerHitmark(head, false);
    AudioSys.hit(head);
  }
  // Being shot interrupts planting/defusing.
  if (bot.planting) { bot.planting = false; if (BOMB.plantingBot === bot) BOMB.plantingBot = null; }
  if (bot.defusing) { bot.defusing = false; if (BOMB.defuser === bot) BOMB.defuser = null; }
  if (bot.hp <= 0) {
    bot.alive = false; bot.hp = 0;
    bot.planting = false; bot.defusing = false;
    if (!isOnline()) {
      try { spawnWorldWeapon({ wid: newWid(), key: 'ak', mag: 5 + ((Math.random() * 25) | 0), reserve: 30 + ((Math.random() * 60) | 0), x: bot.pos.x, y: bot.pos.y + 1.0, z: bot.pos.z, vx: rand(-1.5, 1.5), vy: 2, vz: rand(-1.5, 1.5) }); } catch (e) {}
    }
    // Make sure a first-person spectate target is visible again for its death anim.
    bot.mesh.visible = true;
    if (BOMB.plantingBot === bot) BOMB.plantingBot = null;
    if (BOMB.defuser === bot) BOMB.defuser = null;
    // Bomb carrier drops the C4 where they died (CTs can't pick it up, Ts recover it).
    if (bot.hasBomb && !BOMB.planted) {
      bot.hasBomb = false;
      const tNow = performance.now() / 1000;
      bombDropAt(bot.pos);
      // Reassign remaining Ts to recover it.
      for (const o of bots) if (o.alive && o.team === 't') o.wp.copy(objectiveWaypoint(o));
    }
    // death: momentum ragdoll + persistent corpse with blood pool (cleared next round)
    bot.deathT = 0; bot._thudded = false;
    bot.headless = false; bot.gibbed = false;
    bot.mesh.rotation.set(0, bot.yaw || 0, 0);
    bot.mesh.position.copy(bot.pos);
    try {
      const wName = String((gore && gore.weapon) || (shooter && shooter.weaponName) || currentWeaponName(shooter) || '').toUpperCase();
      const isFire = wName.includes('MOLOTOV') || wName.includes('FIRE') || wName.includes('BURN');
      const explosive = !isFire && (!!(gore && gore.explosive) || wName.includes('HE') || wName.includes('C4'));
      const isAWP = wName.includes('AWP');
      const isHelix = wName.includes('HELIX');
      const isMachete = wName.includes('MACHETE');
      const isDeagle = wName.includes('DESERT') || wName.includes('DEAGLE') || wName.includes('EAGLE');
      const sdir = _sdir ? _sdir.clone() : null;
      // knock power scales the fall + slide: AWP/HE hurl bodies, rifles shove
      let power = (gore && gore.power) || 1;
      if (power === 1) {
        if (explosive) power = 2.1;
        else if (isMachete) power = 2.5;
        else if (isHelix) power = 3.0;
        else if (isAWP) power = 2.0;
        else if (isDeagle) power = 1.4;
        else power = 1.0;
      }
      if (head) power += 0.15;
      bot.fall = pickFallParams(bot.pos, sdir, power);
      bot.deathPos = bot.pos.clone();
      const slideDist = explosive ? rand(0.9, 1.6) : isMachete ? rand(1.0, 1.7) : isHelix ? rand(1.2, 2.0) : (isAWP ? rand(0.7, 1.2) : isDeagle ? rand(0.45, 0.8) : rand(0.3, 0.65));
      const flat = sdir ? sdir.clone().setY(0) : new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1));
      if (flat.lengthSq() < 0.01) flat.set(rand(-1, 1), 0, rand(-1, 1));
      flat.normalize();
      bot.knock = flat.multiplyScalar(slideDist);
      // ---- hit-part gore: only the struck part comes off, body flings whole ----
      const part = woundPart(bot.pos.y, _hp.y, head);
      let pop = false, popPower = 1;
      const headPos = new THREE.Vector3(bot.pos.x, (bot.pos.y || 0) + 1.76, bot.pos.z);
      if (isMachete) {
        // diagonal bisection, every kill — the body is gone, two halves tumble.
        try { bisectDiagonal(bot.mesh, bot.pos, sdir, bot.team); } catch (e) {}
        bot.gibbed = true; bot.headless = true; bot.exploded = true;
        try {
          bloodSplatterRays(botChest(bot), sdir, 14, 1.2, 8);
          const dp = camera ? camera.position.distanceTo(new THREE.Vector3(bot.pos.x, 1, bot.pos.z)) : 99;
          if (dp < 7) screenGore(clamp(1.2 - dp / 7, 0.25, 1));
        } catch (e) {}
      } else if (explosive) {
        pop = Math.random() < 0.75;
        popPower = 1.7;
        tearLimbGib(bot.mesh, bot.pos, sdir, bot.team, true, part === 'head' ? 'torso' : part);
        bot.gibbed = true;
      } else if (head) {
        if (isAWP || dmg >= 90) { pop = true; popPower = 1.7; }
        else if (isDeagle) { pop = Math.random() < 0.65; popPower = 1.3; }
        else { pop = dmg >= 60 ? Math.random() < 0.5 : Math.random() < 0.22; popPower = 1.0; }
      } else if ((isAWP || isHelix) && Math.random() < (isHelix ? 0.6 : 0.3)) {
        // close-range AWP body shots can still tear the hit part off (the HELIX usually does)
        tearLimbGib(bot.mesh, bot.pos, sdir, bot.team, false, part);
        bot.gibbed = true;
      } else if ((isDeagle || dmg >= 55) && part === 'leg' && Math.random() < 0.25) {
        tearLimbGib(bot.mesh, bot.pos, sdir, bot.team, false, 'leg');
        bot.gibbed = true;
      }
      // ---- explosives only: whole body comes apart. Bullets keep the corpse. ----
      const gk = GK();
      if (gk > 0 && explosive && explodeBody(bot.mesh, bot.pos, sdir, power, bot.team)) {
        bot.gibbed = true; bot.headless = true; bot.exploded = true;
        try {
          const dp = camera ? camera.position.distanceTo(new THREE.Vector3(bot.pos.x, 1, bot.pos.z)) : 99;
          if (dp < 7) screenGore(clamp(1.2 - dp / 7, 0.25, 1));
        } catch (e) {}
      } else if (pop) {
        bot.headless = true;
        try { explodeHead(bot.mesh, headPos, sdir, popPower, bot.team); } catch (e) {}
        try {
          bloodSplatterRays(headPos, null, 12, 1.1, 7);
          const dp = camera ? camera.position.distanceTo(headPos) : 99;
          if (dp < 6) screenGore(clamp(1 - dp / 6, 0.2, 0.9));
        } catch (e) {}
      } else {
        // intact death: directional spray + pool, body stays whole and flings
        try { spawnBloodSpray(head ? headPos : botChest(bot), sdir, head ? 1.1 : power * 0.9); } catch (e) {}
        spawnBloodPool(bot.pos.x, bot.pos.z, true);
        for (let i = 0; i < goreN(1); i++) spawnBloodPool(bot.pos.x + rand(-0.9, 0.9), bot.pos.z + rand(-0.9, 0.9), Math.random() < 0.5);
        spawnBurst(botChest(bot), 0x8a0f12, goreN(8) + 4, 3.5, 0.8, 0.12);
        bloodSplatterRays(botChest(bot), sdir, 6, 1.0, 7);
        if (head) { try { AudioSys.headpop(headPos); } catch (e) {} }
      }
      try { poseCorpseLimbs(bot.mesh, bot.fall.sprawl, bot.fall.power); } catch (e) {}
    } catch (e) {
      try {
        spawnBloodPool(bot.pos.x, bot.pos.z, true);
        spawnBurst(botChest(bot), 0x8a0f12, 14, 3.5, 0.8, 0.12);
      } catch (e2) {}
    }
    const killerTeam = shooter.isPlayer ? (player.team || 'ct') : shooter.team;
    G.roundKills[killerTeam]++;
    const kn = killerIsPlayer ? (player.name || 'YOU') : (shooter.bot ? shooter.bot.short : '???');
    const kt = killerTeam;
    addKillfeed(kn, kt, bot.short, bot.team, currentWeaponName(shooter), head);
    bot.deaths = (bot.deaths | 0) + 1;
    try { awardAssist(bot, shooterId(shooter)); } catch {}
    if (killerIsPlayer) {
      G.kills++; player.kills++; addMoney(MONEY_KILL); playerHitmark(head, true);
      AudioSys.kill();
      if (head && !G.roundEnding) { G.headshots++; announce('HEADSHOT +$' + MONEY_KILL, 700); }
    } else { try { creditKill(shooter, bot); } catch {} }
    updateHUD(); checkRoundEnd();
  } else {
    // Wounding the planter buys time — knock a chunk off plant progress.
    if (bot.hasBomb && BOMB.plantProgress > 0) BOMB.plantProgress = Math.max(0, BOMB.plantProgress - 0.5);
  }
}

export function damagePlayer(dmg, shooter, head) {
  if (!player.alive || G.phase !== 'playing') return;
  // CS-like armor: helmet halves headshot bonus, vest absorbs body damage
  if (head && player.armor > 0) dmg *= 0.6;
  if (player.armor > 0) {
    const absorbed = dmg * 0.5;
    const useArmor = Math.min(player.armor, absorbed);
    player.armor -= useArmor;
    dmg -= useArmor * 0.8;
  }
  const hpBefore = player.hp;
  player.hp -= dmg;
  try { noteDamageTaken(shooter, hpBefore - Math.max(0, player.hp), player.hp <= 0); } catch {}
  // Piss in the eyes: brief white-out. Victim-side, so it works online — the
  // attacker's 'hit' just carries weapon 'PEE', same as bullets.
  try {
    if (String((shooter && shooter.weaponName) || '').toUpperCase() === 'PEE' && player.alive) {
      const tt = performance.now() / 1000;
      if (tt + 1.0 > (player.flashUntil || 0)) { player.flashUntil = tt + 1.0; player.flashMax = 1.0; }
      // yellow melt outlasts the white-out: lens stays stained while vision returns
      if (tt + 2.4 > (player.peeUntil || 0)) { player.peeUntil = tt + 2.4; player.peeMax = 2.4; }
    }
  } catch {}
  AudioSys.hurt();
  try { noteDamage(player, shooter); } catch {}
  try { screenGore(clamp(dmg / 55, 0.15, 1) * (head ? 1.3 : 1)); } catch (e) {}
  try {
    if (shooter && shooter.remotePos) flashDamageRemote(shooter.remotePos);
    else flashDamage(shooter);
  } catch { flashDamage(shooter); }
  updateHUD();
  if (player.hp <= 0) {
    player.hp = 0; player.alive = false; player.deaths++;
    // Died holding a live nuke: hitting the floor is impact enough.
    if (player.carryingNuke) {
      player.carryingNuke = false; player.nades.nuke = 0;
      try { detonateNuke(player.pos.clone().add(new THREE.Vector3(0, 1, 0)), { isPlayer: true, team: player.team || 'ct' }, performance.now() / 1000); } catch (e) {}
    }
    try { awardAssist(player, shooterId(shooter)); } catch {}
    try { if (!shooter.isPlayer) creditKill(shooter, player); } catch {}
    try { dropAllOnDeath(); } catch (e) { console.warn('death drop', e); }
    player.aiming = false; player.cook = null;
    player.crouching = false; player.airTuck = false; player.wallRun = null; player.wallRoll = 0;
    // your own body ragdolls where you fell, same rules as everyone else
    try {
      let sdir = null;
      if (shooter && shooter.remotePos) sdir = new THREE.Vector3(player.pos.x - shooter.remotePos.x, 0, player.pos.z - shooter.remotePos.z);
      else if (shooter && shooter.bot) sdir = new THREE.Vector3(player.pos.x - shooter.bot.pos.x, 0, player.pos.z - shooter.bot.pos.z);
      if (sdir && sdir.lengthSq() < 0.01) sdir = null;
      if (sdir) sdir.normalize();
      player.deathT = 0;
      player.fall = pickFallParams(player.pos, sdir, head ? 1.4 : 1.0);
      const gk = GK();
      const wExpl = String((shooter && shooter.weaponName) || '').toUpperCase();
      const isExpl = /HE|C4|MOLOTOV|NUKE|ATOMIC|☢/.test(wExpl) || dmg >= 400;
      player.exploded = gk > 0 && isExpl;
      if (player.exploded && playerMesh) {
        setPlayerBodyFirstPerson(false);
        explodeBody(playerMesh, player.pos, sdir, player.fall.power, player.team || 'ct');
        screenGore(1);
      } else if (playerMesh) {
        poseCorpseLimbs(playerMesh, player.fall.sprawl, player.fall.power);
      }
    } catch (e) {}
    try { updateInteractHUD(null); } catch (e) {}
    if (BOMB.defuser === 'player') BOMB.defuser = null;
    // T death drops the bomb where we died so teammates (or T bots) can recover it.
    // Solo used to just delete it. Online the server drops it when it hears about the death.
    try {
      if (player.hasBomb && !BOMB.planted) {
        player.hasBomb = false;
        if (!isServerMatch()) bombDropAt(player.pos, false);
      }
    } catch {}
    const kn = shooter.isPlayer ? (player.name || 'YOU') : (shooter.bot ? shooter.bot.short : (shooter.remoteName || shooter.remote?.data?.name || 'Enemy'));
    const suicide = !!shooter.isPlayer;
    $('respawn-killer').textContent = kn + (suicide ? ' (OWN GRENADE)' : (head ? ' (HEADSHOT)' : ''));
    $('respawn-timer').textContent = BOMB.planted
      ? 'BOMB IS PLANTED — your team must still defuse it…'
      : 'Waiting for next round… (no respawns — CS elimination)';
    $('respawn-overlay').classList.remove('hidden');
    // Spectate a living teammate immediately — keep pointer lock so the
    // mouse keeps working for look / click-to-cycle.
    if (G.buyOpen) toggleBuy(false); // dead players get no buy menu
    player.specTarget = null;
    spectateCurrent();
    updateSpectateOverlay();
    if (viewmodel) viewmodel.visible = false;
    const killerTeam = shooter.team || 't';
    const victimTeam = player.team || 'ct';
    G.roundKills[killerTeam]++;
    addKillfeed(kn, killerTeam, player.name || 'YOU', victimTeam, currentWeaponName(shooter), head);
    // Victim-authoritative death report — sent exactly once per death, for every cause
    // (bullets, nades, C4, suicide), so the server's alive counts and K/D stay exact.
    try {
      if (isOnline()) {
        const now = performance.now() / 1000;
        const aid = String(player._assistId || '');
        const assistId = aid.startsWith('remote:') && (now - (player._assistT || 0)) < 5 ? +aid.slice(7) : null;
        Net.sendKilled({
          killerId: shooter.remote?.data?.id ?? shooter.remoteId ?? null, killerName: kn, killerTeam,
          victimId: Net.id, victimName: player.name || 'YOU', victimTeam,
          weapon: currentWeaponName(shooter), head: !!head, assistId,
        });
      }
    } catch {}
    updateHUD(); checkRoundEnd();
  }
}
function currentWeaponName(shooter) {
  if (shooter && shooter.weaponName) return shooter.weaponName;
  if (shooter.isPlayer) {
    if (isNadeKey(player.cur)) return NADE_DEFS[player.cur].name;
    return (WEAPONS[player.cur] || WEAPONS.deagle).name;
  }
  if (shooter && shooter.remote && shooter.remote.data && shooter.remote.data.weapon && WEAPONS[shooter.remote.data.weapon]) return WEAPONS[shooter.remote.data.weapon].name;
  return G.round <= 1 ? 'Desert Eagle' : 'AK-47'; // pistol round flavor
}

export function playerNearPlantedBomb(range = 2.8) {
  if (!BOMB.planted || !BOMB.pos) return false;
  // Only CTs defuse — a T holding E on the planted bomb was losing his weapon.
  if ((player.team || 'ct') !== 'ct') return false;
  return Math.hypot(player.pos.x - BOMB.pos.x, player.pos.z - BOMB.pos.z) < range;
}
export function playerInPlantSite() {
  if (!player.alive || BOMB.planted || (player.team || 'ct') !== 't' || !player.hasBomb) return null;
  for (const s of SITES) { if (isInSite(player.pos, s)) return s; }
  return null;
}

