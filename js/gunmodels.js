// js/gunmodels.js — AGENTS: Profile-extruded gun geometry shared by viewmodel + world models; soldier gun attach (single/dual).
// Ownership: buildGunModel, gunMats, setSoldierGun, setSoldierDual. ADD a gun's look here (data in config.js).

import * as THREE from 'three';
import { WEAPONS } from './config.js';
import { buildGunHands, vmMats } from './viewmodel.js';

// Guns are authored as SIDE PROFILES in (f, y): f = metres forward of the trigger area,
// y = up. Each profile is extruded across its width, so silhouettes read like real guns
// instead of stacked boxes. Viewmodel: forward is -Z. World models are rotated to +Z.
const _gunGeoCache = new Map();
function gunProfileGeo(pts, holes, w, bevel = 0.0025) {
  const key = JSON.stringify([pts, holes, w, bevel]);
  if (_gunGeoCache.has(key)) return _gunGeoCache.get(key);
  const trace = (path, arr) => arr.forEach((p, i) => {
    if (p[0] === 'q') path.quadraticCurveTo(p[1], p[2], p[3], p[4]);
    else if (i === 0) path.moveTo(p[0], p[1]); else path.lineTo(p[0], p[1]);
  });
  const s = new THREE.Shape(); trace(s, pts);
  for (const h of holes || []) { const hp = new THREE.Path(); trace(hp, h); s.holes.push(hp); }
  const depth = Math.max(0.001, w - bevel * 2);
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 8 });
  g.translate(0, 0, -depth / 2);
  g.rotateY(Math.PI / 2); // profile forward (+x) → -Z, extrusion → X
  g.computeVertexNormals();
  _gunGeoCache.set(key, g);
  return g;
}
export let _worldGunMats = null;
export function gunMats() {
  const M = vmMats();
  M.polymer = new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.72, metalness: 0.05 });
  M.polymerL = new THREE.MeshStandardMaterial({ color: 0x45484c, roughness: 0.8, metalness: 0.05 });
  M.bakelite = new THREE.MeshStandardMaterial({ color: 0x5b2a17, roughness: 0.55, metalness: 0.05 });
  M.blued = new THREE.MeshStandardMaterial({ color: 0x3b3e44, roughness: 0.42, metalness: 0.55 });
  M.awpGreen = new THREE.MeshStandardMaterial({ color: 0x4f6b3c, roughness: 0.7, metalness: 0.05 });
  // machete slab: bright enough to read as steel with no envmap (pure metals go black)
  M.blade = new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.32, metalness: 0.55, emissive: 0x14181d });
  M.magClear = new THREE.MeshStandardMaterial({ color: 0x55554c, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.35, depthWrite: false });
  M.glowR = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
  M.sleeve = new THREE.MeshStandardMaterial({ color: 0x3d4654, roughness: 0.95 });
  M.gloveK = new THREE.MeshStandardMaterial({ color: 0x3a3630, roughness: 0.85 });
  return M;
}
// Build `key` into `root`; magazine parts go into `magG` (so reloads can drop them).
export function buildGunModel(key, M, root, magG, opts = {}) {
  const hi = !opts.world;
  const out = { muzzle: null, rear: null, front: null, bolt: null, stock: [] };
  const P = (parent, pts, w, mat, x = 0, holes = null, bevel = 0.0025) => {
    const m = new THREE.Mesh(gunProfileGeo(pts, holes, w, bevel), mat);
    m.position.x = x; parent.add(m); return m;
  };
  const Cy = (parent, r, len, mat, f, y, x = 0, seg = 14, r2 = r) => { // cylinder along the barrel axis
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, seg), mat);
    m.rotation.x = Math.PI / 2; m.position.set(x, y, -f); parent.add(m); return m;
  };
  const Bx = (parent, w, h, len, mat, f, y, x = 0, rx = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, len), mat);
    m.position.set(x, y, -f); m.rotation.x = rx; parent.add(m); return m;
  };
  const mark = (f, y, x = 0) => { const o = new THREE.Object3D(); o.position.set(x, y, -f); root.add(o); return o; };

  if (key === 'ak') {
    // stamped receiver with the AK's rounded dust-cover rear
    P(root, [[-0.12, -0.038], [0.40, -0.038], [0.40, 0.030], [0.05, 0.034], [-0.02, 0.046], ['q', -0.10, 0.052, -0.12, 0.028]], 0.060, M.blued);
    if (hi) for (let i = 0; i < 2; i++) Bx(root, 0.062, 0.004, 0.33, M.metal, 0.19, 0.012 - i * 0.022); // stamping lines
    // wooden stock with steel buttplate
    out.stock.push(P(root, [[-0.12, 0.024], [-0.12, -0.036], [-0.44, -0.105], [-0.455, -0.098], [-0.455, 0.012], [-0.44, 0.022]], 0.046, M.wood));
    out.stock.push(P(root, [[-0.455, -0.1], [-0.468, -0.1], [-0.468, 0.014], [-0.455, 0.014]], 0.048, M.steel, 0, null, 0.001));
    // bakelite pistol grip
    P(root, [[-0.035, -0.036], [0.03, -0.036], [0.0, -0.155], ['q', -0.03, -0.168, -0.07, -0.15]], 0.044, M.bakelite);
    // trigger guard (real hole) + trigger
    P(root, [[0.03, -0.036], [0.14, -0.036], [0.13, -0.078], [0.05, -0.08], [0.02, -0.06]], 0.012, M.blued, 0,
      [[[0.045, -0.042], [0.123, -0.042], [0.116, -0.070], [0.055, -0.071], [0.036, -0.056]]], 0.001);
    P(root, [[0.075, -0.038], [0.085, -0.038], [0.08, -0.068], [0.07, -0.066]], 0.008, M.steel, 0, null, 0.001);
    // banana magazine
    P(magG, [[0.14, -0.034], [0.235, -0.034], ['q', 0.26, -0.17, 0.33, -0.285], [0.255, -0.31], ['q', 0.18, -0.19, 0.14, -0.034]], 0.046, M.blued);
    if (hi) P(magG, [[0.228, -0.05], [0.24, -0.05], ['q', 0.265, -0.17, 0.322, -0.275], [0.31, -0.28], ['q', 0.25, -0.17, 0.228, -0.05]], 0.05, M.metal, 0, null, 0.001);
    // rear sight block + leaf
    P(root, [[0.36, 0.028], [0.47, 0.028], [0.47, 0.052], [0.40, 0.058]], 0.05, M.blued);
    Bx(root, 0.032, 0.008, 0.07, M.dark, 0.42, 0.062);
    Bx(root, 0.006, 0.012, 0.01, M.dark, 0.45, 0.071, -0.011); Bx(root, 0.006, 0.012, 0.01, M.dark, 0.45, 0.071, 0.011);
    out.rear = mark(0.45, 0.074);
    // wooden handguards, steel band
    P(root, [[0.40, -0.038], [0.62, -0.030], ['q', 0.64, -0.012, 0.62, 0.006], [0.40, 0.006]], 0.062, M.wood);
    if (hi) for (let i = 0; i < 3; i++) Bx(root, 0.064, 0.006, 0.012, M.woodD, 0.47 + i * 0.05, -0.014);
    P(root, [[0.47, 0.012], [0.63, 0.012], ['q', 0.655, 0.03, 0.63, 0.052], [0.49, 0.052], ['q', 0.465, 0.035, 0.47, 0.012]], 0.046, M.wood);
    Bx(root, 0.066, 0.05, 0.012, M.steel, 0.635, 0.005);
    // gas tube + block, barrel, cleaning rod
    Cy(root, 0.012, 0.12, M.blued, 0.70, 0.034);
    P(root, [[0.75, -0.012], [0.79, -0.012], [0.79, 0.046], [0.755, 0.046]], 0.03, M.blued);
    Cy(root, 0.0105, 0.32, M.blued, 0.77, 0.0);
    if (hi) Cy(root, 0.0035, 0.28, M.steel, 0.76, -0.022, 0, 6);
    // front sight tower (hooded post)
    P(root, [[0.85, -0.012], [0.885, -0.012], [0.88, 0.064], [0.855, 0.064]], 0.022, M.blued);
    Bx(root, 0.004, 0.026, 0.004, M.dark, 0.868, 0.075);
    if (hi) Bx(root, 0.004, 0.03, 0.02, M.blued, 0.868, 0.075, -0.012), Bx(root, 0.004, 0.03, 0.02, M.blued, 0.868, 0.075, 0.012);
    if (hi) { const d = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 8, 6), M.glowG); d.position.set(0, 0.087, -0.868); root.add(d); }
    out.front = mark(0.868, 0.088);
    // slant muzzle brake
    P(root, [[0.905, -0.017], [0.965, -0.017], [0.965, 0.006], [0.94, 0.017], [0.905, 0.017]], 0.034, M.dark);
    // charging handle + selector
    if (hi) {
      const ch = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.04, 8), M.steel); ch.rotation.z = Math.PI / 2; ch.position.set(0.045, 0.012, -0.30); root.add(ch);
      const sel = Bx(root, 0.006, 0.016, 0.12, M.blued, 0.16, 0.004, 0.033); sel.rotation.x = -0.12;
    }
    out.muzzle = mark(0.975, 0.0);
  } else if (key === 'p90') {
    // bullpup polymer shell with the P90's two cut-outs
    P(root, [[-0.20, 0.045], [0.22, 0.045], ['q', 0.30, 0.045, 0.31, 0.0], [0.30, -0.035], [0.265, -0.06], [0.255, -0.14], ['q', 0.25, -0.16, 0.225, -0.16],
      [0.17, -0.16], ['q', 0.15, -0.16, 0.145, -0.14], [0.12, -0.13], [-0.13, -0.13], ['q', -0.2, -0.13, -0.215, -0.08], [-0.215, 0.0], ['q', -0.215, 0.045, -0.20, 0.045]],
      0.066, M.polymer, 0,
      [[[0.168, -0.068], [0.235, -0.064], [0.235, -0.128], ['q', 0.2, -0.142, 0.168, -0.126]],
       [[-0.12, -0.05], [0.09, -0.05], ['q', 0.115, -0.055, 0.105, -0.085], [0.02, -0.098], [-0.11, -0.104], ['q', -0.15, -0.09, -0.12, -0.05]]], 0.004);
    // lighter grip panel + buttplate
    P(root, [[0.12, -0.13], [-0.13, -0.13], ['q', -0.2, -0.13, -0.215, -0.08], [-0.2, -0.08], ['q', -0.18, -0.115, -0.12, -0.112], [0.1, -0.112]], 0.07, M.polymerL, 0, null, 0.002);
    out.stock.push(P(root, [[-0.215, 0.03], [-0.228, 0.03], [-0.228, -0.09], [-0.215, -0.09]], 0.06, M.rubber, 0, null, 0.002));
    out.stock.push(Bx(magG, 0.052, 0.026, 0.02, M.polymer, -0.14, 0.058));
    // clear top magazine with brass column
    Bx(magG, 0.05, 0.022, 0.37, M.magClear, 0.04, 0.058);
    Bx(magG, 0.026, 0.012, 0.35, M.brass, 0.04, 0.058);
    // open reflex sight: rails + hood + red dot
    Bx(root, 0.006, 0.05, 0.13, M.polymer, 0.13, 0.093, -0.022);
    Bx(root, 0.006, 0.05, 0.13, M.polymer, 0.13, 0.093, 0.022);
    Bx(root, 0.05, 0.006, 0.13, M.polymer, 0.13, 0.121);
    if (hi) { const d = new THREE.Mesh(new THREE.SphereGeometry(0.0028, 8, 6), M.glowR); d.position.set(0, 0.097, -0.19); root.add(d); }
    out.rear = mark(0.07, 0.097); out.front = mark(0.19, 0.097);
    // barrel + flash hider, trigger, side charging knobs
    Cy(root, 0.011, 0.07, M.blued, 0.335, 0.0);
    Cy(root, 0.015, 0.035, M.dark, 0.38, 0.0);
    P(root, [[0.13, -0.05], [0.14, -0.05], [0.135, -0.09], [0.125, -0.088]], 0.008, M.steel, 0, null, 0.001);
    if (hi) for (const sx of [-0.036, 0.036]) Bx(root, 0.01, 0.014, 0.03, M.dark, 0.23, 0.028, sx);
    out.muzzle = mark(0.40, 0.0);
  } else if (key === 'deagle') {
    // slide with rear serrations and the flat-top rib
    P(root, [[-0.06, 0.0], [0.40, 0.0], [0.40, 0.06], [0.0, 0.064], [-0.06, 0.048]], 0.056, M.chrome);
    Bx(root, 0.02, 0.008, 0.36, M.steel, 0.21, 0.067);
    if (hi) for (let i = 0; i < 7; i++) Bx(root, 0.058, 0.034, 0.005, M.dark, -0.03 + i * 0.012, 0.03);
    if (hi) for (const sx of [-0.029, 0.029]) Bx(root, 0.002, 0.012, 0.16, M.dark, 0.25, 0.025, sx);
    // frame, rubber grip, guard (real hole), trigger, hammer
    P(root, [[-0.04, 0.001], [0.36, 0.001], [0.36, -0.028], [0.14, -0.03], [0.10, -0.045], [0.0, -0.045], [-0.04, -0.03]], 0.052, M.metal);
    P(root, [[-0.06, -0.02], [0.04, -0.03], [0.012, -0.21], ['q', -0.03, -0.225, -0.09, -0.205], [-0.075, -0.05]], 0.058, M.rubber);
    if (hi) for (let i = 0; i < 5; i++) { const r = Bx(root, 0.06, 0.006, 0.07, M.dark, -0.025 - i * 0.008, -0.07 - i * 0.03); r.rotation.x = -0.28; }
    P(root, [[0.03, -0.03], [0.16, -0.03], [0.155, -0.09], [0.07, -0.095], [0.03, -0.07]], 0.014, M.metal, 0,
      [[[0.045, -0.037], [0.145, -0.037], [0.14, -0.08], [0.075, -0.085], [0.045, -0.066]]], 0.001);
    P(root, [[0.085, -0.032], [0.097, -0.032], [0.09, -0.07], [0.078, -0.066]], 0.009, M.steel, 0, null, 0.001);
    P(root, [[-0.075, 0.018], [-0.05, 0.018], [-0.055, 0.056], [-0.082, 0.05]], 0.018, M.dark, 0, null, 0.001);
    Bx(magG, 0.06, 0.016, 0.08, M.metal, -0.045, -0.212, 0, -0.28);
    // sights (3-dot) + muzzle bore
    Bx(root, 0.009, 0.016, 0.014, M.dark, -0.03, 0.072, -0.0165); Bx(root, 0.009, 0.016, 0.014, M.dark, -0.03, 0.072, 0.0165);
    Bx(root, 0.008, 0.02, 0.012, M.dark, 0.38, 0.072);
    if (hi) for (const [f, x] of [[0.38, 0], [-0.03, -0.0165], [-0.03, 0.0165]]) { const d = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 8, 6), M.glowW); d.position.set(x, 0.077, -f - 0.008); root.add(d); }
    out.rear = mark(-0.03, 0.08); out.front = mark(0.38, 0.082);
    Cy(root, 0.013, 0.006, M.dark, 0.402, 0.03);
    out.muzzle = mark(0.42, 0.03);
  } else if (key === 'awp') {
    // olive thumbhole stock (real hole) + buttpad + cheek rest
    P(root, [[-0.24, 0.035], [-0.24, -0.115], [-0.14, -0.105], [-0.06, -0.07], [0.0, -0.14], [0.07, -0.14], [0.09, -0.05], [0.50, -0.045], ['q', 0.53, -0.03, 0.50, -0.005],
      [0.20, -0.005], [0.05, 0.03], [-0.08, 0.05], ['q', -0.2, 0.06, -0.24, 0.035]], 0.062, M.awpGreen, 0,
      [[[-0.11, -0.02], [-0.035, -0.035], ['q', -0.005, -0.06, -0.025, -0.082], [-0.085, -0.062]]], 0.004);
    P(root, [[-0.24, 0.04], [-0.268, 0.04], [-0.268, -0.12], [-0.24, -0.12]], 0.066, M.rubber, 0, null, 0.003);
    if (hi) for (let i = 0; i < 4; i++) Bx(root, 0.064, 0.004, 0.03, M.dark, 0.25 + i * 0.05, -0.03);
    // receiver + ejection port
    P(root, [[0.05, -0.012], [0.36, -0.012], [0.36, 0.045], [0.07, 0.048]], 0.052, M.blued);
    Bx(root, 0.004, 0.02, 0.09, M.dark, 0.23, 0.028, 0.027);
    // fluted barrel + brake
    Cy(root, 0.014, 0.58, M.blued, 0.66, 0.018);
    if (hi) for (const z of [0.58, 0.68, 0.78]) Cy(root, 0.016, 0.012, M.dark, z, 0.018);
    P(root, [[0.94, -0.006], [1.03, -0.006], [1.03, 0.042], [0.94, 0.042]], 0.04, M.dark, 0, [[[0.958, 0.008], [0.972, 0.008], [0.972, 0.028], [0.958, 0.028]], [[0.99, 0.008], [1.004, 0.008], [1.004, 0.028], [0.99, 0.028]]], 0.003);
    // scope (same optical centre as before so the scope overlay lines up)
    Cy(root, 0.025, 0.28, M.dark, 0.28, 0.105);
    Cy(root, 0.037, 0.08, M.dark, 0.45, 0.105, 0, 16, 0.03);
    Cy(root, 0.026, 0.06, M.dark, 0.115, 0.105, 0, 16, 0.031);
    { const l = new THREE.Mesh(new THREE.CircleGeometry(0.03, 18), M.lens); l.position.set(0, 0.105, -0.491); l.rotation.y = Math.PI; root.add(l); }
    if (hi) {
      const t1 = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.024, 12), M.steel); t1.position.set(0, 0.14, -0.28); root.add(t1);
      const t2 = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.024, 12), M.steel); t2.rotation.z = Math.PI / 2; t2.position.set(0.034, 0.105, -0.28); root.add(t2);
    }
    for (const f of [0.2, 0.36]) P(root, [[f - 0.018, 0.045], [f + 0.018, 0.045], [f + 0.018, 0.082], [f - 0.018, 0.082]], 0.03, M.dark, 0, null, 0.002);
    // bolt (animated group rides at the origin so reload/cycle offsets stay relative)
    const boltG = new THREE.Group(); root.add(boltG);
    { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.05, 8), M.steel); s.rotation.z = Math.PI / 2; s.position.set(0.05, 0.028, -0.16); boltG.add(s);
      const k = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 10), M.dark); k.position.set(0.078, 0.02, -0.16); boltG.add(k); }
    out.bolt = boltG;
    // box mag, guard, trigger, folded bipod
    P(magG, [[0.16, -0.045], [0.28, -0.045], [0.275, -0.15], [0.165, -0.15]], 0.048, M.blued);
    P(magG, [[0.16, -0.15], [0.28, -0.15], [0.28, -0.162], [0.16, -0.162]], 0.052, M.dark, 0, null, 0.001);
    P(root, [[0.08, -0.045], [0.16, -0.045], [0.15, -0.095], [0.095, -0.095]], 0.012, M.dark, 0, [[[0.095, -0.05], [0.148, -0.05], [0.14, -0.086], [0.103, -0.086]]], 0.001);
    P(root, [[0.115, -0.047], [0.125, -0.047], [0.12, -0.08], [0.11, -0.078]], 0.008, M.steel, 0, null, 0.001);
    if (hi) for (const sx of [-0.036, 0.036]) Bx(root, 0.012, 0.012, 0.36, M.dark, 0.72, -0.05, sx);
    out.muzzle = mark(1.04, 0.018);
  } else if (key === 'machete') {
    // MACHETE: insanely massive. Wrapped grip, brass guard, then a slab of a
    // blade ~1.5m long — reads huge in first person and on soldiers alike.
    P(root, [[-0.22, -0.035], [-0.02, -0.035], [-0.02, 0.035], [-0.22, 0.035]], 0.055, M.rubber);
    if (hi) for (let i = 0; i < 4; i++) Bx(root, 0.057, 0.008, 0.02, M.dark, -0.19 + i * 0.045, 0.0);
    P(root, [[-0.02, -0.045], [0.03, -0.045], [0.03, 0.07], [-0.02, 0.07]], 0.09, M.brass);
    // the slab: clipped point, swedge, fuller groove
    P(root, [[0.03, -0.10], [1.28, -0.10], [1.52, 0.02], [1.50, 0.10], [0.03, 0.10]], 0.022, M.blade || M.steel);
    if (hi) Bx(root, 0.024, 0.018, 1.05, M.dark, 0.62, 0.045);
    if (hi) { const e = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.012, 1.30), M.chrome || M.steel); e.position.set(0, -0.095, -0.75); root.add(e); }
    out.muzzle = mark(1.52, 0.02);
    out.rear = mark(0.03, 0.10); out.front = mark(1.50, 0.10);
  } else if (key === 'helix') {
    // HELIX ARC: fictional coilgun. Fat shroud, 3 accelerator rings, glowing core,
    // and a spinning tri-blade rotor (out.spinner) that winds up before each shot.
    P(root, [[-0.16, -0.05], [0.42, -0.05], [0.44, 0.05], [-0.16, 0.055]], 0.075, M.polymer);
    P(root, [[-0.16, 0.02], [-0.34, 0.03], [-0.345, -0.10], [-0.16, -0.09]], 0.055, M.rubber, 0, null, 0.002);
    out.stock.push(P(root, [[-0.345, 0.03], [-0.46, 0.02], [-0.46, -0.08], [-0.345, -0.09]], 0.06, M.rubber, 0, null, 0.003));
    P(root, [[0.0, -0.05], [0.07, -0.05], [0.045, -0.16], [-0.01, -0.15]], 0.045, M.bakelite);
    out.coils = [];
    for (let i = 0; i < 3; i++) {
      const f = 0.52 + i * 0.17;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.014, 10, 22), M.steel);
      ring.position.set(0, 0.01, -f); root.add(ring);
      const coreMat = new THREE.MeshBasicMaterial({ color: 0x66f6ff });
      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.10, 12), coreMat);
      core.rotation.x = Math.PI / 2; core.position.set(0, 0.01, -f); root.add(core);
      out.coils.push({ m: coreMat, base: coreMat.color.clone(), ph: i * 2.1 });
    }
    Cy(root, 0.012, 0.22, M.blued, 1.12, 0.01);
    Bx(root, 0.05, 0.03, 0.16, M.dark, 0.10, 0.075); // top cell housing
    { const cellMat = new THREE.MeshBasicMaterial({ color: 0x9ff3ff });
      const cell = new THREE.Mesh(new THREE.CapsuleGeometry(0.016, 0.07, 4, 10), cellMat);
      cell.rotation.x = Math.PI / 2; cell.position.set(0, 0.078, -0.10); root.add(cell);
      out.coils.push({ m: cellMat, base: cellMat.color.clone(), ph: 4.2 }); }
    if (hi) { const d = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6), M.glowR); d.position.set(0, 0.078, -0.19); root.add(d); }
    const spinG = new THREE.Group(); spinG.position.set(0, 0.01, -0.44); spinG.name = 'helix-spinner'; root.add(spinG);
    for (let i = 0; i < 3; i++) {
      const holder = new THREE.Group(); holder.rotation.z = (i / 3) * Math.PI * 2;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.085, 0.03), M.chrome || M.steel);
      blade.position.set(0, 0.045, 0); holder.add(blade); spinG.add(holder);
    }
    { const hub = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xd8fbff })); spinG.add(hub); }
    out.spinner = spinG;
    out.rear = mark(0.10, 0.09); out.front = mark(0.86, 0.065);
    out.muzzle = mark(1.24, 0.01);
  }
  if (opts.hands) buildGunHands(key, M, root);
  return out;
}
// Third-person weapon on soldiers (bots + online players)
export function setSoldierGun(mesh, key) {
  const ud = mesh && mesh.userData; if (!ud) return;
  const gunG = ud.gunG || ud.gun || (ud.rig && ud.rig.gun);
  if (!gunG || !WEAPONS[key] || gunG.userData.model === key) return;
  if (!_worldGunMats) _worldGunMats = gunMats();
  for (let i = gunG.children.length - 1; i >= 0; i--) gunG.remove(gunG.children[i]);
  const holder = new THREE.Group(); holder.rotation.y = Math.PI; holder.scale.setScalar(0.85); holder.position.z = 0.02;
  gunG.add(holder);
  const built = buildGunModel(key, _worldGunMats, holder, holder, { world: true });
  try { gunG.userData.coils = built.coils || null; } catch (e) {}
  holder.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  gunG.userData.model = key;
}
// Second gun on a third-person soldier (remotes): mirrored on the left side of the chest.
export function setSoldierDual(mesh, key, dual) {
  const ud = mesh && mesh.userData; if (!ud) return;
  const gunG = ud.gunG || ud.gun || (ud.rig && ud.rig.gun);
  if (!gunG || !gunG.parent) return;
  const want = dual && WEAPONS[key] ? key : null;
  if ((ud.gunL && ud.gunL.userData.model) === want) return;
  if (ud.gunL) { try { ud.gunL.parent.remove(ud.gunL); } catch (e) {} ud.gunL = null; }
  if (!want) return;
  if (!_worldGunMats) _worldGunMats = gunMats();
  const gl = new THREE.Group();
  gl.position.set(-gunG.position.x, gunG.position.y, gunG.position.z);
  const holder = new THREE.Group(); holder.rotation.y = Math.PI; holder.scale.setScalar(0.85); holder.position.z = 0.02;
  gl.add(holder);
  const built2 = buildGunModel(want, _worldGunMats, holder, holder, { world: true });
  try { gl.userData.coils = built2.coils || null; } catch (e) {}
  holder.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  gl.userData.model = want;
  gunG.parent.add(gl);
  ud.gunL = gl;
}


// Cross-module writers (ES imports are read-only bindings).
export function setWorldGunMats(v) { return (_worldGunMats = v); }
