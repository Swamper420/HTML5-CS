import * as THREE from 'three';
import { Net } from './net.js';

/* ============================================================
   HTML5-CS : STRIKE ZONE — a Counter-Strike-style browser FPS
   Single-file game engine: map + FPS controls + bots + weapons
   ============================================================ */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const randPick = (arr) => arr[(Math.random() * arr.length) | 0];

// ---------------- Config ----------------
// kickUp   = permanent crosshair climb per shot (rad) — pull down to control spray
// kickSide = horizontal drift per shot (rad)
// punch    = recoverable visual kick (rad, springs back)
// bloomAdd/Max/Decay = CS-style heat: consecutive shots widen spread, shown in crosshair
// sprayX/Y = per-shot pattern multipliers (AK climbs then sways, others mostly vertical)
const WEAPONS = {
  ak:     { name: 'AK-47', slot: 0, damage: 26, headMult: 3.5, magSize: 30, startReserve: 90, fireInterval: 0.105, reloadTime: 2.4,
             spreadHip: 0.022, spreadAim: 0.008, range: 120, auto: true, zoomFov: 55, price: 2500,
             kickUp: 0.0115, kickSide: 0.005, punch: 0.014, shake: 0.0035, vmKick: 0.075, fovPunch: 1.6,
             bloomAdd: 0.0048, bloomMax: 0.035, bloomDecay: 0.055, tracer: 0xffe08a, sound: 'rifle', falloff: 0.35 },
  deagle: { name: 'Desert Eagle', slot: 1, damage: 46, headMult: 3.4, magSize: 7, startReserve: 35, fireInterval: 0.32, reloadTime: 1.9,
             spreadHip: 0.016, spreadAim: 0.004, range: 95, auto: false, zoomFov: 60, price: 700,
             kickUp: 0.032, kickSide: 0.008, punch: 0.045, shake: 0.009, vmKick: 0.16, fovPunch: 2.2,
             bloomAdd: 0.016, bloomMax: 0.03, bloomDecay: 0.09, tracer: 0xffc46b, sound: 'pistol', falloff: 0.25 },
  awp:    { name: 'AWP', slot: 2, damage: 110, headMult: 2.0, magSize: 5, startReserve: 20, fireInterval: 1.15, reloadTime: 3.1,
             spreadHip: 0.085, spreadAim: 0.0006, range: 240, auto: false, zoomFov: 18, price: 4750,
             kickUp: 0.065, kickSide: 0.012, punch: 0.09, shake: 0.02, vmKick: 0.32, fovPunch: 4.5,
             bloomAdd: 0.05, bloomMax: 0.06, bloomDecay: 0.12, tracer: 0xbfe9ff, sound: 'sniper', falloff: 0.1 },
};
// Classic-style AK spray pattern (x,y multipliers per consecutive shot, resets after pause)
const SPRAY_AK = [
  [0.1, 1.0], [-0.2, 1.0], [0.35, 1.0], [-0.5, 0.95], [0.6, 0.9], [-0.7, 0.85],
  [0.8, 0.8], [-0.6, 0.85], [0.4, 0.9], [-0.9, 0.9], [1.0, 0.85], [-0.8, 0.9],
  [0.9, 0.9], [-1.0, 0.85], [0.7, 0.9], [-0.6, 0.9], [0.5, 0.9], [-0.5, 0.9],
];
const SLOT_ORDER = ['ak', 'deagle', 'awp'];
const MAP_HALF = 34;            // playable half-extent
const EYE = 1.62;
const ROUND_TIME = 120;         // 2:00 round (CS-like, timer starts after freeze)
const BUY_TIME = 5;             // CS-style short buy window each round start
const FREEZE_TIME = 3;          // frozen in spawn: look + buy, no move/shoot
const KILLS_TO_WIN_ROUND = 15;  // legacy (unused — rounds are elimination now)
const ROUNDS_TO_WIN_MATCH = 7;
const RESPAWN_DELAY = 3;        // legacy (unused — CS has no mid-round respawns)
// CS economy
const MONEY_START = 800;
const MONEY_KILL = 300;
const MONEY_WIN = 3250;
const MONEY_LOSS = 1900;
const MONEY_DRAW = 2000;
const MONEY_MAX = 16000;
const addMoney = (n) => { player.money = clamp(player.money + n, 0, MONEY_MAX); };

// ---------------- Defusal (bomb) config ----------------
// Proper defusal layout: T spawn WEST (far), CT spawn EAST-CENTRAL (between sites).
// Sites sit on the CT (east) side so T must push across mid / long / tunnels.
const SITES = [
  { name: 'A', pos: null, x: 24, z: -20, r: 4.2, color: 0x2e9bff }, // filled with Vector3 in buildMap
  { name: 'B', pos: null, x: 24, z: 20, r: 4.2, color: 0xffb020 },
];
const BOMB_PLANT_TIME = 3.2;   // seconds to plant
const BOMB_DEFUSE_TIME = 5.0;  // seconds to defuse (no kits in this build)
const BOMB_TIMER = 35;         // seconds from plant -> detonation
const BOMB = {
  carrier: null,        // bot ref carrying the bomb
  droppedPos: null,     // THREE.Vector3 when dropped on the ground
  planted: false,
  site: null,           // 'A' | 'B' once planted
  pos: null,            // planted Vector3
  targetSite: null,     // 'A' | 'B' — T objective for this round
  plantProgress: 0,
  plantingBot: null,
  defuseProgress: 0,
  defuser: null,        // 'player' | bot ref
  explodeAt: 0,         // performance-time seconds
  mesh: null,
  light: null,
  beepAt: 0,
  exploded: false,
};

const opts = { quality: true, sound: true, difficulty: 1 };

// ---------------- Audio (procedural WebAudio, full 3D) ----------------
// Realistic + dynamic: inverse-distance volume, stereo pan from listener yaw,
// air-absorption lowpass, wall occlusion, speed-of-sound delay, shared
// generated-impulse reverb + slap echo, per-weapon randomized layers.
const AudioSys = {
  ctx: null, master: null, comp: null, verb: null, verbGain: null,
  echo: null, echoFb: null, echoOut: null, muted: false,
  _white: null, _ambient: false, _stepAlt: false,
  init() {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      // master -> compressor -> destination (glue + anti-clip when many guns)
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.62;
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -16; this.comp.knee.value = 18;
      this.comp.ratio.value = 7; this.comp.attack.value = 0.003; this.comp.release.value = 0.16;
      this.master.connect(this.comp); this.comp.connect(this.ctx.destination);
      // generated stereo impulse reverb (outdoor slap / courtyard feel)
      const sr = this.ctx.sampleRate, len = Math.floor(sr * 1.7);
      const ir = this.ctx.createBuffer(2, len, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          const k = i / len;
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - k, 2.6) * 0.55;
        }
      }
      this.verb = this.ctx.createConvolver(); this.verb.buffer = ir;
      this.verbGain = this.ctx.createGain(); this.verbGain.gain.value = 0.42;
      this.verb.connect(this.verbGain); this.verbGain.connect(this.master);
      // shared slap echo for distant gun tails / bomb beeps
      this.echo = this.ctx.createDelay(1.0); this.echo.delayTime.value = 0.21;
      this.echoFb = this.ctx.createGain(); this.echoFb.gain.value = 0.32;
      this.echoOut = this.ctx.createGain(); this.echoOut.gain.value = 0.22;
      this.echo.connect(this.echoFb); this.echoFb.connect(this.echo);
      this.echo.connect(this.echoOut); this.echoOut.connect(this.master);
      // cached 1s white noise (reused with playbackRate jitter for variety)
      const wb = this.ctx.createBuffer(1, sr, sr);
      const wd = wb.getChannelData(0);
      for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
      this._white = wb;
      this._startAmbient();
    } catch (e) { /* no audio */ }
  },
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    if (this.ctx && !this._ambient) this._startAmbient();
  },
  now() { return this.ctx ? this.ctx.currentTime : 0; },
  env(gainNode, t, peak, decay) {
    gainNode.gain.setValueAtTime(Math.max(0.0002, peak), t);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  },
  noiseBuffer(dur) {
    const sr = this.ctx.sampleRate, buf = this.ctx.createBuffer(1, Math.max(1, Math.floor(sr * dur)), sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  },
  _startAmbient() {
    try {
      if (!this.ctx || this._ambient) return;
      this._ambient = true;
      // subtle wind: looped noise -> wandering lowpass -> quiet gain
      const src = this.ctx.createBufferSource();
      src.buffer = this._white; src.loop = true;
      src.playbackRate.value = 0.32;
      const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 320; f.Q.value = 0.4;
      const g = this.ctx.createGain(); g.gain.value = 0.035;
      const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.09;
      const lfoG = this.ctx.createGain(); lfoG.gain.value = 0.016;
      lfo.connect(lfoG); lfoG.connect(g.gain);
      const lfo2 = this.ctx.createOscillator(); lfo2.frequency.value = 0.05;
      const lfo2G = this.ctx.createGain(); lfo2G.gain.value = 130;
      lfo2.connect(lfo2G); lfo2G.connect(f.frequency);
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(); lfo.start(); lfo2.start();
    } catch (e) {}
  },
  _listenerPos() {
    try {
      if (typeof camera !== 'undefined' && camera && camera.position) {
        return { x: camera.position.x, y: camera.position.y, z: camera.position.z };
      }
    } catch (e) {}
    try {
      if (typeof player !== 'undefined' && player && player.pos) {
        return { x: player.pos.x, y: player.pos.y + 1.6, z: player.pos.z };
      }
    } catch (e) {}
    return { x: 0, y: 1.6, z: 0 };
  },
  // Core 3D model: returns {vol, pan, lp, delay, verb, dist, occluded}
  _spatial(pos, kind = 'sfx') {
    const fallback = { vol: 1, pan: 0, lp: 19000, delay: 0, verb: 0.08, dist: 0, occluded: false };
    if (!pos || typeof pos.x !== 'number') return fallback;
    const lp0 = this._listenerPos();
    const dx = pos.x - lp0.x, dy = (pos.y ?? 1.4) - lp0.y, dz = pos.z - lp0.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let vol;
    if (kind === 'gun') vol = 1 / (1 + dist * 0.135);
    else if (kind === 'explosion') vol = 1 / (1 + dist * 0.042);
    else if (kind === 'step') {
      vol = 1 / (1 + dist * 0.5);
      if (dist > 24) vol *= Math.max(0, 1 - (dist - 24) / 9); // footsteps fade fast
    }
    else if (kind === 'beep') vol = 1 / (1 + dist * 0.11);
    else if (kind === 'impact') vol = 1 / (1 + dist * 0.22);
    else vol = 1 / (1 + dist * 0.16);
    vol = clamp(vol, 0, 1);
    // stereo pan from listener yaw (right-vector projection)
    let pan = 0;
    try {
      const yaw = (typeof player !== 'undefined' && player) ? player.yaw : 0;
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const inv = 1 / (dist || 1);
      const nx = dx * inv, nz = dz * inv;
      pan = clamp((nx * rx + nz * rz) * 0.9, -1, 1);
      if (dist < 1.2) pan *= dist / 1.2; // avoid hard pan when on top of listener
      const front = nx * fx + nz * fz;
      if (front < 0) vol *= (0.88 + 0.12 * (1 + front)); // slightly quieter behind
    } catch (e) {}
    // air absorption: highs die with distance
    let lpF = 19000 * Math.exp(-dist * 0.035) + 420;
    lpF = clamp(lpF, 320, 19000);
    // occlusion: walls muffle + push to reverb
    let occluded = false;
    try {
      if (dist > 3 && typeof hasLOS !== 'undefined' && typeof THREE !== 'undefined') {
        const a = new THREE.Vector3(lp0.x, lp0.y, lp0.z);
        const b = new THREE.Vector3(pos.x, (pos.y ?? 1.4), pos.z);
        if (!hasLOS(a, b)) occluded = true;
      }
    } catch (e) {}
    if (occluded) { vol *= 0.30; lpF *= 0.36; }
    const verb = clamp(0.06 + dist / 52 + (occluded ? 0.22 : 0), 0.05, 0.62);
    const delay = Math.min(dist / 343, 0.24); // speed of sound
    return { vol, pan, lp: lpF, delay, verb, dist, occluded };
  },
  _pan(pan) {
    try {
      if (this.ctx.createStereoPanner) {
        const p = this.ctx.createStereoPanner();
        p.pan.value = clamp(pan, -1, 1);
        p.connect(this.master);
        return p;
      }
    } catch (e) {}
    return this.master; // fallback: mono
  },
  // generic filtered-noise hit routed through pan + reverb send
  _noise({ dur = 0.2, type = 'lowpass', freq = 1500, Q = 0.8, peak = 0.5, decay = 0.15, rate = 1, pos = null, kind = 'sfx', verb = null, echo = 0, at = 0, sweepTo = 0 }) {
    if (!this.ctx) return;
    const s = this._spatial(pos, kind);
    const t0 = this.now() + s.delay + at;
    const src = this.ctx.createBufferSource();
    src.buffer = this._white; src.loop = true;
    src.playbackRate.value = rate * rand(0.94, 1.06);
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(Math.min(freq * rand(0.92, 1.08), s.lp), t0);
    if (sweepTo > 0) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + decay);
    f.Q.value = Q;
    const g = this.ctx.createGain();
    this.env(g, t0, Math.max(0.0002, peak * s.vol), decay);
    const p = this._pan(s.pan);
    src.connect(f); f.connect(g); g.connect(p);
    const vAmt = verb !== null ? verb : s.verb;
    if (vAmt > 0.01) {
      const vs = this.ctx.createGain(); vs.gain.value = vAmt;
      g.connect(vs); vs.connect(this.verb);
    }
    if (echo > 0.01 && this.echo) {
      const es = this.ctx.createGain(); es.gain.value = echo * clamp(s.dist / 30, 0.15, 1);
      // echo itself muffled with distance
      const ef = this.ctx.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = clamp(s.lp * 0.4, 300, 4000);
      g.connect(ef); ef.connect(es); es.connect(this.echo);
    }
    const stopJit = dur + 0.08;
    try { src.start(t0, Math.random() * 0.5); src.stop(t0 + stopJit); } catch (e) {}
  },
  _tone({ type = 'sine', f0 = 440, f1 = 0, dur = 0.2, peak = 0.4, decay = 0.15, pos = null, kind = 'sfx', verb = null, at = 0 }) {
    if (!this.ctx) return;
    const s = this._spatial(pos, kind);
    const t0 = this.now() + s.delay + at;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0 * rand(0.97, 1.03)), t0);
    if (f1 > 0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + decay);
    const g = this.ctx.createGain();
    this.env(g, t0, Math.max(0.0002, peak * s.vol), decay);
    const p = this._pan(s.pan);
    o.connect(g); g.connect(p);
    const vAmt = verb !== null ? verb : s.verb;
    if (vAmt > 0.01) {
      const vs = this.ctx.createGain(); vs.gain.value = vAmt;
      g.connect(vs); vs.connect(this.verb);
    }
    try { o.start(t0); o.stop(t0 + dur + 0.05); } catch (e) {}
  },
  _asPos(distOrPos) {
    // backward compat: old callers passed a distance number; new callers pass a Vector3
    if (distOrPos && typeof distOrPos.x === 'number') return distOrPos;
    return null; // number/undefined -> treat as non-positional (full vol, shaped by legacy dist)
  },
  // ---- GUNS: first-person (pos=null) is dry/punchy; world guns are fully spatial ----
  shoot(kind, distOrPos = 0) {
    if (!this.ctx || !opts.sound || this.muted) return;
    const pos = this._asPos(distOrPos);
    const legacyVol = (typeof distOrPos === 'number') ? clamp(1 - distOrPos / 70, 0.08, 1) : 1;
    const firstPerson = !pos;
    const P = firstPerson ? 1 : 0; // helper to scale first-person-only extras
    if (kind === 'rifle') {
      // supersonic crack
      this._noise({ dur: 0.1, type: 'highpass', freq: 2100, peak: 0.55 * legacyVol, decay: 0.055, rate: 1.15, pos, kind: 'gun', echo: 0.05 });
      // receiver punch (mid bark)
      this._noise({ dur: 0.22, type: 'lowpass', freq: 2500, sweepTo: 500, peak: 0.95 * legacyVol, decay: 0.15, rate: 1.0, pos, kind: 'gun', echo: 0.10 });
      // chest thump
      this._tone({ type: 'sine', f0: 168, f1: 43, dur: 0.16, peak: 0.6 * legacyVol, decay: 0.13, pos, kind: 'gun' });
      // grit + mech, close only
      this._noise({ dur: 0.05, type: 'bandpass', freq: 3800, Q: 1.4, peak: 0.22 * legacyVol, decay: 0.035, rate: 1.3, pos, kind: 'gun' });
      if (firstPerson || (pos && this._spatial(pos, 'gun').dist < 14)) {
        const mp = firstPerson ? null : pos;
        this._tone({ type: 'square', f0: 4300, dur: 0.03, peak: 0.10 * legacyVol, decay: 0.03, pos: mp, kind: 'sfx', verb: 0.03 });
      }
    } else if (kind === 'pistol') {
      this._noise({ dur: 0.09, type: 'highpass', freq: 2900, peak: 0.6 * legacyVol, decay: 0.05, rate: 1.2, pos, kind: 'gun', echo: 0.04 });
      this._noise({ dur: 0.2, type: 'bandpass', freq: 1150, Q: 0.9, peak: 1.0 * legacyVol, decay: 0.14, rate: 1.0, pos, kind: 'gun', echo: 0.08 });
      this._tone({ type: 'sine', f0: 148, f1: 48, dur: 0.15, peak: 0.65 * legacyVol, decay: 0.12, pos, kind: 'gun' });
      this._noise({ dur: 0.04, type: 'highpass', freq: 5200, peak: 0.18 * legacyVol, decay: 0.03, rate: 1.4, pos, kind: 'gun' });
    } else { // sniper / awp: huge boom + long rolling echo
      this._noise({ dur: 0.16, type: 'highpass', freq: 850, peak: 0.75 * legacyVol, decay: 0.11, rate: 1.0, pos, kind: 'gun', echo: 0.12 });
      this._noise({ dur: 0.65, type: 'lowpass', freq: 950, sweepTo: 220, peak: 1.0 * legacyVol, decay: 0.5, rate: 0.85, pos, kind: 'gun', echo: 0.30 });
      this._tone({ type: 'sine', f0: 118, f1: 27, dur: 0.6, peak: 0.9 * legacyVol, decay: 0.5, pos, kind: 'gun', verb: 0.3 });
      // rolling thunder tail (two delayed low washes)
      this._noise({ dur: 0.5, type: 'lowpass', freq: 520, sweepTo: 150, peak: 0.4 * legacyVol, decay: 0.55, rate: 0.7, pos, kind: 'gun', verb: 0.55, echo: 0.4, at: 0.16 });
      this._noise({ dur: 0.6, type: 'lowpass', freq: 380, sweepTo: 120, peak: 0.26 * legacyVol, decay: 0.6, rate: 0.6, pos, kind: 'gun', verb: 0.6, echo: 0.45, at: 0.34 });
      void P;
    }
  },
  mech(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    this._tone({ type: 'square', f0: 4300, dur: 0.025, peak: 0.12, decay: 0.025, pos, kind: 'sfx', verb: 0.04 });
    this._noise({ dur: 0.04, type: 'bandpass', freq: 3200, Q: 2, peak: 0.16, decay: 0.035, rate: 1.5, pos, kind: 'sfx' });
    setTimeout(() => {
      this._tone({ type: 'square', f0: 2500, dur: 0.03, peak: 0.11, decay: 0.03, pos, kind: 'sfx', verb: 0.04 });
      this._noise({ dur: 0.05, type: 'bandpass', freq: 2000, Q: 1.6, peak: 0.14, decay: 0.04, rate: 1.2, pos, kind: 'sfx' });
    }, 55);
  },
  click(freq = 2000, dur = 0.05, vol = 0.25, pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    // metallic UI blip: square body + breath of noise for texture
    this._tone({ type: 'square', f0: freq, dur, peak: vol * 0.8, decay: dur, pos, kind: 'sfx', verb: 0.05 });
    this._noise({ dur: 0.03, type: 'highpass', freq: freq * 1.5, peak: vol * 0.25, decay: 0.025, rate: 1.6, pos, kind: 'sfx' });
  },
  dryfire() { this.click(300, 0.06, 0.3); },
  reload(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    // staged: mag out (clack) -> mag in (chunk) -> charge (shick-clack)
    this._noise({ dur: 0.06, type: 'bandpass', freq: 950, Q: 1.8, peak: 0.4, decay: 0.06, rate: 1.1, pos, kind: pos ? 'gun' : 'sfx' });
    this._tone({ type: 'square', f0: 900, dur: 0.07, peak: 0.22, decay: 0.07, pos, kind: 'sfx', verb: 0.06 });
    setTimeout(() => {
      this._noise({ dur: 0.06, type: 'bandpass', freq: 1500, Q: 1.8, peak: 0.42, decay: 0.06, rate: 1.25, pos, kind: pos ? 'gun' : 'sfx' });
      this._tone({ type: 'square', f0: 1400, dur: 0.07, peak: 0.22, decay: 0.07, pos, kind: 'sfx', verb: 0.06 });
    }, 180);
    setTimeout(() => {
      this._noise({ dur: 0.05, type: 'bandpass', freq: 2600, Q: 2, peak: 0.34, decay: 0.05, rate: 1.4, pos, kind: pos ? 'gun' : 'sfx' });
      this._tone({ type: 'square', f0: 700, dur: 0.09, peak: 0.26, decay: 0.09, pos, kind: 'sfx', verb: 0.07 });
    }, 700);
  },
  hit(headshot) {
    if (!this.ctx || !opts.sound || this.muted) return;
    if (headshot) {
      // bright skull-ping: metallic triangle + sizzle
      this._tone({ type: 'triangle', f0: 2750, f1: 2100, dur: 0.08, peak: 0.42, decay: 0.07, verb: 0.12 });
      this._noise({ dur: 0.05, type: 'highpass', freq: 4200, peak: 0.2, decay: 0.04, rate: 1.5 });
    } else {
      this._tone({ type: 'triangle', f0: 1950, f1: 1500, dur: 0.07, peak: 0.38, decay: 0.06, verb: 0.1 });
      this._noise({ dur: 0.04, type: 'highpass', freq: 3200, peak: 0.14, decay: 0.035, rate: 1.4 });
    }
  },
  kill() {
    if (!this.ctx || !opts.sound || this.muted) return;
    // punchy two-tone confirm with harmonic sheen
    this._tone({ type: 'triangle', f0: 620, dur: 0.1, peak: 0.42, decay: 0.1, verb: 0.16 });
    this._tone({ type: 'sine', f0: 1240, dur: 0.08, peak: 0.14, decay: 0.08, verb: 0.14 });
    setTimeout(() => {
      this._tone({ type: 'triangle', f0: 930, dur: 0.13, peak: 0.44, decay: 0.12, verb: 0.18 });
      this._tone({ type: 'sine', f0: 1860, dur: 0.1, peak: 0.13, decay: 0.1, verb: 0.16 });
    }, 105);
  },
  hurt() {
    if (!this.ctx || !opts.sound || this.muted) return;
    // body thud + grunt-ish saw drop + breath noise
    this._tone({ type: 'sawtooth', f0: 210, f1: 82, dur: 0.24, peak: 0.4, decay: 0.22, verb: 0.08 });
    this._tone({ type: 'sine', f0: 95, f1: 45, dur: 0.2, peak: 0.5, decay: 0.18 });
    this._noise({ dur: 0.14, type: 'lowpass', freq: 700, sweepTo: 200, peak: 0.3, decay: 0.13, rate: 0.8 });
  },
  step(pos = null, sprint = false) {
    if (!this.ctx || !opts.sound || this.muted) return;
    const isSelf = !pos || typeof pos.x !== 'number';
    this._stepAlt = !this._stepAlt;
    if (isSelf) {
      // own boots: alternating L/R micro-pan, gravel crunch + soft thud
      const pan = (this._stepAlt ? -1 : 1) * 0.12;
      const t0 = this.now();
      const mk = (freq, peak, rate) => {
        const src = this.ctx.createBufferSource(); src.buffer = this._white; src.loop = true;
        src.playbackRate.value = rate * rand(0.88, 1.12);
        const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq * rand(0.9, 1.1);
        const g = this.ctx.createGain(); this.env(g, t0, peak * rand(0.85, 1.15), 0.075);
        const p = this._pan(pan);
        src.connect(f); f.connect(g); g.connect(p);
        try { src.start(t0, Math.random() * 0.6); src.stop(t0 + 0.14); } catch (e) {}
      };
      mk(sprint ? 750 : 580, sprint ? 0.17 : 0.12, 0.9);
      mk(1400, 0.05, 1.5); // grit
      this._tone({ type: 'sine', f0: 85, f1: 50, dur: 0.07, peak: 0.10, decay: 0.07 });
    } else {
      // world boots: fully spatial, quiet, fade fast with distance
      const s = this._spatial(pos, 'step');
      if (s.vol < 0.015) return;
      this._noise({ dur: 0.09, type: 'lowpass', freq: rand(380, 640), peak: (sprint ? 0.5 : 0.36), decay: 0.075, rate: 0.85, pos, kind: 'step' });
    }
  },
  land(hard = false) {
    if (!this.ctx || !opts.sound || this.muted) return;
    this._tone({ type: 'sine', f0: hard ? 110 : 90, f1: 42, dur: 0.12, peak: hard ? 0.4 : 0.22, decay: 0.11 });
    this._noise({ dur: 0.1, type: 'lowpass', freq: hard ? 650 : 450, peak: hard ? 0.35 : 0.18, decay: 0.09, rate: 0.8 });
  },
  impact(pos, big = false) {
    if (!this.ctx || !opts.sound || this.muted || !pos) return;
    const s = this._spatial(pos, 'impact');
    if (s.vol < 0.012) return;
    // concrete snap + dust wash + faint metallic ring
    this._noise({ dur: 0.07, type: 'highpass', freq: 2400, peak: big ? 0.5 : 0.34, decay: 0.05, rate: 1.3, pos, kind: 'impact' });
    this._noise({ dur: 0.16, type: 'lowpass', freq: 900, sweepTo: 250, peak: 0.3, decay: 0.12, rate: 0.9, pos, kind: 'impact' });
    if (Math.random() < 0.4) this._tone({ type: 'triangle', f0: rand(2600, 3400), f1: 1700, dur: 0.09, peak: 0.10, decay: 0.09, pos, kind: 'impact', verb: 0.25 });
  },
  crack() {
    // supersonic whizz-by when a round snaps past the camera
    if (!this.ctx || !opts.sound || this.muted) return;
    const t0 = this.now();
    const src = this.ctx.createBufferSource(); src.buffer = this._white; src.loop = true;
    src.playbackRate.value = rand(1.4, 1.8);
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.1;
    f.frequency.setValueAtTime(rand(2800, 3800), t0);
    f.frequency.exponentialRampToValueAtTime(rand(900, 1300), t0 + 0.09);
    const g = this.ctx.createGain(); this.env(g, t0, rand(0.22, 0.34), 0.09);
    const p = this._pan(rand(-0.7, 0.7));
    src.connect(f); f.connect(g); g.connect(p);
    try { src.start(t0, Math.random() * 0.5); src.stop(t0 + 0.16); } catch (e) {}
  },
  shellTick(pos) {
    if (!this.ctx || !opts.sound || this.muted || !pos) return;
    const s = this._spatial(pos, 'impact');
    if (s.vol < 0.03 || s.dist > 14) return;
    this._tone({ type: 'triangle', f0: rand(3800, 5200), f1: 2600, dur: 0.03, peak: 0.07, decay: 0.03, pos, kind: 'impact', verb: 0.1 });
  },
  roundWin() {
    if (!this.ctx || !opts.sound || this.muted) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((fr, i) => setTimeout(() => {
      this._tone({ type: 'triangle', f0: fr, dur: 0.22, peak: 0.34, decay: 0.2, verb: 0.3 });
      this._tone({ type: 'sine', f0: fr * 2, dur: 0.16, peak: 0.08, decay: 0.15, verb: 0.28 });
    }, i * 128));
  },
  roundLose() {
    if (!this.ctx || !opts.sound || this.muted) return;
    [392, 329.6, 261.6, 196].forEach((fr, i) => setTimeout(() => {
      this._tone({ type: 'sawtooth', f0: fr, dur: 0.22, peak: 0.16, decay: 0.2, verb: 0.25 });
      this._tone({ type: 'triangle', f0: fr / 2, dur: 0.22, peak: 0.3, decay: 0.2, verb: 0.25 });
    }, i * 148));
  },
  beep(urgent = false, pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    // bomb beep: piercing sine + harmonic, positional so you can hunt it
    let p = pos;
    try {
      if (!p && typeof BOMB !== 'undefined' && BOMB.pos) p = BOMB.pos;
      else if (!p && typeof BOMB !== 'undefined' && BOMB.droppedPos) p = BOMB.droppedPos;
    } catch (e) {}
    const f = urgent ? 1560 : 1180;
    this._tone({ type: 'sine', f0: f, dur: 0.09, peak: urgent ? 0.5 : 0.36, decay: urgent ? 0.09 : 0.07, pos: p, kind: 'beep', verb: 0.3 });
    this._tone({ type: 'sine', f0: f * 2, dur: 0.05, peak: 0.08, decay: 0.05, pos: p, kind: 'beep' });
  },
  plantBeep() { [880, 880, 1174.7].forEach((fr, i) => setTimeout(() => this.click(fr, 0.09, 0.38), i * 118)); },
  plantedConfirm() { [659.25, 880, 659.25, 880].forEach((fr, i) => setTimeout(() => this.click(fr, 0.12, 0.42), i * 138)); },
  defuseTick(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    let p = pos;
    try { if (!p && typeof BOMB !== 'undefined' && BOMB.pos) p = BOMB.pos; } catch (e) {}
    this._tone({ type: 'sine', f0: 1500, dur: 0.04, peak: 0.2, decay: 0.04, pos: p, kind: 'beep', verb: 0.2 });
  },
  explode(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    try {
      let p = pos;
      try {
        if (!p && typeof BOMB !== 'undefined') p = (BOMB.pos || BOMB.droppedPos || null);
      } catch (e) {}
      // initial crack (close = violent, far = soft thump)
      this._noise({ dur: 0.22, type: 'highpass', freq: 600, peak: 0.9, decay: 0.16, rate: 1.0, pos: p, kind: 'explosion', echo: 0.1 });
      // core boom sweeping down
      this._noise({ dur: 1.3, type: 'lowpass', freq: 950, sweepTo: 55, peak: 1.0, decay: 1.15, rate: 0.9, pos: p, kind: 'explosion', verb: 0.5, echo: 0.35 });
      // sub drop you feel
      this._tone({ type: 'sine', f0: 105, f1: 26, dur: 1.1, peak: 0.95, decay: 1.0, pos: p, kind: 'explosion', verb: 0.35 });
      // debris rattles
      for (let i = 0; i < 5; i++) {
        this._noise({ dur: 0.08, type: 'bandpass', freq: rand(700, 2600), Q: 1.5, peak: 0.22, decay: 0.07, rate: rand(0.8, 1.3), pos: p, kind: 'explosion', at: rand(0.15, 0.8) });
      }
      // long smoky tail
      this._noise({ dur: 1.6, type: 'lowpass', freq: 320, sweepTo: 90, peak: 0.4, decay: 1.5, rate: 0.6, pos: p, kind: 'explosion', verb: 0.6, echo: 0.5, at: 0.25 });
    } catch (e) {}
  },
};

// ---------------- Three.js setup ----------------
let renderer, scene, camera, sunLight, muzzleLight, vmFill = null;
let maxAniso = 4;
const colliders = [];   // THREE.Box3[]
const waypoints = [];
const spawns = { ct: [], t: [] };

// Seeded value-noise helper for procedural textures (cheap, tileable-ish)
function _texRand(seedObj) {
  seedObj.s = (seedObj.s * 16807) % 2147483647;
  return (seedObj.s - 1) / 2147483646;
}

function makeCanvasTexture(draw, size = 256, repeat = 1, srgb = true) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

// Build a color map + matching bump map from one paint pass.
// draw(g, size, bumpCtx) paints color on g and height on bumpCtx (white=high).
function makePBRTexture(paint, size = 512, repeat = 1) {
  const cc = document.createElement('canvas'); cc.width = cc.height = size;
  const bc = document.createElement('canvas'); bc.width = bc.height = size;
  const g = cc.getContext('2d'), b = bc.getContext('2d');
  b.fillStyle = '#808080'; b.fillRect(0, 0, size, size);
  paint(g, b, size);
  const map = new THREE.CanvasTexture(cc);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(repeat, repeat);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAniso;
  const bumpMap = new THREE.CanvasTexture(bc);
  bumpMap.wrapS = bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.repeat.set(repeat, repeat);
  return { map, bumpMap };
}

function grainPass(g, s, n, alpha, light, dark, minR = 1, maxR = 3) {
  for (let i = 0; i < n; i++) {
    const v = Math.random();
    g.fillStyle = v < 0.5 ? light : dark;
    g.globalAlpha = Math.random() * alpha;
    const r = minR + Math.random() * (maxR - minR);
    g.fillRect(Math.random() * s, Math.random() * s, r, r);
  }
  g.globalAlpha = 1;
}

function blotchPass(g, s, n, colors, minR, maxR, alpha) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[(Math.random() * colors.length) | 0];
    g.globalAlpha = alpha * (0.5 + Math.random() * 0.5);
    const r = minR + Math.random() * (maxR - minR);
    g.beginPath();
    g.ellipse(Math.random() * s, Math.random() * s, r, r * (0.5 + Math.random() * 0.8), Math.random() * Math.PI, 0, 7);
    g.fill();
  }
  g.globalAlpha = 1;
}

function bumpBlotch(b, s, n, minR, maxR, up = true) {
  for (let i = 0; i < n; i++) {
    const v = up ? 150 + (Math.random() * 70 | 0) : 40 + (Math.random() * 50 | 0);
    b.fillStyle = `rgb(${v},${v},${v})`;
    b.globalAlpha = 0.25 + Math.random() * 0.3;
    const r = minR + Math.random() * (maxR - minR);
    b.beginPath(); b.arc(Math.random() * s, Math.random() * s, r, 0, 7); b.fill();
  }
  b.globalAlpha = 1;
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // filmic look: richer sun, softer highlights, less washed-out sand
  try {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
  } catch (e) {}
  try { maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy()); } catch (e) { maxAniso = 4; }
  $('game-container').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87a5c8);
  // warm dusty haze — hides far edge, adds depth
  scene.fog = new THREE.Fog(0xc4b295, 34, 165);

  camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 600);

  // late-afternoon desert sun: warm key + cool sky bounce + faint fill
  const hemi = new THREE.HemisphereLight(0xbdd5ff, 0x9a7d55, 0.75);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0xffe8c4, 0.18);
  scene.add(amb);
  sunLight = new THREE.DirectionalLight(0xffe3b8, 2.4);
  sunLight.position.set(34, 42, 20);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -48; sunLight.shadow.camera.right = 48;
  sunLight.shadow.camera.top = 48; sunLight.shadow.camera.bottom = -48;
  sunLight.shadow.camera.far = 160;
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.normalBias = 0.02;
  scene.add(sunLight);
  // cool bounce from opposite side so shadow faces aren't pitch black
  const fill = new THREE.DirectionalLight(0x9db8e8, 0.35);
  fill.position.set(-28, 22, -26);
  scene.add(fill);

  muzzleLight = new THREE.PointLight(0xffc36b, 0, 14, 2);
  scene.add(muzzleLight);

  // small warm fill attached to camera so viewmodel + nearby walls read well
  vmFill = new THREE.PointLight(0xfff0d8, 0.55, 6, 1.6);
  vmFill.position.set(0.1, 0.1, 0.2);
  camera.add(vmFill);
  scene.add(camera);

  // gradient sky dome with sun disc + procedural clouds + horizon dust
  const skyGeo = new THREE.SphereGeometry(420, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x2f5da8) },
      mid: { value: new THREE.Color(0x8fb0d8) },
      bottom: { value: new THREE.Color(0xe3c69a) },
      sunDir: { value: new THREE.Vector3(34, 42, 20).normalize() },
      sunCol: { value: new THREE.Color(0xfff3d0) },
      uTime: { value: 0 },
    },
    vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `
      uniform vec3 top; uniform vec3 mid; uniform vec3 bottom;
      uniform vec3 sunDir; uniform vec3 sunCol;
      uniform float uTime;
      varying vec3 vP;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        vec2 u = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1.,0.)), u.x),
                   mix(hash(i+vec2(0.,1.)), hash(i+vec2(1.,1.)), u.x), u.y);
      }
      float fbm(vec2 p){ float v=0.0; float a=0.5; for(int i=0;i<4;i++){ v+=a*vnoise(p); p*=2.1; a*=0.5; } return v; }
      void main(){
        vec3 d = normalize(vP);
        float h = d.y*0.5+0.5;
        vec3 col = mix(bottom, mid, smoothstep(0.48, 0.62, h));
        col = mix(col, top, smoothstep(0.62, 0.95, h));
        // horizon dust band
        col = mix(vec3(0.92,0.78,0.58), col, smoothstep(0.46, 0.56, h));
        // sun disc + glow
        float s = max(dot(d, normalize(sunDir)), 0.0);
        col += sunCol * (pow(s, 900.0) * 1.6 + pow(s, 18.0) * 0.22);
        // high clouds (slow drift with time)
        if (d.y > 0.04) {
          vec2 uv = d.xz / max(d.y, 0.12);
          float cl = fbm(uv * 1.4 + vec2(3.7 + uTime * 0.008, 1.3 + uTime * 0.003));
          float mask = smoothstep(0.52, 0.78, cl) * smoothstep(0.03, 0.25, d.y) * 0.5;
          col = mix(col, vec3(1.0, 0.98, 0.94), mask);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));
  try { scene.userData.skyMat = skyMat; } catch (e) {}

  // distant dune silhouette ring — sells "desert outpost" beyond walls
  try {
    const duneMat = new THREE.MeshBasicMaterial({ color: 0xb89a6e, fog: true });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.3;
      const w = 120 + Math.random() * 90, h = 14 + Math.random() * 22;
      const dune = new THREE.Mesh(new THREE.ConeGeometry(w * 0.5, h, 5), duneMat);
      dune.position.set(Math.cos(a) * 260, h * 0.28, Math.sin(a) * 260);
      dune.rotation.y = Math.random() * Math.PI;
      scene.add(dune);
    }
  } catch (e) {}

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

// ---------------- Map (de_dust-inspired) ----------------
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
const palmFronds = [], lampLightsArr = [], birdsArr = [];
let tumbleweed = null, tumbleVel = null;

function buildMap() {
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

  // Spawns — DEFUSAL CORRECT: T far WEST, CT EAST-CENTRAL between A/B (holds sites).
  // T must push ~45m across mid/long/tunnels; CT starts ~12-15m from either site.
  spawns.t = [new THREE.Vector3(-29, 0, -5), new THREE.Vector3(-29, 0, -1.7), new THREE.Vector3(-29, 0, 1.7), new THREE.Vector3(-29, 0, 5)];
  spawns.ct = [new THREE.Vector3(14.5, 0, -2.5), new THREE.Vector3(14.5, 0, 2.5), new THREE.Vector3(18, 0, -2.5), new THREE.Vector3(18, 0, 2.5)];

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

// ---------------- Soldier meshes ----------------
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

function makeSoldier(team) {
  const g = new THREE.Group();
  const tex = soldierTextures(team);
  const cBody = team === 'ct' ? 0xffffff : 0xffffff; // cloth map carries the color
  const skin = 0xc9986b;
  const matBody = new THREE.MeshStandardMaterial({ map: tex.cloth, color: cBody, roughness: 0.92 });
  const matPants = new THREE.MeshStandardMaterial({ map: tex.pants, roughness: 0.95 });
  const matSkin = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.65 });
  const matGun = new THREE.MeshStandardMaterial({ color: 0x1e1e22, roughness: 0.42, metalness: 0.65 });
  const matHelmet = new THREE.MeshStandardMaterial({ color: team === 'ct' ? 0x1d2f45 : 0x6b5a35, roughness: 0.75 });
  const matVest = new THREE.MeshStandardMaterial({ color: team === 'ct' ? 0x1a2330 : 0x3d3220, roughness: 0.95 });
  const matBoot = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.9 });
  const matPad = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.85 });

  // boots + legs + knee pads (legs pivot at hip via group offset trick kept simple: rotate mesh)
  const bootL = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.34), matBoot);
  bootL.position.set(-0.15, 0.07, 0.04); bootL.castShadow = true; g.add(bootL);
  const bootR = bootL.clone(); bootR.position.x = 0.15; g.add(bootR);
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.72, 0.24), matPants);
  legL.position.set(-0.15, 0.5, 0); legL.castShadow = true; g.add(legL);
  const legR = legL.clone(); legR.position.x = 0.15; g.add(legR);
  const padL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.08), matPad);
  padL.position.set(-0.15, 0.55, 0.14); g.add(padL);
  const padR = padL.clone(); padR.position.x = 0.15; g.add(padR);
  // belt + holster
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.1, 0.34), matVest);
  belt.position.y = 0.86; g.add(belt);
  const holster = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.22, 0.16), matBoot);
  holster.position.set(0.32, 0.72, 0.05); g.add(holster);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.72, 0.38), matBody);
  torso.position.y = 1.2; torso.castShadow = true; g.add(torso);
  // tactical vest front + mag pouches
  const vest = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.1), matVest);
  vest.position.set(0, 1.18, 0.22); vest.castShadow = true; g.add(vest);
  for (let i = -1; i <= 1; i++) {
    const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.18, 0.08), matVest);
    pouch.position.set(i * 0.15, 1.12, 0.29); g.add(pouch);
    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.085), matPad);
    flap.position.set(i * 0.15, 1.22, 0.29); g.add(flap);
  }
  // backpack + bedroll
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.5, 0.2), matVest);
  pack.position.set(0, 1.25, -0.29); pack.castShadow = true; g.add(pack);
  const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.46, 8),
    new THREE.MeshStandardMaterial({ color: team === 'ct' ? 0x3a4a5a : 0x7a6a48, roughness: 1 }));
  roll.rotation.z = Math.PI / 2; roll.position.set(0, 1.52, -0.29); g.add(roll);
  // team stripe (subtle emissive so friend/foe reads at distance)
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.09, 0.40),
    new THREE.MeshStandardMaterial({ color: team === 'ct' ? 0x66b3ff : 0xffc14d, emissive: team === 'ct' ? 0x1a3a5a : 0x5a3a10, emissiveIntensity: 0.7, roughness: 0.6 }));
  stripe.position.y = 1.44; g.add(stripe);
  // shoulder pads
  for (const sx of [-0.38, 0.38]) {
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.24), matVest);
    pad.position.set(sx, 1.52, 0); g.add(pad);
  }
  // head + helmet + eyewear (CT visor / T scarf)
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), matSkin);
  head.position.y = 1.76; head.castShadow = true; g.add(head);
  // jaw / beard shadow for T, clean for CT
  if (team === 't') {
    const beard = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x2e1f12, roughness: 1 }));
    beard.position.set(0, 1.66, 0.16); g.add(beard);
    const scarf = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.36),
      new THREE.MeshStandardMaterial({ color: 0x8a2f22, roughness: 1 }));
    scarf.position.y = 1.56; g.add(scarf);
  } else {
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x0e141c, roughness: 0.15, metalness: 0.8 }));
    glass.position.set(0, 1.79, 0.17); g.add(glass);
  }
  const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.18, 0.42), matHelmet);
  helmet.position.y = 1.98; helmet.castShadow = true; g.add(helmet);
  const helmBand = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.44), matVest);
  helmBand.position.y = 1.92; g.add(helmBand);
  // CT: NVG mount block. T: cloth tail
  if (team === 'ct') {
    const nvg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.08), matPad);
    nvg.position.set(0, 1.95, 0.24); g.add(nvg);
  } else {
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.04), matHelmet);
    tail.position.set(0, 1.86, -0.22); tail.rotation.x = 0.2; g.add(tail);
  }
  // arms with rolled-sleeve cuffs + gloves
  const matCuff = new THREE.MeshStandardMaterial({ color: team === 'ct' ? 0x22344e : 0x6e562f, roughness: 0.9 });
  const matGlove = new THREE.MeshStandardMaterial({ color: 0x2b2b26, roughness: 0.95 });
  const mkArm = (sx) => {
    const grp = new THREE.Group();
    grp.position.set(sx, 1.46, 0);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.4, 0.19), matBody);
    upper.position.y = -0.2; upper.castShadow = true; grp.add(upper);
    const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.2), matCuff);
    cuff.position.y = -0.38; grp.add(cuff);
    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.24, 0.16), matSkin);
    fore.position.set(0, -0.5, 0.08); fore.rotation.x = -0.9; grp.add(fore);
    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, 0.16), matGlove);
    glove.position.set(0, -0.58, 0.2); grp.add(glove);
    grp.rotation.x = -0.55;
    g.add(grp);
    return grp;
  };
  const armL = mkArm(-0.41), armR = mkArm(0.41);
  // detailed world gun: receiver + barrel + mag + stock + sight
  const gunG = new THREE.Group();
  const recv = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.55), matGun);
  gunG.add(recv);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.42, 6), matGun);
  barrel.rotation.x = Math.PI / 2; barrel.position.z = 0.47; gunG.add(barrel);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.22, 0.1), matGun);
  mag.position.set(0, -0.15, 0.05); mag.rotation.x = 0.35; gunG.add(mag);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.11, 0.28),
    new THREE.MeshStandardMaterial({ color: team === 'ct' ? 0x22303f : 0x6b4a2a, roughness: 0.8 }));
  stock.position.z = -0.4; gunG.add(stock);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.03), matGun);
  sight.position.set(0, 0.1, 0.18); gunG.add(sight);
  gunG.position.set(0.22, 1.25, 0.55);
  gunG.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.add(gunG);

  g.userData = { legL, legR, head, torso, gun: gunG, gunG, team };
  return g;
}

// ---------------- View-model gun (detailed procedural) ----------------
let viewmodel = null, vmMuzzle = null, vmBase = null, vmKickG = null, vmFlashGroup = null, vmBolt = null;
const vmRig = {
  kickZ: 0, kickV: 0, kickRot: 0, kickRotV: 0,   // spring state
  swayX: 0, swayY: 0, bobT: 0, aimK: 0, drawT: 1,
  fovKick: 0, punchP: 0, punchY: 0, shake: 0,
  muzzleT: 0, boltT: 0,
};
const VM_HIP = new THREE.Vector3(0.24, -0.235, -0.42);
const VM_AIM = {
  ak: new THREE.Vector3(0.0, -0.082, -0.32),
  deagle: new THREE.Vector3(0.0, -0.084, -0.30),
  awp: new THREE.Vector3(0.0, -0.107, -0.34),
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

function vmMats() {
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

function buildViewmodel(key) {
  if (viewmodel) { camera.remove(viewmodel); }
  if (!_flashTex) _flashTex = makeFlashTexture();
  const M = vmMats();
  viewmodel = new THREE.Group();
  vmBase = new THREE.Group();
  vmKickG = new THREE.Group();
  vmBolt = null;
  viewmodel.add(vmBase); vmBase.add(vmKickG);
  vmBase.position.copy(VM_HIP);
  const add = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.frustumCulled = false;
    parent.add(m); return m;
  };
  const B = (parent, w, h, d, mat, x, y, z, rx, ry, rz) => add(parent, new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz);
  const C = (parent, rt, rb, h, mat, x, y, z, rx = 0, seg = 12) => add(parent, new THREE.CylinderGeometry(rt, rb, h, seg), mat, x, y, z, rx);

  if (key === 'ak') {
    // receiver + cover
    B(vmKickG, 0.070, 0.085, 0.52, M.metal, 0, 0, -0.15);
    B(vmKickG, 0.066, 0.022, 0.48, M.steel, 0, 0.052, -0.15);
    B(vmKickG, 0.060, 0.030, 0.06, M.dark, 0, 0.045, -0.36); // rear sight base
    B(vmKickG, 0.042, 0.014, 0.09, M.dark, 0, 0.066, -0.24); // sight leaf
    B(vmKickG, 0.008, 0.022, 0.012, M.dark, 0, 0.078, -0.21); // notch
    // stock stub (toward camera)
    B(vmKickG, 0.058, 0.100, 0.24, M.wood, 0, -0.045, 0.20, -0.06);
    B(vmKickG, 0.060, 0.030, 0.20, M.woodD, 0, -0.095, 0.20, -0.06);
    // grip + trigger
    B(vmKickG, 0.050, 0.130, 0.060, M.wood, 0, -0.110, 0.03, 0.42);
    B(vmKickG, 0.052, 0.012, 0.075, M.dark, 0, -0.062, -0.03); // trigger guard bottom
    B(vmKickG, 0.010, 0.045, 0.012, M.dark, 0, -0.055, -0.005, 0.15); // guard front
    B(vmKickG, 0.012, 0.035, 0.014, M.steel, 0, -0.048, 0.005, 0.3); // trigger
    // curved mag (3 segments + ribs)
    B(vmKickG, 0.055, 0.100, 0.070, M.steel, 0, -0.090, -0.075, 0.18);
    B(vmKickG, 0.050, 0.100, 0.065, M.steel, 0, -0.172, -0.038, 0.45);
    B(vmKickG, 0.048, 0.060, 0.060, M.dark, 0, -0.232, 0.005, 0.60);
    B(vmKickG, 0.056, 0.008, 0.072, M.dark, 0, -0.115, -0.063, 0.18);
    // handguard wood + grooves
    B(vmKickG, 0.070, 0.050, 0.240, M.wood, 0, -0.018, -0.480);
    B(vmKickG, 0.066, 0.038, 0.240, M.wood, 0, 0.032, -0.480);
    for (let i = 0; i < 3; i++) B(vmKickG, 0.072, 0.008, 0.016, M.woodD, 0, -0.018, -0.40 - i * 0.07);
    // gas tube + block
    C(vmKickG, 0.013, 0.013, 0.200, M.woodD, 0, 0.048, -0.480, Math.PI / 2, 10);
    B(vmKickG, 0.030, 0.050, 0.040, M.metal, 0, 0.028, -0.620);
    // barrel + muzzle brake
    C(vmKickG, 0.011, 0.011, 0.200, M.metal, 0, 0.008, -0.700, Math.PI / 2, 10);
    C(vmKickG, 0.019, 0.019, 0.075, M.dark, 0, 0.008, -0.825, Math.PI / 2, 10);
    B(vmKickG, 0.040, 0.008, 0.050, M.dark, 0, 0.008, -0.825); // brake slots visual
    // front sight
    B(vmKickG, 0.008, 0.030, 0.008, M.dark, 0, 0.070, -0.700);
    B(vmKickG, 0.030, 0.022, 0.010, M.dark, 0, 0.062, -0.700);
    add(vmKickG, new THREE.SphereGeometry(0.005, 6, 6), M.glowG, 0, 0.085, -0.700);
    // charging handle + selector + rivets
    C(vmKickG, 0.008, 0.008, 0.05, M.steel, 0.045, 0.02, -0.160, Math.PI / 2, 8);
    B(vmKickG, 0.006, 0.014, 0.070, M.dark, 0.038, -0.01, -0.10, 0, 0, 0.5);
    for (const [rx, rz] of [[0.036, -0.30], [0.036, -0.05], [0.036, 0.05]]) C(vmKickG, 0.005, 0.005, 0.006, M.steel, rx, 0.0, rz, Math.PI / 2, 6);
    // sling loop
    B(vmKickG, 0.008, 0.030, 0.012, M.dark, -0.030, -0.05, -0.38);
    // hands (gloves)
    B(vmKickG, 0.072, 0.085, 0.085, M.glove, 0, -0.115, 0.035, 0.42); // right on grip
    B(vmKickG, 0.030, 0.060, 0.070, M.glove, 0.045, -0.105, 0.035, 0.42); // thumb
    B(vmKickG, 0.078, 0.065, 0.115, M.glove, 0, -0.058, -0.480); // left on handguard
    B(vmKickG, 0.070, 0.030, 0.100, M.gloveD, 0, -0.095, -0.480); // fingers under
    vmMuzzle = new THREE.Object3D(); vmMuzzle.position.set(0, 0.008, -0.88); vmKickG.add(vmMuzzle);
  } else if (key === 'deagle') {
    // slide (two-tone) + serrations
    B(vmKickG, 0.062, 0.068, 0.400, M.metal, 0, 0.020, -0.250);
    B(vmKickG, 0.058, 0.018, 0.390, M.chrome, 0, 0.058, -0.250); // top flat highlight
    for (let i = 0; i < 6; i++) {
      B(vmKickG, 0.064, 0.040, 0.010, M.dark, 0, 0.020, -0.085 - i * 0.016);
    }
    B(vmKickG, 0.064, 0.012, 0.060, M.dark, 0, -0.018, -0.18); // underlug
    // muzzle
    C(vmKickG, 0.019, 0.019, 0.02, M.dark, 0, 0.020, -0.455, Math.PI / 2, 12);
    C(vmKickG, 0.023, 0.023, 0.012, M.steel, 0, 0.020, -0.450, Math.PI / 2, 12);
    // sights with dots
    B(vmKickG, 0.010, 0.022, 0.010, M.dark, 0, 0.078, -0.430);
    add(vmKickG, new THREE.SphereGeometry(0.0045, 8, 8), M.glowW, 0, 0.082, -0.435);
    B(vmKickG, 0.030, 0.022, 0.014, M.dark, -0.018, 0.076, -0.075);
    B(vmKickG, 0.030, 0.022, 0.014, M.dark, 0.018, 0.076, -0.075);
    add(vmKickG, new THREE.SphereGeometry(0.004, 8, 8), M.glowW, -0.018, 0.078, -0.068);
    add(vmKickG, new THREE.SphereGeometry(0.004, 8, 8), M.glowW, 0.018, 0.078, -0.068);
    // frame + rail grooves
    B(vmKickG, 0.054, 0.042, 0.300, M.dark, 0, -0.032, -0.240);
    for (let i = 0; i < 3; i++) B(vmKickG, 0.056, 0.006, 0.012, M.rubber, 0, -0.050, -0.34 + i * 0.04);
    // trigger guard / trigger / hammer
    B(vmKickG, 0.014, 0.010, 0.110, M.dark, 0, -0.078, -0.150);
    B(vmKickG, 0.012, 0.045, 0.012, M.dark, 0, -0.055, -0.100, 0.25);
    B(vmKickG, 0.012, 0.032, 0.012, M.steel, 0, -0.048, -0.135, -0.25);
    B(vmKickG, 0.026, 0.030, 0.020, M.dark, 0, 0.005, -0.045, -0.5); // hammer
    B(vmKickG, 0.010, 0.014, 0.030, M.steel, -0.032, 0.005, -0.10); // safety
    B(vmKickG, 0.008, 0.012, 0.045, M.steel, -0.030, -0.015, -0.22); // slide stop
    // grip (angled) + panels + screws + baseplate
    B(vmKickG, 0.060, 0.170, 0.095, M.rubber, 0, -0.135, -0.005, 0.28);
    B(vmKickG, 0.064, 0.120, 0.070, M.dark, 0, -0.130, -0.002, 0.28);
    for (const sx of [-0.033, 0.033]) {
      C(vmKickG, 0.007, 0.007, 0.006, M.steel, sx, -0.115, 0.028, Math.PI / 2, 8);
    }
    B(vmKickG, 0.066, 0.022, 0.100, M.metal, 0, -0.220, 0.022, 0.28);
    add(vmKickG, new THREE.BoxGeometry(0.062, 0.02, 0.09), M.glove, 0, -0.205, 0.015).rotation.x = 0.28;
    // hands
    B(vmKickG, 0.074, 0.105, 0.095, M.glove, 0, -0.135, 0.005, 0.28); // right wraps grip
    B(vmKickG, 0.070, 0.050, 0.080, M.gloveD, 0, -0.095, -0.06, 0.28); // left cup under
    B(vmKickG, 0.018, 0.030, 0.040, M.glove, 0.030, -0.048, -0.135); // trigger finger
    vmMuzzle = new THREE.Object3D(); vmMuzzle.position.set(0, 0.020, -0.48); vmKickG.add(vmMuzzle);
  } else {
    // ---- AWP ----
    // stock (olive) + buttpad + cheek + thumbhole inset
    B(vmKickG, 0.065, 0.090, 0.560, M.olive, 0, -0.020, -0.080);
    B(vmKickG, 0.070, 0.120, 0.045, M.rubber, 0, -0.020, 0.210); // buttpad
    B(vmKickG, 0.060, 0.040, 0.180, M.olive, 0, 0.042, 0.060); // cheek riser
    B(vmKickG, 0.040, 0.050, 0.100, M.dark, 0, -0.030, 0.090); // thumbhole shadow
    // receiver + ejection port
    B(vmKickG, 0.060, 0.070, 0.300, M.metal, 0, 0.010, -0.250);
    B(vmKickG, 0.062, 0.020, 0.090, M.dark, 0.005, 0.025, -0.230); // port
    // barrel fluted + rings + muzzle brake
    C(vmKickG, 0.014, 0.014, 0.540, M.metal, 0, 0.010, -0.660, Math.PI / 2, 12);
    for (const z of [-0.55, -0.65, -0.75]) C(vmKickG, 0.016, 0.016, 0.015, M.dark, 0, 0.010, z, Math.PI / 2, 12);
    C(vmKickG, 0.023, 0.023, 0.095, M.dark, 0, 0.010, -0.955, Math.PI / 2, 12);
    B(vmKickG, 0.048, 0.010, 0.070, M.dark, 0, 0.010, -0.955);
    // scope: tube + bells + lenses + turrets + mounts
    C(vmKickG, 0.025, 0.025, 0.280, M.dark, 0, 0.105, -0.280, Math.PI / 2, 14);
    C(vmKickG, 0.036, 0.030, 0.075, M.dark, 0, 0.105, -0.450, Math.PI / 2, 14);
    C(vmKickG, 0.031, 0.026, 0.060, M.dark, 0, 0.105, -0.115, Math.PI / 2, 14);
    const lensF = add(vmKickG, new THREE.CircleGeometry(0.028, 16), M.lens, 0, 0.105, -0.489);
    lensF.rotation.y = Math.PI;
    add(vmKickG, new THREE.CircleGeometry(0.020, 16), M.dark, 0, 0.105, -0.084).rotation.y = 0;
    C(vmKickG, 0.012, 0.012, 0.022, M.steel, 0, 0.138, -0.280, 0, 10); // top turret
    C(vmKickG, 0.012, 0.012, 0.022, M.steel, 0.032, 0.105, -0.280, Math.PI / 2, 10); // side
    B(vmKickG, 0.020, 0.035, 0.030, M.dark, 0, 0.065, -0.200);
    B(vmKickG, 0.020, 0.035, 0.030, M.dark, 0, 0.065, -0.360);
    // crosshair inside scope (visible when aiming unscoped transition)
    // bolt handle (animated)
    const boltG = new THREE.Group(); boltG.position.set(0.035, 0.020, -0.170); vmKickG.add(boltG);
    C(boltG, 0.008, 0.008, 0.045, M.steel, 0.020, 0, 0, Math.PI / 2, 8);
    add(boltG, new THREE.SphereGeometry(0.014, 10, 8), M.dark, 0.045, -0.008, 0);
    vmBolt = boltG;
    // mag + trigger
    B(vmKickG, 0.050, 0.120, 0.120, M.metal, 0, -0.100, -0.220);
    B(vmKickG, 0.054, 0.018, 0.124, M.dark, 0, -0.165, -0.220);
    B(vmKickG, 0.052, 0.012, 0.070, M.dark, 0, -0.068, -0.100);
    B(vmKickG, 0.011, 0.030, 0.012, M.steel, 0, -0.055, -0.115, 0.2);
    // folded bipod
    B(vmKickG, 0.014, 0.014, 0.380, M.dark, -0.038, -0.030, -0.550);
    B(vmKickG, 0.014, 0.014, 0.380, M.dark, 0.038, -0.030, -0.550);
    // hands
    B(vmKickG, 0.072, 0.085, 0.085, M.glove, 0, -0.085, 0.060, 0.3);
    B(vmKickG, 0.078, 0.060, 0.115, M.glove, 0, -0.060, -0.380);
    B(vmKickG, 0.070, 0.028, 0.100, M.gloveD, 0, -0.092, -0.380);
    vmMuzzle = new THREE.Object3D(); vmMuzzle.position.set(0, 0.010, -1.02); vmKickG.add(vmMuzzle);
  }
  // ---- muzzle flash rig (star sprite + crossed planes + smoke anchor) ----
  vmFlashGroup = new THREE.Group();
  vmFlashGroup.position.copy(vmMuzzle.position);
  const flashMat = new THREE.MeshBasicMaterial({ map: _flashTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const f1 = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), flashMat);
  f1.name = 'flash'; f1.frustumCulled = false;
  const f2 = f1.clone(); f2.rotation.z = Math.PI / 2;
  const fwd = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.42), flashMat);
  fwd.rotation.y = Math.PI / 2; fwd.position.z = -0.08; fwd.frustumCulled = false;
  vmFlashGroup.add(f1); vmFlashGroup.add(f2); vmFlashGroup.add(fwd);
  vmKickG.add(vmFlashGroup);
  vmKickG.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });

  // rig reset + draw animation
  vmRig.kickZ = 0; vmRig.kickV = 0; vmRig.kickRot = 0; vmRig.kickRotV = 0;
  vmRig.drawT = 0; vmRig.aimK = player && player.aiming ? 1 : 0;
  vmBase.position.copy(VM_HIP);
  vmBase.position.y -= 0.22; vmBase.rotation.x = 0.55;
  camera.add(viewmodel);
  scene.add(camera);
}

// ---------------- Game state ----------------
const G = {
  phase: 'menu', // menu | playing | paused | over
  round: 1, score: { ct: 0, t: 0 }, roundKills: { ct: 0, t: 0 },
  timeLeft: ROUND_TIME, buyOpen: false, roundEnding: false,
  freezeLeft: 0, buyLeft: 0,
  kills: 0, deaths: 0, headshots: 0, shots: 0, hits: 0,
  startTime: 0,
};
const isFreeze = () => G.freezeLeft > 0;
const isBuyTime = () => G.buyLeft > 0 && !G.roundEnding;

const player = {
  team: 'ct', name: 'YOU',
  pos: new THREE.Vector3(-29, 0, 0), vel: new THREE.Vector3(),
  yaw: -Math.PI / 2, pitch: 0, onGround: true,
  hp: 100, armor: 0, money: MONEY_START, alive: true,
  weapons: { ak: { owned: false, mag: 0, reserve: 0 }, deagle: { owned: true, mag: 7, reserve: 35 }, awp: { owned: false, mag: 5, reserve: 0 } },
  cur: 'deagle', last: 'ak', reloading: 0, reloadDur: 1, nextShot: 0,
  aiming: false, respawnAt: 0, radius: 0.45, lastDmgDir: 0,
  kills: 0, deaths: 0,
  // gunplay state: bloom heat + spray index + recoverable punch + shake
  bloom: 0, sprayIdx: 0, lastShotT: -9,
  // spectate-after-death state (bot ref + camera mode)
  specTarget: null, specMode: 'chase', // 'first' | 'chase'
};

const bots = [];
const keys = {};
let pointerLocked = false;

// ---------------- Multiplayer (real players; no bots when humans are online) ----------------
// Rule: Net.hasRealOpponents === true  =>  pure PvP, bots hidden & skipped.
// Solo / alone-on-server => bots stay exactly as before.
const remotes = new Map(); // netId -> { data, mesh, nameTag, pos:Vector3, yaw, targetPos, walkPhase, flashAt }
let mpStatusEl = null;
function isMultiplayer() { try { return Net.active && Net.hasRealOpponents; } catch { return false; } }
function isOnline() { try { return Net.active; } catch { return false; } }

function makeNameTag(name, team) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 30px Arial';
  g.fillStyle = 'rgba(0,0,0,0.55)';
  const tw = Math.min(240, g.measureText(name).width + 28);
  g.beginPath();
  if (g.roundRect) g.roundRect(128 - tw / 2, 6, tw, 44, 10); else g.rect(128 - tw / 2, 6, tw, 44);
  g.fill();
  g.fillStyle = team === 'ct' ? '#6db3ff' : '#ffb020';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(name.slice(0, 14), 128, 30);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(2.2, 0.55, 1);
  return sp;
}

function addRemoteMesh(r) {
  if (remotes.has(r.id) || typeof scene === 'undefined' || !scene) return;
  const mesh = makeSoldier(r.team === 'ct' ? 'ct' : 't');
  const tag = makeNameTag(r.name || ('Player' + r.id), r.team);
  tag.position.y = 2.25;
  mesh.add(tag);
  mesh.position.set(r.x || 0, r.y || 0, r.z || 0);
  scene.add(mesh);
  remotes.set(r.id, {
    data: { ...r }, mesh, nameTag: tag,
    pos: new THREE.Vector3(r.x || 0, r.y || 0, r.z || 0),
    targetPos: new THREE.Vector3(r.x || 0, r.y || 0, r.z || 0),
    yaw: r.yaw || 0, targetYaw: r.yaw || 0,
    walkPhase: Math.random() * 6, flashAt: 0, lastShotAt: 0,
  });
}

function removeRemoteMesh(id) {
  const e = remotes.get(id);
  if (!e) return;
  try { scene.remove(e.mesh); } catch {}
  try { if (e.blob) scene.remove(e.blob); } catch {}
  remotes.delete(id);
  if (player.specTarget && player.specTarget.__remoteId === id) {
    player.specTarget = null;
    try { spectateCurrent(); updateSpectateOverlay(); } catch {}
  }
}

function syncRemoteMeshes() {
  // Create meshes for newcomers, drop leavers.
  try {
    for (const r of Net.remoteList()) {
      if (!remotes.has(r.id)) addRemoteMesh(r);
    }
    for (const id of [...remotes.keys()]) {
      if (!Net.remotes.has(id)) removeRemoteMesh(id);
    }
  } catch {}
}

function clearBotsForMP() {
  // Hide + deactivate bots while real players share the server.
  for (const b of bots) {
    b.alive = false; b.hp = 0;
    try { b.mesh.visible = false; } catch {}
    try { if (b.blob) b.blob.visible = false; } catch {}
    b.planting = false; b.defusing = false;
  }
  if (BOMB.carrier && BOMB.carrier.hasBomb !== undefined) { /* carrier was a bot — bomb goes neutral */ }
  if (BOMB.carrier && typeof BOMB.carrier === 'object' && BOMB.carrier.short) {
    BOMB.carrier = null;
    if (!BOMB.planted && !BOMB.droppedPos) {
      // Drop neutral bomb mid-map so T players can still play the objective.
      BOMB.droppedPos = new THREE.Vector3(0, 0, 0);
      try { spawnBombMesh(BOMB.droppedPos, false); } catch {}
    }
  }
  try { updateBombHUD(performance.now() / 1000); } catch {}
}

function restoreBotsForSolo() {
  // Re-enable bots when the last remote leaves / we disconnect.
  if (G.phase !== 'playing') return;
  let anyAlive = false;
  for (const b of bots) if (b.alive) { anyAlive = true; break; }
  if (anyAlive) return;
  for (const b of bots) {
    try { resetBot(b); } catch {}
  }
  try { bombResetRound(); } catch {}
}

function refreshBotsForMP() {
  if (isMultiplayer()) clearBotsForMP();
  else if (isOnline() && remotes.size === 0 && Net.remotes.size === 0) {
    // Alone on server: keep bots (do nothing — they were never cleared).
  }
  try { updateHUD(); } catch {}
}

function remoteEye(e) { return new THREE.Vector3(e.pos.x, e.pos.y + 1.55, e.pos.z); }
function remoteChest(e) { return new THREE.Vector3(e.pos.x, e.pos.y + 1.1, e.pos.z); }

function updateRemoteMeshes(dt, t) {
  syncRemoteMeshes();
  for (const [id, e] of remotes) {
    const r = Net.remotes.get(id);
    if (!r) continue;
    e.data = r;
    // Lerp position toward snapshot (15Hz -> smooth).
    e.targetPos.set(r.x || 0, r.y || 0, r.z || 0);
    const k = Math.min(1, dt * 12);
    e.pos.lerp(e.targetPos, k);
    let dy = (r.yaw || 0) - e.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
    e.yaw += dy * Math.min(1, dt * 10);
    e.targetYaw = r.yaw || 0;
    const m = e.mesh;
    m.position.copy(e.pos);
    // Face movement model uses same yaw convention as bots (atan2(dx,dz)).
    m.rotation.y = e.yaw + Math.PI;
    // Walk anim when moving.
    const moving = !!r.moving || e.targetPos.distanceToSquared(e.pos) > 0.0004;
    if (moving) e.walkPhase += dt * 9;
    const sw = moving ? Math.sin(e.walkPhase) * 0.5 : 0;
    try {
      m.userData.legL.rotation.x = sw; m.userData.legR.rotation.x = -sw;
      m.position.y = e.pos.y + (moving ? Math.abs(Math.sin(e.walkPhase)) * 0.05 : 0);
      // Aim-ish gun pitch from remote pitch.
      if (m.userData.gun) m.userData.gun.rotation.x = clamp(-(r.pitch || 0) * 0.5, -0.6, 0.6);
      // Muzzle flash blink.
      const fl = t < e.flashAt ? 1 : 0;
      m.scale.set(1, 1, 1);
      void fl;
      // Dead => fall over like bots.
      if (!r.alive) {
        if (m.rotation.x > -Math.PI / 2 + 0.05) m.rotation.x -= dt * 6;
        m.position.y = Math.max(0.2, m.position.y);
      } else {
        if (Math.abs(m.rotation.x) > 0.01) m.rotation.x *= Math.max(0, 1 - dt * 6);
        m.visible = !(player.specTarget && player.specTarget.__remoteId === id && player.specMode === 'first' && !player.alive);
      }
      updateBlob(e, e.pos.x, e.pos.z, !!r.alive, moving);
    } catch {}
  }
}

// Outgoing state @ ~20Hz + incoming event wiring (called once from boot).
let _mpWired = false;
function wireMultiplayer() {
  if (_mpWired) return; _mpWired = true;
  mpStatusEl = document.getElementById('mp-status');

  Net.on('welcome', (m) => {
    player.team = (m.team === 't') ? 't' : 'ct';
    player.name = Net.name || 'YOU';
    announce(`ONLINE AS ${player.team.toUpperCase()} — ${player.name}`, 1800);
    refreshBotsForMP();
    updateMPStatus();
    // Re-spawn on our team's side with the new team.
    if (G.phase === 'playing') {
      try {
        const sp = (player.team === 'ct' ? spawns.ct[0] : spawns.t[0]).clone();
        player.pos.copy(sp); player.yaw = faceCenterYawPlayer(player.pos);
      } catch {}
    }
  });
  Net.on('player_joined', () => { refreshBotsForMP(); updateMPStatus(); try { updateHUD(); } catch {} });
  Net.on('player_left', (m) => {
    try { removeRemoteMesh(m.id); } catch {}
    // If nobody real is left, bring bots back so solo-on-server still plays.
    if (Net.remotes.size === 0) { try { restoreBotsForSolo(); } catch {} }
    refreshBotsForMP(); updateMPStatus();
    try { updateHUD(); } catch {}
  });
  Net.on('disconnect', () => {
    for (const id of [...remotes.keys()]) try { removeRemoteMesh(id); } catch {}
    try { restoreBotsForSolo(); } catch {}
    updateMPStatus();
  });

  Net.on('shot', (m) => {
    // Remote tracer + positional gun sound.
    try {
      const e = remotes.get(m.fromId);
      const from = new THREE.Vector3(m.ox, m.oy, m.oz);
      const dir = new THREE.Vector3(m.dx, m.dy, m.dz).normalize();
      const end = from.clone().addScaledVector(dir, 30);
      const reduce = isMultiplayer();
      void reduce;
      spawnTracer(from, end, m.tracer || 0xff9a5c);
      spawnWorldFlash(from, m.tracer || 0xff9a5c, m.sound === 'sniper' ? 1.5 : 0.85);
      AudioSys.shoot(m.sound || 'rifle', from);
      if (e) e.flashAt = performance.now() / 1000 + 0.05;
      // Near-miss crack for remote shots.
      if (player.alive && camera) {
        const lp = camera.position;
        const ox = lp.x - from.x, oy = lp.y - from.y, oz = lp.z - from.z;
        const along = ox * dir.x + oy * dir.y + oz * dir.z;
        if (along > 0 && along < 45) {
          const px = from.x + dir.x * along - lp.x;
          const py = from.y + dir.y * along - lp.y;
          const pz = from.z + dir.z * along - lp.z;
          if (Math.sqrt(px * px + py * py + pz * pz) < 2.6 && Math.random() < 0.85)
            setTimeout(() => AudioSys.crack(), along / 343 * 1000);
        }
      }
    } catch {}
  });

  Net.on('hit', (m) => {
    // Someone shot *us* (authoritative damage applied by victim).
    try {
      if (m.targetId !== Net.id) return;
      if (!player.alive || G.phase !== 'playing') return;
      const e = remotes.get(m.fromId);
      const shooter = {
        isPlayer: false, team: m.fromTeam || (e ? e.data.team : 't'),
        bot: null, remote: e || null,
        remoteName: m.fromName || (e ? e.data.name : 'Enemy'),
        remotePos: e ? e.pos.clone() : null,
        weaponName: m.weapon || 'AK-47',
      };
      damagePlayer(m.dmg, shooter, !!m.head);
      if (player.alive === false) {
        // Tell everyone who killed us (victim-authoritative killfeed).
        Net.sendKilled({
          killerId: m.fromId, killerName: shooter.remoteName, killerTeam: shooter.team,
          victimId: Net.id, victimName: player.name, victimTeam: player.team,
          weapon: m.weapon || 'AK-47', head: !!m.head,
        });
      } else {
        playerHitmark?.(false, false);
      }
      // Hit direction arrow from remote position.
      if (e && typeof flashDamageRemote === 'function') flashDamageRemote(e.pos);
    } catch {}
  });

  Net.on('killed', (m) => {
    try {
      // Remote-vs-remote or remote-vs-us killfeed + round check.
      if (m.victimId === Net.id) return; // already handled locally in damagePlayer
      const e = remotes.get(m.victimId);
      if (e) { e.data.alive = false; e.data.hp = 0; }
      addKillfeed(m.killerName || '???', m.killerTeam || 't', m.victimName || '???', m.victimTeam || 'ct', m.weapon || 'AK-47', !!m.head);
      if (m.killerId === Net.id) {
        G.kills++; player.kills++; addMoney(MONEY_KILL); playerHitmark(m.head, true);
        AudioSys.kill();
        if (m.head) announce('HEADSHOT +$' + MONEY_KILL, 700);
        try { updateHUD(); } catch {}
      }
      checkRoundEnd();
    } catch {}
  });

  Net.on('bomb', (m) => {
    try { applyRemoteBomb(m); } catch (e) { console.warn('bomb msg', e); }
  });
  Net.on('round', (m) => {
    try { applyRemoteRound(m); } catch (e) { console.warn('round msg', e); }
  });
}

function updateMPStatus() {
  if (!mpStatusEl) mpStatusEl = document.getElementById('mp-status');
  if (!mpStatusEl) return;
  if (!Net.active) { mpStatusEl.textContent = 'OFFLINE — SOLO VS BOTS'; mpStatusEl.className = 'offline'; }
  else if (Net.hasRealOpponents) {
    mpStatusEl.textContent = `ONLINE · ${Net.realPlayers} PLAYERS · NO BOTS (PURE PVP)`;
    mpStatusEl.className = 'online pvp';
  } else {
    mpStatusEl.textContent = `ONLINE · ALONE — BOTS ACTIVE UNTIL PLAYERS JOIN`;
    mpStatusEl.className = 'online solo';
  }
}
function flashDamageRemote(remotePos) {
  try {
    const dx = remotePos.x - player.pos.x, dz = remotePos.z - player.pos.z;
    const worldAng = Math.atan2(dx, dz);
    const facing = player.yaw + Math.PI;
    const rel = worldAng - facing;
    const el = document.createElement('div');
    el.className = 'dmg-arrow';
    el.style.transform = `rotate(${-rel}rad)`;
    const di = $('direction-indicator');
    di.innerHTML = ''; di.appendChild(el); di.style.opacity = 1;
    setTimeout(() => di.style.opacity = 0, 600);
  } catch {}
}

// effects pools
const tracers = [], particles = [], corpses = [], shells = [], smokes = [];
const decals = [], shockwaves = [], debrisChunks = [], worldFlashes = [];
let _holeTex = null, _bloodTex = null, _scorchTex = null, _glowTex = null, _blobTex = null;

function decalTextures() {
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
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 34;
      const x = 64 + Math.cos(a) * r, y = 64 + Math.sin(a) * r;
      const rad = 3 + Math.random() * 11 * (1 - r / 48);
      g.fillStyle = `rgba(${110 + Math.random() * 40 | 0},8,10,${0.75 + Math.random() * 0.2})`;
      g.beginPath(); g.ellipse(x, y, rad, rad * (0.6 + Math.random() * 0.6), a, 0, 7); g.fill();
    }
    // arterial spatter streaks
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      g.strokeStyle = 'rgba(130,10,12,0.7)'; g.lineWidth = 1.5 + Math.random() * 2;
      g.beginPath(); g.moveTo(64, 64);
      g.lineTo(64 + Math.cos(a) * (38 + Math.random() * 22), 64 + Math.sin(a) * (38 + Math.random() * 22));
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
function spawnDecal(kind, pos, normal, size = 0.3, opacity = 1) {
  try {
    const T = decalTextures();
    const tex = kind === 'blood' ? T.blood : kind === 'scorch' ? T.scorch : T.hole;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
      opacity: kind === 'scorch' ? 0.95 * opacity : opacity,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    m.position.copy(pos).addScaledVector(normal, 0.02 + Math.random() * 0.012);
    // orient plane to surface: plane +z faces along normal
    m.lookAt(pos.clone().add(normal));
    m.rotation.z = Math.random() * Math.PI * 2;
    m.renderOrder = 2;
    scene.add(m);
    decals.push({ mesh: m, kind });
    // recycle oldest: bullet holes cap high (combat memory), blood/scorch lower
    const cap = kind === 'hole' ? 90 : kind === 'blood' ? 40 : 12;
    let count = 0;
    for (const d of decals) if (d.kind === kind) count++;
    if (count > cap) {
      const idx = decals.findIndex((d) => d.kind === kind);
      if (idx >= 0) { const old = decals.splice(idx, 1)[0]; scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose(); }
    }
  } catch (e) {}
}
function spawnBloodPool(x, z, big = false) {
  try {
    const T = decalTextures();
    const s = (big ? 2.2 : 1.4) * (0.85 + Math.random() * 0.4);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s * (0.8 + Math.random() * 0.4)),
      new THREE.MeshBasicMaterial({ map: T.blood, transparent: true, depthWrite: false, opacity: 0.92, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.rotation.x = -Math.PI / 2; m.rotation.z = Math.random() * Math.PI * 2;
    m.position.set(x + rand(-0.2, 0.2), 0.028, z + rand(-0.2, 0.2));
    m.renderOrder = 2;
    scene.add(m);
    decals.push({ mesh: m, kind: 'blood' });
    if (decals.filter((d) => d.kind === 'blood').length > 40) {
      const idx = decals.findIndex((d) => d.kind === 'blood');
      const old = decals.splice(idx, 1)[0]; scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose();
    }
  } catch (e) {}
}
function clearDecals() {
  for (const d of decals) { try { scene.remove(d.mesh); d.mesh.geometry.dispose(); d.mesh.material.dispose(); } catch (e) {} }
  decals.length = 0;
}

function spawnTracer(a, b, color) {
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
  const rad = 0.012 + Math.min(0.02, len * 0.0006);
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
    head.scale.setScalar(0.55);
    g.add(head);
  } catch (e) {}
  g.frustumCulled = false;
  scene.add(g);
  tracers.push({ mesh: g, beam, core, head, life: 0.09, max: 0.09 });
}

// world-space muzzle flash for bots / remotes / planted-bomb glow pulses
function spawnWorldFlash(pos, color = 0xffc36b, scale = 0.9) {
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
function spawnFireball(p, scale = 2.2, life = 0.45) {
  try {
    const T = decalTextures();
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xffb060, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.copy(p);
    m.scale.setScalar(scale * 0.5);
    scene.add(m);
    worldFlashes.push({ mesh: m, life, max: life, grow: scale * 3.2, fire: true });
  } catch (e) {}
}
function spawnShockwave(p, maxR = 9, life = 0.5, color = 0xffe0b0) {
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
function spawnDebris(p, n = 10, spread = 8, up = 7) {
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
function spawnBurst(p, color, n = 10, speed = 5, life = 0.5, size = 0.09) {
  if (!opts.quality) n = Math.min(n, 5);
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
function spawnSmoke(p, scale = 0.35, life = 0.7, tint = 0xbbbbbb) {
  if (!opts.quality) return;
  const mat = new THREE.SpriteMaterial({ map: smokeTexture(), color: tint, transparent: true, opacity: 0.5, depthWrite: false });
  const s = new THREE.Sprite(mat);
  s.position.copy(p);
  s.scale.setScalar(scale * rand(0.8, 1.2));
  scene.add(s);
  smokes.push({ mesh: s, vel: new THREE.Vector3(rand(-0.3, 0.3), rand(0.8, 1.6), rand(-0.3, 0.3)), life, maxLife: life, grow: scale * 1.6 });
}
const _shellGeo = null;
function spawnShell(worldPos, right, up, fwd) {
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
function updateEffects(dt, t = 0) {
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
    const dust = scene.getObjectByName('dustMotes');
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
      } else { vmBolt.position.z *= 0.8; vmBolt.rotation.y *= 0.8; }
    }
  }
}

// ---------------- Collision ----------------
const _tmpBox = new THREE.Box3();
function collidesAt(p, radius, height = 1.7) {
  _tmpBox.min.set(p.x - radius, p.y, p.z - radius);
  _tmpBox.max.set(p.x + radius, p.y + height, p.z + radius);
  for (const b of colliders) if (_tmpBox.intersectsBox(b)) return b;
  return null;
}
function moveWithCollision(p, dx, dz, radius) {
  // X axis
  let nx = p.x + dx;
  const hitX = collidesAt(new THREE.Vector3(nx, p.y, p.z), radius);
  if (!hitX) p.x = clamp(nx, -MAP_HALF, MAP_HALF);
  let nz = p.z + dz;
  const hitZ = collidesAt(new THREE.Vector3(p.x, p.y, p.z + dz), radius);
  if (!hitZ) p.z = clamp(nz, -MAP_HALF, MAP_HALF);
}
function rayWallDist(origin, dir, maxDist) {
  const ray = new THREE.Ray(origin, dir.clone().normalize());
  const pt = new THREE.Vector3();
  let best = maxDist;
  for (const b of colliders) {
    const hit = ray.intersectBox(b, pt);
    if (hit) { const d = origin.distanceTo(pt); if (d < best) best = d; }
  }
  return best;
}
function hasLOS(a, b) {
  const dir = b.clone().sub(a); const dist = dir.length(); dir.normalize();
  return rayWallDist(a, dir, dist - 0.3) >= dist - 0.35;
}

// soft blob shadow grounds characters where the sun map goes soft
function makeBlob(scale = 1.1) {
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
function updateBlob(entry, x, z, alive, moving) {
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
// staged death fall: fast tip-over -> ground thud dust -> settle (corpses persist to round end)
function updateDeadBots(dt) {
  for (const b of bots) {
    if (b.alive || !b.mesh.visible) continue;
    b.deathT = Math.min(1.4, (b.deathT || 0) + dt);
    const k = Math.min(1, b.deathT / 0.45);
    const ease = 1 - Math.pow(1 - k, 3);
    b.mesh.rotation.x = -Math.PI / 2 * ease;
    b.mesh.position.y = 0.2 * ease + Math.sin(Math.min(1, k) * Math.PI) * 0.12;
    if (!b._thudded && k >= 1) {
      b._thudded = true;
      try { spawnSmoke(new THREE.Vector3(b.pos.x, 0.25, b.pos.z), 0.7, 0.9, 0xbfae8e); } catch (e) {}
    }
    try { if (b.blob) { b.blob.position.set(b.pos.x, 0.02, b.pos.z); } } catch (e) {}
  }
}

// ---------------- Bots ----------------
function faceCenterYaw(pos) { return Math.atan2(-pos.x, -pos.z); } // mesh convention
function faceCenterYawPlayer(pos) { return Math.atan2(pos.x, pos.z); } // camera convention
function makeBot(team, idx) {
  const mesh = makeSoldier(team);
  scene.add(mesh);
  const spawn = (team === 'ct' ? spawns.ct : spawns.t)[idx % 4].clone();
  const bot = {
    team, idx, mesh, pos: spawn.clone(), vel: new THREE.Vector3(),
    yaw: faceCenterYaw(spawn), hp: 100, alive: true,
    respawnAt: 0, speed: rand(3.4, 4.6), state: 'roam',
    wp: waypoints.length ? randPick(waypoints).clone() : spawn.clone(), target: null,
    nextThink: Math.random() * 0.5, nextShot: 0, burstLeft: 0, burstAt: 0,
    strafeDir: 1, strafeAt: 0, flashAt: 0, walkPhase: Math.random() * 6,
    flinchT: 0, flinchHead: false, deathT: 0, blob: null,
    hasBomb: false, guardSite: team === 'ct' ? (idx < 2 ? 'A' : 'B') : null,
    siteOffset: new THREE.Vector3(rand(-2, 2), 0, rand(-2, 2)),
    planting: false, defusing: false,
    name: (team === 'ct' ? ['Blaze', 'Falcon', 'Havoc', 'Ghost'][idx] : ['Viper', 'Rattler', 'Jackal', 'Scorpion'][idx]) + (team === 'ct' ? ' [CT]' : ' [T]'),
    short: team === 'ct' ? ['Blaze', 'Falcon', 'Havoc', 'Ghost'][idx] : ['Viper', 'Rattler', 'Jackal', 'Scorpion'][idx],
  };
  mesh.position.copy(spawn);
  mesh.rotation.y = bot.yaw;
  try { bot.blob = makeBlob(1.25); if (bot.blob) bot.blob.position.set(spawn.x, 0.02, spawn.z); } catch (e) {}
  bots.push(bot);
  return bot;
}
function resetBot(bot) {
  const spawn = (bot.team === 'ct' ? spawns.ct : spawns.t)[bot.idx % 4];
  bot.pos.copy(spawn).add(new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1)));
  bot.yaw = faceCenterYaw(bot.pos);
  bot.hp = 100; bot.alive = true;
  bot.flinchT = 0; bot.flinchHead = false; bot.deathT = 0; bot._thudded = false;
  bot.wp = waypoints.length ? randPick(waypoints).clone() : bot.pos.clone();
  bot.target = null; bot.state = 'roam'; bot.mesh.visible = true;
  bot.hasBomb = false; bot.planting = false; bot.defusing = false;
  bot.siteOffset.set(rand(-2, 2), 0, rand(-2, 2));
  // CTs split to guard A/B; T objective assigned per-round in bombResetRound().
  if (bot.team === 'ct') bot.guardSite = bot.idx % 2 === 0 ? 'A' : 'B';
  bot.mesh.rotation.set(0, bot.yaw, 0);
  bot.mesh.position.copy(bot.pos);
  try { if (bot.blob) { bot.blob.visible = true; bot.blob.position.set(bot.pos.x, 0.02, bot.pos.z); } } catch (e) {}
}
function siteByName(n) { return SITES.find((s) => s.name === n); }
function isInSite(pos, site) {
  const dx = pos.x - site.x, dz = pos.z - site.z;
  return Math.hypot(dx, dz) < site.r;
}
function botEye(b) { return new THREE.Vector3(b.pos.x, b.pos.y + 1.55, b.pos.z); }
function botChest(b) { return new THREE.Vector3(b.pos.x, b.pos.y + 1.1, b.pos.z); }

function nearestEnemy(bot) {
  let best = null, bestD = 1e9;
  const eye = botEye(bot);
  // player? team-based (PvP-safe): bots only acquire opposite-team locals.
  if (player.alive && (player.team || 'ct') !== bot.team) {
    const p = new THREE.Vector3(player.pos.x, player.pos.y + 1.3, player.pos.z);
    const d = eye.distanceTo(p);
    if (d < 55 && hasLOS(eye, p) && d < bestD) { bestD = d; best = { type: 'player', d }; }
  }
  for (const o of bots) {
    if (!o.alive || o.team === bot.team) continue;
    if (o.team === 'ct' && bot.team === 'ct') continue;
    const p = botChest(o);
    const d = eye.distanceTo(p);
    const visRange = bot.team === 't' ? 55 : 50;
    if (d < visRange && d < bestD && hasLOS(eye, p)) { bestD = d; best = { type: 'bot', bot: o, d }; }
  }
  // Team-based: drop player target if same team (covers solo T vs CT bots).
  if (best && best.type === 'player' && (player.team || 'ct') === bot.team) best = null;
  return best;
}

function objectiveWaypoint(bot) {
  // Defusal objectives — T pushes target site, CTs guard / retake.
  if (BOMB.planted && BOMB.pos) {
    // Both teams converge on the planted site (with personal offset so they don't stack).
    return new THREE.Vector3(BOMB.pos.x + bot.siteOffset.x * 0.7, 0, BOMB.pos.z + bot.siteOffset.z * 0.7);
  }
  if (bot.team === 't') {
    // Dropped bomb recovery: nearest living T goes to pick it up.
    if (BOMB.droppedPos && !BOMB.planted) {
      // Carrier-less Ts head for the dropped bomb; carrier itself never exists here.
      return BOMB.droppedPos.clone();
    }
    const tgt = siteByName(BOMB.targetSite || 'A');
    if (bot.hasBomb) return new THREE.Vector3(tgt.x + rand(-1, 1), 0, tgt.z + rand(-1, 1));
    // Escorts: push the same site with a spread so the team arrives together.
    return new THREE.Vector3(tgt.x + bot.siteOffset.x * 1.6, 0, tgt.z + bot.siteOffset.z * 1.6);
  } else {
    // CT: hold assigned site pre-plant (slight patrol via think jitter).
    const g = siteByName(bot.guardSite || (bot.idx % 2 === 0 ? 'A' : 'B'));
    return new THREE.Vector3(g.x + bot.siteOffset.x * 1.4, 0, g.z + bot.siteOffset.z * 1.4);
  }
}

function botThink(bot, t) {
  bot.nextThink = t + rand(0.25, 0.5);
  bot.target = nearestEnemy(bot);
  if (bot.target) { bot.state = 'combat'; bot.strafeAt = t + rand(0.5, 1.4); if (Math.random() < 0.5) bot.strafeDir *= -1; }
  else {
    bot.state = 'objective';
    // Re-path toward objective when close / periodically so pushes look deliberate.
    if (bot.pos.distanceTo(bot.wp) < 2.5 || Math.random() < 0.35) {
      const ow = objectiveWaypoint(bot);
      // Blend objective with a nearby lane waypoint so bots use doors, not walls.
      bot.wp.copy(ow);
      if (Math.random() < 0.3 && waypoints.length) {
        const near = randPick(waypoints);
        if (near.distanceTo(bot.pos) < bot.pos.distanceTo(ow)) bot.wp.copy(near);
      }
    }
  }
  if (bot.target && Math.random() < 0.3) { bot.burstLeft = 2 + (Math.random() * 3 | 0); bot.burstAt = t; }
}

// ---------------- Bomb (defusal) ----------------
function bombClearMesh() {
  if (BOMB.mesh) { scene.remove(BOMB.mesh); BOMB.mesh = null; }
  if (BOMB.light) { scene.remove(BOMB.light); BOMB.light = null; }
}
function bombResetRound() {
  bombClearMesh();
  BOMB.carrier = null; BOMB.droppedPos = null; BOMB.planted = false;
  BOMB.site = null; BOMB.pos = null; BOMB.targetSite = Math.random() < 0.5 ? 'A' : 'B';
  BOMB.plantProgress = 0; BOMB.plantingBot = null;
  BOMB.defuseProgress = 0; BOMB.defuser = null;
  BOMB.explodeAt = 0; BOMB.exploded = false; BOMB.beepAt = 0;
  if (isMultiplayer()) {
    // Pure PvP: no bot carrier — T players carry (player.hasBomb set in startRound).
    for (const b of bots) b.hasBomb = false;
    updateBombHUD(0);
    return;
  }
  const aliveT = bots.filter((b) => b.team === 't');
  if (aliveT.length) {
    BOMB.carrier = randPick(aliveT);
    for (const b of aliveT) b.hasBomb = (b === BOMB.carrier);
  }
  for (const b of bots) if (b.team === 'ct') { b.guardSite = b.idx % 2 === 0 ? 'A' : 'B'; b.wp.copy(objectiveWaypoint(b)); }
  for (const b of bots) if (b.team === 't') b.wp.copy(objectiveWaypoint(b));
  updateBombHUD(0);
}
function bombDropAt(pos, fromNet = false) {
  BOMB.droppedPos = pos.clone(); BOMB.droppedPos.y = 0;
  BOMB.carrier = null; BOMB.plantProgress = 0; BOMB.plantingBot = null;
  spawnBombMesh(BOMB.droppedPos, false);
  announce('BOMB DROPPED', 1400);
  updateBombHUD(performance.now() / 1000);
  try { if (isOnline() && !fromNet) Net.sendBomb({ action: 'drop', x: BOMB.droppedPos.x, z: BOMB.droppedPos.z }); } catch {}
}
function spawnBombMesh(pos, planted) {
  bombClearMesh();
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.28, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.5, metalness: 0.5 }));
  body.position.y = 0.16; body.castShadow = true; g.add(body);
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xff2222, emissiveIntensity: 2 }));
  led.position.set(0.12, 0.33, 0); g.add(led);
  g.userData.led = led;
  g.position.copy(pos); g.position.y = 0;
  scene.add(g);
  BOMB.mesh = g;
  if (planted) {
    BOMB.light = new THREE.PointLight(0xff3333, 2, 9, 2);
    BOMB.light.position.copy(pos).add(new THREE.Vector3(0, 1, 0));
    scene.add(BOMB.light);
  }
}
function plantBomb(bot, site, t, fromNet = false) {
  const isPlayerPlanter = bot && bot.isPlayerPlanter;
  BOMB.planted = true; BOMB.site = site.name;
  BOMB.pos = (bot.pos || bot).clone ? (bot.pos ? bot.pos.clone() : bot.clone()) : new THREE.Vector3(bot.x, 0, bot.z);
  BOMB.pos.y = 0;
  BOMB.carrier = null;
  try { if (bot) bot.hasBomb = false; } catch {}
  if (isPlayerPlanter) player.hasBomb = false;
  BOMB.droppedPos = null; BOMB.plantProgress = 0; BOMB.plantingBot = null;
  BOMB.explodeAt = t + BOMB_TIMER; BOMB.beepAt = t;
  BOMB.defuseProgress = 0; BOMB.defuser = null;
  spawnBombMesh(BOMB.pos, true);
  AudioSys.plantedConfirm();
  announce(`BOMB PLANTED ON ${site.name} — DEFUSE IT!`, 2600);
  const planterName = isPlayerPlanter ? (player.name || 'YOU') : (bot.short || 'T');
  addKillfeed(planterName, 't', 'SITE ' + site.name, 'ct', '💣 C4', false);
  updateBombHUD(t);
  try { if (isOnline() && !fromNet) Net.sendBomb({ action: 'plant', site: site.name, x: BOMB.pos.x, z: BOMB.pos.z }); } catch {}
}
function plantBombByPlayer(site, t) {
  plantBomb({ isPlayerPlanter: true, pos: player.pos, hasBomb: player.hasBomb }, site, t, false);
}
function bombDroppedHit(origin, dir, maxT) {
  // Ray vs dropped C4 only — planted C4 is bulletproof by design.
  // Returns distance or null. Small ground target: sphere at y~0.3, r~0.55.
  if (BOMB.planted || !BOMB.droppedPos || G.roundEnding || G.phase !== 'playing') return null;
  const cx = BOMB.droppedPos.x, cy = 0.3, cz = BOMB.droppedPos.z;
  const r = 0.55;
  const ox = origin.x - cx, oy = origin.y - cy, oz = origin.z - cz;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const tt = -b - Math.sqrt(disc);
  if (tt > 0.3 && tt < maxT) return tt;
  return null;
}
function explodeBomb(t, reason, fromNet = false) {
  if (BOMB.exploded || G.roundEnding) return;
  try { if (isOnline() && !fromNet) Net.sendBomb({ action: 'explode', reason: reason || '' }); } catch {}
  BOMB.exploded = true;
  const groundZero = BOMB.planted && BOMB.pos ? BOMB.pos : BOMB.droppedPos;
  const p = groundZero ? groundZero.clone().add(new THREE.Vector3(0, 1, 0)) : new THREE.Vector3(24, 1, 0);
  AudioSys.explode(p);
  spawnBurst(p, 0xffd27a, 40, 12, 0.9, 0.22);
  spawnBurst(p, 0xff6a2a, 30, 9, 1.1, 0.3);
  spawnBurst(p, 0x555555, 24, 6, 1.6, 0.35);
  spawnSmoke(p, 1.6, 2.2, 0x444444);
  // cinematic layers: core fireball, rolling fireballs, shockwave, debris, dust column, scorch
  spawnFireball(p, 5.5, 0.5);
  spawnFireball(p.clone().add(new THREE.Vector3(rand(-1, 1), 1.2, rand(-1, 1))), 3.4, 0.7);
  spawnFireball(p.clone().add(new THREE.Vector3(rand(-1.5, 1.5), 0.4, rand(-1.5, 1.5))), 2.6, 0.9);
  spawnShockwave(p, 11, 0.55);
  setTimeout(() => { try { spawnShockwave(p, 7, 0.4, 0xc8b090); } catch (e) {} }, 120);
  spawnDebris(p, opts.quality ? 16 : 8, 10, 10);
  for (let i = 0; i < 5; i++) {
    const c = p.clone().add(new THREE.Vector3(rand(-2.5, 2.5), rand(0, 2), rand(-2.5, 2.5)));
    spawnSmoke(c, rand(0.8, 1.4), rand(1.4, 2.4), i % 2 ? 0x555555 : 0x8a7a64);
  }
  try {
    const gz = groundZero ? groundZero.clone() : p.clone().setY(0);
    spawnDecal('scorch', new THREE.Vector3(gz.x, 0.06, gz.z), new THREE.Vector3(0, 1, 0), 7.5, 1);
    spawnDecal('scorch', new THREE.Vector3(gz.x + rand(-1, 1), 0.055, gz.z + rand(-1, 1)), new THREE.Vector3(0, 1, 0), 4, 0.8);
  } catch (e) {}
  try { flashExplosionOverlay(); } catch (e) {}
  muzzleLight.position.copy(p); muzzleLight.intensity = 14; muzzleLight.distance = 55;
  if (camera) {
    const d = camera.position.distanceTo(p);
    vmRig.shake += clamp(0.09 * (1 - d / 50), 0.01, 0.09);
    vmRig.fovKick += clamp(6 * (1 - d / 50), 0, 6);
  }
  setTimeout(() => bombClearMesh(), 2500);
  BOMB.planted = false; // stop the HUD timer — round is decided, mesh burns out visually
  BOMB.droppedPos = null; BOMB.carrier = null; BOMB.plantingBot = null;
  BOMB.defuser = null;
  endRound('t', reason || '💥 BOMB DETONATED');
}
function defuseBomb(byPlayer, t, fromNet = false) {
  if (G.roundEnding) return;
  try { if (isOnline() && !fromNet) Net.sendBomb({ action: 'defuse', by: player.name || 'CT' }); } catch {}
  AudioSys.roundWin();
  announce(byPlayer ? 'BOMB DEFUSED — YOU SAVED THE SITE!' : 'BOMB DEFUSED — CT WINS', 2400);
  bombClearMesh();
  BOMB.planted = false; BOMB.pos = null; BOMB.site = null;
  BOMB.defuseProgress = 0; BOMB.defuser = null;
  endRound('ct', 'BOMB DEFUSED');
}
// ---- Remote bomb/round application (PvP sync, last-write-wins for bomb) ----
function applyRemoteBomb(m) {
  const t = performance.now() / 1000;
  const act = m.action;
  if (act === 'plant') {
    if (BOMB.planted) return;
    const site = siteByName(m.site || 'A') || SITES[0];
    BOMB.planted = true; BOMB.site = site.name;
    BOMB.pos = new THREE.Vector3(m.x || site.x, 0, m.z || site.z);
    BOMB.carrier = null; BOMB.droppedPos = null;
    BOMB.plantProgress = 0; BOMB.plantingBot = null;
    BOMB.explodeAt = t + BOMB_TIMER; BOMB.beepAt = t;
    BOMB.defuseProgress = 0; BOMB.defuser = null;
    player.hasBomb = false;
    spawnBombMesh(BOMB.pos, true);
    AudioSys.plantedConfirm();
    announce(`BOMB PLANTED ON ${site.name} — DEFUSE IT!`, 2600);
    addKillfeed(m.fromName || 'T', m.fromTeam || 't', 'SITE ' + site.name, 'ct', '💣 C4', false);
    updateBombHUD(t);
  } else if (act === 'defuse') {
    if (G.roundEnding) return;
    bombClearMesh();
    BOMB.planted = false; BOMB.pos = null; BOMB.site = null;
    BOMB.defuseProgress = 0; BOMB.defuser = null;
    AudioSys.roundWin();
    announce(`BOMB DEFUSED BY ${m.by || m.fromName || 'CT'} — CT WINS`, 2400);
    endRound('ct', 'BOMB DEFUSED', true);
  } else if (act === 'drop') {
    if (BOMB.planted) return;
    BOMB.droppedPos = new THREE.Vector3(m.x || 0, 0, m.z || 0);
    BOMB.carrier = null; BOMB.plantProgress = 0; BOMB.plantingBot = null;
    spawnBombMesh(BOMB.droppedPos, false);
    announce('BOMB DROPPED', 1400);
    updateBombHUD(t);
  } else if (act === 'pickup') {
    if (BOMB.planted) return;
    BOMB.droppedPos = null; bombClearMesh();
    announce(`${m.fromName || 'T'} PICKED UP THE BOMB`, 1200);
    updateBombHUD(t);
  } else if (act === 'explode') {
    if (BOMB.exploded || G.roundEnding) return;
    explodeBomb(t, m.reason || '💥 BOMB DETONATED', true);
  }
}
function applyRemoteRound(m) {
  if (m.action === 'start') {
    // Guest follows host round numbering.
    if (typeof m.round === 'number' && m.round !== G.round) G.round = m.round;
    if (!G.roundEnding) return; // already live — ignore duplicate starts
    startRound(!!m.first, true);
  } else if (m.action === 'end') {
    if (G.phase !== 'playing' || G.roundEnding) return;
    endRound(m.winner || 't', m.reason || '', true);
  }
}
function updateBombHUD(t) {
  const bar = $('bomb-status'), txt = $('bomb-text'), tmr = $('bomb-timer');
  if (!bar) return;
  if (G.phase !== 'playing') { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.classList.remove('planted', 'ct');
  if (BOMB.planted && BOMB.pos) {
    const left = Math.max(0, BOMB.explodeAt - t);
    bar.classList.add('planted');
    txt.innerHTML = `💣 BOMB ON <span class="t">${BOMB.site}</span> — DEFUSE!`;
    tmr.textContent = left.toFixed(1) + 's';
  } else if (BOMB.droppedPos) {
    txt.innerHTML = `<span class="t">BOMB DROPPED</span> — UNSTABLE, DO NOT SHOOT`;
    tmr.textContent = 'SITE ' + (BOMB.targetSite || 'A');
  } else if (BOMB.carrier && BOMB.carrier.alive) {
    bar.classList.add('ct');
    txt.innerHTML = `<span class="t">💣 ${BOMB.carrier.short}</span> heading <span class="t">${BOMB.targetSite}</span>`;
    tmr.textContent = 'STOP THE PLANT';
  } else if (player.hasBomb && !BOMB.planted && (player.team || 'ct') === 't') {
    bar.classList.add('ct');
    txt.innerHTML = `<span class="t">💣 YOU</span> — PLANT ON <span class="t">A / B</span>`;
    tmr.textContent = 'HOLD E IN SITE';
  } else {
    txt.textContent = 'BOMB IN PLAY';
    tmr.textContent = 'SITE ' + (BOMB.targetSite || 'A');
  }
}
function updateInteractHUD(label, frac, isDefuse) {
  const bar = $('interact-bar');
  if (!bar) return;
  if (!label) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('interact-label').textContent = label;
  const f = $('interact-fill');
  f.style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
  f.classList.toggle('defuse', !!isDefuse);
}

function botShoot(bot, t, targetPos) {
  const diff = opts.difficulty;
  const interval = rand(0.35, 0.7) / diff;
  if (t < bot.nextShot) return;
  bot.nextShot = t + interval;
  const from = botEye(bot);
  const dist = from.distanceTo(targetPos);
  const spread = clamp(0.02 + dist * 0.0016, 0.02, 0.09) / Math.sqrt(diff);
  const dir = targetPos.clone().sub(from).normalize();
  dir.x += rand(-spread, spread); dir.y += rand(-spread, spread); dir.z += rand(-spread, spread);
  dir.normalize();
  fireHitscan({ team: bot.team, isPlayer: false, bot }, from, dir, { damage: 11 * diff, headMult: 2.2, range: 90, tracer: 0xff9a5c, sound: 'rifle' }, t);
  bot.flashAt = t + 0.05;
}

// bot per-frame update (defusal-aware: plant / defend / defuse / recover)
function updateBot(bot, dt, t) {
  const m = bot.mesh;
  if (isMultiplayer()) return; // pure PvP — bots stay hidden/dead
  if (!bot.alive) return; // CS: no mid-round respawns — wait for next round
  if (isFreeze()) { // frozen: hold position, no thinking/shooting
    m.position.copy(bot.pos);
    bot.planting = false; bot.defusing = false;
    return;
  }
  if (t >= bot.nextThink) botThink(bot, t);
  let moveDir = null, speed = bot.speed;

  // --- Bomb pickup (T walks over dropped bomb) ---
  if (bot.team === 't' && !BOMB.planted && BOMB.droppedPos && !BOMB.carrier) {
    if (bot.pos.distanceTo(BOMB.droppedPos) < 1.6) {
      BOMB.carrier = bot; bot.hasBomb = true; BOMB.droppedPos = null;
      bombClearMesh();
      announce(`${bot.short} PICKED UP THE BOMB`, 1400);
      AudioSys.plantBeep();
      bot.wp.copy(objectiveWaypoint(bot));
      updateBombHUD(t);
    }
  }

  // --- Plant attempt (carrier inside its target site, holds still) ---
  let isPlanting = false;
  if (bot.team === 't' && bot.hasBomb && !BOMB.planted && !G.roundEnding) {
    const tgt = siteByName(BOMB.targetSite || 'A');
    if (tgt && isInSite(bot.pos, tgt)) {
      const enemyClose = bot.target && bot.target.d < 12;
      if (!enemyClose) {
        isPlanting = true;
        bot.planting = true;
        BOMB.plantingBot = bot;
        // Face site center while planting.
        bot.yaw = Math.atan2(tgt.x - bot.pos.x, tgt.z - bot.pos.z);
        BOMB.plantProgress += dt;
        // Audio tick each ~0.8s while planting (positional so CTs can hear it).
        if (!bot._plantTick || t - bot._plantTick > 0.8) {
          bot._plantTick = t;
          try { AudioSys.click(980, 0.06, 0.3, new THREE.Vector3(bot.pos.x, 1.2, bot.pos.z)); }
          catch (e) { AudioSys.click(980, 0.06, 0.3); }
        }
        if (BOMB.plantProgress >= BOMB_PLANT_TIME) {
          plantBomb(bot, tgt, t);
          bot.planting = false;
          return; // planted — next frames defend.
        }
      }
    }
  }
  if (!isPlanting && BOMB.plantingBot === bot) { BOMB.plantingBot = null; }
  if (!isPlanting) {
    bot.planting = false;
    // Plant progress decays if carrier is interrupted (moved/fought), not instant reset
    // so brief peeks don't fully punish — but dropping the bomb resets it.
    if (BOMB.plantingBot === null && BOMB.plantProgress > 0 && !BOMB.planted) {
      BOMB.plantProgress = Math.max(0, BOMB.plantProgress - dt * 1.5);
    }
  }

  // --- Defuse attempt (CT near planted bomb, holds still) ---
  let isDefusing = false;
  if (bot.team === 'ct' && BOMB.planted && BOMB.pos && !G.roundEnding) {
    const dBomb = bot.pos.distanceTo(BOMB.pos);
    if (dBomb < 2.6) {
      const tAlive = bots.some((o) => o.alive && o.team === 't');
      const enemyClose = bot.target && bot.target.d < 11 && tAlive;
      // Only the closest CT defuses; others cover. If no defuser yet, claim it.
      const claimable = !BOMB.defuser || BOMB.defuser === bot || !BOMB.defuser.alive;
      if ((!enemyClose || !tAlive) && claimable) {
        // Check this bot is (one of) the closest — avoids 3 bots stacking on bomb.
        let closest = bot, bestD = dBomb;
        for (const o of bots) {
          if (!o.alive || o.team !== 'ct' || o === bot) continue;
          const dd = o.pos.distanceTo(BOMB.pos);
          if (dd < bestD) { bestD = dd; closest = o; }
        }
        if (closest === bot) {
          isDefusing = true;
          bot.defusing = true;
          BOMB.defuser = bot;
          bot.yaw = Math.atan2(BOMB.pos.x - bot.pos.x, BOMB.pos.z - bot.pos.z);
          BOMB.defuseProgress += dt;
          if (!bot._defTick || t - bot._defTick > 0.5) { bot._defTick = t; AudioSys.defuseTick(BOMB.pos); }
          if (BOMB.defuseProgress >= BOMB_DEFUSE_TIME) {
            defuseBomb(false, t);
            return;
          }
        }
      }
    }
  }
  if (!isDefusing && BOMB.defuser === bot) BOMB.defuser = null;
  if (!isDefusing) bot.defusing = false;

  // Planting / defusing bots stand still and don't shoot (CS interaction locks weapon).
  if (isPlanting || isDefusing) {
    m.position.copy(bot.pos);
    let dy0 = bot.yaw - m.rotation.y;
    while (dy0 > Math.PI) dy0 -= Math.PI * 2; while (dy0 < -Math.PI) dy0 += Math.PI * 2;
    m.rotation.y += dy0 * Math.min(1, dt * 10);
    m.userData.legL.rotation.x *= 0.8; m.userData.legR.rotation.x *= 0.8;
    return;
  }

  if (bot.state === 'combat' && bot.target) {
    let tp = null;
    if (bot.target.type === 'player') tp = new THREE.Vector3(player.pos.x, player.pos.y + 1.2, player.pos.z);
    else if (bot.target.bot.alive) tp = botChest(bot.target.bot);
    else { bot.target = null; bot.state = 'objective'; }
    if (tp) {
      // face target
      const dx = tp.x - bot.pos.x, dz = tp.z - bot.pos.z;
      bot.yaw = Math.atan2(dx, dz);
      const dist = Math.hypot(dx, dz);
      // Carrier with bomb prefers to break contact and run to site if enemy is far;
      // if enemy is close, fight normally.
      const carrierFleeing = bot.hasBomb && !BOMB.planted && dist > 16;
      if (carrierFleeing) {
        const tgt = siteByName(BOMB.targetSite || 'A');
        const ex = tgt.x - bot.pos.x, ez = tgt.z - bot.pos.z;
        const ed = Math.hypot(ex, ez) || 1;
        moveDir = new THREE.Vector3(ex / ed, 0, ez / ed);
        // Still snap-shoot while fleeing if very close? No — run.
      } else {
        // strafe perpendicular, keep ideal range 8-18
        if (t > bot.strafeAt) { bot.strafeAt = t + rand(0.6, 1.5); bot.strafeDir *= -1; }
        const nx = dx / (dist || 1), nz = dz / (dist || 1);
        let mx = -nz * bot.strafeDir, mz = nx * bot.strafeDir;
        if (dist > 18) { mx += nx * 0.9; mz += nz * 0.9; }
        else if (dist < 7) { mx -= nx; mz -= nz; }
        moveDir = new THREE.Vector3(mx, 0, mz).normalize();
        speed *= 0.7;
        // shoot if roughly LOS + aimed
        if (dist < 50) {
          const eye = botEye(bot);
          if (hasLOS(eye, tp)) {
            const aimAt = tp.clone();
            botShoot(bot, t, aimAt);
          }
        }
      }
    }
  } else {
    const dx = bot.wp.x - bot.pos.x, dz = bot.wp.z - bot.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1.5) {
      moveDir = new THREE.Vector3(dx / dist, 0, dz / dist);
      bot.yaw = Math.atan2(dx, dz);
    } else {
      // Reached objective: CTs hold (scan), Ts push on.
      if (bot.team === 'ct' && !BOMB.planted) {
        bot.yaw += Math.sin(t * 0.9 + bot.idx) * dt * 0.6; // idle scan
      } else if (waypoints.length && Math.random() < 0.02) {
        bot.wp.copy(objectiveWaypoint(bot));
      }
    }
  }
  if (moveDir) {
    const step = moveDir.clone().multiplyScalar(speed * dt);
    const ox = bot.pos.x, oz = bot.pos.z;
    moveWithCollision(bot.pos, step.x, step.z, 0.42);
    if (Math.abs(bot.pos.x - ox) + Math.abs(bot.pos.z - oz) < 0.001) {
      // Stuck on a wall corner — pick a nearby free waypoint instead of purely random.
      bot.wp.copy(objectiveWaypoint(bot));
      if (Math.random() < 0.5 && waypoints.length) bot.wp.copy(randPick(waypoints));
    }
    bot.walkPhase += dt * 9;
    // audible boots: interval scales with speed, fully 3D (distance + occlusion)
    if (bot._stepAt === undefined) bot._stepAt = 0;
    if (t > bot._stepAt) {
      bot._stepAt = t + clamp(2.1 / (speed || 4), 0.32, 0.55) * rand(0.9, 1.1);
      try { AudioSys.step(new THREE.Vector3(bot.pos.x, 0.9, bot.pos.z), false); } catch (e) {}
    }
  }
  m.position.copy(bot.pos);
  // smooth yaw
  let dy = bot.yaw - m.rotation.y;
  while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
  m.rotation.y += dy * Math.min(1, dt * 8);
  // walk anim
  const sw = moveDir ? Math.sin(bot.walkPhase) * 0.5 : 0;
  m.userData.legL.rotation.x = sw; m.userData.legR.rotation.x = -sw;
  m.position.y = moveDir ? Math.abs(Math.sin(bot.walkPhase)) * 0.05 : 0;
  // hit-flinch: torso/head jerk that springs back (no gameplay effect)
  if (bot.flinchT > 0) {
    bot.flinchT = Math.max(0, bot.flinchT - dt);
    const f = bot.flinchT / 0.22;
    try {
      if (m.userData.torso) m.userData.torso.rotation.x = -0.28 * f;
      if (m.userData.head) { m.userData.head.rotation.x = (bot.flinchHead ? -0.5 : 0.3) * f; }
    } catch (e) {}
  } else {
    try {
      if (m.userData.torso) m.userData.torso.rotation.x *= 0.8;
      if (m.userData.head) m.userData.head.rotation.x *= 0.8;
    } catch (e) {}
  }
  updateBlob(bot, bot.pos.x, bot.pos.z, true, !!moveDir);
}

// Per-frame bomb tick: beeps, LED pulse, explosion, player defuse, HUD.
function updateBomb(dt, t) {
  if (G.phase !== 'playing') { updateInteractHUD(null); return; }
  // Planted: beeping accelerates + LED pulse + explosion on timer.
  if (BOMB.planted && BOMB.pos && !G.roundEnding) {
    const left = BOMB.explodeAt - t;
    if (left <= 0) { explodeBomb(t); updateInteractHUD(null); return; }
    // Beep interval shrinks as detonation nears (CS-like urgency).
    const interval = left > 20 ? 1.0 : left > 10 ? 0.55 : 0.28;
    if (t - BOMB.beepAt > interval) {
      BOMB.beepAt = t;
      AudioSys.beep(left < 10, BOMB.pos);
      if (BOMB.mesh && BOMB.mesh.userData.led) {
        BOMB.mesh.userData.led.material.emissiveIntensity = 4;
        setTimeout(() => { if (BOMB.mesh && BOMB.mesh.userData.led) BOMB.mesh.userData.led.material.emissiveIntensity = 1.2; }, 120);
      }
      if (BOMB.light) BOMB.light.intensity = left < 10 ? 3.2 : 1.8;
    }
    // --- Player defuse (CT only, hold E near bomb) ---
    let showDefuse = false;
    if (player.alive && !G.roundEnding && (player.team || 'ct') === 'ct') {
      const d = Math.hypot(player.pos.x - BOMB.pos.x, player.pos.z - BOMB.pos.z);
      if (d < 2.8) {
        if (keys['KeyE']) {
          // Only one defuser counts — if a CT bot is already defusing, player helps? CS: one at a time.
          // Let player take over (feels responsive) and pause bot progress confusion by sharing one bar.
          BOMB.defuser = 'player';
          BOMB.defuseProgress += dt;
          showDefuse = true;
          if (Math.floor(t * 2) !== Math.floor((t - dt) * 2)) AudioSys.defuseTick(BOMB.pos);
          updateInteractHUD('DEFUSING…', BOMB.defuseProgress / BOMB_DEFUSE_TIME, true);
          if (BOMB.defuseProgress >= BOMB_DEFUSE_TIME) {
            updateInteractHUD(null);
            defuseBomb(true, t);
            return;
          }
        } else {
          // In range but not holding E — prompt.
          updateInteractHUD('HOLD E TO DEFUSE', BOMB.defuseProgress / BOMB_DEFUSE_TIME, true);
          showDefuse = true;
          // If player released, keep progress? CS keeps kit progress partially — keep, don't reset.
          if (BOMB.defuser === 'player') BOMB.defuser = null;
        }
      } else {
        if (BOMB.defuser === 'player') { BOMB.defuser = null; }
      }
    }
    // --- Bot defuse progress bar (when a CT bot is defusing and player isn't) ---
    if (!showDefuse) {
      if (BOMB.defuser && BOMB.defuser !== 'player' && BOMB.defuser.alive) {
        const dd = BOMB.defuser.pos.distanceTo(BOMB.pos);
        if (dd < 3.2) updateInteractHUD(`${BOMB.defuser.short.toUpperCase()} DEFUSING…`, BOMB.defuseProgress / BOMB_DEFUSE_TIME, true);
        else updateInteractHUD(null);
      } else if (BOMB.plantingBot && BOMB.plantingBot.alive && !BOMB.planted) {
        // handled below
      } else {
        updateInteractHUD(null);
      }
    }
    // If defuser died / walked off, progress slowly decays (not instant reset).
    const defuserValid = (BOMB.defuser === 'player' && player.alive) ||
      (BOMB.defuser && BOMB.defuser !== 'player' && BOMB.defuser.alive && BOMB.defuser.pos.distanceTo(BOMB.pos) < 3.2);
    if (!defuserValid && BOMB.defuseProgress > 0 && !showDefuse) {
      // Only decay when nobody is actively defusing (checked via per-bot flags each frame is complex;
      // decay slowly so interrupts cost time but don't fully reset).
      const anyDefusing = bots.some((b) => b.alive && b.defusing);
      if (!anyDefusing) BOMB.defuseProgress = Math.max(0, BOMB.defuseProgress - dt * 0.6);
    }
    updateBombHUD(t);
    return;
  }
  // --- PvP: T-side player pickup + plant (hold E inside a site) ---
  if (isOnline() && !BOMB.planted && !G.roundEnding && player.alive && (player.team || 'ct') === 't') {
    // Pickup dropped bomb by walking over it.
    if (BOMB.droppedPos && !player.hasBomb) {
      if (player.pos.distanceTo(BOMB.droppedPos) < 1.8) {
        player.hasBomb = true; BOMB.droppedPos = null;
        bombClearMesh();
        announce('YOU PICKED UP THE BOMB — PLANT ON A OR B (HOLD E)', 1800);
        AudioSys.plantBeep();
        try { Net.sendBomb({ action: 'pickup' }); } catch {}
        updateBombHUD(t);
      }
    }
    // Plant inside either site while holding E and standing still-ish.
    if (player.hasBomb && !BOMB.planted) {
      let inSite = null;
      for (const s of SITES) { if (isInSite(player.pos, s)) { inSite = s; break; } }
      if (inSite) {
        // Enemies nearby interrupt (same rule as bots).
        let enemyClose = false;
        try {
          for (const r of Net.remoteList()) {
            if (!r.alive || (r.team || 't') === 't') continue;
            const dd = Math.hypot((r.x || 0) - player.pos.x, (r.z || 0) - player.pos.z);
            if (dd < 12) { enemyClose = true; break; }
          }
        } catch {}
        if (!enemyClose) {
          if (keys['KeyE']) {
            BOMB.plantProgress += dt;
            updateInteractHUD(`PLANTING ON ${inSite.name}…`, BOMB.plantProgress / BOMB_PLANT_TIME, false);
            if (Math.floor(t * 4) !== Math.floor((t - dt) * 4)) AudioSys.defuseTick(inSite.pos);
            if (BOMB.plantProgress >= BOMB_PLANT_TIME) {
              updateInteractHUD(null);
              plantBombByPlayer(inSite, t);
              return;
            }
            updateBombHUD(t);
            return;
          } else {
            updateInteractHUD(`HOLD E TO PLANT ON ${inSite.name}`, BOMB.plantProgress / BOMB_PLANT_TIME, false);
            BOMB.plantProgress = Math.max(0, BOMB.plantProgress - dt * 1.5);
            updateBombHUD(t);
            return;
          }
        }
      }
    }
  }
  // Not planted: show carrier plant progress if actively planting.
  if (BOMB.plantingBot && BOMB.plantingBot.alive && BOMB.plantProgress > 0.05) {
    updateInteractHUD(`BOMB PLANTING ON ${BOMB.targetSite} — STOP THEM!`, BOMB.plantProgress / BOMB_PLANT_TIME, false);
  } else {
    // Player near dropped bomb? Just informational (CT can't pick up).
    if (!(isOnline() && (player.team || 'ct') === 't' && player.hasBomb)) updateInteractHUD(null);
  }
  updateBombHUD(t);
}

// ---------------- Hitscan firing ----------------
const _dir = new THREE.Vector3();
function fireHitscan(shooter, origin, dir, wdef, t) {
  const maxD = wdef.range;
  const wallD = rayWallDist(origin, dir, maxD);
  let bestT = wallD, hitBot = null, hitPlayer = false, head = false;

  // Ray vs person approximation: head sphere + two body spheres.
  const checkPerson = (px, pz, feetY) => {
    // returns {d, head} or null — ray-sphere for head + body
    const o = origin, d = dir;
    // head sphere
    const hx = px, hy = feetY + 1.7, hz = pz;
    const hr = 0.30;
    let best = null;
    // ray-sphere
    const ox = o.x - hx, oy = o.y - hy, oz = o.z - hz;
    const b = ox * d.x + oy * d.y + oz * d.z;
    const c = ox * ox + oy * oy + oz * oz - hr * hr;
    const disc = b * b - c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      let tt = -b - sq;
      if (tt > 0.3 && tt < bestT && tt < maxD) best = { d: tt, head: true };
    }
    // body: approximate as sphere at chest r=0.55 + lower sphere r=0.5
    for (const [by, br] of [[feetY + 1.05, 0.62], [feetY + 0.45, 0.5]]) {
      const ox2 = o.x - px, oy2 = o.y - by, oz2 = o.z - pz;
      const b2 = ox2 * d.x + oy2 * d.y + oz2 * d.z;
      const c2 = ox2 * ox2 + oy2 * oy2 + oz2 * oz2 - br * br;
      const disc2 = b2 * b2 - c2;
      if (disc2 >= 0) {
        const tt = -b2 - Math.sqrt(disc2);
        if (tt > 0.3 && tt < bestT && tt < maxD && (!best || tt < best.d)) best = { d: tt, head: false };
      }
    }
    return best;
  };

  // Hit enemy bots (no friendly fire: skip same team and self).
  // In multiplayer (pure PvP) bots are cleared, so this loop is a no-op — kept for solo.
  for (const b of bots) {
    if (!b.alive) continue;
    if (b.team === shooter.team) continue;
    if (shooter.bot === b) continue;
    if (shooter.isPlayer) {
      // Solo: player (CT) only fights T. Online: team-based friendly fire off.
      const myTeam = player.team || 'ct';
      if (b.team === myTeam) continue;
    }
    const r = checkPerson(b.pos.x, b.pos.z, b.pos.y);
    if (r && r.d < bestT) { bestT = r.d; hitBot = b; head = r.head; hitPlayer = false; }
  }
  // Remote real players as hit targets (PvP, team-based, no friendly fire).
  let hitRemote = null;
  if (shooter.isPlayer) {
    try {
      const myTeam = player.team || 'ct';
      for (const [rid, e] of remotes) {
        const rd = e.data; if (!rd || !rd.alive) continue;
        if ((rd.team || 't') === myTeam) continue; // no friendly fire
        const r = checkPerson(e.pos.x, e.pos.z, e.pos.y);
        if (r && r.d < bestT) { bestT = r.d; hitRemote = { id: rid, entry: e }; hitBot = null; head = r.head; hitPlayer = false; }
      }
    } catch {}
  }
  // can bots hit player? + can player hit self? no. Can teammates hit player? no friendly fire.
  if (!shooter.isPlayer && shooter.team !== (player.team || 'ct') && player.alive) {
    // Bots only damage the local player when on opposite teams (solo CT vs T).
    // Remote shooters never reach here — they send 'hit' msgs applied victim-side.
    const r = checkPerson(player.pos.x, player.pos.z, player.pos.y);
    if (r && r.d < bestT) { bestT = r.d; hitPlayer = true; hitBot = null; hitRemote = null; head = r.head; }
  }
  // teammates (CT bots) can be hit by... nobody (no friendly fire) — skip.

  // Dropped C4 is shoot-to-detonate (planted C4 is bulletproof — bombDroppedHit
  // returns null when planted). Closest-hit wins: body/wall in front still blocks.
  const bombT = bombDroppedHit(origin, dir, bestT);
  if (bombT !== null) {
    const bombEnd = origin.clone().add(dir.clone().multiplyScalar(bombT));
    spawnTracer(origin.clone(), bombEnd.clone(), wdef.tracer);
    if (shooter.isPlayer) {
      muzzleLight.position.copy(origin).add(dir.clone().multiplyScalar(0.6));
      muzzleLight.intensity = wdef.sound === 'sniper' ? 5 : 3.2;
      muzzleLight.distance = wdef.sound === 'sniper' ? 20 : 14;
    }
    if (shooter.isPlayer) AudioSys.shoot(wdef.sound);
    else AudioSys.shoot(wdef.sound, origin);
    spawnBurst(bombEnd, 0xffd27a, 10, 6, 0.4, 0.1);
    const shooterName = shooter.isPlayer ? (player.name || 'YOU') : (shooter.bot ? shooter.bot.short : (shooter.remoteName || '???'));
    const shooterTeam = shooter.isPlayer ? (player.team || 'ct') : shooter.team;
    addKillfeed(shooterName, shooterTeam, 'DROPPED BOMB', 't', '💥 C4', false);
    explodeBomb(t, '💥 C4 SHOT — DETONATED');
    return { hit: true, d: bombT, bombDetonated: true };
  }

  const end = origin.clone().add(dir.clone().multiplyScalar(bestT));
  // effects
  spawnTracer(origin.clone(), end.clone(), wdef.tracer);
  if (shooter.isPlayer) {
    muzzleLight.position.copy(origin).add(dir.clone().multiplyScalar(0.6));
    muzzleLight.intensity = wdef.sound === 'sniper' ? 5 : 3.2;
    muzzleLight.distance = wdef.sound === 'sniper' ? 20 : 14;
  } else if (bestT < 60) {
    muzzleLight.position.copy(origin); muzzleLight.intensity = Math.max(muzzleLight.intensity, 1.5);
    spawnWorldFlash(origin, wdef.tracer || 0xffc36b, wdef.sound === 'sniper' ? 1.5 : 0.85);
  }
  if (shooter.isPlayer) AudioSys.shoot(wdef.sound);
  else AudioSys.shoot(wdef.sound, origin);
  // supersonic snap when an enemy round whizzes past the camera (near miss)
  if (!shooter.isPlayer && !hitBot && !hitPlayer && player.alive && camera) {
    try {
      const lp = camera.position;
      const ox = lp.x - origin.x, oy = lp.y - origin.y, oz = lp.z - origin.z;
      const along = ox * dir.x + oy * dir.y + oz * dir.z;
      if (along > 0 && along < 45) {
        const px = origin.x + dir.x * along - lp.x;
        const py = origin.y + dir.y * along - lp.y;
        const pz = origin.z + dir.z * along - lp.z;
        const miss = Math.sqrt(px * px + py * py + pz * pz);
        if (miss < 2.6 && Math.random() < 0.85) setTimeout(() => AudioSys.crack(), along / 343 * 1000);
      }
    } catch (e) {}
  }

  // damage falloff with distance (keeps AWP lethal far, rifles fade)
  const fall = wdef.falloff !== undefined ? wdef.falloff : 0.35;
  const fallK = 1 - fall * clamp(bestT / wdef.range, 0, 1);
  if (hitRemote) {
    // PvP: shooter predicts the hit locally for feedback, victim applies it.
    let dmg = wdef.damage * fallK * (head ? wdef.headMult : 1) * rand(0.9, 1.1);
    dmg = Math.round(dmg * 10) / 10;
    G.hits++; playerHitmark(head, false); AudioSys.hit(head);
    spawnBurst(end, 0xb00000, head ? 12 : 8, 4, 0.5);
    try {
      Net.sendHit({
        targetId: hitRemote.id, dmg, head,
        weapon: WEAPONS[player.cur] ? WEAPONS[player.cur].name : 'AK-47',
      });
    } catch {}
    // Optimistic local feedback; authoritative death arrives via 'killed' or snapshot.
    return { hit: true, d: bestT };
  } else if (hitBot) {
    let dmg = wdef.damage * fallK * (head ? wdef.headMult : 1) * rand(0.9, 1.1);
    damageBot(hitBot, dmg, shooter, head, end);
    return { hit: true, d: bestT };
  } else if (hitPlayer) {
    let dmg = wdef.damage * fallK * (head ? 2.0 : 1) * rand(0.85, 1.1);
    damagePlayer(dmg, shooter, head);
    spawnBurst(end, 0xaa0000, 6, 3, 0.4);
    return { hit: true, d: bestT };
  } else if (bestT < maxD - 0.01) {
    // wall impact: spark + dust + chip + smoke wisp + positional thwack/ring
    spawnBurst(end, 0xffd27a, 8, 5, 0.3, 0.07);
    spawnBurst(end, 0x9a8f7a, 5, 2.2, 0.55, 0.08);
    spawnSmoke(end, 0.22, 0.6);
    if (opts.quality) spawnDebris(end, 2, 3, 3);
    // persistent bullet hole facing back along the shot
    try { spawnDecal('hole', end, dir.clone().negate(), 0.22 + Math.random() * 0.14); } catch (e) {}
    // hot impact glint so far hits read at distance
    try {
      const T = decalTextures();
      const glint = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xffd9a0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      glint.position.copy(end); glint.scale.setScalar(0.4);
      scene.add(glint);
      worldFlashes.push({ mesh: glint, life: 0.08, max: 0.08 });
    } catch (e) {}
    AudioSys.impact(end, wdef.sound === 'sniper');
    return { hit: false, d: bestT };
  }
  return { hit: false, d: bestT };
}

function damageBot(bot, dmg, shooter, head, hitPos) {
  if (!bot.alive || G.phase !== 'playing') return;
  // armor-lite: bots have no armor
  bot.hp -= dmg;
  const _hp = hitPos || botChest(bot);
  spawnBurst(_hp, 0xb00000, head ? 12 : 8, 4, 0.5);
  spawnBurst(_hp, 0x7a0a0c, 6, 2.5, 0.7, 0.12); // dark arterial spray
  // directional mist + ground spatter so firefights stain the lane
  try {
    const d = shooter && shooter.isPlayer && camera
      ? new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
      : (shooter && shooter.bot ? shooter.bot.pos.clone().sub(bot.pos).setY(0).normalize() : new THREE.Vector3(1, 0, 0));
    const mist = _hp.clone().addScaledVector(d, 0.5); mist.y = Math.max(0.3, mist.y - 0.2);
    spawnSmoke(mist, 0.3, 0.7, 0x8a1518);
    if (Math.random() < 0.5) spawnDecal('blood', new THREE.Vector3(bot.pos.x, 0.06, bot.pos.z), new THREE.Vector3(0, 1, 0), 0.9 + Math.random() * 0.7, 0.55);
  } catch (e) {}
  // visible hit-flinch (springs back in updateBot via flinchT decay)
  bot.flinchT = 0.22; bot.flinchHead = !!head;
  const killerIsPlayer = shooter.isPlayer;
  if (killerIsPlayer) {
    G.hits++; playerHitmark(head, false);
    AudioSys.hit(head);
  }
  // Being shot interrupts planting/defusing.
  if (bot.planting) { bot.planting = false; if (BOMB.plantingBot === bot) BOMB.plantingBot = null; }
  if (bot.defusing) { bot.defusing = false; if (BOMB.defuser === bot) BOMB.defuser = null; }
  if (bot.hp <= 0) {
    bot.alive = false; bot.hp = 0;
    bot.planting = false; bot.defusing = false;
    // Make sure a first-person spectate target is visible again for its death anim.
    bot.mesh.visible = true;
    if (BOMB.plantingBot === bot) BOMB.plantingBot = null;
    if (BOMB.defuser === bot) BOMB.defuser = null;
    // Bomb carrier drops the C4 where they died (CTs can't pick it up, Ts recover it).
    if (bot.hasBomb && !BOMB.planted) {
      bot.hasBomb = false;
      const tNow = performance.now() / 1000;
      bombDropAt(bot.pos);
      // Reassign remaining Ts to recover it.
      for (const o of bots) if (o.alive && o.team === 't') o.wp.copy(objectiveWaypoint(o));
    }
    // death: crumple + persistent corpse with blood pool (CS elimination — cleared next round)
    bot.deathT = 0; bot._thudded = false;
    bot.mesh.rotation.x = 0;
    bot.mesh.position.y = 0;
    try {
      spawnBloodPool(bot.pos.x, bot.pos.z, true);
      spawnBurst(botChest(bot), 0x8a0f12, 14, 3.5, 0.8, 0.12);
    } catch (e) {}
    const killerTeam = shooter.isPlayer ? (player.team || 'ct') : shooter.team;
    G.roundKills[killerTeam]++;
    const kn = killerIsPlayer ? (player.name || 'YOU') : (shooter.bot ? shooter.bot.short : '???');
    const kt = killerTeam;
    addKillfeed(kn, kt, bot.short, bot.team, currentWeaponName(shooter), head);
    if (killerIsPlayer) {
      G.kills++; player.kills++; addMoney(MONEY_KILL); playerHitmark(head, true);
      AudioSys.kill();
      if (head && !G.roundEnding) { G.headshots++; announce('HEADSHOT +$' + MONEY_KILL, 700); }
    }
    if (shooter.bot && shooter.team === 't') { /* enemy got a kill */ }
    updateHUD(); checkRoundEnd();
  } else {
    // Wounding the planter buys time — knock a chunk off plant progress.
    if (bot.hasBomb && BOMB.plantProgress > 0) BOMB.plantProgress = Math.max(0, BOMB.plantProgress - 0.5);
  }
}

function damagePlayer(dmg, shooter, head) {
  if (!player.alive || G.phase !== 'playing') return;
  // CS-like armor: helmet halves headshot bonus, vest absorbs body damage
  if (head && player.armor > 0) dmg *= 0.6;
  if (player.armor > 0) {
    const absorbed = dmg * 0.5;
    const useArmor = Math.min(player.armor, absorbed);
    player.armor -= useArmor;
    dmg -= useArmor * 0.8;
  }
  player.hp -= dmg;
  AudioSys.hurt();
  try {
    if (shooter && shooter.remotePos) flashDamageRemote(shooter.remotePos);
    else flashDamage(shooter);
  } catch { flashDamage(shooter); }
  updateHUD();
  if (player.hp <= 0) {
    player.hp = 0; player.alive = false; player.deaths++;
    player.aiming = false;
    if (BOMB.defuser === 'player') BOMB.defuser = null;
    // PvP T death drops the bomb where we died so teammates can recover it.
    try {
      if (isOnline() && player.hasBomb && !BOMB.planted) {
        player.hasBomb = false;
        bombDropAt(player.pos, false);
      }
    } catch {}
    const kn = shooter.bot ? shooter.bot.short : (shooter.remoteName || shooter.remote?.data?.name || 'Enemy');
    $('respawn-killer').textContent = kn + (head ? ' (HEADSHOT)' : '');
    $('respawn-timer').textContent = BOMB.planted
      ? 'BOMB IS PLANTED — your team must still defuse it…'
      : 'Waiting for next round… (no respawns — CS elimination)';
    $('respawn-overlay').classList.remove('hidden');
    // Spectate a living teammate immediately — keep pointer lock so the
    // mouse keeps working for look / click-to-cycle.
    if (G.buyOpen) toggleBuy(false); // dead players get no buy menu
    player.specTarget = null;
    spectateCurrent();
    updateSpectateOverlay();
    if (viewmodel) viewmodel.visible = false;
    const killerTeam = shooter.team || 't';
    const victimTeam = player.team || 'ct';
    G.roundKills[killerTeam]++;
    addKillfeed(kn, killerTeam, player.name || 'YOU', victimTeam, currentWeaponName(shooter), head);
    // Broadcast victim-authoritative kill so remotes get killfeed + round check.
    try {
      if (isOnline() && (shooter.remote || shooter.remoteName)) {
        Net.sendKilled({
          killerId: shooter.remote?.data?.id ?? null, killerName: kn, killerTeam,
          victimId: Net.id, victimName: player.name || 'YOU', victimTeam,
          weapon: currentWeaponName(shooter), head: !!head,
        });
      }
    } catch {}
    updateHUD(); checkRoundEnd();
  }
}
function currentWeaponName(shooter) {
  if (shooter.isPlayer) return WEAPONS[player.cur].name;
  if (shooter && shooter.weaponName) return shooter.weaponName;
  if (shooter && shooter.remote && shooter.remote.data && shooter.remote.data.weapon && WEAPONS[shooter.remote.data.weapon]) return WEAPONS[shooter.remote.data.weapon].name;
  return G.round <= 1 ? 'Desert Eagle' : 'AK-47'; // pistol round flavor
}

function playerNearPlantedBomb(range = 2.8) {
  if (!BOMB.planted || !BOMB.pos) return false;
  return Math.hypot(player.pos.x - BOMB.pos.x, player.pos.z - BOMB.pos.z) < range;
}
function playerInPlantSite() {
  if (!player.alive || BOMB.planted || (player.team || 'ct') !== 't' || !player.hasBomb) return null;
  for (const s of SITES) { if (isInSite(player.pos, s)) return s; }
  return null;
}

// ---------------- Player shooting (CS-style recoil + bloom) ----------------
function playerTryFire(t) {
  const wkey = player.cur, w = player.weapons[wkey], def = WEAPONS[wkey];
  if (!player.alive || player.reloading > 0 || t < player.nextShot) return;
  if (isFreeze() || G.roundEnding) return; // CS freeze: no shooting
  if (keys['KeyE'] && playerNearPlantedBomb()) return; // hands busy defusing
  if (keys['KeyE'] && playerInPlantSite()) return; // hands busy planting (PvP T)
  if (w.mag <= 0) { AudioSys.click(300, 0.06, 0.3); player.nextShot = t + 0.3; startReload(); return; }
  if (!def.auto && !mouseJustDown) return;
  // spray reset after pause (tap = accurate again)
  if (t - player.lastShotT > 0.5) { player.sprayIdx = 0; }
  player.nextShot = t + def.fireInterval;
  player.lastShotT = t;
  w.mag--; G.shots++;
  // --- spread: base + heat bloom + movement + air ---
  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  const moveF = 1 + clamp(hSpeed / 5, 0, 1) * (wkey === 'awp' ? 2.2 : 1.1);
  const airF = player.onGround ? 1 : (wkey === 'awp' ? 5 : 2.2);
  const aimK = vmRig.aimK || 0;
  const spreadBase = def.spreadHip + (def.spreadAim - def.spreadHip) * aimK;
  const bloomNow = player.bloom;
  const spread = (spreadBase + bloomNow) * moveF * airF;
  // punch + shake are applied to the camera, so shoot from the *punched* view
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  dir.x += rand(-spread, spread); dir.y += rand(-spread, spread); dir.z += rand(-spread, spread);
  dir.normalize();
  crossGap = clamp(6 + spread * 950 + bloomNow * 550, 6, 46);
  const origin = new THREE.Vector3(player.pos.x, player.pos.y + EYE, player.pos.z).add(dir.clone().multiplyScalar(0.4));
  const muzzleWorld = new THREE.Vector3();
  if (vmMuzzle) vmMuzzle.getWorldPosition(muzzleWorld);
  else muzzleWorld.copy(origin);
  spawnTracer(muzzleWorld, origin.clone().add(dir.clone().multiplyScalar(2.2)), def.tracer);
  fireHitscan({ team: player.team || 'ct', isPlayer: true }, origin, dir, def, t);
  // Relay tracer to remotes so they see/hear our shot.
  try {
    if (isOnline()) Net.sendShot({
      ox: origin.x, oy: origin.y, oz: origin.z,
      dx: dir.x, dy: dir.y, dz: dir.z,
      weapon: def.name, tracer: def.tracer, sound: def.sound,
    });
  } catch {}
  // --- heat up ---
  player.bloom = Math.min(def.bloomMax, player.bloom + def.bloomAdd * (player.aiming ? 0.55 : 1) * moveF);
  // --- true recoil (permanent climb — pull down to compensate) ---
  let patX = 0, patY = 1;
  if (wkey === 'ak') {
    const p = SPRAY_AK[Math.min(player.sprayIdx, SPRAY_AK.length - 1)];
    patX = p[0]; patY = p[1];
  } else if (wkey === 'deagle') { patX = rand(-0.5, 0.5); patY = 1; }
  else { patX = rand(-0.4, 0.4); patY = 1; }
  const aimMul = player.aiming ? (wkey === 'awp' ? 0.85 : 0.62) : 1;
  // first bullet is the accurate one
  const firstMul = player.sprayIdx === 0 ? 0.85 : 1;
  player.pitch += def.kickUp * patY * aimMul * firstMul;
  player.yaw += (rand(-def.kickSide, def.kickSide) + patX * def.kickSide * 0.9) * aimMul;
  player.pitch = clamp(player.pitch, -1.45, 1.45);
  player.sprayIdx++;
  // --- recoverable punch / shake / fov (game feel, springs back) ---
  vmRig.punchP += def.punch * (player.aiming ? 0.6 : 1);
  vmRig.punchY += rand(-def.punch, def.punch) * 0.4;
  vmRig.shake += def.shake;
  vmRig.fovKick += def.fovPunch * (player.aiming ? 0.4 : 1);
  // --- viewmodel spring kick + flash + shell + smoke ---
  vmRig.kickV += def.vmKick * 15 * (player.aiming ? 0.65 : 1);
  vmRig.kickRotV += def.punch * 9;
  if (vmFlashGroup) {
    for (const f of vmFlashGroup.children) {
      f.material.opacity = 1;
      f.rotation.z = Math.random() * Math.PI * 2;
      const s = (wkey === 'awp' ? 1.9 : wkey === 'deagle' ? 1.35 : 1.0) * rand(0.9, 1.15);
      f.scale.set(s, s, 1);
    }
  }
  if (vmMuzzle) {
    const mp = new THREE.Vector3(); vmMuzzle.getWorldPosition(mp);
    if (wkey !== 'awp' || !player.aiming) spawnSmoke(mp, wkey === 'awp' ? 0.3 : 0.18, 0.55);
    // eject brass to the right
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const ejectP = mp.addScaledVector(right, -0.06).addScaledVector(up, -0.03);
    spawnShell(ejectP, right, up, fwd);
  }
  if (wkey === 'awp') {
    vmRig.boltT = 0.45;
    setTimeout(() => AudioSys.mech(), 320);
  }
  mouseJustDown = false;
  if (w.mag === 0) setTimeout(() => startReload(), 260);
  updateHUD();
}
function startReload() {
  const wkey = player.cur, w = player.weapons[wkey], def = WEAPONS[wkey];
  if (player.reloading > 0 || w.mag >= def.magSize || w.reserve <= 0 || !player.alive) return;
  player.reloading = def.reloadTime; player.reloadDur = def.reloadTime;
  player.sprayIdx = 0;
  AudioSys.reload();
  $('reload-tip').classList.remove('hidden');
}
function finishReload() {
  const wkey = player.cur, w = player.weapons[wkey], def = WEAPONS[wkey];
  const need = def.magSize - w.mag, take = Math.min(need, w.reserve);
  w.mag += take; w.reserve -= take;
  player.reloading = 0;
  player.bloom = 0;
  $('reload-tip').classList.add('hidden');
  updateHUD();
}
function switchWeapon(key) {
  if (!player.alive) return;
  if (!player.weapons[key].owned || player.cur === key) return;
  player.last = player.cur; player.cur = key;
  player.reloading = 0; $('reload-tip').classList.add('hidden');
  player.bloom = 0; player.sprayIdx = 0;
  buildViewmodel(key);
  AudioSys.click(1200, 0.05, 0.3);
  setTimeout(() => AudioSys.click(900, 0.05, 0.25), 120);
  updateHUD();
}

// ---------------- Input ----------------
let mouseDown = false, mouseJustDown = false, crossGap = 8;
function initInput() {
  addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
    if (G.phase !== 'playing') return;
    if (e.code === 'KeyM') { AudioSys.muted = !AudioSys.muted; announce(AudioSys.muted ? 'SOUND OFF' : 'SOUND ON', 800); return; }
    if (!player.alive) {
      // Spectating: cycle targets / toggle camera. (Weapon/buy keys stay blocked.)
      if (e.code === 'KeyB' || e.code === 'Escape') { if (G.buyOpen) toggleBuy(false); return; }
      if (e.repeat) return;
      if (e.code === 'Space' || e.code === 'ArrowRight' || e.code === 'ArrowDown' || e.code === 'KeyN') spectateNext();
      if (e.code === 'KeyF' || e.code === 'KeyV' || e.code === 'ArrowUp') spectateToggleMode();
      return;
    }
    if (e.code === 'Digit1') switchWeapon('ak');
    if (e.code === 'Digit2') switchWeapon('deagle');
    if (e.code === 'Digit3') { if (player.weapons.awp.owned) switchWeapon('awp'); else announce('AWP NOT OWNED — PRESS B', 1200); }
    if (e.repeat) return;
    if (e.code === 'KeyQ') switchWeapon(player.last && player.weapons[player.last].owned ? player.last : player.cur);
    if (e.code === 'KeyR') startReload();
    if (e.code === 'KeyB') toggleBuy();
    if (e.code === 'Escape' && G.buyOpen) toggleBuy(false);
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  document.addEventListener('mousedown', (e) => {
    if (G.phase !== 'playing' || !pointerLocked) return;
    if (!player.alive) {
      // Spectating: LMB next player, RMB toggle first/chase.
      if (e.button === 0) spectateNext();
      if (e.button === 2) spectateToggleMode();
      return;
    }
    if (e.button === 0) { mouseDown = true; mouseJustDown = true; }
    if (e.button === 2) player.aiming = true;
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouseDown = false;
    if (e.button === 2) player.aiming = false;
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('mousemove', (e) => {
    if (!pointerLocked || G.phase !== 'playing') return;
    if (!player.alive) {
      // Spectate look (orbit in chase cam, free look in first-person).
      const sens = 0.0022;
      player.yaw -= e.movementX * sens;
      player.pitch -= e.movementY * sens;
      player.pitch = clamp(player.pitch, -1.45, 1.45);
      return;
    }
    const sens = 0.0022 * (player.aiming ? (player.cur === 'awp' ? 0.35 : 0.7) : 1);
    player.yaw -= e.movementX * sens;
    player.pitch -= e.movementY * sens;
    player.pitch = clamp(player.pitch, -1.45, 1.45);
    // weapon sway inertia from look velocity
    vmRig.swayX = clamp(vmRig.swayX - e.movementX * 0.00035, -0.05, 0.05);
    vmRig.swayY = clamp(vmRig.swayY + e.movementY * 0.00035, -0.05, 0.05);
  });
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === renderer.domElement;
    if (!pointerLocked && G.phase === 'playing' && player.alive && !G.buyOpen) pauseGame();
  });
  document.querySelectorAll('.buy-item').forEach((b) => b.addEventListener('click', () => buyItem(b.dataset.buy)));
}

// ---------------- Buy menu ----------------
function buyTimeLeft() { return Math.max(0, G.buyLeft); }
function toggleBuy(force) {
  const want = force !== undefined ? force : !G.buyOpen;
  if (want) {
    if (G.phase !== 'playing' || G.roundEnding) return;
    if (!player.alive) { announce('CAN\'T BUY WHILE DEAD', 1000); AudioSys.click(300, 0.1, 0.3); return; }
    if (!isBuyTime()) { announce('BUY TIME OVER (' + BUY_TIME + 'S)', 1000); AudioSys.click(300, 0.1, 0.3); return; }
  }
  G.buyOpen = want;
  $('buy-menu').classList.toggle('hidden', !want);
  $('buy-money').textContent = '$' + player.money;
  updateBuyTimer();
  if (want) { document.exitPointerLock && document.exitPointerLock(); }
  else if (G.phase === 'playing' && player.alive) lockPointer();
}
function updateBuyTimer() {
  const el = $('buy-timer');
  if (el) {
    if (isBuyTime()) { el.textContent = 'BUY TIME ' + buyTimeLeft().toFixed(1) + 's — frozen ' + Math.max(0, G.freezeLeft).toFixed(1) + 's'; el.style.color = '#7dff9a'; }
    else { el.textContent = 'BUY CLOSED'; el.style.color = '#ff6b6b'; }
  }
}
function buyItem(kind) {
  if (!isBuyTime()) { announce('BUY TIME OVER (' + BUY_TIME + 'S)', 1100); AudioSys.click(250, 0.12, 0.35); return; }
  if (!player.alive) { announce('CAN\'T BUY WHILE DEAD', 1100); AudioSys.click(250, 0.12, 0.35); return; }
  if (G.roundEnding) return;
  const w = player.weapons;
  const ok = (msg) => { announce(msg, 1100); $('buy-money').textContent = '$' + player.money; updateHUD(); AudioSys.click(1500, 0.07, 0.35); };
  const no = (msg) => { announce(msg, 1100); AudioSys.click(250, 0.12, 0.35); };
  if (kind === 'ak') {
    if (w.ak.owned) return no('AK-47 ALREADY OWNED');
    if (player.money < 2500) return no('NOT ENOUGH $');
    player.money -= 2500; w.ak.owned = true; w.ak.mag = 30; w.ak.reserve = 90; switchWeapon('ak'); return ok('AK-47 PURCHASED');
  }
  if (kind === 'awp') {
    if (w.awp.owned) return no('AWP ALREADY OWNED');
    if (player.money < 4750) return no('NOT ENOUGH $');
    player.money -= 4750; w.awp.owned = true; w.awp.mag = 5; w.awp.reserve = 20; switchWeapon('awp'); return ok('AWP PURCHASED');
  }
  if (kind === 'deagle') {
    if (w.deagle.owned) { // refill
      if (player.money < 200) return no('NOT ENOUGH $');
      player.money -= 200; w.deagle.reserve = 35; return ok('DEAGLE AMMO REFILLED');
    }
    if (player.money < 700) return no('NOT ENOUGH $');
    player.money -= 700; w.deagle.owned = true; w.deagle.mag = 7; w.deagle.reserve = 35; return ok('DESERT EAGLE PURCHASED');
  }
  if (kind === 'ammo') {
    if (player.money < 200) return no('NOT ENOUGH $');
    player.money -= 200;
    for (const k of SLOT_ORDER) if (w[k].owned) w[k].reserve = WEAPONS[k].startReserve;
    return ok('AMMO REFILLED');
  }
  if (kind === 'armor') {
    if (player.money < 1000) return no('NOT ENOUGH $');
    player.money -= 1000; player.armor = 100; return ok('ARMOR EQUIPPED');
  }
  if (kind === 'hp') {
    if (player.money < 500) return no('NOT ENOUGH $');
    if (player.hp >= 100) return no('HP ALREADY FULL');
    player.money -= 500; player.hp = Math.min(100, player.hp + 50);
    $('heal-flash').style.opacity = 1; setTimeout(() => $('heal-flash').style.opacity = 0, 400);
    return ok('+50 HP');
  }
}

// ---------------- HUD / UI ----------------
function playerHitmark(head, kill) {
  const h = $('hitmarker');
  h.classList.remove('show', 'kill'); void h.offsetWidth;
  h.classList.add('show'); if (kill) h.classList.add('kill');
}
function flashDamage(shooter) {
  const v = $('damage-vignette');
  v.style.opacity = 0.9; setTimeout(() => v.style.opacity = 0, 180);
  // direction arrow
  if (shooter && shooter.bot) {
    const dx = shooter.bot.pos.x - player.pos.x, dz = shooter.bot.pos.z - player.pos.z;
    const worldAng = Math.atan2(dx, dz);
    const facing = player.yaw + Math.PI; // player forward in atan2(dx,dz) convention
    const rel = worldAng - facing;
    const el = document.createElement('div');
    el.className = 'dmg-arrow';
    el.style.transform = `rotate(${-rel}rad)`;
    const di = $('direction-indicator');
    di.innerHTML = ''; di.appendChild(el); di.style.opacity = 1;
    setTimeout(() => di.style.opacity = 0, 600);
  }
}
let _boomFlashV = 0;
function flashExplosionOverlay() {
  _boomFlashV = 1;
  try { const el = $('boomflash'); if (el) el.style.opacity = 1; } catch (e) {}
}
// per-frame screen feel: sun glare when facing the sun, low-hp heartbeat, boom decay
const _sunDirV = new THREE.Vector3(34, 42, 20).normalize();
function updateScreenFeel(dt, t) {
  try {
    if (G.phase === 'playing' && player.alive && camera) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const sunK = Math.max(0, fwd.dot(_sunDirV));
      const glare = Math.pow(sunK, 18) * 0.85 + Math.pow(sunK, 90) * 0.9;
      const el = $('glare');
      if (el) el.style.opacity = clamp(glare, 0, 0.9).toFixed(3);
    } else {
      const el = $('glare');
      if (el && el.style.opacity !== '0') el.style.opacity = 0;
    }
  } catch (e) {}
  try {
    const el = $('lowhp');
    if (el) {
      if (G.phase === 'playing' && player.alive && player.hp <= 45) {
        el.style.opacity = (0.35 + 0.4 * (1 - player.hp / 45) + Math.sin(t * 5) * 0.12).toFixed(3);
      } else if (el.style.opacity !== '0') el.style.opacity = 0;
    }
  } catch (e) {}
  try {
    if (_boomFlashV > 0) {
      _boomFlashV = Math.max(0, _boomFlashV - dt * 1.8);
      const el = $('boomflash');
      if (el) el.style.opacity = _boomFlashV.toFixed(3);
    }
  } catch (e) {}
}
let announceTimer = null;
function announce(msg, ms = 1200) {
  const a = $('announce');
  a.textContent = msg; a.classList.remove('hidden');
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => a.classList.add('hidden'), ms);
}
function addKillfeed(killer, kTeam, victim, vTeam, wpn, head) {
  const kf = $('killfeed');
  const div = document.createElement('div');
  div.className = 'feed-item' + (head ? ' headshot' : '');
  div.innerHTML = `<span class="killer ${kTeam}">${killer}</span><span class="wpn">[${wpn}${head ? ' 💀' : ''}]</span><span class="victim ${vTeam}">${victim}</span>`;
  kf.prepend(div);
  while (kf.children.length > 5) kf.lastChild.remove();
  setTimeout(() => div.remove(), 6000);
}
function fmtTime(s) { s = Math.max(0, Math.ceil(s)); return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`; }
function updateHUD() {
  $('hp-num').textContent = Math.ceil(player.hp);
  $('hp-fill').style.width = clamp(player.hp, 0, 100) + '%';
  $('armor-num').textContent = Math.ceil(player.armor);
  $('armor-fill').style.width = clamp(player.armor, 0, 100) + '%';
  $('money').textContent = '$' + player.money;
  const w = player.weapons[player.cur];
  $('ammo-mag').textContent = w.mag; $('ammo-reserve').textContent = w.reserve;
  $('weapon-name').textContent = WEAPONS[player.cur].name.toUpperCase();
  document.querySelectorAll('.wslot').forEach((el) => {
    const k = SLOT_ORDER[+el.dataset.slot];
    el.classList.toggle('active', k === player.cur);
    el.classList.toggle('locked', !player.weapons[k].owned);
  });
  $('ct-score').textContent = G.score.ct; $('t-score').textContent = G.score.t;
  if (BOMB.planted && BOMB.pos && !G.roundEnding) {
    const tNow = performance.now() / 1000;
    const left = Math.max(0, BOMB.explodeAt - tNow);
    $('timer').textContent = '💣 ' + left.toFixed(1);
    $('timer').classList.toggle('low', true);
  } else {
    $('timer').textContent = isFreeze() ? ('❄ ' + G.freezeLeft.toFixed(1)) : fmtTime(G.timeLeft);
    $('timer').classList.toggle('low', !isFreeze() && G.timeLeft < 20);
  }
  let ctAlive = (player.alive && (player.team || 'ct') === 'ct' ? 1 : 0) + bots.filter((b) => b.alive && b.team === 'ct').length;
  let tAlive = (player.alive && player.team === 't' ? 1 : 0) + bots.filter((b) => b.alive && b.team === 't').length;
  try {
    if (isOnline()) {
      for (const r of Net.remoteList()) {
        if (!r.alive) continue;
        if ((r.team || 't') === 'ct') ctAlive++; else tAlive++;
      }
    }
  } catch {}
  let phase = '';
  if (isFreeze()) phase = ` · ❄ FREEZE ${G.freezeLeft.toFixed(1)}`;
  else if (isBuyTime()) phase = ` · BUY ${G.buyLeft.toFixed(1)}s`;
  $('round-label').textContent = `ROUND ${G.round} / ${ROUNDS_TO_WIN_MATCH * 2 - 1} · CT ${ctAlive} — ${tAlive} T${phase}`;
  $('crosshair').style.setProperty('--gap', crossGap.toFixed(1) + 'px');
}

// minimap
const mm = { last: 0 };
function drawMinimap(t) {
  if (t - mm.last < 0.12) return; mm.last = t;
  const c = $('minimap'), g = c.getContext('2d');
  const S = c.width, world = MAP_HALF * 2 + 8;
  const px = (x) => (x + world / 2) / world * S;
  const pz = (z) => (z + world / 2) / world * S;
  g.clearRect(0, 0, S, S);
  g.fillStyle = 'rgba(20,28,40,0.9)'; g.fillRect(0, 0, S, S);
  // walls (project colliders as rects, top-down using min/max x/z)
  g.fillStyle = 'rgba(200,180,130,0.85)';
  for (const b of colliders) {
    const w = (b.max.x - b.min.x) / world * S, h = (b.max.z - b.min.z) / world * S;
    if (w < 1 || h < 1 || b.max.y < 1.5) continue;
    g.fillRect(px(b.min.x), pz(b.min.z), Math.max(1.5, w), Math.max(1.5, h));
  }
  // sites (A north, B south) + target highlight
  for (const s of SITES) {
    const isTarget = !BOMB.planted && BOMB.targetSite === s.name;
    g.fillStyle = s.name === 'A' ? '#2e9bff' : '#ffb020';
    g.beginPath(); g.arc(px(s.x), pz(s.z), isTarget ? 5.5 : 4, 0, 7); g.fill();
    if (isTarget) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(px(s.x), pz(s.z), 6.5, 0, 7); g.stroke(); }
    g.fillStyle = '#0a0e14'; g.font = 'bold 7px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(s.name, px(s.x), pz(s.z));
  }
  // bomb: planted (blinking red) / dropped (orange) / carrier (ring the carrier)
  const tNow2 = performance.now() / 1000;
  if (BOMB.planted && BOMB.pos) {
    if (Math.floor(tNow2 * 3) % 2 === 0) g.fillStyle = '#ff2222'; else g.fillStyle = '#ff8888';
    g.beginPath(); g.arc(px(BOMB.pos.x), pz(BOMB.pos.z), 5, 0, 7); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.arc(px(BOMB.pos.x), pz(BOMB.pos.z), 7, 0, 7); g.stroke();
  } else if (BOMB.droppedPos) {
    g.fillStyle = '#ff9a2a';
    g.beginPath(); g.arc(px(BOMB.droppedPos.x), pz(BOMB.droppedPos.z), 4.5, 0, 7); g.fill();
  }
  // bots (bomb carrier gets a white ring, spectate target gets a green ring)
  for (const b of bots) {
    if (!b.alive) continue;
    if (!b.mesh.visible && isMultiplayer()) continue; // hidden PvP bots
    g.fillStyle = b.team === 'ct' ? '#5eb2ff' : '#ff7043';
    g.beginPath(); g.arc(px(b.pos.x), pz(b.pos.z), 3, 0, 7); g.fill();
    if (b.hasBomb) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(px(b.pos.x), pz(b.pos.z), 5, 0, 7); g.stroke(); }
    if (!player.alive && player.specTarget === b) { g.strokeStyle = '#3dff7a'; g.lineWidth = 2; g.beginPath(); g.arc(px(b.pos.x), pz(b.pos.z), 6, 0, 7); g.stroke(); }
  }
  // real remote players: white ring = enemy, green ring = spectate target
  try {
    if (isOnline()) {
      for (const [rid, e] of remotes) {
        const rd = e.data; if (!rd || !rd.alive) continue;
        g.fillStyle = (rd.team || 't') === 'ct' ? '#5eb2ff' : '#ff7043';
        g.beginPath(); g.arc(px(e.pos.x), pz(e.pos.z), 3.4, 0, 7); g.fill();
        g.strokeStyle = (rd.team !== (player.team || 'ct')) ? '#ffffff' : 'rgba(255,255,255,0.4)';
        g.lineWidth = 1;
        g.beginPath(); g.arc(px(e.pos.x), pz(e.pos.z), 5, 0, 7); g.stroke();
        if (!player.alive && player.specTarget && player.specTarget.__remoteId === rid) {
          g.strokeStyle = '#3dff7a'; g.lineWidth = 2;
          g.beginPath(); g.arc(px(e.pos.x), pz(e.pos.z), 6.5, 0, 7); g.stroke();
        }
      }
    }
  } catch {}
  // player arrow (greyed out while spectating)
  const x = px(player.pos.x), y = pz(player.pos.z);
  g.save(); g.translate(x, y); g.rotate(-player.yaw + Math.PI);
  g.fillStyle = player.alive ? '#3dff7a' : 'rgba(140,140,140,0.65)';
  g.beginPath(); g.moveTo(0, -6); g.lineTo(4.5, 5); g.lineTo(-4.5, 5); g.closePath(); g.fill();
  g.restore();
}

// ---------------- Round flow ----------------
function aliveCounts() {
  const myTeam = player.team || 'ct';
  let ct = ((player.alive && myTeam === 'ct') ? 1 : 0) + bots.filter((b) => b.alive && b.team === 'ct').length;
  let t = ((player.alive && myTeam === 't') ? 1 : 0) + bots.filter((b) => b.alive && b.team === 't').length;
  try {
    if (isOnline()) {
      for (const r of Net.remoteList()) {
        if (!r.alive) continue;
        if ((r.team || 't') === 'ct') ct++; else t++;
      }
    }
  } catch {}
  return { ct, t };
}
function isRoundHost() {
  // Lowest net id hosts round flow + bomb timer to keep clients in sync.
  try {
    if (!isOnline() || Net.id == null) return true;
    for (const r of Net.remoteList()) if (r.id < Net.id) return false;
    return true;
  } catch { return true; }
}

// ---------------- Spectate after death ----------------
// CS-style: dead players follow a living teammate. Teammates first,
// falling back to any living bot/remote so a planted-bomb finish stays watchable.
// Online PvP: teammates (same team) first, then any living remote.
function remoteSpectateProxies(myTeam) {
  const out = [];
  try {
    for (const [rid, e] of remotes) {
      if (!e.data || !e.data.alive) continue;
      out.push({
        __remoteId: rid, __isRemote: true,
        get pos() { return e.pos; },
        get yaw() { return e.yaw; },
        get alive() { return !!(e.data && e.data.alive); },
        team: e.data.team || 't',
        short: e.data.name || ('Player' + rid),
      });
    }
  } catch {}
  // Teammates first for familiar behavior.
  out.sort((a, b) => ((b.team === myTeam) - (a.team === myTeam)));
  return out;
}
function spectateTargets() {
  const myTeam = player.team || 'ct';
  const mates = bots.filter((b) => b.alive && b.team === myTeam);
  const matesR = remoteSpectateProxies(myTeam).filter((r) => r.team === myTeam);
  if (mates.length || matesR.length) return [...matesR, ...mates];
  const anyB = bots.filter((b) => b.alive);
  const anyR = remoteSpectateProxies(myTeam);
  return [...anyR, ...anyB];
}
function spectateCurrent() {
  if (player.alive) return null;
  const list = spectateTargets();
  if (!list.length) { player.specTarget = null; return null; }
  if (player.specTarget && player.specTarget.alive) {
    // Bots are stable refs; remote proxies are re-created — match by __remoteId.
    if (list.includes(player.specTarget)) return player.specTarget;
    if (player.specTarget.__remoteId != null) {
      const same = list.find((x) => x.__remoteId === player.specTarget.__remoteId);
      if (same) { player.specTarget = same; return same; }
    }
  }
  player.specTarget = list[0];
  // Face the same way as the new target so the view doesn't snap wildly.
  // Bots use mesh yaw (offset by PI from player yaw); remotes already use player yaw.
  player.yaw = player.specTarget.__isRemote ? player.specTarget.yaw : player.specTarget.yaw + Math.PI;
  player.pitch = 0;
  return player.specTarget;
}
function applySpectateVisibility() {
  const cur = player.alive ? null : player.specTarget;
  for (const b of bots) {
    if (!b.alive) continue; // death anim owns dead-bot visibility
    b.mesh.visible = !(cur && player.specMode === 'first' && b === cur);
  }
  // Hide the spectated remote's own mesh in first-person (we're inside their head).
  try {
    for (const [rid, e] of remotes) {
      if (!e.data || !e.data.alive) continue;
      if (cur && cur.__remoteId === rid && player.specMode === 'first') e.mesh.visible = false;
      else if (e.data.alive) e.mesh.visible = true;
    }
  } catch {}
}
function updateSpectateOverlay() {
  const el = $('spectate-text'), hint = $('spectate-hint');
  if (!el) return;
  if (player.alive) return;
  const t = player.specTarget && player.specTarget.alive ? player.specTarget : spectateCurrent();
  if (!t) {
    el.textContent = '💀 NO ONE LEFT TO SPECTATE';
  } else {
    const tag = t.team === 'ct' ? '[CT]' : '[T]';
    const mode = player.specMode === 'first' ? 'FIRST-PERSON' : 'CHASE CAM';
    el.textContent = `👁 SPECTATING ${t.short} ${tag} · ${mode}`;
  }
  if (hint) hint.textContent = 'CLICK / SPACE — next player · RMB / F — camera mode';
  applySpectateVisibility();
}
function spectateNext() {
  if (player.alive) return;
  const list = spectateTargets();
  if (!list.length) { player.specTarget = null; updateSpectateOverlay(); return; }
  let i = list.indexOf(player.specTarget);
  if (i < 0 && player.specTarget && player.specTarget.__remoteId != null) {
    i = list.findIndex((x) => x.__remoteId === player.specTarget.__remoteId);
  }
  player.specTarget = list[(i + 1) % list.length];
  player.yaw = player.specTarget.__isRemote ? player.specTarget.yaw : player.specTarget.yaw + Math.PI;
  player.pitch = 0;
  AudioSys.click(1200, 0.05, 0.25);
  updateSpectateOverlay();
}
function spectateToggleMode() {
  if (player.alive) return;
  player.specMode = player.specMode === 'first' ? 'chase' : 'first';
  AudioSys.click(900, 0.05, 0.25);
  updateSpectateOverlay();
}
function updateSpectate(dt) {
  mouseJustDown = false; // clicks while dead cycle targets, never fire
  const target = spectateCurrent();
  if (viewmodel) viewmodel.visible = false;
  $('scope-overlay').classList.add('hidden');
  $('crosshair').style.opacity = 0;
  // ease FOV back (e.g. after dying scoped with the AWP)
  camera.fov += (75 - camera.fov) * Math.min(1, dt * 8);
  camera.updateProjectionMatrix();
  camera.rotation.order = 'YXZ';
  applySpectateVisibility();
  if (!target) {
    // Nobody left alive — hold the corpse cam, free look.
    camera.position.set(player.pos.x, player.pos.y + EYE, player.pos.z);
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch;
    camera.rotation.z = 0;
    return;
  }
  if (player.specMode === 'first') {
    // Through their eyes, with our own look direction.
    camera.position.set(target.pos.x, target.pos.y + EYE, target.pos.z);
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch;
    camera.rotation.z = 0;
  } else {
    // Third-person chase: orbit behind the target on our yaw/pitch.
    const chest = new THREE.Vector3(target.pos.x, target.pos.y + 1.4, target.pos.z);
    const cp = clamp(player.pitch, -1.2, 1.2);
    const fx = -Math.sin(player.yaw) * Math.cos(cp);
    const fy = Math.sin(cp);
    const fz = -Math.cos(player.yaw) * Math.cos(cp);
    const want = 3.4;
    const back = new THREE.Vector3(-fx, -fy, -fz).normalize();
    const clear = rayWallDist(chest, back, want + 0.3);
    const dist = clamp(Math.min(want, Math.max(0.6, clear - 0.25)), 0.6, want);
    camera.position.copy(chest).addScaledVector(back, dist).add(new THREE.Vector3(0, 0.55, 0));
    camera.lookAt(chest.x, chest.y + 0.35, chest.z);
  }
}
function startMatch() {
  G.phase = 'playing'; G.round = 1; G.score = { ct: 0, t: 0 };
  G.kills = 0; G.deaths = 0; G.headshots = 0; G.shots = 0; G.hits = 0;
  G.startTime = performance.now();
  player.money = MONEY_START; player.kills = 0; player.deaths = 0;
  player.armor = 0;
  player.weapons = { ak: { owned: false, mag: 0, reserve: 0 }, deagle: { owned: true, mag: 7, reserve: 35 }, awp: { owned: false, mag: 0, reserve: 0 } };
  player.cur = 'deagle'; player.last = 'ak';
  startRound(true);
  $('main-menu').classList.add('hidden');
  $('end-screen').classList.add('hidden');
  $('hud').classList.remove('hidden');
  lockPointer();
}
function startRound(first = false, fromNet = false) {
  const diedLastRound = !first && !player.alive;
  G.roundKills = { ct: 0, t: 0 };
  G.timeLeft = ROUND_TIME; G.buyOpen = false; G.roundEnding = false;
  G.freezeLeft = FREEZE_TIME; G.buyLeft = BUY_TIME;
  $('buy-menu').classList.add('hidden');
  $('killfeed').innerHTML = '';
  // fresh battlefield: fade out tracers/smoke/debris, wipe decals (blood, holes, scorch)
  try {
    clearDecals();
    for (const arr of [tracers, particles, smokes, shockwaves, worldFlashes, debrisChunks]) {
      for (const e of arr) { try { scene.remove(e.mesh); } catch (err) {} }
      arr.length = 0;
    }
  } catch (e) {}
  // CS loadout rules: survivors keep guns/ammo/armor, dead reset to pistol + no armor
  if (first || diedLastRound) {
    if (!first) {
      player.weapons = { ak: { owned: false, mag: 0, reserve: 0 }, deagle: { owned: true, mag: 7, reserve: 35 }, awp: { owned: false, mag: 0, reserve: 0 } };
      player.cur = 'deagle'; player.last = 'ak';
      player.armor = 0;
    }
  }
  // reset actors — team-aware spawns (CT east-central, T west far).
  player.hp = 100;
  player.alive = true; player.reloading = 0;
  player.specTarget = null;
  player.hasBomb = false;
  player.bloom = 0; player.sprayIdx = 0; player.lastShotT = -9; player.aiming = false;
  vmRig.punchP = 0; vmRig.punchY = 0; vmRig.shake = 0; vmRig.fovKick = 0; vmRig.aimK = 0;
  {
    const mySpawns = (player.team || 'ct') === 't' ? spawns.t : spawns.ct;
    player.pos.copy(mySpawns[0]).add(new THREE.Vector3(rand(-0.8, 0.8), 0, rand(-1, 1)));
  }
  player.vel.set(0, 0, 0); player.yaw = faceCenterYawPlayer(player.pos); player.pitch = 0;
  if (!player.weapons[player.cur].owned) player.cur = player.weapons.deagle.owned ? 'deagle' : SLOT_ORDER.find((k) => player.weapons[k].owned) || 'deagle';
  buildViewmodel(player.cur);
  if (viewmodel) viewmodel.visible = true;
  if (!isMultiplayer()) { for (const b of bots) { resetBot(b); b.mesh.visible = true; } }
  else { clearBotsForMP(); }
  // scatter bots to their spawns (face center) — skipped in pure PvP.
  if (!isMultiplayer()) {
    bots.filter((b) => b.team === 'ct').forEach((b, i) => {
      b.pos.copy(spawns.ct[(i + 1) % 4]).add(new THREE.Vector3(rand(-0.8, 0.8), 0, rand(-0.8, 0.8)));
      b.yaw = faceCenterYaw(b.pos); b.mesh.rotation.y = b.yaw; b.mesh.position.copy(b.pos);
    });
    bots.filter((b) => b.team === 't').forEach((b, i) => {
      b.pos.copy(spawns.t[i % 4]).add(new THREE.Vector3(rand(-0.8, 0.8), 0, rand(-0.8, 0.8)));
      b.yaw = faceCenterYaw(b.pos); b.mesh.rotation.y = b.yaw; b.mesh.position.copy(b.pos);
    });
  }
  try { for (const [, e] of remotes) { if (e.data) { e.data.alive = true; e.data.hp = 100; } } } catch {}
  bombResetRound();
  try { if (isOnline() && (player.team || 'ct') === 't') player.hasBomb = true; } catch {}
  const tSite = BOMB.targetSite || 'A';
  const carrierName = BOMB.carrier ? BOMB.carrier.short : ((player.team === 't' && player.hasBomb) ? (player.name || 'YOU') : 'T');
  $('respawn-overlay').classList.add('hidden');
  if (isMultiplayer()) {
    const n = (Net.realPlayers || (remotes.size + 1));
    announce(first ? `ROUND 1 — PVP - ${n} PLAYERS - NO BOTS (${(player.team || 'ct').toUpperCase()})` : `ROUND ${G.round} — PVP - ${(player.team || 'ct').toUpperCase()} - ${n}P`, 2200);
  } else {
    announce(first ? `ROUND 1 — PISTOL - T PUSH ${tSite} (${carrierName} HAS BOMB)` : `ROUND ${G.round} — T PUSH ${tSite} - HOLD THE SITES`, 2200);
  }
  try { if (isOnline() && isRoundHost() && !fromNet) Net.sendRound({ action: 'start', round: G.round, first: !!first }); } catch {}
  setTimeout(() => { if (G.phase === 'playing' && isBuyTime() && player.alive && !G.roundEnding && !G.buyOpen) toggleBuy(true); }, 400);
  updateBuyTimer();
  updateHUD();
}
function checkRoundEnd() {
  if (G.phase !== 'playing' || G.roundEnding || isFreeze()) return;
  const { ct, t } = aliveCounts();
  // Bomb planted changes everything (CS rules):
  // - killing all Ts does NOT win — CTs must still defuse before it blows.
  // - killing all CTs while planted still waits for detonation (handled via quick fuse below).
  if (BOMB.planted) {
    if (ct <= 0 && t <= 0) { // mutual wipe after plant — bomb still blows, T wins.
      explodeBomb(performance.now() / 1000);
      return;
    }
    if (ct <= 0) {
      // No one left to defuse — fast-forward to detonation for pacing.
      BOMB.explodeAt = Math.min(BOMB.explodeAt, performance.now() / 1000 + 2.5);
      announce('ALL CT DOWN — BOMB WILL DETONATE', 1800);
      return;
    }
    return; // Ts all dead but bomb ticking — play the defuse!
  }
  if (t <= 0 && ct <= 0) endRound('draw');
  else if (t <= 0) endRound('ct', BOMB.droppedPos ? 'T WIPED — SITE HELD' : 'T WIPED');
  else if (ct <= 0) endRound('t', 'CT WIPED');
}
function endRound(winner, reason, fromNet = false) { // 'ct' | 't' | 'draw'
  if (G.phase !== 'playing' || G.roundEnding) return;
  G.roundEnding = true;
  if (G.buyOpen) toggleBuy(false);
  updateInteractHUD(null);
  for (const b of bots) { b.planting = false; b.defusing = false; }
  try { if (isOnline() && !fromNet) Net.sendRound({ action: 'end', winner, reason: reason || '', round: G.round }); } catch {}
  if (winner === 'ct') { G.score.ct++; addMoney(MONEY_WIN); AudioSys.roundWin(); announce((reason || 'ROUND WON') + ' — +$' + MONEY_WIN, 2200); }
  else if (winner === 't') { G.score.t++; addMoney(MONEY_LOSS); AudioSys.roundLose(); announce((reason || 'ROUND LOST') + ' — +$' + MONEY_LOSS, 2200); }
  else { addMoney(MONEY_DRAW); announce((reason || 'DRAW') + ' — +$' + MONEY_DRAW, 1800); }
  // bot economy irrelevant
  updateHUD();
  if (G.score.ct >= ROUNDS_TO_WIN_MATCH || G.score.t >= ROUNDS_TO_WIN_MATCH) { endMatch(); return; }
  G.round++;
  // Online: host drives the next round; guests wait for 'round/start' (plus fallback timer).
  try {
    if (isOnline() && !isRoundHost()) {
      setTimeout(() => { if (G.phase === 'playing' && G.roundEnding) startRound(false, true); }, 3400);
      return;
    }
  } catch {}
  setTimeout(() => { if (G.phase === 'playing') startRound(); }, 3000);
}
function endMatch() {
  G.phase = 'over';
  updateInteractHUD(null);
  for (const b of bots) if (b.alive) b.mesh.visible = true; // unhide first-person spectate target
  if ($('bomb-status')) $('bomb-status').classList.add('hidden');
  document.exitPointerLock && document.exitPointerLock();
  const myTeam = player.team || 'ct';
  const win = myTeam === 't' ? (G.score.t > G.score.ct) : (G.score.ct > G.score.t);
  $('end-title').textContent = win ? '🏆 VICTORY' : '💀 DEFEAT';
  $('end-title').style.color = win ? '#7dff9a' : '#ff6b6b';
  const acc = G.shots ? Math.round((G.hits / G.shots) * 100) : 0;
  const mins = ((performance.now() - G.startTime) / 60000).toFixed(1);
  $('end-sub').textContent = `Final: CT ${G.score.ct} — ${G.score.t} T · ${mins} min`;
  $('end-stats').innerHTML = `Kills <b>${G.kills}</b> · Deaths <b>${player.deaths}</b> · Headshots <b>${G.headshots}</b><br>Accuracy <b>${acc}%</b> (${G.hits}/${G.shots}) · Cash <b>$${player.money}</b>`;
  $('end-screen').classList.remove('hidden');
  win ? AudioSys.roundWin() : AudioSys.roundLose();
}
function pauseGame() {
  if (G.phase !== 'playing') return;
  G.phase = 'paused';
  $('pause-menu').classList.remove('hidden');
}
function resumeGame() {
  if (G.phase !== 'paused') return;
  G.phase = 'playing';
  $('pause-menu').classList.add('hidden');
  lockPointer();
}
function lockPointer() {
  AudioSys.init(); AudioSys.resume();
  if (renderer.domElement.requestPointerLock) {
    try { const p = renderer.domElement.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }
}

// ---------------- Player physics ----------------
let stepAt = 0;
function updatePlayer(dt, t) {
  if (!player.alive) {
    // CS: dead until round ends — spectate a living teammate instead of a
    // static death cam. Auto-advances when the target dies (spectateCurrent).
    const before = player.specTarget;
    updateSpectate(dt);
    if (player.specTarget !== before) updateSpectateOverlay();
    try {
      if (isOnline()) Net.sendState({
        x: player.pos.x, y: player.pos.y, z: player.pos.z,
        yaw: player.yaw, pitch: player.pitch, hp: 0, alive: false,
        weapon: player.cur, aiming: false, moving: false,
      });
    } catch {}
    return;
  }
  const frozen = isFreeze();
  const speedBase = player.cur === 'awp' && player.aiming ? 2.2 : 5.2;
  const sprint = !frozen && keys['ShiftLeft'] && !player.aiming && player.vel.lengthSq() > 0.1;
  const speed = frozen ? 0 : (player.aiming ? speedBase * 0.55 : speedBase) * (sprint ? 1.45 : 1);
  let ix = 0, iz = 0;
  if (player.alive && G.phase === 'playing' && !frozen) {
    if (keys['KeyW']) iz -= 1; if (keys['KeyS']) iz += 1;
    if (keys['KeyA']) ix -= 1; if (keys['KeyD']) ix += 1;
  }
  const len = Math.hypot(ix, iz) || 1;
  ix /= len; iz /= len;
  const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
  const wx = (ix * cos - iz * sin) * speed;
  const wz = (-ix * sin - iz * cos) * speed * -1;
  // NOTE: forward for yaw: forward = (-sin(yaw), -cos(yaw))? verify: yaw=0 -> looking -z. move:
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
  const mx = (rx * ix + fx * -iz) * speed;
  const mz = (rz * ix + fz * -iz) * speed;
  void wx; void wz;

  const accel = player.onGround ? 14 : 3;
  player.vel.x += (mx - player.vel.x) * Math.min(1, accel * dt);
  player.vel.z += (mz - player.vel.z) * Math.min(1, accel * dt);
  // gravity / jump (blocked while frozen — CS freeze time)
  if (player.onGround && keys['Space'] && player.alive && !isFreeze()) { player.vel.y = 5.2; player.onGround = false; }
  const fallV = player.vel.y;
  player.vel.y -= 13.5 * dt;
  moveWithCollision(player.pos, player.vel.x * dt, player.vel.z * dt, player.radius);
  player.pos.y += player.vel.y * dt;
  if (player.pos.y <= 0) {
    // landing thud scales with fall speed
    if (!player.onGround && fallV < -3.5 && player.alive) AudioSys.land(fallV < -7);
    player.pos.y = 0; player.vel.y = 0; player.onGround = true;
  }

  // footsteps (own boots, L/R alternating + sprint weight)
  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  if (player.onGround && hSpeed > 2 && t > stepAt) { stepAt = t + (sprint ? 0.3 : 0.42); AudioSys.step(null, sprint); }

  const def = WEAPONS[player.cur];
  // --- bloom cool-down + punch / shake / sway recovery ---
  const coolMul = player.aiming ? 1.6 : 1;
  player.bloom = Math.max(0, player.bloom - def.bloomDecay * coolMul * dt);
  if (t - player.lastShotT > 0.5) player.sprayIdx = Math.max(0, player.sprayIdx - dt * 6);
  const rec = Math.min(1, dt * 9);
  vmRig.punchP += (0 - vmRig.punchP) * Math.min(1, dt * 11);
  vmRig.punchY += (0 - vmRig.punchY) * rec;
  vmRig.shake += (0 - vmRig.shake) * Math.min(1, dt * 8);
  vmRig.fovKick += (0 - vmRig.fovKick) * Math.min(1, dt * 9);
  vmRig.swayX += (0 - vmRig.swayX) * Math.min(1, dt * 7);
  vmRig.swayY += (0 - vmRig.swayY) * Math.min(1, dt * 7);

  // --- camera with punch + shake + strafe lean + breathing ---
  const bob = hSpeed > 0.5 && player.onGround ? Math.sin(t * (sprint ? 12 : 9)) * 0.035 * (player.aiming ? 0.35 : 1) : 0;
  const breathe = player.aiming && player.onGround && hSpeed < 0.5 ? Math.sin(t * 1.9) * 0.0022 : 0;
  camera.position.set(player.pos.x, player.pos.y + EYE + bob, player.pos.z);
  camera.rotation.order = 'YXZ';
  const shX = vmRig.shake > 0.0005 ? (Math.random() - 0.5) * vmRig.shake * 2 : 0;
  const shY = vmRig.shake > 0.0005 ? (Math.random() - 0.5) * vmRig.shake * 2 : 0;
  camera.rotation.y = player.yaw + vmRig.punchY + shY;
  camera.rotation.x = player.pitch + vmRig.punchP + shX + breathe;
  camera.rotation.z = clamp(-ix * 0.012, -0.02, 0.02) + (vmRig.shake > 0.0005 ? (Math.random() - 0.5) * vmRig.shake : 0);

  // reload progress
  if (player.reloading > 0) {
    player.reloading -= dt;
    if (player.reloading <= 0) finishReload();
  }
  // firing (also catch fast semi-auto clicks that release within one frame; blocked in freeze)
  if ((mouseDown || mouseJustDown) && player.alive && G.phase === 'playing' && !G.buyOpen && !isFreeze() && !G.roundEnding) {
    if (def.auto) playerTryFire(t);
    else if (mouseJustDown) { playerTryFire(t); }
  }
  mouseJustDown = false;

  // --- ADS blend + viewmodel motion (bob / sway / draw / reload) ---
  const wantAim = (player.aiming && player.alive && player.reloading <= 0) ? 1 : 0;
  vmRig.aimK += (wantAim - vmRig.aimK) * Math.min(1, dt * 13);
  const aimE = vmRig.aimK * vmRig.aimK * (3 - 2 * vmRig.aimK); // smoothstep
  if (vmBase) {
    vmRig.bobT += dt * (2 + hSpeed * 1.55);
    vmRig.drawT = Math.min(1, vmRig.drawT + dt / 0.32);
    const hip = VM_HIP, aimP = VM_AIM[player.cur] || VM_AIM.ak;
    const drawK = 1 - vmRig.drawT;
    const bobAmp = 0.009 * (1 - aimE * 0.75);
    const bobX = Math.cos(vmRig.bobT * 0.5) * bobAmp * clamp(hSpeed / 5, 0, 1);
    const bobY = Math.abs(Math.sin(vmRig.bobT)) * bobAmp * 1.2 * clamp(hSpeed / 5, 0, 1) + Math.sin(t * 1.7) * 0.0018;
    let px = hip.x + (aimP.x - hip.x) * aimE + bobX + vmRig.swayX * (1 - aimE * 0.6);
    let py = hip.y + (aimP.y - hip.y) * aimE + bobY + vmRig.swayY * (1 - aimE * 0.6);
    let pz = hip.z + (aimP.z - hip.z) * aimE;
    // draw rise
    py -= drawK * 0.22;
    pz += drawK * 0.08;
    let rx = drawK * 0.55 + vmRig.swayY * 2.2 * (1 - aimE * 0.5);
    let ry = vmRig.swayX * 2.6 * (1 - aimE * 0.5);
    let rz = 0;
    // reload dip + tilt
    if (player.reloading > 0) {
      const rk = 1 - player.reloading / player.reloadDur;
      const dip = Math.sin(rk * Math.PI);
      py -= dip * 0.13; pz += dip * 0.02;
      rx -= dip * 0.75; rz += Math.sin(rk * Math.PI * 2) * 0.12; ry += dip * 0.25;
    }
    // sprint lowers gun
    if (sprint && hSpeed > 3) { py -= 0.03; rx -= 0.35; ry += 0.15; }
    vmBase.position.set(px, py, pz);
    vmBase.rotation.set(rx, ry, rz);
  }

  // aim / FOV (with punch kick that springs back)
  const targetFov = (player.aiming ? def.zoomFov : 75) + vmRig.fovKick;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 14);
  camera.updateProjectionMatrix();
  const scoped = player.aiming && player.cur === 'awp';
  $('scope-overlay').classList.toggle('hidden', !scoped);
  $('crosshair').style.opacity = scoped || !player.alive ? 0 : 1;
  if (viewmodel) viewmodel.visible = !scoped;
  // crosshair reflects heat + motion (bloom-driven)
  const wantGap = 6 + player.bloom * 620 + hSpeed * 1.3 + (player.onGround ? 0 : 9) + (player.aiming ? -2 : 0);
  crossGap += (clamp(wantGap, 5, 46) - crossGap) * Math.min(1, dt * 10);
  // hide spread UI glitch: hide crosshair lines while reloading draw? keep visible
  // --- multiplayer snapshot out (~20Hz) ---
  try {
    if (isOnline()) Net.sendState({
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      yaw: player.yaw, pitch: player.pitch, hp: Math.max(0, Math.round(player.hp)),
      alive: player.alive, weapon: player.cur, aiming: !!player.aiming, moving: hSpeed > 0.8,
    });
  } catch {}
}

// ---------------- FPS meter ----------------
let fpsAcc = 0, fpsN = 0, fpsAt = performance.now();
function fpsTick() {
  fpsAcc += 1; fpsN += 1;
  const now = performance.now();
  if (now - fpsAt > 500) {
    const fps = Math.round(fpsAcc * 1000 / (now - fpsAt));
    if (isMultiplayer()) {
      const foes = [...remotes.values()].filter((e) => e.data && e.data.alive && (e.data.team !== (player.team || 'ct'))).length;
      $('fps-counter').textContent = `${fps} FPS · ${foes} enemies (PVP · NO BOTS) · ${Net.realPlayers} online`;
    } else if (isOnline()) {
      $('fps-counter').textContent = `${fps} FPS · ${bots.filter((b) => b.alive).length} bots up · alone online`;
    } else {
      $('fps-counter').textContent = `${fps} FPS · ${bots.filter((b) => b.alive).length} hostiles up`;
    }
    fpsAcc = 0; fpsAt = now;
  }
}

// ---------------- Main loop ----------------
const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = performance.now() / 1000;
  if (G.phase === 'playing') {
    // CS timers: freeze first (round clock paused), then live; buy window ticks throughout
    if (G.freezeLeft > 0) {
      G.freezeLeft = Math.max(0, G.freezeLeft - dt);
      if (G.freezeLeft <= 0 && !G.roundEnding) {
        announce('GO GO GO', 900);
        AudioSys.click(880, 0.12, 0.4);
        setTimeout(() => AudioSys.click(1174, 0.14, 0.4), 130);
      }
    } else if (!G.roundEnding) {
      if (BOMB.planted) {
        // Bomb live — round clock is irrelevant now; it plays to boom/defuse.
        G.timeLeft = 0;
      } else {
        G.timeLeft -= dt;
        if (G.timeLeft <= 0) {
          G.timeLeft = 0;
          endRound('ct', 'TIME — CT WINS'); // CS: defense wins on time if no plant
        }
      }
    }
    if (G.buyLeft > 0) {
      G.buyLeft = Math.max(0, G.buyLeft - dt);
      if (G.buyLeft <= 0 && G.buyOpen) toggleBuy(false);
    }
    updatePlayer(dt, t);
    if (!isMultiplayer()) { for (const b of bots) updateBot(b, dt, t); }
    try { if (isOnline()) updateRemoteMeshes(dt, t); } catch {}
    updateBomb(dt, t);
    updateEffects(dt, t);
    try { updateScreenFeel(dt, t); } catch (e) {}
    // HUD: ~4Hz normally, every frame during freeze/buy/bomb countdown for smooth display
    loop.n = (loop.n || 0) + 1;
    if (loop.n % 15 === 0 || G.freezeLeft > 0 || BOMB.planted || (G.buyLeft > 0 && loop.n % 4 === 0)) { updateHUD(); updateBuyTimer(); }
    drawMinimap(t);
    if (!player.alive) { /* CS: dead until next round — no respawn */ }
  } else if (G.phase === 'paused' || G.phase === 'over' || G.phase === 'menu') {
    // idle menu camera orbit
    if (G.phase === 'menu') {
      const a = t * 0.12;
      camera.position.set(Math.sin(a) * 30, 14, Math.cos(a) * 30);
      camera.lookAt(0, 1, 0);
      camera.fov = 60; camera.updateProjectionMatrix();
      for (const b of bots) { // idle bots wander for menu backdrop
        if (!b.alive) continue;
        if (t >= b.nextThink) botThink(b, t);
        const dx = b.wp.x - b.pos.x, dz = b.wp.z - b.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 2) b.wp = randPick(waypoints).clone();
        else { b.pos.x += (dx / d) * b.speed * 0.5 * dt; b.pos.z += (dz / d) * b.speed * 0.5 * dt; b.yaw = Math.atan2(dx, dz); }
        b.mesh.position.copy(b.pos); b.mesh.rotation.y = b.yaw;
      }
      updateEffects(dt, t);
    }
  }
  fpsTick();
  renderer.render(scene, camera);
}

// ---------------- Boot ----------------
function defaultWsUrl() {
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // Same host, /ws path (server.js). File:// preview falls back to localhost:8080.
    if (location.protocol.startsWith('http')) return `${proto}://${location.host}/ws`;
  } catch {}
  return 'ws://localhost:8080/ws';
}
async function connectMultiplayer(statusCb) {
  const nameEl = document.getElementById('mp-name');
  const urlEl = document.getElementById('mp-url');
  const teamEl = document.getElementById('mp-team');
  const name = (nameEl && nameEl.value ? nameEl.value : ('Player' + ((Math.random() * 900 + 100) | 0))).slice(0, 16);
  const url = (urlEl && urlEl.value ? urlEl.value.trim() : '') || defaultWsUrl();
  const wantTeam = (teamEl && teamEl.value) || 'auto';
  if (statusCb) statusCb('CONNECTING…');
  try {
    wireMultiplayer();
    const r = await Net.connect(url, name, wantTeam);
    player.team = r.team; player.name = name;
    if (urlEl) urlEl.value = url;
    try { localStorage.setItem('h5cs_name', name); localStorage.setItem('h5cs_url', url); } catch {}
    if (statusCb) statusCb(`ONLINE AS ${r.team.toUpperCase()} · ${Net.realPlayers} PLAYER(S)`);
    updateMPStatus();
    return true;
  } catch (e) {
    console.warn('mp connect failed', e);
    if (statusCb) statusCb('CONNECT FAILED — SOLO VS BOTS (' + (e.message || 'no server') + ')');
    updateMPStatus();
    return false;
  }
}
function boot() {
  $('loading-note').textContent = 'Building map…';
  initThree();
  buildMap();
  buildViewmodel('deagle');
  if (viewmodel) viewmodel.visible = false; // hidden until match starts
  for (let i = 0; i < 4; i++) makeBot('ct', i);
  for (let i = 0; i < 4; i++) makeBot('t', i);
  initInput();
  try { wireMultiplayer(); updateMPStatus(); } catch {}
  // Restore last MP settings into the menu (if the new MP panel exists).
  try {
    const n = localStorage.getItem('h5cs_name'); const u = localStorage.getItem('h5cs_url');
    if (n && document.getElementById('mp-name')) document.getElementById('mp-name').value = n;
    if (u && document.getElementById('mp-url')) document.getElementById('mp-url').value = u;
    else if (document.getElementById('mp-url') && !document.getElementById('mp-url').value) {
      document.getElementById('mp-url').value = defaultWsUrl();
    }
  } catch {}
  updateHUD();
  // click canvas to (re)lock pointer — needed after ESC / buy menu /
  // spectating (browsers only allow pointer lock from a user gesture)
  renderer.domElement.addEventListener('click', () => {
    if (G.phase === 'playing' && !G.buyOpen && !pointerLocked) lockPointer();
  });

  $('opt-quality').addEventListener('change', (e) => {
    opts.quality = e.target.checked;
    renderer.shadowMap.enabled = opts.quality;
    sunLight.castShadow = opts.quality;
  });
  $('opt-sound').addEventListener('change', (e) => { opts.sound = e.target.checked; });
  $('opt-diff').addEventListener('change', (e) => { opts.difficulty = parseFloat(e.target.value); });
  const mpNote = (msg) => {
    const el = document.getElementById('mp-note');
    if (el) el.textContent = msg;
    const ln = $('loading-note');
    if (ln && msg) ln.textContent = msg;
  };
  const soloBtn = document.getElementById('solo-btn');
  const onlineBtn = document.getElementById('online-btn');
  if (soloBtn) soloBtn.addEventListener('click', () => {
    try { Net.disconnect(); for (const id of [...remotes.keys()]) removeRemoteMesh(id); } catch {}
    player.team = 'ct';
    AudioSys.init(); startMatch();
  });
  if (onlineBtn) onlineBtn.addEventListener('click', async () => {
    AudioSys.init();
    onlineBtn.disabled = true;
    const ok = await connectMultiplayer(mpNote);
    onlineBtn.disabled = false;
    // Join regardless (alone-on-server keeps bots until a second human joins).
    startMatch();
    if (!ok) mpNote('SERVER UNREACHABLE — PLAYING SOLO VS BOTS');
  });
  // Back-compat: old single DEPLOY button (if MP panel missing).
  const legacyPlay = $('play-btn');
  if (legacyPlay && !soloBtn) legacyPlay.addEventListener('click', () => { AudioSys.init(); startMatch(); });
  else if (legacyPlay) legacyPlay.addEventListener('click', () => { AudioSys.init(); startMatch(); });
  $('resume-btn').addEventListener('click', resumeGame);
  $('restart-btn').addEventListener('click', () => { $('pause-menu').classList.add('hidden'); G.phase = 'playing'; startMatch(); });
  $('again-btn').addEventListener('click', () => startMatch());

  $('loading-note').textContent = 'Ready. Click DEPLOY.';
  loop();
}

boot();
