// js/effects.js — AGENTS: Visual effect pools + per-frame updater: tracers, particles, decals, world flashes, fireballs, shockwaves, debris, shells, smoke puffs.
// Ownership: effect arrays (tracers/particles/corpses/decals...), spawn* helpers, updateEffects (called from loop).

import * as THREE from 'three';
import { AudioSys } from './audio.js';
import { isNadeKey } from './config.js';
import { SET, opts } from './settings.js';
import { clamp, rand } from './utils.js';
import { _tmpBox } from './collision.js';
import { updateGibs } from './gibs.js';
import { goreCap, updateDeadBots } from './gore.js';
import { birdsArr, colliders, lampLightsArr, palmFronds, tumbleVel, tumbleweed } from './map.js';
import { muzzleLight, scene } from './render.js';
import { player } from './state.js';
import { vmBase, vmBolt, vmFlashGroup, vmKickG, vmL, vmRig } from './viewmodel.js';

// effects pools
export const tracers = [], particles = [], corpses = [], shells = [], smokes = [];
export const decals = [], shockwaves = [], debrisChunks = [], worldFlashes = [];
let _holeTex = null, _bloodTex = null, _scorchTex = null, _glowTex = null, _blobTex = null;

export function decalTextures() {
  if (!_holeTex) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 64, 64);
    // dark punched core + cracked rim + dust halo
    const halo = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    halo.addColorStop(0, 'rgba(8,6,4,1)'); halo.addColorStop(0.28, 'rgba(15,12,8,0.95)');
    halo.addColorStop(0.42, 'rgba(60,50,35,0.55)'); halo.addColorStop(1, 'rgba(60,50,35,0)');
    g.fillStyle = halo; g.fillRect(0, 0, 64, 64);
    g.strokeStyle = 'rgba(20,14,8,0.9)'; g.lineWidth = 1.5;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + Math.random() * 0.5;
      g.beginPath(); g.moveTo(32 + Math.cos(a) * 6, 32 + Math.sin(a) * 6);
      g.lineTo(32 + Math.cos(a) * (13 + Math.random() * 9), 32 + Math.sin(a) * (13 + Math.random() * 9));
      g.stroke();
    }
    g.fillStyle = 'rgba(0,0,0,1)'; g.beginPath(); g.arc(32, 32, 4.5, 0, 7); g.fill();
    _holeTex = new THREE.CanvasTexture(c);
  }
  if (!_bloodTex) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    // ragged blob: a wobbly polygon reads as spilled liquid, a circle reads as a dot
    const lobe = (cx, cy, r, alpha) => {
      g.fillStyle = `rgba(${94 + Math.random() * 48 | 0},${5 + Math.random() * 9 | 0},${7 + Math.random() * 9 | 0},${alpha})`;
      g.beginPath();
      for (let i = 0, n = 14; i <= n; i++) {
        const th = (i / n) * Math.PI * 2, rr = r * (0.6 + Math.random() * 0.65);
        const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill();
    };
    lobe(64, 60, 40, 0.95); lobe(56, 68, 31, 0.9); lobe(73, 55, 27, 0.85);
    // runs, so a wall splat drips (spawnDecal keeps vertical surfaces upright)
    for (let i = 0; i < 8; i++) {
      const x = 30 + Math.random() * 66, w = 2 + Math.random() * 6, len = 12 + Math.random() * 46;
      g.fillStyle = `rgba(${88 + Math.random() * 42 | 0},6,8,${0.5 + Math.random() * 0.4})`;
      g.fillRect(x, 66, w, len);
      g.beginPath(); g.arc(x + w / 2, 66 + len, w * 0.8, 0, 7); g.fill();
    }
    // satellite droplets thrown clear of the main mass
    for (let i = 0; i < 44; i++) {
      const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 32;
      lobe(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 2 + Math.random() * 7, 0.5 + Math.random() * 0.45);
    }
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      g.strokeStyle = 'rgba(120,9,11,0.6)'; g.lineWidth = 1 + Math.random() * 2.6;
      g.beginPath(); g.moveTo(64, 64);
      g.lineTo(64 + Math.cos(a) * (40 + Math.random() * 24), 64 + Math.sin(a) * (40 + Math.random() * 24));
      g.stroke();
    }
    _bloodTex = new THREE.CanvasTexture(c);
  }
  if (!_scorchTex) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    const rg = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    rg.addColorStop(0, 'rgba(5,4,3,0.95)'); rg.addColorStop(0.45, 'rgba(12,9,6,0.75)');
    rg.addColorStop(0.75, 'rgba(30,22,14,0.35)'); rg.addColorStop(1, 'rgba(30,22,14,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 60; i++) {
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.beginPath(); g.arc(Math.random() * 128, Math.random() * 128, 1 + Math.random() * 2.5, 0, 7); g.fill();
    }
    _scorchTex = new THREE.CanvasTexture(c);
  }
  if (!_glowTex) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const rg = g.createRadialGradient(32, 32, 1, 32, 32, 31);
    rg.addColorStop(0, 'rgba(255,255,240,1)'); rg.addColorStop(0.25, 'rgba(255,220,150,0.9)');
    rg.addColorStop(0.6, 'rgba(255,150,60,0.35)'); rg.addColorStop(1, 'rgba(255,120,20,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    _glowTex = new THREE.CanvasTexture(c);
  }
  if (!_blobTex) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const rg = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    rg.addColorStop(0, 'rgba(0,0,0,0.42)'); rg.addColorStop(0.7, 'rgba(0,0,0,0.22)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    _blobTex = new THREE.CanvasTexture(c);
  }
  return { hole: _holeTex, blood: _bloodTex, scorch: _scorchTex, glow: _glowTex, blob: _blobTex };
}

// Persistent battle-damage decals. Capped + recycled; cleared each round.
const _decalMats = new Map();
function decalMaterial(kind, tex, opacity) {
  const o = clamp(Math.round(opacity * 5) / 5, 0.2, 1);
  const key = kind + '|' + o;
  let m = _decalMats.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, opacity: o,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    _decalMats.set(key, m);
  }
  return m;
}
export function spawnDecal(kind, pos, normal, size = 0.3, opacity = 1) {
  try {
    const T = decalTextures();
    const tex = kind === 'blood' ? T.blood : kind === 'scorch' ? T.scorch : T.hole;
    const mat = decalMaterial(kind, tex, kind === 'scorch' ? 0.95 * opacity : opacity);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    m.position.copy(pos).addScaledVector(normal, 0.02 + Math.random() * 0.012);
    // orient plane to surface: plane +z faces along normal
    m.lookAt(pos.clone().add(normal));
    // on a wall, keep the texture upright so its runs point down; on the floor the
    // orientation is arbitrary, so spin it to hide the repeated texture
    const upright = kind === 'blood' && Math.abs(normal.y) < 0.55;
    m.rotation.z = upright ? rand(-0.35, 0.35) : Math.random() * Math.PI * 2;
    m.renderOrder = 2;
    scene.add(m);
    decals.push({ mesh: m, kind });
    // recycle oldest: bullet holes cap high (combat memory), blood/scorch lower
    const cap = kind === 'hole' ? 90 : kind === 'blood' ? goreCap(45) : 12;
    let count = 0;
    for (const d of decals) if (d.kind === kind) count++;
    if (count > cap) {
      const idx = decals.findIndex((d) => d.kind === kind);
      if (idx >= 0) { const old = decals.splice(idx, 1)[0]; scene.remove(old.mesh); old.mesh.geometry.dispose(); } // material is shared
    }
  } catch (e) {}
}
export function spawnBloodPool(x, z, big = false) {
  if (!SET.gore) return;
  try {
    const T = decalTextures();
    const s = (big ? 2.2 : 1.4) * (0.85 + Math.random() * 0.4);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s * (0.8 + Math.random() * 0.4)),
      decalMaterial('blood', T.blood, 0.92));
    m.rotation.x = -Math.PI / 2; m.rotation.z = Math.random() * Math.PI * 2;
    m.position.set(x + rand(-0.2, 0.2), 0.028, z + rand(-0.2, 0.2));
    m.renderOrder = 2;
    scene.add(m);
    decals.push({ mesh: m, kind: 'blood' });
    if (decals.filter((d) => d.kind === 'blood').length > goreCap(45)) {
      const idx = decals.findIndex((d) => d.kind === 'blood');
      const old = decals.splice(idx, 1)[0]; scene.remove(old.mesh); old.mesh.geometry.dispose();
    }
  } catch (e) {}
}
export function clearDecals() {
  // materials are shared via decalMaterial() — geometry only
  for (const d of decals) { try { scene.remove(d.mesh); d.mesh.geometry.dispose(); } catch (e) {} }
  decals.length = 0;
}

export function spawnTracer(a, b, color, wide = 1) {
  const len = a.distanceTo(b);
  if (len < 0.5) return;
  if (!opts.quality && tracers.length > 6) return;
  if (tracers.length > 28) {
    const old = tracers.shift();
    try { scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose(); } catch (e) {}
  }
  // volumetric-feel beam: thin additive cylinder + hot core line + glow head
  const g = new THREE.Group();
  const dir = b.clone().sub(a);
  const mid = a.clone().addScaledVector(dir, 0.5);
  const beamLen = Math.min(len, 26);
  const rad = (0.012 + Math.min(0.02, len * 0.0006)) * wide;
  const beamGeo = new THREE.CylinderGeometry(rad, rad * 1.6, beamLen, 5, 1, true);
  const beamMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  // cylinder Y-axis -> align to shot dir, anchor beam start at muzzle
  const start = a.clone();
  const beamMid = start.clone().addScaledVector(dir.clone().normalize(), beamLen * 0.5);
  beam.position.copy(beamMid);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize().negate());
  beam.frustumCulled = false;
  g.add(beam);
  // hot white-hot core (short, near muzzle — reads as powder burn)
  const coreLen = Math.min(3.2, beamLen * 0.4);
  const coreGeo = new THREE.CylinderGeometry(rad * 0.55, rad * 0.8, coreLen, 5, 1, true);
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff6e0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.copy(start.clone().addScaledVector(dir.clone().normalize(), coreLen * 0.5));
  core.quaternion.copy(beam.quaternion);
  core.frustumCulled = false;
  g.add(core);
  // impact glow head so distant hits read
  let head = null;
  try {
    const T = decalTextures();
    head = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    head.position.copy(b);
    head.scale.setScalar(0.55 * wide);
    g.add(head);
  } catch (e) {}
  g.frustumCulled = false;
  scene.add(g);
  const life = wide > 1 ? 0.35 : 0.09;
  tracers.push({ mesh: g, beam, core, head, life, max: life });
}

// world-space muzzle flash for bots / remotes / planted-bomb glow pulses
export function spawnWorldFlash(pos, color = 0xffc36b, scale = 0.9) {
  try {
    if (!opts.quality && worldFlashes.length > 8) return;
    if (worldFlashes.length > 16) {
      const old = worldFlashes.shift();
      try { scene.remove(old.mesh); old.mesh.material.dispose(); } catch (e) {}
    }
    const T = decalTextures();
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.copy(pos);
    m.scale.setScalar(scale * (0.9 + Math.random() * 0.3));
    m.material.rotation = Math.random() * Math.PI * 2;
    scene.add(m);
    worldFlashes.push({ mesh: m, life: 0.07, max: 0.07 });
    // brief smoke wisp so sustained fire leaves a haze
    if (Math.random() < 0.6) spawnSmoke(pos, 0.28, 0.8, 0xcfc4ae);
  } catch (e) {}
}
export function spawnFireball(p, scale = 2.2, life = 0.45) {
  try {
    const T = decalTextures();
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xffb060, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.copy(p);
    m.scale.setScalar(scale * 0.5);
    scene.add(m);
    worldFlashes.push({ mesh: m, life, max: life, grow: scale * 3.2, fire: true });
  } catch (e) {}
}
export function spawnShockwave(p, maxR = 9, life = 0.5, color = 0xffe0b0) {
  try {
    if (!opts.quality) return;
    if (shockwaves.length > 6) {
      const old = shockwaves.shift();
      try { scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose(); } catch (e) {}
    }
    const geo = new THREE.RingGeometry(0.85, 1.0, 40);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(p.x, Math.max(0.12, p.y - 0.55), p.z);
    scene.add(m);
    shockwaves.push({ mesh: m, life, max: life, maxR });
  } catch (e) {}
}
export function spawnDebris(p, n = 10, spread = 8, up = 7) {
  try {
    const cap = opts.quality ? 26 : 10;
    if (debrisChunks.length > cap) return;
    const geo = spawnDebris.geo || (spawnDebris.geo = new THREE.BoxGeometry(0.09, 0.09, 0.09));
    for (let i = 0; i < n; i++) {
      const tint = [0x6b5a40, 0x4a4238, 0x2e2a24, 0x8a764e][(Math.random() * 4) | 0];
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: tint, roughness: 1 }));
      m.position.set(p.x + rand(-0.3, 0.3), p.y + rand(-0.2, 0.4), p.z + rand(-0.3, 0.3));
      m.castShadow = true;
      scene.add(m);
      debrisChunks.push({
        mesh: m,
        vel: new THREE.Vector3(rand(-spread, spread), rand(up * 0.4, up), rand(-spread, spread)),
        ang: new THREE.Vector3(rand(-12, 12), rand(-12, 12), rand(-12, 12)),
        life: rand(0.9, 1.7),
      });
    }
  } catch (e) {}
}
export function spawnBurst(p, color, n = 10, speed = 5, life = 0.5, size = 0.09) {
  if (!opts.quality) n = Math.min(n, 5);
  if (particles.length > 260) return; // safety valve for multi-kill gore storms
  n = Math.min(n, 220);
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), vel = [];
  for (let i = 0; i < n; i++) {
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    vel.push(new THREE.Vector3(rand(-1, 1), rand(-0.2, 1.2), rand(-1, 1)).normalize().multiplyScalar(rand(speed * 0.4, speed)));
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 1, depthWrite: false });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  particles.push({ mesh: pts, vel, life, maxLife: life });
}
let _smokeTex = null;
function smokeTexture() {
  if (_smokeTex) return _smokeTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(200,200,200,0.55)');
  grad.addColorStop(0.6, 'rgba(160,160,160,0.28)');
  grad.addColorStop(1, 'rgba(140,140,140,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  _smokeTex = new THREE.CanvasTexture(c);
  return _smokeTex;
}
export function spawnSmoke(p, scale = 0.35, life = 0.7, tint = 0xbbbbbb) {
  if (!opts.quality) return;
  const mat = new THREE.SpriteMaterial({ map: smokeTexture(), color: tint, transparent: true, opacity: 0.5, depthWrite: false });
  const s = new THREE.Sprite(mat);
  s.position.copy(p);
  s.scale.setScalar(scale * rand(0.8, 1.2));
  scene.add(s);
  smokes.push({ mesh: s, vel: new THREE.Vector3(rand(-0.3, 0.3), rand(0.8, 1.6), rand(-0.3, 0.3)), life, maxLife: life, grow: scale * 1.6 });
}
export function spawnShell(worldPos, right, up, fwd) {
  if (!opts.quality && shells.length > 12) return;
  if (shells.length > 24) return;
  const geo = spawnShell.geo || (spawnShell.geo = new THREE.BoxGeometry(0.014, 0.014, 0.03));
  const mat = spawnShell.mat || (spawnShell.mat = new THREE.MeshBasicMaterial({ color: 0xd8a833 }));
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(worldPos);
  const vel = new THREE.Vector3()
    .addScaledVector(right, rand(1.2, 2.2))
    .addScaledVector(up, rand(1.4, 2.2))
    .addScaledVector(fwd, rand(-0.6, 0.2));
  const angVel = new THREE.Vector3(rand(-18, 18), rand(-18, 18), rand(-18, 18));
  scene.add(m);
  shells.push({ mesh: m, vel, angVel, life: 1.1 });
}
export function updateEffects(dt, t = 0) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i]; tr.life -= dt;
    const k = Math.max(0, tr.life / tr.max);
    try {
      if (tr.beam) tr.beam.material.opacity = 0.75 * k;
      if (tr.core) tr.core.material.opacity = 0.95 * k;
      if (tr.head) { tr.head.material.opacity = 0.9 * k; tr.head.scale.setScalar(Math.max(0.001, tr.head.scale.x - dt * 4)); }
    } catch (e) {}
    if (tr.life <= 0) {
      try {
        scene.remove(tr.mesh);
        // NOTE: sprite geometry is shared in three — only dispose materials for sprites
        tr.mesh.traverse((o) => {
          try { if (o.isMesh) o.geometry.dispose(); } catch (e) {}
          try { if (o.isMesh || o.isSprite) o.material.dispose(); } catch (e) {}
        });
      } catch (e) { try { scene.remove(tr.mesh); } catch (e2) {} }
      tracers.splice(i, 1);
    }
  }
  for (let i = worldFlashes.length - 1; i >= 0; i--) {
    const f = worldFlashes[i]; f.life -= dt;
    const k = Math.max(0, f.life / f.max);
    try {
      f.mesh.material.opacity = f.fire ? Math.min(1, k * 1.6) : k;
      if (f.grow) f.mesh.scale.setScalar(f.mesh.scale.x + f.grow * dt);
      else f.mesh.scale.setScalar(Math.max(0.001, f.mesh.scale.x - dt * 6));
      f.mesh.material.rotation += dt * 6;
    } catch (e) {}
    if (f.life <= 0) { try { scene.remove(f.mesh); f.mesh.material.dispose(); } catch (e) {} worldFlashes.splice(i, 1); }
  }
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const s = shockwaves[i]; s.life -= dt;
    const k = 1 - Math.max(0, s.life) / s.max;
    try {
      const r = 0.5 + k * s.maxR;
      s.mesh.scale.set(r, r, 1);
      s.mesh.material.opacity = 0.85 * (1 - k);
    } catch (e) {}
    if (s.life <= 0) { try { scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh.material.dispose(); } catch (e) {} shockwaves.splice(i, 1); }
  }
  for (let i = debrisChunks.length - 1; i >= 0; i--) {
    const d = debrisChunks[i]; d.life -= dt;
    try {
      d.vel.y -= 16 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.ang.x * dt; d.mesh.rotation.y += d.ang.y * dt; d.mesh.rotation.z += d.ang.z * dt;
      if (d.mesh.position.y < 0.05) {
        d.mesh.position.y = 0.05;
        d.vel.y *= -0.35; d.vel.x *= 0.6; d.vel.z *= 0.6; d.ang.multiplyScalar(0.55);
        if (Math.abs(d.vel.y) < 0.8) { d.vel.set(0, 0, 0); d.ang.set(0, 0, 0); }
      }
    } catch (e) {}
    if (d.life <= 0) { try { scene.remove(d.mesh); d.mesh.material.dispose(); } catch (e) {} debrisChunks.splice(i, 1); }
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life -= dt;
    const arr = p.mesh.geometry.attributes.position.array;
    for (let j = 0; j < p.vel.length; j++) {
      p.vel[j].y -= 12 * dt;
      arr[j * 3] += p.vel[j].x * dt; arr[j * 3 + 1] += p.vel[j].y * dt; arr[j * 3 + 2] += p.vel[j].z * dt;
      if (arr[j * 3 + 1] < 0.02) arr[j * 3 + 1] = 0.02;
    }
    p.mesh.geometry.attributes.position.needsUpdate = true;
    p.mesh.material.opacity = Math.max(0, p.life / p.maxLife);
    if (p.life <= 0) { scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); particles.splice(i, 1); }
  }
  for (let i = shells.length - 1; i >= 0; i--) {
    const s = shells[i]; s.life -= dt;
    s.vel.y -= 9.5 * dt;
    s.mesh.position.addScaledVector(s.vel, dt);
    s.mesh.rotation.x += s.angVel.x * dt; s.mesh.rotation.y += s.angVel.y * dt; s.mesh.rotation.z += s.angVel.z * dt;
    if (s.mesh.position.y < 0.02) {
      s.mesh.position.y = 0.02;
      if (s.vel.y < -1.4 && !s._tinked) { s._tinked = true; try { AudioSys.shellTick(s.mesh.position); } catch (e) {} }
      s.vel.y *= -0.4; s.vel.x *= 0.6; s.vel.z *= 0.6; s.angVel.multiplyScalar(0.5);
    }
    if (s.life <= 0) { scene.remove(s.mesh); shells.splice(i, 1); }
  }
  for (let i = smokes.length - 1; i >= 0; i--) {
    const s = smokes[i]; s.life -= dt;
    s.mesh.position.addScaledVector(s.vel, dt);
    const k = 1 - s.life / s.maxLife;
    s.mesh.scale.setScalar(s.mesh.scale.x + s.grow * dt);
    s.mesh.material.opacity = 0.5 * (s.life / s.maxLife);
    if (s.life <= 0) { scene.remove(s.mesh); s.mesh.material.dispose(); smokes.splice(i, 1); }
  }
  if (muzzleLight.intensity > 0) muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 90);
  // drifting dust motes (cheap wind advection, wraps in-bounds)
  try {
    if (!_dustCache) _dustCache = scene.getObjectByName('dustMotes');
    const dust = _dustCache;
    if (dust && dust.geometry) {
      const arr = dust.geometry.attributes.position.array;
      const wx = 0.35 * dt, wy = Math.sin(t * 0.7) * 0.06 * dt;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] += wx + Math.sin(t * 0.5 + i) * 0.12 * dt;
        arr[i + 1] += wy;
        arr[i + 2] += 0.12 * dt;
        if (arr[i] > 34) arr[i] = -34;
        if (arr[i + 2] > 30) arr[i + 2] = -30;
        if (arr[i + 1] < 0.2) arr[i + 1] = 6;
        if (arr[i + 1] > 6.5) arr[i + 1] = 0.4;
      }
      dust.geometry.attributes.position.needsUpdate = true;
      dust.material.opacity = 0.4 + Math.sin(t * 0.8) * 0.1;
    }
  } catch (e) {}
  // ---- ambient life: sky drift, palms, grass, lamps, birds, tumbleweed, dead ----
  try { if (scene.userData.skyMat) scene.userData.skyMat.uniforms.uTime.value = t; } catch (e) {}
  try {
    for (const f of palmFronds) f.mesh.rotation.x = f.baseRX + Math.sin(t * 1.1 + f.phase) * f.amp;
  } catch (e) {}
  try {
    const tufts = window.__grassTufts || [];
    for (const g of tufts) g.grp.rotation.z = Math.sin(t * 1.6 + g.phase) * 0.06;
  } catch (e) {}
  try {
    for (const pl of lampLightsArr) {
      const b = pl.userData.base || 6;
      pl.intensity = b * (0.93 + 0.05 * Math.sin(t * 13 + pl.userData.phase) + 0.02 * Math.sin(t * 47 + pl.userData.phase * 2));
    }
  } catch (e) {}
  try {
    for (const bd of birdsArr) {
      const a = t * bd.speed + bd.phase;
      bd.mesh.position.set(Math.cos(a) * bd.r, bd.h + Math.sin(t * 0.7 + bd.phase) * 1.2, Math.sin(a) * bd.r);
      const flap = 1 + Math.sin(t * 9 + bd.phase) * 0.25;
      bd.mesh.scale.set(2.2 * flap, 1.1 / flap, 1);
    }
  } catch (e) {}
  try {
    if (tumbleweed) {
      tumbleweed.position.addScaledVector(tumbleVel, dt);
      tumbleweed.rotation.z -= dt * 3.2; tumbleweed.rotation.x += dt * 1.1;
      tumbleweed.position.y = 0.45 + Math.abs(Math.sin(t * 2.2)) * 0.25;
      if (tumbleweed.position.x > 34) { tumbleweed.position.x = -34; tumbleweed.position.z = rand(-10, 10); }
      // bounce off walls: cheap reflect using colliders probe
      _tmpBox.min.set(tumbleweed.position.x - 0.4, 0, tumbleweed.position.z - 0.4);
      _tmpBox.max.set(tumbleweed.position.x + 0.4, 1, tumbleweed.position.z + 0.4);
      for (const b of colliders) {
        if (_tmpBox.intersectsBox(b)) {
          tumbleVel.z *= -1; tumbleweed.position.z += tumbleVel.z * dt * 2;
          break;
        }
      }
    }
  } catch (e) {}
  try { updateDeadBots(dt); } catch (e) {}
  try { updateGibs(dt); } catch (e) {}
  // ---- viewmodel springs (recoil feel) ----
  if (vmBase && vmKickG) {
    // kick spring: stiff spring back to 0
    const k = 180, d = 14;
    vmRig.kickV += (-k * vmRig.kickZ - d * vmRig.kickV) * dt;
    vmRig.kickZ += vmRig.kickV * dt;
    const kr = 160, dr = 13;
    vmRig.kickRotV += (-kr * vmRig.kickRot - dr * vmRig.kickRotV) * dt;
    vmRig.kickRot += vmRig.kickRotV * dt;
    vmKickG.position.z = vmRig.kickZ;
    vmKickG.position.y = vmRig.kickZ * 0.35;
    vmKickG.rotation.x = vmRig.kickRot;
    if (vmL) {
      vmRig.kickVL += (-k * vmRig.kickZL - d * vmRig.kickVL) * dt;
      vmRig.kickZL += vmRig.kickVL * dt;
      vmRig.kickRotVL += (-kr * vmRig.kickRotL - dr * vmRig.kickRotVL) * dt;
      vmRig.kickRotL += vmRig.kickRotVL * dt;
      vmL.kick.position.z = vmRig.kickZL;
      vmL.kick.position.y = vmRig.kickZL * 0.35;
      vmL.kick.rotation.x = vmRig.kickRotL;
      for (const f of vmL.flash.children) {
        f.material.opacity = Math.max(0, f.material.opacity - dt * 16);
        if (f.material.opacity > 0) f.rotation.z += dt * 20;
      }
    }
    if (vmRig.primeK > 0.001 && isNadeKey(player.cur)) {
      vmKickG.position.y += vmRig.primeK * 0.07;
      vmKickG.position.z += vmRig.primeK * 0.09;
      vmKickG.rotation.x -= vmRig.primeK * 0.45;
      vmKickG.rotation.z = vmRig.primeK * 0.25;
    } else vmKickG.rotation.z = 0;
    // flash decay + flicker scale
    if (vmFlashGroup) {
      for (const f of vmFlashGroup.children) {
        f.material.opacity = Math.max(0, f.material.opacity - dt * 16);
        if (f.material.opacity > 0) {
          const s = 1 + Math.sin(t * 90) * 0.08;
          f.scale.set(s, s, 1);
          f.rotation.z += dt * 20;
        }
      }
    }
    // AWP bolt cycle: pull back then forward shortly after shot
    if (vmBolt) {
      if (vmRig.boltT > 0) {
        vmRig.boltT -= dt;
        const bt = 1 - Math.max(0, vmRig.boltT) / 0.45; // 0..1
        const back = Math.sin(Math.min(1, bt) * Math.PI); // 0-1-0
        vmBolt.position.z = 0.09 * back;
        vmBolt.rotation.y = 0.5 * back;
      } else { const bk = Math.pow(0.8, dt * 60); vmBolt.position.z *= bk; vmBolt.rotation.y *= bk; }
    }
  }
}
let _dustCache = null;

