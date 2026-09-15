// js/collision.js — AGENTS: World collision queries against map colliders (AABBs): move/slide, step/support height, ceilings, wall-run walls, LOS raycasts.
// Ownership: collidesAt, moveWithCollision, supportHeightAt, ceilingAt, findRunnableWall, rayWallDist, hasLOS.

import * as THREE from 'three';
import { CROUCH_HEIGHT, MAP_HALF, STAND_HEIGHT, STEP_EPS, WALLRUN } from './config.js';
import { clamp } from './utils.js';
import { colliders } from './map.js';
import { player } from './state.js';

export const _tmpBox = new THREE.Box3();
const _tmpMoveA = new THREE.Vector3();
export const _tmpMMEye = new THREE.Vector3();
export const _tmpMMTgt = new THREE.Vector3();
export function collidesAt(p, radius, height = 1.7) {
  _tmpBox.min.set(p.x - radius, p.y + STEP_EPS, p.z - radius);
  _tmpBox.max.set(p.x + radius, p.y + height, p.z + radius);
  for (const b of colliders) if (_tmpBox.intersectsBox(b)) return b;
  return null;
}
export function moveWithCollision(p, dx, dz, radius, height = 1.7) {
  // X axis — reuse temp vectors, no per-frame allocation
  let nx = p.x + dx;
  _tmpMoveA.set(nx, p.y, p.z);
  const hitX = collidesAt(_tmpMoveA, radius, height);
  if (!hitX) p.x = clamp(nx, -MAP_HALF, MAP_HALF);
  let nz = p.z + dz;
  _tmpMoveA.set(p.x, p.y, p.z + dz);
  const hitZ = collidesAt(_tmpMoveA, radius, height);
  if (!hitZ) p.z = clamp(nz, -MAP_HALF, MAP_HALF);
}
// footprint overlap (strict — touching a wall's side doesn't count as over it)
function _overFootprint(b, x, z, r) {
  return x + r > b.min.x && x - r < b.max.x && z + r > b.min.z && z - r < b.max.z;
}
// highest walkable surface under the footprint that is at or below `y` (0 = ground)
export function supportHeightAt(x, z, y, radius) {
  let best = 0;
  for (const b of colliders) {
    if (b.max.y > y + 0.06 || b.max.y <= best) continue;
    if (_overFootprint(b, x, z, radius)) best = b.max.y;
  }
  return best;
}
// lowest overhang bottom under the footprint that is above `y`
export function ceilingAt(x, z, y, radius) {
  let best = Infinity;
  for (const b of colliders) {
    if (b.min.y < y - 0.02 || b.min.y >= best) continue;
    if (_overFootprint(b, x, z, radius)) best = b.min.y;
  }
  return best;
}
export const playerHullHeight = () => (player.crouching ? CROUCH_HEIGHT : STAND_HEIGHT);
// Axis-aligned wall next to the player whose face runs along our motion.
// Returns { box, nx, nz, tx, tz, along, side } or null. n points from the wall to us.
export function findRunnableWall() {
  const p = player.pos, r = player.radius;
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
  let best = null;
  for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    _tmpMoveA.set(p.x - nx * WALLRUN.probe, p.y + 0.3, p.z - nz * WALLRUN.probe);
    const box = collidesAt(_tmpMoveA, r, 1.0);
    if (!box || box.max.y < p.y + WALLRUN.minWallAbove) continue;
    // the wall face must actually be facing us along this axis (not a corner we're inside of)
    _tmpMoveA.set(p.x, p.y + 0.3, p.z);
    if (collidesAt(_tmpMoveA, r, 1.0) === box) continue;
    const tx = -nz, tz = nx; // tangent
    const vAlong = player.vel.x * tx + player.vel.z * tz;
    const lookAlong = fx * tx + fz * tz;
    // run the way we're looking; need to be looking mostly along the wall, not into it
    const dirSign = Math.abs(lookAlong) > 0.05 ? Math.sign(lookAlong) : Math.sign(vAlong);
    const along = vAlong * dirSign;
    const lookInto = -(fx * nx + fz * nz);
    if (Math.abs(lookAlong) < 0.35 || lookInto > 0.93) continue;
    const side = (rx * -nx + rz * -nz) > 0 ? 1 : -1; // +1 wall on our right
    const cand = { box, nx, nz, tx: tx * dirSign, tz: tz * dirSign, along, side };
    if (!best || cand.along > best.along) best = cand;
  }
  return best;
}
export function rayWallDist(origin, dir, maxDist) {
  const ray = new THREE.Ray(origin, dir.clone().normalize());
  const pt = new THREE.Vector3();
  let best = maxDist;
  for (const b of colliders) {
    const hit = ray.intersectBox(b, pt);
    if (hit) { const d = origin.distanceTo(pt); if (d < best) best = d; }
  }
  return best;
}
export function hasLOS(a, b) {
  const dir = b.clone().sub(a); const dist = dir.length(); dir.normalize();
  return rayWallDist(a, dir, dist - 0.3) >= dist - 0.35;
}

