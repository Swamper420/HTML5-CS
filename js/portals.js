// js/portals.js — AGENTS: Portal gun: linked blue/orange wall portals per owner, body teleport, online relay.
// Ownership: PORTALS, firePortalSlot, applyRemotePortal, updatePortals, clearPortals.

import * as THREE from 'three';
import { Net } from '../net.js';
import { AudioSys } from './audio.js';
import { MAP_HALF } from './config.js';
import { opts } from './settings.js';
import { collidesAt, rayWallDist, supportHeightAt } from './collision.js';
import { spawnBurst } from './effects.js';
import { announce } from './hud.js';
import { isOnline } from './multiplayer.js';
import { colliders } from './map.js';
import { camera, renderer, scene } from './render.js';
import { G, player } from './state.js';

export const PORTALS = new Map(); // ownerKey -> { A, B } where end = { pos, normal, mesh, rt, _mapped }
const PCOL = { A: 0x2e9bff, B: 0xff9a2a };
const DISC_R = 0.95; // portal face radius — big enough to walk through
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
    new THREE.TorusGeometry(DISC_R + 0.1, 0.12, 10, 32),
    new THREE.MeshBasicMaterial({ color })
  );
  // Window-style viewport: the exit-side render is sampled by main-camera
  // screen position, so the portal acts as a window — pixels line up with the
  // real bullet path from any angle. Aim at what you see and you hit it.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(DISC_R, 32),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        map: { value: null },
        baseColor: { value: new THREE.Color(color) },
        opacity: { value: 0.45 },
        mapped: { value: 0 },
      },
      vertexShader: `
        varying vec4 vClip;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vClip = projectionMatrix * viewMatrix * wp;
          gl_Position = vClip;
        }`,
      fragmentShader: `
        uniform sampler2D map;
        uniform vec3 baseColor;
        uniform float opacity;
        uniform float mapped;
        varying vec4 vClip;
        void main() {
          if (mapped < 0.5) {
            gl_FragColor = vec4(baseColor, opacity);
          } else {
            if (vClip.w <= 0.0) discard;
            vec2 uv = vClip.xy / vClip.w * 0.5 + 0.5;
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
            gl_FragColor = vec4(texture2D(map, uv).rgb, 1.0);
          }
          #include <colorspace_fragment>
        }`,
    })
  );
  g.add(ring); g.add(disc);
  g.userData.disc = disc;
  g.userData.baseColor = color;
  return g;
}

function setEnd(pair, slot, hit, rt = null) {
  if (pair[slot]) { try { scene.remove(pair[slot].mesh); } catch {} }
  const mesh = makePortalMesh(PCOL[slot]);
  mesh.position.copy(hit.pos).addScaledVector(hit.normal, 0.05);
  mesh.lookAt(hit.pos.clone().addScaledVector(hit.normal, 2));
  scene.add(mesh);
  pair[slot] = { pos: hit.pos.clone(), normal: hit.normal.clone(), mesh, rt, _mapped: false };
}

// Live view: every linked pair shows the other side. Render targets are pooled
// (max 10 ends) and only the nearest visible ends re-render each frame.
const VIEW_W = 512, VIEW_H = 288;
const _rtPool = new Map(); // "owner:slot" -> WebGLRenderTarget
function pairRT(ownerKey, slot) {
  const k = ownerKey + ':' + slot;
  let rt = _rtPool.get(k);
  if (rt) return rt;
  if (_rtPool.size >= 10) {
    const oldest = _rtPool.keys().next().value; // latest 10 win, rest stay shimmer
    try { _rtPool.get(oldest).dispose(); } catch {}
    _rtPool.delete(oldest);
  }
  rt = new THREE.WebGLRenderTarget(VIEW_W, VIEW_H);
  try { rt.texture.colorSpace = THREE.SRGBColorSpace; } catch {}
  _rtPool.set(k, rt);
  return rt;
}
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _sv = new THREE.Vector3(), _v = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3();
const _pq1 = new THREE.Quaternion(), _pq2 = new THREE.Quaternion();
const _qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

// Nearest linked portal face pierced by the ray (front side only). skip = end to ignore.
function rayPortalFace(O, D, maxD, skip = null) {
  let best = null;
  for (const [, pair] of PORTALS) {
    if (!pair.A || !pair.B) continue;
    for (const [E, Ox] of [[pair.A, pair.B], [pair.B, pair.A]]) {
      if (E === skip) continue;
      const dn = D.dot(E.normal);
      if (dn > -0.05) continue; // must enter through the face
      const t = _v.copy(E.pos).sub(O).dot(E.normal) / dn;
      if (!(t > 0.05) || t > maxD || (best && t >= best.d)) continue;
      _p.copy(O).addScaledVector(D, t).sub(E.pos);
      _p.addScaledVector(E.normal, -_p.dot(E.normal));
      if (_p.length() > DISC_R + 0.15) continue;
      best = { entry: E, exit: Ox, d: t, pos: O.clone().addScaledVector(D, t) };
    }
  }
  return best;
}

// Hitscan path with portal hops: { segs: [{o, d, len}] }.
// Bullets, beams and placement rays all travel this — offline and online alike.
export function tracePortalPath(origin, dir, maxD) {
  const segs = [];
  const ro = origin.clone(), rd = dir.clone();
  let rem = maxD, skip = null;
  for (let h = 0; h <= 3; h++) {
    const segLen = Math.min(rayWallDist(ro, rd, rem), rem);
    const ph = rayPortalFace(ro, rd, segLen, skip);
    if (!ph || h === 3) {
      segs.push({ o: ro.clone(), d: rd.clone(), len: segLen });
      break;
    }
    segs.push({ o: ro.clone(), d: rd.clone(), len: ph.d });
    // emerge from the exit, mirrored like the portal view
    ph.entry.mesh.getWorldQuaternion(_pq1).invert();
    ph.exit.mesh.getWorldQuaternion(_pq2);
    _pq2.multiply(_qy).multiply(_pq1);
    rd.applyQuaternion(_pq2);
    ro.copy(ph.exit.pos).addScaledVector(ph.exit.normal, 0.15);
    rem -= ph.d;
    if (rem <= 0.01) { segs.push({ o: ro.clone(), d: rd.clone(), len: 0 }); break; }
    skip = ph.exit;
  }
  return { segs };
}

function setMapped(end, on) {
  if (!end || end._mapped === on) return;
  end._mapped = on;
  try {
    const m = end.mesh.userData.disc.material;
    if (on) {
      // Opaque viewport: only exit view shows, wall behind hidden.
      m.uniforms.map.value = end.rt.texture;
      m.uniforms.mapped.value = 1;
      m.depthWrite = true;
    } else {
      m.uniforms.map.value = null;
      m.uniforms.mapped.value = 0;
      m.uniforms.opacity.value = 0.45;
      m.depthWrite = false;
    }
    m.needsUpdate = true;
  } catch {}
}

// Render exit side O's view onto entry end E's disc.
// Each end owns its virtual camera: one shared cam meant the second render
// overwrote the first, so far-apart ends showed stale/wrong views.
function endCam(E) {
  if (!E._cam) E._cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 300);
  return E._cam;
}
function renderPortalView(E, O) {
  const cam = endCam(E);
  try {
    E.mesh.updateMatrixWorld(); O.mesh.updateMatrixWorld(); camera.updateMatrixWorld();
    // virtual cam = exit frame * 180°-about-Y * entry frame^-1 * main cam
    _m1.copy(E.mesh.matrixWorld).invert();
    _m2.makeRotationY(Math.PI);
    _m3.multiplyMatrices(_m2, _m1).premultiply(O.mesh.matrixWorld).multiply(camera.matrixWorld);
    _m3.decompose(cam.position, cam.quaternion, _sv);
    cam.fov = camera.fov; cam.aspect = camera.aspect;
    cam.near = 0.1; cam.far = camera.far;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // hide every portal disc: the rest sample by screen pos, which belongs to
    // the main camera — under the virtual cam they'd sample garbage.
    const hidden = [];
    for (const [, pair] of PORTALS) {
      for (const s of ['A', 'B']) {
        const m = pair[s] && pair[s].mesh;
        if (m && m.visible) { m.visible = false; hidden.push(m); }
      }
    }
    renderer.setRenderTarget(E.rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(null);
    for (const m of hidden) m.visible = true;
    setMapped(E, true);
  } catch { try { renderer.setRenderTarget(null); } catch {} for (const [, pair] of PORTALS) { for (const s of ['A', 'B']) { try { if (pair[s]) pair[s].mesh.visible = true; } catch {} } } }
}

function endVisible(end) {
  _d.copy(camera.position).sub(end.pos);
  const dist = _d.length();
  if (dist > 40 || dist < 0.1) return -1;
  if (_d.normalize().dot(end.normal) < 0.12) return -1; // behind the face
  _v.copy(end.pos).project(camera);
  return (_v.z < 1 && Math.abs(_v.x) < 1.15 && Math.abs(_v.y) < 1.15) ? dist : -1;
}

function updatePortalViews() {
  if (!opts.quality) return;
  const now = performance.now() / 1000;
  const cands = [];
  for (const [key, pair] of PORTALS) {
    if (!pair.A || !pair.B) {
      if (pair.A) setMapped(pair.A, false);
      if (pair.B) setMapped(pair.B, false);
      continue;
    }
    if (!pair.A.rt || !pair.B.rt) continue;
    for (const [E, O] of [[pair.A, pair.B], [pair.B, pair.A]]) {
      const dist = endVisible(E);
      if (dist < 0) continue;
      // Local pair re-renders every frame: a stale view breaks aim-through parallax.
      const rate = key === 'local' ? 0 : 1 / 10;
      if (now - (E._viewT || 0) < rate) continue; // keep last frame (or shimmer until first render)
      cands.push({ E, O, dist, local: key === 'local' ? 0 : 1 });
    }
  }
  cands.sort((a, b) => (a.local - b.local) || (a.dist - b.dist));
  for (let i = 0; i < Math.min(3, cands.length); i++) {
    const c = cands[i];
    c.E._viewT = now;
    renderPortalView(c.E, c.O);
  }
}

// Shooter places one end. fromNet=true skips rebroadcast (remote replay).
// The placement ray itself travels through linked portals — shoot through your
// orange to place blue behind it. Relayed as the final wall hit, so all clients agree.
export function firePortalSlot(origin, dir, slot, ownerKey = 'local', fromNet = false, range = 120) {
  const path = tracePortalPath(origin, dir, range);
  const last = path.segs[path.segs.length - 1];
  const hit = rayPortalHit(last.o, last.d, last.len);
  if (!hit) { if (!fromNet) AudioSys.click(300, 0.06, 0.3); return null; }
  // disjoint legs (teleport jumps are not lines) for the placement beam relay
  hit.points = path.segs.map((S) => [S.o.clone(), S.o.clone().addScaledVector(S.d, S.len)]);
  hit.points[hit.points.length - 1][1].copy(hit.pos);
  let pair = PORTALS.get(ownerKey);
  if (!pair) { pair = {}; PORTALS.set(ownerKey, pair); }
  setEnd(pair, slot, hit, pairRT(ownerKey, slot));
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
  setEnd(pair, slot, { pos: new THREE.Vector3(x, y, z), normal: n }, pairRT(key, slot));
  try { spawnBurst(new THREE.Vector3(x, y, z), PCOL[slot], 10, 4, 0.4, 0.1); } catch {}
}

function tryTeleportPair(pair, t) {
  if (!pair.A || !pair.B || !player.alive) return;
  if (t < (player._portalCd || 0)) return;
  // plane trigger: near the disc plane AND within its face (no yank from walking past)
  _v.set(player.pos.x, player.pos.y + 0.9, player.pos.z);
  let exit = null;
  for (const [E, O] of [[pair.A, pair.B], [pair.B, pair.A]]) {
    _d.copy(_v).sub(E.pos);
    const axial = _d.dot(E.normal);
    _d.addScaledVector(E.normal, -axial);
    if (Math.abs(axial) < 1.0 && _d.length() < DISC_R + 0.3) { exit = O; break; }
  }
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
  try { updatePortalViews(); } catch {}
  // shimmer so unlinked pairs read at distance (linked stay opaque viewport)
  for (const [, pair] of PORTALS) {
    for (const s of ['A', 'B']) {
      const e = pair[s];
      if (e && e.mesh && e.mesh.userData.disc && !e._mapped) {
        try { e.mesh.userData.disc.material.uniforms.opacity.value = 0.35 + 0.15 * Math.sin(t * 5 + (s === 'A' ? 0 : 2)); } catch {}
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
