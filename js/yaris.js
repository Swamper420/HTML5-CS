// js/yaris.js — AGENTS: Drivable beater Yaris: E to enter/exit, WASD arcade drive, bouncy suspension, horn, run-over kills, backfire boost.
// Ownership: YARIS state, buildYaris, updateYaris, resetYaris. One shared car online: the driver owns the pose via snapshot yaris fields.

import * as THREE from 'three';
import { Net } from '../net.js';
import { AudioSys } from './audio.js';
import { EYE } from './config.js';
import { clamp, rand } from './utils.js';
import { collidesAt, moveWithCollision } from './collision.js';
import { botsHearShot } from './bots.js';
import { damageBot, playerInPlantSite, playerNearPlantedBomb } from './combat.js';
import { decalTextures, spawnBurst, spawnSmoke } from './effects.js';
import { announce, playerHitmark } from './hud.js';
import { isOnline, remoteYarisDriver, remotes } from './multiplayer.js';
import { setPickupHint } from './pickups.js';
import { camera, scene } from './render.js';
import { G, bots, isFreeze, keys, player } from './state.js';

export const YARIS = {
  pos: new THREE.Vector3(-16, 0, 3.5), yaw: Math.PI / 2, speed: 0,
  driving: false, _hint: false, _honkAt: 0, _fireAt: 0, _hearAt: 0,
  _bounce: 0, _imm: new Map(), _immR: new Map(),
  _honkN: 0, _fireN: 0, // monotonic event counters — remotes edge-trigger honk/backfire sounds
};
let _g = null, _body = null, _wheels = [];
let _home = null;
let _brakeMats = [], _revMat = null, _exhaust = null, _hlGlow = [];

// tried in order; first spot clear of geometry wins (beater never spawns inside a crate)
const CANDIDATES = [[-16, 3.5], [-16, -3.5], [-24, 0], [16, -6], [16, 6], [-6, -3.5], [-6, 3.5], [0, -10]];

function plateTexture(txt) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#e8e8e2'; g.fillRect(0, 0, 128, 32);
  g.strokeStyle = '#222'; g.lineWidth = 3; g.strokeRect(2, 2, 124, 28);
  g.fillStyle = '#1a3a8a'; g.font = '900 22px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(txt, 64, 17);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildYaris() {
  const probe = new THREE.Vector3();
  let hx = -16, hz = 3.5;
  for (const [cx, cz] of CANDIDATES) {
    probe.set(cx, 0, cz);
    try { if (!collidesAt(probe, 1.5, 1.6)) { hx = cx; hz = cz; break; } } catch { hx = cx; hz = cz; break; }
  }
  YARIS.pos.set(hx, 0, hz); _home = new THREE.Vector3(hx, 0, hz);

  const beige = new THREE.MeshStandardMaterial({ color: 0xc9bd9a, roughness: 0.7, metalness: 0.15 });
  const rustDoor = new THREE.MeshStandardMaterial({ color: 0x7a4a28, roughness: 0.9, metalness: 0.05 });
  const rust = new THREE.MeshStandardMaterial({ color: 0x5e3418, roughness: 1, metalness: 0 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x10161c, roughness: 0.12, metalness: 0.85, transparent: true, opacity: 0.62 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x2c2c30, roughness: 0.8 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.3, metalness: 0.85 });
  const fabric = new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 1 });
  _g = new THREE.Group();
  _body = new THREE.Group();
  _g.add(_body);
  const lower = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 3.6), beige);
  lower.position.y = 0.62; lower.castShadow = true; _body.add(lower);
  const doorL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 1.1), rustDoor); // mismatched junkyard door
  doorL.position.set(-0.87, 0.62, 0.3); _body.add(doorL);
  // see-through cabin + simple interior (seats, wheel, dash)
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.55, 1.9), glass);
  cabin.position.set(0, 1.15, 0.2); cabin.castShadow = true; _body.add(cabin);
  const tub = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.3, 1.8), fabric);
  tub.position.set(0, 0.95, 0.2); _body.add(tub);
  for (const sx of [-0.35, 0.35]) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), fabric);
    seat.position.set(sx, 1.05, 0.55); _body.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.12), fabric);
    back.position.set(sx, 1.3, 0.82); back.rotation.x = 0.12; _body.add(back);
  }
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.16, 0.35), trim);
  dash.position.set(0, 1.12, -0.62); _body.add(dash);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.028, 6, 14), trim);
  wheel.position.set(-0.35, 1.22, -0.42); wheel.rotation.x = -1.1; _body.add(wheel);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 6), trim);
  column.position.set(-0.35, 1.1, -0.5); column.rotation.x = 1.1; _body.add(column);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 2.0), beige);
  roof.position.set(0, 1.46, 0.2); _body.add(roof);
  // grille + chrome slats + plates + wipers + mirrors + handles + antenna
  const grille = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.2, 0.08), trim);
  grille.position.set(0, 0.55, -1.82); _body.add(grille);
  for (let i = 0; i < 3; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.025, 0.02), chrome);
    slat.position.set(0, 0.49 + i * 0.06, -1.87); _body.add(slat);
  }
  try {
    const pf = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.11),
      new THREE.MeshStandardMaterial({ map: plateTexture('BEATER'), roughness: 0.6 }));
    pf.position.set(0, 0.32, -1.99); pf.rotation.y = Math.PI; _body.add(pf);
    const pr = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.11),
      new THREE.MeshStandardMaterial({ map: plateTexture('YAR1S-99'), roughness: 0.6 }));
    pr.position.set(0, 0.36, 1.99); _body.add(pr);
  } catch {}
  for (const [i, sx] of [-0.55, 0.55].entries()) {
    void i;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.04), trim);
    arm.position.set(sx * 1.55, 1.12, -0.55); _body.add(arm);
    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.07), trim);
    mir.position.set(sx * 1.62, 1.16, -0.55); _body.add(mir);
  }
  for (const sx of [-0.86, 0.86]) for (const sz of [-0.35, 0.55]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.035, 0.18), trim);
    h.position.set(sx, 0.78, sz); _body.add(h);
  }
  for (const [i, sx] of [-0.5, 0.5].entries()) {
    const wiper = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.55), trim);
    wiper.position.set(sx * 0.5 + (i ? 0.15 : -0.05), 0.92, -1.15);
    wiper.rotation.y = (i ? -1 : 1) * 0.35; _body.add(wiper);
  }
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.7, 5), trim);
  ant.position.set(0.6, 1.85, 1.0); ant.rotation.z = -0.15; _body.add(ant);
  // rust blotches + mudflaps + exhaust (backfire origin)
  const rustSpots = [[-0.86, 0.5, -1.0, 0.5, 0.3], [0.86, 0.45, 0.9, 0.4, 0.28], [0, 0.9, -1.82, 0.7, 0.12], [-0.4, 0.35, 1.82, 0.5, 0.2], [0.86, 0.62, -0.4, 0.3, 0.22]];
  for (const [x, y, z, w, h] of rustSpots) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), rust);
    p.position.set(x, y, z);
    if (Math.abs(z) > 1.5) p.rotation.y = z < 0 ? Math.PI : 0;
    else p.rotation.y = x < 0 ? -Math.PI / 2 : Math.PI / 2;
    _body.add(p);
  }
  for (const [sx, sz] of [[-0.85, -0.75], [0.85, -0.75], [-0.85, 1.65], [0.85, 1.65]]) {
    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.28, 0.05), trim);
    flap.position.set(sx, 0.22, sz); _body.add(flap);
  }
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.35, 8), chrome);
  pipe.rotation.x = Math.PI / 2; pipe.position.set(0.55, 0.22, 1.95); _body.add(pipe);
  _exhaust = new THREE.Object3D(); _exhaust.position.set(0.55, 0.22, 2.15); _body.add(_exhaust);
  for (const sx of [-0.6, 0.6]) { // headlights: one bright, one dead (beater lore)
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x111111, emissive: sx < 0 ? 0xffedb5 : 0x000000, emissiveIntensity: sx < 0 ? 2.2 : 0 }));
    hl.position.set(sx, 0.66, -1.83); _body.add(hl);
  }
  try { // headlight glow sprites
    const T = decalTextures();
    for (const sx of [-0.6, 0.6]) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: sx < 0 ? 0xffedb5 : 0x333333, transparent: true, opacity: sx < 0 ? 0.55 : 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
      sp.position.set(sx, 0.66, -1.9); sp.scale.setScalar(0.55);
      _body.add(sp); _hlGlow.push(sp);
    }
  } catch {}
  _brakeMats = [];
  for (const sx of [-0.6, 0.6]) {
    const m = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2222, emissiveIntensity: 0.9 });
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.06), m);
    tl.position.set(sx, 0.7, 1.83); _body.add(tl);
    _brakeMats.push(m);
  }
  _revMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffffff, emissiveIntensity: 0 });
  const rev = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 0.06), _revMat);
  rev.position.set(0, 0.7, 1.84); _body.add(rev);
  const bumpF = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.22, 0.25), trim);
  bumpF.position.set(0, 0.32, -1.85); _body.add(bumpF);
  const bumpR = bumpF.clone(); bumpR.position.z = 1.85; _body.add(bumpR);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.4), rustDoor); // crooked spoiler, held on with hope
  wing.position.set(0, 1.62, 1.7); wing.rotation.z = 0.09; _body.add(wing);
  try { // roof sign so mid players read it instantly
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const gg = c.getContext('2d');
    gg.fillStyle = '#111'; gg.fillRect(0, 0, 256, 64);
    gg.fillStyle = '#ffd76d'; gg.font = '900 36px Arial'; gg.textAlign = 'center'; gg.textBaseline = 'middle';
    gg.fillText('🚗 YARIS', 128, 34);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.32),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    sign.position.set(0, 1.75, 0.2); _body.add(sign);
  } catch {}
  // daytime running beam: one shadowless spotlight (single car — cheap)
  try {
    const beam = new THREE.SpotLight(0xffe9b0, 6, 20, 0.45, 0.6, 1.2);
    beam.position.set(-0.6, 0.7, -1.8);
    const tgt = new THREE.Object3D(); tgt.position.set(-0.6, 0, -12);
    _g.add(tgt); beam.target = tgt; _g.add(beam);
  } catch {}
  const wg = new THREE.CylinderGeometry(0.34, 0.34, 0.25, 12);
  wg.rotateZ(Math.PI / 2);
  const wm = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 });
  const hub = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.4, metalness: 0.7 });
  _wheels = [];
  for (const [sx, sz] of [[-0.85, -1.2], [0.85, -1.2], [-0.85, 1.2], [0.85, 1.2]]) {
    const w = new THREE.Group();
    const tire = new THREE.Mesh(wg, wm); tire.castShadow = true; w.add(tire);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.27, 8), hub);
    cap.rotation.z = Math.PI / 2; w.add(cap);
    // one hubcap missing (beater lore) — bare steel on the rear right
    if (!(sx > 0 && sz > 0)) {
      const trim2 = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.02, 5, 12), chrome);
      trim2.rotation.y = Math.PI / 2; w.add(trim2);
    }
    w.position.set(sx, 0.34, sz);
    _g.add(w); _wheels.push(w);
  }
  _g.position.copy(YARIS.pos);
  _g.rotation.y = YARIS.yaw;
  scene.add(_g);
}

function honk() {
  const t = performance.now() / 1000;
  if (t - YARIS._honkAt < 0.5) return;
  YARIS._honkAt = t;
  YARIS._honkN++;
  try { AudioSys.yarisHonkAt(YARIS.pos); } catch {}
}

function enterCar() {
  YARIS.driving = true; player.driving = true;
  player.useQueued = 0;
  YARIS.speed = 0; YARIS._imm.clear(); YARIS._immR.clear();
  try { announce('YARIS ACQUIRED 🚗💨 — W/S DRIVE · SPACE HANDBRAKE · H HONK · E EXIT', 2200); } catch {}
  try { AudioSys.yarisDoorAt(YARIS.pos); } catch {}
  honk();
}

function exitCar() {
  if (!YARIS.driving) return;
  YARIS.driving = false; player.driving = false;
  player.useQueued = 0; YARIS.speed = 0;
  try { AudioSys.yarisEngine(0); } catch {}
  try { AudioSys.yarisDoorAt(YARIS.pos); } catch {}
  player.vel.set(0, 0, 0); player.pos.y = 0; player.onGround = true;
  // step out the left side (or right/behind if blocked)
  const rx = Math.cos(YARIS.yaw), rz = -Math.sin(YARIS.yaw);
  for (const [ox, oz] of [[-rx * 2, -rz * 2], [rx * 2, rz * 2], [Math.sin(YARIS.yaw) * 2.5, Math.cos(YARIS.yaw) * 2.5]]) {
    const p = new THREE.Vector3(YARIS.pos.x + ox, 0, YARIS.pos.z + oz);
    try { if (!collidesAt(p, player.radius, 1.7)) { player.pos.set(p.x, 0, p.z); break; } } catch { player.pos.set(p.x, 0, p.z); break; }
  }
}

export function resetYaris() {
  if (YARIS.driving) { YARIS.driving = false; player.driving = false; }
  try { AudioSys.yarisEngine(0); } catch {}
  YARIS.speed = 0; YARIS._imm.clear(); YARIS._immR.clear(); YARIS._hint = false;
  if (_home) { YARIS.pos.copy(_home); YARIS.yaw = Math.PI / 2; }
  if (_g) { _g.position.copy(YARIS.pos); _g.rotation.y = YARIS.yaw; }
  try { setPickupHint(''); } catch {}
}

function frozen() { try { return isFreeze(); } catch { return false; } }

// exhaust world pos for backfire flames
const _exP = new THREE.Vector3();
function exhaustWorld() {
  try { _exhaust.getWorldPosition(_exP); return _exP; } catch {}
  return _exP.set(YARIS.pos.x, 0.3, YARIS.pos.z);
}

const _fwd = new THREE.Vector3();
export function updateYaris(dt, t) {
  if (!_g) return;
  if (G.phase !== 'playing') { try { AudioSys.yarisEngine(0); } catch {} return; }
  const wantE = (t - (player.useQueued || 0)) < 0.4;
  const drv = (() => { try { return remoteYarisDriver(); } catch { return null; } })();

  if (!YARIS.driving) {
    // someone else owns the beater online: mirror their pose, animate from their speed
    if (drv && isOnline()) {
      const rk = clamp(+drv.r.yspd || 0, 0, 1);
      YARIS.pos.set(+drv.r.yx || 0, 0, +drv.r.yz || 0);
      YARIS.yaw = +drv.r.yyaw || 0;
      YARIS.speed = rk * 10.5;
      _g.position.copy(YARIS.pos); _g.rotation.y = YARIS.yaw;
      const hop = Math.abs(Math.sin(t * (6 + rk * 9))) * (0.02 + rk * 0.11);
      _body.position.y = hop;
      _body.rotation.z = Math.sin(t * 7.3) * 0.012 * (0.3 + rk);
      for (const w of _wheels) { try { w.rotation.x += (YARIS.speed / 0.34) * dt; } catch {} }
      if (!player.alive || G.roundEnding || G.buyOpen) return;
      const d = Math.hypot(player.pos.x - YARIS.pos.x, player.pos.z - YARIS.pos.z);
      if (d < 3.5) { setPickupHint('YARIS IN USE 🚗'); YARIS._hint = true; }
      else if (YARIS._hint) { YARIS._hint = false; try { setPickupHint(''); } catch {} }
      return;
    }
    // idle beater: sag on blown shocks
    _body.position.y = Math.sin(t * 1.3) * 0.008 - 0.02;
    _body.rotation.z = Math.sin(t * 0.9) * 0.004;
    if (!player.alive || G.roundEnding || G.buyOpen) return;
    const d = Math.hypot(player.pos.x - YARIS.pos.x, player.pos.z - YARIS.pos.z);
    if (d < 2.8 && player.alive && player.onGround) {
      setPickupHint('E — DRIVE THE YARIS 🚗');
      YARIS._hint = true;
      // bomb E always wins (plant/defuse keep the press)
      let bombBusy = false;
      try { bombBusy = playerNearPlantedBomb() || (player.hasBomb && !!playerInPlantSite()); } catch {}
      if (wantE && !bombBusy && !frozen()) enterCar();
    } else if (YARIS._hint) { YARIS._hint = false; try { setPickupHint(''); } catch {} }
    return;
  }

  // --- driving ---
  if (!player.alive || G.roundEnding) { exitCar(); return; }
  if (wantE) { exitCar(); return; }
  // lost the race online: lower net id keeps the beater
  if (drv && isOnline()) {
    try { if (drv.id < Net.id) { exitCar(); return; } } catch {}
  }
  if (frozen()) { YARIS.speed = 0; try { AudioSys.yarisEngine(0); } catch {} return; }

  const hb = !!keys['Space']; // handbrake slide (Space can't jump the beater — too heavy)
  const fwdIn = (keys['KeyW'] ? 1 : 0) - (keys['KeyS'] ? 1 : 0);
  const steerIn = (keys['KeyA'] ? 1 : 0) - (keys['KeyD'] ? 1 : 0);
  YARIS.speed += clamp(fwdIn * (fwdIn > 0 ? 7 : 5), -9, 9) * dt;
  if (!fwdIn) YARIS.speed -= YARIS.speed * Math.min(1, (hb ? 4 : 1.2) * dt);
  YARIS.speed = clamp(YARIS.speed, -4.5, hb ? 7 : 10.5);
  if (hb) YARIS.speed -= YARIS.speed * Math.min(1, 3 * dt);
  const spd = Math.abs(YARIS.speed);
  const dirS = YARIS.speed >= 0 ? 1 : -1;
  YARIS.yaw += steerIn * (hb ? 2.6 : 1.7) * clamp(spd / 4, 0, 1) * dirS * dt;

  _fwd.set(-Math.sin(YARIS.yaw), 0, -Math.cos(YARIS.yaw));
  const preX = YARIS.pos.x, preZ = YARIS.pos.z;
  moveWithCollision(YARIS.pos, _fwd.x * YARIS.speed * dt, _fwd.z * YARIS.speed * dt, 1.15, 1.5);
  const moved = Math.hypot(YARIS.pos.x - preX, YARIS.pos.z - preZ);
  const want = Math.abs(YARIS.speed * dt);
  if (want > 0.05 && moved < want * 0.25) {
    // boing off the wall — beater bounces, doesn't crunch
    YARIS.speed *= -0.32;
    YARIS._bounce = 1;
    try {
      AudioSys.thud(YARIS.pos); AudioSys.click(300, 0.08, 0.4, YARIS.pos);
      spawnBurst(new THREE.Vector3(YARIS.pos.x, 0.8, YARIS.pos.z), 0xffd27a, 8, 4, 0.4);
    } catch {}
  }
  // driver rides along; Space is handbrake so zero the jump the movement code queued
  player.pos.set(YARIS.pos.x, 0, YARIS.pos.z);
  player.vel.set(_fwd.x * YARIS.speed, 0, _fwd.z * YARIS.speed);
  player.onGround = true; player.yaw = YARIS.yaw;

  // --- bounce: blown shocks never settle. speed + wall-boings feed it. ---
  YARIS._bounce = Math.max(0, YARIS._bounce - dt * 2.2);
  const k = clamp(spd / 10, 0, 1);
  const hop = Math.abs(Math.sin(t * (6 + k * 9))) * (0.02 + k * 0.11) + YARIS._bounce * 0.22 * Math.abs(Math.sin(t * 22));
  _body.position.y = hop;
  _body.rotation.z = Math.sin(t * 7.3) * 0.012 * (0.3 + k) + -steerIn * 0.03 * k + YARIS._bounce * 0.06 * Math.sin(t * 31);
  _body.rotation.x = clamp(-fwdIn * 0.02 - YARIS.speed * 0.004, -0.05, 0.05) + YARIS._bounce * 0.05 * Math.sin(t * 27);
  for (const w of _wheels) { try { w.rotation.x += (YARIS.speed / 0.34) * dt; } catch {} }
  if (_wheels.length === 4) { _wheels[0].rotation.y = _wheels[1].rotation.y = steerIn * 0.42; }
  _g.position.copy(YARIS.pos); _g.rotation.y = YARIS.yaw;
  // brake + reverse lights follow the pedals
  try {
    const braking = fwdIn < 0 || (hb && spd > 1);
    for (const m of _brakeMats) m.emissiveIntensity = braking ? 3.2 : 0.9;
    if (_revMat) _revMat.emissiveIntensity = YARIS.speed < -0.5 ? 2.0 : 0;
  } catch {}
  try {
    camera.position.set(YARIS.pos.x, EYE + hop * 0.7, YARIS.pos.z);
    camera.rotation.z += Math.sin(t * 9.1) * 0.006 * k; // rattly wheel through the camera
    if (camera.fov < 82 && spd > 7) { camera.fov += (82 - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
  } catch {}

  // engine loop follows speed (local); remotes get it via snapshot yspd
  try { AudioSys.yarisEngine(player.alive ? 0.12 + k * 0.88 : 0); } catch {}
  if (hb && spd > 5) { try { spawnSmoke(new THREE.Vector3(YARIS.pos.x, 0.3, YARIS.pos.z), 0.5, 0.7, 0x9a9a9a); } catch {} }
  if (keys['KeyH']) honk();
  // loud beater draws the bots
  if (spd > 4 && t - YARIS._hearAt > 1.2) {
    YARIS._hearAt = t;
    try { botsHearShot({ team: player.team || 'ct', isPlayer: true }, new THREE.Vector3(YARIS.pos.x, 1, YARIS.pos.z), t); } catch {}
  }
  // backfire boost: random bang + exhaust flame + kick (the beater runs rich)
  if (spd > 2 && t - YARIS._fireAt > 7 && Math.random() < dt * 0.25) {
    YARIS._fireAt = t;
    YARIS._fireN++;
    YARIS.speed = clamp(YARIS.speed + dirS * 2.2, -4.5, 11.5);
    try {
      AudioSys.yarisBackfireAt(YARIS.pos);
      const ep = exhaustWorld().clone();
      spawnBurst(ep, 0xff9a2a, 14, 6, 0.4);
      spawnSmoke(new THREE.Vector3(YARIS.pos.x, 0.8, YARIS.pos.z), 0.4, 0.8, 0x555555);
    } catch {}
  }
  // --- run over enemies: speed-gated splat, per-victim cooldown so one frame can't multihit ---
  if (spd > 3.5) {
    const dmg = Math.round(120 + spd * 14);
    for (const b of bots) {
      if (!b.alive || b.team === (player.team || 'ct')) continue;
      const d = Math.hypot(b.pos.x - YARIS.pos.x, b.pos.z - YARIS.pos.z);
      if (d > 1.7) continue;
      const last = YARIS._imm.get(b) || -9;
      if (t - last < 0.6) continue;
      YARIS._imm.set(b, t);
      try {
        const dir = _fwd.clone();
        damageBot(b, dmg, { team: player.team || 'ct', isPlayer: true }, false,
          new THREE.Vector3(b.pos.x, 1.0, b.pos.z), { dir, weapon: 'YARIS', power: 2.4 });
        AudioSys.thud(new THREE.Vector3(b.pos.x, 1, b.pos.z));
        spawnBurst(new THREE.Vector3(b.pos.x, 0.8, b.pos.z), 0xb00000, 10, 5, 0.5);
        YARIS._bounce = Math.min(1.2, YARIS._bounce + 0.5); // speed-bump thump
      } catch {}
    }
    // online: victim-authoritative like bullets (server clamps to 100 — still a splat)
    if (isOnline()) {
      try {
        const myTeam = player.team || 'ct';
        for (const [rid, e] of remotes) {
          const rd = e.data; if (!rd || !rd.alive) continue;
          if ((rd.team || 't') === myTeam) continue;
          const d = Math.hypot(e.pos.x - YARIS.pos.x, e.pos.z - YARIS.pos.z);
          if (d > 1.9) continue;
          const last = YARIS._immR.get(rid) || -9;
          if (t - last < 0.8) continue;
          YARIS._immR.set(rid, t);
          G.hits++; playerHitmark(false, false); AudioSys.hit(false);
          spawnBurst(new THREE.Vector3(e.pos.x, 1.0, e.pos.z), 0xb00000, 10, 5, 0.5);
          try { AudioSys.thud(new THREE.Vector3(e.pos.x, 1, e.pos.z)); } catch {}
          try { Net.sendHit({ targetId: rid, dmg, head: false, weapon: 'YARIS' }); } catch {}
          YARIS._bounce = Math.min(1.2, YARIS._bounce + 0.5);
        }
      } catch {}
    }
  }
}
