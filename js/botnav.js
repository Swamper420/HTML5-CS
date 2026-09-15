// js/botnav.js — AGENTS: Bot navigation: A* grid baked from colliders, path smoothing, steering, depenetration, teammate separation.
// Ownership: NAV, BOT_R, navBuild, navFindPath, navSteer, botDepenetrate, botSeparate, botOpenHeading.

import * as THREE from 'three';
import { MAP_HALF } from './config.js';
import { clamp } from './utils.js';
import { collidesAt } from './collision.js';
import { colliders } from './map.js';
import { bots } from './state.js';

// Bots used to steer in a straight line at a waypoint and slide along whatever wall
// was in between, which is how they got pinned in corners. Now every bot plans a
// real route over a walkable grid baked from the colliders, smooths it into natural
// corner-to-corner lines, keeps a little distance from walls and teammates, and
// notices when it stops making progress (then re-plans / sidesteps).
export const BOT_R = 0.42;
const NAV = {
  cell: 0.4, n: 0, count: -1, blocked: null, clear: null, rects: null,
  g: null, par: null, seen: null, closed: null, heapI: null, heapF: null, gen: 1,
  budget: 0, frameT: -1,
};
const NAV_DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];

function navBuild() {
  const c = NAV.cell, n = Math.ceil((MAP_HALF * 2) / c), N = n * n;
  NAV.n = n; NAV.count = colliders.length;
  const blocked = new Uint8Array(N);
  const inf = BOT_R + 0.1;
  const rects = [];
  for (const b of colliders) {
    if (b.max.y < 0.05 || b.min.y > 1.7) continue; // same vertical span collidesAt() tests
    rects.push(b.min.x, b.min.z, b.max.x, b.max.z);
    const x0 = Math.max(0, Math.floor((b.min.x - inf + MAP_HALF) / c)), x1 = Math.min(n - 1, Math.floor((b.max.x + inf + MAP_HALF) / c));
    const z0 = Math.max(0, Math.floor((b.min.z - inf + MAP_HALF) / c)), z1 = Math.min(n - 1, Math.floor((b.max.z + inf + MAP_HALF) / c));
    for (let iz = z0; iz <= z1; iz++) {
      const cz = -MAP_HALF + (iz + 0.5) * c;
      if (cz < b.min.z - inf || cz > b.max.z + inf) continue;
      for (let ix = x0; ix <= x1; ix++) {
        const cx = -MAP_HALF + (ix + 0.5) * c;
        if (cx < b.min.x - inf || cx > b.max.x + inf) continue;
        blocked[iz * n + ix] = 1;
      }
    }
  }
  const edge = MAP_HALF - BOT_R - 0.1;
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const cx = -MAP_HALF + (ix + 0.5) * c, cz = -MAP_HALF + (iz + 0.5) * c;
    if (Math.abs(cx) > edge || Math.abs(cz) > edge) blocked[iz * n + ix] = 1;
  }
  // Clearance field (cells to nearest wall) so routes run down the middle of lanes.
  const clear = new Uint8Array(N).fill(255);
  const q = new Int32Array(N); let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (blocked[i]) { clear[i] = 0; q[qt++] = i; }
  while (qh < qt) {
    const i = q[qh++], d = clear[i];
    if (d >= 8) continue;
    const ix = i % n, iz = (i / n) | 0;
    if (ix > 0 && clear[i - 1] > d + 1) { clear[i - 1] = d + 1; q[qt++] = i - 1; }
    if (ix < n - 1 && clear[i + 1] > d + 1) { clear[i + 1] = d + 1; q[qt++] = i + 1; }
    if (iz > 0 && clear[i - n] > d + 1) { clear[i - n] = d + 1; q[qt++] = i - n; }
    if (iz < n - 1 && clear[i + n] > d + 1) { clear[i + n] = d + 1; q[qt++] = i + n; }
  }
  NAV.blocked = blocked; NAV.clear = clear; NAV.rects = new Float32Array(rects);
  NAV.g = new Float32Array(N); NAV.par = new Int32Array(N);
  NAV.seen = new Uint32Array(N); NAV.closed = new Uint32Array(N);
  NAV.heapI = new Int32Array(N * 8); NAV.heapF = new Float32Array(N * 8);
}
function navReady() { if (NAV.count !== colliders.length || !NAV.blocked) navBuild(); }
function navIdx(x, z) {
  const n = NAV.n, c = NAV.cell;
  const ix = clamp(Math.floor((x + MAP_HALF) / c), 0, n - 1), iz = clamp(Math.floor((z + MAP_HALF) / c), 0, n - 1);
  return iz * n + ix;
}
function navCellPos(i) {
  const n = NAV.n, c = NAV.cell;
  return new THREE.Vector3(-MAP_HALF + ((i % n) + 0.5) * c, 0, -MAP_HALF + (((i / n) | 0) + 0.5) * c);
}
function navNearestFree(i) {
  const B = NAV.blocked, n = NAV.n;
  if (!B[i]) return i;
  const ix = i % n, iz = (i / n) | 0;
  for (let r = 1; r < 30; r++) {
    let best = -1, bestD = 1e9;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
      const x = ix + dx, z = iz + dz;
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const j = z * n + x;
      if (!B[j] && dx * dx + dz * dz < bestD) { bestD = dx * dx + dz * dz; best = j; }
    }
    if (best >= 0) return best;
  }
  return -1;
}
// Can a body walk the straight segment a->b without touching any collider?
function navWalkable(a, b, inflate = BOT_R + 0.08) {
  navReady();
  const R = NAV.rects, ax = a.x, az = a.z, dx = b.x - a.x, dz = b.z - a.z;
  for (let k = 0; k < R.length; k += 4) {
    const x0 = R[k] - inflate, z0 = R[k + 1] - inflate, x1 = R[k + 2] + inflate, z1 = R[k + 3] + inflate;
    let tmin = 0, tmax = 1;
    if (Math.abs(dx) < 1e-9) { if (ax < x0 || ax > x1) continue; }
    else {
      let t1 = (x0 - ax) / dx, t2 = (x1 - ax) / dx;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;
    }
    if (Math.abs(dz) < 1e-9) { if (az < z0 || az > z1) continue; }
    else {
      let t1 = (z0 - az) / dz, t2 = (z1 - az) / dz;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;
    }
    return false;
  }
  return Math.abs(b.x) < MAP_HALF - 0.5 && Math.abs(b.z) < MAP_HALF - 0.5;
}
function navFindPath(from, to) {
  navReady();
  const n = NAV.n, B = NAV.blocked, CL = NAV.clear;
  const s = navNearestFree(navIdx(from.x, from.z)), goal = navNearestFree(navIdx(to.x, to.z));
  if (s < 0 || goal < 0) return null;
  const gen = ++NAV.gen;
  const G = NAV.g, P = NAV.par, S = NAV.seen, C = NAV.closed, HI = NAV.heapI, HF = NAV.heapF, cap = HI.length;
  const gx = goal % n, gz = (goal / n) | 0;
  let hn = 0;
  const push = (i, f) => {
    if (hn >= cap) return;
    let k = hn++;
    while (k > 0) { const p = (k - 1) >> 1; if (HF[p] <= f) break; HI[k] = HI[p]; HF[k] = HF[p]; k = p; }
    HI[k] = i; HF[k] = f;
  };
  const pop = () => {
    const top = HI[0], li = HI[--hn], lf = HF[hn];
    let k = 0;
    for (;;) {
      let ch = 2 * k + 1; if (ch >= hn) break;
      if (ch + 1 < hn && HF[ch + 1] < HF[ch]) ch++;
      if (HF[ch] >= lf) break;
      HI[k] = HI[ch]; HF[k] = HF[ch]; k = ch;
    }
    HI[k] = li; HF[k] = lf;
    return top;
  };
  const h = (i) => { const dx = Math.abs((i % n) - gx), dz = Math.abs(((i / n) | 0) - gz); return dx + dz - 0.5858 * Math.min(dx, dz); };
  S[s] = gen; G[s] = 0; P[s] = -1; push(s, h(s));
  let found = false, iters = 0;
  while (hn > 0) {
    const i = pop();
    if (C[i] === gen) continue;
    C[i] = gen;
    if (i === goal) { found = true; break; }
    if (++iters > 60000) break;
    const ix = i % n, iz = (i / n) | 0;
    for (const [ox, oz, cost] of NAV_DIRS) {
      const x = ix + ox, z = iz + oz;
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const j = z * n + x;
      if (B[j] || C[j] === gen) continue;
      if (ox && oz && (B[iz * n + x] || B[z * n + ix])) continue; // no corner cutting
      const cl = CL[j];
      const pen = cl <= 1 ? 2.2 : cl === 2 ? 0.9 : cl === 3 ? 0.35 : cl === 4 ? 0.1 : 0;
      const ng = G[i] + cost * (1 + pen);
      if (S[j] !== gen || ng < G[j]) { S[j] = gen; G[j] = ng; P[j] = i; push(j, ng + h(j)); }
    }
  }
  if (!found) return null;
  const raw = [];
  for (let i = goal; i >= 0; i = P[i]) raw.push(i);
  raw.reverse();
  const pts = raw.map(navCellPos);
  if (!B[navIdx(to.x, to.z)]) pts[pts.length - 1] = new THREE.Vector3(to.x, 0, to.z);
  // String-pull into long straight legs (what a person actually walks).
  const out = [];
  let anchor = new THREE.Vector3(from.x, 0, from.z), k = -1;
  while (k < pts.length - 1) {
    let j = k + 1;
    while (j + 1 < pts.length && navWalkable(anchor, pts[j + 1])) j++;
    out.push(pts[j]); anchor = pts[j]; k = j;
  }
  return out;
}

// Returns a unit {x,z} heading that follows the planned route toward `goal`,
// or null once within `arrive` metres. Also exposes bot._navLook (a point ahead to face).
export function navSteer(bot, goal, t, arrive = 1.2) {
  navReady();
  if (NAV.frameT !== t) { NAV.frameT = t; NAV.budget = 3; }
  const gdx = goal.x - bot.pos.x, gdz = goal.z - bot.pos.z;
  if (gdx * gdx + gdz * gdz < arrive * arrive) { bot.path = null; return null; }
  if (!bot.pathGoal) bot.pathGoal = new THREE.Vector3(1e9, 0, 1e9);
  const goalMoved = bot.pathGoal.distanceToSquared(goal) > 2.0 * 2.0;
  const stale = t - (bot.pathT || 0) > 5;
  if (!bot.path || goalMoved || stale) {
    if (!bot.path || NAV.budget > 0) {
      NAV.budget--;
      bot.path = navFindPath(bot.pos, goal) || [new THREE.Vector3(goal.x, 0, goal.z)];
      bot.pathI = 0; bot.pathGoal.set(goal.x, 0, goal.z); bot.pathT = t; bot._shortcutAt = 0;
    }
  }
  const P = bot.path;
  let i = Math.min(bot.pathI || 0, P.length - 1);
  while (i < P.length - 1) {
    const dx = P[i].x - bot.pos.x, dz = P[i].z - bot.pos.z, d2 = dx * dx + dz * dz;
    if (d2 < 0.55 * 0.55) { i++; continue; }
    // walked past the corner already?
    const nx = P[i + 1].x - P[i].x, nz = P[i + 1].z - P[i].z;
    if (d2 < 1.5 * 1.5 && (-dx * nx - dz * nz) > 0) { i++; continue; }
    break;
  }
  if (i < P.length - 1 && t > (bot._shortcutAt || 0)) {
    bot._shortcutAt = t + 0.3;
    if (navWalkable(bot.pos, P[i + 1])) i++;
  }
  bot.pathI = i;
  const tg = P[i];
  let dx = tg.x - bot.pos.x, dz = tg.z - bot.pos.z;
  let d = Math.hypot(dx, dz);
  if (i === P.length - 1 && d < 0.45) return null; // as close as the walkable space allows
  dx /= d; dz /= d;
  const look = P[Math.min(i + 1, P.length - 1)];
  bot._navLook = d < 2.5 && look !== tg ? look : tg;
  return { x: dx, z: dz };
}

// A body overlapping a collider (spawn jitter into a crate, knockback, nade push)
// can't move at all — every axis step collides. Pop it out along the shallowest side.
export function botDepenetrate(bot) {
  for (let k = 0; k < 4; k++) {
    const hit = collidesAt(bot.pos, BOT_R);
    if (!hit) return;
    const e = BOT_R + 0.02;
    const opts = [
      [hit.max.x + e - bot.pos.x, 1, 0], [bot.pos.x - (hit.min.x - e), -1, 0],
      [hit.max.z + e - bot.pos.z, 0, 1], [bot.pos.z - (hit.min.z - e), 0, -1],
    ].sort((a, b) => a[0] - b[0]);
    const [d, sx, sz] = opts[0];
    if (d > 1.5) { // deep inside something big: jump to the nearest walkable cell
      navReady();
      const j = navNearestFree(navIdx(bot.pos.x, bot.pos.z));
      if (j >= 0) { const c = navCellPos(j); bot.pos.x = c.x; bot.pos.z = c.z; }
      return;
    }
    bot.pos.x += sx * d; bot.pos.z += sz * d;
  }
}
// Personal space + "keep right" so teammates don't bulldoze each other in doorways.
export function botSeparate(bot, dir) {
  let px = 0, pz = 0;
  for (const o of bots) {
    if (o === bot || !o.alive) continue;
    const ox = bot.pos.x - o.pos.x, oz = bot.pos.z - o.pos.z;
    const d = Math.hypot(ox, oz);
    if (d > 1.6 || d < 1e-4) continue;
    const w = (1.6 - d) / 1.6;
    px += (ox / d) * w * 1.3; pz += (oz / d) * w * 1.3;
    if (-(ox * dir.x + oz * dir.z) > 0) { px += dir.z * w * 0.6; pz -= dir.x * w * 0.6; } // pass on the right
  }
  if (px === 0 && pz === 0) return dir;
  let x = dir.x + px, z = dir.z + pz;
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}
const _probeV = new THREE.Vector3();
export function botDirFree(bot, dx, dz, dist = 0.7) {
  _probeV.set(bot.pos.x + dx * dist, bot.pos.y, bot.pos.z + dz * dist);
  return !collidesAt(_probeV, BOT_R);
}
// Pick an open heading closest to the preferred yaw (used to peel off a wall).
export function botOpenHeading(bot, yaw) {
  for (let k = 0; k < 8; k++) {
    for (const s of k ? [1, -1] : [1]) {
      const a = yaw + s * k * (Math.PI / 8);
      const x = Math.sin(a), z = Math.cos(a);
      if (botDirFree(bot, x, z, 0.8)) return { x, z };
    }
  }
  return null;
}

