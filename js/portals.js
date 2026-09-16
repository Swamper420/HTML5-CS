// js/portals.js — AGENTS: Portal gun: linked blue/orange wall portals per owner, body teleport, online relay.
// Ownership: PORTALS, firePortalSlot, applyRemotePortal, updatePortals, clearPortals.

import * as THREE from 'three';
import { Net } from '../net.js';
import { AudioSys } from './audio.js';
import { MAP_HALF } from './config.js';
import { collidesAt, supportHeightAt } from './collision.js';
import { spawnBurst } from './effects.js';
import { announce } from './hud.js';
import { isOnline } from './multiplayer.js';
import { colliders } from './map.js';
import { scene } from './render.js';
import { G, player } from './state.js';

export const PORTALS = new Map(); // ownerKey -> { A, B } where end = { pos, normal, mesh }
const PCOL = { A: 0x2e9bff, B: 0xff9a2a };
const _ray = new THREE.Ray();
const _pt = new THREE.Vector3();

// Nearest wall face (or floor) along the ray. Returns { pos, normal, d } or null.
function rayPortalHit(origin, dir, maxD) {
  _ray.set(origin, dir);
  let best = null;
  for (const b of colliders) {
    const hit = _ray.intersectBox(b, _pt);
    if (!hit) continue;
    const d = origin.distanceTo(_pt);
    if (d > maxD || (best && d >= best.d)) continue;
    // face normal: which slab the hit sits on (walls are axis-aligned)
    const e = 0.03;
    const n = new THREE.Vector3();
    if (Math.abs(_pt.x - b.min.x) < e) n.set(-1, 0, 0);
    else if (Math.abs(_pt.x - b.max.x) < e) n.set(1, 0, 0);
    else if (Math.abs(_pt.z - b.min.z) < e) n.set(0, 0, -1);
    else if (Math.abs(_pt.z - b.max.z) < e) n.set(0, 0, 1);
    else if (Math.abs(_pt.y - b.min.y) < e) n.set(0, -1, 0);
    else n.set(0, 1, 0);
    best = { pos: _pt.clone(), normal: n, d };
  }
  if (dir.y < -0.001) {
    const t = (0.02 - origin.y) / dir.y;
    if (t > 0 && t <= maxD && (!best || t < best.d)) {
      const p = origin.clone().addScaledVector(dir, t);
      if (Math.abs(p.x) <= MAP_HALF && Math.abs(p.z) <= MAP_HALF) best = { pos: p, normal: new THREE.Vector3(0, 1, 0), d: t };
    }
  }
  return best;
}

function makePortalMesh(color) {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.7, 0.09, 10, 28),
    new THREE.MeshBasicMaterial({ color })
  );
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.62, 28),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })
  );
  g.add(ring); g.add(disc);
  g.userData.disc = disc;
  return g;
}

function setEnd(pair, slot, hit) {
  if (pair[slot]) { try { scene.remove(pair[slot].mesh); } catch {} }
  const mesh = makePortalMesh(PCOL[slot]);
  mesh.position.copy(hit.pos).addScaledVector(hit.normal, 0.05);
  mesh.lookAt(hit.pos.clone().addScaledVector(hit.normal, 2));
  scene.add(mesh);
  pair[slot] = { pos: hit.pos.clone(), normal: hit.normal.clone(), mesh };
}

// Shooter places one end. fromNet=true skips rebroadcast (remote replay).
export function firePortalSlot(origin, dir, slot, ownerKey = 'local', fromNet = false, range = 120) {
  const hit = rayPortalHit(origin, dir, range);
  if (!hit) { if (!fromNet) AudioSys.click(300, 0.06, 0.3); return null; }
  let pair = PORTALS.get(ownerKey);
  if (!pair) { pair = {}; PORTALS.set(ownerKey, pair); }
  setEnd(pair, slot, hit);
  try {
    spawnBurst(hit.pos, PCOL[slot], 14, 5, 0.5, 0.1);
    if (!fromNet) AudioSys.shoot('portal');
  } catch {}
  if (!fromNet && pair.A && pair.B && ownerKey === 'local') {
    const now = performance.now();
    if (!pair._annT || now - pair._annT > 4000) {
      pair._annT = now;
      try { announce('PORTALS LINKED — STEP THROUGH', 1200); } catch {}
    }
  }
  if (!fromNet && isOnline()) {
    try {
      Net.sendNade({ action: 'portal', slot,
        x: hit.pos.x, y: hit.pos.y, z: hit.pos.z,
        nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z });
    } catch {}
  }
  return hit;
}

// Relayed placement from another player (sender id stamped by the server).
export function applyRemotePortal(m) {
  if (G.phase !== 'playing') return;
  const slot = m.slot === 'B' ? 'B' : 'A';
  const x = +m.x, y = +m.y, z = +m.z;
  if (!isFinite(x + y + z) || Math.abs(x) > MAP_HALF + 6 || Math.abs(z) > MAP_HALF + 6 || y < -1 || y > 12) return;
  const n = new THREE.Vector3(+m.nx || 0, +m.ny || 0, +m.nz || 0);
  if (!isFinite(n.x + n.y + n.z) || n.lengthSq() < 0.5 || n.lengthSq() > 1.5) return;
  n.normalize();
  const key = m.fromId != null ? `remote:${m.fromId}` : null;
  if (!key) return;
  let pair = PORTALS.get(key);
  if (!pair) { pair = {}; PORTALS.set(key, pair); }
  setEnd(pair, slot, { pos: new THREE.Vector3(x, y, z), normal: n });
  try { spawnBurst(new THREE.Vector3(x, y, z), PCOL[slot], 10, 4, 0.4, 0.1); } catch {}
}

function tryTeleportPair(pair, t) {
  if (!pair.A || !pair.B || !player.alive) return;
  if (t < (player._portalCd || 0)) return;
  const feet = new THREE.Vector3(player.pos.x, player.pos.y + 0.9, player.pos.z);
  let exit = null;
  if (feet.distanceTo(pair.A.pos) < 1.15) exit = pair.B;
  else if (feet.distanceTo(pair.B.pos) < 1.15) exit = pair.A;
  if (!exit) return;
  const out = exit.pos.clone().addScaledVector(exit.normal, 1.3); // clear of the 1.15 trigger so you don't bounce back
  let footY;
  if (exit.normal.y > 0.5) footY = exit.pos.y + 0.1;
  else footY = supportHeightAt(out.x, out.z, exit.pos.y + 0.5, player.radius);
  out.y = footY;
  _pt.set(out.x, out.y, out.z);
  if (collidesAt(_pt, player.radius, 1.7)) return; // no room — stay put
  player.pos.copy(out);
  player.vel.addScaledVector(exit.normal, 1.5);
  player._portalCd = t + 0.8;
  try {
    AudioSys.shoot('portal', out);
    spawnBurst(out.clone().add(new THREE.Vector3(0, 1, 0)), 0xffffff, 12, 5, 0.4, 0.1);
  } catch {}
}

export function updatePortals(dt, t) {
  if (G.phase !== 'playing' || !player.alive) return;
  for (const [, pair] of PORTALS) {
    try { tryTeleportPair(pair, t); } catch {}
  }
  // shimmer so linked pairs read at distance
  for (const [, pair] of PORTALS) {
    for (const s of ['A', 'B']) {
      const e = pair[s];
      if (e && e.mesh && e.mesh.userData.disc) {
        try { e.mesh.userData.disc.material.opacity = 0.35 + 0.15 * Math.sin(t * 5 + (s === 'A' ? 0 : 2)); } catch {}
      }
    }
  }
  void dt;
}

export function clearPortals() {
  for (const [, pair] of PORTALS) {
    for (const s of ['A', 'B']) {
      if (pair[s]) { try { scene.remove(pair[s].mesh); } catch {} }
    }
  }
  PORTALS.clear();
  player._portalCd = 0;
}
