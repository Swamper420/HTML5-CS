// js/pickups.js — AGENTS: Dropped weapons: drop (X), pick up (walk over / E), dual wield rules, world weapon entities + net sync.
// Ownership: worldWeapons[], DUAL, spawnWorldWeapon, dropWeapon, applyPickup, updateWorldWeapons.

import * as THREE from 'three';
import { Net } from '../net.js';
import { AudioSys } from './audio.js';
import { CROUCH_EYE_DROP, EYE, MAP_HALF, PRIMARIES, SLOT_ORDER, WEAPONS } from './config.js';
import { $, clamp, rand } from './utils.js';
import { TAU } from './anim.js';
import { collidesAt, rayWallDist, supportHeightAt } from './collision.js';
import { playerInPlantSite, playerNearPlantedBomb } from './combat.js';
import { _worldGunMats, buildGunModel, gunMats, setWorldGunMats } from './gunmodels.js';
import { announce, updateHUD } from './hud.js';
import { isOnline } from './multiplayer.js';
import { scene } from './render.js';
import { switchWeapon } from './shooting.js';
import { G, player, primaryKey } from './state.js';
import { buildViewmodel } from './viewmodel.js';

// Any firearm can be dropped and picked up. Picking up a second copy of a gun you
// already carry puts one in each hand. Dual wielding: LMB fires the right gun, RMB
// the left, no sights, huge spread, violent alternating recoil and a constant
// wandering aim — double the firepower, a fraction of the control.
export const DUAL = {
  spreadMul: 3.4, spreadAdd: 0.014,   // hip spread multiplier + flat add
  moveMul: 1.8,                        // extra movement inaccuracy
  bloomMul: 2.6, bloomMaxMul: 3.2,     // heat builds faster and higher
  kickUpMul: 2.4, kickSideMul: 5.5,    // raw recoil
  whip: 0.018,                         // each gun yanks the view toward its own side
  roll: 0.045,                         // camera roll kick per shot
  driftYaw: 0.020, driftPitch: 0.013,  // rad/s wandering aim (grows with speed + heat)
  reloadMul: 1.85,                     // reloading two guns
  speedMul: 0.92,
  reserveMul: 2,                       // carry double reserve
};
const PICKUP_RANGE = 1.35;
const E_RANGE = 2.4; // E reaches further than the auto-pickup radius
const E_QUEUE = 0.4; // E press stays valid this long (s), so edge presses aren't lost
const worldWeapons = new Map(); // wid -> { wid, key, mag, reserve, mesh, pos, vel, rest, ry, spin, pendingUntil, mine, noPickupUntil }
let _wwSeq = 0;
export const newWid = () => `${isOnline() && Net.id ? Net.id : 'L'}.${Date.now().toString(36)}.${(_wwSeq++).toString(36)}`;
export const reserveCap = (key, dual) => (WEAPONS[key] ? WEAPONS[key].startReserve * (dual ? DUAL.reserveMul : 1) : 0);
export const isDualCur = () => { const w = player.weapons[player.cur]; return !!(w && w.owned && w.dual && WEAPONS[player.cur]); };

export function spawnWorldWeapon(o) {
  if (!o || !WEAPONS[o.key] || worldWeapons.has(o.wid)) return null;
  if (!_worldGunMats) setWorldGunMats(gunMats());
  const mesh = new THREE.Group();
  const holder = new THREE.Group();
  holder.scale.setScalar(0.9);
  holder.rotation.z = Math.PI / 2; // lying on its side
  holder.position.y = 0.06;
  mesh.add(holder);
  try { buildGunModel(o.key, _worldGunMats, holder, holder, { world: true }); } catch (e) { console.warn('world gun', e); }
  holder.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  const e = {
    wid: o.wid, key: o.key, mag: Math.max(0, o.mag | 0), reserve: Math.max(0, o.reserve | 0),
    mesh, pos: new THREE.Vector3(+o.x || 0, +o.y || 0, +o.z || 0),
    vel: new THREE.Vector3(+o.vx || 0, +o.vy || 0, +o.vz || 0),
    rest: !!o.rest, ry: +o.ry || Math.random() * TAU, spin: rand(-9, 9),
    pendingUntil: 0, mine: !!o.mine, noPickupUntil: +o.noPickupUntil || 0, bornT: performance.now() / 1000,
  };
  mesh.position.copy(e.pos); mesh.rotation.y = e.ry;
  scene.add(mesh);
  worldWeapons.set(e.wid, e);
  return e;
}
function removeWorldWeapon(wid) {
  const e = worldWeapons.get(wid);
  if (!e) return null;
  try { scene.remove(e.mesh); } catch (err) {}
  worldWeapons.delete(wid);
  return e;
}
export function clearWorldWeapons() { for (const wid of [...worldWeapons.keys()]) removeWorldWeapon(wid); }

// Throw a gun out of the player's hands (or off their corpse). Returns the entries spawned.
function throwWeaponEntry(key, mag, reserve, fromDeath) {
  const fwd = new THREE.Vector3(-Math.sin(player.yaw) * Math.cos(player.pitch), Math.sin(player.pitch), -Math.cos(player.yaw) * Math.cos(player.pitch));
  let p, v;
  if (fromDeath) {
    p = new THREE.Vector3(player.pos.x + rand(-0.3, 0.3), player.pos.y + 1.0, player.pos.z + rand(-0.3, 0.3));
    v = new THREE.Vector3(rand(-1.5, 1.5) + player.vel.x * 0.5, rand(1, 2.5), rand(-1.5, 1.5) + player.vel.z * 0.5);
  } else {
    const eye = new THREE.Vector3(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0) - 0.25, player.pos.z);
    const reach = Math.max(0, Math.min(0.5, rayWallDist(eye, fwd, 0.8) - 0.3));
    p = eye.addScaledVector(fwd, reach);
    v = fwd.clone().multiplyScalar(4.2).add(new THREE.Vector3(player.vel.x * 0.8, 1.6, player.vel.z * 0.8));
  }
  const o = { wid: newWid(), key, mag, reserve, x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z, ry: player.yaw + Math.PI / 2, mine: true, noPickupUntil: performance.now() / 1000 + 1.0 };
  const e = spawnWorldWeapon(o);
  try { if (isOnline()) Net.sendWeapon({ action: 'drop', wid: o.wid, key, mag, reserve, x: o.x, y: o.y, z: o.z, vx: o.vx, vy: o.vy, vz: o.vz, ry: o.ry }); } catch (err) {}
  return e;
}

// Drop `key`. Dual: drops the left-hand copy (both:true drops both). fromDeath skips the last-gun rule.
export function dropWeapon(key, { both = false, fromDeath = false } = {}) {
  const w = player.weapons[key], def = WEAPONS[key];
  if (!w || !w.owned || !def) return false;
  if (!fromDeath && !w.dual) {
    const others = SLOT_ORDER.filter((k) => k !== key && player.weapons[k] && player.weapons[k].owned);
    if (!others.length) { announce("CAN'T DROP YOUR LAST GUN", 900); AudioSys.click(250, 0.08, 0.3); return false; }
  }
  if (w.dual) {
    const half = Math.floor(w.reserve / 2);
    throwWeaponEntry(key, w.mag2 | 0, half, fromDeath);
    w.reserve -= half; w.mag2 = 0; w.dual = false;
    if (both) {
      throwWeaponEntry(key, w.mag, w.reserve, fromDeath);
      w.owned = false; w.mag = 0; w.reserve = 0;
    } else {
      w.reserve = Math.min(w.reserve, reserveCap(key, false));
    }
  } else {
    throwWeaponEntry(key, w.mag, w.reserve, fromDeath);
    w.owned = false; w.mag = 0; w.reserve = 0;
  }
  if (fromDeath) return true;
  player.reloading = 0; $('reload-tip').classList.add('hidden');
  if (player.cur === key) {
    if (w.owned) { player.aiming = false; buildViewmodel(key); }
    else {
      const fb = (player.last && player.last !== key && player.weapons[player.last] && player.weapons[player.last].owned) ? player.last
        : (SLOT_ORDER.find((k) => player.weapons[k] && player.weapons[k].owned) || 'deagle');
      player.cur = fb === key ? 'deagle' : fb;
      player.aiming = false; buildViewmodel(player.cur);
    }
  }
  if (player.last === key && !w.owned) player.last = 'deagle';
  AudioSys.click(700, 0.05, 0.25);
  updateHUD();
  return true;
}
export function dropAllOnDeath() {
  // CS: your best gun hits the floor where you fall (both, if you were dual wielding).
  // A dual-wielded sidearm isn't the primary, so drop the pair too — else it vanishes with the corpse.
  const pk = primaryKey();
  const key = pk || (player.weapons.deagle && player.weapons.deagle.owned ? 'deagle' : null);
  if (key) dropWeapon(key, { both: true, fromDeath: true });
  for (const k of SLOT_ORDER) {
    if (k === key) continue;
    const w = player.weapons[k];
    if (w && w.owned && w.dual) dropWeapon(k, { both: true, fromDeath: true });
  }
}

// What pressing E on this weapon would do (null = nothing useful).
function pickupAction(e) {
  const w = player.weapons[e.key];
  if (!w) return null;
  if (!w.owned) {
    if (PRIMARIES.includes(e.key)) { const pk = primaryKey(); return pk ? { kind: 'swap', auto: false, label: `E — SWAP ${WEAPONS[pk].name} FOR ${WEAPONS[e.key].name}` } : { kind: 'take', auto: true }; }
    return { kind: 'take', auto: true };
  }
  if (!w.dual) return { kind: 'dual', auto: false, label: `E — DUAL WIELD ${WEAPONS[e.key].name}` };
  if (w.reserve < reserveCap(e.key, true) && (e.mag + e.reserve) > 0) return { kind: 'ammo', auto: false, label: `E — TAKE AMMO (${WEAPONS[e.key].name})` };
  return null;
}
function requestPickup(e) {
  const t = performance.now() / 1000;
  if (e.pendingUntil > t) return;
  e.pendingUntil = t + 1.5;
  if (isOnline()) { try { Net.sendWeapon({ action: 'pickup', wid: e.wid }); } catch (err) {} }
  else { removeWorldWeapon(e.wid); applyPickup(e); }
}
function applyPickup(d) {
  const key = d.key, def = WEAPONS[key], w = player.weapons[key];
  if (!def || !w || !player.alive) {
    // raced into death / bad data: put it back on the floor
    if (def) throwWeaponEntry(key, d.mag | 0, d.reserve | 0, true);
    return;
  }
  const mag = Math.min(def.magSize, d.mag | 0), reserve = d.reserve | 0;
  AudioSys.click(1300, 0.05, 0.3);
  setTimeout(() => AudioSys.click(950, 0.05, 0.25), 90);
  if (!w.owned) {
    if (PRIMARIES.includes(key)) {
      const pk = primaryKey();
      if (pk && !dropWeapon(pk, { both: true })) {
        // swap must never leave two primaries: force-clear the old one
        const ow = player.weapons[pk];
        if (ow) { ow.owned = false; ow.mag = 0; ow.reserve = 0; ow.dual = false; ow.mag2 = 0; }
      }
    }
    w.owned = true; w.dual = false; w.mag = mag; w.mag2 = 0; w.reserve = Math.min(reserve, reserveCap(key, false));
    announce(`PICKED UP ${def.name}`, 800);
    if (PRIMARIES.includes(key) || !player.cur || !player.weapons[player.cur] || !player.weapons[player.cur].owned) {
      if (player.cur === key) buildViewmodel(key); else switchWeapon(key);
    }
  } else if (!w.dual) {
    w.dual = true; w.mag2 = mag;
    w.reserve = Math.min(reserveCap(key, true), w.reserve + reserve);
    announce(`DUAL ${def.name.toUpperCase()}S — LMB RIGHT · RMB LEFT`, 1400);
    player.aiming = false; player.reloading = 0; $('reload-tip').classList.add('hidden');
    if (player.cur === key) buildViewmodel(key); else switchWeapon(key);
  } else {
    w.reserve = Math.min(reserveCap(key, true), w.reserve + mag + reserve);
    announce(`+AMMO ${def.name}`, 700);
  }
  updateHUD();
}

let _pickupHintKey = '';
export function setPickupHint(txt) {
  if (txt === _pickupHintKey) return;
  _pickupHintKey = txt;
  const el = $('pickup-hint');
  if (!el) return;
  if (!txt) el.classList.add('hidden'); else { el.textContent = txt; el.classList.remove('hidden'); }
}
export function updateWorldWeapons(dt, t) {
  // --- physics: toss, bounce off walls, settle on floor / box tops ---
  const probe = new THREE.Vector3();
  for (const e of worldWeapons.values()) {
    if (e.rest) continue;
    e.vel.y -= 13.5 * dt;
    probe.set(e.pos.x + e.vel.x * dt, e.pos.y, e.pos.z);
    if (collidesAt(probe, 0.14, 0.12)) e.vel.x *= -0.35; else e.pos.x = clamp(probe.x, -MAP_HALF, MAP_HALF);
    probe.set(e.pos.x, e.pos.y, e.pos.z + e.vel.z * dt);
    if (collidesAt(probe, 0.14, 0.12)) e.vel.z *= -0.35; else e.pos.z = clamp(probe.z, -MAP_HALF, MAP_HALF);
    const prevY = e.pos.y;
    e.pos.y += e.vel.y * dt;
    const floor = supportHeightAt(e.pos.x, e.pos.z, prevY, 0.1);
    if (e.pos.y <= floor) {
      e.pos.y = floor;
      if (e.vel.y < -2.5) { e.vel.y *= -0.28; e.spin *= 0.5; try { AudioSys.step(e.pos.clone(), false); } catch (err) {} }
      else e.vel.y = 0;
      e.vel.x *= Math.max(0, 1 - dt * 7); e.vel.z *= Math.max(0, 1 - dt * 7);
      e.spin *= Math.max(0, 1 - dt * 6);
      if (e.vel.y === 0 && Math.hypot(e.vel.x, e.vel.z) < 0.12) {
        e.rest = true; e.vel.set(0, 0, 0);
        // the dropper settles the final resting spot for everyone
        if (e.mine && isOnline()) { try { Net.sendWeapon({ action: 'rest', wid: e.wid, x: e.pos.x, y: e.pos.y, z: e.pos.z, ry: e.ry }); } catch (err) {} }
      }
    }
    e.ry += e.spin * dt;
    e.mesh.position.copy(e.pos); e.mesh.rotation.y = e.ry;
  }
  // --- pickup ---
  // E press lives briefly (E_QUEUE) so edge presses aren't lost; only consume it on use.
  const wantE = (t - (player.useQueued || 0)) < E_QUEUE;
  const consumeE = () => { player.useQueued = 0; };
  if (t - (player.useQueued || 0) > E_QUEUE) player.useQueued = 0;
  if (!player.alive || G.phase !== 'playing' || G.buyOpen) { setPickupHint(''); return; }
  // nearest-first candidates within E reach (skip guns awaiting server pickup)
  const near = [];
  for (const e of worldWeapons.values()) {
    if (e.pendingUntil > t) continue;
    const dy = e.pos.y - player.pos.y;
    if (dy < -0.6 || dy > 1.4) continue;
    const d = Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z);
    if (d < E_RANGE) near.push([d, e]);
  }
  near.sort((a, b) => a[0] - b[0]);
  let best = null, bestAct = null;
  for (const [d, e] of near) {
    const act = pickupAction(e);
    if (act) { best = e; bestAct = act; break; }
  }
  if (!best) {
    // E on an already-owned full gun still switches to it
    if (wantE && near.length) {
      const owned = near.find(([d, e]) => d < E_RANGE && player.weapons[e.key] && player.weapons[e.key].owned && WEAPONS[e.key]);
      if (owned) { consumeE(); try { switchWeapon(owned[1].key); } catch (err) {} }
    }
    setPickupHint('');
    return;
  }
  const act = bestAct;
  if (act.auto) {
    setPickupHint('');
    const dAuto = Math.hypot(best.pos.x - player.pos.x, best.pos.z - player.pos.z);
    if (dAuto < PICKUP_RANGE && t >= best.noPickupUntil) { consumeE(); requestPickup(best); }
    else if (wantE && dAuto < E_RANGE) { consumeE(); requestPickup(best); }
    return;
  }
  // E is shared with plant/defuse — the bomb always wins (E press kept for after)
  const bombBusy = (typeof playerNearPlantedBomb === 'function' && playerNearPlantedBomb()) || (player.hasBomb && typeof playerInPlantSite === 'function' && playerInPlantSite());
  if (bombBusy) { setPickupHint(''); return; }
  setPickupHint(act.label);
  // E grabs from further out than the auto radius; noPickupUntil only gates auto
  if (wantE && Math.hypot(best.pos.x - player.pos.x, best.pos.z - player.pos.z) < E_RANGE) { consumeE(); requestPickup(best); }
}
export function applyRemoteWeapon(m) {
  if (m.action === 'drop') {
    if (typeof m.wid !== 'string' || m.wid.length > 64 || !WEAPONS[m.key]) return;
    if (!isFinite(+m.x + +m.y + +m.z)) return;
    spawnWorldWeapon({ wid: m.wid, key: m.key, mag: clamp(m.mag | 0, 0, 50), reserve: clamp(m.reserve | 0, 0, 250), x: clamp(+m.x || 0, -MAP_HALF - 6, MAP_HALF + 6), y: clamp(+m.y || 0, -1, 12), z: clamp(+m.z || 0, -MAP_HALF - 6, MAP_HALF + 6), vx: +m.vx || 0, vy: +m.vy || 0, vz: +m.vz || 0, ry: +m.ry || 0 });
  } else if (m.action === 'rest') {
    const e = worldWeapons.get(m.wid);
    if (e && isFinite(+m.x + +m.y + +m.z)) { e.pos.set(+m.x || 0, +m.y || 0, +m.z || 0); e.ry = +m.ry || e.ry; e.vel.set(0, 0, 0); e.rest = true; e.mesh.position.copy(e.pos); e.mesh.rotation.y = e.ry; }
  } else if (m.action === 'pickup') {
    const local = removeWorldWeapon(m.wid);
    if (m.byId === Net.id) applyPickup(local || m);
  } else if (m.action === 'deny') {
    removeWorldWeapon(m.wid);
  } else if (m.action === 'sync') {
    for (const d of (m.drops || [])) spawnWorldWeapon({ ...d, rest: true, vx: 0, vy: 0, vz: 0 });
  }
}

