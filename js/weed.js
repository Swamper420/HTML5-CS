// js/weed.js — AGENTS: mid-map weed farm: soil beds + plants, hold-E harvest ($100/s), trip hallucination that grows with harvest.
// Ownership: WEED state, buildWeed, updateWeed, resetWeed. Money via addMoney; bomb E always wins.

import * as THREE from 'three';
import { AudioSys } from './audio.js';
import { clamp, rand } from './utils.js';
import { playerNearPlantedBomb, playerInPlantSite } from './combat.js';
import { setPickupHint } from './pickups.js';
import { camera, renderer, scene } from './render.js';
import { G, addMoney, keys, player } from './state.js';

export const WEED = {
  x: -8, z: 0, r: 3.6, rate: 100,
  trip: 0, earned: 0, pending: 0,
  harvesting: false, _tick: 0, _cashAt: 0, _hintOurs: false,
};
const plants = [];
let _overlay = null;

// Realistic cannabis look, cheap: one baked palmate-cluster texture (7 serrated
// leaflets fanning from a petiole) on crossed alpha planes + stem + cola bud.
// One texture/material shared by every plant — variety comes from yaw/scale.
let _clusterMats = null;
let _stemMat = null, _budMat2 = null, _pistilMat = null;
let _stemGeo = null, _budGeo = null, _hairGeo = null, _leafGeo = null;

function paintLeaflet(g, len, wid, tone) {
  // origin at leaflet base, pointing up (-Y). Serrated lanceolate, widest ~40% out.
  const steps = 22, R = [], L = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const prof = t < 0.4 ? 0.25 + 1.875 * t : 1 - (t - 0.4) / 0.6 * 0.95;
    const tooth = i % 2 ? 1 : 0.8;
    const w = Math.max(0.5, wid * prof * tooth);
    R.push([w, -t * len]); L.push([-w, -t * len]);
  }
  g.beginPath();
  g.moveTo(0, 0);
  for (const [x, y] of R) g.lineTo(x, y);
  g.lineTo(0, -len);
  for (let i = L.length - 1; i >= 0; i--) g.lineTo(L[i][0], L[i][1]);
  g.closePath();
  g.fillStyle = tone; g.fill();
  // toothed rim shade
  g.strokeStyle = 'rgba(20,60,20,0.55)'; g.lineWidth = 2; g.stroke();
  // central vein + side veins to each tooth
  g.strokeStyle = 'rgba(220,255,200,0.75)'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, -4); g.lineTo(0, -len + 4); g.stroke();
  g.lineWidth = 1.4; g.strokeStyle = 'rgba(220,255,200,0.4)';
  g.beginPath();
  for (let i = 2; i <= steps; i += 2) {
    const t = i / steps, y = -t * len;
    const prof = t < 0.4 ? 0.25 + 1.875 * t : 1 - (t - 0.4) / 0.6 * 0.95;
    const w = wid * prof;
    g.moveTo(0, y); g.lineTo(w * 0.9, y - 8);
    g.moveTo(0, y); g.lineTo(-w * 0.9, y - 8);
  }
  g.stroke();
}
function clusterTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 512, 512);
  const tones = ['#2f7a2e', '#357f2f', '#2a6e2b', '#3a8a33', '#2e7530', '#388232', '#2c7030'];
  // petiole point near bottom-center; 7 leaflets fan upward
  const px = 256, py = 470;
  for (let k = -3; k <= 3; k++) {
    const ang = k * 0.38; // ~22° apart
    const len = 205 - Math.abs(k) * 30;
    const wid = 36 - Math.abs(k) * 4;
    g.save();
    g.translate(px, py); g.rotate(ang);
    paintLeaflet(g, len, wid, tones[k + 3]);
    g.restore();
  }
  // petiole stalk
  g.strokeStyle = '#4a6b2f'; g.lineWidth = 8; g.lineCap = 'round';
  g.beginPath(); g.moveTo(px, py); g.lineTo(px, 508); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
function weedAssets() {
  if (!_clusterMats) {
    const tex = clusterTexture();
    // 3 tints for variety, same texture
    _clusterMats = [0xffffff, 0xd6e8c8, 0xb9d0a5].map((tint) => new THREE.MeshStandardMaterial({
      map: tex, color: tint, roughness: 0.9, metalness: 0,
      side: THREE.DoubleSide, transparent: true, alphaTest: 0.42,
    }));
  }
  if (!_stemMat) {
    _stemMat = new THREE.MeshStandardMaterial({ color: 0x4f7031, roughness: 1 });
    _budMat2 = new THREE.MeshStandardMaterial({ color: 0x5d8f3e, roughness: 1 });
    _pistilMat = new THREE.MeshStandardMaterial({ color: 0xd97a2b, roughness: 0.9 });
    _stemGeo = new THREE.CylinderGeometry(0.022, 0.038, 1, 5);
    _budGeo = new THREE.IcosahedronGeometry(0.085, 1);
    _hairGeo = new THREE.ConeGeometry(0.008, 0.07, 4);
    _leafGeo = new THREE.PlaneGeometry(1, 1);
  }
}
function makeRealPlant() {
  weedAssets();
  const g = new THREE.Group();
  const h = rand(0.9, 1.3);
  const stem = new THREE.Mesh(_stemGeo, _stemMat);
  stem.scale.y = h; stem.position.y = h / 2;
  stem.castShadow = true;
  g.add(stem);
  // 4 leaf clusters up the stem: big low, small high
  const mat = _clusterMats[(Math.random() * _clusterMats.length) | 0];
  for (let n = 0; n < 4; n++) {
    const f = 0.34 + n * 0.2; // height fraction
    const size = (n < 2 ? rand(0.95, 1.15) : rand(0.6, 0.85));
    const yaw = Math.random() * Math.PI * 2;
    for (let k = 0; k < 2; k++) {
      const leaf = new THREE.Mesh(_leafGeo, mat);
      leaf.position.y = h * f;
      leaf.rotation.set(-0.35 + rand(-0.1, 0.1), yaw + k * Math.PI / 2, 0);
      leaf.scale.setScalar(size);
      leaf.castShadow = true;
      // offset base toward the stem so the petiole reads attached
      leaf.position.x = Math.cos(yaw) * 0.12; leaf.position.z = Math.sin(yaw) * 0.12;
      g.add(leaf);
    }
  }
  // cola bud: stacked buds + orange pistil hairs
  const bud = new THREE.Mesh(_budGeo, _budMat2);
  bud.position.y = h + 0.05; bud.scale.set(1, 1.7, 1);
  bud.castShadow = true;
  g.add(bud);
  const bud2 = new THREE.Mesh(_budGeo, _budMat2);
  bud2.position.y = h - 0.12; bud2.scale.setScalar(0.7);
  g.add(bud2);
  for (let i = 0; i < 3; i++) {
    const hair = new THREE.Mesh(_hairGeo, _pistilMat);
    hair.position.set(rand(-0.05, 0.05), h + rand(0.0, 0.12), rand(-0.05, 0.05));
    hair.rotation.set(rand(-0.6, 0.6), 0, rand(-0.6, 0.6));
    g.add(hair);
  }
  return g;
}

export function buildWeed() {
  const soilMat = new THREE.MeshStandardMaterial({ color: 0x4a3220, roughness: 1 });
  const soilDark = new THREE.MeshStandardMaterial({ color: 0x3a2618, roughness: 1 });
  for (const bz of [2.8, -2.8]) {
    const bed = new THREE.Mesh(new THREE.BoxGeometry(3, 0.25, 2), soilMat);
    bed.position.set(WEED.x, 0.12, bz);
    bed.receiveShadow = true; bed.castShadow = true;
    scene.add(bed);
    // irrigation rows
    for (let i = -1; i <= 1; i++) {
      const row = new THREE.Mesh(new THREE.BoxGeometry(3, 0.08, 0.12), soilDark);
      row.position.set(WEED.x, 0.26, bz + i * 0.6);
      scene.add(row);
    }
    // 10 plants per bed, jittered on the rows
    for (let i = 0; i < 10; i++) {
      const g = makeRealPlant();
      const s = rand(0.8, 1.3);
      g.scale.setScalar(s);
      g.position.set(WEED.x + rand(-1.3, 1.3), 0.25, bz + [-0.6, 0, 0.6][i % 3] + rand(-0.12, 0.12));
      g.rotation.y = Math.random() * Math.PI * 2;
      scene.add(g);
      plants.push({ g, phase: Math.random() * 10 });
    }
  }
  // signpost so mid players read it instantly
  try {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const gg = c.getContext('2d');
    gg.fillStyle = '#1b3a1b'; gg.fillRect(0, 0, 256, 64);
    gg.strokeStyle = '#9dff6a'; gg.lineWidth = 4; gg.strokeRect(3, 3, 250, 58);
    gg.fillStyle = '#9dff6a'; gg.font = '900 34px Arial'; gg.textAlign = 'center'; gg.textBaseline = 'middle';
    gg.fillText('🌿 WEED  $100/s', 128, 34);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, side: THREE.DoubleSide }));
    sign.position.set(WEED.x + 1.8, 1.4, 0); sign.rotation.y = Math.PI / 2;
    scene.add(sign);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 6),
      new THREE.MeshStandardMaterial({ color: 0x5e3f1e, roughness: 1 }));
    post.position.set(WEED.x + 1.8, 0.7, 0); post.castShadow = true;
    scene.add(post);
  } catch (e) {}
}

export function resetWeed() {
  WEED.trip = 0; WEED.earned = 0; WEED.pending = 0; WEED.harvesting = false; WEED._hintOurs = false; WEED._cashAt = 0;
  try { if (_overlay) _overlay.style.opacity = 0; } catch (e) {}
  try { if (renderer && renderer.domElement) renderer.domElement.style.filter = ''; } catch (e) {}
}

function tripOverlay() {
  if (!_overlay) { try { _overlay = document.getElementById('trip-overlay'); } catch (e) {} }
  return _overlay;
}

export function updateWeed(dt, t) {
  // sway the crop
  for (const p of plants) p.g.rotation.z = Math.sin(t * 1.4 + p.phase) * 0.07;
  if (G.phase !== 'playing') return;
  const el = tripOverlay();
  const bombBusy = playerNearPlantedBomb() || playerInPlantSite();
  const d = Math.hypot(player.pos.x - WEED.x, player.pos.z - WEED.z);
  const inZone = d < WEED.r;
  WEED.harvesting = false;
  if (player.alive && !G.roundEnding && !G.buyOpen && inZone && !bombBusy && keys['KeyE'] && player.onGround) {
    WEED.harvesting = true;
    WEED.pending += WEED.rate * dt;
    const whole = Math.floor(WEED.pending);
    if (whole > 0) { WEED.pending -= whole; addMoney(whole); WEED.earned += whole; }
    // ponytail: full trip after ~18s on the crop, never sobers up mid-round — resetWeed() on round start only
    WEED.trip = clamp(WEED.trip + dt * 0.055, 0, 1);
    if (t - WEED._tick > 0.5) {
      WEED._tick = t;
      try { AudioSys.rustle(); } catch (e) {}
      const lvl = Math.floor(WEED.earned / 100);
      if (lvl > (WEED._cashAt || 0)) { WEED._cashAt = lvl; try { AudioSys.cash(); } catch (e2) {} }
    }
    setPickupHint(`🌿 HARVESTING +$${WEED.rate}/s · +$${WEED.earned} this round`);
    WEED._hintOurs = true;
  } else {
    if (player.alive && !G.roundEnding && inZone && !bombBusy && !keys['KeyE']) {
      setPickupHint(`HOLD E — HARVEST 🌿 +$${WEED.rate}/s`);
      WEED._hintOurs = true;
    } else if (WEED._hintOurs) {
      WEED._hintOurs = false;
      try { setPickupHint(''); } catch (e) {}
    }
  }
  // hallucination: wobble cam + breathe the render + wash the screen
  const k = WEED.trip;
  if (k > 0.02 && camera && player.alive) {
    camera.rotation.z += Math.sin(t * 1.7) * 0.06 * k;
    camera.rotation.x += Math.sin(t * 2.3 + 1) * 0.022 * k;
    camera.rotation.y += Math.sin(t * 1.1 + 2) * 0.03 * k;
  }
  try {
    if (renderer && renderer.domElement) {
      renderer.domElement.style.filter = k > 0.02
        ? `hue-rotate(${(Math.sin(t * 0.9) * 60 * k).toFixed(1)}deg) saturate(${(1 + k * 1.6).toFixed(2)}) contrast(${(1 + k * 0.12).toFixed(2)})`
        : '';
    }
  } catch (e) {}
  try {
    if (el) el.style.opacity = (k * 0.85).toFixed(3);
  } catch (e) {}
}
