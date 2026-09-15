// js/viewmodel.js — AGENTS: First-person gun (viewmodel): rig, hip/ADS poses, gloved hands, iron-sight solving, muzzle flash texture.
// Ownership: viewmodel + vm* parts, vmRig, VM_HIP/VM_AIM, buildViewmodel. Gun geometry comes from gunmodels.js.

import * as THREE from 'three';
import { WEAPONS, isNadeKey } from './config.js';
import { makeFirstPersonNadeMesh } from './grenades.js';
import { buildGunModel, gunMats } from './gunmodels.js';
import { camera, scene } from './render.js';
import { player } from './state.js';

export let viewmodel = null, vmMuzzle = null, vmBase = null, vmKickG = null, vmFlashGroup = null, vmBolt = null, vmMag = null;
export let vmL = null; // left-hand gun when dual wielding: { base, kick, mag, muzzle, flash }
// Iron-sight reference points: the top of the rear notch and the tip of the front
// post. The eye sits at the camera origin, so a correct sight picture means both of
// these land dead on the camera's -Z axis. VM_AIM alone can only translate the gun,
// which cannot level a sight line that is not already parallel to the view.
export let vmSightRear = null, vmSightFront = null, vmStockParts = [];
export const VM_AIM_SOLVED = {};
export const vmRig = {
  kickZ: 0, kickV: 0, kickRot: 0, kickRotV: 0,   // spring state
  kickZL: 0, kickVL: 0, kickRotL: 0, kickRotVL: 0, // left gun (dual wield)
  roll: 0,                                         // camera roll kick (dual recoil)
  swayX: 0, swayY: 0, bobT: 0, aimK: 0, drawT: 1, landK: 0, busyK: 0,
  fovKick: 0, punchP: 0, punchY: 0, shake: 0,
  muzzleT: 0, boltT: 0,
};
export const VM_HIP = new THREE.Vector3(0.24, -0.235, -0.42);
export const VM_AIM = {
  ak: new THREE.Vector3(0.0, -0.082, -0.32),
  deagle: new THREE.Vector3(0.0, -0.084, -0.30),
  awp: new THREE.Vector3(0.0, -0.107, -0.34),
  p90: new THREE.Vector3(0.0, -0.100, -0.30),
  he: new THREE.Vector3(0.0, -0.10, -0.32),
  flash: new THREE.Vector3(0.0, -0.10, -0.32),
  smoke: new THREE.Vector3(0.0, -0.10, -0.32),
  molotov: new THREE.Vector3(0.0, -0.10, -0.32),
};
function makeFlashTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,230,1)');
  grad.addColorStop(0.25, 'rgba(255,210,110,0.95)');
  grad.addColorStop(0.55, 'rgba(255,130,30,0.55)');
  grad.addColorStop(1, 'rgba(255,80,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  // star spikes
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,240,180,0.9)'; g.lineWidth = 6; g.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI + 0.4;
    g.beginPath();
    g.moveTo(64 - Math.cos(a) * 60, 64 - Math.sin(a) * 60);
    g.lineTo(64 + Math.cos(a) * 60, 64 + Math.sin(a) * 60);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
let _flashTex = null;

export function vmMats() {
  return {
    metal: new THREE.MeshStandardMaterial({ color: 0x232327, roughness: 0.36, metalness: 0.85 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x131315, roughness: 0.5, metalness: 0.6 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x9aa0ab, roughness: 0.28, metalness: 0.92 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x7c4f27, roughness: 0.72, metalness: 0.05 }),
    woodD: new THREE.MeshStandardMaterial({ color: 0x5a381b, roughness: 0.8 }),
    olive: new THREE.MeshStandardMaterial({ color: 0x4d5c3a, roughness: 0.75, metalness: 0.08 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x1c1c1f, roughness: 0.9 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x2e3138, roughness: 0.92 }),
    gloveD: new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.95 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xc9a06b, roughness: 0.8 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.9 }),
    glowG: new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x39ff6a, emissiveIntensity: 1.6 }),
    glowW: new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xfff2cc, emissiveIntensity: 1.2 }),
    lens: new THREE.MeshBasicMaterial({ color: 0x86c5ff, transparent: true, opacity: 0.85 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xb8bec9, roughness: 0.22, metalness: 0.95 }),
  };
}
// Gloved hands with sleeves. Grip hand wraps a vertical grip; support hand cradles the fore-end.
// forearm sleeve: starts at the wrist and runs back toward the camera's lower edge
function vmSleeve(parent, M, wrist, dir, len) {
  const d = dir.clone().normalize();
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.05, 12), M.gloveK);
  const sl = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.052, len, 12), M.sleeve);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), d);
  cuff.quaternion.copy(q); cuff.position.copy(wrist).addScaledVector(d, 0.02);
  sl.quaternion.copy(q); sl.position.copy(wrist).addScaledVector(d, 0.04 + len / 2);
  parent.add(cuff); parent.add(sl);
}
function vmGripHand(parent, M, f, y, pitch) {
  const g = new THREE.Group(); g.position.set(0, y, -f); g.rotation.x = pitch; parent.add(g);
  const cap = (r, len, mat, x, yy, z, rx, ry, rz) => { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mat); m.position.set(x, yy, z); m.rotation.set(rx, ry, rz); g.add(m); return m; };
  const box = (w, h, d, mat, x, yy, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, yy, z); g.add(m); return m; };
  box(0.03, 0.085, 0.07, M.gloveK, 0.042, -0.035, 0.005);          // back of hand (outside)
  box(0.075, 0.03, 0.035, M.gloveK, 0.004, 0.0, 0.03);              // web over the backstrap
  for (let i = 0; i < 3; i++) cap(0.0115, 0.05, M.gloveK, 0.004, -0.03 - i * 0.025, -0.036, 0, 0, Math.PI / 2); // wrapped fingers
  cap(0.0105, 0.045, M.gloveK, 0.03, 0.022, -0.05, Math.PI / 2 - 0.25, 0, 0);  // trigger finger
  cap(0.012, 0.04, M.gloveK, -0.036, -0.004, -0.004, 0.7, 0, 0);    // thumb
  vmSleeve(parent, M, new THREE.Vector3(0.02, y - 0.07, -f + 0.05), new THREE.Vector3(0.12, -0.5, 0.55), 0.5);
  return g;
}
function vmSupportHand(parent, M, f, y, halfW) {
  const g = new THREE.Group(); g.position.set(0, y, -f); parent.add(g);
  const cap = (r, len, x, yy, z, rx, rz) => { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), M.gloveK); m.position.set(x, yy, z); m.rotation.set(rx, 0, rz); g.add(m); return m; };
  const palm = new THREE.Mesh(new THREE.BoxGeometry(halfW * 2 + 0.02, 0.026, 0.085), M.gloveK); palm.position.set(-0.005, -0.012, 0); g.add(palm);
  for (let i = 0; i < 4; i++) cap(0.0105, 0.035, halfW + 0.008, 0.012, -0.03 + i * 0.021, 0, 0.35); // fingertips up the right side
  cap(0.012, 0.045, -halfW - 0.008, 0.01, 0.01, 0.5, -0.3);           // thumb along the left
  vmSleeve(parent, M, new THREE.Vector3(-0.02, y - 0.03, -f + 0.03), new THREE.Vector3(-0.35, -0.42, 0.6), 0.7);
  return g;
}
export function buildGunHands(key, M, root) {
  if (key === 'ak') { vmGripHand(root, M, -0.03, -0.05, 0.42); vmSupportHand(root, M, 0.55, -0.045, 0.031); }
  else if (key === 'p90') { vmGripHand(root, M, 0.005, -0.075, 0.2); vmSupportHand(root, M, 0.2, -0.13, 0.033); }
  else if (key === 'deagle') { vmGripHand(root, M, -0.02, -0.055, 0.3); const s = vmSupportHand(root, M, 0.0, -0.14, 0.03); s.rotation.set(0.3, 0, -0.35); s.position.x = -0.02; }
  else if (key === 'awp') { vmGripHand(root, M, 0.03, -0.06, 0.4); vmSupportHand(root, M, 0.42, -0.048, 0.031); }
}

export function buildViewmodel(key) {
  if (viewmodel) { camera.remove(viewmodel); }
  if (!_flashTex) _flashTex = makeFlashTexture();
  const M = gunMats();
  viewmodel = new THREE.Group();
  vmBase = new THREE.Group();
  vmKickG = new THREE.Group();
  vmBolt = null;
  vmSightRear = vmSightFront = null; vmStockParts = [];
  viewmodel.add(vmBase); vmBase.add(vmKickG);
  vmMag = new THREE.Group(); vmKickG.add(vmMag); // magazine rides its own group so it can drop
  vmBase.position.copy(VM_HIP);
  const add = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.frustumCulled = false;
    parent.add(m); return m;
  };
  const B = (parent, w, h, d, mat, x, y, z, rx, ry, rz) => add(parent, new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz);
  const C = (parent, rt, rb, h, mat, x, y, z, rx = 0, seg = 12) => add(parent, new THREE.CylinderGeometry(rt, rb, h, seg), mat, x, y, z, rx);

  if (WEAPONS[key]) {
    const gm = buildGunModel(key, M, vmKickG, vmMag, { hands: true });
    vmMuzzle = gm.muzzle; vmBolt = gm.bolt;
    vmSightRear = gm.rear; vmSightFront = gm.front; vmStockParts = gm.stock;
    vmMag.userData.top = key === 'p90'; // P90 mag lifts off the top instead of dropping
  } else if (isNadeKey(key)) {
    // First-person: hi-def version of third-person silhouette, easy to tell apart.
    const nm = makeFirstPersonNadeMesh(key);
    nm.position.set(0, -0.02, -0.30);
    vmKickG.add(nm);
    // hand holding it
    B(vmKickG, 0.075, 0.080, 0.085, M.glove, 0, -0.115, -0.24, 0.35);
    B(vmKickG, 0.030, 0.055, 0.060, M.glove, 0.045, -0.08, -0.27, 0.35);
    vmMuzzle = new THREE.Object3D(); vmMuzzle.position.set(0, -0.02, -0.34); vmKickG.add(vmMuzzle);
  } else {
    // fallback (unknown key -> AWP silhouette safety)
    vmMuzzle = new THREE.Object3D(); vmMuzzle.position.set(0, 0.010, -1.02); vmKickG.add(vmMuzzle);
  }
  // ---- muzzle flash rig (star sprite + crossed planes + smoke anchor) ----
  const makeFlashRig = (kickG, muzzle) => {
    const grp = new THREE.Group();
    grp.position.copy(muzzle.position);
    const flashMat = new THREE.MeshBasicMaterial({ map: _flashTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const f1 = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), flashMat);
    f1.name = 'flash'; f1.frustumCulled = false;
    const f2 = f1.clone(); f2.rotation.z = Math.PI / 2;
    const fwd = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.42), flashMat);
    fwd.rotation.y = Math.PI / 2; fwd.position.z = -0.08; fwd.frustumCulled = false;
    grp.add(f1); grp.add(f2); grp.add(fwd);
    kickG.add(grp);
    kickG.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    return grp;
  };
  vmFlashGroup = makeFlashRig(vmKickG, vmMuzzle);
  // ---- dual wield: a second gun in the left hand ----
  vmL = null;
  const wOwn = player && player.weapons && player.weapons[key];
  if (WEAPONS[key] && wOwn && wOwn.owned && wOwn.dual) {
    const base = new THREE.Group(), kick = new THREE.Group(), mag = new THREE.Group();
    base.add(kick); kick.add(mag); viewmodel.add(base);
    const gmL = buildGunModel(key, M, kick, mag, { hands: true });
    const muzzle = gmL.muzzle || (() => { const o = new THREE.Object3D(); o.position.set(0, 0.01, -0.5); kick.add(o); return o; })();
    vmL = { base, kick, mag, muzzle, flash: makeFlashRig(kick, muzzle) };
    base.position.set(-VM_HIP.x, VM_HIP.y - 0.22, VM_HIP.z);
    vmRig.kickZL = 0; vmRig.kickVL = 0; vmRig.kickRotL = 0; vmRig.kickRotVL = 0;
  }

  // rig reset + draw animation
  vmRig.kickZ = 0; vmRig.kickV = 0; vmRig.kickRot = 0; vmRig.kickRotV = 0;
  vmRig.drawT = 0; vmRig.aimK = player && player.aiming ? 1 : 0;
  vmBase.position.copy(VM_HIP);
  vmBase.position.y -= 0.22; vmBase.rotation.x = 0.55;
  camera.add(viewmodel);
  scene.add(camera);
  VM_AIM_SOLVED[key] = solveIronSights(key);
}
// Work out the ADS pose that actually lines the sights up with the shot.
// Bullets leave along the camera's -Z axis, so we solve for the gun rotation that
// levels the rear notch with the front post, then for the offset that drops that
// line onto the eye axis. Done once per weapon build, off the rest pose, so runtime
// recoil, bob and sway still move the gun normally.
function solveIronSights(key) {
  if (!vmSightRear || !vmSightFront || !vmBase || !vmKickG || !camera) return null;
  const base = VM_AIM[key] || VM_AIM.ak;
  const sp = vmBase.position.clone(), sr = vmBase.rotation.clone();
  const kp = vmKickG.position.clone(), kr = vmKickG.rotation.clone();
  vmKickG.position.set(0, 0, 0); vmKickG.rotation.set(0, 0, 0);
  const pos = base.clone();
  let pitch = 0, yaw = 0;
  const rear = new THREE.Vector3(), front = new THREE.Vector3();
  try {
    camera.updateMatrixWorld(true);
    for (let i = 0; i < 5; i++) {
      vmBase.position.copy(pos);
      vmBase.rotation.set(pitch, yaw, 0);
      viewmodel.updateMatrixWorld(true);
      vmSightRear.getWorldPosition(rear); camera.worldToLocal(rear);
      vmSightFront.getWorldPosition(front); camera.worldToLocal(front);
      const dz = rear.z - front.z; // how far the front sight sits beyond the rear
      if (dz > 1e-4) {
        pitch += Math.atan2(rear.y - front.y, dz); // level the sight line
        yaw += Math.atan2(front.x - rear.x, dz);
      }
      pos.x -= rear.x; pos.y -= rear.y;            // drop it onto the eye axis
    }
  } catch (e) { return null; }
  vmBase.position.copy(sp); vmBase.rotation.copy(sr);
  vmKickG.position.copy(kp); vmKickG.rotation.copy(kr);
  try { viewmodel.updateMatrixWorld(true); } catch (e) {}
  return { pos, pitch, yaw };
}

