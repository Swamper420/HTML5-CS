// js/shooting.js — AGENTS: Player weapon handling: CS-style recoil/bloom/spray, fire, reload, weapon switching.
// Ownership: playerTryFire, startReload, finishReload, switchWeapon, currentWeaponName.

import * as THREE from 'three';
import { Net } from '../net.js';
import { AudioSys } from './audio.js';
import { CROUCH_EYE_DROP, EYE, NADE_DEFS, SPRAY_AK, WEAPONS, isNadeKey } from './config.js';
import { $, clamp, rand } from './utils.js';
import { soldierFireKick, soldierSlash } from './anim.js';
import { updateInteractHUD } from './bomb.js';
import { rayWallDist } from './collision.js';
import { fireHitscan, damageBot, playerInPlantSite, playerNearPlantedBomb } from './combat.js';
import { spawnBurst, spawnDecal, spawnFireball, spawnShell, spawnShockwave, spawnSmoke, spawnTracer } from './effects.js';
import { announce, flashExplosionOverlay, playerHitmark, updateHUD } from './hud.js';
import { mouseJustDown, rmbJustDown, setCrossGap, setMouseJustDown, setRmbJustDown } from './input.js';
import { isOnline, remotes } from './multiplayer.js';
import { DUAL } from './pickups.js';
import { PEE } from './pee.js';
import { firePortalSlot } from './portals.js';
import { playerMesh } from './playerbody.js';
import { camera, muzzleLight } from './render.js';
import { G, isFreeze, bots, keys, player } from './state.js';
import { buildViewmodel, vmFlashGroup, vmL, vmMuzzle, vmRig } from './viewmodel.js';

// MACHETE: no ammo, no spread, no tracer — a wide diagonal cleave that hits
// everything in front within range. Kills bisect (see combat.js).
export function meleeSlash(t, wkey, def) {
  if (!def.auto && !mouseJustDown) return;
  player.nextShot = t + def.fireInterval;
  player.lastShotT = t;
  player.sprayIdx = 0;
  G.shots++;
  AudioSys.shoot(def.sound);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const eye = new THREE.Vector3(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0), player.pos.z);
  const range = def.range || 3.4;
  const wallD = rayWallDist(eye, dir, range);
  // the slash itself is animated in movement.js (vmRig.swingT) — here just a
  // light wrist snap, no gun-style kickback
  vmRig.swingT = 0;
  vmRig.swingFlip = -(vmRig.swingFlip || 1);
  vmRig.kickV += def.vmKick * 4;
  vmRig.punchP += def.punch * 0.5;
  vmRig.roll += rand(-0.06, 0.06);
  vmRig.fovKick += def.fovPunch;
  vmRig.shake += def.shake;
  soldierSlash(playerMesh); // own shadow-body chops with you
  setMouseJustDown(false);
  setCrossGap(clamp(6 + Math.hypot(player.vel.x, player.vel.z) * 1.3, 6, 46));
  const myTeam = player.team || 'ct';
  const inArc = (cx, cy, cz) => {
    const tx = cx - eye.x, ty = cy - eye.y, tz = cz - eye.z;
    const along = tx * dir.x + ty * dir.y + tz * dir.z;
    if (along < 0.1 || along > range + 0.7 || along > wallD - 0.15) return -1;
    const px = tx - dir.x * along, py = ty - dir.y * along, pz = tz - dir.z * along;
    if (Math.sqrt(px * px + py * py + pz * pz) > 1.25) return -1;
    return along;
  };
  let hitAny = false;
  for (const b of bots) {
    if (!b.alive || b.team === myTeam) continue;
    const along = inArc(b.pos.x, b.pos.y + 1.0, b.pos.z);
    if (along < 0) continue;
    hitAny = true;
    const hitPos = eye.clone().addScaledVector(dir, along);
    try {
      damageBot(b, def.damage * rand(0.95, 1.05), { team: myTeam, isPlayer: true }, false, hitPos, { dir: dir.clone(), weapon: 'MACHETE' });
    } catch (e) {}
  }
  try {
    for (const [rid, e] of remotes) {
      const rd = e.data; if (!rd || !rd.alive) continue;
      if ((rd.team || 't') === myTeam) continue;
      const along = inArc(e.pos.x, e.pos.y + 1.0, e.pos.z);
      if (along < 0) continue;
      hitAny = true;
      const dmg = Math.round(def.damage * rand(0.95, 1.05) * 10) / 10;
      G.hits++; playerHitmark(false, false); AudioSys.hit(false);
      spawnBurst(eye.clone().addScaledVector(dir, along), 0xb00000, 10, 4, 0.5);
      try { Net.sendHit({ targetId: rid, dmg, head: false, weapon: 'MACHETE' }); } catch {}
    }
  } catch {}
  try {
    if (isOnline()) Net.sendShot({
      ox: eye.x, oy: eye.y, oz: eye.z,
      dx: dir.x, dy: dir.y, dz: dir.z,
      weapon: 'MACHETE', tracer: def.tracer, sound: def.sound,
    });
  } catch {}
  if (!hitAny && wallD < range - 0.01) {
    const end = eye.clone().addScaledVector(dir, wallD);
    spawnBurst(end, 0xffd27a, 8, 5, 0.3, 0.07);
    AudioSys.impact(end, false);
  }
  updateHUD();
}
// PORTAL GUN: infinite ammo, zero damage — LMB places blue (A), RMB orange (B).
function firePortal(t, hand = 'R') {
  const def = WEAPONS.portal;
  const nextKey = hand === 'L' ? 'nextShotL' : 'nextShot';
  if (!player.alive || player.reloading > 0 || t < (player[nextKey] || 0)) return;
  if (isFreeze()) return;
  player[nextKey] = t + def.fireInterval;
  player.lastShotT = t;
  player.sprayIdx = 0;
  G.shots++;
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const eye = new THREE.Vector3(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0), player.pos.z);
  const slot = hand === 'L' ? 'B' : 'A';
  const wallD = rayWallDist(eye, dir, def.range);
  const muzzleWorld = new THREE.Vector3();
  if (vmMuzzle) vmMuzzle.getWorldPosition(muzzleWorld);
  else muzzleWorld.copy(eye);
  spawnTracer(muzzleWorld, eye.clone().addScaledVector(dir, Math.min(wallD, def.range)), def.tracer, 2);
  firePortalSlot(eye, dir, slot, 'local', false, def.range);
  try {
    if (isOnline()) Net.sendShot({
      ox: eye.x, oy: eye.y, oz: eye.z,
      dx: dir.x, dy: dir.y, dz: dir.z,
      weapon: def.name, tracer: def.tracer, sound: def.sound,
    });
  } catch {}
  vmRig.kickV += def.vmKick * 15;
  vmRig.punchP += def.punch;
  vmRig.shake += def.shake;
  vmRig.fovKick += def.fovPunch;
  soldierFireKick(playerMesh, 0.4);
  if (hand === 'L') setRmbJustDown(false); else setMouseJustDown(false);
  setCrossGap(8);
  updateHUD();
}
export function playerTryFire(t, hand = 'R') {
  // hands busy peeing — release P, then shoot
  if (PEE.peeing) { setMouseJustDown(false); setRmbJustDown(false); return; }
  // nades never reach the hitscan path — they prime/throw instead
  if (isNadeKey(player.cur)) return;
  const wkey = player.cur, w = player.weapons[wkey], def = WEAPONS[wkey];
  if (!w || !def) return;
  const dual = !!w.dual;
  if (hand === 'L' && !dual && wkey !== 'portal') return;
  const left = hand === 'L';
  const magKey = left ? 'mag2' : 'mag', nextKey = left ? 'nextShotL' : 'nextShot';
  const justDown = left ? rmbJustDown : mouseJustDown;
  if (!player.alive || player.reloading > 0 || t < (player[nextKey] || 0)) return;
  if (isFreeze()) return; // CS freeze: no shooting (post-round stays live)
  if (keys['KeyE'] && playerNearPlantedBomb()) return; // hands busy defusing
  if (keys['KeyE'] && playerInPlantSite()) return; // hands busy planting (PvP T)
  if (def.melee) { meleeSlash(t, wkey, def); return; }
  if (def.portal) { firePortal(t, hand); return; }
  if (wkey === 'helix') {
    // HELIX ARC: battery cell (mag 1, no reserve — recharges via reload clock).
    if (w[magKey] <= 0) {
      AudioSys.click(300, 0.06, 0.3); player[nextKey] = t + 0.3;
      startReload();
      return;
    }
    // Spin-up gate: the shot breaks when the rotor winds past spinThreshold —
    // spinrate is the defining factor, not hold time. (Rotor inertia + whine
    // are driven per-frame in movement.js; this just gates the shot.)
    if (!player._helixSpin || t - player._helixSpin < 0) player._helixSpin = t;
    if (vmRig.helixRate < (def.spinThreshold || 44)) {
      player[nextKey] = t + 0.05; // stay trigger-hot; fires once wound
      return;
    }
  } else
  if (w[magKey] <= 0) {
    AudioSys.click(300, 0.06, 0.3); player[nextKey] = t + 0.3;
    if (!dual || (w.mag <= 0 && (w.mag2 | 0) <= 0)) startReload();
    return;
  }
  if (!def.auto && !justDown) return;
  // spray reset after pause (tap = accurate again)
  if (t - player.lastShotT > 0.5) { player.sprayIdx = 0; }
  player[nextKey] = t + def.fireInterval;
  player.lastShotT = t;
  w[magKey]--; G.shots++;
  // --- spread: base + heat bloom + movement + air ---
  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  const moveF = 1 + clamp(hSpeed / 5, 0, 1) * (wkey === 'awp' ? 2.2 : wkey === 'p90' ? 0.45 : 1.1) * (dual ? DUAL.moveMul : 1);
  const airF = player.onGround ? 1 : player.wallRun ? (wkey === 'awp' ? 3 : 1.5) : (wkey === 'awp' ? 5 : 2.2);
  const crouchF = player.onGround ? 1 - 0.3 * (player.crouch || 0) : 1; // crouched = steadier
  const aimK = vmRig.aimK || 0;
  const spreadBase = dual ? def.spreadHip * DUAL.spreadMul + DUAL.spreadAdd : def.spreadHip + (def.spreadAim - def.spreadHip) * aimK;
  const bloomNow = player.bloom;
  const spread = (spreadBase + bloomNow) * moveF * airF * crouchF;
  // punch + shake are applied to the camera, so shoot from the *punched* view
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  dir.x += rand(-spread, spread); dir.y += rand(-spread, spread); dir.z += rand(-spread, spread);
  dir.normalize();
  setCrossGap(clamp(6 + spread * 950 + bloomNow * 550, 6, 46));
  const origin = new THREE.Vector3(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0), player.pos.z).add(dir.clone().multiplyScalar(0.4));
  if (dual) origin.addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), left ? -0.16 : 0.16);
  const muzzleObj = left && vmL ? vmL.muzzle : vmMuzzle;
  const flashObj = left && vmL ? vmL.flash : vmFlashGroup;
  const muzzleWorld = new THREE.Vector3();
  if (muzzleObj) muzzleObj.getWorldPosition(muzzleWorld);
  else muzzleWorld.copy(origin);
  spawnTracer(muzzleWorld, origin.clone().add(dir.clone().multiplyScalar(2.2)), def.tracer, wkey === 'helix' ? 4 : 1);
  const helixShot = wkey === 'helix';
  const hitRet = fireHitscan({ team: player.team || 'ct', isPlayer: true }, origin, dir, def, t);
  if (helixShot) {
    // Over-the-top beam: fat lingering beam + muzzle star + impact storm + scorch.
    try {
      const hx = (hitRet && isFinite(hitRet.d)) ? hitRet.d : def.range;
      const end = origin.clone().add(dir.clone().multiplyScalar(hx));
      spawnTracer(origin.clone(), end.clone(), 0xd8fbff, 4);
      spawnTracer(muzzleWorld.clone(), end.clone(), 0x66f6ff, 2.5);
      spawnFireball(muzzleWorld.clone(), 3.2, 0.35);
      spawnShockwave(muzzleWorld.clone(), 4, 0.4, 0x66f6ff);
      spawnShockwave(end.clone(), 7, 0.5, 0x9ff3ff);
      spawnBurst(muzzleWorld.clone(), 0x9ff3ff, 24, 9, 0.5, 0.12);
      spawnBurst(end.clone(), 0xd8fbff, 30, 11, 0.6, 0.12);
      spawnBurst(end.clone(), 0x66f6ff, 20, 7, 0.7, 0.14);
      try { spawnDecal('scorch', end, dir.clone().negate(), 1.6 + Math.random() * 0.8); } catch {}
      muzzleLight.position.copy(muzzleWorld);
      muzzleLight.intensity = 14; muzzleLight.distance = 34;
      try { flashExplosionOverlay(); } catch {}
      player._helixSpin = 0; // next cell needs a fresh spin-up
    } catch {}
  }
  // Relay tracer to remotes so they see/hear our shot.
  try {
    if (isOnline()) Net.sendShot({
      ox: origin.x, oy: origin.y, oz: origin.z,
      dx: dir.x, dy: dir.y, dz: dir.z,
      weapon: def.name, tracer: def.tracer, sound: def.sound,
    });
  } catch {}
  // --- heat up ---
  player.bloom = Math.min(def.bloomMax * (dual ? DUAL.bloomMaxMul : 1), player.bloom + def.bloomAdd * (dual ? DUAL.bloomMul : 1) * (player.aiming ? 0.55 : 1) * moveF * (1 - 0.3 * (player.crouch || 0)));
  // --- true recoil (permanent climb — pull down to compensate) ---
  let patX = 0, patY = 1;
  if (wkey === 'ak') {
    const p = SPRAY_AK[Math.min(player.sprayIdx, SPRAY_AK.length - 1)];
    patX = p[0]; patY = p[1];
  } else if (wkey === 'deagle') { patX = rand(-0.5, 0.5); patY = 1; }
  else if (wkey === 'p90') { patX = Math.sin(player.sprayIdx * 0.9) * 0.6 + rand(-0.3, 0.3); patY = player.sprayIdx < 8 ? 1 : 0.55; }
  else { patX = rand(-0.4, 0.4); patY = 1; }
  const aimMul = (player.aiming ? (wkey === 'awp' ? 0.85 : 0.62) : 1) * (player.onGround ? 1 - 0.15 * (player.crouch || 0) : 1);
  // first bullet is the accurate one
  const firstMul = player.sprayIdx === 0 ? 0.85 : 1;
  if (dual) {
    // two guns bucking out of sync: big climb, and each gun whips the view toward its own side
    const heat = 1 + clamp(player.sprayIdx / 6, 0, 1.2);
    player.pitch += def.kickUp * DUAL.kickUpMul * rand(0.55, 1.45) * heat;
    player.yaw += rand(-def.kickSide, def.kickSide) * DUAL.kickSideMul * heat + (left ? 1 : -1) * DUAL.whip * rand(0.6, 1.3) * (def.kickUp / 0.0115 * 0.35 + 0.65);
    vmRig.roll += (left ? -1 : 1) * DUAL.roll * rand(0.6, 1.2);
  } else {
  player.pitch += def.kickUp * patY * aimMul * firstMul;
  player.yaw += (rand(-def.kickSide, def.kickSide) + patX * def.kickSide * 0.9) * aimMul;
  }
  player.pitch = clamp(player.pitch, -1.45, 1.45);
  if (wkey === 'helix') vmRig.roll += rand(-0.09, 0.09); // coil discharge slams the view sideways
  player.sprayIdx++;
  // --- recoverable punch / shake / fov (game feel, springs back) ---
  vmRig.punchP += def.punch * (player.aiming ? 0.6 : 1);
  vmRig.punchY += rand(-def.punch, def.punch) * 0.4;
  vmRig.shake += def.shake;
  vmRig.fovKick += def.fovPunch * (player.aiming ? 0.4 : 1);
  // --- viewmodel spring kick + flash + shell + smoke ---
  soldierFireKick(playerMesh, 0.85);
  if (left) { vmRig.kickVL += def.vmKick * 19; vmRig.kickRotVL += def.punch * 12; vmRig.shake += def.shake; }
  else { vmRig.kickV += def.vmKick * (dual ? 19 : 15) * (player.aiming ? 0.65 : 1); vmRig.kickRotV += def.punch * (dual ? 12 : 9); if (dual) vmRig.shake += def.shake; }
  if (flashObj) {
    for (const f of flashObj.children) {
      f.material.opacity = 1;
      f.rotation.z = Math.random() * Math.PI * 2;
      const s = (wkey === 'helix' ? 3.4 : wkey === 'awp' ? 1.9 : wkey === 'deagle' ? 1.35 : wkey === 'p90' ? 0.75 : 1.0) * rand(0.9, 1.15);
      f.scale.set(s, s, 1);
    }
  }
  if (muzzleObj) {
    const mp = new THREE.Vector3(); muzzleObj.getWorldPosition(mp);
    if (wkey === 'helix') { try { spawnBurst(mp, 0x9ff3ff, 8, 4, 0.4, 0.1); } catch {} } // plasma wisps, no powder smoke
    else if (wkey !== 'awp' || !player.aiming) spawnSmoke(mp, wkey === 'awp' ? 0.3 : 0.18, 0.55);
    // eject brass to the right (coilgun: no brass)
    if (wkey !== 'helix') {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const ejectP = mp.addScaledVector(right, -0.06).addScaledVector(up, -0.03);
    spawnShell(ejectP, right, up, fwd);
    }
  }
  if (wkey === 'awp') {
    vmRig.boltT = 0.45;
    setTimeout(() => AudioSys.mech(), 320);
  }
  if (left) setRmbJustDown(false); else setMouseJustDown(false);
  if (w.mag === 0 && (!dual || (w.mag2 | 0) === 0)) { const rk = wkey; setTimeout(() => { if (player.cur === rk) startReload(); }, 260); }
  updateHUD();
}
export function startReload() {
  if (isNadeKey(player.cur)) return;
  const wkey = player.cur, w = player.weapons[wkey], def = WEAPONS[wkey];
  if (!w || !def) return;
  if (def.melee || def.portal) return; // nothing to reload — the blade is always ready, portals are infinite
  if (wkey === 'helix') {
    // Battery recharge: no reserve, 5s cell cycle. Manual R restarts it.
    if (player.reloading > 0 || w.mag >= def.magSize || !player.alive) return;
    player.reloading = def.reloadTime; player.reloadDur = def.reloadTime;
    player.sprayIdx = 0; player._helixSpin = 0;
    AudioSys.click(500, 0.15, 0.3);
    AudioSys.reload();
    try {
      if (isOnline()) Net.sendHelix({ action: 'reload', x: player.pos.x, y: player.pos.y + 1.4, z: player.pos.z });
    } catch {}
    const tip = $('reload-tip'); tip.textContent = 'RECHARGING…'; tip.classList.remove('hidden');
    return;
  }
  const needMag = (def.magSize - w.mag) + (w.dual ? def.magSize - (w.mag2 | 0) : 0);
  if (player.reloading > 0 || needMag <= 0 || w.reserve <= 0 || !player.alive) return;
  const rt = def.reloadTime * (w.dual ? DUAL.reloadMul : 1);
  player.reloading = rt; player.reloadDur = rt;
  player.sprayIdx = 0;
  AudioSys.reload();
  $('reload-tip').classList.remove('hidden');
}
export function finishReload() {
  if (isNadeKey(player.cur)) { player.reloading = 0; return; }
  const wkey = player.cur, w = player.weapons[wkey], def = WEAPONS[wkey];
  if (!w || !def) { player.reloading = 0; return; }
  if (def.melee || def.portal) { player.reloading = 0; return; }
  if (wkey === 'helix') {
    w.mag = def.magSize; w.reserve = 0;
    player.reloading = 0; player.bloom = 0; player._helixSpin = 0;
    const tip = $('reload-tip'); tip.textContent = 'RELOADING…'; tip.classList.add('hidden');
    try { AudioSys.helixReady(); } catch {}
    try {
      if (isOnline()) Net.sendHelix({ action: 'ready', x: player.pos.x, y: player.pos.y + 1.4, z: player.pos.z });
    } catch {}
    try { announce('HELIX CHARGED ⚡', 800); } catch {}
    updateHUD();
    return;
  }
  const need = def.magSize - w.mag, take = Math.min(need, w.reserve);
  w.mag += take; w.reserve -= take;
  if (w.dual) { const t2 = Math.min(def.magSize - (w.mag2 | 0), w.reserve); w.mag2 = (w.mag2 | 0) + t2; w.reserve -= t2; }
  player.reloading = 0;
  player.bloom = 0;
  $('reload-tip').classList.add('hidden');
  updateHUD();
}
export function switchWeapon(key) {
  if (!player.alive) return;
  if (player.carryingNuke && key !== 'nuke') { announce('HANDS FULL — LIVE NUKE (X TO DISARM)', 1200); AudioSys.dryfire(); return; }
  if (isNadeKey(key)) {
    if ((player.nades[key] || 0) <= 0) { announce(`${NADE_DEFS[key].name} EMPTY — PRESS B`, 1100); AudioSys.dryfire(); return; }
    if (player.cur === key) return;
    player.last = player.cur; player.cur = key;
    player.cook = null;
    player.reloading = 0; $('reload-tip').classList.add('hidden');
    player.bloom = 0; player.sprayIdx = 0; player.aiming = false;
    buildViewmodel(key);
    AudioSys.pin();
    updateHUD();
    return;
  }
  if (!player.weapons[key] || !player.weapons[key].owned || player.cur === key) return;
  player.last = player.cur; player.cur = key;
  player.cook = null;
  try { updateInteractHUD(null); } catch (e) {}
  player.reloading = 0; $('reload-tip').classList.add('hidden');
  player.bloom = 0; player.sprayIdx = 0;
  player._helixSpin = 0; // fresh trigger for the coilgun
  // You cannot carry a sight picture through a weapon swap — dropping ADS also
  // stops the new gun snapping straight to its aim pose with no raise animation.
  player.aiming = false;
  buildViewmodel(key);
  AudioSys.click(1200, 0.05, 0.3);
  setTimeout(() => AudioSys.click(900, 0.05, 0.25), 120);
  updateHUD();
}

