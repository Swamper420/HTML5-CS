// js/grenades.js — AGENTS: Grenade core: projectiles (throw/cook/bounce), HE + flashbang detonation, flash overlay, nade meshes.
// Ownership: nadeProjectiles/tacticalSmokes/fireZones arrays, throwNade, updateNades, detonateHE/Flash. Smoke -> smoke.js, molotov -> molotov.js.

import * as THREE from 'three';
import { Net } from '../net.js';
import { AudioSys } from './audio.js';
import { CROUCH_EYE_DROP, EYE, NADE_DEFS, isNadeKey } from './config.js';
import { opts } from './settings.js';
import { $, clamp, rand } from './utils.js';
import { updateInteractHUD } from './bomb.js';
import { botChest, botEye } from './bots.js';
import { hasLOS, rayWallDist } from './collision.js';
import { damageBot, damagePlayer, playerInPlantSite, playerNearPlantedBomb } from './combat.js';
import {
  decalTextures, spawnBurst, spawnDebris, spawnDecal, spawnFireball, spawnShockwave, spawnSmoke,
  spawnWorldFlash,
} from './effects.js';
import { announce, flashExplosionOverlay, playerHitmark, updateHUD } from './hud.js';
import { colliders } from './map.js';
import { igniteMolotov, updateFires } from './molotov.js';
import { isOnline, remoteEye, remotes } from './multiplayer.js';
import { camera, muzzleLight, renderer, scene } from './render.js';
import { isRoundHost } from './rounds.js';
import { switchWeapon } from './shooting.js';
import { deploySmoke, disperseSmokes, smokeDensityAt, smokePushAt, updateTacticalSmokes } from './smoke.js';
import { G, bots, isFreeze, keys, player, primaryKey } from './state.js';
import { buildViewmodel, vmRig } from './viewmodel.js';

// Projectiles are simulated on every client from throw events (victim-applies damage,
// thrower only predicts hitmarkers). This keeps solo + PvP consistent with no extra RTT.
export const nadeProjectiles = []; // {type, pos, vel, fuse, owner, mesh, spin, bounces, lastBounceSfx}
export const tacticalSmokes = [];  // {pos, radius, born, until, puffs:[{mesh, seed}], drift}
export const fireZones = [];       // {pos, radius, until, owner, light, flames:[], tickAt, burnSfxAt}
const NADE_GRAV = 9.0;          // CS-ish floaty arc (was 16.5 → short, heavy lobs)
const NADE_RADIUS = 0.07;
const _nadeTmp = { v: null };

function nadeOwnerName(o) {
  if (!o) return '???';
  if (o.isPlayer) return (player.name || 'YOU');
  if (o.bot) return o.bot.short || 'Bot';
  if (o.remoteName) return o.remoteName;
  return '???';
}
export function nadeOwnerTeam(o) {
  if (!o) return 't';
  if (o.isPlayer) return (player.team || 'ct');
  if (o.team) return o.team;
  return 't';
}
export function makeNadeMesh(type) {
  const g = new THREE.Group();
  try {
    const def = NADE_DEFS[type];
    const dark = new THREE.MeshStandardMaterial({ color: 0x1f2226, roughness: 0.5, metalness: 0.6 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.35, metalness: 0.85 });
    if (type === 'nuke') {
      // Hand-carried atomic bomb: black sphere, yellow warning band, pulsing core glow.
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12),
        new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.4, metalness: 0.7 }));
      ball.castShadow = true; g.add(ball);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.016, 8, 24),
        new THREE.MeshStandardMaterial({ color: 0xffd21f, roughness: 0.6, emissive: 0x7a5c00, emissiveIntensity: 0.4 }));
      band.rotation.x = Math.PI / 2; g.add(band);
      const T = decalTextures();
      const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xff3b1f, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
      gl.scale.setScalar(0.34); g.add(gl);
      g.userData.blink = gl;
      return g;
    }
    if (type === 'molotov') {
      const glass = new THREE.MeshStandardMaterial({ color: 0x3f6b2a, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.9 });
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.16, 10), glass);
      bottle.castShadow = true; g.add(bottle);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.04, 0.07, 8), glass);
      neck.position.y = 0.11; g.add(neck);
      const rag = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.06, 0.035), new THREE.MeshStandardMaterial({ color: 0xd8cfc0, roughness: 1 }));
      rag.position.y = 0.17; rag.rotation.z = 0.4; g.add(rag);
      const T = decalTextures();
      const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xff9a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
      gl.scale.setScalar(0.22); gl.position.y = 0.2; g.add(gl);
      g.userData.flame = gl;
    } else {
      const col = def ? def.color : 0x4d7c3a;
      const bodyM = new THREE.MeshStandardMaterial({ color: col, roughness: 0.55, metalness: 0.25 });
      let body;
      if (type === 'he') body = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 10), bodyM), body.scale.y = 1.15;
      else body = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.13, 12), bodyM);
      body.castShadow = true; g.add(body);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.035, 8), dark);
      cap.position.y = type === 'he' ? 0.078 : 0.082; g.add(cap);
      const lever = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.1, 0.01), steel);
      lever.position.set(0.05, 0.03, 0); lever.rotation.z = -0.12; g.add(lever);
      if (type === 'smoke') {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.02, 12), new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.6 }));
        g.add(band);
      }
    }
  } catch (e) {}
  return g;
}
// High-definition first-person nades: same silhouettes as makeNadeMesh
// (HE = green egg, flash = light-blue cylinder, smoke = grey cylinder + white band,
// molotov = bottle) so thrown + held types never get confused, with close-up
// detail: segment-dense bodies, caps, grooves, vents, labels, pin + lever.
export function makeFirstPersonNadeMesh(type) {
  const g = new THREE.Group();
  try {
    const dark = new THREE.MeshStandardMaterial({ color: 0x1f2226, roughness: 0.45, metalness: 0.65 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.28, metalness: 0.9 });
    const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
    const pinLever = (py) => {
      mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.032, 12), dark, 0, py, 0);
      const lv = mesh(new THREE.BoxGeometry(0.016, 0.11, 0.012), steel, 0.056, py - 0.045, 0);
      lv.rotation.z = -0.12;
      mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.02, 8), steel, 0.045, py - 0.002, 0).rotation.z = Math.PI / 2;
      const ring = mesh(new THREE.TorusGeometry(0.016, 0.004, 8, 16), steel, -0.04, py + 0.005, 0);
      ring.rotation.y = Math.PI / 2;
      mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.028, 6), steel, -0.02, py + 0.005, 0).rotation.z = Math.PI / 2;
    };
    if (type === 'molotov') {
      const glass = new THREE.MeshStandardMaterial({ color: 0x3f6b2a, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.9 });
      mesh(new THREE.CylinderGeometry(0.048, 0.052, 0.17, 20), glass, 0, 0, 0);
      mesh(new THREE.CylinderGeometry(0.042, 0.046, 0.10, 16), new THREE.MeshStandardMaterial({ color: 0x8a4a12, roughness: 0.35 }), 0, -0.028, 0);
      for (const ry of [-0.05, 0.005]) { const rib = mesh(new THREE.TorusGeometry(0.050, 0.0025, 6, 24), glass, 0, ry, 0); rib.rotation.x = Math.PI / 2; }
      mesh(new THREE.CylinderGeometry(0.053, 0.053, 0.045, 16), new THREE.MeshStandardMaterial({ color: 0xd8cfc0, roughness: 0.9 }), 0, -0.01, 0);
      mesh(new THREE.CylinderGeometry(0.054, 0.054, 0.01, 16), new THREE.MeshStandardMaterial({ color: 0x8a2f22, roughness: 0.8 }), 0, 0.015, 0);
      mesh(new THREE.CylinderGeometry(0.02, 0.042, 0.07, 16), glass, 0, 0.12, 0);
      mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.028, 12), new THREE.MeshStandardMaterial({ color: 0x9a7a4a, roughness: 0.9 }), 0, 0.158, 0);
      const rag = mesh(new THREE.BoxGeometry(0.04, 0.075, 0.04), new THREE.MeshStandardMaterial({ color: 0xe2d9c6, roughness: 1 }), 0.012, 0.20, 0);
      rag.rotation.z = 0.35;
      const knot = mesh(new THREE.BoxGeometry(0.032, 0.03, 0.032), new THREE.MeshStandardMaterial({ color: 0xc9bfa8, roughness: 1 }), -0.012, 0.175, 0);
      knot.rotation.z = 0.5;
      const T = decalTextures();
      const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xff9a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
      gl.scale.setScalar(0.22); gl.position.y = 0.24; g.add(gl);
    } else if (type === 'nuke') {
      // First-person hand nuke: fat black bomb with yellow band + blinking red core light.
      const ball = mesh(new THREE.SphereGeometry(0.11, 28, 20), new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.35, metalness: 0.75 }));
      ball.scale.y = 1.1;
      const band = mesh(new THREE.TorusGeometry(0.11, 0.016, 8, 32), new THREE.MeshStandardMaterial({ color: 0xffd21f, roughness: 0.5, emissive: 0x7a5c00, emissiveIntensity: 0.5 }));
      band.rotation.x = Math.PI / 2;
      mesh(new THREE.CylinderGeometry(0.02, 0.026, 0.05, 12), dark, 0, 0.125, 0);
      const T = decalTextures();
      const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xff3b1f, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
      gl.scale.setScalar(0.3); gl.position.y = 0.16; g.add(gl);
      g.userData.blink = gl;
      pinLever(0.155);
    } else if (type === 'he') {
      const body = mesh(new THREE.SphereGeometry(0.062, 28, 20), new THREE.MeshStandardMaterial({ color: 0x4d7c3a, roughness: 0.5, metalness: 0.3 }));
      body.scale.y = 1.15;
      for (const gy of [-0.025, 0.008]) { const gr = mesh(new THREE.TorusGeometry(0.0615, 0.0022, 6, 28), dark, 0, gy, 0); gr.rotation.x = Math.PI / 2; }
      mesh(new THREE.CylinderGeometry(0.0625, 0.0625, 0.013, 24), new THREE.MeshStandardMaterial({ color: 0xd8b93a, roughness: 0.6 }), 0, 0.035, 0);
      mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.014, 12), dark, 0, -0.074, 0);
      pinLever(0.082);
    } else {
      const isFlash = type === 'flash';
      if (isFlash) {
        // Light-blue flashbang: tapered body, recessed waist channels,
        // vertical grip flutes, stepped collar + knurled bottom rim.
        const blue = new THREE.MeshStandardMaterial({ color: 0x8fc3ec, roughness: 0.32, metalness: 0.5 });
        const blueD = new THREE.MeshStandardMaterial({ color: 0x5d8ab5, roughness: 0.45, metalness: 0.55 });
        mesh(new THREE.CylinderGeometry(0.044, 0.048, 0.14, 28), blue, 0, 0, 0);
        for (const sy of [-0.032, -0.004, 0.024]) { const s = mesh(new THREE.TorusGeometry(0.0465, 0.0032, 6, 28), blueD, 0, sy, 0); s.rotation.x = Math.PI / 2; }
        for (let i = 0; i < 8; i++) {
          const a = i / 8 * Math.PI * 2;
          mesh(new THREE.BoxGeometry(0.006, 0.062, 0.004), blueD, Math.cos(a) * 0.0465, -0.002, Math.sin(a) * 0.0465).rotation.y = -a;
        }
        mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.01, 24), dark, 0, 0.072, 0);
        mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.008, 24), new THREE.MeshStandardMaterial({ color: 0x1d2f45, roughness: 0.6 }), 0, 0.054, 0);
        mesh(new THREE.CylinderGeometry(0.048, 0.049, 0.014, 24), dark, 0, -0.072, 0);
        const rim = mesh(new THREE.TorusGeometry(0.048, 0.0022, 6, 28), steel, 0, -0.064, 0); rim.rotation.x = Math.PI / 2;
      } else {
        const bodyCol = 0x7d8894;
        mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.14, 24), new THREE.MeshStandardMaterial({ color: bodyCol, roughness: 0.32, metalness: 0.55 }), 0, 0, 0);
        mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.012, 20), dark, 0, -0.07, 0);
        mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.035, 20), new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.55 }), 0, 0.048, 0);
        mesh(new THREE.CylinderGeometry(0.0485, 0.0485, 0.007, 20), dark, 0, 0.027, 0);
        for (let i = 0; i < 6; i++) {
          const a = i / 6 * Math.PI * 2;
          mesh(new THREE.BoxGeometry(0.01, 0.012, 0.006), dark, Math.cos(a) * 0.044, -0.048, Math.sin(a) * 0.044).rotation.y = -a;
        }
      }
      pinLever(0.088);
    }
  } catch (e) {}
  return g;
}
function nadeThrowOrigin(dir, forBot, botPos) {
  if (forBot && botPos) return new THREE.Vector3(botPos.x, botPos.y + 1.5, botPos.z).addScaledVector(dir, 0.4);
  try {
    if (camera) return new THREE.Vector3(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0), player.pos.z).addScaledVector(dir, 0.5);
  } catch (e) {}
  return new THREE.Vector3(player.pos.x, player.pos.y + 1.5, player.pos.z);
}
// Central spawn: used by player, bots, and remote replays (fromNet=true skips rebroadcast).
export function throwNade(type, origin, vel, owner, fuseOverride, fromNet = false) {
  // bots/remote clients may still pass old long molotov fuses; CS2 airbursts at 2s
  if (type === 'molotov' && fuseOverride > NADE_DEFS.molotov.fuse) fuseOverride = NADE_DEFS.molotov.fuse;
  const def = NADE_DEFS[type];
  if (!def) return null;
  if (nadeProjectiles.length > 12) {
    const old = nadeProjectiles.shift();
    try { scene.remove(old.mesh); } catch (e) {}
  }
  const mesh = makeNadeMesh(type);
  mesh.position.copy(origin);
  scene.add(mesh);
  const fuse = (fuseOverride !== undefined && fuseOverride !== null) ? fuseOverride : def.fuse;
  const proj = {
    type, pos: origin.clone(), vel: vel.clone(), fuse,
    owner: { isPlayer: !!owner.isPlayer, team: nadeOwnerTeam(owner), bot: owner.bot || null, remoteName: owner.remoteName || null, remoteId: owner.remoteId ?? null, weaponName: def.name },
    mesh, spin: new THREE.Vector3(rand(-3, 3), rand(-6, 6), rand(-9, -5)),
    bounces: 0, born: performance.now() / 1000,
  };
  nadeProjectiles.push(proj);
  try { AudioSys.throwWhoosh(origin); } catch (e) {}
  if (!fromNet && isOnline() && owner.isPlayer) {
    try {
      Net.sendNade({
        action: 'throw', nade: type,
        x: origin.x, y: origin.y, z: origin.z,
        vx: vel.x, vy: vel.y, vz: vel.z, fuse,
      });
    } catch (e) {}
  } else if (!fromNet && isOnline() && owner.bot && isRoundHost()) {
    // Solo-with-guests: host relays bot throws so spectators see the same arcs.
    try {
      Net.sendNade({ action: 'throw', nade: type, x: origin.x, y: origin.y, z: origin.z, vx: vel.x, vy: vel.y, vz: vel.z, fuse, botShort: owner.bot.short || 'Bot', botTeam: owner.bot.team || 't' });
    } catch (e) {}
  }
  return proj;
}
// Ballistic solve for bots: pick an arc that lands near target (fixed 1.1s flight).
export function botThrowNadeAt(bot, type, targetPos) {
  const def = NADE_DEFS[type];
  if (!def || !bot.alive) return null;
  if (bot._nadeAt && performance.now() / 1000 < bot._nadeAt) return null;
  const from = new THREE.Vector3(bot.pos.x, bot.pos.y + 1.5, bot.pos.z);
  const flight = clamp(from.distanceTo(targetPos) / 14, 0.6, 1.4);
  const vel = new THREE.Vector3(
    (targetPos.x - from.x) / flight,
    (targetPos.y + 0.2 - from.y) / flight + 0.5 * NADE_GRAV * flight,
    (targetPos.z - from.z) / flight
  );
  // clamp lob speed so close tosses don't rocket
  const sp = vel.length(), maxSp = def.throwPower + 2;
  if (sp > maxSp) vel.multiplyScalar(maxSp / sp);
  bot._nadeAt = performance.now() / 1000 + rand(9, 16); // per-bot utility cooldown
  try { AudioSys.pin(from); } catch (e) {}
  return throwNade(type, from, vel, { isPlayer: false, team: bot.team, bot }, def.fuse, false);
}
// ---- Player prime / release (CS2: pin on press, throw on release; LMB far · RMB short · both medium) ----
export function playerPrimeNade(type, t, button = 0) {
  if (type === 'nuke') return false; // two-hand live carry — never primed, never thrown
  if (!player.alive || isFreeze() || G.roundEnding || G.phase !== 'playing') return false;
  if ((player.nades[type] || 0) <= 0) { announce(`${NADE_DEFS[type].name} EMPTY — PRESS B`, 1100); AudioSys.dryfire(); return false; }
  if (keys['KeyE'] && (playerNearPlantedBomb() || playerInPlantSite())) return false; // hands busy
  if (player.cook && player.cook.type === type) {
    // second button joins in → medium throw
    if (button === 0) player.cook.lmb = true; else player.cook.rmb = true;
    return true;
  }
  player.cook = { type, lmb: button === 0, rmb: button === 2, heldT: 0, strength: 1 };
  try { AudioSys.pin(); } catch (e) {}
  return true; // throw happens on release, fuse starts then (CS2)
}
// called from mouseup: throw once ALL held buttons are released; strength is decided by what was held
export function playerReleaseNade(button) {
  const c = player.cook;
  if (!c) return;
  const both = c.lmb && c.rmb;
  if (button === 0) c.lmb = false; else if (button === 2) c.rmb = false;
  if (both) c.strength = 0.5;            // LMB+RMB = medium
  if (c.lmb || c.rmb) return;            // still holding the other button
  if (c.strength === 1 && button === 2 && !both) c.strength = 0; // RMB only = underhand
  if (player.alive && G.phase === 'playing' && !isFreeze() && !G.roundEnding && !G.buyOpen) playerThrowNade(c.type, c.strength);
  player.cook = null;
}
function nadeThrowVelocity(strength) {
  // CS: pitch nudged 10° upward at the horizon, fading to 0 at straight up/down
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  let pitch = e.x * 180 / Math.PI; // + = looking up
  pitch = pitch > 0 ? 10 + pitch * (80 / 90) : 10 + pitch * (100 / 90);
  const pr = pitch * Math.PI / 180, yaw = e.y;
  const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pr), Math.sin(pr), -Math.cos(yaw) * Math.cos(pr)).normalize();
  const s = clamp(strength, 0, 1);
  const speed = NADE_DEFS.he.throwPower * (0.3 + 0.7 * s);
  const vel = dir.multiplyScalar(speed);
  vel.x += player.vel.x * 1.1; vel.z += player.vel.z * 1.1;
  vel.y += (player.vel.y || 0) * 1.0; // jump-throws carry
  return vel;
}
function playerThrowNade(type, strength = 1) {
  if (typeof strength === 'boolean') strength = strength ? 0 : 1; // legacy (underhand flag)
  if (!player.alive || isFreeze() || G.roundEnding) { player.cook = null; return; }
  if ((player.nades[type] || 0) <= 0) { player.cook = null; return; }
  const def = NADE_DEFS[type];
  const vel = nadeThrowVelocity(strength);
  const dir = vel.clone().normalize();
  // spawn in front of the eye but never inside a wall
  const eye = new THREE.Vector3(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0) - 0.1, player.pos.z);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const reach = Math.max(0.05, Math.min(0.45, rayWallDist(eye, fwd, 0.6) - 0.15));
  const origin = eye.addScaledVector(fwd, reach);
  player.cook = null;
  player.nades[type]--;
  vmRig.kickV -= 4.5 * (0.5 + strength * 0.5); vmRig.kickRotV -= 5 * (0.4 + strength * 0.6); vmRig.shake += 0.002;
  vmRig.primeK = 0;
  throwNade(type, origin, vel, { isPlayer: true, team: player.team || 'ct' }, def.fuse, false);
  void dir;
  if (player.nades[type] <= 0) {
    const fb = (player.last && !isNadeKey(player.last) && player.weapons[player.last] && player.weapons[player.last].owned) ? player.last : (primaryKey() || 'deagle');
    setTimeout(() => { if (player.alive && player.cur === type && (player.nades[type] || 0) <= 0) switchWeapon(fb); }, 260);
  } else {
    setTimeout(() => { if (player.alive && player.cur === type) buildViewmodel(type); }, 260);
  }
  updateHUD();
}
function updateNadeCook(dt, t) {
  const c = player.cook;
  const want = c ? 1 : 0;
  vmRig.primeK = (vmRig.primeK || 0) + (want - (vmRig.primeK || 0)) * Math.min(1, dt * 12);
  if (c) c.heldT += dt;
}
// ---- Physics: gravity + axis-separated bounce off Box3 colliders + floor ----
const _nClosest = new THREE.Vector3(), _nN = new THREE.Vector3();
// Resolve sphere vs every collider box + floor. Returns the strongest contact normal (or null).
function nadeResolve(p, r) {
  let hitN = null, best = 0;
  if (p.pos.y < r) {
    p.pos.y = r; _nN.set(0, 1, 0);
    const vn = p.vel.y; if (vn < 0) { hitN = new THREE.Vector3(0, 1, 0); best = -vn; }
  }
  for (const b of colliders) {
    if (p.pos.x < b.min.x - r || p.pos.x > b.max.x + r || p.pos.y < b.min.y - r || p.pos.y > b.max.y + r || p.pos.z < b.min.z - r || p.pos.z > b.max.z + r) continue;
    _nClosest.set(clamp(p.pos.x, b.min.x, b.max.x), clamp(p.pos.y, b.min.y, b.max.y), clamp(p.pos.z, b.min.z, b.max.z));
    _nN.subVectors(p.pos, _nClosest);
    let d = _nN.length();
    if (d >= r) continue;
    if (d < 1e-5) {
      // centre inside the box: push out along the shallowest face
      const ex = [p.pos.x - b.min.x, b.max.x - p.pos.x, p.pos.y - b.min.y, b.max.y - p.pos.y, p.pos.z - b.min.z, b.max.z - p.pos.z];
      let k = 0; for (let i = 1; i < 6; i++) if (ex[i] < ex[k]) k = i;
      _nN.set(k === 0 ? -1 : k === 1 ? 1 : 0, k === 2 ? -1 : k === 3 ? 1 : 0, k === 4 ? -1 : k === 5 ? 1 : 0);
      p.pos.addScaledVector(_nN, ex[k] + r);
    } else {
      _nN.multiplyScalar(1 / d);
      p.pos.addScaledVector(_nN, r - d);
    }
    const vn = p.vel.dot(_nN);
    if (vn < 0 && -vn >= best) { best = -vn; hitN = _nN.clone(); }
  }
  return hitN ? { n: hitN, speed: best } : null;
}
export function updateNades(dt, t) {
  updateNadeCook(dt, t);
  updateNukeCarry(t);
  const r = NADE_RADIUS;
  for (let i = nadeProjectiles.length - 1; i >= 0; i--) {
    const p = nadeProjectiles[i];
    p.fuse -= dt;
    try { if (p.mesh.userData.flame) p.mesh.userData.flame.material.opacity = 0.6 + Math.sin(t * 30 + i) * 0.3; } catch (e) {}
    try { if (p.mesh.userData.blink) p.mesh.userData.blink.material.opacity = 0.45 + 0.55 * Math.abs(Math.sin(t * 9 + i)); } catch (e) {}
    // substep so fast throws never tunnel through thin walls
    const steps = clamp(Math.ceil(p.vel.length() * dt / 0.05), 1, 8);
    const h = dt / steps;
    let removed = false;
    p.onGround = false;
    for (let s = 0; s < steps && !removed; s++) {
      p.vel.y -= NADE_GRAV * h;
      p.pos.addScaledVector(p.vel, h);
      if (tacticalSmokes.length) {
        const sd = smokeDensityAt(p.pos, t);
        if (sd > 0.25) {
          p.vel.multiplyScalar(1 - Math.min(0.5, 1.6 * h * sd)); // thick air inside the cloud
          smokePushAt(p.pos, p.vel.x * h * 2, p.vel.z * h * 2, sd);
          if (t - (p._smokeWispT || 0) > 0.09) {
            p._smokeWispT = t;
            try { spawnSmoke(p.pos, 0.45, 0.7, 0xd8d4cb); } catch (e) {} // visible trail in the cloud
          }
        }
      }
      const c = nadeResolve(p, r);
      if (!c) continue;
      const { n, speed } = c;
      const ground = n.y > 0.7;
      if (p.type === 'molotov' && ground) {
        // CS2: bottles bounce off walls but shatter on anything floor-like
        const at = p.pos.clone(); at.y -= r;
        removeNadeProj(i); removed = true;
        igniteMolotov(at, p.owner, t);
        break;
      }
      // reflect normal component with restitution, scrape tangential
      const vn = p.vel.dot(n);
      const e = speed < 1.2 ? 0 : 0.45;
      p.vel.addScaledVector(n, -(1 + e) * vn);
      const tanK = ground ? (speed < 1.2 ? 1 : 0.8) : 0.7;
      const vnAfter = p.vel.dot(n);
      p.vel.addScaledVector(n, -vnAfter).multiplyScalar(tanK).addScaledVector(n, vnAfter);
      if (ground && speed < 1.2) p.onGround = true;
      if (speed > 1.5 && t - (p.lastBounceSfx || 0) > 0.08) { p.lastBounceSfx = t; p.bounces++; nadeBounceSfx(p, speed > 8); }
      // bounce randomises the tumble a bit
      if (speed > 1.5) p.spin.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(Math.min(14, speed * 1.4));
    }
    if (removed) continue;
    if (p.onGround) {
      // rolling friction: CS nades slide/roll a little then stop
      const hs = Math.hypot(p.vel.x, p.vel.z);
      const dec = Math.max(0, hs - 6.5 * dt);
      if (hs > 1e-4) { p.vel.x *= dec / hs; p.vel.z *= dec / hs; }
      p.spin.multiplyScalar(Math.max(0, 1 - dt * 6));
    }
    p.speed = p.vel.length();
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.x += p.spin.x * dt; p.mesh.rotation.y += p.spin.y * dt; p.mesh.rotation.z += p.spin.z * dt;
    if (p.onGround && p.speed < 0.4 && p.type !== 'molotov') {
      // settle lying on its side instead of balancing on a point
      p.mesh.rotation.x += (Math.PI / 2 - p.mesh.rotation.x % Math.PI) * Math.min(1, dt * 8);
      p.mesh.position.y = p.pos.y - r * 0.35;
    }
    if (p.pos.y < -5) { removeNadeProj(i); continue; }
    // smoke: CS2 checks for "stopped" after a short arm time
    if (p.type === 'smoke') {
      if ((t - p.born) > 0.6 && p.speed < 0.25) p.stillT = (p.stillT || 0) + dt; else p.stillT = 0;
      if (p.stillT > 0.2 || p.fuse < -6) {
        const at = p.pos.clone(), owner = p.owner;
        removeNadeProj(i); deploySmoke(at, owner, t);
      }
      continue;
    }
    if (p.fuse <= 0) {
      const at = p.pos.clone();
      const owner = p.owner;
      const type = p.type;
      removeNadeProj(i);
      if (type === 'he') detonateHE(at, owner, t, false);
      else if (type === 'flash') detonateFlash(at, owner, t, false);
      else if (type === 'molotov') molotovAirburst(at);
    }
  }
  updateTacticalSmokes(dt, t);
  updateFires(dt, t);
  updateFlashOverlay(t);
}
function molotovAirburst(at) {
  // CS2: a bottle that never finds the floor bursts harmlessly mid-air
  try { AudioSys.molotovIgnite(at); } catch (e) {}
  try {
    spawnFireball(at, 1.3, 0.25);
    spawnBurst(at, 0xff9a2a, 16, 5, 0.6, 0.12);
    spawnSmoke(at, 0.6, 1.0, 0x333333);
  } catch (e) {}
}
function nadeBounceSfx(p, hard = false) {
  try { AudioSys.nadeBounce(p.pos, hard); } catch (e) {}
  try { spawnBurst(p.pos, 0xcfc4ae, 3, 1.6, 0.25, 0.05); } catch (e) {}
}
function removeNadeProj(i) {
  const p = nadeProjectiles[i];
  try {
    scene.remove(p.mesh);
    p.mesh.traverse((o) => {
      try { if (o.isMesh) o.geometry.dispose(); } catch {}
      try { if (o.isMesh || o.isSprite) o.material.dispose(); } catch {}
    });
  } catch (e) {}
  nadeProjectiles.splice(i, 1);
}
export function clearNades() {
  for (const p of nadeProjectiles) { try { scene.remove(p.mesh); } catch (e) {} }
  nadeProjectiles.length = 0;
  for (const s of tacticalSmokes) {
    try { for (const pf of s.puffs) { scene.remove(pf.mesh); if (!pf.core) pf.mesh.material.dispose(); } if (s.mat) s.mat.dispose(); } catch (e) {}
  }
  tacticalSmokes.length = 0;
  for (const f of fireZones) {
    try { for (const fl of f.flames) scene.remove(fl); if (f.light) scene.remove(f.light); if (f.smokeAt !== undefined) {} } catch (e) {}
  }
  fireZones.length = 0;
  try { updateInteractHUD(null); } catch (e) {}
}
// ---- HE: radial frag with wall-occluded falloff ----
function explodeDamage(pos, radius, baseDmg, owner, weaponLabel) {
  const oTeam = nadeOwnerTeam(owner);
  const oName = nadeOwnerName(owner);
  // bots (solo): direct authoritative damage
  for (const b of bots) {
    if (!b.alive) continue;
    if (b.team === oTeam) {
      // No friendly fire — but the thrower still staggers? Skip teammates entirely.
      if (!(owner.isPlayer && b === undefined)) continue;
    }
    // owner bot never hits itself at throw; still allow self-splash for plays
    const target = botChest(b);
    const d = pos.distanceTo(target);
    if (d > radius + 0.6) continue;
    let dmg = baseDmg * (1 - clamp(d / radius, 0, 1) * 0.92) * rand(0.9, 1.1);
    if (!hasLOS(pos, target)) dmg *= 0.25; // walls soak most of the blast
    if (dmg < 4) continue;
    const shooter = owner.isPlayer
      ? { team: oTeam, isPlayer: true, weaponName: weaponLabel }
      : { team: oTeam, isPlayer: false, bot: owner.bot || null, weaponName: weaponLabel };
    try {
      const bdir = target.clone().sub(pos).normalize();
      damageBot(b, dmg, shooter, false, target, { dir: bdir, weapon: weaponLabel, explosive: true, power: 2.1 });
    } catch (e) { damageBot(b, dmg, shooter, false, target); }
  }
  // local player (victim-authoritative: applies for ANY owner's blast we simulate)
  if (player.alive && G.phase === 'playing') {
    const eye = new THREE.Vector3(player.pos.x, player.pos.y + 1.2, player.pos.z);
    const d = pos.distanceTo(eye);
    if (d <= radius + 0.6) {
      const sameTeam = (player.team || 'ct') === oTeam && !owner.isPlayer;
      // Friendly bots' HEs don't hurt us (no friendly fire); our own HE does (cook risk).
      const isOwn = !!owner.isPlayer;
      if (!sameTeam || isOwn) {
        let dmg = baseDmg * (1 - clamp(d / radius, 0, 1) * 0.92) * rand(0.9, 1.1);
        if (!hasLOS(pos, eye)) dmg *= 0.25;
        if (dmg >= 4) {
          const shooter = owner.isPlayer
            ? { team: oTeam, isPlayer: true, weaponName: weaponLabel }
            : { team: oTeam, isPlayer: false, bot: owner.bot || null, remoteName: owner.remoteName || null, remoteId: owner.remoteId ?? null, remote: null, weaponName: weaponLabel };
          // resolve remote ref for direction arrow when killed by a real player
          try {
            if (owner.remoteId != null && remotes.has(owner.remoteId)) shooter.remote = remotes.get(owner.remoteId);
          } catch (e) {}
          damagePlayer(dmg, shooter, false); // reports the death to the server itself
        }
      }
    }
    // attacker-side hitmarker prediction for real enemies in the blast (visual only;
    // victims apply their own damage, kills come back via 'killed')
    if (owner.isPlayer) {
      try {
        let any = false;
        for (const [, e] of remotes) {
          if (!e.data || !e.data.alive) continue;
          if ((e.data.team || 't') === (player.team || 'ct')) continue;
          const rp = new THREE.Vector3(e.pos.x, e.pos.y + 1.1, e.pos.z);
          if (pos.distanceTo(rp) < radius && (hasLOS(pos, rp) || pos.distanceTo(rp) < radius * 0.4)) { any = true; break; }
        }
        if (any) { playerHitmark(false, false); AudioSys.hit(false); }
      } catch (e) {}
    }
  }
}
export function detonateHE(at, owner, t, inHand = false) {
  const label = 'HE GRENADE';
  try { AudioSys.heBoom(at); } catch (e) {}
  try {
    spawnFireball(at.clone().add(new THREE.Vector3(0, 0.3, 0)), 3.2, 0.35);
    spawnShockwave(at, 7.5, 0.45);
    spawnBurst(at, 0xffd27a, 26, 10, 0.7, 0.16);
    spawnBurst(at, 0xff6a2a, 18, 7, 0.9, 0.2);
    spawnBurst(at, 0x555555, 14, 5, 1.3, 0.25);
    spawnSmoke(at.clone().add(new THREE.Vector3(0, 0.6, 0)), 1.0, 1.6, 0x4a4a4a);
    spawnDebris(at, opts.quality ? 10 : 5, 8, 8);
    spawnDecal('scorch', new THREE.Vector3(at.x, 0.06, at.z), new THREE.Vector3(0, 1, 0), 3.2, 0.9);
  } catch (e) {}
  try {
    muzzleLight.position.copy(at).add(new THREE.Vector3(0, 1, 0));
    muzzleLight.intensity = 10; muzzleLight.distance = 30;
  } catch (e) {}
  try {
    if (camera) {
      const d = camera.position.distanceTo(at);
      const k = clamp(1 - d / 38, 0, 1);
      vmRig.shake += 0.05 * k + (inHand ? 0.06 : 0);
      vmRig.fovKick += 4 * k;
    }
  } catch (e) {}
  // dynamic smoke interaction: blasts shred nearby cover
  try { disperseSmokes(at, 6.5, 6.0); } catch (e) {}
  explodeDamage(at, NADE_DEFS.he.radius, NADE_DEFS.he.damage, owner, label);
  try { if (isOnline() && owner.isPlayer && inHand) Net.sendNade({ action: 'boom', nade: 'he', x: at.x, y: at.y, z: at.z }); } catch (e) {}
}
// Is the carrier's live bomb touching anyone? (The carrier themself doesn't count.)
function nukeTouchingCarrier(at) {
  try {
    for (const b of bots) {
      if (!b.alive) continue;
      if (at.distanceTo(botChest(b)) < 1.4) return true;
    }
  } catch (e) {}
  try {
    for (const [, e] of remotes) {
      if (!e.data || !e.data.alive) continue;
      if (at.distanceTo(new THREE.Vector3(e.pos.x, e.pos.y + 1.1, e.pos.z)) < 1.4) return true;
    }
  } catch (e) {}
  return false;
}
// Two-hand live carry: the bomb goes off when the carrier runs face-first into a
// wall (movement.js sets _moveBlocked) or bumps another player. Called from updateNades.
export function updateNukeCarry(t) {
  if (!player.carryingNuke || !player.alive || G.phase !== 'playing' || G.roundEnding || isFreeze()) return;
  if (t - (player.nukeArmedAt || 0) < 1.0) return; // buy/spawn grace
  const at = new THREE.Vector3(player.pos.x, player.pos.y + 1.1, player.pos.z);
  if (!player._moveBlocked && !nukeTouchingCarrier(at)) return;
  player.carryingNuke = false; player.nades.nuke = 0;
  detonateNuke(at, { isPlayer: true, team: player.team || 'ct' }, t);
  try {
    if (player.alive && player.cur === 'nuke') { switchWeapon(primaryKey() || 'deagle'); updateHUD(); }
  } catch (e) {}
}
export function disarmNuke() {
  if (!player.carryingNuke) return false;
  player.carryingNuke = false; player.nades.nuke = 0;
  try { AudioSys.pin(); } catch (e) {}
  try { announce('NUKE DISARMED — HANDS FREE', 1200); } catch (e) {}
  try {
    if (player.cur === 'nuke') switchWeapon(primaryKey() || 'deagle');
    updateHUD();
  } catch (e) {}
  return true;
}
// ---- ☢ ATOMIC BOMB: map-wide over-the-top contact nuke ----
export function detonateNuke(at, owner, t) {
  const def = NADE_DEFS.nuke, label = def.name;
  if (owner && owner.isPlayer && player.carryingNuke) { player.carryingNuke = false; player.nades.nuke = 0; }
  try { AudioSys.nukeBoom(at); } catch (e) {}
  try {
    const up = (y) => at.clone().add(new THREE.Vector3(0, y, 0));
    spawnFireball(up(1), 14, 0.7);                       // core flash
    spawnFireball(up(4), 10, 1.0);                       // rising fire
    spawnFireball(up(8), 13, 1.3);                       // mushroom cap
    spawnShockwave(at, 34, 0.9);
    setTimeout(() => { try { spawnShockwave(at, 26, 0.7, 0xff9a3c); } catch (e2) {} }, 150);
    setTimeout(() => { try { spawnShockwave(at, 18, 0.6, 0xc8b090); } catch (e2) {} }, 350);
    spawnWorldFlash(up(2), 0xfff2cc, 22);
    spawnBurst(at, 0xffd27a, 60, 22, 1.2, 0.22);
    spawnBurst(at, 0xff6a2a, 50, 16, 1.5, 0.3);
    spawnBurst(at, 0x333333, 40, 10, 2.2, 0.4);
    for (let i = 0; i < 10; i++) {                       // mushroom stem + cap smoke
      const stem = i < 6;
      const c = at.clone().add(new THREE.Vector3(rand(-2, 2) * (stem ? 0.5 : 2.5), stem ? rand(1, 7) : rand(7, 10), rand(-2, 2) * (stem ? 0.5 : 2.5)));
      spawnSmoke(c, rand(1.4, 2.6), rand(2.0, 3.5), i % 2 ? 0x3a3a3a : 0x8a7a64);
    }
    spawnDebris(at, opts.quality ? 22 : 10, 18, 16);
    spawnDecal('scorch', new THREE.Vector3(at.x, 0.06, at.z), new THREE.Vector3(0, 1, 0), 16, 1);
    spawnDecal('scorch', new THREE.Vector3(at.x + rand(-3, 3), 0.055, at.z + rand(-3, 3)), new THREE.Vector3(0, 1, 0), 9, 0.8);
  } catch (e) {}
  try {
    muzzleLight.position.copy(at).add(new THREE.Vector3(0, 2, 0));
    muzzleLight.intensity = 30; muzzleLight.distance = 90;
  } catch (e) {}
  try { flashExplosionOverlay(); } catch (e) {}
  try {
    if (camera) {
      const d = camera.position.distanceTo(at);
      const k = clamp(1 - d / 70, 0, 1);
      vmRig.shake += 0.12 * k + 0.03;
      vmRig.fovKick += 10 * k + 2;
    }
  } catch (e) {}
  // White-out anyone close enough to see it + blind every bot (they stare at everything).
  try {
    if (player.alive && G.phase === 'playing') {
      const eye = new THREE.Vector3(player.pos.x, player.pos.y + 1.2, player.pos.z);
      const d = eye.distanceTo(at);
      if (d < 45 && hasLOS(eye, at)) {
        const dur = (1 - d / 45) * 2.5 + 0.5;
        if (t + dur > (player.flashUntil || 0)) { player.flashUntil = t + dur; player.flashMax = dur; flashAfterPending = true; }
      }
    }
  } catch (e) {}
  try { for (const b of bots) if (b.alive) { b.blindUntil = t + 5; b.target = null; } } catch (e) {}
  try { disperseSmokes(at, 30, 12); } catch (e) {}
  try { announce('☢ ATOMIC DETONATION ☢', 2200); } catch (e) {}
  explodeDamage(at, def.radius, def.damage, owner, label);
  try { if (isOnline() && owner.isPlayer) Net.sendNade({ action: 'boom', nade: 'nuke', x: at.x, y: at.y, z: at.z }); } catch (e) {}
}
// ---- Flash: LOS + facing + distance blindness for player, bots, remotes(feedback) ----
function flashPowerAt(viewPos, viewFwd, at) {
  const toFlash = at.clone().sub(viewPos);
  const d = toFlash.length();
  if (d > NADE_DEFS.flash.radius) return 0;
  if (!hasLOS(viewPos, at)) return 0; // walls fully protect (smoke does NOT — flashes burn through smoke)
  toFlash.normalize();
  const facing = viewFwd ? clamp(toFlash.dot(viewFwd), -1, 1) : 0;
  // looking straight at it = full; turned fully away = ~25% (peripheral + bounce)
  const angK = 0.25 + 0.75 * clamp((facing + 0.4) / 1.4, 0, 1);
  const distK = 1 - clamp(d / NADE_DEFS.flash.radius, 0, 1);
  return clamp(distK * angK * 1.25, 0, 1);
}
export function detonateFlash(at, owner, t, inHand = false) {
  try { AudioSys.flashPop(at); } catch (e) {}
  try {
    spawnWorldFlash(at.clone().add(new THREE.Vector3(0, 0.3, 0)), 0xffffff, 3.2);
    spawnFireball(at.clone().add(new THREE.Vector3(0, 0.3, 0)), 1.6, 0.12);
    muzzleLight.position.copy(at); muzzleLight.intensity = 8; muzzleLight.distance = 26;
  } catch (e) {}
  // local player blindness
  try {
    if (player.alive && G.phase === 'playing') {
      const eye = new THREE.Vector3(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0), player.pos.z);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
      let p = flashPowerAt(eye, fwd, at);
      if (inHand && owner.isPlayer) p = 1; // cooking it in your face = full white
      if (p > 0.03) {
        const dur = p * NADE_DEFS.flash.blindMax;
        // a stronger flash refreshes the blind; a weaker one never shortens it
        if (t + dur > (player.flashUntil || 0)) { player.flashUntil = t + dur; player.flashMax = dur; flashAfterPending = true; }
        if (p > 0.5) { try { AudioSys.click(5200, 0.4, 0.10); } catch (e2) {} }
      }
    }
  } catch (e) {}
  // bots: blinded = can't acquire/shoot, wander (handled in updateBot/nearestEnemy)
  try {
    for (const b of bots) {
      if (!b.alive) continue;
      const eye = botEye(b);
      const dyaw = b.yaw;
      const fwd = new THREE.Vector3(Math.sin(dyaw), 0.05, Math.cos(dyaw)).normalize();
      const p = flashPowerAt(eye, fwd, at);
      if (p > 0.08) {
        b.blindUntil = t + p * NADE_DEFS.flash.blindMax * rand(0.85, 1.15);
        b.target = null; b.state = 'objective';
      }
    }
  } catch (e) {}
  // attacker feedback: any remote enemy caught gets a hitmarker tick
  try {
    if (owner.isPlayer) {
      let any = false;
      for (const [, e] of remotes) {
        if (!e.data || !e.data.alive) continue;
        if ((e.data.team || 't') === (player.team || 'ct')) continue;
        const eye = remoteEye(e);
        if (hasLOS(eye, at) && eye.distanceTo(at) < 20) { any = true; break; }
      }
      if (any) { playerHitmark(false, false); AudioSys.hit(false); announce('FLASHED ✨', 700); }
    }
  } catch (e) {}
  try { if (isOnline() && owner.isPlayer && inHand) Net.sendNade({ action: 'boom', nade: 'flash', x: at.x, y: at.y, z: at.z }); } catch (e) {}
}
let flashAfterPending = false;
function updateFlashOverlay(t) {
  try {
    const el = $('flash-overlay'), after = $('flash-after');
    if (!el) return;
    if (G.phase !== 'playing' || !player.alive) { el.style.opacity = 0; if (after) after.style.opacity = 0; return; }
    const left = (player.flashUntil || 0) - t;
    if (left <= 0) { el.style.opacity = 0; if (after) after.style.opacity = 0; player.flashMax = 0; return; }
    const total = Math.max(0.001, player.flashMax || left);
    const k = clamp(left / total, 0, 1);            // 1 → 0 over the blind
    const strong = clamp(total / NADE_DEFS.flash.blindMax, 0, 1);
    // CS2 feel: solid white hold, then an eased fade; the burned-in frame outlasts the white
    const white = k > 0.55 ? 1 : Math.pow(k / 0.55, 1.6);
    el.style.opacity = (white * (0.55 + 0.45 * strong)).toFixed(3);
    if (after) after.style.opacity = (Math.pow(k, 0.7) * 0.55 * strong).toFixed(3);
  } catch (e) {}
}
// grab the frame being looked at the moment the flash pops (must run right after renderer.render)
export function captureFlashAfterimage() {
  if (!flashAfterPending) return;
  flashAfterPending = false;
  try {
    const c = $('flash-after'); if (!c) return;
    const src = renderer.domElement;
    c.width = Math.max(1, src.width >> 2); c.height = Math.max(1, src.height >> 2);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  } catch (e) {}
}

