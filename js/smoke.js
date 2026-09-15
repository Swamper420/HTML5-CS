// js/smoke.js — AGENTS: Smoke grenade volumes: deploy, disperse (HE), density/LOS blocking, visuals update.
// Ownership: deploySmoke, smokeDensityAt, smokeBlocks, hasLOSClear, updateTacticalSmokes.

import * as THREE from 'three';
import { AudioSys } from './audio.js';
import { MAP_HALF, NADE_DEFS } from './config.js';
import { opts } from './settings.js';
import { $, clamp, rand } from './utils.js';
import { hasLOS } from './collision.js';
import { spawnBurst, spawnSmoke } from './effects.js';
import { fireZones, nadeOwnerTeam, tacticalSmokes } from './grenades.js';
import { isOnline } from './multiplayer.js';
import { camera, scene } from './render.js';
import { G } from './state.js';

// ---- Dynamic smoke: grows, drifts on wind, fades; blocks AI vision ----
export function deploySmoke(at, owner, t) {
  try { AudioSys.smokePop(at); } catch (e) {}
  const def = NADE_DEFS.smoke;
  const center = at.clone(); center.y = at.y + 1.1;
  // CS2: smoke extinguishes molotov fire it lands in
  try {
    for (let i = fireZones.length - 1; i >= 0; i--) {
      const z = fireZones[i];
      if (Math.hypot(z.pos.x - center.x, z.pos.z - center.z) < def.radius + z.radius * 0.6 && Math.abs(z.pos.y - at.y) < 2.5) {
        try { for (const fl of z.flames) scene.remove(fl); if (z.light) scene.remove(z.light); } catch (e) {}
        try { spawnSmoke(new THREE.Vector3(z.pos.x, z.pos.y + 0.6, z.pos.z), 1.2, 1.2, 0x9a9a9a); } catch (e) {}
        fireZones.splice(i, 1);
      }
    }
  } catch (e) {}
  // clamp inside map so wall-embedded pops still cover the choke
  center.x = clamp(center.x, -MAP_HALF + 1, MAP_HALF - 1);
  center.z = clamp(center.z, -MAP_HALF + 1, MAP_HALF - 1);
  if (tacticalSmokes.length >= 8) {
    const old = tacticalSmokes.shift();
    try { for (const pf of old.puffs) { scene.remove(pf.mesh); if (!pf.core) pf.mesh.material.dispose(); } if (old.mat) old.mat.dispose(); } catch (e) {}
  }
  const vol = { pos: center, radius: def.radius, born: t, until: t + def.duration, ownerTeam: nadeOwnerTeam(owner), puffs: [], drift: new THREE.Vector3(rand(-0.03, 0.03), 0, rand(-0.03, 0.03)), mat: null, fading: false };
  try {
    const R = def.radius;
    // --- opaque core: overlapping lumpy blobs you physically cannot see through
    const blobs = [{ x: 0, y: 0.1, z: 0, r: 0.5 }];
    const ringN = 6, ringOff = rand(0, 6.28);
    for (let i = 0; i < ringN; i++) { const a = ringOff + (i / ringN) * Math.PI * 2; blobs.push({ x: Math.cos(a) * 0.55, y: -0.05 + rand(-0.04, 0.06), z: Math.sin(a) * 0.55, r: rand(0.37, 0.43) }); }
    for (let i = 0; i < 3; i++) { const a = ringOff + (i / 3) * Math.PI * 2 + 0.5; blobs.push({ x: Math.cos(a) * 0.28, y: 0.38 + rand(-0.03, 0.05), z: Math.sin(a) * 0.28, r: rand(0.3, 0.36) }); }
    // mostly self-lit so it reads as soft vapour, not grey boulders; sun adds a gentle top-light
    const mat = new THREE.MeshLambertMaterial({ color: 0x5e5b55, emissive: 0x96928a, vertexColors: true, side: THREE.DoubleSide });
    vol.mat = mat;
    for (const b of blobs) {
      const mesh = new THREE.Mesh(smokeBlobGeometry(), mat);
      mesh.rotation.set(rand(0, 6.28), rand(0, 6.28), rand(0, 6.28));
      mesh.renderOrder = 1;
      scene.add(mesh);
      vol.puffs.push({ mesh, core: true, off: new THREE.Vector3(b.x * R, b.y * R, b.z * R), base: b.r * R, seed: Math.random() * 10, spin: rand(-0.08, 0.08) });
    }
    // --- soft shell: billboards on the blob surfaces break up the ball silhouette
    const tex = smokeCloudTexture();
    const n = opts.quality ? 44 : 20;
    for (let i = 0; i < n; i++) {
      const b = blobs[(Math.random() * blobs.length) | 0];
      const dir = new THREE.Vector3(rand(-1, 1), rand(-0.3, 1), rand(-1, 1)).normalize();
      const off = new THREE.Vector3(b.x * R, b.y * R, b.z * R).addScaledVector(dir, b.r * R * rand(0.85, 1.05));
      const smat = new THREE.SpriteMaterial({ map: tex, color: 0xd8d4cb, transparent: true, opacity: 0, depthWrite: false, fog: true });
      const s = new THREE.Sprite(smat);
      s.material.rotation = rand(0, Math.PI * 2);
      scene.add(s);
      vol.puffs.push({ mesh: s, core: false, off, base: b.r * R * rand(1.2, 1.8), seed: Math.random() * 10, spin: rand(-0.15, 0.15) });
    }
    spawnBurst(center, 0xd6d2c8, 12, 4, 0.6, 0.3);
  } catch (e) {}
  tacticalSmokes.push(vol);
  try { if (isOnline() && owner && owner.isPlayer) { /* throw already relayed; pop is deterministic */ } } catch (e) {}
}
export function disperseSmokes(at, radius, lifeCut) {
  for (const s of tacticalSmokes) {
    if (s.pos.distanceTo(at) < radius + s.radius) {
      s.until = Math.min(s.until, performance.now() / 1000 + Math.max(2, (s.until - performance.now() / 1000) - lifeCut));
      s.dispersed = true;
    }
  }
}
// ponytail: smoke stays vision-only (CS rule) — bullets/nades/bodies only stir
// it and wade through it, never blocked by it. HE shreds via disperseSmokes.
export const _smokePt = new THREE.Vector3();
export function smokePushAt(p, vx, vz, power = 1) {
  if (!tacticalSmokes.length) return 0;
  let dense = 0;
  const t = performance.now() / 1000;
  for (const s of tacticalSmokes) {
    const R = smokeVolumeRadius(s, t);
    if (R < 0.5 || t > s.until) continue;
    const dx = p.x - s.pos.x, dz = p.z - s.pos.z, dy = (p.y ?? 1) - s.pos.y;
    if (dx * dx + dz * dz > R * R * 1.2 || Math.abs(dy) > R) continue;
    const k = power * clamp(1 - Math.hypot(dx, dz) / (R + 0.001), 0, 1);
    if (k <= 0) continue;
    dense = Math.max(dense, k);
    s.pos.x = clamp(s.pos.x + vx * k * 0.06, -MAP_HALF + 0.5, MAP_HALF - 0.5);
    s.pos.z = clamp(s.pos.z + vz * k * 0.06, -MAP_HALF + 0.5, MAP_HALF - 0.5);
    s.drift.x = clamp((s.drift.x || 0) + vx * k * 0.015, -0.25, 0.25);
    s.drift.z = clamp((s.drift.z || 0) + vz * k * 0.015, -0.25, 0.25);
  }
  return dense;
}
export function smokeSlowAt(p) {
  try { return 1 - 0.14 * clamp(smokeDensityAt(p, performance.now() / 1000), 0, 1); }
  catch { return 1; }
}
let _smokeGeos = null, _smokeCloudTex = null;
function smokeBlobGeometry() {
  if (!_smokeGeos) {
    _smokeGeos = [];
    for (let v = 0; v < 3; v++) {
      const g = new THREE.IcosahedronGeometry(1, 4);
      const pos = g.attributes.position, cols = new Float32Array(pos.count * 3);
      const ph = [rand(0, 9), rand(0, 9), rand(0, 9)];
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const n = Math.sin(x * 2.3 + ph[0]) * Math.sin(y * 2.1 + ph[1]) * Math.sin(z * 2.5 + ph[2]) * 0.16
          + Math.sin(x * 4.1 + y * 3.3 + ph[1]) * 0.05 + Math.sin(z * 3.7 - y * 2.9 + ph[2]) * 0.04;
        const k = 1 + n;
        pos.setXYZ(i, x * k, y * k, z * k);
        const shade = 0.72 + 0.28 * clamp((y + 1) / 2, 0, 1); // darker underside
        cols[i * 3] = shade; cols[i * 3 + 1] = shade; cols[i * 3 + 2] = shade * 0.98;
      }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      g.computeVertexNormals();
      _smokeGeos.push(g);
    }
  }
  return _smokeGeos[(Math.random() * 3) | 0];
}
function smokeCloudTexture() {
  if (_smokeCloudTex) return _smokeCloudTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * 6.28, d = Math.random() * 30;
    const x = 64 + Math.cos(a) * d, y = 64 + Math.sin(a) * d, r = 18 + Math.random() * 22;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const v = 200 + (Math.random() * 40 | 0);
    gr.addColorStop(0, `rgba(${v},${v},${v - 6},0.7)`); gr.addColorStop(0.6, `rgba(${v},${v},${v - 6},0.35)`); gr.addColorStop(1, `rgba(${v},${v},${v - 6},0)`);
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  }
  _smokeCloudTex = new THREE.CanvasTexture(c);
  return _smokeCloudTex;
}
function smokeBloom(s, t) { return 1 - Math.pow(1 - clamp((t - s.born) / 1.3, 0, 1), 3); }
export function smokeVolumeRadius(s, t) {
  const left = s.until - t;
  const fade = clamp(left / 3.0, 0, 1);
  return s.radius * (0.35 + 0.65 * smokeBloom(s, t)) * (0.6 + 0.4 * fade);
}
// 0..1 how deep a point sits inside a smoke (ellipsoid: wide dome, ~2.7 m tall above its centre)
export function smokeDensityAt(p, t) {
  let best = 0;
  for (const s of tacticalSmokes) {
    const R = smokeVolumeRadius(s, t);
    if (R < 0.5) continue;
    const dx = (p.x - s.pos.x) / (R * 0.95), dz = (p.z - s.pos.z) / (R * 0.95);
    const dy = (p.y - s.pos.y) / (p.y > s.pos.y ? R * 0.72 : R * 1.2);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    best = Math.max(best, clamp((1.0 - d) / 0.25, 0, 1) * clamp((s.until - t) / 2, 0, 1));
  }
  return best;
}
export function updateTacticalSmokes(dt, t) {
  for (let i = tacticalSmokes.length - 1; i >= 0; i--) {
    const s = tacticalSmokes[i];
    const left = s.until - t;
    if (left <= 0) {
      try { for (const pf of s.puffs) { scene.remove(pf.mesh); if (!pf.core) pf.mesh.material.dispose(); } if (s.mat) s.mat.dispose(); } catch (e) {}
      tacticalSmokes.splice(i, 1);
      continue;
    }
    s.pos.x = clamp(s.pos.x + s.drift.x * dt, -MAP_HALF + 0.5, MAP_HALF - 0.5);
    s.pos.z = clamp(s.pos.z + s.drift.z * dt, -MAP_HALF + 0.5, MAP_HALF - 0.5);
    const bloom = smokeBloom(s, t);
    const fadeOut = clamp(left / 3.0, 0, 1);
    // core stays fully opaque until the last seconds, then thins out
    if (s.mat) {
      if (fadeOut < 1 && !s.fading) { s.fading = true; s.mat.transparent = true; s.mat.depthWrite = false; s.mat.needsUpdate = true; }
      if (s.fading) s.mat.opacity = Math.pow(fadeOut, 1.5);
    }
    for (const pf of s.puffs) {
      try {
        const sway = pf.core ? 0.05 : 0.14;
        pf.mesh.position.set(
          s.pos.x + pf.off.x * (0.4 + 0.6 * bloom) + Math.sin(t * 0.35 + pf.seed) * sway,
          s.pos.y + pf.off.y * (0.4 + 0.6 * bloom) + Math.sin(t * 0.5 + pf.seed) * sway * 0.6,
          s.pos.z + pf.off.z * (0.4 + 0.6 * bloom) + Math.cos(t * 0.3 + pf.seed) * sway);
        const sc = pf.base * (0.25 + 0.75 * bloom) * (0.8 + 0.2 * fadeOut);
        pf.mesh.scale.setScalar(Math.max(0.01, sc));
        if (pf.core) pf.mesh.rotation.y += pf.spin * dt;
        else {
          pf.mesh.material.rotation += pf.spin * dt;
          pf.mesh.material.opacity = 0.95 * clamp(bloom * 2, 0, 1) * fadeOut;
        }
      } catch (e) {}
    }
  }
  // standing in a smoke: you see grey, not through it
  try {
    const el = $('smoke-screen');
    if (el) {
      const k = (camera && G.phase === 'playing') ? smokeDensityAt(camera.position, t) : 0;
      el.style.opacity = k.toFixed(3);
    }
  } catch (e) {}
}
// true if the segment a->b punches through any live smoke volume (AI vision only)
export function smokeBlocks(a, b) {
  if (!tacticalSmokes.length) return false;
  const t = performance.now() / 1000;
  for (const s of tacticalSmokes) {
    const R = smokeVolumeRadius(s, t) * 0.9;
    if (R < 0.8 || s.until - t < 1.2) continue;
    // segment-sphere: closest approach of center to ab
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const len2 = abx * abx + aby * aby + abz * abz;
    if (len2 < 1e-6) continue;
    let u = ((s.pos.x - a.x) * abx + ((s.pos.y + 0.2) - a.y) * aby + (s.pos.z - a.z) * abz) / len2;
    u = clamp(u, 0, 1);
    const cx = a.x + abx * u - s.pos.x, cy = a.y + aby * u - (s.pos.y + 0.2), cz = a.z + abz * u - s.pos.z;
    if (cx * cx + cy * cy + cz * cz < R * R) {
      // require both ends outside the cloud (inside = blind anyway, still blocked)
      return true;
    }
  }
  return false;
}
export function hasLOSClear(a, b) {
  // walls first (cheap), then dynamic smoke
  if (!hasLOS(a, b)) return false;
  return !smokeBlocks(a, b);
}

