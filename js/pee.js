// js/pee.js — AGENTS: Piss mechanic: hold P for an arcing stream, puddles grow where it lands, desert evaporates them in 20s (shrink + steam), standing in one is slippery, direct hits blind.
// Ownership: PEE state, peeZones, startPee/stopPee, onPee, initPee, updatePee, resetPee. Online via the relayed 'nade' channel (action 'pee'), no server change.

import * as THREE from 'three';
import { Net } from '../net.js';
import { AudioSys } from './audio.js';
import { MAP_HALF } from './config.js';
import { clamp, rand } from './utils.js';
import { collidesAt, supportHeightAt } from './collision.js';
import { damageBot } from './combat.js';
import { spawnBurst, spawnSmoke } from './effects.js';
import { announce, playerHitmark } from './hud.js';
import { isOnline, remotes } from './multiplayer.js';
import { camera, scene } from './render.js';
import { G, bots, isFreeze, player } from './state.js';

export const PEE_EVAP = 20; // desert sun dries a puddle in 20s
const PEE_BLADDER = 5; // max seconds of stream per press
const PEE_MAX_R = 2.0;
const PEE_SEND_EVERY = 0.5;
const PEE_POWER = 13; // stream muzzle velocity: lobs ~10m aiming level
const PEE_GRAV = 9.5;
const PEE_RATE = 45; // droplets per second

export const PEE = { peeing: false, until: 0, _sendAt: 0, _acc: 0, _hitAt: new Map() };
export const peeZones = []; // {x,z,y,maxR,born,until,mesh,steamAt}
const peeDrops = []; // live stream droplets {x,y,z,vx,vy,vz,life,mesh}
let _dropGeo = null, _dropMat = null;

let _wired = false;
export function initPee() {
  if (_wired) return; _wired = true;
  try {
    Net.on('nade', (m) => {
      if (!m || m.action !== 'pee' || G.phase !== 'playing') return;
      const x = +m.x, z = +m.z;
      if (!isFinite(x + z) || Math.abs(x) > MAP_HALF || Math.abs(z) > MAP_HALF) return;
      const yh = isFinite(+m.y) ? +m.y : undefined;
      addRemotePee(x, z, yh);
    });
  } catch {}
}

function groundY(x, z, refY) {
  try { return supportHeightAt(x, z, refY + 0.5, 0.4); } catch { return 0; }
}

function makePuddleMesh(x, y, z) {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(1, 20),
    new THREE.MeshBasicMaterial({ color: 0xc7a91e, transparent: true, opacity: 0.55, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y + 0.03, z);
  try { scene.add(m); } catch {}
  return m;
}

function growAt(x, z, amount, yHint) {
  for (const zn of peeZones) {
    if (Math.hypot(zn.x - x, zn.z - z) < 1.2) {
      zn.maxR = Math.min(PEE_MAX_R, zn.maxR + amount);
      zn.until = performance.now() / 1000 + PEE_EVAP; // fresh piss resets the dry-out
      return zn;
    }
  }
  if (peeZones.length >= 6) {
    const old = peeZones.shift();
    try { scene.remove(old.mesh); } catch {}
  }
  const t = performance.now() / 1000;
  const refY = isFinite(yHint) ? yHint : player.pos.y;
  const zn = { x, z, y: groundY(x, z, refY), maxR: Math.min(PEE_MAX_R, 0.5 + amount), born: t, until: t + PEE_EVAP, mesh: null, steamAt: 0 };
  try { zn.mesh = makePuddleMesh(x, zn.y, z); } catch {}
  peeZones.push(zn);
  return zn;
}

function addRemotePee(x, z, yHint) {
  const zn = growAt(x, z, 0.22, yHint);
  try { AudioSys.peeAt(new THREE.Vector3(x, zn.y + 0.5, z)); } catch {}
}

function sendPee(x, z, yHint) {
  let gy = isFinite(yHint) ? yHint : 0;
  try { if (!isFinite(yHint)) gy = groundY(x, z, player.pos.y); } catch {}
  try { Net.sendNade({ action: 'pee', x, y: gy, z }); } catch {}
}

export function startPee(t) {
  if (PEE.peeing || !player.alive || G.phase !== 'playing' || G.roundEnding || isFreeze()) return;
  if (!player.onGround || player.driving) return;
  PEE.peeing = true;
  PEE.until = t + PEE_BLADDER;
  PEE._sendAt = 0; PEE._acc = 0; PEE._hitAt.clear();
  try { announce('PEEING — HOLD P 🚻', 900); } catch {}
}

export function stopPee() {
  PEE.peeing = false;
  try { AudioSys.peeLoop(false); } catch {}
}

export function resetPee() {
  stopPee();
  for (const d of peeDrops) { try { scene.remove(d.mesh); } catch {} }
  peeDrops.length = 0;
  for (const zn of peeZones) { try { scene.remove(zn.mesh); } catch {} }
  peeZones.length = 0;
}

export function onPee(x, z, pad = 0) {
  for (const zn of peeZones) if (Math.hypot(x - zn.x, z - zn.z) < radiusNow(zn) + pad) return zn;
  return null;
}

function radiusNow(zn) {
  const t = performance.now() / 1000;
  return Math.max(0.01, zn.maxR * clamp((zn.until - t) / PEE_EVAP, 0, 1));
}

// Droplet hits: blind + humiliation chip. Per-victim 0.4s cooldown so one
// stream doesn't melt; remotes are victim-authoritative via sendHit (same as bullets).
const _hitP = new THREE.Vector3();
function peeHitBot(b, t, hitPos) {
  const last = PEE._hitAt.get(b) || -9;
  if (t - last < 0.4) return;
  PEE._hitAt.set(b, t);
  try { b.blindUntil = Math.max(b.blindUntil || 0, t + 1.5); b.target = null; } catch {}
  try { spawnBurst(hitPos, 0xd8c531, 6, 2, 0.4, 0.08); } catch {}
  try { damageBot(b, 2, { team: player.team || 'ct', isPlayer: true }, false, hitPos, { weapon: 'PEE' }); } catch {}
}
function peeHitRemote(rid, t, hitPos) {
  const last = PEE._hitAt.get(rid) || -9;
  if (t - last < 0.4) return;
  PEE._hitAt.set(rid, t);
  try { spawnBurst(hitPos, 0xd8c531, 6, 2, 0.4, 0.08); } catch {}
  G.hits++; playerHitmark(false, false); AudioSys.hit(false);
  try { Net.sendHit({ targetId: rid, dmg: 2, head: false, weapon: 'PEE' }); } catch {}
}

const _dropV = new THREE.Vector3();
function spawnDrop() {
  if (peeDrops.length >= 80) return;
  if (!_dropGeo) {
    _dropGeo = new THREE.SphereGeometry(0.05, 6, 5);
    _dropMat = new THREE.MeshBasicMaterial({ color: 0xd8c531 });
  }
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const mesh = new THREE.Mesh(_dropGeo, _dropMat);
  const d = {
    x: player.pos.x + dir.x * 0.4, y: player.pos.y + 1.0, z: player.pos.z + dir.z * 0.4,
    vx: dir.x * PEE_POWER + rand(-0.5, 0.5), vy: dir.y * PEE_POWER + rand(-0.3, 0.5), vz: dir.z * PEE_POWER + rand(-0.5, 0.5),
    life: 1.6, mesh, visual: false,
  };
  mesh.position.set(d.x, d.y, d.z);
  try { scene.add(mesh); } catch {}
  peeDrops.push(d);
}

// Someone else's stream: visual-only droplets from their interpolated pose/aim.
// Hits stay owner-simulated (their client sends us 'hit'), so this never double-counts.
function spawnRemoteDrop(e) {
  if (peeDrops.length >= 80) return;
  if (!_dropGeo) {
    _dropGeo = new THREE.SphereGeometry(0.05, 6, 5);
    _dropMat = new THREE.MeshBasicMaterial({ color: 0xd8c531 });
  }
  const cp = Math.cos(e.pitch || 0);
  const dx = -Math.sin(e.yaw || 0) * cp, dy = Math.sin(e.pitch || 0), dz = -Math.cos(e.yaw || 0) * cp;
  const mesh = new THREE.Mesh(_dropGeo, _dropMat);
  const d = {
    x: e.pos.x + dx * 0.4, y: e.pos.y + 1.0, z: e.pos.z + dz * 0.4,
    vx: dx * PEE_POWER + rand(-0.5, 0.5), vy: dy * PEE_POWER + rand(-0.3, 0.5), vz: dz * PEE_POWER + rand(-0.5, 0.5),
    life: 1.6, mesh, visual: true,
  };
  mesh.position.set(d.x, d.y, d.z);
  try { scene.add(mesh); } catch {}
  peeDrops.push(d);
}

function killDrop(i) {
  try { scene.remove(peeDrops[i].mesh); } catch {}
  peeDrops.splice(i, 1);
}

function updateDrops(dt, t) {
  const online = isOnline();
  for (let i = peeDrops.length - 1; i >= 0; i--) {
    const d = peeDrops[i];
    d.life -= dt;
    d.vy -= PEE_GRAV * dt;
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    let dead = d.life <= 0;
    if (!dead) {
      // ground impact: the puddle grows where the stream lands (owner only —
      // remotes grow theirs from the relayed impacts, never from our visuals)
      let gy = 0;
      try { gy = supportHeightAt(d.x, d.z, d.y + 0.3, 0.15); } catch {}
      if (d.y <= gy + 0.04 && d.vy < 0) {
        if (!d.visual) {
          growAt(d.x, d.z, 0.015, gy);
          PEE._lastImpact = { x: d.x, z: d.z, y: gy };
        }
        if (Math.random() < 0.15) {
          try { spawnBurst(_hitP.set(d.x, gy + 0.1, d.z), 0xd8c531, 2, 1.5, 0.3, 0.05); } catch {}
        }
        dead = true;
      }
    }
    if (!dead) {
      _dropV.set(d.x, d.y, d.z);
      try { if (collidesAt(_dropV, 0.05, 0.1)) dead = true; } catch {}
    }
    // friendly fire: piss doesn't check teams — anyone but you catches it
    if (!dead && !d.visual) {
      for (const b of bots) {
        if (!b.alive) continue;
        const dx = d.x - b.pos.x, dy = d.y - (b.pos.y + 1.0), dz = d.z - b.pos.z;
        if (dx * dx + dy * dy + dz * dz < 0.36) {
          peeHitBot(b, t, _hitP.set(d.x, d.y, d.z).clone());
          dead = true; break;
        }
      }
    }
    if (!dead && !d.visual && online) {
      try {
        for (const [rid, e] of remotes) {
          const rd = e.data; if (!rd || !rd.alive) continue;
          const dx = d.x - e.pos.x, dy = d.y - (e.pos.y + 1.2), dz = d.z - e.pos.z;
          if (dx * dx + dy * dy + dz * dz < 0.49) {
            peeHitRemote(rid, t, _hitP.set(d.x, d.y, d.z).clone());
            dead = true; break;
          }
        }
      } catch {}
    }
    if (dead) killDrop(i);
    else d.mesh.position.set(d.x, d.y, d.z);
  }
}

export function updatePee(dt, t) {
  if (PEE.peeing) {
    if (!player.alive || G.phase !== 'playing' || G.roundEnding || player.driving || t > PEE.until) stopPee();
    else {
      // strong arcing stream, aimed with the crosshair
      PEE._acc += dt * PEE_RATE;
      while (PEE._acc >= 1) { PEE._acc -= 1; spawnDrop(); }
      try { AudioSys.peeLoop(true); } catch {}
      // relay where the stream lands so remotes grow the same puddles
      if (t - PEE._sendAt > PEE_SEND_EVERY) {
        PEE._sendAt = t;
        const im = PEE._lastImpact;
        if (im) sendPee(im.x, im.z, im.y);
      }
    }
  }
  if (peeDrops.length) updateDrops(dt, t);
  // show everyone else's streams too (visual only — hits stay owner-simulated)
  if (isOnline()) {
    try {
      for (const [, e] of remotes) {
        const rd = e.data;
        if (!rd || !rd.alive || !rd.peeing) continue;
        if (Math.random() < dt * 20) spawnRemoteDrop(e);
      }
    } catch {}
  }
  for (let i = peeZones.length - 1; i >= 0; i--) {
    const zn = peeZones[i];
    const left = zn.until - t;
    if (left <= 0) {
      try { scene.remove(zn.mesh); } catch {}
      peeZones.splice(i, 1);
      continue;
    }
    try {
      const r = radiusNow(zn);
      if (zn.mesh) {
        zn.mesh.scale.setScalar(Math.max(0.01, r));
        // desert shimmer: fade + wobble opacity in the last 6s
        zn.mesh.material.opacity = left < 6 ? 0.55 * (left / 6) : 0.55;
      }
      // evaporation steam, thicker as the puddle dies
      if (t - zn.steamAt > (left < 6 ? 0.25 : 0.6)) {
        zn.steamAt = t;
        spawnSmoke(new THREE.Vector3(zn.x, zn.y + 0.25, zn.z), 0.35, 0.7, 0xfff6d8);
      }
    } catch {}
  }
}
