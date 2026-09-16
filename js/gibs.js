// js/gibs.js — AGENTS: Gibs: detached limbs/heads as rigid-body chunks, blood spray, corpse restore between rounds.
// Ownership: gibs[], spawnGibMesh, explodeHead, tearLimbGib, restoreSoldierMesh, updateGibs.

import * as THREE from 'three';
import { AudioSys } from './audio.js';
import { SET, opts } from './settings.js';
import { clamp, rand } from './utils.js';
import { spawnBloodPool, spawnBurst, spawnDecal, spawnSmoke } from './effects.js';
import { goreCap } from './gore.js';
import { colliders } from './map.js';
import { remotes } from './multiplayer.js';
import { scene } from './render.js';
import { bots } from './state.js';

// Design: corpses stay whole — bullets don't dismember torsos. Only the hit
// part detaches (head pops, limb tears), rest flings along shot dir.
// Full dismemberment is explosives-only (HE/C4). Counts kept low on purpose.
const gibs = []; // {mesh, vel, ang, life, restY, bounced, bloodAt, helmet, flesh}
let _gibMats = null;
export function gibMats() {
  if (_gibMats) return _gibMats;
  _gibMats = {
    flesh: new THREE.MeshStandardMaterial({ color: 0x8a1214, roughness: 0.55 }),
    fleshD: new THREE.MeshStandardMaterial({ color: 0x5d0b0d, roughness: 0.7 }),
    bone: new THREE.MeshStandardMaterial({ color: 0xe8ddc4, roughness: 0.6 }),
    brain: new THREE.MeshStandardMaterial({ color: 0xd98a94, roughness: 0.45 }),
    helmetCT: new THREE.MeshStandardMaterial({ color: 0x1d2f45, roughness: 0.75 }),
    helmetT: new THREE.MeshStandardMaterial({ color: 0x6b5a35, roughness: 0.75 }),
    clothCT: new THREE.MeshStandardMaterial({ color: 0x2e4a6e, roughness: 0.95 }),
    clothT: new THREE.MeshStandardMaterial({ color: 0x8a6f42, roughness: 0.95 }),
  };
  return _gibMats;
}
export function clearGibs() {
  for (const gib of gibs) {
    try { scene.remove(gib.mesh); } catch (e) {}
    try { gib.mesh.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); } catch (e) {
      try { if (gib.mesh.geometry) gib.mesh.geometry.dispose(); } catch (e2) {}
    }
    // materials are shared via gibMats() — do not dispose
  }
  gibs.length = 0;
  // hide neck stumps parented to corpses (reused next round via userData.stump)
  try {
    for (const b of bots) {
      if (b.mesh && b.mesh.userData && b.mesh.userData.stump) {
        try { b.mesh.userData.stump.visible = false; } catch (e) {}
      }
    }
    for (const [, e] of remotes) {
      if (e.mesh && e.mesh.userData && e.mesh.userData.stump) {
        try { e.mesh.userData.stump.visible = false; } catch (err) {}
      }
    }
  } catch (e) {}
}
function capGibs() {
  const cap = Math.min(300, goreCap(opts.quality ? 46 : 20));
  while (gibs.length > cap) {
    const old = gibs.shift();
    try { scene.remove(old.mesh); } catch (e) {}
    try { old.mesh.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); } catch (e) {
      try { if (old.mesh.geometry) old.mesh.geometry.dispose(); } catch (e2) {}
    }
  }
}
export function spawnGibMesh(mesh, pos, vel, go = {}) {
  mesh.position.copy(pos);
  try { mesh.traverse((o) => { if (o.isMesh) o.castShadow = true; }); } catch (e) { mesh.castShadow = true; }
  scene.add(mesh);
  // rigid body state: point mass with radius, restitution + surface friction.
  // Wall/ground contacts resolve in updateGibs via gibCollide.
  gibs.push({
    mesh,
    vel: vel.clone(),
    ang: go.ang ? go.ang.clone() : new THREE.Vector3(rand(-11, 11), rand(-11, 11), rand(-11, 11)),
    life: 30, // persist to round end; startRound clears
    restY: go.restY !== undefined ? go.restY : 0.09,
    radius: go.radius !== undefined ? go.radius : 0.14,
    rest: go.rest !== undefined ? go.rest : 0.35, // bounciness 0..1
    fric: go.fric !== undefined ? go.fric : 0.7, // surface friction on contact
    bounced: 0,
    bloodAt: 0,
    flesh: !!go.flesh,
    helmet: !!go.helmet,
    silent: !!go.silent,
  });
  capGibs();
  return mesh;
}
// Rigid-body contact: push a sphere (p, radius) out of world AABBs.
// Reflects velocity on the hit axis with restitution, kills the rest with
// friction. Returns true on contact. ponytail: AABB-only, no stacking.
export function gibCollide(p, vel, radius, rest, fric) {
  let hit = false;
  for (const b of colliders) {
    const cx = clamp(p.x, b.min.x, b.max.x);
    const cy = clamp(p.y, b.min.y, b.max.y);
    const cz = clamp(p.z, b.min.z, b.max.z);
    const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= radius * radius) continue;
    hit = true;
    const d = Math.sqrt(d2);
    if (d > 1e-5) {
      const nx = dx / d, ny = dy / d, nz = dz / d;
      p.x = cx + nx * radius; p.y = cy + ny * radius; p.z = cz + nz * radius;
      const vn = vel.x * nx + vel.y * ny + vel.z * nz;
      if (vn < 0) {
        vel.x -= (1 + rest) * vn * nx;
        vel.y -= (1 + rest) * vn * ny;
        vel.z -= (1 + rest) * vn * nz;
        vel.x *= (1 - fric * 0.4); vel.z *= (1 - fric * 0.4); vel.y *= (1 - fric * 0.2);
      }
    } else {
      // center inside box: pop out along smallest penetration axis
      const px = Math.min(p.x - b.min.x, b.max.x - p.x);
      const py = Math.min(p.y - b.min.y, b.max.y - p.y);
      const pz = Math.min(p.z - b.min.z, b.max.z - p.z);
      if (px <= py && px <= pz) { p.x = (p.x - b.min.x < b.max.x - p.x) ? b.min.x - radius : b.max.x + radius; vel.x *= -rest; }
      else if (py <= px && py <= pz) { p.y = (p.y - b.min.y < b.max.y - p.y) ? b.min.y - radius : b.max.y + radius; vel.y *= -rest; }
      else { p.z = (p.z - b.min.z < b.max.z - p.z) ? b.min.z - radius : b.max.z + radius; vel.z *= -rest; }
      vel.x *= (1 - fric * 0.3); vel.z *= (1 - fric * 0.3);
    }
  }
  return hit;
}
// directional arterial spray: red particles + dark mist + ground spatter along shot dir
export function spawnBloodSpray(pos, dir, power = 1) {
  if (!SET.gore) return;
  try {
    const n = opts.quality ? Math.round(10 * power) + 6 : 6;
    spawnBurst(pos, 0xb00000, n, 4.5 * power, 0.5, 0.09);
    spawnBurst(pos, 0x7a0a0c, Math.max(3, n >> 1), 2.4 * power, 0.7, 0.12);
    const mist = pos.clone();
    if (dir) mist.addScaledVector(dir, 0.5);
    mist.y = Math.max(0.3, mist.y - 0.15);
    spawnSmoke(mist, 0.3 * power, 0.7, 0x8a1518);
    // fling a few physical blood-flesh droplets that arc and stain where they land
    const droplets = opts.quality ? Math.round(2 * power) : 1;
    for (let i = 0; i < droplets; i++) {
      const m = gibMats();
      const chunk = new THREE.Mesh(
        new THREE.BoxGeometry(rand(0.05, 0.1), rand(0.04, 0.08), rand(0.05, 0.1)),
        Math.random() < 0.5 ? m.flesh : m.fleshD
      );
      const v = new THREE.Vector3(rand(-1, 1), rand(0.4, 1.4), rand(-1, 1)).normalize()
        .multiplyScalar(rand(2, 4.5 * power));
      if (dir) v.addScaledVector(dir, rand(1, 3 * power));
      v.y += rand(1, 2.5 * power);
      spawnGibMesh(chunk, pos, v, { flesh: true, restY: 0.05 });
    }
  } catch (e) {}
}
// skull + brain + helmet explosion at head position. Hides headParts on the corpse,
// adds a bleeding neck stump, launches helmet as a clattering projectile.
export function explodeHead(mesh, headWorldPos, shotDir, power = 1, team = 't') {
  if (!SET.gore) return;
  try {
    const ud = mesh.userData || {};
    const parts = ud.headParts || (ud.head ? [ud.head] : []);
    for (const p of parts) { try { if (p) p.visible = false; } catch (e) {} }
    // neck stump so the corpse doesn't look hollow
    try {
      if (!ud.stump) {
        const stump = new THREE.Mesh(
          new THREE.CylinderGeometry(0.09, 0.11, 0.16, 8),
          new THREE.MeshStandardMaterial({ color: 0x6d0d0f, roughness: 0.6 })
        );
        const host = (ud.rig && ud.rig.neck) || mesh;
        stump.position.set(0, host === mesh ? 1.58 : 0.02, 0);
        host.add(stump);
        ud.stump = stump;
      } else {
        ud.stump.visible = true;
      }
    } catch (e) {}
    const M = gibMats();
    // red mist core + brain-matter burst + bone shards (kept small: head only)
    spawnBurst(headWorldPos, 0xc01418, opts.quality ? 12 : 6, 5 * power, 0.6, 0.11);
    spawnBurst(headWorldPos, 0xff6a6a, opts.quality ? 5 : 2, 3 * power, 0.5, 0.09);
    spawnSmoke(headWorldPos.clone().add(new THREE.Vector3(0, 0.15, 0)), 0.4 * power, 0.8, 0x7a0f12);
    // skull shards (pale) + brain blobs (pink) as tumbling physics
    const nBone = opts.quality ? 3 : 2, nBrain = opts.quality ? 3 : 2;
    for (let i = 0; i < nBone; i++) {
      const s = rand(0.04, 0.09);
      const shard = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.6, s * 0.8), M.bone);
      const v = new THREE.Vector3(rand(-1, 1), rand(0.5, 1.5), rand(-1, 1)).normalize().multiplyScalar(rand(2.5, 6 * power));
      if (shotDir) v.addScaledVector(shotDir, rand(1.5, 4 * power));
      v.y += rand(1.5, 3.5);
      spawnGibMesh(shard, headWorldPos, v, { flesh: true, restY: 0.04 });
    }
    for (let i = 0; i < nBrain; i++) {
      const s = rand(0.06, 0.12);
      const blob = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.8, s), M.brain);
      const v = new THREE.Vector3(rand(-1, 1), rand(0.2, 1.2), rand(-1, 1)).normalize().multiplyScalar(rand(2, 5 * power));
      if (shotDir) v.addScaledVector(shotDir, rand(1, 3 * power));
      v.y += rand(1, 3);
      spawnGibMesh(blob, headWorldPos, v, { flesh: true, restY: 0.05 });
    }
    // flesh slabs from the scalp/jaw
    for (let i = 0; i < (opts.quality ? 2 : 1); i++) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(rand(0.07, 0.13), rand(0.05, 0.09), rand(0.07, 0.12)), M.flesh);
      const v = new THREE.Vector3(rand(-1, 1), rand(0.4, 1.3), rand(-1, 1)).normalize().multiplyScalar(rand(2.5, 5.5 * power));
      if (shotDir) v.addScaledVector(shotDir, rand(1.5, 3.5 * power));
      v.y += rand(1.2, 3);
      spawnGibMesh(slab, headWorldPos, v, { flesh: true, restY: 0.06 });
    }
    // helmet launches separately — spins, bounces, clatters
    try {
      const helm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.18, 0.42), team === 'ct' ? M.helmetCT : M.helmetT);
      const hv = new THREE.Vector3(rand(-1, 1), 1, rand(-1, 1)).normalize().multiplyScalar(rand(3, 5.5 * power));
      if (shotDir) hv.addScaledVector(shotDir, rand(2, 4.5 * power));
      hv.y += rand(2.5, 4.5);
      spawnGibMesh(helm, headWorldPos.clone().add(new THREE.Vector3(0, 0.25, 0)), hv, { helmet: true, restY: 0.1 });
    } catch (e) {}
    // ground gore: big pool + spatter along shot dir
    try {
      spawnBloodPool(headWorldPos.x, headWorldPos.z, true);
      const d = shotDir ? shotDir.clone().setY(0).normalize() : new THREE.Vector3(1, 0, 0);
      for (let i = 0; i < 3; i++) {
        spawnDecal('blood',
          new THREE.Vector3(headWorldPos.x + d.x * (0.8 + i * 0.7) + rand(-0.4, 0.4), 0.06, headWorldPos.z + d.z * (0.8 + i * 0.7) + rand(-0.4, 0.4)),
          new THREE.Vector3(0, 1, 0), 0.9 + Math.random() * 0.7, 0.6);
      }
    } catch (e) {}
    try { AudioSys.headpop(headWorldPos); } catch (e) {}
  } catch (e) {}
}
// Hide the struck limb on the corpse and return its joint group (null = torso
// chunk, nothing to hide). A flesh stump cap covers the socket.
function detachLimb(mesh, part) {
  try {
    const ud = mesh && mesh.userData, rg = ud && ud.rig;
    if (!rg) return null;
    let joint = null;
    if (part === 'leg') joint = Math.random() < 0.5 ? rg.hipL : rg.hipR;
    else if (part === 'arm') joint = Math.random() < 0.5 ? rg.shoulderL : rg.shoulderR;
    if (!joint) return null;
    joint.visible = false;
    try {
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.1, 0.14),
        new THREE.MeshStandardMaterial({ color: 0x6d0d0f, roughness: 0.6 })
      );
      cap.position.copy(joint.position);
      (joint.parent || mesh).add(cap);
      (ud.stumps || (ud.stumps = [])).push(cap);
    } catch (e) {}
    return joint;
  } catch (e) { return null; }
}
// Build an anatomical detached part: leg (thigh+shin+boot), arm
// (sleeve+forearm+glove), or torso meat chunk. Cloth matches the team.
function buildDetachedPart(part, team) {
  const M = gibMats();
  const g = new THREE.Group();
  const cloth = team === 'ct' ? M.clothCT : M.clothT;
  const skin = new THREE.MeshStandardMaterial({ color: 0xc9986b, roughness: 0.65 });
  const bootM = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.9 });
  const gloveM = new THREE.MeshStandardMaterial({ color: 0x2b2b26, roughness: 0.95 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  if (part === 'leg') {
    add(new THREE.BoxGeometry(0.22, 0.4, 0.24), cloth, 0, -0.2, 0);
    add(new THREE.BoxGeometry(0.2, 0.32, 0.22), cloth, 0, -0.56, 0);
    add(new THREE.BoxGeometry(0.24, 0.14, 0.34), bootM, 0, -0.79, 0.05);
    add(new THREE.BoxGeometry(0.2, 0.08, 0.2), M.flesh, 0, 0.03, 0); // stump
  } else if (part === 'arm') {
    add(new THREE.BoxGeometry(0.17, 0.36, 0.19), cloth, 0, -0.18, 0);
    add(new THREE.BoxGeometry(0.15, 0.28, 0.16), skin, 0, -0.5, 0);
    add(new THREE.BoxGeometry(0.15, 0.12, 0.16), gloveM, 0, -0.7, 0);
    add(new THREE.BoxGeometry(0.15, 0.07, 0.15), M.flesh, 0, 0.03, 0);
  } else {
    add(new THREE.BoxGeometry(rand(0.1, 0.15), rand(0.12, 0.2), rand(0.1, 0.14)),
      Math.random() < 0.5 ? cloth : M.flesh, 0, 0, 0);
  }
  return g;
}
// tear off ONLY the hit part (torso chunk or limb). One chunk, flung along
// shot dir — the rest of the body stays whole and falls via ragdoll.
export function tearLimbGib(mesh, pos, shotDir, team, big = false, part = null) {
  if (!pos) return;
  if (!SET.gore) return;
  try {
    let hitPart = part || 'torso';
    if (hitPart === 'torso' && Math.random() < 0.4) hitPart = 'arm'; // upper-body hits take the arm
    const y = hitPart === 'leg' ? rand(0.3, 0.6) : hitPart === 'arm' ? rand(1.0, 1.35) : rand(0.7, 1.3);
    const origin = new THREE.Vector3(pos.x + rand(-0.15, 0.15), y + (pos.y || 0), pos.z + rand(-0.15, 0.15));
    if (mesh) detachLimb(mesh, hitPart === 'torso' ? null : hitPart);
    const chunk = buildDetachedPart(hitPart, team);
    const v = new THREE.Vector3(rand(-0.6, 0.6), rand(0.6, 1.2), rand(-0.6, 0.6)).normalize().multiplyScalar(rand(2.5, big ? 7 : 5));
    if (shotDir) v.addScaledVector(shotDir, rand(2, 5));
    v.y += rand(1.5, big ? 4 : 3);
    const radius = hitPart === 'torso' ? 0.12 : 0.3;
    spawnGibMesh(chunk, origin, v, { flesh: true, restY: hitPart === 'torso' ? 0.08 : 0.14, radius, rest: 0.3, fric: 0.75 });
    spawnBloodSpray(origin, shotDir, big ? 1.4 : 1.0);
    try { AudioSys.gib(origin, big); } catch (e) {}
  } catch (e) {}
}
// Diagonal bisection (MACHETE): the body comes apart shoulder-to-opposite-hip
// into two big halves that tumble away from the cut. The corpse mesh is gone —
// halves + mess are physical gibs, so no ragdoll runs afterwards.
export function bisectDiagonal(mesh, pos, shotDir, team) {
  if (!pos) return;
  try {
    const M = gibMats();
    const cloth = team === 'ct' ? M.clothCT : M.clothT;
    const dir = shotDir ? shotDir.clone().setY(0) : new THREE.Vector3(1, 0, 0);
    if (dir.lengthSq() < 0.01) dir.set(1, 0, 0);
    dir.normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x); // across the cut
    const oy = pos.y || 0;
    // upper half (shoulder side) flies up + along the swing, lower half drops + back
    const upper = new THREE.Group();
    {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.30), cloth);
      m.position.y = 0.28; upper.add(m);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), M.bone);
      head.position.y = 0.68; upper.add(head);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.5, 0.16), cloth);
      arm.position.set(0.28, 0.25, 0); upper.add(arm);
      const cut = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.08, 0.32), M.flesh);
      cut.position.y = -0.02; cut.rotation.z = 0.6; upper.add(cut);
    }
    const lower = new THREE.Group();
    {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.6, 0.28), cloth);
      m.position.y = -0.3; lower.add(m);
      for (const sx of [-0.12, 0.12]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.55, 0.19), cloth);
        leg.position.set(sx, -0.85, 0); lower.add(leg);
      }
      const cut = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.08, 0.30), M.flesh);
      cut.position.y = 0.02; cut.rotation.z = 0.6; lower.add(cut);
    }
    const uv = dir.clone().multiplyScalar(rand(1.5, 3)).addScaledVector(side, rand(0.5, 1.5)); uv.y = rand(2.5, 4.5);
    const lv = dir.clone().multiplyScalar(rand(-2.5, -1)).addScaledVector(side, rand(-1.5, -0.5)); lv.y = rand(0.5, 1.5);
    spawnGibMesh(upper, new THREE.Vector3(pos.x, oy + 1.2, pos.z), uv, { flesh: true, restY: 0.25, radius: 0.35, rest: 0.3, fric: 0.75 });
    spawnGibMesh(lower, new THREE.Vector3(pos.x, oy + 0.6, pos.z), lv, { flesh: true, restY: 0.3, radius: 0.35, rest: 0.25, fric: 0.8 });
    const mid = new THREE.Vector3(pos.x, oy + 1.0, pos.z);
    spawnBloodSpray(mid, dir, 2.2);
    spawnBurst(mid, 0xa00d10, opts.quality ? 22 : 10, 7, 0.8, 0.14);
    try { bloodPoolBig(pos); } catch {}
    try { AudioSys.gib(mid, true); } catch (e) {}
    try { AudioSys.headpop(mid); } catch (e) {}
    try { if (mesh) mesh.visible = false; } catch (e) {}
  } catch (e) {}
}
function bloodPoolBig(pos) {
  spawnBloodPool(pos.x, pos.z, true);
  for (let i = 0; i < 3; i++) spawnBloodPool(pos.x + rand(-1.2, 1.2), pos.z + rand(-1.2, 1.2), Math.random() < 0.6);
}
export function restoreSoldierMesh(mesh) {
  try {
    const ud = mesh.userData || {};
    const parts = ud.headParts || [];
    for (const p of parts) { try { if (p) p.visible = true; } catch (e) {} }
    if (ud.head) { try { ud.head.rotation.set(0, 0, 0); } catch (e) {} }
    const rg = ud.rig;
    if (rg) {
      try {
        for (const j of [rg.pelvis, rg.spine, rg.chest, rg.neck, rg.hipL, rg.kneeL, rg.ankleL,
                         rg.hipR, rg.kneeR, rg.ankleR, rg.shoulderL, rg.shoulderR, rg.elbowL, rg.elbowR, rg.gun]) {
          if (!j) continue;
          j.rotation.set(0, 0, 0);
          j.visible = true; // re-attach limbs hidden by detachLimb
        }
        rg.pelvis.position.set(0, rg.hipY, 0);
        rg.shoulderL.rotation.set(-0.55, 0, 0); rg.elbowL.rotation.set(-0.85, 0, 0);
        rg.shoulderR.rotation.set(-0.55, 0, 0); rg.elbowR.rotation.set(-0.85, 0, 0);
        if (rg.gun && rg.gun.userData.baseY !== undefined) {
          rg.gun.position.y = rg.gun.userData.baseY; rg.gun.position.z = rg.gun.userData.baseZ;
        }
      } catch (e) {}
    }
    ud.anim = null; ud.rag = null; // fresh gait clock on respawn, drop the ragdoll
    if (ud.torso) { try { ud.torso.rotation.set(0, 0, 0); } catch (e) {} }
    if (ud.legL) { try { ud.legL.rotation.set(0, 0, 0); ud.legL.visible = true; } catch (e) {} }
    if (ud.legR) { try { ud.legR.rotation.set(0, 0, 0); ud.legR.visible = true; } catch (e) {} }
    if (ud.armL) { try { ud.armL.rotation.set(-0.55, 0, 0); ud.armL.visible = true; } catch (e) {} }
    if (ud.armR) { try { ud.armR.rotation.set(-0.55, 0, 0); ud.armR.visible = true; } catch (e) {} }
    if (ud.gunG) { try { ud.gunG.visible = true; } catch (e) {} }
    if (ud.stump) { try { ud.stump.visible = false; } catch (e) {} }
    try {
      for (const s of (ud.stumps || [])) { try { s.visible = false; s.parent && s.parent.remove(s); } catch (e) {} }
      ud.stumps = [];
    } catch (e) {}
    mesh.rotation.set(0, mesh.rotation.y || 0, 0);
  } catch (e) {}
}
// rigid-body gibs: gravity + air drag, wall contacts, ground bounce with
// friction, then rest + bleed-out stain. ponytail: single sphere per gib,
// no stacking/constraints — helmet clatter + flesh thud only.
export function updateGibs(dt) {
  for (let i = 0; i < gibs.length; i++) {
    const gib = gibs[i];
    try {
      gib.vel.y -= 20 * dt;
      gib.vel.multiplyScalar(Math.max(0, 1 - 0.12 * dt)); // air drag
      gib.mesh.position.addScaledVector(gib.vel, dt);
      gib.mesh.rotation.x += gib.ang.x * dt;
      gib.mesh.rotation.y += gib.ang.y * dt;
      gib.mesh.rotation.z += gib.ang.z * dt;
      const p = gib.mesh.position;
      const wallHit = gibCollide(p, gib.vel, gib.radius || 0.14, gib.helmet ? 0.45 : (gib.rest ?? 0.35), gib.fric ?? 0.7);
      if (wallHit) {
        gib.ang.multiplyScalar(0.6);
        gib.bounced++;
        if (gib.flesh && gib.vel.lengthSq() > 4 && Math.random() < 0.4) {
          try { spawnDecal('blood', p.clone(), new THREE.Vector3(0, 1, 0), 0.4 + Math.random() * 0.4, 0.5); } catch (e) {}
        }
      }
      if (p.y < gib.restY) {
        p.y = gib.restY;
        if (Math.abs(gib.vel.y) > 1.6 && gib.bounced < 5) {
          gib.bounced++;
          gib.vel.y *= gib.helmet ? -0.45 : -0.32;
          gib.vel.x *= (1 - gib.fric * 0.5); gib.vel.z *= (1 - gib.fric * 0.5);
          gib.ang.multiplyScalar(0.5);
          if (gib.helmet) { try { AudioSys.helmetHit(p); } catch (e) {} }
          else if (gib.flesh && Math.random() < 0.6) {
            try { spawnDecal('blood', new THREE.Vector3(p.x, 0.06, p.z), new THREE.Vector3(0, 1, 0), 0.5 + Math.random() * 0.5, 0.5); } catch (e) {}
          }
        } else {
          gib.vel.set(0, 0, 0);
          gib.ang.set(0, 0, 0);
          // bleed-out stain once when coming to rest
          if (gib.flesh && !gib._stained) {
            gib._stained = true;
            try { spawnDecal('blood', new THREE.Vector3(p.x, 0.06, p.z), new THREE.Vector3(0, 1, 0), 0.7 + Math.random() * 0.6, 0.55); } catch (e) {}
          }
        }
      } else if (gib.flesh && gib.mesh.position.y > 0.5) {
        // blood trail while airborne
        gib.bloodAt -= dt;
        if (gib.bloodAt <= 0) {
          gib.bloodAt = 0.07;
          try { spawnBurst(gib.mesh.position, 0x9a0d10, 1, 0.8, 0.4, 0.07); } catch (e) {}
        }
      }
    } catch (e) {}
  }
}

