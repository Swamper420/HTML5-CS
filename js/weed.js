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
  harvesting: false, _tick: 0, _hintOurs: false,
};
const plants = [];
let _overlay = null;

export function buildWeed() {
  const soilMat = new THREE.MeshStandardMaterial({ color: 0x4a3220, roughness: 1 });
  const soilDark = new THREE.MeshStandardMaterial({ color: 0x3a2618, roughness: 1 });
  const leafMats = [0x2e7d32, 0x388e3c, 0x43a047, 0x1b5e20].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
  const budMat = new THREE.MeshStandardMaterial({ color: 0x7b1fa2, roughness: 0.8 });
  const coneGeo = new THREE.ConeGeometry(0.3, 1.0, 6);
  const budGeo = new THREE.SphereGeometry(0.12, 6, 5);
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
      const g = new THREE.Group();
      const leaf = new THREE.Mesh(coneGeo, leafMats[(Math.random() * leafMats.length) | 0]);
      leaf.position.y = 0.5; leaf.castShadow = true;
      g.add(leaf);
      const bud = new THREE.Mesh(budGeo, budMat);
      bud.position.y = 0.95;
      g.add(bud);
      const s = rand(0.7, 1.25);
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
  WEED.trip = 0; WEED.earned = 0; WEED.pending = 0; WEED.harvesting = false; WEED._hintOurs = false;
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
      try { AudioSys.click(900 + Math.random() * 500, 0.07, 0.22); } catch (e) {}
      setTimeout(() => { try { AudioSys.click(1400 + Math.random() * 400, 0.05, 0.15); } catch (e2) {} }, 90);
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
