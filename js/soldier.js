// js/soldier.js — AGENTS: Third-person soldier mesh (jointed rig, camo textures) + blob shadows.
// Ownership: makeSoldier, soldierTextures, makeBlob/updateBlob. Animation lives in anim.js.

import * as THREE from 'three';
import { decalTextures } from './effects.js';
import { scene } from './render.js';

// cached camo cloth textures (one per team — shared across all bots/remotes)
let _camoTexCT = null, _camoTexT = null, _pantsTexCT = null, _pantsTexT = null;
function camoTexture(base, spots, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 42; i++) {
    g.fillStyle = spots[(Math.random() * spots.length) | 0];
    g.globalAlpha = 0.55 + Math.random() * 0.3;
    const r = 6 + Math.random() * 18;
    g.beginPath();
    g.ellipse(Math.random() * size, Math.random() * size, r, r * (0.5 + Math.random() * 0.7), Math.random() * 3, 0, 7);
    g.fill();
  }
  g.globalAlpha = 1;
  // fabric weave
  g.globalAlpha = 0.12; g.fillStyle = '#000';
  for (let y = 0; y < size; y += 3) g.fillRect(0, y, size, 1);
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function soldierTextures(team) {
  if (team === 'ct') {
    if (!_camoTexCT) {
      _camoTexCT = camoTexture('#2e4a6e', ['#22344e', '#3d5f8a', '#1a2638', '#4a6f9a']);
      _pantsTexCT = camoTexture('#232f42', ['#1a2332', '#2e3d55', '#141b28']);
    }
    return { cloth: _camoTexCT, pants: _pantsTexCT };
  }
  if (!_camoTexT) {
    _camoTexT = camoTexture('#8a6f42', ['#6e562f', '#a68d5a', '#5a4526', '#b89a68']);
    _pantsTexT = camoTexture('#4a3d28', ['#3a3020', '#5d4c33', '#2e2517']);
  }
  return { cloth: _camoTexT, pants: _pantsTexT };
}

// Anatomical hierarchy, not a pile of boxes: every limb rotates about a real joint.
//   root(feet) > pelvis > { hip > knee > ankle } x2
//                       > spine > chest > { shoulder > elbow } x2, neck > head, gun
// Old code addressed userData.legL / armL / torso and expected ".rotation.x = swing"
// to bend a limb; those keys now point at the hip / shoulder / spine PIVOTS, so
// every existing call site (gore, ragdoll, restore) keeps working — and finally
// bends the body where a body actually bends.
// shared per-team materials (one set per team, reused across all soldiers)
const _soldierMats = {};
function soldierMats(team) {
  const k = team === 'ct' ? 'ct' : 't';
  let M = _soldierMats[k];
  if (M) return M;
  const tex = soldierTextures(k);
  M = {
    matBody: new THREE.MeshStandardMaterial({ map: tex.cloth, color: 0xffffff, roughness: 0.92 }),
    matPants: new THREE.MeshStandardMaterial({ map: tex.pants, roughness: 0.95 }),
    matSkin: new THREE.MeshStandardMaterial({ color: 0xc9986b, roughness: 0.65 }),
    matGun: new THREE.MeshStandardMaterial({ color: 0x1e1e22, roughness: 0.42, metalness: 0.65 }),
    matHelmet: new THREE.MeshStandardMaterial({ color: k === 'ct' ? 0x1d2f45 : 0x6b5a35, roughness: 0.75 }),
    matVest: new THREE.MeshStandardMaterial({ color: k === 'ct' ? 0x1a2330 : 0x3d3220, roughness: 0.95 }),
    matBoot: new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.9 }),
    matPad: new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.85 }),
    matCuff: new THREE.MeshStandardMaterial({ color: k === 'ct' ? 0x22344e : 0x6e562f, roughness: 0.9 }),
    matGlove: new THREE.MeshStandardMaterial({ color: 0x2b2b26, roughness: 0.95 }),
    matRoll: new THREE.MeshStandardMaterial({ color: k === 'ct' ? 0x3a4a5a : 0x7a6a48, roughness: 1 }),
    matStripe: new THREE.MeshStandardMaterial({ color: k === 'ct' ? 0x66b3ff : 0xffc14d, emissive: k === 'ct' ? 0x1a3a5a : 0x5a3a10, emissiveIntensity: 0.7, roughness: 0.6 }),
    matStock: new THREE.MeshStandardMaterial({ color: k === 'ct' ? 0x22303f : 0x6b4a2a, roughness: 0.8 }),
    matBeard: new THREE.MeshStandardMaterial({ color: 0x2e1f12, roughness: 1 }),
    matScarf: new THREE.MeshStandardMaterial({ color: 0x8a2f22, roughness: 1 }),
    matGlass: new THREE.MeshStandardMaterial({ color: 0x0e141c, roughness: 0.15, metalness: 0.8 }),
  };
  _soldierMats[k] = M;
  return M;
}
export function makeSoldier(team) {
  const g = new THREE.Group();
  const { matBody, matPants, matSkin, matGun, matHelmet, matVest, matBoot, matPad, matCuff, matGlove, matRoll, matStripe, matStock, matBeard, matScarf, matGlass } = soldierMats(team);
  const mk = (geo, mat, x, y, z, shadow = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.castShadow = shadow;
    return m;
  };

  // --- pelvis: the root of everything that moves. Hips sit at y = HIP_Y. ---
  const HIP_Y = 0.86;
  const pelvis = new THREE.Group();
  pelvis.position.y = HIP_Y;
  g.add(pelvis);

  // --- legs: hip > knee > ankle, foot sole landing exactly on y = 0 ---
  const THIGH = 0.40, SHIN = 0.32;
  const mkLeg = (sx) => {
    const hip = new THREE.Group();
    hip.position.set(sx, 0, 0);
    hip.add(mk(new THREE.BoxGeometry(0.22, THIGH, 0.24), matPants, 0, -THIGH / 2, 0));
    hip.add(mk(new THREE.BoxGeometry(0.2, 0.2, 0.08), matPad, 0, -THIGH + 0.06, 0.13, false));
    const knee = new THREE.Group();
    knee.position.y = -THIGH;
    knee.add(mk(new THREE.BoxGeometry(0.2, SHIN, 0.22), matPants, 0, -SHIN / 2, 0));
    const ankle = new THREE.Group();
    ankle.position.y = -SHIN;
    const boot = mk(new THREE.BoxGeometry(0.24, 0.14, 0.34), matBoot, 0, -0.07, 0.05);
    ankle.add(boot);
    knee.add(ankle);
    hip.add(knee);
    pelvis.add(hip);
    return { hip, knee, ankle, boot };
  };
  const L = mkLeg(-0.15), R = mkLeg(0.15);

  pelvis.add(mk(new THREE.BoxGeometry(0.56, 0.1, 0.34), matVest, 0, 0, 0, false));           // belt
  pelvis.add(mk(new THREE.BoxGeometry(0.14, 0.22, 0.16), matBoot, 0.32, -0.14, 0.05, false)); // holster

  // --- spine (lower back) > chest (upper back). Two joints so the torso can
  //     counter-rotate against the hips the way a walking human's does. ---
  const spine = new THREE.Group();
  pelvis.add(spine);
  const chest = new THREE.Group();
  chest.position.y = 0.26;
  spine.add(chest);
  const C = (y) => y - HIP_Y - 0.26; // world-height -> chest-local

  const torso = mk(new THREE.BoxGeometry(0.62, 0.72, 0.38), matBody, 0, C(1.2), 0);
  chest.add(torso);
  const vest = mk(new THREE.BoxGeometry(0.5, 0.5, 0.1), matVest, 0, C(1.18), 0.22);
  chest.add(vest);
  for (let i = -1; i <= 1; i++) {
    chest.add(mk(new THREE.BoxGeometry(0.12, 0.18, 0.08), matVest, i * 0.15, C(1.12), 0.29, false));
    chest.add(mk(new THREE.BoxGeometry(0.12, 0.05, 0.085), matPad, i * 0.15, C(1.22), 0.29, false));
  }
  const pack = mk(new THREE.BoxGeometry(0.44, 0.5, 0.2), matVest, 0, C(1.25), -0.29);
  chest.add(pack);
  const roll = mk(new THREE.CylinderGeometry(0.09, 0.09, 0.46, 8),
    matRoll,
    0, C(1.52), -0.29, false);
  roll.rotation.z = Math.PI / 2; chest.add(roll);
  chest.add(mk(new THREE.BoxGeometry(0.64, 0.09, 0.40),
    matStripe,
    0, C(1.44), 0, false));
  for (const sx of [-0.38, 0.38]) chest.add(mk(new THREE.BoxGeometry(0.18, 0.1, 0.24), matVest, sx, C(1.52), 0, false));

  // --- neck > head: the head can track independently of the torso ---
  const neck = new THREE.Group();
  neck.position.y = C(1.58);
  chest.add(neck);
  const N = (y) => y - 1.58; // world-height -> neck-local
  const head = mk(new THREE.BoxGeometry(0.32, 0.32, 0.32), matSkin, 0, N(1.76), 0);
  neck.add(head);
  let beard = null, scarf = null, glass = null;
  if (team === 't') {
    beard = mk(new THREE.BoxGeometry(0.3, 0.12, 0.05), matBeard, 0, N(1.66), 0.16, false);
    neck.add(beard);
    scarf = mk(new THREE.BoxGeometry(0.36, 0.12, 0.36), matScarf, 0, N(1.56), 0, false);
    neck.add(scarf);
  } else {
    glass = mk(new THREE.BoxGeometry(0.3, 0.1, 0.05), matGlass, 0, N(1.79), 0.17, false);
    neck.add(glass);
  }
  const helmet = mk(new THREE.BoxGeometry(0.4, 0.18, 0.42), matHelmet, 0, N(1.98), 0);
  neck.add(helmet);
  const helmBand = mk(new THREE.BoxGeometry(0.42, 0.05, 0.44), matVest, 0, N(1.92), 0, false);
  neck.add(helmBand);
  let nvg = null, tail = null;
  if (team === 'ct') {
    nvg = mk(new THREE.BoxGeometry(0.12, 0.1, 0.08), matPad, 0, N(1.95), 0.24, false);
    neck.add(nvg);
  } else {
    tail = mk(new THREE.BoxGeometry(0.3, 0.22, 0.04), matHelmet, 0, N(1.86), -0.22, false);
    tail.rotation.x = 0.2; neck.add(tail);
  }

  // --- arms: shoulder > elbow, so the forearm folds instead of shearing ---
  const UPPER = 0.36, FORE = 0.28;
  const mkArm = (sx) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(sx, C(1.46), 0);
    shoulder.add(mk(new THREE.BoxGeometry(0.17, UPPER, 0.19), matBody, 0, -UPPER / 2, 0));
    shoulder.add(mk(new THREE.BoxGeometry(0.18, 0.08, 0.2), matCuff, 0, -UPPER + 0.03, 0, false));
    const elbow = new THREE.Group();
    elbow.position.y = -UPPER;
    elbow.add(mk(new THREE.BoxGeometry(0.15, FORE, 0.16), matSkin, 0, -FORE / 2, 0));
    const glove = mk(new THREE.BoxGeometry(0.15, 0.12, 0.16), matGlove, 0, -FORE - 0.05, 0, false);
    elbow.add(glove);
    shoulder.add(elbow);
    chest.add(shoulder);
    // rifle-carry rest pose: upper arm down-and-forward, forearm folded up to the grip
    shoulder.rotation.x = -0.55;
    elbow.rotation.x = -0.85;
    return { shoulder, elbow, glove };
  };
  const AL = mkArm(-0.41), AR = mkArm(0.41);

  // --- world gun, carried by the chest so it tracks the torso ---
  const gunG = new THREE.Group();
  gunG.add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.55), matGun));
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.42, 6), matGun);
  barrel.rotation.x = Math.PI / 2; barrel.position.z = 0.47; gunG.add(barrel);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.22, 0.1), matGun);
  mag.position.set(0, -0.15, 0.05); mag.rotation.x = 0.35; gunG.add(mag);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.11, 0.28),
    matStock);
  stock.position.z = -0.4; gunG.add(stock);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.03), matGun);
  sight.position.set(0, 0.1, 0.18); gunG.add(sight);
  gunG.position.set(0.22, C(1.25), 0.55);
  gunG.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  chest.add(gunG);

  const headParts = [head, helmet, helmBand];
  if (beard) headParts.push(beard);
  if (scarf) headParts.push(scarf);
  if (glass) headParts.push(glass);
  if (nvg) headParts.push(nvg);
  if (tail) headParts.push(tail);

  g.userData = {
    // legacy keys — legL/armL/torso are the HIP / SHOULDER / SPINE pivots now
    legL: L.hip, legR: R.hip, armL: AL.shoulder, armR: AR.shoulder, torso: spine,
    head, helmet, helmBand, beard, scarf, glass, nvg, tail, headParts,
    bootL: L.boot, bootR: R.boot, vest, pack,
    gun: gunG, gunG, team, stump: null,
    // rig
    rig: {
      pelvis, spine, chest, neck, head, gun: gunG, torsoMesh: torso,
      hipL: L.hip, kneeL: L.knee, ankleL: L.ankle,
      hipR: R.hip, kneeR: R.knee, ankleR: R.ankle,
      shoulderL: AL.shoulder, elbowL: AL.elbow,
      shoulderR: AR.shoulder, elbowR: AR.elbow,
      hipY: HIP_Y, thigh: THIGH, shin: SHIN,
    },
    // per-entity animation state, owned by animateSoldier()
    anim: null,
  };
  return g;
}

// soft blob shadow grounds characters where the sun map goes soft
export function makeBlob(scale = 1.1) {
  try {
    const T = decalTextures();
    const m = new THREE.Mesh(new THREE.PlaneGeometry(scale, scale),
      new THREE.MeshBasicMaterial({ map: T.blob, transparent: true, depthWrite: false, opacity: 0.85 }));
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = 1;
    scene.add(m);
    return m;
  } catch (e) { return null; }
}
export function updateBlob(entry, x, z, alive, moving) {
  try {
    if (!entry.blob) entry.blob = makeBlob(1.25);
    if (!entry.blob) return;
    entry.blob.position.set(x, 0.02, z);
    entry.blob.material.opacity = alive ? (moving ? 0.7 : 0.85) : 0.5;
    const s = alive ? 1.25 : 1.5;
    entry.blob.scale.set(s, s, 1);
    entry.blob.visible = true;
  } catch (e) {}
}

