// js/map.js — AGENTS: de_dust-style level geometry, colliders, waypoints, spawn points, ambient props (palms, lamps, birds, tumbleweed).
// Ownership: colliders[], waypoints[], spawns{}, buildMap/addSolid. EDIT the level here.

import * as THREE from 'three';
import { MAP_HALF, SITES } from './config.js';
import { rand } from './utils.js';
import { collidesAt } from './collision.js';
import {
  blotchPass, bumpBlotch, grainPass, makeCanvasTexture, makePBRTexture, maxAniso, scene,
} from './render.js';

export const colliders = [];   // THREE.Box3[]
export const waypoints = [];
export const spawns = { ct: [], t: [] };

function addSolid(x, y, z, sx, sy, sz, mat, collide = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  if (collide) {
    const box = new THREE.Box3().setFromObject(m);
    colliders.push(box);
  }
  return m;
}

// ambient-life registries (filled during buildMap, animated in updateEffects)
export const palmFronds = [], lampLightsArr = [], birdsArr = [];
export let tumbleweed = null, tumbleVel = null;

export function buildMap() {
  // ---- Realistic procedural PBR textures (color + bump, tileable core) ----
  const groundPBR = makePBRTexture((g, b, s) => {
    g.fillStyle = '#ab8e60'; g.fillRect(0, 0, s, s);
    blotchPass(g, s, 110, ['#c2a878', '#9a7d52', '#b89a6c', '#8f744e', '#c9b184'], 24, 110, 0.16);
    blotchPass(g, s, 46, ['#7d6a4d', '#cbb587', '#6f5c3e'], 8, 34, 0.10);
    // sun-bleached patches
    blotchPass(g, s, 24, ['#d6c096', '#dcc9a0'], 30, 80, 0.08);
    // fine sand grain
    grainPass(g, s, 5200, 0.5, 'rgb(255,240,210)', 'rgb(48,34,18)', 1, 2.5);
    // pebbles: light stone + contact shadow
    for (let i = 0; i < 210; i++) {
      const x = Math.random() * s, y = Math.random() * s, r = 1.5 + Math.random() * 3.2;
      g.fillStyle = 'rgba(40,28,14,0.35)';
      g.beginPath(); g.ellipse(x + 1, y + 1.2, r, r * 0.75, 0, 0, 7); g.fill();
      const tone = 150 + (Math.random() * 60 | 0);
      g.fillStyle = `rgb(${tone},${tone - 18},${tone - 45})`;
      g.beginPath(); g.ellipse(x, y, r, r * 0.75, Math.random(), 0, 7); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.beginPath(); g.ellipse(x - r * 0.3, y - r * 0.3, r * 0.4, r * 0.3, 0, 0, 7); g.fill();
    }
    // worn concrete slab joints (tileable 2x2)
    for (let k = 0; k <= 2; k++) {
      const p = k * s / 2;
      g.strokeStyle = 'rgba(52,38,20,0.55)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(s, p); g.stroke();
      g.strokeStyle = 'rgba(255,235,190,0.16)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(p + 2, 0); g.lineTo(p + 2, s); g.stroke();
      g.beginPath(); g.moveTo(0, p + 2); g.lineTo(s, p + 2); g.stroke();
      b.strokeStyle = 'rgba(0,0,0,0.85)'; b.lineWidth = 3;
      b.beginPath(); b.moveTo(p, 0); b.lineTo(p, s); b.stroke();
      b.beginPath(); b.moveTo(0, p); b.lineTo(s, p); b.stroke();
    }
    // hairline cracks
    g.strokeStyle = 'rgba(45,32,16,0.5)'; b.strokeStyle = 'rgba(0,0,0,0.7)';
    for (let i = 0; i < 8; i++) {
      let x = Math.random() * s, y = Math.random() * s;
      g.lineWidth = 1.4; b.lineWidth = 2;
      g.beginPath(); g.moveTo(x, y); b.beginPath(); b.moveTo(x, y);
      for (let j = 0; j < 6; j++) { x += (Math.random() - 0.5) * 46; y += (Math.random() - 0.5) * 46; g.lineTo(x, y); b.lineTo(x, y); }
      g.stroke(); b.stroke();
    }
    // dust settled in bump lows / highs
    bumpBlotch(b, s, 90, 12, 60, true);
    bumpBlotch(b, s, 70, 4, 20, false);
    // faint tire scuff arcs
    g.strokeStyle = 'rgba(60,48,28,0.18)'; g.lineWidth = 9;
    for (let i = 0; i < 3; i++) {
      g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 60 + Math.random() * 80, Math.random() * 3, Math.random() * 1.2 + 0.4); g.stroke();
    }
  }, 512, 11);
  const wallPBR = makePBRTexture((g, b, s) => {
    // sun-baked plaster gradient: pale top -> grimy base
    const grad = g.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0, '#d3bd92'); grad.addColorStop(0.62, '#c2a878');
    grad.addColorStop(0.85, '#a68d60'); grad.addColorStop(1, '#7d6742');
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
    blotchPass(g, s, 90, ['#d8c49a', '#b59a6b', '#cbb587', '#9c8459'], 18, 70, 0.14);
    // plaster chips exposing mudbrick
    for (let i = 0; i < 14; i++) {
      const x = Math.random() * s, y = s * 0.25 + Math.random() * s * 0.75;
      const w = 12 + Math.random() * 42, h = 8 + Math.random() * 22;
      g.fillStyle = '#8d6b42'; g.globalAlpha = 0.9; g.fillRect(x, y, w, h);
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(60,40,20,0.5)';
      for (let r = 0; r < 3; r++) g.fillRect(x, y + r * h / 3, w, 1.5);
      g.strokeStyle = 'rgba(255,240,210,0.5)'; g.lineWidth = 2; g.strokeRect(x, y, w, h);
      b.fillStyle = 'rgb(40,40,40)'; b.globalAlpha = 0.7; b.fillRect(x, y, w, h); b.globalAlpha = 1;
    }
    // rain / dust streaks running down
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * s, w = 3 + Math.random() * 9, h = 40 + Math.random() * 130;
      const sg = g.createLinearGradient(0, 0, 0, h);
      sg.addColorStop(0, 'rgba(70,55,30,0.20)'); sg.addColorStop(1, 'rgba(70,55,30,0)');
      g.fillStyle = sg;
      g.save(); g.translate(x, Math.random() * s * 0.4); g.fillRect(0, 0, w, h); g.restore();
    }
    // faint adobe brick courses showing through
    g.fillStyle = 'rgba(90,68,40,0.18)';
    for (let y = 0; y < s; y += 42) g.fillRect(0, y, s, 2);
    grainPass(g, s, 2600, 0.4, 'rgb(255,244,220)', 'rgb(70,54,30)', 1, 2);
    // whitewash band near top + grime near ground
    g.fillStyle = 'rgba(240,230,205,0.35)'; g.fillRect(0, 0, s, 14);
    const gg = g.createLinearGradient(0, s * 0.8, 0, s);
    gg.addColorStop(0, 'rgba(40,30,16,0)'); gg.addColorStop(1, 'rgba(40,30,16,0.42)');
    g.fillStyle = gg; g.fillRect(0, s * 0.8, s, s * 0.2);
    bumpBlotch(b, s, 80, 10, 50, true);
    bumpBlotch(b, s, 50, 4, 16, false);
  }, 512, 2);
  const cratePBR = makePBRTexture((g, b, s) => {
    g.fillStyle = '#7d5a2e'; g.fillRect(0, 0, s, s);
    // vertical planks with per-plank tone shift
    const planks = 4, pw = s / planks;
    for (let p = 0; p < planks; p++) {
      const l = (Math.random() - 0.5) * 26;
      g.fillStyle = `rgb(${125 + l | 0},${90 + l * 0.8 | 0},${46 + l * 0.5 | 0})`;
      g.fillRect(p * pw, 0, pw, s);
      // wood grain: long wavy streaks
      for (let i = 0; i < 26; i++) {
        g.strokeStyle = Math.random() < 0.7 ? 'rgba(60,38,14,0.28)' : 'rgba(255,220,160,0.14)';
        g.lineWidth = 1 + Math.random() * 1.4;
        const gx = p * pw + Math.random() * pw;
        g.beginPath(); g.moveTo(gx, 0);
        for (let y = 0; y <= s; y += 32) g.lineTo(gx + Math.sin(y * 0.05 + i) * 3, y);
        g.stroke();
      }
      // plank gap + bump groove
      g.fillStyle = 'rgba(25,14,4,0.85)'; g.fillRect(p * pw - 2, 0, 4, s);
      b.fillStyle = 'rgb(20,20,20)'; b.fillRect(p * pw - 2, 0, 4, s);
    }
    // knots
    for (let i = 0; i < 6; i++) {
      const x = Math.random() * s, y = Math.random() * s;
      for (let r = 7; r > 0; r -= 2) {
        g.strokeStyle = `rgba(48,28,10,${0.25 + (7 - r) * 0.08})`; g.lineWidth = 1.6;
        g.beginPath(); g.ellipse(x, y, r * 1.4, r, 0.3, 0, 7); g.stroke();
      }
      g.fillStyle = 'rgba(35,20,8,0.9)';
      g.beginPath(); g.ellipse(x, y, 3, 2.4, 0, 0, 7); g.fill();
    }
    // frame border (military crate) + wear highlight
    g.strokeStyle = '#5e3f1e'; g.lineWidth = 30; g.strokeRect(15, 15, s - 30, s - 30);
    g.strokeStyle = 'rgba(255,225,170,0.25)'; g.lineWidth = 3; g.strokeRect(32, 32, s - 64, s - 64);
    g.strokeStyle = 'rgba(20,10,2,0.6)'; g.lineWidth = 2; g.strokeRect(15, 15, s - 30, s - 30);
    // diagonal brace shadow
    g.save(); g.translate(s / 2, s / 2); g.rotate(Math.PI / 4);
    g.fillStyle = 'rgba(70,45,18,0.55)'; g.fillRect(-s * 0.75, -22, s * 1.5, 44);
    g.fillStyle = 'rgba(255,220,160,0.10)'; g.fillRect(-s * 0.75, -22, s * 1.5, 6);
    g.restore();
    // corner steel brackets + rivets
    for (const [cx, cy] of [[18, 18], [s - 18, 18], [18, s - 18], [s - 18, s - 18]]) {
      g.fillStyle = '#3d4148'; g.fillRect(cx - 14, cy - 14, 28, 28);
      g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(cx - 14, cy - 14, 28, 4);
      g.fillStyle = '#1c1e22';
      for (const [ox, oy] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) {
        g.beginPath(); g.arc(cx + ox, cy + oy, 3, 0, 7); g.fill();
      }
    }
    // faded stencil marking
    g.save();
    g.globalAlpha = 0.30; g.fillStyle = '#e8dcc0';
    g.font = `900 ${s * 0.11 | 0}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('7.62  •  AMMO', s / 2, s * 0.42);
    g.font = `700 ${s * 0.07 | 0}px Arial`;
    g.fillText('▲ THIS SIDE UP', s / 2, s * 0.58);
    g.restore();
    grainPass(g, s, 900, 0.25, 'rgb(255,225,170)', 'rgb(40,24,8)', 1, 2);
    bumpBlotch(b, s, 40, 8, 30, true);
  }, 512, 1);
  const darkPBR = makePBRTexture((g, b, s) => {
    g.fillStyle = '#7b7466'; g.fillRect(0, 0, s, s);
    blotchPass(g, s, 90, ['#8a8375', '#6a6355', '#948c7c', '#5d574b'], 20, 80, 0.16);
    grainPass(g, s, 3200, 0.45, 'rgb(220,215,200)', 'rgb(30,28,24)', 1, 2.5);
    // concrete formwork seams
    g.fillStyle = 'rgba(40,38,32,0.4)';
    for (let k = 0; k <= 2; k++) { const p = k * s / 2; g.fillRect(0, p - 1, s, 3); g.fillRect(p - 1, 0, 3, s); }
    // formwork tie holes
    for (let ix = 0; ix < 2; ix++) for (let iy = 0; iy < 2; iy++) {
      const x = (ix + 0.5) * s / 2, y = (iy + 0.5) * s / 2;
      const rg = g.createRadialGradient(x, y, 1, x, y, 12);
      rg.addColorStop(0, 'rgba(20,18,14,0.85)'); rg.addColorStop(0.6, 'rgba(50,48,42,0.6)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.beginPath(); g.arc(x, y, 12, 0, 7); g.fill();
      b.fillStyle = 'rgb(30,30,30)'; b.beginPath(); b.arc(x, y, 8, 0, 7); b.fill();
    }
    // cracks + damp stains
    g.strokeStyle = 'rgba(30,28,24,0.55)';
    for (let i = 0; i < 6; i++) {
      let x = Math.random() * s, y = Math.random() * s;
      g.lineWidth = 1.3; g.beginPath(); g.moveTo(x, y);
      for (let j = 0; j < 5; j++) { x += (Math.random() - 0.5) * 40; y += (Math.random() - 0.5) * 40; g.lineTo(x, y); }
      g.stroke();
    }
    blotchPass(g, s, 12, ['#4a463d', '#3e3a32'], 20, 60, 0.14);
    bumpBlotch(b, s, 70, 8, 40, true);
    bumpBlotch(b, s, 50, 4, 14, false);
  }, 512, 2);
  const metalPBR = makePBRTexture((g, b, s) => {
    // weathered olive-drab painted metal (doors / lintels / barrels)
    g.fillStyle = '#5f6247'; g.fillRect(0, 0, s, s);
    blotchPass(g, s, 70, ['#6b6e52', '#525539', '#77795c'], 16, 60, 0.18);
    // brushed streaks
    for (let i = 0; i < 60; i++) {
      g.strokeStyle = Math.random() < 0.5 ? 'rgba(255,255,240,0.06)' : 'rgba(0,0,0,0.10)';
      g.lineWidth = 1 + Math.random() * 2;
      const y = Math.random() * s;
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y + (Math.random() - 0.5) * 12); g.stroke();
    }
    // paint chips + rust bleeding
    for (let i = 0; i < 46; i++) {
      const x = Math.random() * s, y = Math.random() * s, r = 1.5 + Math.random() * 5;
      g.fillStyle = '#3a3b2e'; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
      if (Math.random() < 0.55) {
        g.fillStyle = `rgba(${140 + Math.random() * 40 | 0},${70 + Math.random() * 25 | 0},30,0.55)`;
        g.beginPath(); g.ellipse(x, y + r, r * 0.9, r * 1.6, 0, 0, 7); g.fill();
      }
      b.fillStyle = 'rgb(60,60,60)'; b.beginPath(); b.arc(x, y, r, 0, 7); b.fill();
    }
    // rivet rows top/bottom
    for (let k = 0; k < 6; k++) {
      for (const y of [18, s - 18]) {
        const x = 24 + k * (s - 48) / 5;
        const rg = g.createRadialGradient(x - 1, y - 1, 1, x, y, 7);
        rg.addColorStop(0, '#d8dcc8'); rg.addColorStop(0.5, '#7a7d6a'); rg.addColorStop(1, '#2c2d24');
        g.fillStyle = rg; g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill();
      }
    }
    grainPass(g, s, 1200, 0.3, 'rgb(230,230,210)', 'rgb(20,20,14)', 1, 2);
  }, 512, 1);

  const groundMat = new THREE.MeshStandardMaterial({ map: groundPBR.map, bumpMap: groundPBR.bumpMap, bumpScale: 0.9, roughness: 0.96, metalness: 0.0, envMapIntensity: 0.35 });
  const wallMat = new THREE.MeshStandardMaterial({ map: wallPBR.map, bumpMap: wallPBR.bumpMap, bumpScale: 0.6, roughness: 0.94, metalness: 0.0, envMapIntensity: 0.35 });
  const crateMat = new THREE.MeshStandardMaterial({ map: cratePBR.map, bumpMap: cratePBR.bumpMap, bumpScale: 0.5, roughness: 0.72, metalness: 0.05, envMapIntensity: 0.5 });
  const darkMat = new THREE.MeshStandardMaterial({ map: darkPBR.map, bumpMap: darkPBR.bumpMap, bumpScale: 0.7, roughness: 0.97, metalness: 0.0, envMapIntensity: 0.25 });
  const metalMat = new THREE.MeshStandardMaterial({ map: metalPBR.map, bumpMap: metalPBR.bumpMap, bumpScale: 0.35, roughness: 0.55, metalness: 0.65, envMapIntensity: 0.8 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x4f463a, roughness: 0.9, metalness: 0.02 });
  const accentA = new THREE.MeshStandardMaterial({ color: 0x2e9bff, roughness: 0.6 });
  const accentB = new THREE.MeshStandardMaterial({ color: 0xffb020, roughness: 0.6 });

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP_HALF * 2 + 30, MAP_HALF * 2 + 30), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  scene.add(ground);

  const H = MAP_HALF, W = 4, WH = 4.5;
  addSolid(0, WH / 2 - 0.5, -H - 2, H * 2 + 16, WH, W, wallMat);
  addSolid(0, WH / 2 - 0.5, H + 2, H * 2 + 16, WH, W, wallMat);
  addSolid(-H - 2, WH / 2 - 0.5, 0, W, WH, H * 2 + 16, wallMat);
  addSolid(H + 2, WH / 2 - 0.5, 0, W, WH, H * 2 + 16, wallMat);

  // ---- DEFUSAL LAYOUT ----
  // Lanes: north = A Long, center = Mid (3 doors), south = B Tunnels.
  // T spawn WEST far from sites, CT spawn EAST-CENTRAL between A/B.

  // Mid dividing wall (z=0): solid with 3 chokes —
  // west flank x[-18,-13] (5m), mid doors x[-1.5,+1.5] (3m), east flank x[+13,+18] (5m)
  addSolid(-22, 2, 0, 8, 4, 1.5, wallMat);
  addSolid(22, 2, 0, 8, 4, 1.5, wallMat);
  addSolid(-7.25, 2, 0, 11.5, 4, 1.5, wallMat);
  addSolid(7.25, 2, 0, 11.5, 4, 1.5, wallMat);
  addSolid(0, 3.4, 0, 4.4, 1.2, 1.8, metalMat);
  addSolid(-1.9, 2, 0, 0.8, 4, 1.8, metalMat);
  addSolid(1.9, 2, 0, 0.8, 4, 1.8, metalMat);
  // stone coping caps — catch sunlight, break the flat wall silhouette
  addSolid(-22, 4.12, 0, 8.3, 0.25, 1.8, trimMat, false);
  addSolid(22, 4.12, 0, 8.3, 0.25, 1.8, trimMat, false);
  addSolid(-7.25, 4.12, 0, 11.8, 0.25, 1.8, trimMat, false);
  addSolid(7.25, 4.12, 0, 11.8, 0.25, 1.8, trimMat, false);

  // Long corridor walls (A long north, B south) — create distinct lanes
  addSolid(-8, 1.75, -14, 30, 3.5, 1.2, wallMat);
  addSolid(-8, 1.75, 14, 30, 3.5, 1.2, wallMat);
  addSolid(8, 1.5, -22, 1.2, 3, 16, wallMat);
  addSolid(8, 1.5, 22, 1.2, 3, 16, wallMat);

  // T-side gate (x=-20): splits T exits into upper-mid / lower-mid doors.
  // Leaves a wide west staging area + 2x 3m doors + open flanks around z=±14 ends.
  addSolid(-20, 2, -9.5, 1.5, 4, 9, wallMat);
  addSolid(-20, 2, 9.5, 1.5, 4, 9, wallMat);
  addSolid(-20, 2, 0, 1.5, 4, 4, metalMat);

  // CT-side defense wall (x=12): separates mid from CT/sites staging.
  // Two 3m doors (z[-4,-1] and z[+1,+4]) — CT must hold these + site entrances.
  // Breaks the old huge open sightline from T spawn straight to sites.
  addSolid(12, 2, -9, 1.5, 4, 10, wallMat);
  addSolid(12, 2, 9, 1.5, 4, 10, wallMat);
  addSolid(12, 2, 0, 1.5, 4, 2, metalMat);
  addSolid(-20, 4.12, -9.5, 1.8, 0.25, 9.3, trimMat, false);
  addSolid(-20, 4.12, 9.5, 1.8, 0.25, 9.3, trimMat, false);
  addSolid(12, 4.12, -9, 1.8, 0.25, 10.3, trimMat, false);
  addSolid(12, 4.12, 9, 1.8, 0.25, 10.3, trimMat, false);

  // Mid cover blocks (break up the old open mid, give post-plant cover)
  addSolid(0, 1.1, -7, 4, 2.2, 1.2, crateMat);
  addSolid(0, 1.1, 7, 4, 2.2, 1.2, crateMat);
  addSolid(-10, 1.1, -7, 1.2, 2.2, 3.5, crateMat);
  addSolid(-10, 1.1, 7, 1.2, 2.2, 3.5, crateMat);
  addSolid(5, 1.1, -7, 1.2, 2.2, 3.0, darkMat);
  addSolid(5, 1.1, 7, 1.2, 2.2, 3.0, darkMat);

  // Bombsite enclosures — each site gets walls forcing 2 entrances + plant cover.
  // A site (24,-20): west wall + north wall, open south + NE.
  addSolid(17, 2, -20, 1.2, 4, 9, wallMat);
  addSolid(23, 2, -25.2, 13, 4, 1.2, wallMat);
  // B site (24,+20): mirrored.
  addSolid(17, 2, 20, 1.2, 4, 9, wallMat);
  addSolid(23, 2, 25.2, 13, 4, 1.2, wallMat);

  // Bombsite visuals (ground ring + overhead bar + floating letter)
  const mkSiteLabel = (letter, color) => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.beginPath(); g.arc(64, 64, 60, 0, 7); g.fill();
    g.fillStyle = color; g.font = '900 84px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(letter, 64, 68);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(3.2, 3.2, 1);
    return sp;
  };
  for (const s of SITES) {
    s.pos = new THREE.Vector3(s.x, 0, s.z);
    const ring = new THREE.Mesh(new THREE.CircleGeometry(s.r, 28),
      new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.30 }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(s.x, 0.03, s.z); scene.add(ring);
    const ringEdge = new THREE.Mesh(new THREE.RingGeometry(s.r - 0.25, s.r, 28),
      new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    ringEdge.rotation.x = -Math.PI / 2; ringEdge.position.set(s.x, 0.04, s.z); scene.add(ringEdge);
    const barMat = new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.6, emissive: s.color, emissiveIntensity: 0.25 });
    addSolid(s.x, 3.6, s.z, 0.4, 0.4, 8, barMat, false);
    const label = mkSiteLabel(s.name, s.name === 'A' ? '#7cc4ff' : '#ffd27a');
    label.position.set(s.x, 4.6, s.z); scene.add(label);
    s.mesh = ring; s.label = label;
  }

  // Cover crates — wood military crates + a few olive steel supply boxes
  const crates = [
    [-26, -20, 2.4], [-23.4, -20, 1.6], [-26, 20, 2.4], [-23.4, 20, 1.6],
    [-4, -19.5, 2], [-1.8, -19.5, 1.4], [-4, 19.5, 2], [-1.8, 19.5, 1.4],
    [15.5, 0, 2.2], [15.5, 2.8, 1.5], [-15.5, 0, 2.2],
    [21, -17.5, 2], [23.4, -17.2, 1.5], [21, 17.5, 2], [23.4, 17.2, 1.5],
    [-27, 0, 2.6], [2.5, -10.5, 1.8], [2.5, 10.5, 1.8], [-5, -4.5, 1.4], [-5, 4.5, 1.4],
    [26.5, -21.5, 1.8], [26.5, 21.5, 1.8], [-26, -8, 1.6], [-26, 8, 1.6],
  ];
  crates.forEach(([x, z, s], i) => {
    // every 5th box is a steel supply case for material variety
    const m = (i % 5 === 4) ? metalMat : crateMat;
    const box = addSolid(x, s / 2, z, s, s, s, m);
    // dark pallet underneath wooden crates grounds them + adds contact shadow
    if (m === crateMat) {
      const pal = new THREE.Mesh(new THREE.BoxGeometry(s * 0.94, 0.12, s * 0.94), trimMat);
      pal.position.set(x, 0.06, z); pal.receiveShadow = true; scene.add(pal);
    }
    void box;
  });

  // Tunnel arches (kept for B-tunnel / A-long flavor at map edges)
  for (const z of [-26, 26]) {
    addSolid(-2, 2.5, z, 8, 1, 6, darkMat);
    addSolid(-6, 1.25, z - 2.7, 1, 2.5, 0.8, wallMat);
    addSolid(-6, 1.25, z + 2.7, 1, 2.5, 0.8, wallMat);
    addSolid(2, 1.25, z - 2.7, 1, 2.5, 0.8, wallMat);
    addSolid(2, 1.25, z + 2.7, 1, 2.5, 0.8, wallMat);
  }

  // ---- Dressing: barrels, sandbags, lamps, decals, signage, palms, dust ----
  {
    // rusty fuel / water barrels (collide, break sightlines at sites)
    const barrelGeo = new THREE.CylinderGeometry(0.42, 0.42, 1.05, 14);
    const ribGeo = new THREE.TorusGeometry(0.425, 0.025, 6, 18);
    const barrelCols = [0x5a6136, 0x6e3b22, 0x4c5a68, 0x5a6136, 0x6e3b22, 0x70765a];
    const barrelSpots = [[19.2, -22.6], [19.8, -22.1], [19.2, 22.6], [-24.5, -6.5], [-24.5, 6.5], [7.5, -11.5]];
    barrelSpots.forEach(([x, z], i) => {
      const bm = new THREE.MeshStandardMaterial({ color: barrelCols[i % barrelCols.length], roughness: 0.6, metalness: 0.45 });
      const barrel = new THREE.Mesh(barrelGeo, bm);
      barrel.position.set(x, 0.53, z);
      barrel.castShadow = true; barrel.receiveShadow = true;
      scene.add(barrel);
      for (const ry of [0.3, 0.75]) {
        const rib = new THREE.Mesh(ribGeo, bm);
        rib.rotation.x = Math.PI / 2; rib.position.set(x, ry, z);
        scene.add(rib);
      }
      // rust streak decal band
      const lid = new THREE.Mesh(new THREE.CircleGeometry(0.38, 14),
        new THREE.MeshStandardMaterial({ color: 0x3a3a32, roughness: 0.7, metalness: 0.5 }));
      lid.rotation.x = -Math.PI / 2; lid.position.set(x, 1.06, z); scene.add(lid);
      colliders.push(new THREE.Box3().setFromObject(barrel));
    });

    // sandbag lines guarding CT doors + site entries (low cover, shoot over)
    const sandMat = new THREE.MeshStandardMaterial({ color: 0xa8905e, roughness: 1 });
    const sandDark = new THREE.MeshStandardMaterial({ color: 0x8a764e, roughness: 1 });
    const bagGeo = new THREE.SphereGeometry(0.32, 7, 5);
    bagGeo.scale(1.25, 0.55, 0.8);
    const sandRows = [
      { x: 10.2, z: -2.5, ry: 0 }, { x: 10.2, z: 2.5, ry: 0 },
      { x: 18.5, z: -15.5, ry: 0.5 }, { x: 18.5, z: 15.5, ry: -0.5 },
    ];
    for (const r of sandRows) {
      // collider base stays axis-aligned so movement + bullets match the visual
      addSolid(r.x, 0.5, r.z, r.ry === 0 ? 0.9 : 1.6, 1.0, r.ry === 0 ? 2.2 : 1.6, sandMat);
      // lumpy bags piled on top for silhouette
      for (let bx = 0; bx < 3; bx++) for (let by = 0; by < 2; by++) {
        const bag = new THREE.Mesh(bagGeo, (bx + by) % 2 ? sandMat : sandDark);
        bag.position.set(
          r.x + Math.cos(r.ry) * (bx - 1) * 0.62 + rand(-0.05, 0.05),
          1.05 + by * 0.30,
          r.z - Math.sin(r.ry) * (bx - 1) * 0.62 + rand(-0.08, 0.08));
        bag.rotation.y = r.ry + rand(-0.3, 0.3);
        bag.castShadow = true; bag.receiveShadow = true;
        scene.add(bag);
      }
    }

    // lamp posts at mid + CT staging (emissive head; 2 real lights for perf)
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.5, metalness: 0.7 });
    const lampHeadMat = new THREE.MeshStandardMaterial({ color: 0x30343a, emissive: 0xffd9a0, emissiveIntensity: 1.6, roughness: 0.4 });
    const lampSpots = [[0, -4.2, 0], [0, 4.2, Math.PI], [14, 0, Math.PI / 2]];
    lampSpots.forEach(([x, z, ry], i) => {
      addSolid(x, 1.9, z, 0.22, 3.8, 0.22, poleMat);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 1.1), poleMat);
      arm.position.set(x + Math.sin(ry) * 0.45, 3.75, z + Math.cos(ry) * 0.45);
      arm.rotation.y = ry; arm.castShadow = true; scene.add(arm);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.34), lampHeadMat);
      // head sits at the arm tip
      head.position.set(x + Math.sin(ry) * 0.95, 3.68, z + Math.cos(ry) * 0.95);
      scene.add(head);
      if (i < 2) {
        const pl = new THREE.PointLight(0xffd9a0, 6, 16, 1.8);
        pl.position.set(head.position.x, 3.5, head.position.z);
        pl.userData.base = 6; pl.userData.phase = Math.random() * 10;
        scene.add(pl);
        try { lampLightsArr.push(pl); } catch (e) {}
      }
    });

    // ground decals: oil stains, scorch, hazard stripes at chokes, painted site letters
    const stainTex = makeCanvasTexture((gg, ss) => {
      gg.clearRect(0, 0, ss, ss);
      const rg = gg.createRadialGradient(ss / 2, ss / 2, 4, ss / 2, ss / 2, ss / 2);
      rg.addColorStop(0, 'rgba(18,14,10,0.72)'); rg.addColorStop(0.6, 'rgba(25,20,14,0.42)'); rg.addColorStop(1, 'rgba(20,16,12,0)');
      gg.fillStyle = rg; gg.fillRect(0, 0, ss, ss);
      for (let i = 0; i < 40; i++) {
        gg.fillStyle = 'rgba(10,8,6,0.35)';
        gg.beginPath(); gg.arc(Math.random() * ss, Math.random() * ss, 1 + Math.random() * 3, 0, 7); gg.fill();
      }
    }, 128, 1);
    const stainMat = new THREE.MeshBasicMaterial({ map: stainTex, transparent: true, depthWrite: false, opacity: 0.9 });
    for (const [x, z, sc] of [[-12, 3, 3.2], [6, -9.5, 2.4], [16, 6, 2.8], [22, -19, 4.2], [22, 19, 4.2], [-25, 0, 3.6]]) {
      const st = new THREE.Mesh(new THREE.PlaneGeometry(sc, sc), stainMat);
      st.rotation.x = -Math.PI / 2; st.rotation.z = Math.random() * 3;
      st.position.set(x, 0.02, z); scene.add(st);
    }
    // hazard stripes at the two CT doors + mid doors
    const hzTex = makeCanvasTexture((gg, ss) => {
      gg.fillStyle = '#c9a227'; gg.fillRect(0, 0, ss, ss);
      gg.fillStyle = '#1c1c1c';
      for (let i = -ss; i < ss * 2; i += 32) {
        gg.beginPath(); gg.moveTo(i, 0); gg.lineTo(i + 16, 0); gg.lineTo(i + 16 - ss, ss); gg.lineTo(i - ss, ss); gg.fill();
      }
      gg.fillStyle = 'rgba(0,0,0,0.25)';
      for (let i = 0; i < 300; i++) gg.fillRect(Math.random() * ss, Math.random() * ss, 2, 2);
    }, 128, 1);
    const hzMat = new THREE.MeshStandardMaterial({ map: hzTex, roughness: 0.85 });
    for (const [x, z, w, ry] of [[0, -2.1, 3.2, 0], [0, 2.1, 3.2, 0], [12, -2.5, 3.0, Math.PI / 2], [12, 2.5, 3.0, Math.PI / 2]]) {
      const hz = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.7), hzMat);
      hz.rotation.x = -Math.PI / 2; hz.rotation.z = ry;
      hz.position.set(x, 0.025, z); hz.receiveShadow = true; scene.add(hz);
    }
    // big faded painted site letters on the ground
    const paintLetter = (letter, color) => {
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const gg = c.getContext('2d');
      gg.clearRect(0, 0, 256, 256);
      gg.font = '900 200px Arial'; gg.textAlign = 'center'; gg.textBaseline = 'middle';
      gg.fillStyle = color; gg.globalAlpha = 0.20;
      gg.fillText(letter, 128, 138);
      // wear: erase speckles
      gg.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 500; i++) { gg.beginPath(); gg.arc(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 4, 0, 7); gg.fill(); }
      const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; tx.anisotropy = maxAniso;
      return tx;
    };
    for (const s of SITES) {
      const pm = new THREE.Mesh(new THREE.PlaneGeometry(6, 6),
        new THREE.MeshBasicMaterial({ map: paintLetter(s.name, s.name === 'A' ? '#9fd0ff' : '#ffd9a0'), transparent: true, depthWrite: false }));
      pm.rotation.x = -Math.PI / 2; pm.position.set(s.x, 0.025, s.z + 3.4); scene.add(pm);
    }
    // wall signage: "A →" / "← B" direction boards near mid so lanes read instantly
    const signTex = (txt, bg) => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 96;
      const gg = c.getContext('2d');
      gg.fillStyle = bg; gg.fillRect(0, 0, 256, 96);
      gg.strokeStyle = 'rgba(255,255,255,0.7)'; gg.lineWidth = 6; gg.strokeRect(4, 4, 248, 88);
      gg.fillStyle = '#fff'; gg.font = '900 52px Arial'; gg.textAlign = 'center'; gg.textBaseline = 'middle';
      gg.fillText(txt, 128, 52);
      const tx = new THREE.CanvasTexture(c); tx.colorSpace = THREE.SRGBColorSpace; tx.anisotropy = maxAniso;
      return tx;
    };
    const signA = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.0),
      new THREE.MeshStandardMaterial({ map: signTex('A  →', '#1c4f8a'), roughness: 0.6 }));
    signA.position.set(-7.85, 2.6, -13.32); signA.rotation.y = 0; scene.add(signA);
    const signB = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.0),
      new THREE.MeshStandardMaterial({ map: signTex('←  B', '#8a5a14'), roughness: 0.6 }));
    // south wall face points toward mid (-z), so flip the plane
    signB.position.set(-7.85, 2.6, 13.32); signB.rotation.y = Math.PI; scene.add(signB);
  }

  // Palm grove — upgraded: banded trunk + frond canopy + dates (still cheap)
  {
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 1 });
    const trunkDark = new THREE.MeshStandardMaterial({ color: 0x4e3319, roughness: 1 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f7f36, roughness: 0.9, side: THREE.DoubleSide });
    const leafMat2 = new THREE.MeshStandardMaterial({ color: 0x4d9440, roughness: 0.9, side: THREE.DoubleSide });
    const dateMat = new THREE.MeshStandardMaterial({ color: 0xb06a20, roughness: 0.8 });
    for (const [x, z] of [[-28, -28], [-28, 28], [28, -28], [28, 28], [0, -28], [0, 28]]) {
      const h = 4.6 + Math.random() * 1.2;
      const lean = rand(-0.06, 0.06);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, h, 8), trunkMat);
      trunk.position.set(x, h / 2, z); trunk.rotation.z = lean;
      trunk.castShadow = true; scene.add(trunk);
      for (let i = 0; i < Math.floor(h / 0.55); i++) {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.245 - i * 0.004, 0.26 - i * 0.004, 0.12, 8), trunkDark);
        band.position.set(x + lean * (i * 0.55 - h / 2) * -1, 0.4 + i * 0.55, z);
        scene.add(band);
      }
      const topX = x + lean * -h * 0.5, topY = h, topZ = z;
      // 8 drooping fronds
      for (let f = 0; f < 8; f++) {
        const a = (f / 8) * Math.PI * 2 + rand(-0.2, 0.2);
        const frond = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 2.6, 1, 4), f % 2 ? leafMat : leafMat2);
        // bend the plane downward along its length
        const pos = frond.geometry.attributes.position;
        for (let vi = 0; vi < pos.count; vi++) {
          const vy = pos.getY(vi);
          pos.setZ(vi, -Math.pow((vy + 1.3) / 2.6, 2) * 1.1);
        }
        pos.needsUpdate = true; frond.geometry.computeVertexNormals();
        frond.position.set(topX + Math.cos(a) * 1.1, topY - 0.25, topZ + Math.sin(a) * 1.1);
        frond.rotation.y = -a + Math.PI / 2;
        frond.rotation.x = -0.55 + rand(-0.12, 0.12);
        frond.castShadow = true;
        scene.add(frond);
        try { palmFronds.push({ mesh: frond, baseRX: frond.rotation.x, phase: Math.random() * 10, amp: 0.05 + Math.random() * 0.04 }); } catch (e) {}
      }
      const crown = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), trunkDark);
      crown.position.set(topX, topY - 0.1, topZ); scene.add(crown);
      for (let d = 0; d < 3; d++) {
        const dt = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 5), dateMat);
        dt.position.set(topX + rand(-0.3, 0.3), topY - 0.45, topZ + rand(-0.3, 0.3));
        scene.add(dt);
      }
      // dark contact disc grounds the palm
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1.3, 16),
        new THREE.MeshBasicMaterial({ color: 0x1e1408, transparent: true, opacity: 0.30, depthWrite: false }));
      disc.rotation.x = -Math.PI / 2; disc.position.set(x, 0.015, z); scene.add(disc);
    }
  }

  // floating dust motes — sunlit atmosphere (1 draw call, wraps in updateEffects)
  {
    const N = 220;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = rand(-34, 34); pos[i * 3 + 1] = rand(0.3, 6); pos[i * 3 + 2] = rand(-30, 30);
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dm = new THREE.PointsMaterial({ color: 0xffe9c4, size: 0.06, transparent: true, opacity: 0.55, depthWrite: false });
    const dust = new THREE.Points(dg, dm);
    dust.frustumCulled = false;
    dust.name = 'dustMotes';
    scene.add(dust);
  }

  // ---- Ground life: rocks, rubble, dry grass (no gameplay cost) ----
  {
    const _probe2 = new THREE.Vector3();
    const free2 = (x, z, r = 0.5) => { _probe2.set(x, 0, z); return !collidesAt(_probe2, r); };
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x8d8272, roughness: 1 });
    const rockDark = new THREE.MeshStandardMaterial({ color: 0x6e6558, roughness: 1 });
    const rockGeo = new THREE.DodecahedronGeometry(0.32, 0);
    let placed = 0, guard = 0;
    while (placed < 26 && guard++ < 300) {
      const x = rand(-32, 32), z = rand(-28, 28);
      if (!free2(x, z, 0.55)) continue;
      let nearSite = false;
      for (const s of SITES) { if (Math.hypot(x - s.x, z - s.z) < s.r + 1) { nearSite = true; break; } }
      if (nearSite) continue;
      const sc = rand(0.5, 1.6);
      const rock = new THREE.Mesh(rockGeo, Math.random() < 0.5 ? rockMat : rockDark);
      rock.position.set(x, 0.1 * sc, z);
      rock.scale.set(sc * rand(0.8, 1.3), sc * rand(0.5, 0.8), sc * rand(0.8, 1.3));
      rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      rock.castShadow = true; rock.receiveShadow = true;
      scene.add(rock);
      placed++;
    }
    // rubble piles against walls (visual only)
    const rubbleSpots = [[-18.5, 1.2], [10.5, -5.2], [15.8, 18.2], [-6, -13.2], [20, -23.5]];
    for (const [x, z] of rubbleSpots) {
      for (let i = 0; i < 7; i++) {
        const sc = rand(0.25, 0.6);
        const r = new THREE.Mesh(rockGeo, i % 2 ? rockMat : rockDark);
        r.position.set(x + rand(-0.9, 0.9), 0.06, z + rand(-0.9, 0.9));
        r.scale.setScalar(sc);
        r.rotation.set(Math.random() * 3, Math.random() * 3, 0);
        r.castShadow = true; r.receiveShadow = true;
        scene.add(r);
      }
    }
    // dry grass tufts: crossed alpha planes, sway in updateEffects
    const gc = document.createElement('canvas'); gc.width = 64; gc.height = 64;
    const gg2 = gc.getContext('2d');
    gg2.clearRect(0, 0, 64, 64);
    gg2.strokeStyle = 'rgba(168,150,100,0.95)'; gg2.lineWidth = 2.5; gg2.lineCap = 'round';
    for (let i = 0; i < 14; i++) {
      const x0 = 8 + Math.random() * 48;
      gg2.beginPath(); gg2.moveTo(x0, 62);
      gg2.quadraticCurveTo(x0 + rand(-12, 12), 36, x0 + rand(-18, 18), 6 + Math.random() * 14);
      gg2.stroke();
    }
    const grassTex = new THREE.CanvasTexture(gc);
    const grassMat = new THREE.MeshStandardMaterial({ map: grassTex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 1, color: 0xd8c89a });
    const tuftGeos = [new THREE.PlaneGeometry(0.7, 0.55), new THREE.PlaneGeometry(0.7, 0.55)];
    placed = 0; guard = 0;
    window.__grassTufts = window.__grassTufts || [];
    while (placed < 60 && guard++ < 600) {
      const x = rand(-33, 33), z = rand(-29, 29);
      if (!free2(x, z, 0.4)) continue;
      const grp = new THREE.Group();
      for (let k = 0; k < 2; k++) {
        const p = new THREE.Mesh(tuftGeos[k], grassMat);
        p.rotation.y = k * Math.PI / 2 + rand(-0.2, 0.2);
        p.position.y = 0.26;
        grp.add(p);
      }
      grp.position.set(x, 0, z);
      grp.rotation.y = Math.random() * Math.PI;
      const s = rand(0.7, 1.4); grp.scale.set(s, s, s);
      scene.add(grp);
      window.__grassTufts.push({ grp, phase: Math.random() * 10 });
      placed++;
    }
    // circling desert birds (2 sprites, flap via scale)
    try {
      const bc = document.createElement('canvas'); bc.width = 64; bc.height = 32;
      const bg = bc.getContext('2d');
      bg.clearRect(0, 0, 64, 32);
      bg.strokeStyle = 'rgba(30,28,26,0.9)'; bg.lineWidth = 4; bg.lineCap = 'round';
      bg.beginPath(); bg.moveTo(6, 20); bg.quadraticCurveTo(20, 8, 32, 18); bg.quadraticCurveTo(44, 8, 58, 20); bg.stroke();
      const bt = new THREE.CanvasTexture(bc);
      for (let i = 0; i < 3; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: bt, transparent: true, depthWrite: false, opacity: 0.8 }));
        sp.scale.set(2.2, 1.1, 1);
        scene.add(sp);
        birdsArr.push({ mesh: sp, r: 26 + i * 7, h: 26 + i * 3, speed: 0.05 + i * 0.012, phase: Math.random() * 10 });
      }
    } catch (e) {}
    // lone tumbleweed rolling through mid on the wind
    try {
      const tw = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 1),
        new THREE.MeshStandardMaterial({ color: 0x9a7d4e, roughness: 1, wireframe: true }));
      tw.position.set(-20, 0.45, rand(-8, 8));
      scene.add(tw);
      tumbleweed = tw; tumbleVel = new THREE.Vector3(1.4, 0, 0.35);
    } catch (e) {}
  }

  // Spawns — each team gets two pockets flanking the central corridor.
  // The old spots sat right in the mid-doorway sightline (T could shoot CT spawn from
  // their own base, and one CT + two T spots clipped into crates). Every slot below was
  // checked offline: clear of geometry by 1m and not visible from anywhere in the enemy
  // half of the map. Slot order alternates sides: even = A / north (z<0), odd = B / south.
  // CT: ~11-16m from its nearer site (defenders set up fast). T: far west, long push.
  spawns.ct = [[28.5, -9.5], [28.5, 9.5], [26, -11], [26, 11], [31, -11], [31, 11]].map(([x, z]) => new THREE.Vector3(x, 0, z));
  spawns.t = [[-30, -9], [-30, 9], [-27.5, -11.5], [-27.5, 11.5], [-24.5, -11], [-24.5, 11]].map(([x, z]) => new THREE.Vector3(x, 0, z));

  // Waypoint grid for bots — pruned so none spawn inside the new walls.
  // (Bots steer straight at waypoints; keeping them out of solids avoids stuck spins.)
  const _probe = new THREE.Vector3();
  const _free = (x, z) => {
    _probe.set(x, 0, z);
    return !collidesAt(_probe, 0.6);
  };
  for (let x = -28; x <= 28; x += 5)
    for (let z = -24; z <= 24; z += 5) {
      const jx = x + rand(-1.2, 1.2), jz = z + rand(-1.2, 1.2);
      if (Math.abs(jx) > MAP_HALF - 1 || Math.abs(jz) > MAP_HALF - 1) continue;
      if (!_free(jx, jz)) continue;
      waypoints.push(new THREE.Vector3(jx, 0, jz));
    }
  // Guaranteed lane waypoints: T staging, mid doors, CT doors, site entries.
  const laneWPs = [
    [-25, 0], [-22, -9], [-22, 9], [-16, 0], [-16, -19], [-16, 19],
    [0, -2.5], [0, 2.5], [-15.5, -10.5], [-15.5, 10.5],
    [12, -2.5], [12, 2.5], [9, -19], [9, 19], [15, -11], [15, 11],
    [20, -14], [20, 14], [24, -20], [24, 20], [28, -20], [28, 20], [16, 0],
  ];
  for (const [lx, lz] of laneWPs) if (_free(lx, lz)) waypoints.push(new THREE.Vector3(lx, 0, lz));
}

