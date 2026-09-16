// js/gore.js — AGENTS: Gore rules + corpses: SET.gore scaling (goreN/goreCap), blood splatter, explosive dismemberment, screen blood, ragdoll death falls.
// Ownership: GORE_MULT/GK, explodeBody, screenGore, updateRagdoll, goreRemoteDeath, updateDeadBots.

import * as THREE from 'three';
import { AudioSys } from './audio.js';
import { SET, opts } from './settings.js';
import { $, clamp, rand } from './utils.js';
import { spawnBloodPool, spawnBurst, spawnDecal, spawnSmoke } from './effects.js';
import { explodeHead, gibCollide, gibMats, spawnBloodSpray, spawnGibMesh, tearLimbGib } from './gibs.js';
import { colliders } from './map.js';
import { camera } from './render.js';
import { bots } from './state.js';

// Scale factor for every particle count, chunk count and decal cap in the game.
// SET.gore is the master switch; SET.goreLevel picks how far past "tasteful" to go.
const GORE_MULT = [0, 0.5, 1.0, 1.9, 3.0, 4.8];
export const GK = () => (SET.gore ? (GORE_MULT[clamp(Math.round(SET.goreLevel || 5), 0, 5)] || 0) : 0);
export const goreN = (base) => Math.max(0, Math.round(base * GK() * (opts.quality ? 1 : 0.5)));
export const goreCap = (base) => Math.round(base * Math.max(1, GK()));
// Whole-corpse contact: keep the sliding body out of crates/walls so the
// knockback never ends buried in geometry. Horizontal push-out only — the
// tip-over tween owns Y. ponytail: no per-bone simulation, one capsule push.
export function slideCorpseOut(mesh, radius = 0.5) {
  try {
    const p = mesh.position, v = new THREE.Vector3();
    if (gibCollide(p, v, radius, 0, 0)) {
      p.y = Math.max(p.y, 0.05);
      return true;
    }
  } catch (e) {}
  return false;
}
// Which face of an axis-aligned box is this point on? Needed to lay a splat flat
// against a wall instead of edge-on to it.
function boxFaceNormal(box, p) {
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const dx = (p.x - c.x) / (s.x || 1e-6), dy = (p.y - c.y) / (s.y || 1e-6), dz = (p.z - c.z) / (s.z || 1e-6);
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  if (ax >= ay && ax >= az) return new THREE.Vector3(Math.sign(dx) || 1, 0, 0);
  if (ay >= az) return new THREE.Vector3(0, Math.sign(dy) || 1, 0);
  return new THREE.Vector3(0, 0, Math.sign(dz) || 1);
}
// Throw blood outward from a wound and stain whatever it lands on — walls, crates,
// the floor. This is what makes a firefight leave a scene behind.
const _splatRay = new THREE.Ray(), _splatPt = new THREE.Vector3();
export function bloodSplatterRays(origin, dir, count = 8, spread = 1, maxDist = 7) {
  const k = GK();
  if (!k) return;
  // each ray walks every collider, so cap the work regardless of gore level
  const n = Math.min(36, goreN(count));
  for (let i = 0; i < n; i++) {
    const d = dir ? dir.clone() : new THREE.Vector3(rand(-1, 1), rand(-0.2, 0.4), rand(-1, 1));
    d.x += rand(-spread, spread); d.y += rand(-spread * 0.7, spread * 0.7); d.z += rand(-spread, spread);
    if (d.lengthSq() < 1e-4) continue;
    d.normalize();
    _splatRay.set(origin, d);
    let best = maxDist, hitPt = null, normal = null;
    for (const b of colliders) {
      if (_splatRay.intersectBox(b, _splatPt)) {
        const dd = origin.distanceTo(_splatPt);
        if (dd < best && dd > 0.2) { best = dd; hitPt = _splatPt.clone(); normal = boxFaceNormal(b, hitPt); }
      }
    }
    if (d.y < -0.05) { // floor
      const tg = -origin.y / d.y;
      if (tg > 0.2 && tg < best) { best = tg; hitPt = origin.clone().addScaledVector(d, tg); normal = new THREE.Vector3(0, 1, 0); }
    }
    if (hitPt) {
      const far = clamp(1 - best / maxDist, 0.3, 1);
      spawnDecal('blood', hitPt, normal, rand(0.55, 1.5) * (0.8 + k * 0.12) * (0.55 + far), rand(0.5, 1));
    }
  }
}
// which part did the killing shot hit? head is known; torso vs leg from wound height.
export function woundPart(feetY, hitY, head) {
  if (head) return 'head';
  const h = (hitY || 0) - (feetY || 0);
  return h < 0.8 ? 'leg' : 'torso';
}
// A body that stops being a body. Returns true if it actually came apart.
// EXPLOSIVES ONLY — bullets never call this (they tear one part, see above).
export function explodeBody(mesh, pos, dir, power = 1, team = 't') {
  const k = GK();
  if (!k) return false;
  try {
    const M = gibMats();
    const cloth = team === 'ct' ? M.clothCT : M.clothT;
    const origin = new THREE.Vector3(pos.x, (pos.y || 0) + 1.0, pos.z);
    const kick = (mag, up) => {
      const v = new THREE.Vector3(rand(-1, 1), rand(0.2, 1), rand(-1, 1)).normalize().multiplyScalar(mag * rand(0.6, 1.2));
      if (dir) v.addScaledVector(dir, rand(0.4, 1.8) * power);
      v.y += up * rand(0.7, 1.3);
      return v;
    };
    const at = (spread, yLo, yHi) => new THREE.Vector3(
      pos.x + rand(-spread, spread), (pos.y || 0) + rand(yLo, yHi), pos.z + rand(-spread, spread));

    // torso split in two
    for (let i = 0; i < 2; i++) {
      const half = new THREE.Mesh(new THREE.BoxGeometry(rand(0.26, 0.34), rand(0.3, 0.4), rand(0.3, 0.38)), i ? cloth : M.flesh);
      spawnGibMesh(half, at(0.2, 0.9, 1.4), kick(2.4 * power, 1.5), { flesh: true, restY: 0.16 });
    }
    // limbs
    for (let i = 0; i < 4; i++) {
      const limb = new THREE.Mesh(new THREE.BoxGeometry(rand(0.13, 0.19), rand(0.32, 0.5), rand(0.13, 0.18)),
        Math.random() < 0.55 ? cloth : M.flesh);
      spawnGibMesh(limb, at(0.3, 0.5, 1.5), kick(3.2 * power, 2.0), { flesh: true, restY: 0.12 });
    }
    // meat, bone and viscera
    const chunks = goreN(4) + 2;
    for (let i = 0; i < chunks; i++) {
      const roll = Math.random();
      let g, mt;
      if (roll < 0.34) { g = new THREE.BoxGeometry(rand(0.07, 0.16), rand(0.07, 0.15), rand(0.07, 0.15)); mt = M.flesh; }
      else if (roll < 0.55) { g = new THREE.BoxGeometry(rand(0.03, 0.06), rand(0.16, 0.34), rand(0.03, 0.06)); mt = M.bone; }
      else if (roll < 0.78) { g = new THREE.SphereGeometry(rand(0.06, 0.13), 8, 6); mt = M.fleshD; }
      else { g = new THREE.BoxGeometry(rand(0.09, 0.2), rand(0.03, 0.06), rand(0.09, 0.2)); mt = cloth; }
      spawnGibMesh(new THREE.Mesh(g, mt), at(0.35, 0.4, 1.8), kick(4.0 * power, 2.6), { flesh: true, restY: 0.09 });
    }
    // skull + helmet go their own way
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), M.bone);
    spawnGibMesh(skull, at(0.15, 1.6, 1.9), kick(3.6 * power, 3.0), { flesh: true, restY: 0.15 });
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.18, 0.42), team === 'ct' ? M.helmetCT : M.helmetT);
    spawnGibMesh(lid, at(0.2, 1.8, 2.1), kick(3.4 * power, 2.6), { helmet: true, restY: 0.1 });

    // the mess it leaves
    spawnBloodSpray(origin, dir, 2.0 * power);
    spawnBurst(origin, 0xa00d10, goreN(18) + 8, 9 * power, 0.9, 0.16);
    spawnBurst(origin, 0x5d0b0d, goreN(10) + 4, 5 * power, 1.3, 0.22);
    for (let i = 0; i < goreN(1) + 1; i++) spawnSmoke(at(0.5, 0.6, 1.4), 0.5 + Math.random() * 0.5, 1.1, 0x6a0d10);
    bloodSplatterRays(origin, null, 16, 1.2, 8);
    for (let i = 0; i < goreN(2) + 1; i++) spawnBloodPool(pos.x + rand(-1.3, 1.3), pos.z + rand(-1.3, 1.3), true);
    try { AudioSys.gib(origin, true); } catch (e) {}
    try { AudioSys.headpop(origin); } catch (e) {}
    // the body itself is gone
    try { mesh.visible = false; } catch (e) {}
    return true;
  } catch (e) { return false; }
}
// Pulsing arterial spray from a wound that has not stopped bleeding. Called per frame.
export function bloodFountain(pos, dt, power = 1) {
  const k = GK();
  if (!k) return;
  const n = Math.max(1, Math.round(power * (0.6 + k * 0.5)));
  if (Math.random() > dt * 22 * Math.min(2, k)) return;
  const p = pos.clone();
  const spurt = 1 + Math.sin(performance.now() / 110) * 0.65; // heartbeat
  spawnBurst(p, 0xa00d10, n, 2.2 * spurt * power, 0.5, 0.09);
  if (Math.random() < 0.28 * k) {
    bloodSplatterRays(p, new THREE.Vector3(rand(-0.4, 0.4), rand(0.2, 1), rand(-0.4, 0.4)), 2, 0.5, 4);
  }
}
// Blood on the lens: splattered when you are hit, or when something dies in your face.
let _goreScreen = 0, _goreScreenTex = null;
function goreScreenTexture() {
  if (_goreScreenTex) return _goreScreenTex;
  const c = document.createElement('canvas');
  c.width = 512; c.height = 288;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const blob = (x, y, r, a) => {
    g.fillStyle = `rgba(${105 + Math.random() * 45 | 0},${4 + Math.random() * 8 | 0},${6 + Math.random() * 8 | 0},${a})`;
    g.beginPath();
    g.moveTo(x + r, y);
    for (let i = 1; i <= 11; i++) {
      const th = (i / 11) * Math.PI * 2;
      const rr = r * (0.55 + Math.random() * 0.75);
      g.lineTo(x + Math.cos(th) * rr, y + Math.sin(th) * rr * 0.9);
    }
    g.closePath(); g.fill();
    // runs
    if (Math.random() < 0.5) {
      g.fillRect(x - r * 0.18, y, r * 0.36, r * (1.2 + Math.random() * 3.2));
    }
  };
  // heavier around the edges, sparse in the middle so you can still play
  for (let i = 0; i < 46; i++) {
    const edge = Math.random() < 0.72;
    const x = edge ? (Math.random() < 0.5 ? Math.random() * 130 : c.width - Math.random() * 130) : Math.random() * c.width;
    const y = edge ? Math.random() * c.height : (Math.random() < 0.5 ? Math.random() * 70 : c.height - Math.random() * 70);
    blob(x, y, 8 + Math.random() * 34, 0.5 + Math.random() * 0.45);
  }
  for (let i = 0; i < 90; i++) blob(Math.random() * c.width, Math.random() * c.height, 2 + Math.random() * 7, 0.35 + Math.random() * 0.4);
  _goreScreenTex = c.toDataURL('image/png');
  return _goreScreenTex;
}
export function screenGore(amount = 1) {
  const k = GK();
  if (!k) return;
  const el = $('gore-overlay');
  if (!el) return;
  try {
    if (!el.style.backgroundImage) el.style.backgroundImage = `url(${goreScreenTexture()})`;
    // re-roll orientation so repeat splatters don't look identical
    el.style.transform = `scaleX(${Math.random() < 0.5 ? -1 : 1}) scaleY(${Math.random() < 0.5 ? -1 : 1}) rotate(${(Math.random() * 6 - 3).toFixed(1)}deg)`;
  } catch (e) {}
  _goreScreen = Math.min(1, _goreScreen + amount * clamp(k * 0.35, 0.2, 1));
}
export function updateGoreScreen(dt) {
  const el = $('gore-overlay');
  if (!el) return;
  if (_goreScreen > 0) {
    _goreScreen = Math.max(0, _goreScreen - dt * 0.34);
    el.style.opacity = (_goreScreen * 0.88).toFixed(3);
  } else if (el.style.opacity !== '0') el.style.opacity = 0;
}

// where should this corpse fall? Away from the shooter, with randomness.
// Returns {axis(x/z tip), yawSpin, power} consumed by updateDeadBots / remote dead anim.
export function pickFallParams(botPos, shotDir, power = 1) {
  const d = shotDir ? shotDir.clone().setY(0) : new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1));
  if (d.lengthSq() < 0.01) d.set(rand(-1, 1), 0, rand(-1, 1));
  d.normalize();
  return {
    dirX: d.x, dirZ: d.z,
    spin: rand(-0.9, 0.9) * power,
    roll: rand(-0.45, 0.45),
    power: clamp(power, 0.6, 2.2),
    sprawl: Math.random(),
  };
}
// Death is simulated, not posed. Every joint goes limp with an initial angular
// kick from the impact and then springs toward a dead-weight rest angle, so the
// limbs whip on the way down and settle afterwards. A single random pose (what
// this used to do) always reads as a mannequin dropped on the floor.
export function poseCorpseLimbs(mesh, sprawl, power) {
  const ud = mesh && mesh.userData;
  const r = ud && ud.rig;
  if (!r) return;
  const pw = clamp(power || (0.8 + (sprawl || 0) * 0.9), 0.5, 2.4);
  const s = () => rand(-1, 1);
  const J = (o, tx, tz, vx, vz, stiff) => ({ o, tx, tz, vx, vz, stiff });
  try {
    ud.rag = {
      t: 0,
      j: [
        // arms let go of the weapon and flop outward
        J(r.shoulderL, 0.10 + rand(-0.30, 0.30), -0.50 + s() * 0.5, -3.4 * pw + s() * 2, s() * 4 * pw, 16),
        J(r.shoulderR, 0.10 + rand(-0.30, 0.30), 0.50 + s() * 0.5, -3.4 * pw + s() * 2, s() * 4 * pw, 16),
        J(r.elbowL, -0.30 + rand(-0.40, 0.10), 0, s() * 5, 0, 22),
        J(r.elbowR, -0.30 + rand(-0.40, 0.10), 0, s() * 5, 0, 22),
        // legs buckle: knees fold, hips splay
        J(r.hipL, rand(-0.35, 0.25), rand(-0.22, 0.05), s() * 3 * pw, s() * 1.5, 18),
        J(r.hipR, rand(-0.35, 0.25), rand(-0.05, 0.22), s() * 3 * pw, s() * 1.5, 18),
        J(r.kneeL, rand(0.15, 0.85), 0, rand(0, 4) * pw, 0, 20),
        J(r.kneeR, rand(0.15, 0.85), 0, rand(0, 4) * pw, 0, 20),
        J(r.spine, rand(-0.15, 0.22), rand(-0.22, 0.22), s() * 2, s() * 2, 14),
        J(r.chest, rand(-0.10, 0.16), rand(-0.16, 0.16), s() * 2, s() * 2, 14),
        // the head is heavy and unsupported — it lolls hardest
        J(r.neck, rand(-0.55, 0.60), rand(-0.55, 0.55), s() * 6 * pw, s() * 5 * pw, 12),
      ],
    };
    ud.anim = null;              // gait clock is dead with the body
    r.pelvis.position.y = r.hipY * 0.94; // hips sag as the legs stop carrying weight
    if (r.gun) { r.gun.rotation.z += rand(-0.6, 0.6); r.gun.rotation.x += rand(-0.4, 0.4); }
  } catch (e) {}
}
// Body fall shares one clock: knees buckle first (slow start), then the torso
// slams down accelerating (gravity, not eased-out), with a small ground bounce
// on impact. Returns {k (0..1 linear), e (tip ease with bounce)}.
export function corpseK(deathT) {
  const k = Math.min(1, (deathT || 0) / 0.85);
  const slam = 1 - Math.cos(k * Math.PI / 2);
  const bounce = k > 0.7 ? Math.sin((k - 0.7) / 0.3 * Math.PI) * 0.08 * (1 - k) : 0;
  return { k, e: slam - bounce };
}
// Integrate one corpse's limp joints. Spring toward rest, damped, knees one-way.
export function updateRagdoll(mesh, dt) {
  const ud = mesh && mesh.userData;
  const rg = ud && ud.rag;
  if (!rg) return;
  rg.t += dt;
  if (rg.t > 3.5) { ud.rag = null; return; } // fully settled — stop paying for it
  const d = Math.exp(-3.2 * dt); // loose damping: limbs keep whipping through the ~0.85s fall
  for (const j of rg.j) {
    if (!j.o) continue;
    j.vx = (j.vx + (j.tx - j.o.rotation.x) * j.stiff * dt) * d;
    j.vz = (j.vz + (j.tz - j.o.rotation.z) * j.stiff * dt) * d;
    j.o.rotation.x += j.vx * dt;
    j.o.rotation.z += j.vz * dt;
  }
  const r = ud.rig;
  if (r) {
    r.kneeL.rotation.x = Math.max(0, r.kneeL.rotation.x); // knees don't bend forward
    r.kneeR.rotation.x = Math.max(0, r.kneeR.rotation.x);
  }
}
// PvP gore for a remote player's mesh: same rules as bots (head-pop odds by weapon),
// but driven by the network 'killed' event (authoritative victim) rather than damageBot.
export function goreRemoteDeath(entry, head, weaponLabel, shotDir) {
  if (!entry || !entry.mesh) return;
  try {
    if (entry.fall) return; // already gored (snapshot transition may fire twice)
    const wName = String(weaponLabel || (entry.data && entry.data.weapon) || 'AK-47').toUpperCase();
    const isFire = wName.includes('MOLOTOV');
    const explosive = !isFire && (wName.includes('HE') || wName.includes('C4'));
    const isAWP = wName.includes('AWP');
    const isDeagle = wName.includes('DESERT') || wName.includes('DEAGLE') || wName.includes('EAGLE');
    let power = explosive ? 2.1 : isAWP ? 2.0 : isDeagle ? 1.4 : 1.0;
    if (head) power += 0.15;
    const sdir = shotDir ? shotDir.clone() : null;
    entry.fall = pickFallParams(entry.pos, sdir, power);
    entry.deathPos = entry.pos.clone();
    const slideDist = explosive ? rand(0.9, 1.6) : isAWP ? rand(0.7, 1.2) : isDeagle ? rand(0.45, 0.8) : rand(0.3, 0.65);
    const flat = sdir ? sdir.clone().setY(0) : new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1));
    if (flat.lengthSq() < 0.01) flat.set(rand(-1, 1), 0, rand(-1, 1));
    flat.normalize();
    entry.knock = flat.multiplyScalar(slideDist);
    entry.deathT = 0; entry._thudded = false; entry.headless = false;
    const team = (entry.data && entry.data.team) || 't';
    const headPos = new THREE.Vector3(entry.pos.x, entry.pos.y + 1.76, entry.pos.z);
    let pop = false, popPower = 1;
    if (explosive) {
      pop = Math.random() < 0.75; popPower = 1.7;
      tearLimbGib(entry.mesh, entry.pos, sdir, team, true, 'torso');
    } else if (head) {
      if (isAWP) { pop = true; popPower = 1.7; }
      else if (isDeagle) { pop = Math.random() < 0.65; popPower = 1.3; }
      else { pop = Math.random() < 0.25; popPower = 1.0; }
    } else if (isAWP && Math.random() < 0.25) {
      tearLimbGib(entry.mesh, entry.pos, sdir, team, false, 'torso'); // net has no wound height — torso only
    }
    if (pop) {
      entry.headless = true;
      try { explodeHead(entry.mesh, headPos, sdir, popPower, team); } catch (e) {}
    } else {
      try { spawnBloodSpray(head ? headPos : new THREE.Vector3(entry.pos.x, entry.pos.y + 1.1, entry.pos.z), sdir, head ? 1.2 : power); } catch (e) {}
      try { spawnBloodPool(entry.pos.x, entry.pos.z, true); } catch (e) {}
      if (head) { try { AudioSys.headpop(headPos); } catch (e) {} }
    }
    try {
      const gk = GK();
      if (gk > 0 && explosive
          && explodeBody(entry.mesh, entry.pos, shotDir, entry.fall.power, (entry.data && entry.data.team) || 't')) {
        entry.exploded = true;
        try {
          const dp = camera ? camera.position.distanceTo(new THREE.Vector3(entry.pos.x, 1, entry.pos.z)) : 99;
          if (dp < 7) screenGore(clamp(1.2 - dp / 7, 0.25, 1));
        } catch (e) {}
      } else {
        poseCorpseLimbs(entry.mesh, entry.fall.sprawl, entry.fall.power);
      }
    } catch (e) {}
    entry.mesh.visible = true;
  } catch (e) {}
}
// staged death fall: fast tip-over -> ground thud dust -> settle (corpses persist to round end)
// momentum ragdoll: corpse is knocked along the bullet/blast, tips over onto
// its back/front/side (biased by shot dir vs facing), limbs sprawl, then rests.
// Headless corpses (head-pop) keep the stump hidden-face and bleed out.
export function updateDeadBots(dt) {
  for (const b of bots) {
    if (b.alive) continue;
    if (b.exploded) {
      // nothing left to animate — just the pool spreading where they used to be
      b.deathT = Math.min(6.0, (b.deathT || 0) + dt);
      if (b.deathT < 5.0) {
        try {
          bloodFountain(new THREE.Vector3(b.pos.x, 0.18, b.pos.z), dt, 1.6);
          if (Math.random() < dt * 2.2) spawnBloodPool(b.pos.x + rand(-1.1, 1.1), b.pos.z + rand(-1.1, 1.1), Math.random() < 0.4);
        } catch (e) {}
      }
      if (b.blob) b.blob.visible = false;
      continue;
    }
    if (!b.mesh.visible) continue;
    b.deathT = Math.min(1.6, (b.deathT || 0) + dt);
    updateRagdoll(b.mesh, dt);
    const { k, e: ease } = corpseK(b.deathT);
    const fall = b.fall || { dirX: 0, dirZ: 1, spin: 0, roll: 0, power: 1 };
    try {
      // knockback slide + hop: fast out, friction stop
      if (b.deathPos && b.knock) {
        const slide = 1 - ease;
        b.mesh.position.set(
          b.deathPos.x + b.knock.x * ease,
          0.05 + Math.sin(Math.min(1, k * 1.3) * Math.PI) * 0.10 * (fall.power || 1) * (1 - k),
          b.deathPos.z + b.knock.z * ease
        );
        try { slideCorpseOut(b.mesh, 0.5); } catch (e) {}
        // keep logical pos glued to the corpse so blood pools / bomb drops line up
        b.pos.set(b.mesh.position.x, 0, b.mesh.position.z);
        void slide;
      } else {
        b.mesh.position.y = 0.05 + Math.sin(Math.min(1, k * 1.3) * Math.PI) * 0.08 * (1 - k);
      }
      // tip-over: forward/back from shot-vs-facing + sideways roll + yaw spin
      const fwdX = Math.sin(b.yaw || 0), fwdZ = Math.cos(b.yaw || 0);
      const fwdDot = (fall.dirX || 0) * fwdX + (fall.dirZ || 0) * fwdZ;
      const sideDot = (fall.dirX || 0) * fwdZ - (fall.dirZ || 0) * fwdX;
      const tipMag = Math.PI / 2 * (0.92 + Math.min(0.35, (fall.power || 1) * 0.1));
      // falling forward (shot from behind) pitches face-down (+x), from front falls back
      const targetRX = (fwdDot >= 0 ? tipMag : -tipMag) * (0.75 + Math.abs(fwdDot) * 0.45);
      const targetRZ = clamp(-sideDot * tipMag * 0.9 + (fall.roll || 0), -1.2, 1.2);
      b.mesh.rotation.x = targetRX * ease;
      b.mesh.rotation.z = targetRZ * ease;
      b.mesh.rotation.y = (b.yaw || 0) + (fall.spin || 0) * ease;
      // headless stump: keep neck bleeding briefly after landing
      // open wounds keep pumping long after the body lands
      if (b.headless && b.deathT < 6.0) {
        try {
          const sp = new THREE.Vector3(b.pos.x, Math.max(0.12, 1.0 - ease * 0.75), b.pos.z);
          bloodFountain(sp, dt, 1 + (b.exploded ? 0.8 : 0));
          if (Math.random() < dt * 1.6) spawnBloodPool(b.pos.x + rand(-0.6, 0.6), b.pos.z + rand(-0.6, 0.6), false);
        } catch (e) {}
      }
    } catch (e) {}
    if (!b._thudded && k >= 1) {
      b._thudded = true;
      try { spawnSmoke(new THREE.Vector3(b.pos.x, 0.25, b.pos.z), 0.7, 0.9, 0xbfae8e); } catch (e) {}
      try { AudioSys.thud(new THREE.Vector3(b.pos.x, 0.6, b.pos.z)); } catch (e) {}
    }
    try { if (b.blob) { b.blob.position.set(b.pos.x, 0.02, b.pos.z); } } catch (e) {}
  }
}

