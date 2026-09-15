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
  // CS2 P90: 50-round bullpup, ~857 RPM, low recoil, great on the move, weak at range
  p90:    { name: 'P90', slot: 0, damage: 22, headMult: 3.2, magSize: 50, startReserve: 100, fireInterval: 0.07, reloadTime: 3.3,
             spreadHip: 0.026, spreadAim: 0.012, range: 80, auto: true, zoomFov: 62, price: 2350,
             kickUp: 0.0062, kickSide: 0.0045, punch: 0.008, shake: 0.002, vmKick: 0.045, fovPunch: 0.8,
             bloomAdd: 0.0032, bloomMax: 0.03, bloomDecay: 0.07, tracer: 0xffe9a8, sound: 'smg', falloff: 0.55 },
};
// Classic-style AK spray pattern (x,y multipliers per consecutive shot, resets after pause)
const SPRAY_AK = [
  [0.1, 1.0], [-0.2, 1.0], [0.35, 1.0], [-0.5, 0.95], [0.6, 0.9], [-0.7, 0.85],
  [0.8, 0.8], [-0.6, 0.85], [0.4, 0.9], [-0.9, 0.9], [1.0, 0.85], [-0.8, 0.9],
  [0.9, 0.9], [-1.0, 0.85], [0.7, 0.9], [-0.6, 0.9], [0.5, 0.9], [-0.5, 0.9],
];
const SLOT_ORDER = ['ak', 'deagle', 'awp', 'p90'];
const PRIMARIES = ['ak', 'p90', 'awp']; // CS: one primary at a time — buying another replaces it
const newLoadout = () => ({ ak: { owned: false, mag: 0, reserve: 0 }, deagle: { owned: true, mag: 7, reserve: 35 }, awp: { owned: false, mag: 0, reserve: 0 }, p90: { owned: false, mag: 0, reserve: 0 } });
const primaryKey = () => PRIMARIES.find((k) => player.weapons[k] && player.weapons[k].owned) || null;
// ---------------- Tactical grenades (HE / Flash / Smoke / Molotov) ----------------
// fuse  = seconds after release (CS2: no cooking). Smoke pops once settled; molotov ignites on ground contact, airbursts at fuse.
// smokeFuse = pop time after throw; molotov ignites on first impact (fuse = failsafe)
const NADE_DEFS = {
  he:      { name: 'HE GRENADE', short: 'HE',    slot: 3, price: 300, max: 2, fuse: 1.5, radius: 7.5, damage: 98,  throwPower: 17, underPower: 7,  color: 0x4d7c3a, desc: 'Frag — radial damage' },
  flash:   { name: 'FLASHBANG',  short: 'FLASH', slot: 4, price: 200, max: 2, fuse: 1.5, radius: 26,  blindMax: 3.2, throwPower: 17, underPower: 7,  color: 0x8fc3ec, desc: 'Blinds on LOS' },
  smoke:   { name: 'SMOKE',      short: 'SMOKE', slot: 5, price: 300, max: 2, fuse: 1.7, radius: 3.8, duration: 18, throwPower: 17, underPower: 7, color: 0x9aa0ab, desc: 'Dynamic vision block' },
  molotov: { name: 'MOLOTOV',    short: 'MOLY',  slot: 6, price: 400, max: 1, fuse: 2.0, radius: 2.8, duration: 7.0, dps: 52, throwPower: 17, underPower: 7, color: 0xc76a1e, desc: 'Area denial fire' },
};
const NADE_ORDER = ['he', 'flash', 'smoke', 'molotov'];
const isNadeKey = (k) => !!NADE_DEFS[k];
const MAP_HALF = 34;            // playable half-extent
const EYE = 1.62;
const CROUCH_EYE_DROP = 0.44; // eyeline drop, matched to how far the crouch pose sinks the hips
const STAND_HEIGHT = 1.8;     // collision hull height standing
const CROUCH_HEIGHT = 1.25;   // ...and crouched (fits under low overhangs)
const CROUCH_JUMP_LIFT = 0.34; // crouching mid-air tucks the legs: feet rise, eye stays put (CS crouch-jump)
const STEP_EPS = 0.04;        // hull starts this far above the feet so standing on a box top isn't a collision
// Wall running: jump at a wall that runs alongside you while holding W.
const WALLRUN = {
  minSpeed: 3.0,     // horizontal speed along the wall needed to latch on
  minAirY: 0.25,     // must be this far above whatever you're standing over
  maxTime: 1.4,      // seconds before you peel off
  gravity: 3.2,      // reduced gravity while on the wall (normal is 13.5)
  maxSink: -2.2,     // clamp downward speed while running
  speed: 7.4,        // run speed along the wall
  jumpUp: 5.8,       // wall-jump vertical kick
  jumpOut: 5.6,      // wall-jump push away from the wall
  probe: 0.18,       // how far past the hull we look for a wall
  minWallAbove: 1.1, // the wall must rise at least this far above your feet
  cooldown: 0.25,    // after leaving a wall
  camRoll: 0.13,     // camera tilt away from the wall (rad)
  bodyLean: 0.32,    // third-person lean into the wall (rad)
};
const PLAYER_BODY_CULL_Y = 0.88; // your own body is legs only — the belt sits
                                 // directly under the camera and filled the view
const ROUND_TIME = 120;         // 2:00 round (CS-like, timer starts after freeze)
const BUY_TIME = 20;            // CS2-style buy window (20s from round start)
const FREEZE_TIME = 3;          // frozen in spawn: look + buy, no move/shoot
const ROUNDS_TO_WIN_MATCH = 7;
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
  planter: null,        // 'player' | bot ref — owns plantProgress (handing off restarts the bar)
  plantSite: null,      // site name the current plant progress belongs to
  defuseProgress: 0,
  defuser: null,        // 'player' | bot ref
  _plantAdvT: -1,       // sim time plantProgress last advanced — one advance per frame, one actor
  _defuseAdvT: -1,      // same guard for defuseProgress
  explodeAt: 0,         // performance-time seconds
  mesh: null,
  light: null,
  beepAt: 0,
  exploded: false,
};

const opts = { quality: true, sound: true, music: true, difficulty: 1 };

// ---------------- Settings (mouse / video / audio / crosshair+HUD) ----------------
// Persisted to localStorage on this machine only: no account, no server, no telemetry.
const SETTINGS_KEY = 'h5cs_settings_v1';
const SETTINGS_DEFAULTS = {
  // mouse & aim
  sens: 2.2, adsSens: 100, invertY: false, crouchToggle: false,
  // video
  fov: 75, fpsCap: 240, vsync: false, sway: 100, shake: 100, gore: true, goreLevel: 5, difficulty: 1,
  // audio
  sound: true, music: true, volMaster: 85, volMusic: 85,
  // crosshair & hud
  chColor: '#3dff7a', chLen: 7, chThick: 2, chGap: 100, chDot: true,
  hudKillfeed: true, hudMinimap: true,
};
const SET = Object.assign({}, SETTINGS_DEFAULTS);
const SETTINGS_SPEC = {
  mouse: [
    { k: 'sens', label: 'Mouse sensitivity', type: 'range', min: 0.2, max: 10, step: 0.1, dec: 1 },
    { k: 'adsSens', label: 'ADS / scoped sensitivity', type: 'range', min: 10, max: 150, step: 5, unit: '%' },
    { k: 'invertY', label: 'Invert vertical look', type: 'bool' },
    { k: 'crouchToggle', label: 'Toggle crouch (C) instead of hold', type: 'bool' },
  ],
  video: [
    { k: 'fov', label: 'Field of view', type: 'range', min: 60, max: 110, step: 1, unit: '°' },
    { k: 'vsync', label: 'VSync (lock to display refresh, ignores cap)', type: 'bool' },
    { k: 'fpsCap', label: 'FPS cap', type: 'range', min: 30, max: 500, step: 10, unit: ' fps' },
    { k: 'sway', label: 'View bob & weapon sway', type: 'range', min: 0, max: 150, step: 5, unit: '%' },
    { k: 'shake', label: 'Screen shake', type: 'range', min: 0, max: 150, step: 5, unit: '%' },
    { k: 'gore', label: 'Blood & gore', type: 'bool' },
    { k: 'goreLevel', label: 'Gore level (5 = insane)', type: 'range', min: 1, max: 5, step: 1 },
    { k: 'difficulty', label: 'Bot skill', type: 'select', choices: [[0.7, 'Recruit'], [1, 'Regular'], [1.4, 'Veteran']] },
  ],
  audio: [
    { k: 'sound', label: 'Sound', type: 'bool' },
    { k: 'volMaster', label: 'Master volume', type: 'range', min: 0, max: 100, step: 1, unit: '%' },
    { k: 'music', label: 'Dramatic classical music', type: 'bool' },
    { k: 'volMusic', label: 'Music volume', type: 'range', min: 0, max: 100, step: 1, unit: '%' },
  ],
  hud: [
    { k: 'chColor', label: 'Crosshair color', type: 'color' },
    { k: 'chLen', label: 'Crosshair length', type: 'range', min: 0, max: 16, step: 1, unit: 'px' },
    { k: 'chThick', label: 'Crosshair thickness', type: 'range', min: 1, max: 6, step: 1, unit: 'px' },
    { k: 'chGap', label: 'Crosshair gap', type: 'range', min: 0, max: 200, step: 5, unit: '%' },
    { k: 'chDot', label: 'Center dot', type: 'bool' },
    { k: 'hudKillfeed', label: 'Killfeed', type: 'bool' },
    { k: 'hudMinimap', label: 'Minimap', type: 'bool' },
  ],
};
let _setTab = 'mouse';

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) || {};
    for (const k of Object.keys(SETTINGS_DEFAULTS)) {
      if (saved[k] === undefined) continue;
      const d = SETTINGS_DEFAULTS[k];
      if (typeof d === 'boolean') SET[k] = !!saved[k];
      else if (typeof d === 'number') { const n = parseFloat(saved[k]); if (isFinite(n)) SET[k] = n; }
      if (k === 'fpsCap') SET.fpsCap = Math.max(30, Math.min(500, SET.fpsCap));
      else if (typeof saved[k] === 'string') SET[k] = saved[k];
    }
  } catch (e) { /* private window / storage disabled — defaults are fine */ }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SET)); } catch (e) {} }

// Push SET into everything the game actually reads at runtime.
function applySettings() {
  opts.quality = true; // always high — no low-quality mode.
  opts.sound = SET.sound; opts.music = SET.music; opts.difficulty = SET.difficulty;
  try { if (renderer) renderer.shadowMap.enabled = true; } catch (e) {}
  try { if (sunLight) sunLight.castShadow = true; } catch (e) {}
  try { AudioSys.applyVolumes(); } catch (e) {}
  if (!SET.music) { try { AudioSys.stopMusic(0.2); } catch (e) {} }
  try {
    const ch = $('crosshair');
    if (ch) {
      ch.style.setProperty('--ch-len', SET.chLen + 'px');
      ch.style.setProperty('--ch-thick', SET.chThick + 'px');
      ch.style.setProperty('--ch-color', SET.chColor);
      ch.classList.toggle('ch-nodot', !SET.chDot);
    }
    const kf = $('killfeed'); if (kf) kf.style.display = SET.hudKillfeed ? '' : 'none';
    const mm = $('minimap'); if (mm) mm.style.display = SET.hudMinimap ? '' : 'none';
  } catch (e) {}
  // keep the quick-access main-menu row showing the same truth
  try {
    if ($('opt-sound')) $('opt-sound').checked = SET.sound;
    if ($('opt-music')) $('opt-music').checked = SET.music;
    if ($('opt-diff')) $('opt-diff').value = String(SET.difficulty);
  } catch (e) {}
  syncCrosshairPreview();
}
function syncCrosshairPreview() {
  try {
    const w = document.querySelector('#ch-preview .ch-wrap');
    if (!w) return;
    w.style.setProperty('--ch-len', SET.chLen + 'px');
    w.style.setProperty('--ch-thick', SET.chThick + 'px');
    w.style.setProperty('--ch-color', SET.chColor);
    w.style.setProperty('--gap', (8 * SET.chGap / 100).toFixed(1) + 'px');
    w.classList.toggle('ch-nodot', !SET.chDot);
  } catch (e) {}
}
function buildSettingsUI() {
  const body = $('set-body');
  if (!body) return;
  body.innerHTML = '';
  for (const row of (SETTINGS_SPEC[_setTab] || [])) {
    const el = document.createElement('div');
    el.className = 'set-row';
    const name = document.createElement('label');
    name.className = 'set-name'; name.textContent = row.label;
    el.appendChild(name);
    let input = null, val = null;
    if (row.type === 'range') {
      input = document.createElement('input');
      input.type = 'range'; input.min = row.min; input.max = row.max; input.step = row.step;
      input.value = SET[row.k];
      val = document.createElement('span'); val.className = 'set-val';
      const show = () => { val.textContent = (row.dec ? Number(SET[row.k]).toFixed(row.dec) : Math.round(SET[row.k])) + (row.unit || ''); };
      show();
      input.addEventListener('input', () => { SET[row.k] = parseFloat(input.value); show(); applySettings(); saveSettings(); });
    } else if (row.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox'; input.checked = !!SET[row.k];
      input.addEventListener('change', () => { SET[row.k] = input.checked; applySettings(); saveSettings(); });
    } else if (row.type === 'color') {
      input = document.createElement('input');
      input.type = 'color'; input.value = SET[row.k];
      input.addEventListener('input', () => { SET[row.k] = input.value; applySettings(); saveSettings(); });
    } else if (row.type === 'select') {
      input = document.createElement('select');
      for (const pair of row.choices) {
        const o = document.createElement('option');
        o.value = String(pair[0]); o.textContent = pair[1];
        if (Number(SET[row.k]) === Number(pair[0])) o.selected = true;
        input.appendChild(o);
      }
      input.addEventListener('change', () => { SET[row.k] = parseFloat(input.value); applySettings(); saveSettings(); });
    }
    if (input) el.appendChild(input);
    if (val) el.appendChild(val);
    body.appendChild(el);
  }
  const prev = $('ch-preview');
  if (prev) prev.classList.toggle('hidden', _setTab !== 'hud');
  for (const b of document.querySelectorAll('.set-tab')) b.classList.toggle('active', b.dataset.tab === _setTab);
  syncCrosshairPreview();
}
function settingsOpen() { const el = $('settings-menu'); return !!el && !el.classList.contains('hidden'); }
function openSettings() {
  // Opening mid-match pauses first, so the pause menu is what you fall back to.
  if (G.phase === 'playing') pauseGame();
  $('settings-menu').classList.remove('hidden');
  buildSettingsUI();
}
function closeSettings() { $('settings-menu').classList.add('hidden'); }
function resetSettings() {
  Object.assign(SET, SETTINGS_DEFAULTS);
  applySettings(); saveSettings(); buildSettingsUI();
}
function wireSettingsUI() {
  const open = $('settings-btn'), openP = $('settings-btn-pause');
  if (open) open.addEventListener('click', openSettings);
  if (openP) openP.addEventListener('click', openSettings);
  const close = $('settings-close');
  if (close) close.addEventListener('click', closeSettings);
  const reset = $('settings-reset');
  if (reset) reset.addEventListener('click', resetSettings);
  for (const b of document.querySelectorAll('.set-tab')) {
    b.addEventListener('click', () => { _setTab = b.dataset.tab; buildSettingsUI(); });
  }
  const back = $('settings-menu');
  if (back) back.addEventListener('mousedown', (e) => { if (e.target === back) closeSettings(); });
}
// Per-frame reads.
const lookSens = () => SET.sens * 0.001;
const swayK = () => SET.sway / 100;
const shakeK = () => SET.shake / 100;


// ---------------- Audio (procedural WebAudio, full 3D) ----------------
// Realistic + dynamic: inverse-distance volume, stereo pan from listener yaw,
// air-absorption lowpass, wall occlusion, speed-of-sound delay, shared
// generated-impulse reverb + slap echo, per-weapon randomized layers.
const AudioSys = {
  ctx: null, master: null, shaper: null, comp: null, verb: null, verbGain: null,
  echo: null, echoFb: null, echoOut: null, muted: false,
  musicGain: null, _activeMusic: null, _winIdx: 0, _lossIdx: 0,
  _white: null, _brown: null, _ambient: false, _stepAlt: false,
  _voices: 0, _lastShootAt: 0,
  _buf: null, _loadingSamples: false,
  init() {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      // master -> soft clipper -> gentle glue compressor -> destination.
      // Keeps stacked AK sprays punchy instead of pumping flat.
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85 * (SET.volMaster / 100);
      this.shaper = this.ctx.createWaveShaper();
      try {
        const curve = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
          const x = (i / 128) - 1;
          curve[i] = Math.tanh(1.6 * x);
        }
        this.shaper.curve = curve;
        this.shaper.oversample = '2x';
      } catch (e) {}
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -12; this.comp.knee.value = 14;
      this.comp.ratio.value = 4; this.comp.attack.value = 0.004; this.comp.release.value = 0.18;
      this.master.connect(this.shaper); this.shaper.connect(this.comp); this.comp.connect(this.ctx.destination);
      // Dedicated 2D stereo non-diegetic music channel
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.85 * (SET.volMusic / 100);
      this.musicGain.connect(this.master);
      // short outdoor slap: 0.45s fast-decay stereo IR, kept quiet so guns stay dry
      const sr = this.ctx.sampleRate, len = Math.floor(sr * 0.45);
      const ir = this.ctx.createBuffer(2, len, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          const k = i / len;
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - k, 3.4) * 0.5;
        }
      }
      this.verb = this.ctx.createConvolver(); this.verb.buffer = ir;
      this.verbGain = this.ctx.createGain(); this.verbGain.gain.value = 0.16;
      this.verb.connect(this.verbGain); this.verbGain.connect(this.master);
      // shared slap echo for distant gun tails / bomb beeps
      this.echo = this.ctx.createDelay(1.0); this.echo.delayTime.value = 0.19;
      this.echoFb = this.ctx.createGain(); this.echoFb.gain.value = 0.28;
      this.echoOut = this.ctx.createGain(); this.echoOut.gain.value = 0.14;
      this.echo.connect(this.echoFb); this.echoFb.connect(this.echo);
      this.echo.connect(this.echoOut); this.echoOut.connect(this.master);
      // cached 1s white noise (cracks, mech, foley) + brown-ish noise (booms)
      const wb = this.ctx.createBuffer(1, sr, sr);
      const wd = wb.getChannelData(0);
      for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
      this._white = wb;
      const bb = this.ctx.createBuffer(1, sr, sr);
      const bd = bb.getChannelData(0);
      let last = 0;
      for (let i = 0; i < bd.length; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        bd[i] = last * 3.2;
      }
      this._brown = bb;
      this._buf = {};
      this._loadSamples();
      this._startAmbient();
    } catch (e) { /* no audio */ }
  },
  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    if (this.ctx && !this._ambient) this._startAmbient();
    if (this.ctx) this._loadSamples(); // retry until all samples decode
  },
  now() { return this.ctx ? this.ctx.currentTime : 0; },
  env(gainNode, t, peak, decay, attack = 0.002) {
    // fast fade-in kills the instant-jump click, then natural exp decay
    const p = Math.max(0.0002, peak);
    gainNode.gain.setValueAtTime(0.0001, t);
    gainNode.gain.linearRampToValueAtTime(p, t + attack);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  },
  _claimVoice(vol) {
    // polyphony guard: during full sprays drop the quietest far layers first
    if (this._voices > 26 && vol < 0.2) return false;
    if (this._voices > 40) return false;
    this._voices++;
    return true;
  },
  _releaseVoiceAt(t) {
    try {
      const dt = Math.max(0, (t - this.ctx.currentTime) * 1000);
      setTimeout(() => { this._voices = Math.max(0, this._voices - 1); }, dt + 30);
    } catch (e) { this._voices = Math.max(0, this._voices - 1); }
  },
  noiseBuffer(dur) {
    const sr = this.ctx.sampleRate, buf = this.ctx.createBuffer(1, Math.max(1, Math.floor(sr * dur)), sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  },
  // Real recorded samples (see sounds/CREDITS.txt). Loaded async; every caller
  // falls back to procedural synthesis when a buffer isn't decoded yet.
  SAMPLES: {
    rifle: 'sounds/rifle.mp3', pistol: 'sounds/pistol.mp3', sniper: 'sounds/sniper.mp3',
    explosion: 'sounds/explosion.mp3', he: 'sounds/he.mp3',
    reload_pump: 'sounds/reload_pump.mp3', reload_move: 'sounds/reload_move.mp3',
    click: 'sounds/click.mp3', steps: 'sounds/steps.mp3', crack: 'sounds/crack.mp3',
    impact: 'sounds/impact.mp3', clang: 'sounds/clang.mp3',
    music_beethoven: 'sounds/music_beethoven.mp3',
    music_valkyrie: 'sounds/music_valkyrie.mp3',
    music_chopin: 'sounds/music_chopin.mp3',
    music_lacrimosa: 'sounds/music_lacrimosa.mp3',
    music_verdi: 'sounds/music_verdi.mp3',
    music_bach: 'sounds/music_bach.mp3',
  },
  CLASSICAL_TRACKS: {
    beethoven: { name: 'music_beethoven', title: 'Beethoven — Symphony No. 5 (Fate)', composer: 'Ludwig van Beethoven', dur: 7.5, type: 'win' },
    valkyrie: { name: 'music_valkyrie', title: 'Wagner — Ride of the Valkyries', composer: 'Richard Wagner', dur: 8.0, type: 'win' },
    chopin: { name: 'music_chopin', title: 'Chopin — Funeral March (Op. 35)', composer: 'Frédéric Chopin', dur: 8.0, type: 'loss' },
    lacrimosa: { name: 'music_lacrimosa', title: 'Mozart — Requiem (Lacrimosa)', composer: 'W. A. Mozart', dur: 8.5, type: 'loss' },
    verdi: { name: 'music_verdi', title: 'Verdi — Requiem (Dies Irae)', composer: 'Giuseppe Verdi', dur: 6.5, type: 'loss' },
    bach: { name: 'music_bach', title: 'J.S. Bach — Toccata & Fugue in D Minor', composer: 'Johann Sebastian Bach', dur: 8.5, type: 'dramatic' },
  },
  STEP_SLICES: [0.94, 1.64, 2.43, 3.17], // step onsets inside steps.mp3 (0.3s windows)
  _loadSamples() {
    if (!this.ctx || this._loadingSamples) return;
    const names = Object.keys(this.SAMPLES).filter((n) => !this._buf[n]);
    if (!names.length) return;
    this._loadingSamples = true;
    const done = () => { this._loadingSamples = false; };
    try {
      Promise.all(names.map((n) =>
        fetch(this.SAMPLES[n]).then((r) => {
          if (!r.ok) throw new Error('http ' + r.status);
          return r.arrayBuffer();
        }).then((ab) => this.ctx.decodeAudioData(ab)).then((buf) => {
          this._buf[n] = buf;
        }).catch(() => { /* keep procedural fallback */ })
      )).then(done, done);
    } catch (e) { done(); }
  },
  // Play a decoded sample through the same 3D path (vol/pan/air/verb/echo).
  // Returns true when the sample path handled it (played or culled quiet),
  // false when no buffer is ready (caller should use procedural fallback).
  _sample({ name, peak = 0.8, rate = 1, offset = 0, dur = 0, pos = null, kind = 'sfx', verb = null, echo = 0, at = 0, lp = 0, pan = null }) {
    if (!this.ctx) return false;
    const buf = this._buf && this._buf[name];
    if (!buf) return false;
    const s = this._spatial(pos, kind);
    const scaled = peak * s.vol;
    if (scaled < 0.004) return true;
    if (!this._claimVoice(s.vol)) return true;
    const t0 = this.now() + s.delay + at;
    const playDur = dur > 0 ? dur : (buf.duration - offset);
    const tEnd = t0 + playDur + 0.08;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * rand(0.96, 1.04);
    const g = this.ctx.createGain();
    this.env(g, t0, scaled, Math.max(0.05, playDur * 0.85));
    const chain = [src, g];
    let head = src;
    // air absorption on top of the baked recording so distance still reads
    const lpF = lp > 0 ? Math.min(lp, s.lp) : s.lp;
    if (lpF < 17000) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = lpF; f.Q.value = 0.4;
      head.connect(f); head = f; chain.push(f);
    }
    head.connect(g);
    const p = this._pan(pan !== null ? pan : s.pan);
    g.connect(p);
    if (p !== this.master) chain.push(p);
    const vAmt = verb !== null ? verb : s.verb;
    if (vAmt > 0.01) {
      const vs = this.ctx.createGain(); vs.gain.value = vAmt;
      g.connect(vs); vs.connect(this.verb);
      chain.push(vs);
    }
    if (echo > 0.01 && this.echo) {
      const es = this.ctx.createGain(); es.gain.value = echo * clamp(s.dist / 30, 0.15, 1);
      const ef = this.ctx.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = clamp(s.lp * 0.4, 300, 4000);
      g.connect(ef); ef.connect(es); es.connect(this.echo);
      chain.push(ef, es);
    }
    try {
      src.start(t0, Math.min(offset, Math.max(0, buf.duration - 0.05)), Math.max(0.05, playDur));
      src.stop(tEnd);
    } catch (e) {}
    this._cleanup(src, chain, tEnd);
    this._releaseVoiceAt(tEnd);
    return true;
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
  applyVolumes() {
    if (!this.ctx) return;
    try {
      if (this.master) this.master.gain.value = 0.85 * (SET.volMaster / 100);
      if (this.musicGain) this.musicGain.gain.value = 0.85 * (SET.volMusic / 100);
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
    const fallback = { vol: 1, pan: 0, lp: 19000, delay: 0, verb: 0.035, dist: 0, occluded: false };
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
    const verb = clamp(0.035 + dist / 70 + (occluded ? 0.18 : 0), 0.03, 0.4);
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
  _cleanup(src, nodes, tEnd) {
    // disconnect the whole chain shortly after the voice ends — stops node leak buildup
    try {
      if (src.onended !== undefined) {
        src.onended = () => {
          try { nodes.forEach((n) => { try { n.disconnect(); } catch (e) {} }); } catch (e) {}
        };
      } else {
        const dt = Math.max(0, (tEnd - this.ctx.currentTime) * 1000);
        setTimeout(() => { try { nodes.forEach((n) => { try { n.disconnect(); } catch (e) {} }); } catch (e) {} }, dt + 60);
      }
    } catch (e) {}
  },
  // generic filtered-noise hit routed through pan + reverb send
  _noise({ dur = 0.2, type = 'lowpass', freq = 1500, Q = 0.8, peak = 0.5, decay = 0.15, rate = 1, pos = null, kind = 'sfx', verb = null, echo = 0, at = 0, sweepTo = 0, brown = false }) {
    if (!this.ctx) return;
    const s = this._spatial(pos, kind);
    const scaled = peak * s.vol;
    if (scaled < 0.004) return;
    if (!this._claimVoice(s.vol)) return;
    const t0 = this.now() + s.delay + at;
    const tEnd = t0 + dur + 0.1;
    const src = this.ctx.createBufferSource();
    src.buffer = (brown && this._brown) ? this._brown : this._white; src.loop = true;
    src.playbackRate.value = rate * rand(0.94, 1.06);
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(Math.min(freq * rand(0.92, 1.08), s.lp), t0);
    if (sweepTo > 0) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + 0.002 + decay);
    f.Q.value = Q;
    const g = this.ctx.createGain();
    this.env(g, t0, scaled, decay);
    const p = this._pan(s.pan);
    src.connect(f); f.connect(g); g.connect(p);
    const chain = [src, f, g];
    if (p !== this.master) chain.push(p);
    const vAmt = verb !== null ? verb : s.verb;
    if (vAmt > 0.01) {
      const vs = this.ctx.createGain(); vs.gain.value = vAmt;
      g.connect(vs); vs.connect(this.verb);
      chain.push(vs);
    }
    if (echo > 0.01 && this.echo) {
      const es = this.ctx.createGain(); es.gain.value = echo * clamp(s.dist / 30, 0.15, 1);
      // echo itself muffled with distance
      const ef = this.ctx.createBiquadFilter(); ef.type = 'lowpass'; ef.frequency.value = clamp(s.lp * 0.4, 300, 4000);
      g.connect(ef); ef.connect(es); es.connect(this.echo);
      chain.push(ef, es);
    }
    const stopJit = dur + 0.1;
    try { src.start(t0, Math.random() * 0.5); src.stop(tEnd); } catch (e) {}
    this._cleanup(src, chain, tEnd);
    this._releaseVoiceAt(tEnd);
  },
  _tone({ type = 'sine', f0 = 440, f1 = 0, dur = 0.2, peak = 0.4, decay = 0.15, pos = null, kind = 'sfx', verb = null, at = 0 }) {
    if (!this.ctx) return;
    if (type === 'square' || type === 'sawtooth') type = 'triangle'; // never ship 8-bit waves
    const s = this._spatial(pos, kind);
    const scaled = peak * s.vol;
    if (scaled < 0.004) return;
    if (!this._claimVoice(s.vol)) return;
    const t0 = this.now() + s.delay + at;
    const tEnd = t0 + dur + 0.06;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0 * rand(0.97, 1.03)), t0);
    if (f1 > 0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + 0.002 + decay);
    const g = this.ctx.createGain();
    this.env(g, t0, scaled, decay);
    const p = this._pan(s.pan);
    o.connect(g); g.connect(p);
    const chain = [o, g];
    if (p !== this.master) chain.push(p);
    const vAmt = verb !== null ? verb : s.verb;
    if (vAmt > 0.01) {
      const vs = this.ctx.createGain(); vs.gain.value = vAmt;
      g.connect(vs); vs.connect(this.verb);
      chain.push(vs);
    }
    try { o.start(t0); o.stop(tEnd); } catch (e) {}
    this._cleanup(o, chain, tEnd);
    this._releaseVoiceAt(tEnd);
  },
  _asPos(distOrPos) {
    // backward compat: old callers passed a distance number; new callers pass a Vector3
    if (distOrPos && typeof distOrPos.x === 'number') return distOrPos;
    return null; // number/undefined -> treat as non-positional (full vol, shaped by legacy dist)
  },
  // ---- GUNS: real recordings first, procedural fallback until decoded ----
  // Layers are gain-staged to sum ~1.0 so sprays don't slam the compressor flat.
  shoot(kind, distOrPos = 0) {
    if (!this.ctx || !opts.sound || this.muted) return;
    const pos = this._asPos(distOrPos);
    const legacyVol = (typeof distOrPos === 'number') ? clamp(1 - distOrPos / 70, 0.08, 1) : 1;
    const firstPerson = !pos;
    const dry = firstPerson ? 0.035 : null; // FP stays dry, world uses distance verb
    const lv = legacyVol;
    if (kind === 'smg') {
      // P90: the rifle recording sped up + lighter thump reads as a small-calibre bullpup
      const ok = this._sample({ name: 'rifle', peak: 0.6 * lv, dur: 0.2, rate: 1.42, pos, kind: 'gun', verb: dry, echo: firstPerson ? 0 : 0.06 });
      this._tone({ type: 'sine', f0: 210, f1: 70, dur: 0.07, peak: (firstPerson ? 0.26 : 0.2) * lv, decay: 0.06, pos, kind: 'gun', verb: dry });
      if (ok) return;
      this._noise({ dur: 0.025, type: 'highpass', freq: 3800, peak: 0.3 * lv, decay: 0.016, rate: 1.4, pos, kind: 'gun', verb: dry });
      this._noise({ dur: 0.1, type: 'bandpass', freq: 1500, Q: 0.9, peak: 0.42 * lv, decay: 0.06, rate: 1.2, pos, kind: 'gun', verb: dry, echo: firstPerson ? 0 : 0.06, brown: true });
      return;
    }
    if (kind === 'rifle') {
      // AK-47 recording + felt chest thump + close action clack
      const ok = this._sample({ name: 'rifle', peak: 0.82 * lv, dur: 0.32, pos, kind: 'gun', verb: dry, echo: firstPerson ? 0 : 0.08 });
      this._tone({ type: 'sine', f0: 150, f1: 44, dur: 0.14, peak: (firstPerson ? 0.4 : 0.3) * lv, decay: 0.11, pos, kind: 'gun', verb: dry });
      if (firstPerson || (pos && this._spatial(pos, 'gun').dist < 14)) {
        const mp = firstPerson ? null : pos;
        this._noise({ dur: 0.03, type: 'bandpass', freq: 3400, Q: 2, peak: 0.08 * lv, decay: 0.022, rate: 1.5, pos: mp, kind: 'sfx', verb: 0.02, at: 0.03 });
      }
      if (ok) return;
      // fallback: sharp supersonic crack + mid-forward receiver bark + chest thump
      this._noise({ dur: 0.03, type: 'highpass', freq: 3400, peak: 0.34 * lv, decay: 0.018, rate: 1.35, pos, kind: 'gun', verb: dry });
      this._noise({ dur: 0.09, type: 'highpass', freq: 1700, peak: 0.32 * lv, decay: 0.045, rate: 1.2, pos, kind: 'gun', verb: dry, echo: firstPerson ? 0 : 0.06 });
      this._noise({ dur: 0.2, type: 'lowpass', freq: 2100, sweepTo: 420, peak: (firstPerson ? 0.62 : 0.54) * lv, decay: 0.13, rate: 0.95, pos, kind: 'gun', verb: dry, echo: firstPerson ? 0 : 0.1, brown: true });
      this._tone({ type: 'sine', f0: 150, f1: 44, dur: 0.14, peak: (firstPerson ? 0.55 : 0.44) * lv, decay: 0.11, pos, kind: 'gun', verb: dry });
      this._noise({ dur: 0.04, type: 'bandpass', freq: 2200, Q: 1.6, peak: 0.12 * lv, decay: 0.032, rate: 1.3, pos, kind: 'gun', verb: dry, at: 0.035 });
    } else if (kind === 'pistol') {
      // Desert Eagle recording + deep sub
      const ok = this._sample({ name: 'pistol', peak: 0.85 * lv, dur: 0.5, pos, kind: 'gun', verb: dry, echo: firstPerson ? 0 : 0.06 });
      this._tone({ type: 'sine', f0: 130, f1: 40, dur: 0.15, peak: (firstPerson ? 0.42 : 0.32) * lv, decay: 0.13, pos, kind: 'gun', verb: dry });
      if (ok) return;
      // fallback: heavier snap + hollow chamber + deep sub — bigger and slower than the AK
      this._noise({ dur: 0.03, type: 'highpass', freq: 3200, peak: 0.34 * lv, decay: 0.02, rate: 1.3, pos, kind: 'gun', verb: dry });
      this._noise({ dur: 0.08, type: 'highpass', freq: 2200, peak: 0.34 * lv, decay: 0.05, rate: 1.2, pos, kind: 'gun', verb: dry, echo: firstPerson ? 0 : 0.05 });
      this._noise({ dur: 0.19, type: 'bandpass', freq: 900, Q: 0.9, peak: (firstPerson ? 0.66 : 0.56) * lv, decay: 0.13, rate: 0.95, pos, kind: 'gun', verb: dry, echo: firstPerson ? 0 : 0.08, brown: true });
      this._tone({ type: 'sine', f0: 130, f1: 40, dur: 0.15, peak: (firstPerson ? 0.58 : 0.46) * lv, decay: 0.13, pos, kind: 'gun', verb: dry });
    } else { // sniper / awp: cannon recording + long brown-woof tail + felt sub
      const ok = this._sample({ name: 'sniper', peak: 0.9 * lv, dur: 1.1, rate: 0.95, pos, kind: 'gun', verb: firstPerson ? 0.08 : null, echo: firstPerson ? 0.04 : 0.14 });
      this._tone({ type: 'sine', f0: 95, f1: 27, dur: 0.6, peak: 0.5 * lv, decay: 0.5, pos, kind: 'gun', verb: firstPerson ? 0.06 : null });
      this._noise({ dur: 0.6, type: 'lowpass', freq: 380, sweepTo: 100, peak: 0.2 * lv, decay: 0.6, rate: 0.6, pos, kind: 'gun', verb: 0.35, echo: 0.35, at: 0.2, brown: true });
      if (ok) return;
      // fallback synth layers under the same tail
      this._noise({ dur: 0.035, type: 'highpass', freq: 2600, peak: 0.4 * lv, decay: 0.022, rate: 1.25, pos, kind: 'gun', verb: dry });
      this._noise({ dur: 0.14, type: 'highpass', freq: 750, peak: 0.44 * lv, decay: 0.1, rate: 1.0, pos, kind: 'gun', verb: dry, echo: firstPerson ? 0.04 : 0.12 });
      this._noise({ dur: 0.55, type: 'lowpass', freq: 800, sweepTo: 110, peak: 0.7 * lv, decay: 0.42, rate: 0.85, pos, kind: 'gun', verb: firstPerson ? 0.1 : null, echo: 0.25, brown: true });
    }
  },
  mech(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    // bolt clack: two dry metal snaps, no pitched ring — staged on the ctx clock
    this._noise({ dur: 0.03, type: 'bandpass', freq: 3200, Q: 2.2, peak: 0.16, decay: 0.028, rate: 1.5, pos, kind: 'sfx' });
    this._noise({ dur: 0.025, type: 'highpass', freq: 5200, peak: 0.08, decay: 0.02, rate: 1.7, pos, kind: 'sfx' });
    this._noise({ dur: 0.04, type: 'bandpass', freq: 2000, Q: 1.8, peak: 0.15, decay: 0.035, rate: 1.2, pos, kind: 'sfx', at: 0.055 });
    this._noise({ dur: 0.025, type: 'highpass', freq: 4600, peak: 0.07, decay: 0.02, rate: 1.6, pos, kind: 'sfx', at: 0.055 });
  },
  click(freq = 2000, dur = 0.05, vol = 0.25, pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    // real recorded click; freq steers playback rate, never a pitched note
    if (this._sample({ name: 'click', peak: vol * 0.9, rate: clamp(freq / 2000, 0.75, 1.6), dur: Math.min(dur + 0.02, 0.12), pos, kind: 'sfx', verb: 0.03 })) return;
    // fallback: dry filtered snap only
    const d = Math.min(dur, 0.03);
    this._noise({ dur: d + 0.01, type: 'bandpass', freq: clamp(freq, 900, 4200), Q: 1.4, peak: vol * 0.7, decay: d, rate: 1.6, pos, kind: 'sfx' });
  },
  dryfire() {
    if (!this.ctx || !opts.sound || this.muted) return;
    if (this._sample({ name: 'click', peak: 0.3, rate: 0.75, dur: 0.2, verb: 0.03 })) {
      this._sample({ name: 'click', peak: 0.18, rate: 1.25, dur: 0.12, verb: 0.03, at: 0.05 });
      return;
    }
    // fallback: dull hammer fall + hollow trigger snap, no tone
    this._noise({ dur: 0.04, type: 'lowpass', freq: 900, peak: 0.22, decay: 0.035, rate: 0.9 });
    this._noise({ dur: 0.03, type: 'bandpass', freq: 2100, Q: 1.6, peak: 0.14, decay: 0.025, rate: 1.4, at: 0.045 });
  },
  reload(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    const k = pos ? 'gun' : 'sfx';
    // real handling foley staged on ctx time: mag out -> mag in -> charge
    const a = this._sample({ name: 'reload_pump', peak: 0.5, dur: 0.28, pos, kind: k });
    const b = this._sample({ name: 'reload_move', peak: 0.5, dur: 0.24, pos, kind: k, at: 0.18 });
    const c = this._sample({ name: 'reload_pump', peak: 0.52, rate: 1.18, dur: 0.26, pos, kind: k, at: 0.7 });
    if (a && b && c) {
      this._sample({ name: 'click', peak: 0.2, rate: 1.4, dur: 0.1, pos, kind: k, at: 0.7 });
      return;
    }
    // fallback foley: noise only, same staging
    this._noise({ dur: 0.055, type: 'bandpass', freq: 950, Q: 1.8, peak: 0.3, decay: 0.05, rate: 1.1, pos, kind: k });
    this._noise({ dur: 0.03, type: 'highpass', freq: 3600, peak: 0.09, decay: 0.025, rate: 1.5, pos, kind: k });
    this._noise({ dur: 0.055, type: 'bandpass', freq: 1450, Q: 1.8, peak: 0.32, decay: 0.05, rate: 1.25, pos, kind: k, at: 0.18 });
    this._noise({ dur: 0.03, type: 'highpass', freq: 4200, peak: 0.09, decay: 0.025, rate: 1.5, pos, kind: k, at: 0.18 });
    this._noise({ dur: 0.045, type: 'bandpass', freq: 2700, Q: 2.2, peak: 0.3, decay: 0.04, rate: 1.4, pos, kind: k, at: 0.7 });
    this._noise({ dur: 0.05, type: 'lowpass', freq: 800, peak: 0.2, decay: 0.045, rate: 0.9, pos, kind: k, at: 0.7 });
  },
  hit(headshot) {
    if (!this.ctx || !opts.sound || this.muted) return;
    // dry hit tick from the real click recording. Headshot = brighter + sharper.
    if (this._sample({ name: 'click', peak: headshot ? 0.34 : 0.3, rate: headshot ? 1.5 : 1.25, dur: 0.09, verb: 0.02 })) {
      if (headshot) this._noise({ dur: 0.05, type: 'lowpass', freq: 900, peak: 0.16, decay: 0.045, rate: 0.9 });
      return;
    }
    // fallback: felt impact through the stock, not a synth note
    if (headshot) {
      this._noise({ dur: 0.035, type: 'bandpass', freq: 3400, Q: 1.6, peak: 0.32, decay: 0.03, rate: 1.5, verb: 0.03 });
      this._noise({ dur: 0.05, type: 'lowpass', freq: 900, peak: 0.2, decay: 0.045, rate: 0.9 });
    } else {
      this._noise({ dur: 0.035, type: 'bandpass', freq: 2400, Q: 1.4, peak: 0.28, decay: 0.032, rate: 1.35, verb: 0.03 });
      this._noise({ dur: 0.05, type: 'lowpass', freq: 750, peak: 0.18, decay: 0.045, rate: 0.85 });
    }
  },
  kill() {
    if (!this.ctx || !opts.sound || this.muted) return;
    // kill confirm: single dull chest-thump + dry tick. No melody — CS has no kill jingle.
    this._tone({ type: 'sine', f0: 140, f1: 55, dur: 0.11, peak: 0.34, decay: 0.1, verb: 0.05 });
    this._noise({ dur: 0.04, type: 'bandpass', freq: 2600, Q: 1.5, peak: 0.2, decay: 0.035, rate: 1.4, verb: 0.04, at: 0.02 });
  },
  hurt() {
    if (!this.ctx || !opts.sound || this.muted) return;
    // body thud + soft grunt drop + breath — round waves only, no saw buzz
    this._tone({ type: 'triangle', f0: 190, f1: 85, dur: 0.2, peak: 0.32, decay: 0.19, verb: 0.06 });
    this._tone({ type: 'sine', f0: 95, f1: 45, dur: 0.19, peak: 0.42, decay: 0.17 });
    this._noise({ dur: 0.13, type: 'lowpass', freq: 650, sweepTo: 200, peak: 0.24, decay: 0.12, rate: 0.8 });
  },
  headpop(pos = null) {
    // wet skull crunch: sharp crack + pulpy burst + hollow knock — positional
    if (!this.ctx || !opts.sound || this.muted) return;
    this._noise({ dur: 0.06, type: 'highpass', freq: 1800, peak: 0.5, decay: 0.05, rate: 1.4, pos, kind: 'impact' });
    this._noise({ dur: 0.2, type: 'lowpass', freq: 1300, sweepTo: 220, peak: 0.58, decay: 0.18, rate: 0.9, pos, kind: 'impact', brown: true });
    this._tone({ type: 'sine', f0: 300, f1: 70, dur: 0.13, peak: 0.4, decay: 0.12, pos, kind: 'impact' });
    this._tone({ type: 'triangle', f0: 850, f1: 300, dur: 0.06, peak: 0.16, decay: 0.055, pos, kind: 'impact', verb: 0.15 });
    // delayed wet splat as chunks land (ctx-timed, keeps position)
    this._noise({ dur: 0.11, type: 'lowpass', freq: 750, sweepTo: 200, peak: 0.22, decay: 0.1, rate: 0.7, pos, kind: 'impact', at: 0.16 + Math.random() * 0.12 });
  },
  gib(pos = null, big = false) {
    // full dismemberment splat: meatier + longer than headpop, with bone rattle
    if (!this.ctx || !opts.sound || this.muted) return;
    this._noise({ dur: 0.09, type: 'highpass', freq: 1200, peak: big ? 0.6 : 0.48, decay: 0.07, rate: 1.2, pos, kind: 'explosion', echo: 0.04 });
    this._noise({ dur: 0.32, type: 'lowpass', freq: 1050, sweepTo: 150, peak: big ? 0.68 : 0.55, decay: 0.29, rate: 0.8, pos, kind: 'explosion', brown: true });
    this._tone({ type: 'sine', f0: 190, f1: 45, dur: 0.23, peak: 0.44, decay: 0.2, pos, kind: 'explosion' });
    for (let i = 0; i < (big ? 4 : 2); i++) {
      this._noise({ dur: 0.055, type: 'bandpass', freq: rand(900, 2400), Q: 1.6, peak: 0.15, decay: 0.05, rate: rand(0.9, 1.3), pos, kind: 'impact', at: rand(0.12, 0.5) });
    }
  },
  helmetHit(pos) {
    // helmet clatter: short dull tok from the real metal recording — positional
    if (!this.ctx || !opts.sound || this.muted || !pos) return;
    const s = this._spatial(pos, 'impact');
    if (s.vol < 0.02) return;
    if (this._sample({ name: 'clang', peak: 0.26, rate: rand(0.85, 1.0), dur: 0.22, pos, kind: 'impact', verb: 0.1 })) return;
    this._tone({ type: 'triangle', f0: rand(650, 850), f1: 300, dur: 0.05, peak: 0.15, decay: 0.05, pos, kind: 'impact', verb: 0.12 });
    this._noise({ dur: 0.03, type: 'highpass', freq: 3000, peak: 0.09, decay: 0.025, rate: 1.4, pos, kind: 'impact' });
  },
  step(pos = null, sprint = false) {
    if (!this.ctx || !opts.sound || this.muted) return;
    const isSelf = !pos || typeof pos.x !== 'number';
    this._stepAlt = !this._stepAlt;
    // real boot crunch: cycle slice windows so consecutive steps differ
    const slice = this.STEP_SLICES[(Math.random() * this.STEP_SLICES.length) | 0];
    if (isSelf) {
      const pan = (this._stepAlt ? -1 : 1) * 0.12;
      if (this._sample({ name: 'steps', peak: sprint ? 0.34 : 0.26, offset: slice + rand(-0.03, 0.03), dur: 0.3, pan, verb: 0.03 })) return;
      // fallback: alternating L/R micro-pan gravel crunch + soft thud
      const t0 = this.now();
      const mk = (freq, peak, rate) => {
        if (!this._claimVoice(1)) return;
        const src = this.ctx.createBufferSource(); src.buffer = this._white; src.loop = true;
        src.playbackRate.value = rate * rand(0.88, 1.12);
        const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq * rand(0.9, 1.1);
        const g = this.ctx.createGain(); this.env(g, t0, peak * rand(0.85, 1.15), 0.07);
        const p = this._pan(pan);
        src.connect(f); f.connect(g); g.connect(p);
        const tEnd = t0 + 0.14;
        const chain = p !== this.master ? [src, f, g, p] : [src, f, g];
        try { src.start(t0, Math.random() * 0.6); src.stop(tEnd); } catch (e) {}
        this._cleanup(src, chain, tEnd);
        this._releaseVoiceAt(tEnd);
      };
      mk(sprint ? 700 : 540, sprint ? 0.15 : 0.11, 0.9);
      mk(1350, 0.045, 1.5); // grit
      this._tone({ type: 'sine', f0: 82, f1: 50, dur: 0.06, peak: 0.09, decay: 0.06 });
    } else {
      // world boots: fully spatial real crunch, quiet, fades fast with distance
      const s = this._spatial(pos, 'step');
      if (s.vol < 0.015) return;
      if (this._sample({ name: 'steps', peak: (sprint ? 0.5 : 0.36), offset: slice + rand(-0.03, 0.03), dur: 0.3, pos, kind: 'step' })) return;
      this._noise({ dur: 0.085, type: 'lowpass', freq: rand(360, 600), peak: (sprint ? 0.42 : 0.3), decay: 0.07, rate: 0.85, pos, kind: 'step' });
    }
  },
  land(hard = false) {
    if (!this.ctx || !opts.sound || this.muted) return;
    this._tone({ type: 'sine', f0: hard ? 105 : 88, f1: 42, dur: 0.11, peak: hard ? 0.34 : 0.19, decay: 0.1 });
    this._noise({ dur: 0.09, type: 'lowpass', freq: hard ? 600 : 430, peak: hard ? 0.28 : 0.15, decay: 0.08, rate: 0.8 });
  },
  impact(pos, big = false) {
    if (!this.ctx || !opts.sound || this.muted || !pos) return;
    const s = this._spatial(pos, 'impact');
    if (s.vol < 0.012) return;
    // real recorded impact + dust wash. No ring — concrete doesn't ring.
    if (this._sample({ name: 'impact', peak: big ? 0.55 : 0.4, dur: 0.4, pos, kind: 'impact' })) {
      this._noise({ dur: 0.14, type: 'lowpass', freq: 850, sweepTo: 250, peak: 0.14, decay: 0.11, rate: 0.9, pos, kind: 'impact' });
      return;
    }
    this._noise({ dur: 0.06, type: 'highpass', freq: 2400, peak: big ? 0.4 : 0.27, decay: 0.045, rate: 1.3, pos, kind: 'impact' });
    this._noise({ dur: 0.14, type: 'lowpass', freq: 850, sweepTo: 250, peak: 0.24, decay: 0.11, rate: 0.9, pos, kind: 'impact' });
  },
  crack() {
    // real supersonic flyby snap when a round whips past the camera
    if (!this.ctx || !opts.sound || this.muted) return;
    if (this._sample({ name: 'crack', peak: rand(0.3, 0.42), dur: 0.55, verb: 0.04 })) return;
    if (!this._claimVoice(1)) return;
    const t0 = this.now();
    const tEnd = t0 + 0.16;
    const src = this.ctx.createBufferSource(); src.buffer = this._white; src.loop = true;
    src.playbackRate.value = rand(1.4, 1.8);
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.1;
    f.frequency.setValueAtTime(rand(2800, 3800), t0);
    f.frequency.exponentialRampToValueAtTime(rand(900, 1300), t0 + 0.09);
    const g = this.ctx.createGain(); this.env(g, t0, rand(0.16, 0.24), 0.085);
    const p = this._pan(rand(-0.7, 0.7));
    src.connect(f); f.connect(g); g.connect(p);
    const chain = p !== this.master ? [src, f, g, p] : [src, f, g];
    try { src.start(t0, Math.random() * 0.5); src.stop(tEnd); } catch (e) {}
    this._cleanup(src, chain, tEnd);
    this._releaseVoiceAt(tEnd);
  },
  shellTick(pos) {
    if (!this.ctx || !opts.sound || this.muted || !pos) return;
    const s = this._spatial(pos, 'impact');
    if (s.vol < 0.03 || s.dist > 14) return;
    // real brass tick, barely audible
    if (this._sample({ name: 'clang', peak: 0.1, rate: 1.8, dur: 0.15, pos, kind: 'impact', verb: 0.05 })) return;
    this._noise({ dur: 0.025, type: 'highpass', freq: 5200, peak: 0.05, decay: 0.02, rate: 1.7, pos, kind: 'impact', verb: 0.06 });
  },
  roundWin(reason = '') {
    if (!this.ctx || !opts.sound || this.muted) return null;
    // radio squelch + low resolve tone
    this._noise({ dur: 0.09, type: 'bandpass', freq: 1800, Q: 0.9, peak: 0.2, decay: 0.08, rate: 1.3, verb: 0.1 });
    this._tone({ type: 'sine', f0: 196, f1: 185, dur: 0.35, peak: 0.26, decay: 0.32, verb: 0.12, at: 0.09 });
    if (!opts.music) return null;
    const winKeys = ['beethoven', 'valkyrie'];
    const trackKey = winKeys[(this._winIdx++) % winKeys.length];
    return this.playMusic(trackKey);
  },
  roundLose(reason = '') {
    if (!this.ctx || !opts.sound || this.muted) return null;
    // radio squelch + dull tone
    this._noise({ dur: 0.09, type: 'bandpass', freq: 1300, Q: 0.9, peak: 0.18, decay: 0.08, rate: 1.1, verb: 0.1 });
    this._tone({ type: 'sine', f0: 147, f1: 130, dur: 0.32, peak: 0.24, decay: 0.3, verb: 0.12, at: 0.09 });
    if (!opts.music) return null;
    if (reason && (reason.includes('BOMB') || reason.includes('DETONAT') || reason.includes('💥'))) {
      const bombKeys = ['bach', 'verdi'];
      const trackKey = bombKeys[Math.floor(Math.random() * bombKeys.length)];
      return this.playMusic(trackKey);
    }
    const lossKeys = ['chopin', 'lacrimosa', 'verdi'];
    const trackKey = lossKeys[(this._lossIdx++) % lossKeys.length];
    return this.playMusic(trackKey);
  },
  bombDetonated() {
    if (!this.ctx || !opts.sound || this.muted || !opts.music) return null;
    return this.playMusic('bach');
  },
  tenSecWarning() {
    if (!this.ctx || !opts.sound || this.muted || !opts.music) return;
    const chord = [146.83, 174.61, 220.0, 293.66]; // D minor tension chord
    chord.forEach((f) => {
      this._tone({ type: 'triangle', f0: f, f1: f * 0.99, dur: 2.2, peak: 0.16, decay: 1.8 });
      this._tone({ type: 'sawtooth', f0: f / 2, f1: f / 2, dur: 2.5, peak: 0.12, decay: 2.0 });
    });
    this._tone({ type: 'sine', f0: 73.42, f1: 36.7, dur: 2.6, peak: 0.36, decay: 2.2 });
    this._noise({ dur: 0.4, type: 'lowpass', freq: 300, sweepTo: 60, peak: 0.3, decay: 0.35, brown: true });
  },
  playMusic(trackKey, volume = 0.85) {
    if (!this.ctx || !opts.sound || this.muted || !opts.music) return null;
    this.stopMusic(0.25);
    const track = this.CLASSICAL_TRACKS[trackKey];
    if (!track) return null;
    const buf = this._buf && this._buf[track.name];
    const t0 = this.now();
    if (buf) {
      try {
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const g = this.ctx.createGain();
        const playDur = Math.min(track.dur, buf.duration);
        const fadeStart = Math.max(0.3, playDur - 1.5);
        g.gain.setValueAtTime(0.001, t0);
        g.gain.linearRampToValueAtTime(volume, t0 + 0.08);
        g.gain.setValueAtTime(volume, t0 + fadeStart);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + playDur);
        src.connect(g);
        if (!this.musicGain) {
          this.musicGain = this.ctx.createGain();
          this.musicGain.gain.value = 0.85 * (SET.volMusic / 100);
          this.musicGain.connect(this.master);
        }
        g.connect(this.musicGain);
        src.start(t0);
        src.stop(t0 + playDur + 0.1);
        this._activeMusic = { src, gain: g, name: trackKey };
        src.onended = () => {
          if (this._activeMusic && this._activeMusic.src === src) this._activeMusic = null;
        };
      } catch (e) {
        this._playProceduralClassical(trackKey, volume);
      }
    } else {
      this._playProceduralClassical(trackKey, volume);
    }
    return track;
  },
  stopMusic(fadeTime = 1.0) {
    if (!this._activeMusic || !this.ctx) return;
    const { src, gain } = this._activeMusic;
    this._activeMusic = null;
    try {
      const t = this.now();
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, fadeTime));
      setTimeout(() => {
        try { src.stop(); src.disconnect(); gain.disconnect(); } catch (e) {}
      }, (fadeTime + 0.1) * 1000);
    } catch (e) {
      try { src.stop(); } catch (err) {}
    }
  },
  _playProceduralClassical(trackKey, volume = 0.8) {
    if (!this.ctx) return;
    const t0 = this.now();
    const gMaster = this.ctx.createGain();
    gMaster.gain.setValueAtTime(0.001, t0);
    gMaster.gain.linearRampToValueAtTime(volume, t0 + 0.05);
    gMaster.connect(this.musicGain || this.master);

    const playTone = (f, startOffset, dur, type = 'sawtooth', vol = 0.3, lp = 2600) => {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f, t0 + startOffset);
      const flt = this.ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = lp;
      const g = this.ctx.createGain();
      this.env(g, t0 + startOffset, vol, dur * 0.85, 0.02);
      o.connect(flt); flt.connect(g); g.connect(gMaster);
      try {
        o.start(t0 + startOffset);
        o.stop(t0 + startOffset + dur + 0.1);
        o.onended = () => { try { o.disconnect(); flt.disconnect(); g.disconnect(); } catch {} };
      } catch (e) {}
    };

    if (trackKey === 'beethoven' || trackKey === 'valkyrie') {
      // Beethoven Symphony No. 5 "Fate motif": G G G Eb | F F F D
      const notes = [
        { f: 392, t: 0.0, d: 0.2 },
        { f: 392, t: 0.22, d: 0.2 },
        { f: 392, t: 0.44, d: 0.2 },
        { f: 311.13, t: 0.66, d: 1.6 },
        { f: 349.23, t: 2.3, d: 0.2 },
        { f: 349.23, t: 2.52, d: 0.2 },
        { f: 349.23, t: 2.74, d: 0.2 },
        { f: 293.66, t: 2.96, d: 2.2 },
      ];
      notes.forEach((n) => {
        playTone(n.f, n.t, n.d, 'sawtooth', 0.26, 2800);
        playTone(n.f * 1.003, n.t, n.d, 'sawtooth', 0.18, 3000);
        playTone(n.f / 2, n.t, n.d, 'sawtooth', 0.24, 1500);
        playTone(n.f / 4, n.t, n.d, 'triangle', 0.32, 600);
      });
      this._noise({ dur: 0.8, type: 'lowpass', freq: 160, sweepTo: 45, peak: 0.6, decay: 0.7, at: 0.66, brown: true });
      this._noise({ dur: 1.0, type: 'lowpass', freq: 150, sweepTo: 40, peak: 0.65, decay: 0.9, at: 2.96, brown: true });
    } else if (trackKey === 'bach') {
      // Bach Toccata in D minor
      const notes = [
        { f: 440, t: 0.0, d: 0.16 },
        { f: 392, t: 0.16, d: 0.16 },
        { f: 440, t: 0.32, d: 1.4 },
        { f: 392, t: 1.9, d: 0.14 },
        { f: 349.23, t: 2.05, d: 0.14 },
        { f: 329.63, t: 2.2, d: 0.14 },
        { f: 293.66, t: 2.35, d: 0.14 },
        { f: 277.18, t: 2.5, d: 0.18 },
        { f: 293.66, t: 2.7, d: 0.9 },
      ];
      notes.forEach((n) => {
        playTone(n.f, n.t, n.d, 'triangle', 0.28, 3600);
        playTone(n.f * 2, n.t, n.d, 'sine', 0.18, 5000);
        playTone(n.f / 2, n.t, n.d, 'triangle', 0.22, 1400);
      });
      [146.83, 220.0, 293.66, 349.23, 440.0].forEach((f) => {
        playTone(f, 3.8, 3.2, 'sawtooth', 0.18, 2200);
        playTone(f, 3.8, 3.2, 'triangle', 0.22, 1800);
      });
      playTone(73.42, 3.8, 3.5, 'sine', 0.5, 400);
    } else if (trackKey === 'verdi') {
      // Verdi Requiem Dies Irae: 4 thunderous blasts
      for (let i = 0; i < 4; i++) {
        const at = i * 0.48;
        [98, 146.83, 196, 233.08, 293.66].forEach((f) => {
          playTone(f, at, 0.4, 'sawtooth', 0.25, 2800);
        });
        this._noise({ dur: 0.55, type: 'lowpass', freq: 220, sweepTo: 40, peak: 0.75, decay: 0.45, at, brown: true });
        this._tone({ type: 'sine', f0: 110, f1: 35, dur: 0.5, peak: 0.6, decay: 0.45, at });
      }
    } else {
      // Chopin Funeral March (Bb minor)
      const march = [
        { f: 233.08, t: 0.0, d: 0.48 },
        { f: 233.08, t: 0.55, d: 0.48 },
        { f: 233.08, t: 1.1, d: 0.48 },
        { f: 233.08, t: 1.65, d: 0.7 },
        { f: 277.18, t: 2.4, d: 0.48 },
        { f: 261.63, t: 2.9, d: 0.35 },
        { f: 261.63, t: 3.3, d: 0.35 },
        { f: 233.08, t: 3.7, d: 1.8 },
      ];
      march.forEach((n) => {
        playTone(n.f, n.t, n.d, 'triangle', 0.32, 1800);
        playTone(n.f / 2, n.t, n.d, 'triangle', 0.28, 900);
        playTone(n.f / 4, n.t, n.d, 'sine', 0.35, 400);
      });
      this._tone({ type: 'triangle', f0: 932.33, f1: 466.16, dur: 1.2, peak: 0.12, decay: 1.0, at: 0.0, verb: 0.3 });
      this._tone({ type: 'triangle', f0: 932.33, f1: 466.16, dur: 1.2, peak: 0.12, decay: 1.0, at: 2.4, verb: 0.3 });
    }
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
    this._tone({ type: 'sine', f0: f, dur: 0.08, peak: urgent ? 0.4 : 0.3, decay: urgent ? 0.08 : 0.065, pos: p, kind: 'beep', verb: 0.2 });
    this._tone({ type: 'sine', f0: f * 2, dur: 0.045, peak: 0.06, decay: 0.045, pos: p, kind: 'beep' });
  },
  plantBeep() {
    // planter feedback: three short dry ticks, same pitch — no melody.
    for (let i = 0; i < 3; i++) {
      this._noise({ dur: 0.035, type: 'bandpass', freq: 2000, Q: 2.5, peak: 0.22, decay: 0.03, rate: 1.5, verb: 0.04, at: i * 0.118 });
    }
  },
  plantedConfirm() {
    // bomb armed: two dull clunks, not a jingle.
    this._noise({ dur: 0.06, type: 'lowpass', freq: 700, peak: 0.3, decay: 0.055, rate: 0.9, verb: 0.06 });
    this._noise({ dur: 0.06, type: 'lowpass', freq: 620, peak: 0.3, decay: 0.055, rate: 0.85, verb: 0.06, at: 0.16 });
  },
  defuseTick(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    let p = pos;
    try { if (!p && typeof BOMB !== 'undefined' && BOMB.pos) p = BOMB.pos; } catch (e) {}
    this._tone({ type: 'sine', f0: 1500, dur: 0.035, peak: 0.15, decay: 0.035, pos: p, kind: 'beep', verb: 0.15 });
  },
  explode(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    try {
      let p = pos;
      try {
        if (!p && typeof BOMB !== 'undefined') p = (BOMB.pos || BOMB.droppedPos || null);
      } catch (e) {}
      // C4: real recorded blast + felt sub + debris. No clip-stacking.
      const ok = this._sample({ name: 'explosion', peak: 0.85, dur: 1.6, rate: 0.95, pos: p, kind: 'explosion', verb: 0.28, echo: 0.3 });
      this._tone({ type: 'sine', f0: 100, f1: 26, dur: 1.0, peak: 0.55, decay: 0.95, pos: p, kind: 'explosion', verb: 0.2 });
      for (let i = 0; i < 3; i++) {
        this._noise({ dur: 0.07, type: 'bandpass', freq: rand(700, 2600), Q: 1.5, peak: 0.12, decay: 0.06, rate: rand(0.8, 1.3), pos: p, kind: 'explosion', at: rand(0.15, 0.8) });
      }
      if (ok) return;
      // fallback synth
      this._noise({ dur: 0.2, type: 'highpass', freq: 600, peak: 0.65, decay: 0.15, rate: 1.0, pos: p, kind: 'explosion', echo: 0.08 });
      this._noise({ dur: 1.1, type: 'lowpass', freq: 850, sweepTo: 55, peak: 0.72, decay: 1.0, rate: 0.9, pos: p, kind: 'explosion', verb: 0.32, echo: 0.3, brown: true });
      this._tone({ type: 'sine', f0: 100, f1: 26, dur: 1.0, peak: 0.7, decay: 0.95, pos: p, kind: 'explosion', verb: 0.22 });
      this._noise({ dur: 1.1, type: 'lowpass', freq: 300, sweepTo: 90, peak: 0.28, decay: 1.0, rate: 0.6, pos: p, kind: 'explosion', verb: 0.38, echo: 0.4, at: 0.25, brown: true });
    } catch (e) {}
  },
  // ---- Tactical grenade sounds (all positional) ----
  pin(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    // real pin-pull snap from the metal recording
    if (this._sample({ name: 'clang', peak: 0.2, rate: 1.6, dur: 0.14, pos, kind: 'sfx', verb: 0.03 })) return;
    this._noise({ dur: 0.03, type: 'bandpass', freq: 2900, Q: 2, peak: 0.14, decay: 0.028, rate: 1.6, pos, kind: 'sfx' });
    this._noise({ dur: 0.025, type: 'highpass', freq: 4800, peak: 0.09, decay: 0.02, rate: 1.7, pos, kind: 'sfx', at: 0.03 });
  },
  throwWhoosh(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    this._noise({ dur: 0.16, type: 'bandpass', freq: 850, Q: 1.2, peak: 0.17, decay: 0.14, rate: 1.0, pos, kind: 'sfx' });
  },
  nadeBounce(pos, hard = false) {
    if (!this.ctx || !opts.sound || this.muted || !pos) return;
    const s = this._spatial(pos, 'impact');
    if (s.vol < 0.02) return;
    // real steel knock, short + quiet
    if (this._sample({ name: 'clang', peak: hard ? 0.3 : 0.2, rate: hard ? 0.9 : 1.1, dur: 0.25, pos, kind: 'impact', verb: 0.08 })) return;
    this._noise({ dur: 0.045, type: 'bandpass', freq: hard ? 700 : 950, Q: 1.8, peak: hard ? 0.2 : 0.13, decay: 0.04, rate: 1.1, pos, kind: 'impact', verb: 0.1 });
  },
  heBoom(pos = null) {
    // HE frag: real short-burst recording + sub. Smaller than C4.
    if (!this.ctx || !opts.sound || this.muted) return;
    const ok = this._sample({ name: 'he', peak: 0.8, dur: 1.0, pos, kind: 'explosion', verb: 0.26, echo: 0.22 });
    this._tone({ type: 'sine', f0: 115, f1: 32, dur: 0.5, peak: 0.45, decay: 0.45, pos, kind: 'explosion', verb: 0.18 });
    if (ok) return;
    this._noise({ dur: 0.14, type: 'highpass', freq: 700, peak: 0.6, decay: 0.11, rate: 1.05, pos, kind: 'explosion', echo: 0.06 });
    this._noise({ dur: 0.7, type: 'lowpass', freq: 750, sweepTo: 60, peak: 0.68, decay: 0.62, rate: 0.9, pos, kind: 'explosion', verb: 0.3, echo: 0.25, brown: true });
    this._tone({ type: 'sine', f0: 115, f1: 32, dur: 0.55, peak: 0.6, decay: 0.5, pos, kind: 'explosion', verb: 0.2 });
    for (let i = 0; i < 3; i++) {
      this._noise({ dur: 0.055, type: 'bandpass', freq: rand(900, 2600), Q: 1.5, peak: 0.14, decay: 0.05, rate: rand(0.9, 1.3), pos, kind: 'explosion', at: rand(0.1, 0.5) });
    }
  },
  flashPop(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    // flashbang: real sharp burst pitched up + restrained tinnitus ring
    if (this._sample({ name: 'he', peak: 0.7, rate: 1.3, dur: 0.5, pos, kind: 'explosion', echo: 0.04 })) {
      this._tone({ type: 'sine', f0: 3400, dur: 1.1, peak: 0.11, decay: 1.0, pos, kind: 'beep', verb: 0.08 });
      this._tone({ type: 'sine', f0: 5100, dur: 0.8, peak: 0.055, decay: 0.7, pos, kind: 'beep' });
      return;
    }
    this._noise({ dur: 0.09, type: 'highpass', freq: 1800, peak: 0.7, decay: 0.07, rate: 1.3, pos, kind: 'explosion', echo: 0.04 });
    this._tone({ type: 'sine', f0: 3400, dur: 1.1, peak: 0.11, decay: 1.0, pos, kind: 'beep', verb: 0.08 });
    this._tone({ type: 'sine', f0: 5100, dur: 0.8, peak: 0.055, decay: 0.7, pos, kind: 'beep' });
  },
  smokePop(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    this._noise({ dur: 0.28, type: 'lowpass', freq: 1100, sweepTo: 300, peak: 0.4, decay: 0.26, rate: 1.0, pos, kind: 'explosion', verb: 0.22 });
    this._noise({ dur: 0.55, type: 'lowpass', freq: 480, sweepTo: 150, peak: 0.24, decay: 0.5, rate: 0.7, pos, kind: 'explosion', verb: 0.28, at: 0.1, brown: true });
  },
  molotovIgnite(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    // glass shatter + whoomph: noise only, no pitched element
    this._noise({ dur: 0.09, type: 'highpass', freq: 2800, peak: 0.4, decay: 0.07, rate: 1.4, pos, kind: 'explosion' });
    this._noise({ dur: 0.22, type: 'highpass', freq: 1500, peak: 0.4, decay: 0.18, rate: 1.1, pos, kind: 'explosion', at: 0.03 });
    this._noise({ dur: 0.6, type: 'lowpass', freq: 850, sweepTo: 200, peak: 0.55, decay: 0.55, rate: 0.8, pos, kind: 'explosion', verb: 0.25, at: 0.06, brown: true });
  },
  fireLoopTick(pos = null) {
    if (!this.ctx || !opts.sound || this.muted || !pos) return;
    const s = this._spatial(pos, 'sfx');
    if (s.vol < 0.03) return;
    this._noise({ dur: 0.3, type: 'bandpass', freq: rand(400, 900), Q: 0.8, peak: 0.16, decay: 0.28, rate: rand(0.7, 1.1), pos, kind: 'sfx', verb: 0.25 });
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

// Anatomical hierarchy, not a pile of boxes: every limb rotates about a real joint.
//   root(feet) > pelvis > { hip > knee > ankle } x2
//                       > spine > chest > { shoulder > elbow } x2, neck > head, gun
// Old code addressed userData.legL / armL / torso and expected ".rotation.x = swing"
// to bend a limb; those keys now point at the hip / shoulder / spine PIVOTS, so
// every existing call site (gore, ragdoll, restore) keeps working — and finally
// bends the body where a body actually bends.
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
  const matCuff = new THREE.MeshStandardMaterial({ color: team === 'ct' ? 0x22344e : 0x6e562f, roughness: 0.9 });
  const matGlove = new THREE.MeshStandardMaterial({ color: 0x2b2b26, roughness: 0.95 });
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
    new THREE.MeshStandardMaterial({ color: team === 'ct' ? 0x3a4a5a : 0x7a6a48, roughness: 1 }),
    0, C(1.52), -0.29, false);
  roll.rotation.z = Math.PI / 2; chest.add(roll);
  chest.add(mk(new THREE.BoxGeometry(0.64, 0.09, 0.40),
    new THREE.MeshStandardMaterial({ color: team === 'ct' ? 0x66b3ff : 0xffc14d, emissive: team === 'ct' ? 0x1a3a5a : 0x5a3a10, emissiveIntensity: 0.7, roughness: 0.6 }),
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
    beard = mk(new THREE.BoxGeometry(0.3, 0.12, 0.05), new THREE.MeshStandardMaterial({ color: 0x2e1f12, roughness: 1 }), 0, N(1.66), 0.16, false);
    neck.add(beard);
    scarf = mk(new THREE.BoxGeometry(0.36, 0.12, 0.36), new THREE.MeshStandardMaterial({ color: 0x8a2f22, roughness: 1 }), 0, N(1.56), 0, false);
    neck.add(scarf);
  } else {
    glass = mk(new THREE.BoxGeometry(0.3, 0.1, 0.05), new THREE.MeshStandardMaterial({ color: 0x0e141c, roughness: 0.15, metalness: 0.8 }), 0, N(1.79), 0.17, false);
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
    new THREE.MeshStandardMaterial({ color: team === 'ct' ? 0x22303f : 0x6b4a2a, roughness: 0.8 }));
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

// ---------------- Procedural character animation ----------------
// Layered, the way a real animation graph is: a locomotion base (a two-segment
// gait driven by one phase clock), an aim layer that bends spine/neck/weapon
// toward where the soldier is looking, and additive impulses (recoil, flinch,
// landing, breathing) stacked on top. Everything is written in radians about
// real joints, so the poses stay anatomical instead of shearing boxes around.
const TAU = Math.PI * 2;
// frame-rate-independent smoothing: k = how much of the way to `to` per second
const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));

function newAnimState() {
  return {
    phase: Math.random() * TAU,   // gait clock
    spd: 0, fwd: 0, side: 0,      // smoothed body-space motion
    pitch: 0, crouch: 0, kneel: 0,
    fire: 0, flinch: 0, reload: 0,
    land: 0, air: 0, wall: 0,
    breathe: Math.random() * TAU,
    yawPrev: null, turn: 0,
    step: -1,                     // which foot last struck, for footstep hooks
  };
}
// One-shot impulses the game fires at the rig.
function soldierFireKick(mesh, amt = 1) {
  const a = mesh && mesh.userData && mesh.userData.anim; if (a) a.fire = Math.min(1.4, a.fire + amt);
}
function soldierFlinch(mesh, amt = 1) {
  const a = mesh && mesh.userData && mesh.userData.anim; if (a) a.flinch = Math.min(1, a.flinch + amt);
}

// inp: { vx, vz, yaw, pitch, grounded, crouch, kneel, reloading, moving, wall }
// wall: -1 (wall on left) .. +1 (wall on right). Staggered wall-run pose:
// wall-side foot plants high on the wall, trail leg extends, wall-side arm
// flares for balance, torso stays over the feet while the head levels out.
function animateSoldier(mesh, inp, dt, t) {
  const ud = mesh && mesh.userData;
  if (!ud || !ud.rig) return;
  const r = ud.rig;
  const A = ud.anim || (ud.anim = newAnimState());
  dt = clamp(dt, 0, 0.1);
  const yaw = inp.yaw || 0;

  // ---- inputs into body space (forward = +Z rotated by yaw, matching bot.yaw) ----
  const vx = inp.vx || 0, vz = inp.vz || 0;
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const fwdRaw = vx * sy + vz * cy;
  const sideRaw = vx * cy - vz * sy;
  const spdRaw = Math.hypot(vx, vz);
  A.spd = damp(A.spd, spdRaw, 11, dt);
  A.fwd = damp(A.fwd, fwdRaw, 11, dt);
  A.side = damp(A.side, sideRaw, 11, dt);
  A.pitch = damp(A.pitch, clamp(inp.pitch || 0, -1.2, 1.2), 12, dt);
  A.crouch = damp(A.crouch, inp.crouch ? 1 : 0, 9, dt);
  A.kneel = damp(A.kneel, inp.kneel ? 1 : 0, 7, dt);
  A.reload = damp(A.reload, inp.reloading ? 1 : 0, 10, dt);

  // turn-in-place: yaw rate with no translation makes the torso lead the hips
  if (A.yawPrev === null) A.yawPrev = yaw;
  let dYaw = yaw - A.yawPrev;
  while (dYaw > Math.PI) dYaw -= TAU; while (dYaw < -Math.PI) dYaw += TAU;
  A.yawPrev = yaw;
  A.turn = damp(A.turn, clamp(dYaw / Math.max(dt, 1e-4) * 0.12, -1, 1), 8, dt);

  // airborne / landing
  const grounded = inp.grounded !== false;
  if (!grounded) { A.air = Math.min(1, A.air + dt * 6); }
  else {
    if (A.air > 0.3) A.land = Math.min(1, A.land + A.air * 0.9); // dip proportional to hang time
    A.air = Math.max(0, A.air - dt * 8);
  }
  A.land = Math.max(0, A.land - dt * 3.2);
  A.fire = Math.max(0, A.fire - dt * 7);
  A.flinch = Math.max(0, A.flinch - dt * 4.5);
  A.breathe += dt * 1.5;

  // ---- gait clock ----
  // Cadence rises with speed the way a real stride does: longer AND faster steps.
  // Wall runs step quicker and shorter than a ground sprint.
  A.wall = damp(A.wall || 0, clamp(inp.wall || 0, -1, 1), 8, dt);
  const wAbs = Math.min(1, Math.abs(A.wall));
  const spd = A.spd;
  const amp = clamp(spd / 4.6, 0, 1);                 // stride amplitude
  const runK = clamp((spd - 2.2) / 3.4, 0, 1);        // walk -> run blend
  const cadence = spd > 0.15 ? (1.05 + spd * 0.30) * (1 + wAbs * 0.28) : 0;
  const backward = A.fwd < -0.35 ? -1 : 1;            // backpedal reverses the cycle
  A.phase += cadence * TAU * dt * backward;
  if (A.phase > TAU) A.phase -= TAU; if (A.phase < 0) A.phase += TAU;
  const p = A.phase;
  const kneelK = A.kneel, crouchK = A.crouch * (1 - kneelK);
  const gaitK = amp * (1 - kneelK) * (1 - A.air * 0.85);

  // ---- LEGS: hip swing, knee flexion (swing phase + loading response), ankle roll ----
  // A leg's knee only ever folds backwards, so knee flex is clamped >= 0.
  const mix = (a, b, k) => a + (b - a) * k;
  const legPose = (ph, hip, knee, ankle, kH, kK, kA) => {
    const sw = Math.sin(ph), cw = Math.cos(ph);
    // hip: thigh forward on swing, extended behind on toe-off (+x = backward)
    const hipA = -sw * (0.40 + 0.34 * runK) * gaitK;
    // knee: big flex through swing, small dip as weight loads at heel strike
    const swingFlex = Math.pow(Math.max(0, -Math.sin(ph - 0.55)), 1.5) * (0.95 + 0.85 * runK);
    const loadFlex = Math.max(0, Math.sin(ph * 2 + 0.4)) * 0.16;
    const kneeA = (swingFlex + loadFlex) * gaitK;
    // ankle: plantarflex at toe-off, dorsiflex to clear the ground mid-swing
    const ankleA = (Math.max(0, cw) * 0.30 - Math.max(0, -cw) * 0.22) * gaitK;
    // Joint limits are anatomical, not decorative: stacking a full stride onto a
    // crouch and a landing used to drive the knee to 203 deg, folding the shin
    // up through the thigh. A real knee tops out near 150.
    hip.rotation.x = clamp(mix(hipA - 1.45 * crouchK, kH, kneelK), -1.75, 1.05);
    hip.rotation.z = 0;
    knee.rotation.x = clamp(mix(kneeA + 2.20 * crouchK + A.land * 0.55, kK, kneelK), 0, 2.50);
    // sole stays flat when hip+knee+ankle sums to zero
    ankle.rotation.x = clamp(mix(ankleA - 0.75 * crouchK - A.land * 0.2, kA, kneelK), -1.40, 0.90);
  };
  // kneel = the bomb-plant/defuse crouch: rear knee on the deck, front foot planted
  // rear shin lies along the ground (hip+knee ~= 90deg from vertical), foot trailing
  legPose(p, r.hipL, r.kneeL, r.ankleL, 0.50, 1.07, -1.00);
  legPose(p + Math.PI, r.hipR, r.kneeR, r.ankleR, -1.57, 1.57, 0.0);

  // footstep hook: fires the instant a heel plants (used for sound/dust)
  const foot = Math.sin(p) > 0 ? 0 : 1;
  const struck = foot !== A.step && gaitK > 0.12;
  A.step = foot;

  // ---- PELVIS: height comes from the legs themselves (foot-planting IK) ----
  // Pin whichever sole is lowest to the floor and hang the body off it. The
  // vertical bounce of the walk then falls out of real leg geometry, and no foot
  // can ever sink through the ground — which a hand-tuned sine bob always does
  // eventually, because it has no idea where the feet actually are.
  const BOOT_DROP = 0.14, BOOT_FWD = 0.05;
  const soleDrop = (hip, knee, ankle) => {
    const h = hip.rotation.x, k = h + knee.rotation.x, a = k + ankle.rotation.x;
    return r.thigh * Math.cos(h) + r.shin * Math.cos(k) + BOOT_DROP * Math.cos(a) + BOOT_FWD * Math.sin(a);
  };
  let support = Math.max(soleDrop(r.hipL, r.kneeL, r.ankleL), soleDrop(r.hipR, r.kneeR, r.ankleR));
  // While kneeling the rear KNEE is the contact point, not that foot. Fading it in
  // from far below keeps it out of the calculation entirely when standing.
  const kneeContact = r.thigh * Math.cos(r.hipL.rotation.x) + 0.11;
  support = Math.max(support, kneeContact - (1 - kneelK) * 3);
  r.pelvis.position.y = Math.max(0.20, support - A.land * 0.10 + A.air * 0.03);
  r.pelvis.rotation.z = Math.sin(p) * 0.075 * gaitK;
  r.pelvis.rotation.y = -Math.sin(p) * 0.13 * gaitK;
  r.pelvis.rotation.x = 0;

  // ---- SPINE / CHEST: counter-rotate against the hips, lean into the run ----
  const runLean = clamp(A.fwd / 5, -1, 1) * (0.06 + 0.13 * runK);
  r.spine.rotation.y = Math.sin(p) * 0.15 * gaitK - A.turn * 0.22;
  r.spine.rotation.z = -clamp(A.side / 4.5, -1, 1) * 0.10 - Math.sin(p) * 0.03 * gaitK;
  r.spine.rotation.x = runLean + 0.30 * kneelK + 0.10 * crouchK - A.flinch * 0.26;

  const breatheK = (1 - amp) * (1 - kneelK);
  r.chest.rotation.x = -A.pitch * 0.26
    + Math.sin(A.breathe) * 0.016 * breatheK
    - A.fire * 0.10
    - Math.cos(p * 2) * 0.02 * gaitK;
  r.chest.rotation.y = -Math.sin(p) * 0.06 * gaitK + A.turn * 0.1;
  r.chest.rotation.z = Math.sin(p) * 0.02 * gaitK;

  // ---- NECK: eyes stay on target while the body works underneath ----
  r.neck.rotation.x = -A.pitch * 0.34 + 0.22 * kneelK - A.flinch * 0.34 - A.fire * 0.05;
  r.neck.rotation.y = -r.spine.rotation.y * 0.55 - r.chest.rotation.y * 0.4;
  r.neck.rotation.z = -r.pelvis.rotation.z * 0.5;

  // ---- ARMS: a carried rifle keeps both hands on the weapon, so the arms ride
  //      the torso instead of swinging freely. Recoil and reload move them. ----
  const rl = A.reload;
  const gunBob = Math.sin(p * 2 + 0.6) * 0.035 * gaitK;
  r.shoulderL.rotation.x = -0.55 + gunBob + A.fire * 0.10 + 0.42 * rl - 0.35 * kneelK;
  r.shoulderL.rotation.z = 0.12 * gaitK * Math.sin(p) + 0.38 * rl;
  r.elbowL.rotation.x = -0.85 - A.fire * 0.12 - 0.60 * rl;
  r.shoulderR.rotation.x = -0.55 + gunBob * 0.6 + A.fire * 0.16 - 0.18 * kneelK;
  r.shoulderR.rotation.z = -0.10 * gaitK * Math.sin(p);
  r.elbowR.rotation.x = -0.85 - A.fire * 0.10;

  // ---- WEAPON: barrel tracks the aim line, kicks on fire, dips on reload/kneel ----
  if (r.gun) {
    r.gun.rotation.x = -A.pitch * 0.55 - A.fire * 0.22 + 0.25 * rl + 0.30 * kneelK;
    r.gun.rotation.z = 0.55 * rl + 0.35 * kneelK;
    r.gun.rotation.y = -A.turn * 0.12;
    r.gun.position.y = (r.gun.userData.baseY !== undefined ? r.gun.userData.baseY : (r.gun.userData.baseY = r.gun.position.y))
      - 0.05 * rl - A.fire * 0.015;
    r.gun.position.z = (r.gun.userData.baseZ !== undefined ? r.gun.userData.baseZ : (r.gun.userData.baseZ = r.gun.position.z))
      - A.fire * 0.05;
  }
  // ---- WALL RUN: stagger the gait — wall foot plants high, trail leg drops,
  //      body tips into the wall, head and gun stay level. Scales with |wall|. ----
  if (wAbs > 0.01) {
    const wk = A.wall, wR = Math.max(0, wk), wL = Math.max(0, -wk); // wall-side weight per leg
    r.pelvis.rotation.z += wk * 0.16;
    r.pelvis.position.y += 0.05 * wAbs;
    r.spine.rotation.z -= wk * 0.12;
    r.chest.rotation.z -= wk * 0.10;
    r.neck.rotation.z -= wk * 0.14; // head counter-levels so the eyes stay flat
    // wall-side hip flexes up + out (foot meets the wall), trail leg extends down/back
    r.hipR.rotation.x += (-0.70 * wR + 0.38 * wL) * 1;
    r.hipL.rotation.x += (-0.70 * wL + 0.38 * wR) * 1;
    r.hipR.rotation.z -= 0.50 * wR; r.hipL.rotation.z += 0.50 * wL;
    r.kneeR.rotation.x = clamp(r.kneeR.rotation.x + 0.85 * wR, 0, 2.50);
    r.kneeL.rotation.x = clamp(r.kneeL.rotation.x + 0.85 * wL, 0, 2.50);
    r.ankleR.rotation.x = clamp(r.ankleR.rotation.x - 0.30 * wR, -1.40, 0.90);
    r.ankleL.rotation.x = clamp(r.ankleL.rotation.x - 0.30 * wL, -1.40, 0.90);
    // wall-side arm flares out for balance, gun-side arm pins the weapon steady
    r.shoulderL.rotation.z += 0.75 * wL; r.shoulderR.rotation.z -= 0.75 * wR;
    r.shoulderL.rotation.x -= 0.30 * wL; r.shoulderR.rotation.x -= 0.30 * wR;
    r.elbowL.rotation.x -= 0.25 * wL; r.elbowR.rotation.x -= 0.25 * wR;
    if (r.gun) { r.gun.rotation.z -= wk * 0.12; r.gun.rotation.y -= wk * 0.08; }
  }
  return struck;
}

// ---------------- View-model gun (detailed procedural) ----------------
let viewmodel = null, vmMuzzle = null, vmBase = null, vmKickG = null, vmFlashGroup = null, vmBolt = null, vmMag = null;
let vmL = null; // left-hand gun when dual wielding: { base, kick, mag, muzzle, flash }
// Iron-sight reference points: the top of the rear notch and the tip of the front
// post. The eye sits at the camera origin, so a correct sight picture means both of
// these land dead on the camera's -Z axis. VM_AIM alone can only translate the gun,
// which cannot level a sight line that is not already parallel to the view.
let vmSightRear = null, vmSightFront = null, vmStockParts = [];
const VM_AIM_SOLVED = {};
const vmRig = {
  kickZ: 0, kickV: 0, kickRot: 0, kickRotV: 0,   // spring state
  kickZL: 0, kickVL: 0, kickRotL: 0, kickRotVL: 0, // left gun (dual wield)
  roll: 0,                                         // camera roll kick (dual recoil)
  swayX: 0, swayY: 0, bobT: 0, aimK: 0, drawT: 1, landK: 0, busyK: 0,
  fovKick: 0, punchP: 0, punchY: 0, shake: 0,
  muzzleT: 0, boltT: 0,
};
const VM_HIP = new THREE.Vector3(0.24, -0.235, -0.42);
const VM_AIM = {
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

// ---------------- Gun models (profile-extruded, shared by viewmodel + world) ----------------
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
let _worldGunMats = null;
function gunMats() {
  const M = vmMats();
  M.polymer = new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.72, metalness: 0.05 });
  M.polymerL = new THREE.MeshStandardMaterial({ color: 0x45484c, roughness: 0.8, metalness: 0.05 });
  M.bakelite = new THREE.MeshStandardMaterial({ color: 0x5b2a17, roughness: 0.55, metalness: 0.05 });
  M.blued = new THREE.MeshStandardMaterial({ color: 0x3b3e44, roughness: 0.42, metalness: 0.55 });
  M.awpGreen = new THREE.MeshStandardMaterial({ color: 0x4f6b3c, roughness: 0.7, metalness: 0.05 });
  M.magClear = new THREE.MeshStandardMaterial({ color: 0x55554c, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.35, depthWrite: false });
  M.glowR = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
  M.sleeve = new THREE.MeshStandardMaterial({ color: 0x3d4654, roughness: 0.95 });
  M.gloveK = new THREE.MeshStandardMaterial({ color: 0x3a3630, roughness: 0.85 });
  return M;
}
// Build `key` into `root`; magazine parts go into `magG` (so reloads can drop them).
function buildGunModel(key, M, root, magG, opts = {}) {
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
  }
  if (opts.hands) buildGunHands(key, M, root);
  return out;
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
function buildGunHands(key, M, root) {
  if (key === 'ak') { vmGripHand(root, M, -0.03, -0.05, 0.42); vmSupportHand(root, M, 0.55, -0.045, 0.031); }
  else if (key === 'p90') { vmGripHand(root, M, 0.005, -0.075, 0.2); vmSupportHand(root, M, 0.2, -0.13, 0.033); }
  else if (key === 'deagle') { vmGripHand(root, M, -0.02, -0.055, 0.3); const s = vmSupportHand(root, M, 0.0, -0.14, 0.03); s.rotation.set(0.3, 0, -0.35); s.position.x = -0.02; }
  else if (key === 'awp') { vmGripHand(root, M, 0.03, -0.06, 0.4); vmSupportHand(root, M, 0.42, -0.048, 0.031); }
}
// Third-person weapon on soldiers (bots + online players)
function setSoldierGun(mesh, key) {
  const ud = mesh && mesh.userData; if (!ud) return;
  const gunG = ud.gunG || ud.gun || (ud.rig && ud.rig.gun);
  if (!gunG || !WEAPONS[key] || gunG.userData.model === key) return;
  if (!_worldGunMats) _worldGunMats = gunMats();
  for (let i = gunG.children.length - 1; i >= 0; i--) gunG.remove(gunG.children[i]);
  const holder = new THREE.Group(); holder.rotation.y = Math.PI; holder.scale.setScalar(0.85); holder.position.z = 0.02;
  gunG.add(holder);
  buildGunModel(key, _worldGunMats, holder, holder, { world: true });
  holder.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  gunG.userData.model = key;
}

function buildViewmodel(key) {
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
  weapons: { ak: { owned: false, mag: 0, reserve: 0 }, deagle: { owned: true, mag: 7, reserve: 35 }, awp: { owned: false, mag: 5, reserve: 0 }, p90: { owned: false, mag: 0, reserve: 0 } },
  cur: 'deagle', last: 'ak', reloading: 0, reloadDur: 1, nextShot: 0,
  aiming: false, respawnAt: 0, radius: 0.45, lastDmgDir: 0,
  crouching: false, crouch: 0, // held (or toggled) with C; crouch is the 0..1 blend
  useQueued: false, nextShotL: 0, // E press edge (pickup) · left-gun cooldown (dual wield)
  airTuck: false,               // crouched mid-air (feet lifted by CROUCH_JUMP_LIFT)
  wallRun: null,                // { t, nx, nz, side, box } while running on a wall
  wallCd: 0, lastWallBox: null, wallRoll: 0, spaceWas: false,
  kills: 0, deaths: 0, assists: 0,
  // gunplay state: bloom heat + spray index + recoverable punch + shake
  bloom: 0, sprayIdx: 0, lastShotT: -9,
  // spectate-after-death state (bot ref + camera mode)
  specTarget: null, specMode: 'chase', // 'first' | 'chase'
  // tactical grenades: counts per round (CS: rebuy each round, no carry-over for dead)
  nades: { he: 0, flash: 0, smoke: 0, molotov: 0 },
  cook: null, // {type, lmb, rmb, heldT} pin pulled — throw on release (LMB far, RMB short, both medium)
  flashUntil: 0, flashMax: 0, // white-out blindness (performance-time seconds)
  burnT: 0, // last molotov burn tick overlay
};

const bots = [];
const keys = {};
let pointerLocked = false;

// ---------------- Scoreboard stats (K/A/D per match) ----------------
// ponytail: assists = previous damager within 5s of kill, no per-hit ledger.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const remoteStats = new Map(); // netId -> {kills,deaths,assists,name,team}
function shooterId(s) {
  if (!s) return 'unknown';
  if (s.isPlayer) return 'you';
  if (s.bot) return 'bot:' + s.bot.team + ':' + s.bot.idx;
  const rid = (s.remote && s.remote.data && s.remote.data.id) ?? s.remoteId ?? null;
  if (rid !== null && rid !== undefined) return 'remote:' + rid;
  return 'unknown';
}
function statsHolder(id) {
  if (id === 'you') return player;
  if (id && id.startsWith('bot:')) {
    const [, team, idx] = id.split(':');
    return bots.find((b) => b.team === team && String(b.idx) === String(idx)) || null;
  }
  if (id && id.startsWith('remote:')) {
    const rid = +id.slice(7);
    if (!remoteStats.has(rid)) remoteStats.set(rid, { kills: 0, deaths: 0, assists: 0, name: '', team: '' });
    return remoteStats.get(rid);
  }
  return null;
}
function noteDamage(victim, shooter) {
  try {
    const id = shooterId(shooter);
    if (id === 'unknown') return;
    const now = performance.now() / 1000;
    if (victim._lastId && victim._lastId !== id && (now - (victim._lastT || 0)) < 5) {
      victim._assistId = victim._lastId; victim._assistT = victim._lastT;
    }
    victim._lastId = id; victim._lastT = now;
  } catch {}
}
function awardAssist(victim, killerId) {
  try {
    const now = performance.now() / 1000;
    const aid = victim._assistId;
    if (!aid || aid === killerId || (now - (victim._assistT || 0)) > 5) return;
    const h = statsHolder(aid);
    if (h) h.assists = (h.assists | 0) + 1;
  } catch {}
}
// ponytail: shared get-or-create lives in statsHolder, no local copies.
function creditKill(shooter) {
  // kills++ for killer bot/remote, deaths++ handled by caller victim.
  try {
    if (!shooter || shooter.isPlayer || shooter.suicide) return;
    if (shooter.bot) { shooter.bot.kills = (shooter.bot.kills | 0) + 1; return; }
    const h = statsHolder(shooterId(shooter));
    if (h) h.kills = (h.kills | 0) + 1;
  } catch {}
}

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
  try { setSoldierGun(mesh, WEAPONS[r.weapon] ? r.weapon : 'ak'); } catch (e) {}
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

function remoteEye(e) { return new THREE.Vector3(e.pos.x, e.pos.y + 1.55 - CROUCH_EYE_DROP * (e.crouchK || 0), e.pos.z); }
function remoteChest(e) { return new THREE.Vector3(e.pos.x, e.pos.y + 1.1 - 0.36 * (e.crouchK || 0), e.pos.z); }

const _remSample = {};
function updateRemoteMeshes(dt, t) {
  syncRemoteMeshes();
  const nowMs = performance.now();
  for (const [id, e] of remotes) {
    const r = Net.remotes.get(id);
    if (!r) continue;
    e.data = r;
    try { if (WEAPONS[r.weapon]) setSoldierGun(e.mesh, r.weapon); } catch (err) {}
    try { setSoldierDual(e.mesh, r.weapon, !!r.dual && !!r.alive); } catch (err) {}
    // Buffered snapshot interpolation (net.js): exact, jitter-free motion at any frame rate,
    // rendered a few tens of ms in the past. Hit tests use e.pos, i.e. what you actually see.
    const smp = Net.sample(r, nowMs, _remSample);
    e.targetPos.set(r.x || 0, r.y || 0, r.z || 0);
    if (r.alive || !e.fall) e.pos.set(smp.x, smp.y, smp.z);
    e.yaw = smp.yaw; e.pitch = smp.pitch;
    e.targetYaw = r.yaw || 0;
    const m = e.mesh;
    m.position.copy(e.pos);
    // Face movement model uses same yaw convention as bots (atan2(dx,dz)).
    m.rotation.y = e.yaw + Math.PI;
    // Walk anim when moving.
    const moving = !!r.moving || Math.hypot(e.vx || 0, e.vz || 0) > 0.4;
    if (moving) e.walkPhase += dt * 9;
    const sw = moving ? Math.sin(e.walkPhase) * 0.5 : 0;
    try {
      // revive: round reset — restore head/helmet/limbs cleared by goreRemoteDeath
      if (r.alive && (e.fall || e.headless)) {
        try { restoreSoldierMesh(m); } catch (err) {}
        e.fall = null; e.knock = null; e.deathPos = null; e.deathT = 0; e.headless = false; e._thudded = false;
        m.rotation.set(0, e.yaw + Math.PI, 0);
      }
      // Dead => momentum ragdoll like bots (fall away from killer, limbs sprawl).
      if (!r.alive) {
        // snapshot-only death (blast / suicide with no 'killed' gore yet): generic fall + pool
        if (!e.fall) {
          try {
            e.fall = pickFallParams(e.pos, null, 1);
            e.deathPos = e.pos.clone();
            e.knock = new THREE.Vector3(rand(-0.4, 0.4), 0, rand(-0.4, 0.4));
            e.deathT = 0; e._thudded = false; e.headless = false;
            spawnBloodPool(e.pos.x, e.pos.z, true);
            poseCorpseLimbs(m, e.fall.sprawl, e.fall.power);
          } catch (err) {}
        }
        e.deathT = Math.min(1.6, (e.deathT || 0) + dt);
        updateRagdoll(m, dt);
        const { k: dk, e: dease } = corpseK(e.deathT);
        const ef = e.fall || { dirX: 0, dirZ: 1, spin: 0, roll: 0, power: 1 };
        try {
          if (e.deathPos && e.knock) {
            m.position.set(
              e.deathPos.x + e.knock.x * dease,
              Math.max(0.05, e.deathPos.y + Math.sin(Math.min(1, dk * 1.3) * Math.PI) * 0.10 * (ef.power || 1) * (1 - dk)),
              e.deathPos.z + e.knock.z * dease
            );
            try { slideCorpseOut(m, 0.5); } catch (err) {}
            e.pos.set(m.position.x, e.deathPos.y, m.position.z);
          } else {
            m.position.y = Math.max(0.2, m.position.y);
          }
          const baseYaw = (e.yaw || 0) + Math.PI;
          const fX = Math.sin(baseYaw), fZ = Math.cos(baseYaw);
          const fDot = (ef.dirX || 0) * fX + (ef.dirZ || 0) * fZ;
          const sDot = (ef.dirX || 0) * fZ - (ef.dirZ || 0) * fX;
          const tip = Math.PI / 2 * 0.95;
          m.rotation.x = (fDot >= 0 ? tip : -tip) * (0.75 + Math.abs(fDot) * 0.45) * dease;
          m.rotation.z = clamp(-sDot * tip * 0.9 + (ef.roll || 0), -1.2, 1.2) * dease;
          m.rotation.y = baseYaw + (ef.spin || 0) * dease;
          if (e.headless && e.deathT < 0.9 && Math.random() < dt * 14) {
            try { spawnBurst(new THREE.Vector3(e.pos.x, 1.0 - dease * 0.75, e.pos.z), 0xa00d10, 2, 1.6, 0.4, 0.08); } catch (err) {}
          }
          if (!e._thudded && dk >= 1) {
            e._thudded = true;
            try { spawnSmoke(new THREE.Vector3(e.pos.x, 0.25, e.pos.z), 0.7, 0.9, 0xbfae8e); } catch (err) {}
          }
        } catch (err) {}
        m.visible = !(player.specTarget && player.specTarget.__remoteId === id && player.specMode === 'first' && !player.alive);
      } else {
        // alive: walk swing + gun pitch + ease back upright from any old tip
        try {
          // Full rig: gait comes from how fast the interpolated position is actually
          // moving, so a remote walks, runs and backpedals like a local bot.
          m.position.y = e.pos.y;
          const inv = dt > 1e-4 ? 1 / dt : 0;
          e.vx = damp(e.vx || 0, (e.pos.x - (e.prevX !== undefined ? e.prevX : e.pos.x)) * inv, 14, dt);
          e.vz = damp(e.vz || 0, (e.pos.z - (e.prevZ !== undefined ? e.prevZ : e.pos.z)) * inv, 14, dt);
          e.prevX = e.pos.x; e.prevZ = e.pos.z;
          e.crouchK = damp(e.crouchK || 0, r.crouch ? 1 : 0, 11, dt);
          const wallSide = r.wr ? Math.sign(r.wr) : 0;
          animateSoldier(m, {
            vx: e.vx, vz: e.vz, yaw: m.rotation.y, pitch: -(e.pitch !== undefined ? e.pitch : (r.pitch || 0)),
            grounded: r.gnd !== undefined ? (!!r.gnd || !!wallSide) : (r.y || 0) < 0.06, crouch: !!r.crouch,
            kneel: !!r.planting || !!r.defusing, reloading: !!r.reloading, wall: wallSide,
          }, dt, t);
        } catch (err) {}
        if (Math.abs(m.rotation.x) > 0.01) m.rotation.x *= Math.max(0, 1 - dt * 6);
        // wall run: lean the body into the wall (tip recovery decays the same channel otherwise)
        e.wallLean = damp(e.wallLean || 0, (r.wr ? Math.sign(r.wr) : 0) * WALLRUN.bodyLean, 10, dt);
        e.wallRoll = damp(e.wallRoll || 0, (r.wr ? Math.sign(r.wr) : 0) * WALLRUN.camRoll, 10, dt);
        if (Math.abs(e.wallLean) > 0.005) m.rotation.z = e.wallLean;
        else if (Math.abs(m.rotation.z || 0) > 0.01) m.rotation.z *= Math.max(0, 1 - dt * 6);
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
    try { applyServerScore(m); if (typeof m.round === 'number' && m.round > 0 && G.phase !== 'playing') G.round = m.round; } catch {}
    announce(`ONLINE AS ${player.team.toUpperCase()} — ${player.name}`, 1800);
    refreshBotsForMP();
    updateMPStatus();
    // Re-spawn on our team's side with the new team.
    if (G.phase === 'playing') {
      try {
        const team = player.team || 'ct';
        player.pos.copy(spawnPoint(team, mySpawnSlot())); player.yaw = spawnYawPlayer(team, player.pos);
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
      spawnTracer(from, end, m.tracer || 0xff9a5c);
      spawnWorldFlash(from, m.tracer || 0xff9a5c, m.sound === 'sniper' ? 1.5 : 0.85);
      AudioSys.shoot(m.sound || 'rifle', from);
      if (e) { e.flashAt = performance.now() / 1000 + 0.05; soldierFireKick(e.mesh, 0.85); }
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
      if (m.fromId != null && !e) return; // unknown sender — drop forged hits
      const shooter = {
        isPlayer: false, team: m.fromTeam || (e ? e.data.team : 't'),
        bot: null, remote: e || null,
        remoteName: m.fromName || (e ? e.data.name : 'Enemy'),
        remotePos: e ? e.pos.clone() : null,
        weaponName: m.weapon || 'AK-47',
      };
      let dmg = Number(m.dmg);
      if (!isFinite(dmg)) return;
      dmg = clamp(dmg, 0, 100); // per-hit cap — no remote one-shots via spoofed dmg
      damagePlayer(dmg, shooter, !!m.head);
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
      const wasAlive = !!(e && e.data.alive);
      if (e) {
        e.data.alive = false; e.data.hp = 0;
        // gore: head-pop / ragdoll on the victim's mesh, directed away from the killer
        try {
          let sdir = null;
          if (m.killerId === Net.id && typeof camera !== 'undefined' && camera) {
            sdir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
          } else if (m.killerId != null && remotes.get(m.killerId)) {
            const k = remotes.get(m.killerId);
            sdir = new THREE.Vector3(e.pos.x - k.pos.x, 0, e.pos.z - k.pos.z);
            if (sdir.lengthSq() < 0.01) sdir.set(rand(-1, 1), 0, rand(-1, 1));
            sdir.normalize();
          }
          goreRemoteDeath(e, !!m.head, m.weapon || 'AK-47', sdir);
        } catch (err) {}
      }
      addKillfeed(m.killerName || '???', m.killerTeam || 't', m.victimName || '???', m.victimTeam || 'ct', m.weapon || 'AK-47', !!m.head);
      try {
        if (m.killerId !== null && m.killerId !== undefined && m.killerId !== Net.id) statsHolder('remote:' + m.killerId).kills++;
        if (m.victimId !== null && m.victimId !== undefined && m.victimId !== Net.id) statsHolder('remote:' + m.victimId).deaths++;
      } catch {}
      if (m.killerId === Net.id) {
        if (!wasAlive) return;
        G.kills++; player.kills++; addMoney(MONEY_KILL); playerHitmark(m.head, true);
        AudioSys.kill();
        if (m.head) announce('HEADSHOT +$' + MONEY_KILL, 700);
        try { updateHUD(); } catch {}
      }
      try { if (scoreboardVisible()) renderScoreboard(); } catch {}
      checkRoundEnd();
    } catch {}
  });

  Net.on('bomb', (m) => {
    try { applyRemoteBomb(m); } catch (e) { console.warn('bomb msg', e); }
  });
  Net.on('round', (m) => {
    try { applyRemoteRound(m); } catch (e) { console.warn('round msg', e); }
  });
  Net.on('round_echo', (m) => {
    try { applyServerScore(m); } catch (e) { console.warn('round echo', e); }
  });
  Net.on('nade', (m) => {
    try { applyRemoteNade(m); } catch (e) { console.warn('nade msg', e); }
  });
  Net.on('weapon', (m) => {
    try { applyRemoteWeapon(m); } catch (e) { console.warn('weapon msg', e); }
  });
}
function applyRemoteNade(m) {
  if (G.phase !== 'playing') return;
  const t = performance.now() / 1000;
  if (m.fromId != null && !remotes.get(m.fromId)) return; // unknown sender
  const owner = {
    isPlayer: false, team: m.fromTeam || 't',
    bot: null, remoteName: m.fromName || ('Player' + (m.fromId ?? '?')),
    remoteId: m.fromId ?? null, weaponName: (NADE_DEFS[m.nade] || {}).name || 'GRENADE',
  };
  // Host-relayed bot utility (solo-with-guests spectating): attribute to a display name.
  if (m.botShort) owner.remoteName = `${m.botShort} (BOT)`;
  const inMap = (x, y, z) => isFinite(x) && isFinite(y) && isFinite(z) && Math.abs(x) <= MAP_HALF + 6 && Math.abs(z) <= MAP_HALF + 6 && y >= -1 && y <= 12;
  if (m.action === 'throw' && NADE_DEFS[m.nade]) {
    const ox = +m.x || 0, oy = +m.y || 1.4, oz = +m.z || 0;
    const vx = +m.vx || 0, vy = +m.vy || 0, vz = +m.vz || 0;
    if (!inMap(ox, oy, oz)) return;
    const origin = new THREE.Vector3(ox, oy, oz);
    const vel = new THREE.Vector3(vx, vy, vz);
    if (!isFinite(vel.x + vel.y + vel.z) || vel.length() > 32) return;
    if (vel.lengthSq() < 0.01) vel.set(0, 2, 0);
    let fuse = +m.fuse || NADE_DEFS[m.nade].fuse;
    if (!isFinite(fuse)) return;
    fuse = clamp(fuse, 0.2, NADE_DEFS[m.nade].fuse + 1.0);
    throwNade(m.nade, origin, vel, owner, fuse, true);
  } else if (m.action === 'boom') {
    // in-hand cook from a remote player — detonate at the broadcast position
    const ax = +m.x || 0, ay = +m.y || 1.3, az = +m.z || 0;
    if (!inMap(ax, ay, az)) return;
    const at = new THREE.Vector3(ax, ay, az);
    if (m.nade === 'he') detonateHE(at, owner, t, true);
    else if (m.nade === 'flash') detonateFlash(at, owner, t, true);
    else if (m.nade === 'smoke') deploySmoke(at, owner, t);
    else if (m.nade === 'molotov') igniteMolotov(at, owner, t);
  }
}

function updateMPStatus() {
  if (!mpStatusEl) mpStatusEl = document.getElementById('mp-status');
  if (!mpStatusEl) return;
  // Short on purpose: it sits under the minimap.
  if (!Net.active) { mpStatusEl.textContent = 'OFFLINE · BOTS'; mpStatusEl.className = 'offline'; mpStatusEl.title = 'Solo vs bots'; }
  else if (Net.hasRealOpponents) {
    mpStatusEl.textContent = `ONLINE · ${Net.realPlayers}P · PVP`;
    mpStatusEl.className = 'online pvp'; mpStatusEl.title = 'Real players online — bots disabled';
  } else {
    mpStatusEl.textContent = 'ONLINE · WAITING · BOTS';
    mpStatusEl.className = 'online solo'; mpStatusEl.title = 'Alone on server — bots active until players join';
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
    // ragged blob: a wobbly polygon reads as spilled liquid, a circle reads as a dot
    const lobe = (cx, cy, r, alpha) => {
      g.fillStyle = `rgba(${94 + Math.random() * 48 | 0},${5 + Math.random() * 9 | 0},${7 + Math.random() * 9 | 0},${alpha})`;
      g.beginPath();
      for (let i = 0, n = 14; i <= n; i++) {
        const th = (i / n) * Math.PI * 2, rr = r * (0.6 + Math.random() * 0.65);
        const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill();
    };
    lobe(64, 60, 40, 0.95); lobe(56, 68, 31, 0.9); lobe(73, 55, 27, 0.85);
    // runs, so a wall splat drips (spawnDecal keeps vertical surfaces upright)
    for (let i = 0; i < 8; i++) {
      const x = 30 + Math.random() * 66, w = 2 + Math.random() * 6, len = 12 + Math.random() * 46;
      g.fillStyle = `rgba(${88 + Math.random() * 42 | 0},6,8,${0.5 + Math.random() * 0.4})`;
      g.fillRect(x, 66, w, len);
      g.beginPath(); g.arc(x + w / 2, 66 + len, w * 0.8, 0, 7); g.fill();
    }
    // satellite droplets thrown clear of the main mass
    for (let i = 0; i < 44; i++) {
      const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 32;
      lobe(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 2 + Math.random() * 7, 0.5 + Math.random() * 0.45);
    }
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      g.strokeStyle = 'rgba(120,9,11,0.6)'; g.lineWidth = 1 + Math.random() * 2.6;
      g.beginPath(); g.moveTo(64, 64);
      g.lineTo(64 + Math.cos(a) * (40 + Math.random() * 24), 64 + Math.sin(a) * (40 + Math.random() * 24));
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
const _decalMats = new Map();
function decalMaterial(kind, tex, opacity) {
  const o = clamp(Math.round(opacity * 5) / 5, 0.2, 1);
  const key = kind + '|' + o;
  let m = _decalMats.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, opacity: o,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    _decalMats.set(key, m);
  }
  return m;
}
function spawnDecal(kind, pos, normal, size = 0.3, opacity = 1) {
  try {
    const T = decalTextures();
    const tex = kind === 'blood' ? T.blood : kind === 'scorch' ? T.scorch : T.hole;
    const mat = decalMaterial(kind, tex, kind === 'scorch' ? 0.95 * opacity : opacity);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    m.position.copy(pos).addScaledVector(normal, 0.02 + Math.random() * 0.012);
    // orient plane to surface: plane +z faces along normal
    m.lookAt(pos.clone().add(normal));
    // on a wall, keep the texture upright so its runs point down; on the floor the
    // orientation is arbitrary, so spin it to hide the repeated texture
    const upright = kind === 'blood' && Math.abs(normal.y) < 0.55;
    m.rotation.z = upright ? rand(-0.35, 0.35) : Math.random() * Math.PI * 2;
    m.renderOrder = 2;
    scene.add(m);
    decals.push({ mesh: m, kind });
    // recycle oldest: bullet holes cap high (combat memory), blood/scorch lower
    const cap = kind === 'hole' ? 90 : kind === 'blood' ? goreCap(45) : 12;
    let count = 0;
    for (const d of decals) if (d.kind === kind) count++;
    if (count > cap) {
      const idx = decals.findIndex((d) => d.kind === kind);
      if (idx >= 0) { const old = decals.splice(idx, 1)[0]; scene.remove(old.mesh); old.mesh.geometry.dispose(); } // material is shared
    }
  } catch (e) {}
}
function spawnBloodPool(x, z, big = false) {
  if (!SET.gore) return;
  try {
    const T = decalTextures();
    const s = (big ? 2.2 : 1.4) * (0.85 + Math.random() * 0.4);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s * (0.8 + Math.random() * 0.4)),
      decalMaterial('blood', T.blood, 0.92));
    m.rotation.x = -Math.PI / 2; m.rotation.z = Math.random() * Math.PI * 2;
    m.position.set(x + rand(-0.2, 0.2), 0.028, z + rand(-0.2, 0.2));
    m.renderOrder = 2;
    scene.add(m);
    decals.push({ mesh: m, kind: 'blood' });
    if (decals.filter((d) => d.kind === 'blood').length > goreCap(45)) {
      const idx = decals.findIndex((d) => d.kind === 'blood');
      const old = decals.splice(idx, 1)[0]; scene.remove(old.mesh); old.mesh.geometry.dispose();
    }
  } catch (e) {}
}
function clearDecals() {
  // materials are shared via decalMaterial() — geometry only
  for (const d of decals) { try { scene.remove(d.mesh); d.mesh.geometry.dispose(); } catch (e) {} }
  decals.length = 0;
}

// ---------------- Gore: ragdolls, exploding heads, gibs ----------------
// Design: corpses stay whole — bullets don't dismember torsos. Only the hit
// part detaches (head pops, limb tears), rest flings along shot dir.
// Full dismemberment is explosives-only (HE/C4). Counts kept low on purpose.
const gibs = []; // {mesh, vel, ang, life, restY, bounced, bloodAt, helmet, flesh}
let _gibMats = null;
function gibMats() {
  if (_gibMats) return _gibMats;
  _gibMats = {
    flesh: new THREE.MeshStandardMaterial({ color: 0x8a1214, roughness: 0.55 }),
    fleshD: new THREE.MeshStandardMaterial({ color: 0x5d0b0d, roughness: 0.7 }),
    bone: new THREE.MeshStandardMaterial({ color: 0xe8ddc4, roughness: 0.6 }),
    brain: new THREE.MeshStandardMaterial({ color: 0xd98a94, roughness: 0.45 }),
    helmetCT: new THREE.MeshStandardMaterial({ color: 0x1d2f45, roughness: 0.75 }),
    helmetT: new THREE.MeshStandardMaterial({ color: 0x6b5a35, roughness: 0.75 }),
    clothCT: new THREE.MeshStandardMaterial({ color: 0x2e4a6e, roughness: 0.95 }),
    clothT: new THREE.MeshStandardMaterial({ color: 0x8a6f42, roughness: 0.95 }),
  };
  return _gibMats;
}
function clearGibs() {
  for (const gib of gibs) {
    try { scene.remove(gib.mesh); } catch (e) {}
    try { gib.mesh.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); } catch (e) {
      try { if (gib.mesh.geometry) gib.mesh.geometry.dispose(); } catch (e2) {}
    }
    // materials are shared via gibMats() — do not dispose
  }
  gibs.length = 0;
  // hide neck stumps parented to corpses (reused next round via userData.stump)
  try {
    for (const b of bots) {
      if (b.mesh && b.mesh.userData && b.mesh.userData.stump) {
        try { b.mesh.userData.stump.visible = false; } catch (e) {}
      }
    }
    for (const [, e] of remotes) {
      if (e.mesh && e.mesh.userData && e.mesh.userData.stump) {
        try { e.mesh.userData.stump.visible = false; } catch (err) {}
      }
    }
  } catch (e) {}
}
function capGibs() {
  const cap = Math.min(300, goreCap(opts.quality ? 46 : 20));
  while (gibs.length > cap) {
    const old = gibs.shift();
    try { scene.remove(old.mesh); } catch (e) {}
    try { old.mesh.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); } catch (e) {
      try { if (old.mesh.geometry) old.mesh.geometry.dispose(); } catch (e2) {}
    }
  }
}
function spawnGibMesh(mesh, pos, vel, go = {}) {
  mesh.position.copy(pos);
  try { mesh.traverse((o) => { if (o.isMesh) o.castShadow = true; }); } catch (e) { mesh.castShadow = true; }
  scene.add(mesh);
  // rigid body state: point mass with radius, restitution + surface friction.
  // Wall/ground contacts resolve in updateGibs via gibCollide.
  gibs.push({
    mesh,
    vel: vel.clone(),
    ang: go.ang ? go.ang.clone() : new THREE.Vector3(rand(-11, 11), rand(-11, 11), rand(-11, 11)),
    life: 30, // persist to round end; startRound clears
    restY: go.restY !== undefined ? go.restY : 0.09,
    radius: go.radius !== undefined ? go.radius : 0.14,
    rest: go.rest !== undefined ? go.rest : 0.35, // bounciness 0..1
    fric: go.fric !== undefined ? go.fric : 0.7, // surface friction on contact
    bounced: 0,
    bloodAt: 0,
    flesh: !!go.flesh,
    helmet: !!go.helmet,
    silent: !!go.silent,
  });
  capGibs();
  return mesh;
}
// Rigid-body contact: push a sphere (p, radius) out of world AABBs.
// Reflects velocity on the hit axis with restitution, kills the rest with
// friction. Returns true on contact. ponytail: AABB-only, no stacking.
function gibCollide(p, vel, radius, rest, fric) {
  let hit = false;
  for (const b of colliders) {
    const cx = clamp(p.x, b.min.x, b.max.x);
    const cy = clamp(p.y, b.min.y, b.max.y);
    const cz = clamp(p.z, b.min.z, b.max.z);
    const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= radius * radius) continue;
    hit = true;
    const d = Math.sqrt(d2);
    if (d > 1e-5) {
      const nx = dx / d, ny = dy / d, nz = dz / d;
      p.x = cx + nx * radius; p.y = cy + ny * radius; p.z = cz + nz * radius;
      const vn = vel.x * nx + vel.y * ny + vel.z * nz;
      if (vn < 0) {
        vel.x -= (1 + rest) * vn * nx;
        vel.y -= (1 + rest) * vn * ny;
        vel.z -= (1 + rest) * vn * nz;
        vel.x *= (1 - fric * 0.4); vel.z *= (1 - fric * 0.4); vel.y *= (1 - fric * 0.2);
      }
    } else {
      // center inside box: pop out along smallest penetration axis
      const px = Math.min(p.x - b.min.x, b.max.x - p.x);
      const py = Math.min(p.y - b.min.y, b.max.y - p.y);
      const pz = Math.min(p.z - b.min.z, b.max.z - p.z);
      if (px <= py && px <= pz) { p.x = (p.x - b.min.x < b.max.x - p.x) ? b.min.x - radius : b.max.x + radius; vel.x *= -rest; }
      else if (py <= px && py <= pz) { p.y = (p.y - b.min.y < b.max.y - p.y) ? b.min.y - radius : b.max.y + radius; vel.y *= -rest; }
      else { p.z = (p.z - b.min.z < b.max.z - p.z) ? b.min.z - radius : b.max.z + radius; vel.z *= -rest; }
      vel.x *= (1 - fric * 0.3); vel.z *= (1 - fric * 0.3);
    }
  }
  return hit;
}
// directional arterial spray: red particles + dark mist + ground spatter along shot dir
function spawnBloodSpray(pos, dir, power = 1) {
  if (!SET.gore) return;
  try {
    const n = opts.quality ? Math.round(10 * power) + 6 : 6;
    spawnBurst(pos, 0xb00000, n, 4.5 * power, 0.5, 0.09);
    spawnBurst(pos, 0x7a0a0c, Math.max(3, n >> 1), 2.4 * power, 0.7, 0.12);
    const mist = pos.clone();
    if (dir) mist.addScaledVector(dir, 0.5);
    mist.y = Math.max(0.3, mist.y - 0.15);
    spawnSmoke(mist, 0.3 * power, 0.7, 0x8a1518);
    // fling a few physical blood-flesh droplets that arc and stain where they land
    const droplets = opts.quality ? Math.round(2 * power) : 1;
    for (let i = 0; i < droplets; i++) {
      const m = gibMats();
      const chunk = new THREE.Mesh(
        new THREE.BoxGeometry(rand(0.05, 0.1), rand(0.04, 0.08), rand(0.05, 0.1)),
        Math.random() < 0.5 ? m.flesh : m.fleshD
      );
      const v = new THREE.Vector3(rand(-1, 1), rand(0.4, 1.4), rand(-1, 1)).normalize()
        .multiplyScalar(rand(2, 4.5 * power));
      if (dir) v.addScaledVector(dir, rand(1, 3 * power));
      v.y += rand(1, 2.5 * power);
      spawnGibMesh(chunk, pos, v, { flesh: true, restY: 0.05 });
    }
  } catch (e) {}
}
// skull + brain + helmet explosion at head position. Hides headParts on the corpse,
// adds a bleeding neck stump, launches helmet as a clattering projectile.
function explodeHead(mesh, headWorldPos, shotDir, power = 1, team = 't') {
  if (!SET.gore) return;
  try {
    const ud = mesh.userData || {};
    const parts = ud.headParts || (ud.head ? [ud.head] : []);
    for (const p of parts) { try { if (p) p.visible = false; } catch (e) {} }
    // neck stump so the corpse doesn't look hollow
    try {
      if (!ud.stump) {
        const stump = new THREE.Mesh(
          new THREE.CylinderGeometry(0.09, 0.11, 0.16, 8),
          new THREE.MeshStandardMaterial({ color: 0x6d0d0f, roughness: 0.6 })
        );
        const host = (ud.rig && ud.rig.neck) || mesh;
        stump.position.set(0, host === mesh ? 1.58 : 0.02, 0);
        host.add(stump);
        ud.stump = stump;
      } else {
        ud.stump.visible = true;
      }
    } catch (e) {}
    const M = gibMats();
    // red mist core + brain-matter burst + bone shards (kept small: head only)
    spawnBurst(headWorldPos, 0xc01418, opts.quality ? 12 : 6, 5 * power, 0.6, 0.11);
    spawnBurst(headWorldPos, 0xff6a6a, opts.quality ? 5 : 2, 3 * power, 0.5, 0.09);
    spawnSmoke(headWorldPos.clone().add(new THREE.Vector3(0, 0.15, 0)), 0.4 * power, 0.8, 0x7a0f12);
    // skull shards (pale) + brain blobs (pink) as tumbling physics
    const nBone = opts.quality ? 3 : 2, nBrain = opts.quality ? 3 : 2;
    for (let i = 0; i < nBone; i++) {
      const s = rand(0.04, 0.09);
      const shard = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.6, s * 0.8), M.bone);
      const v = new THREE.Vector3(rand(-1, 1), rand(0.5, 1.5), rand(-1, 1)).normalize().multiplyScalar(rand(2.5, 6 * power));
      if (shotDir) v.addScaledVector(shotDir, rand(1.5, 4 * power));
      v.y += rand(1.5, 3.5);
      spawnGibMesh(shard, headWorldPos, v, { flesh: true, restY: 0.04 });
    }
    for (let i = 0; i < nBrain; i++) {
      const s = rand(0.06, 0.12);
      const blob = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.8, s), M.brain);
      const v = new THREE.Vector3(rand(-1, 1), rand(0.2, 1.2), rand(-1, 1)).normalize().multiplyScalar(rand(2, 5 * power));
      if (shotDir) v.addScaledVector(shotDir, rand(1, 3 * power));
      v.y += rand(1, 3);
      spawnGibMesh(blob, headWorldPos, v, { flesh: true, restY: 0.05 });
    }
    // flesh slabs from the scalp/jaw
    for (let i = 0; i < (opts.quality ? 2 : 1); i++) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(rand(0.07, 0.13), rand(0.05, 0.09), rand(0.07, 0.12)), M.flesh);
      const v = new THREE.Vector3(rand(-1, 1), rand(0.4, 1.3), rand(-1, 1)).normalize().multiplyScalar(rand(2.5, 5.5 * power));
      if (shotDir) v.addScaledVector(shotDir, rand(1.5, 3.5 * power));
      v.y += rand(1.2, 3);
      spawnGibMesh(slab, headWorldPos, v, { flesh: true, restY: 0.06 });
    }
    // helmet launches separately — spins, bounces, clatters
    try {
      const helm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.18, 0.42), team === 'ct' ? M.helmetCT : M.helmetT);
      const hv = new THREE.Vector3(rand(-1, 1), 1, rand(-1, 1)).normalize().multiplyScalar(rand(3, 5.5 * power));
      if (shotDir) hv.addScaledVector(shotDir, rand(2, 4.5 * power));
      hv.y += rand(2.5, 4.5);
      spawnGibMesh(helm, headWorldPos.clone().add(new THREE.Vector3(0, 0.25, 0)), hv, { helmet: true, restY: 0.1 });
    } catch (e) {}
    // ground gore: big pool + spatter along shot dir
    try {
      spawnBloodPool(headWorldPos.x, headWorldPos.z, true);
      const d = shotDir ? shotDir.clone().setY(0).normalize() : new THREE.Vector3(1, 0, 0);
      for (let i = 0; i < 3; i++) {
        spawnDecal('blood',
          new THREE.Vector3(headWorldPos.x + d.x * (0.8 + i * 0.7) + rand(-0.4, 0.4), 0.06, headWorldPos.z + d.z * (0.8 + i * 0.7) + rand(-0.4, 0.4)),
          new THREE.Vector3(0, 1, 0), 0.9 + Math.random() * 0.7, 0.6);
      }
    } catch (e) {}
    try { AudioSys.headpop(headWorldPos); } catch (e) {}
  } catch (e) {}
}
// Hide the struck limb on the corpse and return its joint group (null = torso
// chunk, nothing to hide). A flesh stump cap covers the socket.
function detachLimb(mesh, part) {
  try {
    const ud = mesh && mesh.userData, rg = ud && ud.rig;
    if (!rg) return null;
    let joint = null;
    if (part === 'leg') joint = Math.random() < 0.5 ? rg.hipL : rg.hipR;
    else if (part === 'arm') joint = Math.random() < 0.5 ? rg.shoulderL : rg.shoulderR;
    if (!joint) return null;
    joint.visible = false;
    try {
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.1, 0.14),
        new THREE.MeshStandardMaterial({ color: 0x6d0d0f, roughness: 0.6 })
      );
      cap.position.copy(joint.position);
      (joint.parent || mesh).add(cap);
      (ud.stumps || (ud.stumps = [])).push(cap);
    } catch (e) {}
    return joint;
  } catch (e) { return null; }
}
// Build an anatomical detached part: leg (thigh+shin+boot), arm
// (sleeve+forearm+glove), or torso meat chunk. Cloth matches the team.
function buildDetachedPart(part, team) {
  const M = gibMats();
  const g = new THREE.Group();
  const cloth = team === 'ct' ? M.clothCT : M.clothT;
  const skin = new THREE.MeshStandardMaterial({ color: 0xc9986b, roughness: 0.65 });
  const bootM = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.9 });
  const gloveM = new THREE.MeshStandardMaterial({ color: 0x2b2b26, roughness: 0.95 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  if (part === 'leg') {
    add(new THREE.BoxGeometry(0.22, 0.4, 0.24), cloth, 0, -0.2, 0);
    add(new THREE.BoxGeometry(0.2, 0.32, 0.22), cloth, 0, -0.56, 0);
    add(new THREE.BoxGeometry(0.24, 0.14, 0.34), bootM, 0, -0.79, 0.05);
    add(new THREE.BoxGeometry(0.2, 0.08, 0.2), M.flesh, 0, 0.03, 0); // stump
  } else if (part === 'arm') {
    add(new THREE.BoxGeometry(0.17, 0.36, 0.19), cloth, 0, -0.18, 0);
    add(new THREE.BoxGeometry(0.15, 0.28, 0.16), skin, 0, -0.5, 0);
    add(new THREE.BoxGeometry(0.15, 0.12, 0.16), gloveM, 0, -0.7, 0);
    add(new THREE.BoxGeometry(0.15, 0.07, 0.15), M.flesh, 0, 0.03, 0);
  } else {
    add(new THREE.BoxGeometry(rand(0.1, 0.15), rand(0.12, 0.2), rand(0.1, 0.14)),
      Math.random() < 0.5 ? cloth : M.flesh, 0, 0, 0);
  }
  return g;
}
// tear off ONLY the hit part (torso chunk or limb). One chunk, flung along
// shot dir — the rest of the body stays whole and falls via ragdoll.
function tearLimbGib(mesh, pos, shotDir, team, big = false, part = null) {
  if (!pos) return;
  if (!SET.gore) return;
  try {
    let hitPart = part || 'torso';
    if (hitPart === 'torso' && Math.random() < 0.4) hitPart = 'arm'; // upper-body hits take the arm
    const y = hitPart === 'leg' ? rand(0.3, 0.6) : hitPart === 'arm' ? rand(1.0, 1.35) : rand(0.7, 1.3);
    const origin = new THREE.Vector3(pos.x + rand(-0.15, 0.15), y + (pos.y || 0), pos.z + rand(-0.15, 0.15));
    if (mesh) detachLimb(mesh, hitPart === 'torso' ? null : hitPart);
    const chunk = buildDetachedPart(hitPart, team);
    const v = new THREE.Vector3(rand(-0.6, 0.6), rand(0.6, 1.2), rand(-0.6, 0.6)).normalize().multiplyScalar(rand(2.5, big ? 7 : 5));
    if (shotDir) v.addScaledVector(shotDir, rand(2, 5));
    v.y += rand(1.5, big ? 4 : 3);
    const radius = hitPart === 'torso' ? 0.12 : 0.3;
    spawnGibMesh(chunk, origin, v, { flesh: true, restY: hitPart === 'torso' ? 0.08 : 0.14, radius, rest: 0.3, fric: 0.75 });
    spawnBloodSpray(origin, shotDir, big ? 1.4 : 1.0);
    try { AudioSys.gib(origin, big); } catch (e) {}
  } catch (e) {}
}
function restoreSoldierMesh(mesh) {
  try {
    const ud = mesh.userData || {};
    const parts = ud.headParts || [];
    for (const p of parts) { try { if (p) p.visible = true; } catch (e) {} }
    if (ud.head) { try { ud.head.rotation.set(0, 0, 0); } catch (e) {} }
    const rg = ud.rig;
    if (rg) {
      try {
        for (const j of [rg.pelvis, rg.spine, rg.chest, rg.neck, rg.hipL, rg.kneeL, rg.ankleL,
                         rg.hipR, rg.kneeR, rg.ankleR, rg.shoulderL, rg.shoulderR, rg.elbowL, rg.elbowR, rg.gun]) {
          if (!j) continue;
          j.rotation.set(0, 0, 0);
          j.visible = true; // re-attach limbs hidden by detachLimb
        }
        rg.pelvis.position.set(0, rg.hipY, 0);
        rg.shoulderL.rotation.set(-0.55, 0, 0); rg.elbowL.rotation.set(-0.85, 0, 0);
        rg.shoulderR.rotation.set(-0.55, 0, 0); rg.elbowR.rotation.set(-0.85, 0, 0);
        if (rg.gun && rg.gun.userData.baseY !== undefined) {
          rg.gun.position.y = rg.gun.userData.baseY; rg.gun.position.z = rg.gun.userData.baseZ;
        }
      } catch (e) {}
    }
    ud.anim = null; ud.rag = null; // fresh gait clock on respawn, drop the ragdoll
    if (ud.torso) { try { ud.torso.rotation.set(0, 0, 0); } catch (e) {} }
    if (ud.legL) { try { ud.legL.rotation.set(0, 0, 0); ud.legL.visible = true; } catch (e) {} }
    if (ud.legR) { try { ud.legR.rotation.set(0, 0, 0); ud.legR.visible = true; } catch (e) {} }
    if (ud.armL) { try { ud.armL.rotation.set(-0.55, 0, 0); ud.armL.visible = true; } catch (e) {} }
    if (ud.armR) { try { ud.armR.rotation.set(-0.55, 0, 0); ud.armR.visible = true; } catch (e) {} }
    if (ud.gunG) { try { ud.gunG.visible = true; } catch (e) {} }
    if (ud.stump) { try { ud.stump.visible = false; } catch (e) {} }
    try {
      for (const s of (ud.stumps || [])) { try { s.visible = false; s.parent && s.parent.remove(s); } catch (e) {} }
      ud.stumps = [];
    } catch (e) {}
    mesh.rotation.set(0, mesh.rotation.y || 0, 0);
  } catch (e) {}
}
// rigid-body gibs: gravity + air drag, wall contacts, ground bounce with
// friction, then rest + bleed-out stain. ponytail: single sphere per gib,
// no stacking/constraints — helmet clatter + flesh thud only.
function updateGibs(dt) {
  for (let i = 0; i < gibs.length; i++) {
    const gib = gibs[i];
    try {
      gib.vel.y -= 20 * dt;
      gib.vel.multiplyScalar(Math.max(0, 1 - 0.12 * dt)); // air drag
      gib.mesh.position.addScaledVector(gib.vel, dt);
      gib.mesh.rotation.x += gib.ang.x * dt;
      gib.mesh.rotation.y += gib.ang.y * dt;
      gib.mesh.rotation.z += gib.ang.z * dt;
      const p = gib.mesh.position;
      const wallHit = gibCollide(p, gib.vel, gib.radius || 0.14, gib.helmet ? 0.45 : (gib.rest ?? 0.35), gib.fric ?? 0.7);
      if (wallHit) {
        gib.ang.multiplyScalar(0.6);
        gib.bounced++;
        if (gib.flesh && gib.vel.lengthSq() > 4 && Math.random() < 0.4) {
          try { spawnDecal('blood', p.clone(), new THREE.Vector3(0, 1, 0), 0.4 + Math.random() * 0.4, 0.5); } catch (e) {}
        }
      }
      if (p.y < gib.restY) {
        p.y = gib.restY;
        if (Math.abs(gib.vel.y) > 1.6 && gib.bounced < 5) {
          gib.bounced++;
          gib.vel.y *= gib.helmet ? -0.45 : -0.32;
          gib.vel.x *= (1 - gib.fric * 0.5); gib.vel.z *= (1 - gib.fric * 0.5);
          gib.ang.multiplyScalar(0.5);
          if (gib.helmet) { try { AudioSys.helmetHit(p); } catch (e) {} }
          else if (gib.flesh && Math.random() < 0.6) {
            try { spawnDecal('blood', new THREE.Vector3(p.x, 0.06, p.z), new THREE.Vector3(0, 1, 0), 0.5 + Math.random() * 0.5, 0.5); } catch (e) {}
          }
        } else {
          gib.vel.set(0, 0, 0);
          gib.ang.set(0, 0, 0);
          // bleed-out stain once when coming to rest
          if (gib.flesh && !gib._stained) {
            gib._stained = true;
            try { spawnDecal('blood', new THREE.Vector3(p.x, 0.06, p.z), new THREE.Vector3(0, 1, 0), 0.7 + Math.random() * 0.6, 0.55); } catch (e) {}
          }
        }
      } else if (gib.flesh && gib.mesh.position.y > 0.5) {
        // blood trail while airborne
        gib.bloodAt -= dt;
        if (gib.bloodAt <= 0) {
          gib.bloodAt = 0.07;
          try { spawnBurst(gib.mesh.position, 0x9a0d10, 1, 0.8, 0.4, 0.07); } catch (e) {}
        }
      }
    } catch (e) {}
  }
}
// ---------------- Gore system ----------------
// Scale factor for every particle count, chunk count and decal cap in the game.
// SET.gore is the master switch; SET.goreLevel picks how far past "tasteful" to go.
const GORE_MULT = [0, 0.5, 1.0, 1.9, 3.0, 4.8];
const GK = () => (SET.gore ? (GORE_MULT[clamp(Math.round(SET.goreLevel || 5), 0, 5)] || 0) : 0);
const goreN = (base) => Math.max(0, Math.round(base * GK() * (opts.quality ? 1 : 0.5)));
const goreCap = (base) => Math.round(base * Math.max(1, GK()));
// Whole-corpse contact: keep the sliding body out of crates/walls so the
// knockback never ends buried in geometry. Horizontal push-out only — the
// tip-over tween owns Y. ponytail: no per-bone simulation, one capsule push.
function slideCorpseOut(mesh, radius = 0.5) {
  try {
    const p = mesh.position, v = new THREE.Vector3();
    if (gibCollide(p, v, radius, 0, 0)) {
      p.y = Math.max(p.y, 0.05);
      return true;
    }
  } catch (e) {}
  return false;
}
// Which face of an axis-aligned box is this point on? Needed to lay a splat flat
// against a wall instead of edge-on to it.
function boxFaceNormal(box, p) {
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const dx = (p.x - c.x) / (s.x || 1e-6), dy = (p.y - c.y) / (s.y || 1e-6), dz = (p.z - c.z) / (s.z || 1e-6);
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  if (ax >= ay && ax >= az) return new THREE.Vector3(Math.sign(dx) || 1, 0, 0);
  if (ay >= az) return new THREE.Vector3(0, Math.sign(dy) || 1, 0);
  return new THREE.Vector3(0, 0, Math.sign(dz) || 1);
}
// Throw blood outward from a wound and stain whatever it lands on — walls, crates,
// the floor. This is what makes a firefight leave a scene behind.
const _splatRay = new THREE.Ray(), _splatPt = new THREE.Vector3();
function bloodSplatterRays(origin, dir, count = 8, spread = 1, maxDist = 7) {
  const k = GK();
  if (!k) return;
  // each ray walks every collider, so cap the work regardless of gore level
  const n = Math.min(36, goreN(count));
  for (let i = 0; i < n; i++) {
    const d = dir ? dir.clone() : new THREE.Vector3(rand(-1, 1), rand(-0.2, 0.4), rand(-1, 1));
    d.x += rand(-spread, spread); d.y += rand(-spread * 0.7, spread * 0.7); d.z += rand(-spread, spread);
    if (d.lengthSq() < 1e-4) continue;
    d.normalize();
    _splatRay.set(origin, d);
    let best = maxDist, hitPt = null, normal = null;
    for (const b of colliders) {
      if (_splatRay.intersectBox(b, _splatPt)) {
        const dd = origin.distanceTo(_splatPt);
        if (dd < best && dd > 0.2) { best = dd; hitPt = _splatPt.clone(); normal = boxFaceNormal(b, hitPt); }
      }
    }
    if (d.y < -0.05) { // floor
      const tg = -origin.y / d.y;
      if (tg > 0.2 && tg < best) { best = tg; hitPt = origin.clone().addScaledVector(d, tg); normal = new THREE.Vector3(0, 1, 0); }
    }
    if (hitPt) {
      const far = clamp(1 - best / maxDist, 0.3, 1);
      spawnDecal('blood', hitPt, normal, rand(0.55, 1.5) * (0.8 + k * 0.12) * (0.55 + far), rand(0.5, 1));
    }
  }
}
// which part did the killing shot hit? head is known; torso vs leg from wound height.
function woundPart(feetY, hitY, head) {
  if (head) return 'head';
  const h = (hitY || 0) - (feetY || 0);
  return h < 0.8 ? 'leg' : 'torso';
}
// A body that stops being a body. Returns true if it actually came apart.
// EXPLOSIVES ONLY — bullets never call this (they tear one part, see above).
function explodeBody(mesh, pos, dir, power = 1, team = 't') {
  const k = GK();
  if (!k) return false;
  try {
    const M = gibMats();
    const cloth = team === 'ct' ? M.clothCT : M.clothT;
    const origin = new THREE.Vector3(pos.x, (pos.y || 0) + 1.0, pos.z);
    const kick = (mag, up) => {
      const v = new THREE.Vector3(rand(-1, 1), rand(0.2, 1), rand(-1, 1)).normalize().multiplyScalar(mag * rand(0.6, 1.2));
      if (dir) v.addScaledVector(dir, rand(0.4, 1.8) * power);
      v.y += up * rand(0.7, 1.3);
      return v;
    };
    const at = (spread, yLo, yHi) => new THREE.Vector3(
      pos.x + rand(-spread, spread), (pos.y || 0) + rand(yLo, yHi), pos.z + rand(-spread, spread));

    // torso split in two
    for (let i = 0; i < 2; i++) {
      const half = new THREE.Mesh(new THREE.BoxGeometry(rand(0.26, 0.34), rand(0.3, 0.4), rand(0.3, 0.38)), i ? cloth : M.flesh);
      spawnGibMesh(half, at(0.2, 0.9, 1.4), kick(2.4 * power, 1.5), { flesh: true, restY: 0.16 });
    }
    // limbs
    for (let i = 0; i < 4; i++) {
      const limb = new THREE.Mesh(new THREE.BoxGeometry(rand(0.13, 0.19), rand(0.32, 0.5), rand(0.13, 0.18)),
        Math.random() < 0.55 ? cloth : M.flesh);
      spawnGibMesh(limb, at(0.3, 0.5, 1.5), kick(3.2 * power, 2.0), { flesh: true, restY: 0.12 });
    }
    // meat, bone and viscera
    const chunks = goreN(4) + 2;
    for (let i = 0; i < chunks; i++) {
      const roll = Math.random();
      let g, mt;
      if (roll < 0.34) { g = new THREE.BoxGeometry(rand(0.07, 0.16), rand(0.07, 0.15), rand(0.07, 0.15)); mt = M.flesh; }
      else if (roll < 0.55) { g = new THREE.BoxGeometry(rand(0.03, 0.06), rand(0.16, 0.34), rand(0.03, 0.06)); mt = M.bone; }
      else if (roll < 0.78) { g = new THREE.SphereGeometry(rand(0.06, 0.13), 8, 6); mt = M.fleshD; }
      else { g = new THREE.BoxGeometry(rand(0.09, 0.2), rand(0.03, 0.06), rand(0.09, 0.2)); mt = cloth; }
      spawnGibMesh(new THREE.Mesh(g, mt), at(0.35, 0.4, 1.8), kick(4.0 * power, 2.6), { flesh: true, restY: 0.09 });
    }
    // skull + helmet go their own way
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), M.bone);
    spawnGibMesh(skull, at(0.15, 1.6, 1.9), kick(3.6 * power, 3.0), { flesh: true, restY: 0.15 });
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.18, 0.42), team === 'ct' ? M.helmetCT : M.helmetT);
    spawnGibMesh(lid, at(0.2, 1.8, 2.1), kick(3.4 * power, 2.6), { helmet: true, restY: 0.1 });

    // the mess it leaves
    spawnBloodSpray(origin, dir, 2.0 * power);
    spawnBurst(origin, 0xa00d10, goreN(18) + 8, 9 * power, 0.9, 0.16);
    spawnBurst(origin, 0x5d0b0d, goreN(10) + 4, 5 * power, 1.3, 0.22);
    for (let i = 0; i < goreN(1) + 1; i++) spawnSmoke(at(0.5, 0.6, 1.4), 0.5 + Math.random() * 0.5, 1.1, 0x6a0d10);
    bloodSplatterRays(origin, null, 16, 1.2, 8);
    for (let i = 0; i < goreN(2) + 1; i++) spawnBloodPool(pos.x + rand(-1.3, 1.3), pos.z + rand(-1.3, 1.3), true);
    try { AudioSys.gib(origin, true); } catch (e) {}
    try { AudioSys.headpop(origin); } catch (e) {}
    // the body itself is gone
    try { mesh.visible = false; } catch (e) {}
    return true;
  } catch (e) { return false; }
}
// Pulsing arterial spray from a wound that has not stopped bleeding. Called per frame.
function bloodFountain(pos, dt, power = 1) {
  const k = GK();
  if (!k) return;
  const n = Math.max(1, Math.round(power * (0.6 + k * 0.5)));
  if (Math.random() > dt * 22 * Math.min(2, k)) return;
  const p = pos.clone();
  const spurt = 1 + Math.sin(performance.now() / 110) * 0.65; // heartbeat
  spawnBurst(p, 0xa00d10, n, 2.2 * spurt * power, 0.5, 0.09);
  if (Math.random() < 0.28 * k) {
    bloodSplatterRays(p, new THREE.Vector3(rand(-0.4, 0.4), rand(0.2, 1), rand(-0.4, 0.4)), 2, 0.5, 4);
  }
}
// Blood on the lens: splattered when you are hit, or when something dies in your face.
let _goreScreen = 0, _goreScreenTex = null;
function goreScreenTexture() {
  if (_goreScreenTex) return _goreScreenTex;
  const c = document.createElement('canvas');
  c.width = 512; c.height = 288;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const blob = (x, y, r, a) => {
    g.fillStyle = `rgba(${105 + Math.random() * 45 | 0},${4 + Math.random() * 8 | 0},${6 + Math.random() * 8 | 0},${a})`;
    g.beginPath();
    g.moveTo(x + r, y);
    for (let i = 1; i <= 11; i++) {
      const th = (i / 11) * Math.PI * 2;
      const rr = r * (0.55 + Math.random() * 0.75);
      g.lineTo(x + Math.cos(th) * rr, y + Math.sin(th) * rr * 0.9);
    }
    g.closePath(); g.fill();
    // runs
    if (Math.random() < 0.5) {
      g.fillRect(x - r * 0.18, y, r * 0.36, r * (1.2 + Math.random() * 3.2));
    }
  };
  // heavier around the edges, sparse in the middle so you can still play
  for (let i = 0; i < 46; i++) {
    const edge = Math.random() < 0.72;
    const x = edge ? (Math.random() < 0.5 ? Math.random() * 130 : c.width - Math.random() * 130) : Math.random() * c.width;
    const y = edge ? Math.random() * c.height : (Math.random() < 0.5 ? Math.random() * 70 : c.height - Math.random() * 70);
    blob(x, y, 8 + Math.random() * 34, 0.5 + Math.random() * 0.45);
  }
  for (let i = 0; i < 90; i++) blob(Math.random() * c.width, Math.random() * c.height, 2 + Math.random() * 7, 0.35 + Math.random() * 0.4);
  _goreScreenTex = c.toDataURL('image/png');
  return _goreScreenTex;
}
function screenGore(amount = 1) {
  const k = GK();
  if (!k) return;
  const el = $('gore-overlay');
  if (!el) return;
  try {
    if (!el.style.backgroundImage) el.style.backgroundImage = `url(${goreScreenTexture()})`;
    // re-roll orientation so repeat splatters don't look identical
    el.style.transform = `scaleX(${Math.random() < 0.5 ? -1 : 1}) scaleY(${Math.random() < 0.5 ? -1 : 1}) rotate(${(Math.random() * 6 - 3).toFixed(1)}deg)`;
  } catch (e) {}
  _goreScreen = Math.min(1, _goreScreen + amount * clamp(k * 0.35, 0.2, 1));
}
function updateGoreScreen(dt) {
  const el = $('gore-overlay');
  if (!el) return;
  if (_goreScreen > 0) {
    _goreScreen = Math.max(0, _goreScreen - dt * 0.34);
    el.style.opacity = (_goreScreen * 0.88).toFixed(3);
  } else if (el.style.opacity !== '0') el.style.opacity = 0;
}

// where should this corpse fall? Away from the shooter, with randomness.
// Returns {axis(x/z tip), yawSpin, power} consumed by updateDeadBots / remote dead anim.
function pickFallParams(botPos, shotDir, power = 1) {
  const d = shotDir ? shotDir.clone().setY(0) : new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1));
  if (d.lengthSq() < 0.01) d.set(rand(-1, 1), 0, rand(-1, 1));
  d.normalize();
  return {
    dirX: d.x, dirZ: d.z,
    spin: rand(-0.9, 0.9) * power,
    roll: rand(-0.45, 0.45),
    power: clamp(power, 0.6, 2.2),
    sprawl: Math.random(),
  };
}
// Death is simulated, not posed. Every joint goes limp with an initial angular
// kick from the impact and then springs toward a dead-weight rest angle, so the
// limbs whip on the way down and settle afterwards. A single random pose (what
// this used to do) always reads as a mannequin dropped on the floor.
function poseCorpseLimbs(mesh, sprawl, power) {
  const ud = mesh && mesh.userData;
  const r = ud && ud.rig;
  if (!r) return;
  const pw = clamp(power || (0.8 + (sprawl || 0) * 0.9), 0.5, 2.4);
  const s = () => rand(-1, 1);
  const J = (o, tx, tz, vx, vz, stiff) => ({ o, tx, tz, vx, vz, stiff });
  try {
    ud.rag = {
      t: 0,
      j: [
        // arms let go of the weapon and flop outward
        J(r.shoulderL, 0.10 + rand(-0.30, 0.30), -0.50 + s() * 0.5, -3.4 * pw + s() * 2, s() * 4 * pw, 16),
        J(r.shoulderR, 0.10 + rand(-0.30, 0.30), 0.50 + s() * 0.5, -3.4 * pw + s() * 2, s() * 4 * pw, 16),
        J(r.elbowL, -0.30 + rand(-0.40, 0.10), 0, s() * 5, 0, 22),
        J(r.elbowR, -0.30 + rand(-0.40, 0.10), 0, s() * 5, 0, 22),
        // legs buckle: knees fold, hips splay
        J(r.hipL, rand(-0.35, 0.25), rand(-0.22, 0.05), s() * 3 * pw, s() * 1.5, 18),
        J(r.hipR, rand(-0.35, 0.25), rand(-0.05, 0.22), s() * 3 * pw, s() * 1.5, 18),
        J(r.kneeL, rand(0.15, 0.85), 0, rand(0, 4) * pw, 0, 20),
        J(r.kneeR, rand(0.15, 0.85), 0, rand(0, 4) * pw, 0, 20),
        J(r.spine, rand(-0.15, 0.22), rand(-0.22, 0.22), s() * 2, s() * 2, 14),
        J(r.chest, rand(-0.10, 0.16), rand(-0.16, 0.16), s() * 2, s() * 2, 14),
        // the head is heavy and unsupported — it lolls hardest
        J(r.neck, rand(-0.55, 0.60), rand(-0.55, 0.55), s() * 6 * pw, s() * 5 * pw, 12),
      ],
    };
    ud.anim = null;              // gait clock is dead with the body
    r.pelvis.position.y = r.hipY * 0.94; // hips sag as the legs stop carrying weight
    if (r.gun) { r.gun.rotation.z += rand(-0.6, 0.6); r.gun.rotation.x += rand(-0.4, 0.4); }
  } catch (e) {}
}
// Body fall shares one clock: knees buckle first (slow start), then the torso
// slams down accelerating (gravity, not eased-out), with a small ground bounce
// on impact. Returns {k (0..1 linear), e (tip ease with bounce)}.
function corpseK(deathT) {
  const k = Math.min(1, (deathT || 0) / 0.85);
  const slam = 1 - Math.cos(k * Math.PI / 2);
  const bounce = k > 0.7 ? Math.sin((k - 0.7) / 0.3 * Math.PI) * 0.08 * (1 - k) : 0;
  return { k, e: slam - bounce };
}
// Integrate one corpse's limp joints. Spring toward rest, damped, knees one-way.
function updateRagdoll(mesh, dt) {
  const ud = mesh && mesh.userData;
  const rg = ud && ud.rag;
  if (!rg) return;
  rg.t += dt;
  if (rg.t > 3.5) { ud.rag = null; return; } // fully settled — stop paying for it
  const d = Math.exp(-3.2 * dt); // loose damping: limbs keep whipping through the ~0.85s fall
  for (const j of rg.j) {
    if (!j.o) continue;
    j.vx = (j.vx + (j.tx - j.o.rotation.x) * j.stiff * dt) * d;
    j.vz = (j.vz + (j.tz - j.o.rotation.z) * j.stiff * dt) * d;
    j.o.rotation.x += j.vx * dt;
    j.o.rotation.z += j.vz * dt;
  }
  const r = ud.rig;
  if (r) {
    r.kneeL.rotation.x = Math.max(0, r.kneeL.rotation.x); // knees don't bend forward
    r.kneeR.rotation.x = Math.max(0, r.kneeR.rotation.x);
  }
}
// PvP gore for a remote player's mesh: same rules as bots (head-pop odds by weapon),
// but driven by the network 'killed' event (authoritative victim) rather than damageBot.
function goreRemoteDeath(entry, head, weaponLabel, shotDir) {
  if (!entry || !entry.mesh) return;
  try {
    if (entry.fall) return; // already gored (snapshot transition may fire twice)
    const wName = String(weaponLabel || (entry.data && entry.data.weapon) || 'AK-47').toUpperCase();
    const isFire = wName.includes('MOLOTOV');
    const explosive = !isFire && (wName.includes('HE') || wName.includes('C4'));
    const isAWP = wName.includes('AWP');
    const isDeagle = wName.includes('DESERT') || wName.includes('DEAGLE') || wName.includes('EAGLE');
    let power = explosive ? 2.1 : isAWP ? 2.0 : isDeagle ? 1.4 : 1.0;
    if (head) power += 0.15;
    const sdir = shotDir ? shotDir.clone() : null;
    entry.fall = pickFallParams(entry.pos, sdir, power);
    entry.deathPos = entry.pos.clone();
    const slideDist = explosive ? rand(0.9, 1.6) : isAWP ? rand(0.7, 1.2) : isDeagle ? rand(0.45, 0.8) : rand(0.3, 0.65);
    const flat = sdir ? sdir.clone().setY(0) : new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1));
    if (flat.lengthSq() < 0.01) flat.set(rand(-1, 1), 0, rand(-1, 1));
    flat.normalize();
    entry.knock = flat.multiplyScalar(slideDist);
    entry.deathT = 0; entry._thudded = false; entry.headless = false;
    const team = (entry.data && entry.data.team) || 't';
    const headPos = new THREE.Vector3(entry.pos.x, entry.pos.y + 1.76, entry.pos.z);
    let pop = false, popPower = 1;
    if (explosive) {
      pop = Math.random() < 0.75; popPower = 1.7;
      tearLimbGib(entry.mesh, entry.pos, sdir, team, true, 'torso');
    } else if (head) {
      if (isAWP) { pop = true; popPower = 1.7; }
      else if (isDeagle) { pop = Math.random() < 0.65; popPower = 1.3; }
      else { pop = Math.random() < 0.25; popPower = 1.0; }
    } else if (isAWP && Math.random() < 0.25) {
      tearLimbGib(entry.mesh, entry.pos, sdir, team, false, 'torso'); // net has no wound height — torso only
    }
    if (pop) {
      entry.headless = true;
      try { explodeHead(entry.mesh, headPos, sdir, popPower, team); } catch (e) {}
    } else {
      try { spawnBloodSpray(head ? headPos : new THREE.Vector3(entry.pos.x, entry.pos.y + 1.1, entry.pos.z), sdir, head ? 1.2 : power); } catch (e) {}
      try { spawnBloodPool(entry.pos.x, entry.pos.z, true); } catch (e) {}
      if (head) { try { AudioSys.headpop(headPos); } catch (e) {} }
    }
    try {
      const gk = GK();
      if (gk > 0 && explosive
          && explodeBody(entry.mesh, entry.pos, shotDir, entry.fall.power, (entry.data && entry.data.team) || 't')) {
        entry.exploded = true;
        try {
          const dp = camera ? camera.position.distanceTo(new THREE.Vector3(entry.pos.x, 1, entry.pos.z)) : 99;
          if (dp < 7) screenGore(clamp(1.2 - dp / 7, 0.25, 1));
        } catch (e) {}
      } else {
        poseCorpseLimbs(entry.mesh, entry.fall.sprawl, entry.fall.power);
      }
    } catch (e) {}
    entry.mesh.visible = true;
  } catch (e) {}
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
  if (particles.length > 260) return; // safety valve for multi-kill gore storms
  n = Math.min(n, 220);
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
    if (!_dustCache) _dustCache = scene.getObjectByName('dustMotes');
    const dust = _dustCache;
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
  try { updateGibs(dt); } catch (e) {}
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
    if (vmL) {
      vmRig.kickVL += (-k * vmRig.kickZL - d * vmRig.kickVL) * dt;
      vmRig.kickZL += vmRig.kickVL * dt;
      vmRig.kickRotVL += (-kr * vmRig.kickRotL - dr * vmRig.kickRotVL) * dt;
      vmRig.kickRotL += vmRig.kickRotVL * dt;
      vmL.kick.position.z = vmRig.kickZL;
      vmL.kick.position.y = vmRig.kickZL * 0.35;
      vmL.kick.rotation.x = vmRig.kickRotL;
      for (const f of vmL.flash.children) {
        f.material.opacity = Math.max(0, f.material.opacity - dt * 16);
        if (f.material.opacity > 0) f.rotation.z += dt * 20;
      }
    }
    if (vmRig.primeK > 0.001 && isNadeKey(player.cur)) {
      vmKickG.position.y += vmRig.primeK * 0.07;
      vmKickG.position.z += vmRig.primeK * 0.09;
      vmKickG.rotation.x -= vmRig.primeK * 0.45;
      vmKickG.rotation.z = vmRig.primeK * 0.25;
    } else vmKickG.rotation.z = 0;
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
      } else { const bk = Math.pow(0.8, dt * 60); vmBolt.position.z *= bk; vmBolt.rotation.y *= bk; }
    }
  }
}

// ---------------- Local player body (visible to yourself, and it casts a shadow) ----------------
// The camera sits inside this rig's skull, so the head, arms and world rifle are
// made shadow-only: colorWrite off means they paint nothing for the camera, but
// three.js still runs them through the shadow pass, so your shadow keeps its head
// and gun. (Setting visible = false would drop them from the shadow map too, and
// layers don't help either — the shadow pass tests object layers against the VIEW
// camera, not the light.)
let playerMesh = null, _playerBodyTeam = null, _playerFirstPerson = null;
function playerBodyHiddenParts(mesh) {
  const ud = mesh.userData, r = ud.rig;
  const seen = new Set();
  const add = (o) => { if (o && o.isMesh) seen.add(o); };
  for (const p of (ud.headParts || [])) add(p);
  // the world rifle would fight the viewmodel, and the arms would fight its hands
  for (const g of [r.shoulderL, r.shoulderR, r.gun]) { if (g) g.traverse(add); }
  // Everything from the waist up is culled for your own camera. The torso tops out
  // just below eye level (a run would put you inside your own shoulders), and a
  // half-body hanging under the view reads worse than clean legs. Measured off the
  // rest pose, so it keeps working if the model changes.
  try {
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3();
    mesh.traverse((o) => {
      if (!o.isMesh || seen.has(o)) return;
      box.setFromObject(o);
      if (box.max.y > PLAYER_BODY_CULL_Y) add(o);
    });
  } catch (e) {}
  return [...seen];
}
// firstPerson=true -> head/arms/gun invisible to the camera but still casting.
// firstPerson=false -> whole body drawn normally (your corpse, once you are dead).
function setPlayerBodyFirstPerson(on) {
  if (!playerMesh || _playerFirstPerson === on) return;
  _playerFirstPerson = on;
  for (const o of playerBodyHiddenParts(playerMesh)) {
    if (!o.material) continue;
    if (!o.userData._fpMat) {
      o.userData._srcMat = o.material;
      const m = o.material.clone();
      m.colorWrite = false; m.depthWrite = false;
      o.userData._fpMat = m;
    }
    o.material = on ? o.userData._fpMat : o.userData._srcMat;
    o.castShadow = true;
  }
}
function ensurePlayerMesh() {
  const team = player.team || 'ct';
  if (playerMesh && _playerBodyTeam === team) return playerMesh;
  if (playerMesh) { try { scene.remove(playerMesh); } catch (e) {} }
  playerMesh = makeSoldier(team);
  _playerBodyTeam = team;
  _playerFirstPerson = null;
  scene.add(playerMesh);
  setPlayerBodyFirstPerson(true);
  return playerMesh;
}
function resetPlayerBody() {
  ensurePlayerMesh();
  try { restoreSoldierMesh(playerMesh); } catch (e) {}
  _playerFirstPerson = null;
  setPlayerBodyFirstPerson(true);
  playerMesh.rotation.set(0, (player.yaw || 0) + Math.PI, 0);
  playerMesh.position.copy(player.pos);
  playerMesh.visible = true;
  player._bodyPrev = null; player._bvx = 0; player._bvz = 0;
  player.deathT = 0; player.fall = null;
}
function updatePlayerBody(dt, t) {
  if (!playerMesh) return;
  const m = playerMesh;
  if (G.phase === 'menu') { m.visible = false; if (player.blob) player.blob.visible = false; return; }
  if (!player.alive) {
    if (player.exploded) {
      player.deathT = Math.min(6.0, (player.deathT || 0) + dt);
      m.visible = false;
      if (player.blob) player.blob.visible = false;
      if (player.deathT < 5.0) {
        try {
          bloodFountain(new THREE.Vector3(player.pos.x, 0.18, player.pos.z), dt, 1.6);
          if (Math.random() < dt * 2.2) spawnBloodPool(player.pos.x + rand(-1.1, 1.1), player.pos.z + rand(-1.1, 1.1), false);
        } catch (e) {}
      }
      return;
    }
    // Your own corpse: full body back on, ragdoll settles, tips over like anyone else.
    setPlayerBodyFirstPerson(false);
    player.deathT = Math.min(1.6, (player.deathT || 0) + dt);
    updateRagdoll(m, dt);
    const { k: pk, e: pease } = corpseK(player.deathT);
    const f = player.fall || { dirX: 0, dirZ: 1, spin: 0, roll: 0, power: 1 };
    const fwdX = -Math.sin(player.yaw), fwdZ = -Math.cos(player.yaw);
    const fDot = f.dirX * fwdX + f.dirZ * fwdZ;
    const sDot = f.dirX * fwdZ - f.dirZ * fwdX;
    const tip = Math.PI / 2 * 0.95;
    m.position.set(player.pos.x, 0.05 + Math.sin(Math.min(1, pk * 1.3) * Math.PI) * 0.08 * (f.power || 1) * (1 - pk), player.pos.z);
    try { slideCorpseOut(m, 0.5); player.pos.set(m.position.x, 0, m.position.z); } catch (e) {}
    m.rotation.x = (fDot >= 0 ? tip : -tip) * (0.75 + Math.abs(fDot) * 0.45) * pease;
    m.rotation.z = clamp(-sDot * tip * 0.9 + (f.roll || 0), -1.2, 1.2) * pease;
    m.rotation.y = player.yaw + Math.PI + (f.spin || 0) * pease;
    m.visible = true;
    try { updateBlob(player, player.pos.x, player.pos.z, false, false); } catch (e) {}
    return;
  }
  setPlayerBodyFirstPerson(true);
  m.visible = true;
  m.position.copy(player.pos);
  player.wallLean = damp(player.wallLean || 0, player.wallRun ? player.wallRun.side * WALLRUN.bodyLean : 0, 10, dt);
  m.rotation.set(0, player.yaw + Math.PI, player.wallLean);
  // Body-space gait needs the same forward convention the bots use, and the
  // player's yaw is a half turn off it.
  animateSoldier(m, {
    vx: player.vel.x, vz: player.vel.z,
    yaw: player.yaw + Math.PI,
    pitch: player.pitch,
    grounded: player.onGround || !!player.wallRun,
    crouch: !!player.crouching,
    kneel: !!(keys['KeyE'] && (playerNearPlantedBomb() || playerInPlantSite())),
    reloading: player.reloading > 0,
    wall: player.wallRun ? player.wallRun.side : 0,
  }, dt, t);
  try { updateBlob(player, player.pos.x, player.pos.z, true, Math.hypot(player.vel.x, player.vel.z) > 1.5); } catch (e) {}
}

// ---------------- Collision ----------------
const _tmpBox = new THREE.Box3();
const _tmpMoveA = new THREE.Vector3();
const _tmpMMEye = new THREE.Vector3();
const _tmpMMTgt = new THREE.Vector3();
let _dustCache = null;
function collidesAt(p, radius, height = 1.7) {
  _tmpBox.min.set(p.x - radius, p.y + STEP_EPS, p.z - radius);
  _tmpBox.max.set(p.x + radius, p.y + height, p.z + radius);
  for (const b of colliders) if (_tmpBox.intersectsBox(b)) return b;
  return null;
}
function moveWithCollision(p, dx, dz, radius, height = 1.7) {
  // X axis — reuse temp vectors, no per-frame allocation
  let nx = p.x + dx;
  _tmpMoveA.set(nx, p.y, p.z);
  const hitX = collidesAt(_tmpMoveA, radius, height);
  if (!hitX) p.x = clamp(nx, -MAP_HALF, MAP_HALF);
  let nz = p.z + dz;
  _tmpMoveA.set(p.x, p.y, p.z + dz);
  const hitZ = collidesAt(_tmpMoveA, radius, height);
  if (!hitZ) p.z = clamp(nz, -MAP_HALF, MAP_HALF);
}
// footprint overlap (strict — touching a wall's side doesn't count as over it)
function _overFootprint(b, x, z, r) {
  return x + r > b.min.x && x - r < b.max.x && z + r > b.min.z && z - r < b.max.z;
}
// highest walkable surface under the footprint that is at or below `y` (0 = ground)
function supportHeightAt(x, z, y, radius) {
  let best = 0;
  for (const b of colliders) {
    if (b.max.y > y + 0.06 || b.max.y <= best) continue;
    if (_overFootprint(b, x, z, radius)) best = b.max.y;
  }
  return best;
}
// lowest overhang bottom under the footprint that is above `y`
function ceilingAt(x, z, y, radius) {
  let best = Infinity;
  for (const b of colliders) {
    if (b.min.y < y - 0.02 || b.min.y >= best) continue;
    if (_overFootprint(b, x, z, radius)) best = b.min.y;
  }
  return best;
}
const playerHullHeight = () => (player.crouching ? CROUCH_HEIGHT : STAND_HEIGHT);
// Axis-aligned wall next to the player whose face runs along our motion.
// Returns { box, nx, nz, tx, tz, along, side } or null. n points from the wall to us.
function findRunnableWall() {
  const p = player.pos, r = player.radius;
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
  let best = null;
  for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    _tmpMoveA.set(p.x - nx * WALLRUN.probe, p.y + 0.3, p.z - nz * WALLRUN.probe);
    const box = collidesAt(_tmpMoveA, r, 1.0);
    if (!box || box.max.y < p.y + WALLRUN.minWallAbove) continue;
    // the wall face must actually be facing us along this axis (not a corner we're inside of)
    _tmpMoveA.set(p.x, p.y + 0.3, p.z);
    if (collidesAt(_tmpMoveA, r, 1.0) === box) continue;
    const tx = -nz, tz = nx; // tangent
    const vAlong = player.vel.x * tx + player.vel.z * tz;
    const lookAlong = fx * tx + fz * tz;
    // run the way we're looking; need to be looking mostly along the wall, not into it
    const dirSign = Math.abs(lookAlong) > 0.05 ? Math.sign(lookAlong) : Math.sign(vAlong);
    const along = vAlong * dirSign;
    const lookInto = -(fx * nx + fz * nz);
    if (Math.abs(lookAlong) < 0.35 || lookInto > 0.93) continue;
    const side = (rx * -nx + rz * -nz) > 0 ? 1 : -1; // +1 wall on our right
    const cand = { box, nx, nz, tx: tx * dirSign, tz: tz * dirSign, along, side };
    if (!best || cand.along > best.along) best = cand;
  }
  return best;
}

// ---------------- Dropped weapons: drop (X), pick up (walk over / E), dual wield ----------------
// Any firearm can be dropped and picked up. Picking up a second copy of a gun you
// already carry puts one in each hand. Dual wielding: LMB fires the right gun, RMB
// the left, no sights, huge spread, violent alternating recoil and a constant
// wandering aim — double the firepower, a fraction of the control.
const DUAL = {
  spreadMul: 3.4, spreadAdd: 0.014,   // hip spread multiplier + flat add
  moveMul: 1.8,                        // extra movement inaccuracy
  bloomMul: 2.6, bloomMaxMul: 3.2,     // heat builds faster and higher
  kickUpMul: 2.4, kickSideMul: 5.5,    // raw recoil
  whip: 0.018,                         // each gun yanks the view toward its own side
  roll: 0.045,                         // camera roll kick per shot
  driftYaw: 0.020, driftPitch: 0.013,  // rad/s wandering aim (grows with speed + heat)
  reloadMul: 1.85,                     // reloading two guns
  speedMul: 0.92,
  reserveMul: 2,                       // carry double reserve
};
const PICKUP_RANGE = 1.35;
const worldWeapons = new Map(); // wid -> { wid, key, mag, reserve, mesh, pos, vel, rest, ry, spin, pendingUntil, mine, noPickupUntil }
let _wwSeq = 0;
const newWid = () => `${isOnline() && Net.id ? Net.id : 'L'}.${Date.now().toString(36)}.${(_wwSeq++).toString(36)}`;
const reserveCap = (key, dual) => (WEAPONS[key] ? WEAPONS[key].startReserve * (dual ? DUAL.reserveMul : 1) : 0);
const isDualCur = () => { const w = player.weapons[player.cur]; return !!(w && w.owned && w.dual && WEAPONS[player.cur]); };

function spawnWorldWeapon(o) {
  if (!o || !WEAPONS[o.key] || worldWeapons.has(o.wid)) return null;
  if (!_worldGunMats) _worldGunMats = gunMats();
  const mesh = new THREE.Group();
  const holder = new THREE.Group();
  holder.scale.setScalar(0.9);
  holder.rotation.z = Math.PI / 2; // lying on its side
  holder.position.y = 0.06;
  mesh.add(holder);
  try { buildGunModel(o.key, _worldGunMats, holder, holder, { world: true }); } catch (e) { console.warn('world gun', e); }
  holder.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  const e = {
    wid: o.wid, key: o.key, mag: Math.max(0, o.mag | 0), reserve: Math.max(0, o.reserve | 0),
    mesh, pos: new THREE.Vector3(+o.x || 0, +o.y || 0, +o.z || 0),
    vel: new THREE.Vector3(+o.vx || 0, +o.vy || 0, +o.vz || 0),
    rest: !!o.rest, ry: +o.ry || Math.random() * TAU, spin: rand(-9, 9),
    pendingUntil: 0, mine: !!o.mine, noPickupUntil: +o.noPickupUntil || 0, bornT: performance.now() / 1000,
  };
  mesh.position.copy(e.pos); mesh.rotation.y = e.ry;
  scene.add(mesh);
  worldWeapons.set(e.wid, e);
  return e;
}
function removeWorldWeapon(wid) {
  const e = worldWeapons.get(wid);
  if (!e) return null;
  try { scene.remove(e.mesh); } catch (err) {}
  worldWeapons.delete(wid);
  return e;
}
function clearWorldWeapons() { for (const wid of [...worldWeapons.keys()]) removeWorldWeapon(wid); }

// Throw a gun out of the player's hands (or off their corpse). Returns the entries spawned.
function throwWeaponEntry(key, mag, reserve, fromDeath) {
  const fwd = new THREE.Vector3(-Math.sin(player.yaw) * Math.cos(player.pitch), Math.sin(player.pitch), -Math.cos(player.yaw) * Math.cos(player.pitch));
  let p, v;
  if (fromDeath) {
    p = new THREE.Vector3(player.pos.x + rand(-0.3, 0.3), player.pos.y + 1.0, player.pos.z + rand(-0.3, 0.3));
    v = new THREE.Vector3(rand(-1.5, 1.5) + player.vel.x * 0.5, rand(1, 2.5), rand(-1.5, 1.5) + player.vel.z * 0.5);
  } else {
    const eye = new THREE.Vector3(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0) - 0.25, player.pos.z);
    const reach = Math.max(0, Math.min(0.5, rayWallDist(eye, fwd, 0.8) - 0.3));
    p = eye.addScaledVector(fwd, reach);
    v = fwd.clone().multiplyScalar(4.2).add(new THREE.Vector3(player.vel.x * 0.8, 1.6, player.vel.z * 0.8));
  }
  const o = { wid: newWid(), key, mag, reserve, x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z, ry: player.yaw + Math.PI / 2, mine: true, noPickupUntil: performance.now() / 1000 + 1.0 };
  const e = spawnWorldWeapon(o);
  try { if (isOnline()) Net.sendWeapon({ action: 'drop', wid: o.wid, key, mag, reserve, x: o.x, y: o.y, z: o.z, vx: o.vx, vy: o.vy, vz: o.vz, ry: o.ry }); } catch (err) {}
  return e;
}

// Drop `key`. Dual: drops the left-hand copy (both:true drops both). fromDeath skips the last-gun rule.
function dropWeapon(key, { both = false, fromDeath = false } = {}) {
  const w = player.weapons[key], def = WEAPONS[key];
  if (!w || !w.owned || !def) return false;
  if (!fromDeath && !w.dual) {
    const others = SLOT_ORDER.filter((k) => k !== key && player.weapons[k] && player.weapons[k].owned);
    if (!others.length) { announce("CAN'T DROP YOUR LAST GUN", 900); AudioSys.click(250, 0.08, 0.3); return false; }
  }
  if (w.dual) {
    const half = Math.floor(w.reserve / 2);
    throwWeaponEntry(key, w.mag2 | 0, half, fromDeath);
    w.reserve -= half; w.mag2 = 0; w.dual = false;
    if (both) {
      throwWeaponEntry(key, w.mag, w.reserve, fromDeath);
      w.owned = false; w.mag = 0; w.reserve = 0;
    } else {
      w.reserve = Math.min(w.reserve, reserveCap(key, false));
    }
  } else {
    throwWeaponEntry(key, w.mag, w.reserve, fromDeath);
    w.owned = false; w.mag = 0; w.reserve = 0;
  }
  if (fromDeath) return true;
  player.reloading = 0; $('reload-tip').classList.add('hidden');
  if (player.cur === key) {
    if (w.owned) { player.aiming = false; buildViewmodel(key); }
    else {
      const fb = (player.last && player.last !== key && player.weapons[player.last] && player.weapons[player.last].owned) ? player.last
        : (SLOT_ORDER.find((k) => player.weapons[k] && player.weapons[k].owned) || 'deagle');
      player.cur = fb === key ? 'deagle' : fb;
      player.aiming = false; buildViewmodel(player.cur);
    }
  }
  if (player.last === key && !w.owned) player.last = 'deagle';
  AudioSys.click(700, 0.05, 0.25);
  updateHUD();
  return true;
}
function dropAllOnDeath() {
  // CS: your best gun hits the floor where you fall (both, if you were dual wielding)
  const pk = primaryKey();
  const key = pk || (player.weapons.deagle && player.weapons.deagle.owned ? 'deagle' : null);
  if (key) dropWeapon(key, { both: true, fromDeath: true });
}

// What pressing E on this weapon would do (null = nothing useful).
function pickupAction(e) {
  const w = player.weapons[e.key];
  if (!w) return null;
  if (!w.owned) {
    if (PRIMARIES.includes(e.key)) { const pk = primaryKey(); return pk ? { kind: 'swap', auto: false, label: `E — SWAP ${WEAPONS[pk].name} FOR ${WEAPONS[e.key].name}` } : { kind: 'take', auto: true }; }
    return { kind: 'take', auto: true };
  }
  if (!w.dual) return { kind: 'dual', auto: false, label: `E — DUAL WIELD ${WEAPONS[e.key].name}` };
  if (w.reserve < reserveCap(e.key, true) && (e.mag + e.reserve) > 0) return { kind: 'ammo', auto: false, label: `E — TAKE AMMO (${WEAPONS[e.key].name})` };
  return null;
}
function requestPickup(e) {
  const t = performance.now() / 1000;
  if (e.pendingUntil > t) return;
  e.pendingUntil = t + 1.5;
  if (isOnline()) { try { Net.sendWeapon({ action: 'pickup', wid: e.wid }); } catch (err) {} }
  else { removeWorldWeapon(e.wid); applyPickup(e); }
}
function applyPickup(d) {
  const key = d.key, def = WEAPONS[key], w = player.weapons[key];
  if (!def || !w || !player.alive) {
    // raced into death / bad data: put it back on the floor
    if (def) throwWeaponEntry(key, d.mag | 0, d.reserve | 0, true);
    return;
  }
  const mag = Math.min(def.magSize, d.mag | 0), reserve = d.reserve | 0;
  AudioSys.click(1300, 0.05, 0.3);
  setTimeout(() => AudioSys.click(950, 0.05, 0.25), 90);
  if (!w.owned) {
    if (PRIMARIES.includes(key)) { const pk = primaryKey(); if (pk) dropWeapon(pk, { both: true }); }
    w.owned = true; w.dual = false; w.mag = mag; w.mag2 = 0; w.reserve = Math.min(reserve, reserveCap(key, false));
    announce(`PICKED UP ${def.name}`, 800);
    if (PRIMARIES.includes(key) || !player.cur || !player.weapons[player.cur] || !player.weapons[player.cur].owned) {
      if (player.cur === key) buildViewmodel(key); else switchWeapon(key);
    }
  } else if (!w.dual) {
    w.dual = true; w.mag2 = mag;
    w.reserve = Math.min(reserveCap(key, true), w.reserve + reserve);
    announce(`DUAL ${def.name.toUpperCase()}S — LMB RIGHT · RMB LEFT`, 1400);
    player.aiming = false; player.reloading = 0; $('reload-tip').classList.add('hidden');
    if (player.cur === key) buildViewmodel(key); else switchWeapon(key);
  } else {
    w.reserve = Math.min(reserveCap(key, true), w.reserve + mag + reserve);
    announce(`+AMMO ${def.name}`, 700);
  }
  updateHUD();
}

let _pickupHintKey = '';
function setPickupHint(txt) {
  if (txt === _pickupHintKey) return;
  _pickupHintKey = txt;
  const el = $('pickup-hint');
  if (!el) return;
  if (!txt) el.classList.add('hidden'); else { el.textContent = txt; el.classList.remove('hidden'); }
}
function updateWorldWeapons(dt, t) {
  // --- physics: toss, bounce off walls, settle on floor / box tops ---
  const probe = new THREE.Vector3();
  for (const e of worldWeapons.values()) {
    if (e.rest) continue;
    e.vel.y -= 13.5 * dt;
    probe.set(e.pos.x + e.vel.x * dt, e.pos.y, e.pos.z);
    if (collidesAt(probe, 0.14, 0.12)) e.vel.x *= -0.35; else e.pos.x = clamp(probe.x, -MAP_HALF, MAP_HALF);
    probe.set(e.pos.x, e.pos.y, e.pos.z + e.vel.z * dt);
    if (collidesAt(probe, 0.14, 0.12)) e.vel.z *= -0.35; else e.pos.z = clamp(probe.z, -MAP_HALF, MAP_HALF);
    const prevY = e.pos.y;
    e.pos.y += e.vel.y * dt;
    const floor = supportHeightAt(e.pos.x, e.pos.z, prevY, 0.1);
    if (e.pos.y <= floor) {
      e.pos.y = floor;
      if (e.vel.y < -2.5) { e.vel.y *= -0.28; e.spin *= 0.5; try { AudioSys.step(e.pos.clone(), false); } catch (err) {} }
      else e.vel.y = 0;
      e.vel.x *= Math.max(0, 1 - dt * 7); e.vel.z *= Math.max(0, 1 - dt * 7);
      e.spin *= Math.max(0, 1 - dt * 6);
      if (e.vel.y === 0 && Math.hypot(e.vel.x, e.vel.z) < 0.12) {
        e.rest = true; e.vel.set(0, 0, 0);
        // the dropper settles the final resting spot for everyone
        if (e.mine && isOnline()) { try { Net.sendWeapon({ action: 'rest', wid: e.wid, x: e.pos.x, y: e.pos.y, z: e.pos.z, ry: e.ry }); } catch (err) {} }
      }
    }
    e.ry += e.spin * dt;
    e.mesh.position.copy(e.pos); e.mesh.rotation.y = e.ry;
  }
  // --- pickup ---
  const useQueued = player.useQueued; player.useQueued = false;
  if (!player.alive || G.phase !== 'playing' || G.roundEnding || G.buyOpen) { setPickupHint(''); return; }
  let best = null, bestD = PICKUP_RANGE;
  for (const e of worldWeapons.values()) {
    if (e.pendingUntil > t) continue;
    const dy = e.pos.y - player.pos.y;
    if (dy < -0.6 || dy > 1.4) continue;
    const d = Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z);
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) { setPickupHint(''); return; }
  const act = pickupAction(best);
  if (!act) { setPickupHint(''); return; }
  if (act.auto) {
    setPickupHint('');
    if (t >= best.noPickupUntil) requestPickup(best);
    return;
  }
  // E is shared with plant/defuse — the bomb always wins
  const bombBusy = (typeof playerNearPlantedBomb === 'function' && playerNearPlantedBomb()) || (player.hasBomb && typeof playerInPlantSite === 'function' && playerInPlantSite());
  if (bombBusy) { setPickupHint(''); return; }
  setPickupHint(act.label);
  if (useQueued) requestPickup(best);
}
function applyRemoteWeapon(m) {
  if (m.action === 'drop') {
    if (typeof m.wid !== 'string' || m.wid.length > 64 || !WEAPONS[m.key]) return;
    if (!isFinite(+m.x + +m.y + +m.z)) return;
    spawnWorldWeapon({ wid: m.wid, key: m.key, mag: clamp(m.mag | 0, 0, 50), reserve: clamp(m.reserve | 0, 0, 250), x: clamp(+m.x || 0, -MAP_HALF - 6, MAP_HALF + 6), y: clamp(+m.y || 0, -1, 12), z: clamp(+m.z || 0, -MAP_HALF - 6, MAP_HALF + 6), vx: +m.vx || 0, vy: +m.vy || 0, vz: +m.vz || 0, ry: +m.ry || 0 });
  } else if (m.action === 'rest') {
    const e = worldWeapons.get(m.wid);
    if (e && isFinite(+m.x + +m.y + +m.z)) { e.pos.set(+m.x || 0, +m.y || 0, +m.z || 0); e.ry = +m.ry || e.ry; e.vel.set(0, 0, 0); e.rest = true; e.mesh.position.copy(e.pos); e.mesh.rotation.y = e.ry; }
  } else if (m.action === 'pickup') {
    const local = removeWorldWeapon(m.wid);
    if (m.byId === Net.id) applyPickup(local || m);
  } else if (m.action === 'deny') {
    removeWorldWeapon(m.wid);
  } else if (m.action === 'sync') {
    for (const d of (m.drops || [])) spawnWorldWeapon({ ...d, rest: true, vx: 0, vy: 0, vz: 0 });
  }
}
// Second gun on a third-person soldier (remotes): mirrored on the left side of the chest.
function setSoldierDual(mesh, key, dual) {
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
  buildGunModel(want, _worldGunMats, holder, holder, { world: true });
  holder.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  gl.userData.model = want;
  gunG.parent.add(gl);
  ud.gunL = gl;
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
// momentum ragdoll: corpse is knocked along the bullet/blast, tips over onto
// its back/front/side (biased by shot dir vs facing), limbs sprawl, then rests.
// Headless corpses (head-pop) keep the stump hidden-face and bleed out.
function updateDeadBots(dt) {
  for (const b of bots) {
    if (b.alive) continue;
    if (b.exploded) {
      // nothing left to animate — just the pool spreading where they used to be
      b.deathT = Math.min(6.0, (b.deathT || 0) + dt);
      if (b.deathT < 5.0) {
        try {
          bloodFountain(new THREE.Vector3(b.pos.x, 0.18, b.pos.z), dt, 1.6);
          if (Math.random() < dt * 2.2) spawnBloodPool(b.pos.x + rand(-1.1, 1.1), b.pos.z + rand(-1.1, 1.1), Math.random() < 0.4);
        } catch (e) {}
      }
      if (b.blob) b.blob.visible = false;
      continue;
    }
    if (!b.mesh.visible) continue;
    b.deathT = Math.min(1.6, (b.deathT || 0) + dt);
    updateRagdoll(b.mesh, dt);
    const { k, e: ease } = corpseK(b.deathT);
    const fall = b.fall || { dirX: 0, dirZ: 1, spin: 0, roll: 0, power: 1 };
    try {
      // knockback slide + hop: fast out, friction stop
      if (b.deathPos && b.knock) {
        const slide = 1 - ease;
        b.mesh.position.set(
          b.deathPos.x + b.knock.x * ease,
          0.05 + Math.sin(Math.min(1, k * 1.3) * Math.PI) * 0.10 * (fall.power || 1) * (1 - k),
          b.deathPos.z + b.knock.z * ease
        );
        try { slideCorpseOut(b.mesh, 0.5); } catch (e) {}
        // keep logical pos glued to the corpse so blood pools / bomb drops line up
        b.pos.set(b.mesh.position.x, 0, b.mesh.position.z);
        void slide;
      } else {
        b.mesh.position.y = 0.05 + Math.sin(Math.min(1, k * 1.3) * Math.PI) * 0.08 * (1 - k);
      }
      // tip-over: forward/back from shot-vs-facing + sideways roll + yaw spin
      const fwdX = Math.sin(b.yaw || 0), fwdZ = Math.cos(b.yaw || 0);
      const fwdDot = (fall.dirX || 0) * fwdX + (fall.dirZ || 0) * fwdZ;
      const sideDot = (fall.dirX || 0) * fwdZ - (fall.dirZ || 0) * fwdX;
      const tipMag = Math.PI / 2 * (0.92 + Math.min(0.35, (fall.power || 1) * 0.1));
      // falling forward (shot from behind) pitches face-down (+x), from front falls back
      const targetRX = (fwdDot >= 0 ? tipMag : -tipMag) * (0.75 + Math.abs(fwdDot) * 0.45);
      const targetRZ = clamp(-sideDot * tipMag * 0.9 + (fall.roll || 0), -1.2, 1.2);
      b.mesh.rotation.x = targetRX * ease;
      b.mesh.rotation.z = targetRZ * ease;
      b.mesh.rotation.y = (b.yaw || 0) + (fall.spin || 0) * ease;
      // headless stump: keep neck bleeding briefly after landing
      // open wounds keep pumping long after the body lands
      if (b.headless && b.deathT < 6.0) {
        try {
          const sp = new THREE.Vector3(b.pos.x, Math.max(0.12, 1.0 - ease * 0.75), b.pos.z);
          bloodFountain(sp, dt, 1 + (b.exploded ? 0.8 : 0));
          if (Math.random() < dt * 1.6) spawnBloodPool(b.pos.x + rand(-0.6, 0.6), b.pos.z + rand(-0.6, 0.6), false);
        } catch (e) {}
      }
    } catch (e) {}
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
// Spawn helpers: pick a slot, and face the way out of the pocket (toward mid on your side)
// instead of the map origin, which from most slots is a wall.
function spawnList(team) { return team === 't' ? spawns.t : spawns.ct; }
function spawnPoint(team, slot, jitter = 0.4) {
  const list = spawnList(team), n = list.length;
  return list[((slot % n) + n) % n].clone().add(new THREE.Vector3(rand(-jitter, jitter), 0, rand(-jitter, jitter)));
}
function spawnLookTarget(team, pos) { const sz = pos.z < 0 ? -1 : 1; return team === 't' ? [-18, 4 * sz] : [14, 4 * sz]; }
function spawnYawPlayer(team, pos) { const [tx, tz] = spawnLookTarget(team, pos); return Math.atan2(pos.x - tx, pos.z - tz); } // camera convention
function spawnYawMesh(team, pos) { const [tx, tz] = spawnLookTarget(team, pos); return Math.atan2(tx - pos.x, tz - pos.z); }     // mesh convention
// Online: rank among same-team humans by server id, so every client agrees and nobody stacks.
function mySpawnSlot() {
  const team = player.team || 'ct';
  if (!isOnline() || Net.id == null) return 0;
  const ids = [Net.id];
  try { for (const r of Net.remoteList()) if ((r.team || 't') === team) ids.push(r.id); } catch (e) {}
  ids.sort((a, b) => a - b);
  return Math.max(0, ids.indexOf(Net.id));
}
// Solo default: the player holds slot 0 of their team, so their team's bots start one slot later.
function botDefaultSlot(bot) { return bot.idx + (bot.team === (player.team || 'ct') ? 1 : 0); }
function makeBot(team, idx) {
  const mesh = makeSoldier(team);
  try { setSoldierGun(mesh, 'ak'); } catch (e) {}
  scene.add(mesh);
  const spawn = spawnPoint(team, idx + (team === (player.team || 'ct') ? 1 : 0), 0);
  const bot = {
    team, idx, mesh, pos: spawn.clone(), vel: new THREE.Vector3(),
    yaw: spawnYawMesh(team, spawn), hp: 100, alive: true,
    respawnAt: 0, speed: rand(3.4, 4.6), state: 'roam',
    wp: waypoints.length ? randPick(waypoints).clone() : spawn.clone(), target: null,
    nextThink: Math.random() * 0.5, nextShot: 0, burstLeft: 0, burstAt: 0,
    ammo: 30, reloadUntil: 0,
    strafeDir: 1, strafeAt: 0, flashAt: 0, walkPhase: Math.random() * 6,
    flinchT: 0, flinchHead: false, deathT: 0, blob: null,
    hasBomb: false, guardSite: team === 'ct' ? (idx < 2 ? 'A' : 'B') : null,
    siteOffset: new THREE.Vector3(rand(-2, 2), 0, rand(-2, 2)),
    planting: false, defusing: false,
    blindUntil: 0,
    nades: team === 't' ? { he: 1, flash: 1, smoke: 1, molotov: 0 } : { he: 1, flash: 1, smoke: 0, molotov: 1 },
    _nadeAt: 0, _smokeAt: 0, _molyAt: 0,
    name: (team === 'ct' ? ['Blaze', 'Falcon', 'Havoc', 'Ghost'][idx] : ['Viper', 'Rattler', 'Jackal', 'Scorpion'][idx]) + (team === 'ct' ? ' [CT]' : ' [T]'),
    short: team === 'ct' ? ['Blaze', 'Falcon', 'Havoc', 'Ghost'][idx] : ['Viper', 'Rattler', 'Jackal', 'Scorpion'][idx],
    kills: 0, deaths: 0, assists: 0,
  };
  mesh.position.copy(spawn);
  mesh.rotation.y = bot.yaw;
  try { bot.blob = makeBlob(1.25); if (bot.blob) bot.blob.position.set(spawn.x, 0.02, spawn.z); } catch (e) {}
  bots.push(bot);
  return bot;
}
function resetBot(bot) {
  bot.pos.copy(spawnPoint(bot.team, botDefaultSlot(bot)));
  bot.yaw = spawnYawMesh(bot.team, bot.pos);
  bot.hp = 100; bot.alive = true;
  bot.flinchT = 0; bot.flinchHead = false; bot.deathT = 0; bot._thudded = false; bot.exploded = false;
  bot.ammo = 30; bot.reloadUntil = 0; bot._animPrev = null; bot._vx = 0; bot._vz = 0;
  if (bot.mesh && bot.mesh.userData) bot.mesh.userData.anim = null;
  bot.headless = false; bot.gibbed = false; bot.fall = null; bot.knock = null; bot.deathPos = null;
  bot.wp = waypoints.length ? randPick(waypoints).clone() : bot.pos.clone();
  bot.target = null; bot.state = 'roam'; bot.mesh.visible = true;
  bot.path = null; bot.pathI = 0; bot._stuckT = 0; bot._stuckN = 0; bot._unstick = null;
  bot.lastSeenPos = null; bot.lastSeenAt = 0; bot.heardPos = null; bot.huntPos = null; bot._tgtKey = null;
  bot.reactAt = 0; bot._lookAt = null; bot._moving = false; bot.viaDone = false; bot.viaI = 0;
  try { botDepenetrate(bot); } catch (e) {}
  bot.hasBomb = false; bot.planting = false; bot.defusing = false;
  bot.blindUntil = 0; bot._nadeAt = 0; bot._smokeAt = 0; bot._molyAt = 0;
  bot.nades = bot.team === 't' ? { he: 1, flash: 1, smoke: 1, molotov: 0 } : { he: 1, flash: 1, smoke: 0, molotov: 1 };
  bot.siteOffset.set(rand(-2, 2), 0, rand(-2, 2));
  // CTs split to guard A/B; T objective assigned per-round in bombResetRound().
  if (bot.team === 'ct') bot.guardSite = bot.idx % 2 === 0 ? 'A' : 'B';
  try { restoreSoldierMesh(bot.mesh); } catch (e) {}
  bot.mesh.rotation.set(0, bot.yaw, 0);
  bot.mesh.position.copy(bot.pos);
  try { if (bot.blob) { bot.blob.visible = true; bot.blob.position.set(bot.pos.x, 0.02, bot.pos.z); } } catch (e) {}
}
function siteByName(n) { return SITES.find((s) => s.name === n); }
function isInSite(pos, site) {
  const dx = pos.x - site.x, dz = pos.z - site.z;
  return Math.hypot(dx, dz) < site.r;
}
// Which bombsite is this position standing in? (any site, not just the round's target)
function siteAt(pos) { for (const s of SITES) { if (isInSite(pos, s)) return s; } return null; }

// ---- Single-owner plant/defuse progress ----
// CS rule: one actor works the bomb at a time, and a hand-off restarts the bar.
// updateBot() and updateBomb() both run inside the same frame, so without the
// time stamp a bot and the player could each add dt to the *same* bar and finish
// a 3.2s plant in 1.6s. The stamp also tells us when nobody is working it, which
// is what drives decay.
function bombAdvancePlant(owner, site, dt, t) {
  const siteName = site ? site.name : null;
  if (BOMB.planter !== owner || BOMB.plantSite !== siteName) {
    BOMB.planter = owner; BOMB.plantSite = siteName; BOMB.plantProgress = 0;
  }
  if (BOMB._plantAdvT === t) return BOMB.plantProgress;
  BOMB._plantAdvT = t;
  BOMB.plantProgress += dt;
  return BOMB.plantProgress;
}
function bombAdvanceDefuse(owner, dt, t) {
  if (BOMB.defuser !== owner) { BOMB.defuser = owner; BOMB.defuseProgress = 0; }
  if (BOMB._defuseAdvT === t) return BOMB.defuseProgress;
  BOMB._defuseAdvT = t;
  BOMB.defuseProgress += dt;
  return BOMB.defuseProgress;
}
// Is someone other than `me` actively working the bomb right now?
function bombPlantBusy(me, t) { return !!BOMB.planter && BOMB.planter !== me && (t - BOMB._plantAdvT) < 0.25; }
function bombDefuseBusy(me, t) { return !!BOMB.defuser && BOMB.defuser !== me && (t - BOMB._defuseAdvT) < 0.25; }
// Bleed plant progress when nobody advanced it this frame (walked out, died, mid-air).
function bombDecayPlant(dt, t) {
  if (BOMB.planted || BOMB.plantProgress <= 0 || BOMB._plantAdvT === t) return;
  BOMB.plantProgress = Math.max(0, BOMB.plantProgress - dt * 1.5);
  if (BOMB.plantProgress <= 0) { BOMB.planter = null; BOMB.plantSite = null; }
}

function botEye(b) { return new THREE.Vector3(b.pos.x, b.pos.y + 1.55, b.pos.z); }
function botChest(b) { return new THREE.Vector3(b.pos.x, b.pos.y + 1.1, b.pos.z); }

function nearestEnemy(bot) {
  // Flashed bots see nothing (they wander until vision returns).
  try { if (bot.blindUntil && performance.now() / 1000 < bot.blindUntil) return null; } catch (e) {}
  let best = null, bestD = 1e9;
  const eye = botEye(bot);
  // Dynamic smokes deny vision: walls + smoke volumes both block acquisition.
  const vis = (p) => hasLOSClear(eye, p);
  // player? team-based (PvP-safe): bots only acquire opposite-team locals.
  if (player.alive && (player.team || 'ct') !== bot.team) {
    const p = new THREE.Vector3(player.pos.x, player.pos.y + 1.3 - 0.36 * (player.crouch || 0), player.pos.z);
    const d = eye.distanceTo(p);
    if (d < 55 && vis(p) && d < bestD) { bestD = d; best = { type: 'player', d }; }
  }
  for (const o of bots) {
    if (!o.alive || o.team === bot.team) continue;
    if (o.team === 'ct' && bot.team === 'ct') continue;
    const p = botChest(o);
    const d = eye.distanceTo(p);
    const visRange = bot.team === 't' ? 55 : 50;
    if (d < visRange && d < bestD && vis(p)) { bestD = d; best = { type: 'bot', bot: o, d }; }
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
    // Split the push like a real team: half take the side lane (long A / B tunnels),
    // half come through mid, then everyone collapses onto the site.
    if (!bot.viaDone) {
      const sz = tgt.z < 0 ? -1 : 1;
      const route = (bot.idx % 2 === 0)
        ? [[-26, 22], [0, 24], [20, 30]]   // outer lane (long A / B tunnels)
        : [[-10, 6], [4, 4]];              // through the middle
      let vi = bot.viaI || 0;
      while (vi < route.length) {
        const [vx, vz] = route[vi];
        if (Math.hypot(bot.pos.x - vx, bot.pos.z - sz * vz) < 3.5 || bot.pos.x > vx + 3) vi++; else break;
      }
      bot.viaI = vi;
      if (vi >= route.length) bot.viaDone = true;
      else return new THREE.Vector3(route[vi][0] + bot.siteOffset.x * 0.4, 0, sz * route[vi][1] + bot.siteOffset.z * 0.4);
    }
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
  bot.nextThink = t + rand(0.22, 0.45);
  const prevKey = bot._tgtKey || null;
  bot.target = nearestEnemy(bot);
  if (bot.target) {
    const key = bot.target.type === 'player' ? 'player' : bot.target.bot;
    const tp = bot.target.type === 'player' ? player.pos : bot.target.bot.pos;
    // Fresh contact (not just a flicker of the same fight): human reaction delay + an
    // initial aim error that settles as the bot tracks.
    if (key !== prevKey && (!bot.lastSeenAt || t - bot.lastSeenAt > 1.2)) {
      const diff = opts.difficulty || 1;
      bot.reactAt = t + rand(0.18, 0.42) / diff;
      if (!bot.aimOff) bot.aimOff = new THREE.Vector3();
      const e = rand(0.5, 1.2) / diff;
      bot.aimOff.set(rand(-e, e), rand(-e * 0.5, e * 0.8), rand(-e, e));
    }
    bot._tgtKey = key;
    if (!bot.lastSeenPos) bot.lastSeenPos = new THREE.Vector3();
    bot.lastSeenPos.set(tp.x, 0, tp.z); bot.lastSeenAt = t;
    if (bot.state !== 'combat') { bot.strafeAt = t + rand(0.5, 1.4); if (Math.random() < 0.5) bot.strafeDir *= -1; }
    bot.state = 'combat';
    { const ow = objectiveWaypoint(bot); if (ow.distanceTo(bot.wp) > 3) bot.wp.copy(ow); } // keep route progress during long-range contact
  } else {
    bot._tgtKey = null;
    // Lost sight / heard shots: go check where the enemy was, instead of forgetting.
    const huntPos = (bot.lastSeenPos && t - bot.lastSeenAt < 6) ? bot.lastSeenPos
      : (bot.heardPos && t - bot.heardAt < 5) ? bot.heardPos : null;
    const busyObjective = bot.hasBomb || (BOMB.planted && bot.team === 'ct') || bot.planting || bot.defusing;
    // Pre-plant CTs only clear nearby angles — they don't abandon their site to chase.
    const leashOk = !huntPos || !(bot.team === 'ct' && !BOMB.planted) || (() => {
      const g = siteByName(bot.guardSite || 'A');
      return !g || Math.hypot(huntPos.x - g.x, huntPos.z - g.z) < 13;
    })();
    // Pre-plant Ts stick to their lane; they only check contacts close to them.
    const tLeash = !huntPos || bot.team !== 't' || BOMB.planted || bot.pos.distanceTo(huntPos) < 11;
    if (huntPos && !busyObjective && leashOk && tLeash && bot.pos.distanceTo(huntPos) < 22) {
      bot.state = 'hunt'; bot.huntPos = huntPos;
    } else {
      bot.state = 'objective';
      const ow = objectiveWaypoint(bot);
      // Only re-target when the objective really changed or we've arrived — constant
      // re-rolling made bots jitter between points.
      if (ow.distanceTo(bot.wp) > 3 || (bot.pos.distanceTo(bot.wp) < 1.6 && Math.random() < 0.25)) bot.wp.copy(ow);
      // Holding CTs shuffle a little every few seconds, like a person fidgeting on an angle.
      if (bot.team === 'ct' && !BOMB.planted && bot.pos.distanceTo(bot.wp) < 1.6 && t > (bot._shuffleAt || 0)) {
        bot._shuffleAt = t + rand(5, 11);
        bot.siteOffset.set(rand(-2.5, 2.5), 0, rand(-2.5, 2.5));
        bot.wp.copy(objectiveWaypoint(bot));
      }
    }
  }
  if (bot.target && Math.random() < 0.3) { bot.burstLeft = 2 + (Math.random() * 3 | 0); bot.burstAt = t; }
}

// Drive a bot's rig from how it actually moved this frame. Reading real
// displacement (rather than the AI's intent) means collisions, stuck-on-corner
// stalls and knockback all read correctly in the legs.
function animateBotMesh(bot, dt, t) {
  const m = bot.mesh;
  if (!m || !m.userData || !m.userData.rig) return;
  if (!bot.alive) return; // ragdoll owns the mesh once dead
  if (!bot._animPrev) bot._animPrev = bot.pos.clone();
  const inv = dt > 1e-4 ? 1 / dt : 0;
  bot._vx = damp(bot._vx || 0, (bot.pos.x - bot._animPrev.x) * inv, 16, dt);
  bot._vz = damp(bot._vz || 0, (bot.pos.z - bot._animPrev.z) * inv, 16, dt);
  bot._animPrev.copy(bot.pos);
  // Look down the line to whatever it is aiming at.
  let pitch = 0;
  try {
    const tg = bot.target;
    const tp = tg ? (tg.type === 'player' ? player.pos : (tg.bot && tg.bot.alive ? tg.bot.pos : null)) : null;
    if (tp) {
      const dh = Math.hypot(tp.x - bot.pos.x, tp.z - bot.pos.z);
      pitch = clamp(Math.atan2((tp.y + 1.2) - (bot.pos.y + 1.55), Math.max(0.4, dh)), -1.1, 1.1);
    }
  } catch (e) {}
  animateSoldier(m, {
    vx: bot._vx, vz: bot._vz, yaw: m.rotation.y, pitch,
    grounded: true,
    crouch: !!bot.crouching,
    kneel: !!(bot.planting || bot.defusing),
    reloading: !!(bot.reloadUntil && t < bot.reloadUntil),
  }, dt, t);
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
  BOMB.plantProgress = 0; BOMB.plantingBot = null; BOMB.planter = null; BOMB.plantSite = null;
  BOMB.defuseProgress = 0; BOMB.defuser = null;
  BOMB._plantAdvT = -1; BOMB._defuseAdvT = -1;
  BOMB.explodeAt = 0; BOMB.exploded = false; BOMB.beepAt = 0; BOMB._tenSecWarned = false; BOMB._fastFused = false;
  if (isMultiplayer()) {
    // Pure PvP: no bot carrier — T players carry (player.hasBomb set in startRound).
    for (const b of bots) b.hasBomb = false;
    updateBombHUD(0);
    return;
  }
  // Solo: if player is T they carry the bomb; otherwise give it to a random T bot.
  for (const b of bots) b.hasBomb = false;
  if ((player.team || 'ct') === 't') {
    player.hasBomb = true;
    // No bot carrier when player is the T.
  } else {
    const aliveT = bots.filter((b) => b.team === 't');
    if (aliveT.length) {
      BOMB.carrier = randPick(aliveT);
      for (const b of aliveT) b.hasBomb = (b === BOMB.carrier);
    }
  }
  for (const b of bots) if (b.team === 'ct') { b.guardSite = b.idx % 2 === 0 ? 'A' : 'B'; b.wp.copy(objectiveWaypoint(b)); }
  for (const b of bots) if (b.team === 't') b.wp.copy(objectiveWaypoint(b));
  updateBombHUD(0);
}
function bombDropAt(pos, fromNet = false) {
  BOMB.droppedPos = pos.clone(); BOMB.droppedPos.y = 0;
  BOMB.carrier = null; BOMB.plantProgress = 0; BOMB.plantingBot = null; BOMB.planter = null; BOMB.plantSite = null;
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
  BOMB.droppedPos = null; BOMB.plantProgress = 0; BOMB.plantingBot = null; BOMB.planter = null; BOMB.plantSite = null;
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
  const wasPlanted = BOMB.planted;
  BOMB.planted = false; // stop the HUD timer — round is decided, mesh burns out visually
  BOMB.droppedPos = null; BOMB.carrier = null; BOMB.plantingBot = null; BOMB.planter = null; BOMB.plantSite = null;
  BOMB.defuser = null;
  AudioSys.bombDetonated();
  // Resolve the round BEFORE applying damage, so blast kills can't make
  // checkRoundEnd() hand the round to the wrong team mid-explosion.
  if (wasPlanted) {
    endRound('t', reason || '💥 BOMB DETONATED');
  } else {
    // A dropped C4 shot on the ground is not a T objective win — it destroys the
    // objective. Shooting it used to literally hand T the round.
    announce('💥 DROPPED C4 DESTROYED', 1800);
  }
  // The blast was pure VFX before: you could stand on the C4 through detonation
  // without losing a single HP.
  try {
    const gz = groundZero ? groundZero.clone() : p.clone().setY(0);
    const blastR = 12, killR = 6;
    const dmgAt = (d) => (d <= killR ? 500 : Math.round(500 * Math.max(0, 1 - (d - killR) / (blastR - killR))));
    // remotePos makes the damage indicator point at the blast; remoteName is what
    // the death screen credits the kill to.
    const src = { isPlayer: false, team: 't', weaponName: '💣 C4', remoteName: '💣 C4', remotePos: gz };
    for (const b of bots.slice()) {
      if (!b.alive) continue;
      const d = Math.hypot(b.pos.x - gz.x, b.pos.z - gz.z);
      if (d < blastR) damageBot(b, dmgAt(d), src, false, botChest(b), { explosive: true, weapon: 'C4', power: 2.4 });
    }
    if (player.alive) {
      const d = Math.hypot(player.pos.x - gz.x, player.pos.z - gz.z);
      if (d < blastR) damagePlayer(dmgAt(d), src, false);
    }
  } catch (e) { console.warn('c4 blast', e); }
  if (!wasPlanted) { try { checkRoundEnd(); } catch (e) {} }
}
function defuseBomb(byPlayer, t, fromNet = false) {
  if (G.roundEnding) return;
  try { if (isOnline() && !fromNet) Net.sendBomb({ action: 'defuse', by: player.name || 'CT' }); } catch {}
  bombClearMesh();
  BOMB.planted = false; BOMB.pos = null; BOMB.site = null;
  BOMB.defuseProgress = 0; BOMB.defuser = null;
  endRound('ct', byPlayer ? 'BOMB DEFUSED — YOU SAVED THE SITE!' : 'BOMB DEFUSED — CT WINS');
}
// ---- Remote bomb/round application (PvP sync, last-write-wins for bomb) ----
function applyRemoteBomb(m) {
  const t = performance.now() / 1000;
  const act = m.action;
  if (m.fromId != null && !remotes.get(m.fromId)) return; // unknown sender
  if (act === 'plant') {
    if (BOMB.planted) return;
    const site = siteByName(m.site || 'A') || SITES[0];
    const px = isFinite(+m.x) ? +m.x : site.x, pz = isFinite(+m.z) ? +m.z : site.z;
    // plant must be inside the site radius — no cross-map plants
    if (Math.hypot(px - site.x, pz - site.z) > site.r + 1.5) return;
    BOMB.planted = true; BOMB.site = site.name;
    BOMB.pos = new THREE.Vector3(px, 0, pz);
    BOMB.carrier = null; BOMB.droppedPos = null;
    BOMB.plantProgress = 0; BOMB.plantingBot = null; BOMB.planter = null; BOMB.plantSite = null;
    BOMB.explodeAt = t + BOMB_TIMER; BOMB.beepAt = t; BOMB._fastFused = false;
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
    endRound('ct', `BOMB DEFUSED BY ${m.by || m.fromName || 'CT'}`);
  } else if (act === 'drop') {
    if (BOMB.planted) return;
    const dx = +m.x || 0, dz = +m.z || 0;
    if (!isFinite(dx + dz) || Math.abs(dx) > MAP_HALF + 6 || Math.abs(dz) > MAP_HALF + 6) return;
    BOMB.droppedPos = new THREE.Vector3(dx, 0, dz);
    BOMB.carrier = null; BOMB.plantProgress = 0; BOMB.plantingBot = null; BOMB.planter = null; BOMB.plantSite = null;
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
function applyServerScore(m) {
  // Server is score authority: adopt its tally, never diverge on duplicates.
  if (m && m.score && typeof m.score.ct === 'number' && typeof m.score.t === 'number') {
    G.score.ct = m.score.ct; G.score.t = m.score.t;
    try { updateHUD(); } catch {}
  }
}
function applyRemoteRound(m) {
  if (m.action === 'start') {
    applyServerScore(m);
    // Guest follows host round numbering.
    if (typeof m.round === 'number' && m.round !== G.round) G.round = m.round;
    if (!G.roundEnding) return; // already live — ignore duplicate starts
    if (isOnline() && m.fromId != null && !remotes.get(m.fromId)) return;
    startRound(!!m.first, true);
  } else if (m.action === 'end') {
    if (G.phase !== 'playing' || G.roundEnding) { applyServerScore(m); return; }
    const w = m.winner === 'ct' ? 'ct' : m.winner === 'draw' ? 'draw' : 't';
    endRound(w, String(m.reason || '').slice(0, 80), true, m.score);
  }
}
function updateBombHUD(t) {
  const bar = $('bomb-status'), txt = $('bomb-text'), tmr = $('bomb-timer');
  if (!bar) return;
  if (G.phase !== 'playing') { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.classList.remove('planted', 'ct');
  if (BOMB.exploded) {
    bar.classList.add('planted');
    txt.textContent = '💥 C4 DETONATED';
    tmr.textContent = '0.0s';
    return;
  }
  if (BOMB.planted && BOMB.pos) {
    const left = Math.max(0, BOMB.explodeAt - t);
    if (left <= 10.0 && left > 0 && !BOMB._tenSecWarned && !G.roundEnding) {
      BOMB._tenSecWarned = true;
      AudioSys.tenSecWarning();
    }
    bar.classList.add('planted');
    txt.textContent = `💣 BOMB ON ${BOMB.site} — DEFUSE!`;
    tmr.textContent = left.toFixed(1) + 's';
  } else if (BOMB.droppedPos) {
    txt.textContent = `BOMB DROPPED — UNSTABLE, DO NOT SHOOT`;
    tmr.textContent = 'SITE ' + (BOMB.targetSite || 'A');
  } else if (BOMB.carrier && BOMB.carrier.alive) {
    bar.classList.add('ct');
    txt.textContent = `💣 ${BOMB.carrier.short} heading ${BOMB.targetSite}`;
    tmr.textContent = 'STOP THE PLANT';
  } else if (player.hasBomb && !BOMB.planted && (player.team || 'ct') === 't') {
    bar.classList.add('ct');
    txt.textContent = `💣 YOU — PLANT ON A / B`;
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
  // Magazines: bots now run dry and reload, which is where the reload pose comes from.
  if (t < (bot.reloadUntil || 0)) return;
  if (bot.ammo <= 0) {
    bot.reloadUntil = t + rand(2.1, 2.6);
    bot.ammo = 30; bot.burstLeft = 0;
    try { AudioSys.step(new THREE.Vector3(bot.pos.x, 1.0, bot.pos.z), false); } catch (e) {}
    return;
  }
  bot.ammo--;
  bot.nextShot = t + interval;
  const from = botEye(bot);
  const dist = from.distanceTo(targetPos);
  // Like a real player: shots fired on the move are far less accurate than planted ones.
  const spread = clamp(0.02 + dist * 0.0016, 0.02, 0.09) / Math.sqrt(diff) * (bot._moving ? 1.5 : 1);
  const dir = targetPos.clone().sub(from).normalize();
  dir.x += rand(-spread, spread); dir.y += rand(-spread, spread); dir.z += rand(-spread, spread);
  dir.normalize();
  fireHitscan({ team: bot.team, isPlayer: false, bot }, from, dir, { name: 'AK-47', damage: 11 * diff, headMult: 2.2, range: 90, tracer: 0xff9a5c, sound: 'rifle' }, t);
  bot.flashAt = t + 0.05;
  soldierFireKick(bot.mesh, 0.85);
}

// ---------------- Bot navigation: A* nav grid + human-like steering ----------------
// Bots used to steer in a straight line at a waypoint and slide along whatever wall
// was in between, which is how they got pinned in corners. Now every bot plans a
// real route over a walkable grid baked from the colliders, smooths it into natural
// corner-to-corner lines, keeps a little distance from walls and teammates, and
// notices when it stops making progress (then re-plans / sidesteps).
const BOT_R = 0.42;
const NAV = {
  cell: 0.4, n: 0, count: -1, blocked: null, clear: null, rects: null,
  g: null, par: null, seen: null, closed: null, heapI: null, heapF: null, gen: 1,
  budget: 0, frameT: -1,
};
const NAV_DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];

function navBuild() {
  const c = NAV.cell, n = Math.ceil((MAP_HALF * 2) / c), N = n * n;
  NAV.n = n; NAV.count = colliders.length;
  const blocked = new Uint8Array(N);
  const inf = BOT_R + 0.1;
  const rects = [];
  for (const b of colliders) {
    if (b.max.y < 0.05 || b.min.y > 1.7) continue; // same vertical span collidesAt() tests
    rects.push(b.min.x, b.min.z, b.max.x, b.max.z);
    const x0 = Math.max(0, Math.floor((b.min.x - inf + MAP_HALF) / c)), x1 = Math.min(n - 1, Math.floor((b.max.x + inf + MAP_HALF) / c));
    const z0 = Math.max(0, Math.floor((b.min.z - inf + MAP_HALF) / c)), z1 = Math.min(n - 1, Math.floor((b.max.z + inf + MAP_HALF) / c));
    for (let iz = z0; iz <= z1; iz++) {
      const cz = -MAP_HALF + (iz + 0.5) * c;
      if (cz < b.min.z - inf || cz > b.max.z + inf) continue;
      for (let ix = x0; ix <= x1; ix++) {
        const cx = -MAP_HALF + (ix + 0.5) * c;
        if (cx < b.min.x - inf || cx > b.max.x + inf) continue;
        blocked[iz * n + ix] = 1;
      }
    }
  }
  const edge = MAP_HALF - BOT_R - 0.1;
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const cx = -MAP_HALF + (ix + 0.5) * c, cz = -MAP_HALF + (iz + 0.5) * c;
    if (Math.abs(cx) > edge || Math.abs(cz) > edge) blocked[iz * n + ix] = 1;
  }
  // Clearance field (cells to nearest wall) so routes run down the middle of lanes.
  const clear = new Uint8Array(N).fill(255);
  const q = new Int32Array(N); let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (blocked[i]) { clear[i] = 0; q[qt++] = i; }
  while (qh < qt) {
    const i = q[qh++], d = clear[i];
    if (d >= 8) continue;
    const ix = i % n, iz = (i / n) | 0;
    if (ix > 0 && clear[i - 1] > d + 1) { clear[i - 1] = d + 1; q[qt++] = i - 1; }
    if (ix < n - 1 && clear[i + 1] > d + 1) { clear[i + 1] = d + 1; q[qt++] = i + 1; }
    if (iz > 0 && clear[i - n] > d + 1) { clear[i - n] = d + 1; q[qt++] = i - n; }
    if (iz < n - 1 && clear[i + n] > d + 1) { clear[i + n] = d + 1; q[qt++] = i + n; }
  }
  NAV.blocked = blocked; NAV.clear = clear; NAV.rects = new Float32Array(rects);
  NAV.g = new Float32Array(N); NAV.par = new Int32Array(N);
  NAV.seen = new Uint32Array(N); NAV.closed = new Uint32Array(N);
  NAV.heapI = new Int32Array(N * 8); NAV.heapF = new Float32Array(N * 8);
}
function navReady() { if (NAV.count !== colliders.length || !NAV.blocked) navBuild(); }
function navIdx(x, z) {
  const n = NAV.n, c = NAV.cell;
  const ix = clamp(Math.floor((x + MAP_HALF) / c), 0, n - 1), iz = clamp(Math.floor((z + MAP_HALF) / c), 0, n - 1);
  return iz * n + ix;
}
function navCellPos(i) {
  const n = NAV.n, c = NAV.cell;
  return new THREE.Vector3(-MAP_HALF + ((i % n) + 0.5) * c, 0, -MAP_HALF + (((i / n) | 0) + 0.5) * c);
}
function navNearestFree(i) {
  const B = NAV.blocked, n = NAV.n;
  if (!B[i]) return i;
  const ix = i % n, iz = (i / n) | 0;
  for (let r = 1; r < 30; r++) {
    let best = -1, bestD = 1e9;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
      const x = ix + dx, z = iz + dz;
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const j = z * n + x;
      if (!B[j] && dx * dx + dz * dz < bestD) { bestD = dx * dx + dz * dz; best = j; }
    }
    if (best >= 0) return best;
  }
  return -1;
}
// Can a body walk the straight segment a->b without touching any collider?
function navWalkable(a, b, inflate = BOT_R + 0.08) {
  navReady();
  const R = NAV.rects, ax = a.x, az = a.z, dx = b.x - a.x, dz = b.z - a.z;
  for (let k = 0; k < R.length; k += 4) {
    const x0 = R[k] - inflate, z0 = R[k + 1] - inflate, x1 = R[k + 2] + inflate, z1 = R[k + 3] + inflate;
    let tmin = 0, tmax = 1;
    if (Math.abs(dx) < 1e-9) { if (ax < x0 || ax > x1) continue; }
    else {
      let t1 = (x0 - ax) / dx, t2 = (x1 - ax) / dx;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;
    }
    if (Math.abs(dz) < 1e-9) { if (az < z0 || az > z1) continue; }
    else {
      let t1 = (z0 - az) / dz, t2 = (z1 - az) / dz;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
      if (tmin > tmax) continue;
    }
    return false;
  }
  return Math.abs(b.x) < MAP_HALF - 0.5 && Math.abs(b.z) < MAP_HALF - 0.5;
}
function navFindPath(from, to) {
  navReady();
  const n = NAV.n, B = NAV.blocked, CL = NAV.clear;
  const s = navNearestFree(navIdx(from.x, from.z)), goal = navNearestFree(navIdx(to.x, to.z));
  if (s < 0 || goal < 0) return null;
  const gen = ++NAV.gen;
  const G = NAV.g, P = NAV.par, S = NAV.seen, C = NAV.closed, HI = NAV.heapI, HF = NAV.heapF, cap = HI.length;
  const gx = goal % n, gz = (goal / n) | 0;
  let hn = 0;
  const push = (i, f) => {
    if (hn >= cap) return;
    let k = hn++;
    while (k > 0) { const p = (k - 1) >> 1; if (HF[p] <= f) break; HI[k] = HI[p]; HF[k] = HF[p]; k = p; }
    HI[k] = i; HF[k] = f;
  };
  const pop = () => {
    const top = HI[0], li = HI[--hn], lf = HF[hn];
    let k = 0;
    for (;;) {
      let ch = 2 * k + 1; if (ch >= hn) break;
      if (ch + 1 < hn && HF[ch + 1] < HF[ch]) ch++;
      if (HF[ch] >= lf) break;
      HI[k] = HI[ch]; HF[k] = HF[ch]; k = ch;
    }
    HI[k] = li; HF[k] = lf;
    return top;
  };
  const h = (i) => { const dx = Math.abs((i % n) - gx), dz = Math.abs(((i / n) | 0) - gz); return dx + dz - 0.5858 * Math.min(dx, dz); };
  S[s] = gen; G[s] = 0; P[s] = -1; push(s, h(s));
  let found = false, iters = 0;
  while (hn > 0) {
    const i = pop();
    if (C[i] === gen) continue;
    C[i] = gen;
    if (i === goal) { found = true; break; }
    if (++iters > 60000) break;
    const ix = i % n, iz = (i / n) | 0;
    for (const [ox, oz, cost] of NAV_DIRS) {
      const x = ix + ox, z = iz + oz;
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const j = z * n + x;
      if (B[j] || C[j] === gen) continue;
      if (ox && oz && (B[iz * n + x] || B[z * n + ix])) continue; // no corner cutting
      const cl = CL[j];
      const pen = cl <= 1 ? 2.2 : cl === 2 ? 0.9 : cl === 3 ? 0.35 : cl === 4 ? 0.1 : 0;
      const ng = G[i] + cost * (1 + pen);
      if (S[j] !== gen || ng < G[j]) { S[j] = gen; G[j] = ng; P[j] = i; push(j, ng + h(j)); }
    }
  }
  if (!found) return null;
  const raw = [];
  for (let i = goal; i >= 0; i = P[i]) raw.push(i);
  raw.reverse();
  const pts = raw.map(navCellPos);
  if (!B[navIdx(to.x, to.z)]) pts[pts.length - 1] = new THREE.Vector3(to.x, 0, to.z);
  // String-pull into long straight legs (what a person actually walks).
  const out = [];
  let anchor = new THREE.Vector3(from.x, 0, from.z), k = -1;
  while (k < pts.length - 1) {
    let j = k + 1;
    while (j + 1 < pts.length && navWalkable(anchor, pts[j + 1])) j++;
    out.push(pts[j]); anchor = pts[j]; k = j;
  }
  return out;
}

// Returns a unit {x,z} heading that follows the planned route toward `goal`,
// or null once within `arrive` metres. Also exposes bot._navLook (a point ahead to face).
function navSteer(bot, goal, t, arrive = 1.2) {
  navReady();
  if (NAV.frameT !== t) { NAV.frameT = t; NAV.budget = 3; }
  const gdx = goal.x - bot.pos.x, gdz = goal.z - bot.pos.z;
  if (gdx * gdx + gdz * gdz < arrive * arrive) { bot.path = null; return null; }
  if (!bot.pathGoal) bot.pathGoal = new THREE.Vector3(1e9, 0, 1e9);
  const goalMoved = bot.pathGoal.distanceToSquared(goal) > 2.0 * 2.0;
  const stale = t - (bot.pathT || 0) > 5;
  if (!bot.path || goalMoved || stale) {
    if (!bot.path || NAV.budget > 0) {
      NAV.budget--;
      bot.path = navFindPath(bot.pos, goal) || [new THREE.Vector3(goal.x, 0, goal.z)];
      bot.pathI = 0; bot.pathGoal.set(goal.x, 0, goal.z); bot.pathT = t; bot._shortcutAt = 0;
    }
  }
  const P = bot.path;
  let i = Math.min(bot.pathI || 0, P.length - 1);
  while (i < P.length - 1) {
    const dx = P[i].x - bot.pos.x, dz = P[i].z - bot.pos.z, d2 = dx * dx + dz * dz;
    if (d2 < 0.55 * 0.55) { i++; continue; }
    // walked past the corner already?
    const nx = P[i + 1].x - P[i].x, nz = P[i + 1].z - P[i].z;
    if (d2 < 1.5 * 1.5 && (-dx * nx - dz * nz) > 0) { i++; continue; }
    break;
  }
  if (i < P.length - 1 && t > (bot._shortcutAt || 0)) {
    bot._shortcutAt = t + 0.3;
    if (navWalkable(bot.pos, P[i + 1])) i++;
  }
  bot.pathI = i;
  const tg = P[i];
  let dx = tg.x - bot.pos.x, dz = tg.z - bot.pos.z;
  let d = Math.hypot(dx, dz);
  if (i === P.length - 1 && d < 0.45) return null; // as close as the walkable space allows
  dx /= d; dz /= d;
  const look = P[Math.min(i + 1, P.length - 1)];
  bot._navLook = d < 2.5 && look !== tg ? look : tg;
  return { x: dx, z: dz };
}

// A body overlapping a collider (spawn jitter into a crate, knockback, nade push)
// can't move at all — every axis step collides. Pop it out along the shallowest side.
function botDepenetrate(bot) {
  for (let k = 0; k < 4; k++) {
    const hit = collidesAt(bot.pos, BOT_R);
    if (!hit) return;
    const e = BOT_R + 0.02;
    const opts = [
      [hit.max.x + e - bot.pos.x, 1, 0], [bot.pos.x - (hit.min.x - e), -1, 0],
      [hit.max.z + e - bot.pos.z, 0, 1], [bot.pos.z - (hit.min.z - e), 0, -1],
    ].sort((a, b) => a[0] - b[0]);
    const [d, sx, sz] = opts[0];
    if (d > 1.5) { // deep inside something big: jump to the nearest walkable cell
      navReady();
      const j = navNearestFree(navIdx(bot.pos.x, bot.pos.z));
      if (j >= 0) { const c = navCellPos(j); bot.pos.x = c.x; bot.pos.z = c.z; }
      return;
    }
    bot.pos.x += sx * d; bot.pos.z += sz * d;
  }
}
// Personal space + "keep right" so teammates don't bulldoze each other in doorways.
function botSeparate(bot, dir) {
  let px = 0, pz = 0;
  for (const o of bots) {
    if (o === bot || !o.alive) continue;
    const ox = bot.pos.x - o.pos.x, oz = bot.pos.z - o.pos.z;
    const d = Math.hypot(ox, oz);
    if (d > 1.6 || d < 1e-4) continue;
    const w = (1.6 - d) / 1.6;
    px += (ox / d) * w * 1.3; pz += (oz / d) * w * 1.3;
    if (-(ox * dir.x + oz * dir.z) > 0) { px += dir.z * w * 0.6; pz -= dir.x * w * 0.6; } // pass on the right
  }
  if (px === 0 && pz === 0) return dir;
  let x = dir.x + px, z = dir.z + pz;
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}
const _probeV = new THREE.Vector3();
function botDirFree(bot, dx, dz, dist = 0.7) {
  _probeV.set(bot.pos.x + dx * dist, bot.pos.y, bot.pos.z + dz * dist);
  return !collidesAt(_probeV, BOT_R);
}
// Pick an open heading closest to the preferred yaw (used to peel off a wall).
function botOpenHeading(bot, yaw) {
  for (let k = 0; k < 8; k++) {
    for (const s of k ? [1, -1] : [1]) {
      const a = yaw + s * k * (Math.PI / 8);
      const x = Math.sin(a), z = Math.cos(a);
      if (botDirFree(bot, x, z, 0.8)) return { x, z };
    }
  }
  return null;
}
// Gunfire gives away position: nearby enemy bots turn toward it and may go check.
function botsHearShot(shooter, origin, t) {
  if (!shooter || isMultiplayer()) return;
  for (const b of bots) {
    if (!b.alive || b.team === shooter.team || (shooter.bot && shooter.bot === b)) continue;
    const d = Math.hypot(b.pos.x - origin.x, b.pos.z - origin.z);
    if (d > 40) continue;
    b._lookAt = new THREE.Vector3(origin.x, 0, origin.z);
    b._lookUntil = t + rand(1.5, 3);
    if (!b.target && (!b.lastSeenAt || t - b.lastSeenAt > 2)) {
      const err = d * 0.12;
      b.heardPos = new THREE.Vector3(origin.x + rand(-err, err), 0, origin.z + rand(-err, err));
      b.heardAt = t;
    }
    if (b.nextThink > t + 0.25) b.nextThink = t + rand(0.12, 0.3); // reaction, not telepathy
  }
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
  botDepenetrate(bot);
  if (t >= bot.nextThink) botThink(bot, t);
  let moveDir = null, speed = bot.speed;

  // --- Flash blindness: stagger in place, no shooting/thinking (CS full white) ---
  if (bot.blindUntil && t < bot.blindUntil) {
    // drift + cover eyes: slow stumble, yaw wanders
    bot.yaw += Math.sin(t * 3.1 + bot.idx * 2) * dt * 1.6;
    bot.target = null;
    m.position.copy(bot.pos);
    let dyB = bot.yaw - m.rotation.y;
    while (dyB > Math.PI) dyB -= Math.PI * 2; while (dyB < -Math.PI) dyB += Math.PI * 2;
    m.rotation.y += dyB * Math.min(1, dt * 4);
    try { updateBlob(bot, bot.pos.x, bot.pos.z, true, false); } catch (e) {}
    return;
  }

  // --- Molotov avoidance: never path through fire; flee if standing in it ---
  let fleeingFire = null;
  try {
    const myFire = inFire(bot.pos, 0.2);
    if (myFire) {
      const ax = bot.pos.x - myFire.pos.x, az = bot.pos.z - myFire.pos.z;
      const ad = Math.hypot(ax, az) || 1;
      moveDir = new THREE.Vector3(ax / ad, 0, az / ad);
      fleeingFire = moveDir.clone();
      speed = bot.speed * 1.25; // run out of the flames
      bot.wp.copy(objectiveWaypoint(bot)); // repath after escaping
    } else if (bot.wp && inFire(bot.wp, 0.6)) {
      // waypoint inside flames — sidestep to a free neighbor instead of walking in
      bot.wp.copy(objectiveWaypoint(bot));
      if (Math.random() < 0.6 && waypoints.length) {
        for (let tries = 0; tries < 6; tries++) {
          const cand = randPick(waypoints);
          if (!inFire(cand, 0.8)) { bot.wp.copy(cand); break; }
        }
      }
    }
    // CT molotov area-denial: toss at chokes when Ts push the guarded site
    if (!myFire && bot.team === 'ct' && (bot.nades.molotov || 0) > 0 && !BOMB.planted && !G.roundEnding && t > (bot._molyAt || 0)) {
      const guard = siteByName(bot.guardSite || 'A');
      let tNear = null;
      for (const o of bots) {
        if (!o.alive || o.team !== 't') continue;
        if (guard && Math.hypot(o.pos.x - guard.x, o.pos.z - guard.z) < 14) { tNear = o; break; }
      }
      if (tNear && bot.pos.distanceTo(tNear.pos) < 20 && bot.pos.distanceTo(tNear.pos) > 6) {
        bot.nades.molotov--;
        bot._molyAt = t + rand(18, 30);
        const aim = tNear.pos.clone().add(new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1)));
        botThrowNadeAt(bot, 'molotov', aim);
      }
    }
    // T smoke cover: pop site entries while pushing (once per push, mid-range)
    if (!myFire && bot.team === 't' && (bot.nades.smoke || 0) > 0 && !BOMB.planted && !G.roundEnding && t > (bot._smokeAt || 0)) {
      const tgt = siteByName(BOMB.targetSite || 'A');
      if (tgt) {
        const dSite = Math.hypot(bot.pos.x - tgt.x, bot.pos.z - tgt.z);
        if (dSite < 18 && dSite > 6) {
          bot.nades.smoke--;
          bot._smokeAt = t + rand(20, 34);
          botThrowNadeAt(bot, 'smoke', new THREE.Vector3(tgt.x + rand(-2, 2), 0, tgt.z + rand(-2, 2)));
        }
      }
    }
  } catch (e) {}

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

  // --- Plant attempt (carrier standing in ANY bombsite, holds still) ---
  // Was: only BOMB.targetSite counted, so a carrier that rotated to the other site
  // could stand on the plant spot forever and never arm. Any site is a legal plant.
  let isPlanting = false;
  if (bot.team === 't' && bot.hasBomb && !BOMB.planted && !G.roundEnding && !isFreeze()) {
    const tgt = siteAt(bot.pos);
    if (tgt) {
      // Only a point-blank fight aborts it. At 12m the carrier basically never
      // committed, so Ts routinely ran the clock out standing on the site.
      const enemyClose = bot.target && bot.target.d < 5;
      if (!enemyClose && !bombPlantBusy(bot, t)) {
        isPlanting = true;
        bot.planting = true;
        BOMB.plantingBot = bot;
        // Face site center while planting.
        bot.yaw = Math.atan2(tgt.x - bot.pos.x, tgt.z - bot.pos.z);
        bombAdvancePlant(bot, tgt, dt, t);
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
  if (!isPlanting) bot.planting = false;
  // Decay now happens once per frame in updateBomb(). Doing it here drained the bar
  // once per living bot, so an interrupted plant reset ~10x too fast on a full server.

  // --- Defuse attempt (CT near planted bomb, holds still) ---
  let isDefusing = false;
  if (bot.team === 'ct' && BOMB.planted && BOMB.pos && !G.roundEnding) {
    const dBomb = bot.pos.distanceTo(BOMB.pos);
    if (dBomb < 2.6) {
      const tAlive = bots.some((o) => o.alive && o.team === 't');
      const enemyClose = bot.target && bot.target.d < 6 && tAlive;
      // Only the closest CT defuses; others cover. If no defuser yet, claim it.
      // `!BOMB.defuser.alive` was true when the defuser was the string 'player',
      // so bots happily stole the bar out from under a defusing human.
      const claimable = !bombDefuseBusy(bot, t);
      if (!enemyClose && claimable) {
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
          bot.yaw = Math.atan2(BOMB.pos.x - bot.pos.x, BOMB.pos.z - bot.pos.z);
          // NB: don't set BOMB.defuser here — bombAdvanceDefuse() must see the owner
          // change so taking over from someone else restarts the bar.
          bombAdvanceDefuse(bot, dt, t);
          if (!bot._defTick || t - bot._defTick > 0.5) { bot._defTick = t; AudioSys.defuseTick(BOMB.pos); }
          if (BOMB.defuseProgress >= BOMB_DEFUSE_TIME) {
            defuseBomb(false, t);
            return;
          }
        }
      }
    }
  }
  // Ownership is sticky and decays in updateBomb(); clearing it here threw away a
  // nearly-finished defuse the instant the bot flinched off the bomb for one frame.
  if (!isDefusing) bot.defusing = false;

  // Planting / defusing bots stand still and don't shoot (CS interaction locks weapon).
  if (isPlanting || isDefusing) {
    m.position.copy(bot.pos);
    let dy0 = bot.yaw - m.rotation.y;
    while (dy0 > Math.PI) dy0 -= Math.PI * 2; while (dy0 < -Math.PI) dy0 += Math.PI * 2;
    m.rotation.y += dy0 * Math.min(1, dt * 10);
    return; // the kneel pose is driven by animateBotMesh()
  }

  if (bot.state === 'combat' && bot.target) {
    // burning bots don't strafe-shoot — they run
    if (fleeingFire) {
      moveDir = fleeingFire;
      speed = bot.speed * 1.25;
      bot.yaw = Math.atan2(moveDir.x, moveDir.z);
    } else {
    let tp = null;
    if (bot.target.type === 'player') tp = new THREE.Vector3(player.pos.x, player.pos.y + 1.2 - 0.36 * (player.crouch || 0), player.pos.z);
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
        const nd = navSteer(bot, new THREE.Vector3(tgt.x, 0, tgt.z), t, 1.0);
        if (nd) moveDir = new THREE.Vector3(nd.x, 0, nd.z);
        // Still snap-shoot while fleeing if very close? No — run.
      } else if (dist > 24 && bot.state === 'combat' && (bot.team === 't' || !BOMB.planted)) {
        // Long range: nobody sane stands in the open trading at 25m+. Keep moving to
        // the objective/lane (the route hugs cover) and take shots when they line up.
        const nd = navSteer(bot, bot.wp, t, 1.5);
        if (nd) { moveDir = new THREE.Vector3(nd.x, 0, nd.z); speed *= 0.85; }
        if (dist < 50) {
          const eye = botEye(bot);
          if (hasLOSClear(eye, tp)) {
            if (bot.aimOff) bot.aimOff.multiplyScalar(Math.exp(-dt * 2.6));
            if (t >= (bot.reactAt || 0)) botShoot(bot, t, bot.aimOff ? tp.clone().add(bot.aimOff) : tp.clone());
          }
        }
      } else {
        // strafe perpendicular, keep ideal range 8-18
        if (t > bot.strafeAt) { bot.strafeAt = t + rand(0.6, 1.5); bot.strafeDir *= -1; }
        const nx = dx / (dist || 1), nz = dz / (dist || 1);
        let mx = -nz * bot.strafeDir, mz = nx * bot.strafeDir;
        if (dist > 18) { mx += nx * 0.9; mz += nz * 0.9; }
        else if (dist < 7) { mx -= nx; mz -= nz; }
        moveDir = new THREE.Vector3(mx, 0, mz).normalize();
        // Don't strafe into a wall: reverse, and if both sides are blocked just hold.
        if (!botDirFree(bot, moveDir.x, moveDir.z)) {
          bot.strafeDir *= -1; bot.strafeAt = t + rand(0.6, 1.2);
          mx = -nz * bot.strafeDir; mz = nx * bot.strafeDir;
          if (dist > 18) { mx += nx * 0.9; mz += nz * 0.9; } else if (dist < 7) { mx -= nx; mz -= nz; }
          moveDir.set(mx, 0, mz).normalize();
          if (!botDirFree(bot, moveDir.x, moveDir.z)) moveDir = null;
        }
        // Counter-strafe rhythm: shift, stop, shoot, shift again.
        if (t > (bot._stopPhaseT || 0)) {
          bot._stopShoot = !bot._stopShoot;
          bot._stopPhaseT = t + (bot._stopShoot ? rand(0.35, 0.8) : rand(0.35, 0.9));
        }
        if (bot._stopShoot && dist < 35) moveDir = null;
        speed *= 0.7;
        // shoot if roughly LOS + aimed — smokes deny the shot (vision blocked)
        // combat HE/flash: close-range bots sometimes trade bullets for utility
        try {
          if ((bot.nades.he || 0) > 0 && dist > 9 && dist < 24 && Math.random() < dt * 0.10 && t > (bot._nadeAt || 0)) {
            bot.nades.he--;
            botThrowNadeAt(bot, 'he', tp.clone());
          } else if ((bot.nades.flash || 0) > 0 && dist > 8 && dist < 26 && Math.random() < dt * 0.08 && t > (bot._nadeAt || 0)) {
            bot.nades.flash--;
            // pop-flash above the enemy so it bursts in their face, then peek
            const pop = tp.clone().add(new THREE.Vector3(rand(-1, 1), 1.6, rand(-1, 1)));
            botThrowNadeAt(bot, 'flash', pop);
          }
        } catch (e) {}
        if (dist < 50) {
          const eye = botEye(bot);
          if (hasLOSClear(eye, tp)) {
            if (bot.aimOff) bot.aimOff.multiplyScalar(Math.exp(-dt * 2.6)); // aim settles while tracking
            const aimAt = bot.aimOff ? tp.clone().add(bot.aimOff) : tp.clone();
            if (t >= (bot.reactAt || 0)) botShoot(bot, t, aimAt);
          } else if (smokeBlocks(eye, tp) && Math.random() < dt * 0.5) {
            // blind-fire suppression through smoke: rare, wild, scary (no wallbang damage here)
            if (Math.random() < 0.3) botShoot(bot, t, tp.clone().add(new THREE.Vector3(rand(-2, 2), rand(-0.5, 1), rand(-2, 2))));
          }
        }
      }
    }
    } // end non-burning combat
  } else if (fleeingFire) {
    moveDir = fleeingFire;
    speed = bot.speed * 1.25;
    bot.yaw = Math.atan2(moveDir.x, moveDir.z);
  } else if (bot.state === 'hunt' && bot.huntPos) {
    // Clear the spot the enemy was last seen/heard, weapon up and facing it.
    const nd = navSteer(bot, bot.huntPos, t, 1.4);
    if (nd) {
      moveDir = new THREE.Vector3(nd.x, 0, nd.z);
      speed *= 0.8;
      const lx = bot.huntPos.x - bot.pos.x, lz = bot.huntPos.z - bot.pos.z;
      const lookFwd = bot._navLook || bot.huntPos;
      // face the threat when it's roughly ahead; otherwise look where we're walking
      const fx = lookFwd.x - bot.pos.x, fz = lookFwd.z - bot.pos.z;
      bot.yaw = (lx * fx + lz * fz) > 0 && hasLOS(botEye(bot), new THREE.Vector3(bot.huntPos.x, 1.4, bot.huntPos.z))
        ? Math.atan2(lx, lz) : Math.atan2(fx, fz);
    } else {
      bot.lastSeenPos = null; bot.heardPos = null; bot.huntPos = null;
      bot.state = 'objective'; bot.nextThink = t + rand(0.3, 0.8);
      bot.yaw += rand(-1.2, 1.2); // glance around
    }
  } else {
    const nd = navSteer(bot, bot.wp, t, 1.5);
    if (nd) {
      moveDir = new THREE.Vector3(nd.x, 0, nd.z);
      const lk = bot._navLook || bot.wp;
      bot.yaw = Math.atan2(lk.x - bot.pos.x, lk.z - bot.pos.z);
      // turn toward recent gunfire while walking
      if (bot._lookAt && t < (bot._lookUntil || 0)) bot.yaw = Math.atan2(bot._lookAt.x - bot.pos.x, bot._lookAt.z - bot.pos.z);
      // Walk (quieter, steadier) for the last stretch into a contested site.
      const site = bot.team === 't' && !BOMB.planted ? siteByName(BOMB.targetSite || 'A') : null;
      if (site && !bot.hasBomb && Math.hypot(site.x - bot.pos.x, site.z - bot.pos.z) < 12) speed *= 0.82;
    } else {
      // Reached objective: CTs hold an angle toward where Ts come from, Ts push on.
      if (bot._lookAt && t < (bot._lookUntil || 0)) {
        bot.yaw = Math.atan2(bot._lookAt.x - bot.pos.x, bot._lookAt.z - bot.pos.z);
      } else if (bot.team === 'ct' && !BOMB.planted) {
        const base = Math.atan2(-20 - bot.pos.x, (bot.pos.z * 0.4) - bot.pos.z);
        bot.yaw = base + Math.sin(t * 0.45 + bot.idx * 1.7) * 0.75;
      } else if (BOMB.planted) {
        const base = Math.atan2(-bot.pos.x, -bot.pos.z);
        bot.yaw = base + Math.sin(t * 0.5 + bot.idx * 2.3) * 1.1;
      } else if (waypoints.length && Math.random() < 0.02) {
        bot.wp.copy(objectiveWaypoint(bot));
      }
    }
  }
  if (moveDir && bot._unstick && t < bot._unstick.until) moveDir.set(bot._unstick.x, 0, bot._unstick.z);
  if (moveDir) {
    const sep = botSeparate(bot, moveDir);
    moveDir.set(sep.x, 0, sep.z);
    const step = moveDir.clone().multiplyScalar(speed * smokeSlowAt(_smokePt.set(bot.pos.x, bot.pos.y + 1, bot.pos.z)) * dt);
    smokePushAt(_smokePt.set(bot.pos.x, bot.pos.y + 1, bot.pos.z), moveDir.x * speed * dt * 8, moveDir.z * speed * dt * 8, 1);
    const ox = bot.pos.x, oz = bot.pos.z;
    moveWithCollision(bot.pos, step.x, step.z, BOT_R);
    // Progress watchdog: if we're pushing but barely moving, re-plan, then peel off
    // the obstacle, and as a last resort pick a different spot to go to.
    const moved = Math.hypot(bot.pos.x - ox, bot.pos.z - oz), want = speed * dt;
    if (want > 1e-4 && moved < want * 0.35) bot._stuckT = (bot._stuckT || 0) + dt;
    else { bot._stuckT = Math.max(0, (bot._stuckT || 0) - dt * 2); if (moved > want * 0.7) bot._stuckN = Math.max(0, (bot._stuckN || 0) - dt * 0.4); }
    if (bot._stuckT > 0.3) {
      bot._stuckT = 0; bot._stuckN = (bot._stuckN || 0) + 1;
      bot.path = null;
      const side = Math.random() < 0.5 ? 1 : -1;
      const h = botOpenHeading(bot, Math.atan2(moveDir.x, moveDir.z) + side * Math.PI / 2);
      if (h) bot._unstick = { x: h.x, z: h.z, until: t + rand(0.25, 0.5) };
      if (bot.state === 'combat') bot.strafeDir *= -1;
      if (bot._stuckN >= 3) {
        bot._stuckN = 0;
        bot.siteOffset.set(rand(-2, 2), 0, rand(-2, 2));
        if (bot.state === 'hunt') { bot.huntPos = null; bot.lastSeenPos = null; bot.heardPos = null; bot.state = 'objective'; }
        bot.wp.copy(objectiveWaypoint(bot));
      }
    }
    bot.walkPhase += dt * 9;
    // audible boots: interval scales with speed, fully 3D (distance + occlusion)
    if (bot._stepAt === undefined) bot._stepAt = 0;
    if (t > bot._stepAt) {
      bot._stepAt = t + clamp(2.1 / (speed || 4), 0.32, 0.55) * rand(0.9, 1.1);
      try { AudioSys.step(new THREE.Vector3(bot.pos.x, 0.9, bot.pos.z), false); } catch (e) {}
    }
  }
  bot._moving = !!moveDir && speed > 0.5;
  m.position.copy(bot.pos);
  // smooth yaw (people turn quickly but not instantly)
  let dy = bot.yaw - m.rotation.y;
  while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
  m.rotation.y += dy * Math.min(1, dt * 8);
  // Body pose (gait, aim, recoil, flinch, kneel) is driven once per frame by
  // animateBotMesh() from the loop, so every early-return path above still animates.
  if (bot.flinchT > 0) bot.flinchT = Math.max(0, bot.flinchT - dt);
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
      if (d < 2.8 && player.onGround) {
        if (keys['KeyE']) {
          // One defuser at a time. Taking over from a bot restarts the bar (CS rule),
          // and the frame stamp stops player + bot both advancing the same bar.
          bombAdvanceDefuse('player', dt, t);
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
          // Released E: keep the bar *and* the ownership. Clearing the owner here
          // meant resuming silently restarted the defuse from zero.
        }
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
    // Nobody advanced the bar this frame (died, walked off, let go of E) — decay it.
    // The old `!showDefuse` guard meant a CT standing on the bomb *not* defusing
    // froze the bar at 99% indefinitely, so any teammate could finish it instantly.
    if (BOMB.defuseProgress > 0 && BOMB._defuseAdvT !== t) {
      BOMB.defuseProgress = Math.max(0, BOMB.defuseProgress - dt * 0.6);
      if (BOMB.defuseProgress <= 0) BOMB.defuser = null;
    }
    updateBombHUD(t);
    return;
  }
  // --- T-side player pickup + plant (hold E inside a site) — works in solo and PvP ---
  if (!BOMB.planted && !G.roundEnding && player.alive && (player.team || 'ct') === 't') {
    // Pickup dropped bomb by walking over it.
    if (BOMB.droppedPos && !player.hasBomb) {
      if (player.pos.distanceTo(BOMB.droppedPos) < 1.8) {
        player.hasBomb = true; BOMB.droppedPos = null;
        bombClearMesh();
        announce('YOU PICKED UP THE BOMB — PLANT ON A OR B (HOLD E)', 1800);
        AudioSys.plantBeep();
        try { if (isOnline()) Net.sendBomb({ action: 'pickup' }); } catch {}
        updateBombHUD(t);
      }
    }
    // Plant inside either site while holding E.
    if (player.hasBomb && !BOMB.planted && !isFreeze()) {
      const inSite = siteAt(player.pos);
      // THE bug: the old code refused to even start the bar whenever any CT stood
      // within 10m — and said nothing, so holding E on the site just did nothing.
      // CS lets you plant under fire; getting shot is the interrupt, not proximity.
      if (inSite && !bombPlantBusy('player', t)) {
        if (!player.onGround) {
          // No mid-air plants.
          updateInteractHUD('LAND TO PLANT', BOMB.plantProgress / BOMB_PLANT_TIME, false);
          bombDecayPlant(dt, t);
          updateBombHUD(t);
          return;
        }
        if (keys['KeyE']) {
          const prog = bombAdvancePlant('player', inSite, dt, t);
          updateInteractHUD(`PLANTING ON ${inSite.name}…`, prog / BOMB_PLANT_TIME, false);
          if (Math.floor(t * 4) !== Math.floor((t - dt) * 4)) AudioSys.defuseTick(inSite.pos);
          if (prog >= BOMB_PLANT_TIME) {
            updateInteractHUD(null);
            plantBombByPlayer(inSite, t);
            return;
          }
          updateBombHUD(t);
          return;
        }
        updateInteractHUD(`HOLD E TO PLANT ON ${inSite.name}`, BOMB.plantProgress / BOMB_PLANT_TIME, false);
        bombDecayPlant(dt, t);
        updateBombHUD(t);
        return;
      }
    }
  }
  // Walked out of the site / died / lost the bomb: bleed the bar off. Previously it
  // just froze, so you could bank 3.1s of plant, leave, and finish instantly later.
  bombDecayPlant(dt, t);
  // Not planted: show carrier plant progress if actively planting.
  // Cooking a nade owns the interact bar — don't let the bomb tick wipe it.
  if (BOMB.plantingBot && BOMB.plantingBot.alive && BOMB.plantProgress > 0.05) {
    updateInteractHUD(`BOMB PLANTING ON ${BOMB.targetSite} — STOP THEM!`, BOMB.plantProgress / BOMB_PLANT_TIME, false);
  } else {
    // Player near dropped bomb? Just informational (CT can't pick up).
    if (!(isOnline() && (player.team || 'ct') === 't' && player.hasBomb)) updateInteractHUD(null);
  }
  updateBombHUD(t);
}

// ---------------- Tactical grenades (HE / Flash / Smoke / Molotov) ----------------
// Projectiles are simulated on every client from throw events (victim-applies damage,
// thrower only predicts hitmarkers). This keeps solo + PvP consistent with no extra RTT.
const nadeProjectiles = []; // {type, pos, vel, fuse, owner, mesh, spin, bounces, lastBounceSfx}
const tacticalSmokes = [];  // {pos, radius, born, until, puffs:[{mesh, seed}], drift}
const fireZones = [];       // {pos, radius, until, owner, light, flames:[], tickAt, burnSfxAt}
const NADE_GRAV = 9.0;          // CS-ish floaty arc (was 16.5 → short, heavy lobs)
const NADE_RADIUS = 0.07;
const _nadeTmp = { v: null };

function nadeOwnerName(o) {
  if (!o) return '???';
  if (o.isPlayer) return (player.name || 'YOU');
  if (o.bot) return o.bot.short || 'Bot';
  if (o.remoteName) return o.remoteName;
  return '???';
}
function nadeOwnerTeam(o) {
  if (!o) return 't';
  if (o.isPlayer) return (player.team || 'ct');
  if (o.team) return o.team;
  return 't';
}
function makeNadeMesh(type) {
  const g = new THREE.Group();
  try {
    const def = NADE_DEFS[type];
    const dark = new THREE.MeshStandardMaterial({ color: 0x1f2226, roughness: 0.5, metalness: 0.6 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.35, metalness: 0.85 });
    if (type === 'molotov') {
      const glass = new THREE.MeshStandardMaterial({ color: 0x3f6b2a, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.9 });
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.16, 10), glass);
      bottle.castShadow = true; g.add(bottle);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.04, 0.07, 8), glass);
      neck.position.y = 0.11; g.add(neck);
      const rag = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.06, 0.035), new THREE.MeshStandardMaterial({ color: 0xd8cfc0, roughness: 1 }));
      rag.position.y = 0.17; rag.rotation.z = 0.4; g.add(rag);
      const T = decalTextures();
      const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xff9a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
      gl.scale.setScalar(0.22); gl.position.y = 0.2; g.add(gl);
      g.userData.flame = gl;
    } else {
      const col = def ? def.color : 0x4d7c3a;
      const bodyM = new THREE.MeshStandardMaterial({ color: col, roughness: 0.55, metalness: 0.25 });
      let body;
      if (type === 'he') body = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 10), bodyM), body.scale.y = 1.15;
      else body = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.13, 12), bodyM);
      body.castShadow = true; g.add(body);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.035, 8), dark);
      cap.position.y = type === 'he' ? 0.078 : 0.082; g.add(cap);
      const lever = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.1, 0.01), steel);
      lever.position.set(0.05, 0.03, 0); lever.rotation.z = -0.12; g.add(lever);
      if (type === 'smoke') {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.02, 12), new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.6 }));
        g.add(band);
      }
    }
  } catch (e) {}
  return g;
}
// High-definition first-person nades: same silhouettes as makeNadeMesh
// (HE = green egg, flash = light-blue cylinder, smoke = grey cylinder + white band,
// molotov = bottle) so thrown + held types never get confused, with close-up
// detail: segment-dense bodies, caps, grooves, vents, labels, pin + lever.
function makeFirstPersonNadeMesh(type) {
  const g = new THREE.Group();
  try {
    const dark = new THREE.MeshStandardMaterial({ color: 0x1f2226, roughness: 0.45, metalness: 0.65 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.28, metalness: 0.9 });
    const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
    const pinLever = (py) => {
      mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.032, 12), dark, 0, py, 0);
      const lv = mesh(new THREE.BoxGeometry(0.016, 0.11, 0.012), steel, 0.056, py - 0.045, 0);
      lv.rotation.z = -0.12;
      mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.02, 8), steel, 0.045, py - 0.002, 0).rotation.z = Math.PI / 2;
      const ring = mesh(new THREE.TorusGeometry(0.016, 0.004, 8, 16), steel, -0.04, py + 0.005, 0);
      ring.rotation.y = Math.PI / 2;
      mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.028, 6), steel, -0.02, py + 0.005, 0).rotation.z = Math.PI / 2;
    };
    if (type === 'molotov') {
      const glass = new THREE.MeshStandardMaterial({ color: 0x3f6b2a, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.9 });
      mesh(new THREE.CylinderGeometry(0.048, 0.052, 0.17, 20), glass, 0, 0, 0);
      mesh(new THREE.CylinderGeometry(0.042, 0.046, 0.10, 16), new THREE.MeshStandardMaterial({ color: 0x8a4a12, roughness: 0.35 }), 0, -0.028, 0);
      for (const ry of [-0.05, 0.005]) { const rib = mesh(new THREE.TorusGeometry(0.050, 0.0025, 6, 24), glass, 0, ry, 0); rib.rotation.x = Math.PI / 2; }
      mesh(new THREE.CylinderGeometry(0.053, 0.053, 0.045, 16), new THREE.MeshStandardMaterial({ color: 0xd8cfc0, roughness: 0.9 }), 0, -0.01, 0);
      mesh(new THREE.CylinderGeometry(0.054, 0.054, 0.01, 16), new THREE.MeshStandardMaterial({ color: 0x8a2f22, roughness: 0.8 }), 0, 0.015, 0);
      mesh(new THREE.CylinderGeometry(0.02, 0.042, 0.07, 16), glass, 0, 0.12, 0);
      mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.028, 12), new THREE.MeshStandardMaterial({ color: 0x9a7a4a, roughness: 0.9 }), 0, 0.158, 0);
      const rag = mesh(new THREE.BoxGeometry(0.04, 0.075, 0.04), new THREE.MeshStandardMaterial({ color: 0xe2d9c6, roughness: 1 }), 0.012, 0.20, 0);
      rag.rotation.z = 0.35;
      const knot = mesh(new THREE.BoxGeometry(0.032, 0.03, 0.032), new THREE.MeshStandardMaterial({ color: 0xc9bfa8, roughness: 1 }), -0.012, 0.175, 0);
      knot.rotation.z = 0.5;
      const T = decalTextures();
      const gl = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xff9a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
      gl.scale.setScalar(0.22); gl.position.y = 0.24; g.add(gl);
    } else if (type === 'he') {
      const body = mesh(new THREE.SphereGeometry(0.062, 28, 20), new THREE.MeshStandardMaterial({ color: 0x4d7c3a, roughness: 0.5, metalness: 0.3 }));
      body.scale.y = 1.15;
      for (const gy of [-0.025, 0.008]) { const gr = mesh(new THREE.TorusGeometry(0.0615, 0.0022, 6, 28), dark, 0, gy, 0); gr.rotation.x = Math.PI / 2; }
      mesh(new THREE.CylinderGeometry(0.0625, 0.0625, 0.013, 24), new THREE.MeshStandardMaterial({ color: 0xd8b93a, roughness: 0.6 }), 0, 0.035, 0);
      mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.014, 12), dark, 0, -0.074, 0);
      pinLever(0.082);
    } else {
      const isFlash = type === 'flash';
      if (isFlash) {
        // Light-blue flashbang: tapered body, recessed waist channels,
        // vertical grip flutes, stepped collar + knurled bottom rim.
        const blue = new THREE.MeshStandardMaterial({ color: 0x8fc3ec, roughness: 0.32, metalness: 0.5 });
        const blueD = new THREE.MeshStandardMaterial({ color: 0x5d8ab5, roughness: 0.45, metalness: 0.55 });
        mesh(new THREE.CylinderGeometry(0.044, 0.048, 0.14, 28), blue, 0, 0, 0);
        for (const sy of [-0.032, -0.004, 0.024]) { const s = mesh(new THREE.TorusGeometry(0.0465, 0.0032, 6, 28), blueD, 0, sy, 0); s.rotation.x = Math.PI / 2; }
        for (let i = 0; i < 8; i++) {
          const a = i / 8 * Math.PI * 2;
          mesh(new THREE.BoxGeometry(0.006, 0.062, 0.004), blueD, Math.cos(a) * 0.0465, -0.002, Math.sin(a) * 0.0465).rotation.y = -a;
        }
        mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.01, 24), dark, 0, 0.072, 0);
        mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.008, 24), new THREE.MeshStandardMaterial({ color: 0x1d2f45, roughness: 0.6 }), 0, 0.054, 0);
        mesh(new THREE.CylinderGeometry(0.048, 0.049, 0.014, 24), dark, 0, -0.072, 0);
        const rim = mesh(new THREE.TorusGeometry(0.048, 0.0022, 6, 28), steel, 0, -0.064, 0); rim.rotation.x = Math.PI / 2;
      } else {
        const bodyCol = 0x7d8894;
        mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.14, 24), new THREE.MeshStandardMaterial({ color: bodyCol, roughness: 0.32, metalness: 0.55 }), 0, 0, 0);
        mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.012, 20), dark, 0, -0.07, 0);
        mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.035, 20), new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.55 }), 0, 0.048, 0);
        mesh(new THREE.CylinderGeometry(0.0485, 0.0485, 0.007, 20), dark, 0, 0.027, 0);
        for (let i = 0; i < 6; i++) {
          const a = i / 6 * Math.PI * 2;
          mesh(new THREE.BoxGeometry(0.01, 0.012, 0.006), dark, Math.cos(a) * 0.044, -0.048, Math.sin(a) * 0.044).rotation.y = -a;
        }
      }
      pinLever(0.088);
    }
  } catch (e) {}
  return g;
}
function nadeThrowOrigin(dir, forBot, botPos) {
  if (forBot && botPos) return new THREE.Vector3(botPos.x, botPos.y + 1.5, botPos.z).addScaledVector(dir, 0.4);
  try {
    if (camera) return new THREE.Vector3(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0), player.pos.z).addScaledVector(dir, 0.5);
  } catch (e) {}
  return new THREE.Vector3(player.pos.x, player.pos.y + 1.5, player.pos.z);
}
// Central spawn: used by player, bots, and remote replays (fromNet=true skips rebroadcast).
function throwNade(type, origin, vel, owner, fuseOverride, fromNet = false) {
  // bots/remote clients may still pass old long molotov fuses; CS2 airbursts at 2s
  if (type === 'molotov' && fuseOverride > NADE_DEFS.molotov.fuse) fuseOverride = NADE_DEFS.molotov.fuse;
  const def = NADE_DEFS[type];
  if (!def) return null;
  if (nadeProjectiles.length > 12) {
    const old = nadeProjectiles.shift();
    try { scene.remove(old.mesh); } catch (e) {}
  }
  const mesh = makeNadeMesh(type);
  mesh.position.copy(origin);
  scene.add(mesh);
  const fuse = (fuseOverride !== undefined && fuseOverride !== null) ? fuseOverride : def.fuse;
  const proj = {
    type, pos: origin.clone(), vel: vel.clone(), fuse,
    owner: { isPlayer: !!owner.isPlayer, team: nadeOwnerTeam(owner), bot: owner.bot || null, remoteName: owner.remoteName || null, remoteId: owner.remoteId ?? null, weaponName: def.name },
    mesh, spin: new THREE.Vector3(rand(-3, 3), rand(-6, 6), rand(-9, -5)),
    bounces: 0, born: performance.now() / 1000,
  };
  nadeProjectiles.push(proj);
  try { AudioSys.throwWhoosh(origin); } catch (e) {}
  if (!fromNet && isOnline() && owner.isPlayer) {
    try {
      Net.sendNade({
        action: 'throw', nade: type,
        x: origin.x, y: origin.y, z: origin.z,
        vx: vel.x, vy: vel.y, vz: vel.z, fuse,
      });
    } catch (e) {}
  } else if (!fromNet && isOnline() && owner.bot && isRoundHost()) {
    // Solo-with-guests: host relays bot throws so spectators see the same arcs.
    try {
      Net.sendNade({ action: 'throw', nade: type, x: origin.x, y: origin.y, z: origin.z, vx: vel.x, vy: vel.y, vz: vel.z, fuse, botShort: owner.bot.short || 'Bot', botTeam: owner.bot.team || 't' });
    } catch (e) {}
  }
  return proj;
}
// Ballistic solve for bots: pick an arc that lands near target (fixed 1.1s flight).
function botThrowNadeAt(bot, type, targetPos) {
  const def = NADE_DEFS[type];
  if (!def || !bot.alive) return null;
  if (bot._nadeAt && performance.now() / 1000 < bot._nadeAt) return null;
  const from = new THREE.Vector3(bot.pos.x, bot.pos.y + 1.5, bot.pos.z);
  const flight = clamp(from.distanceTo(targetPos) / 14, 0.6, 1.4);
  const vel = new THREE.Vector3(
    (targetPos.x - from.x) / flight,
    (targetPos.y + 0.2 - from.y) / flight + 0.5 * NADE_GRAV * flight,
    (targetPos.z - from.z) / flight
  );
  // clamp lob speed so close tosses don't rocket
  const sp = vel.length(), maxSp = def.throwPower + 2;
  if (sp > maxSp) vel.multiplyScalar(maxSp / sp);
  bot._nadeAt = performance.now() / 1000 + rand(9, 16); // per-bot utility cooldown
  try { AudioSys.pin(from); } catch (e) {}
  return throwNade(type, from, vel, { isPlayer: false, team: bot.team, bot }, def.fuse, false);
}
// ---- Player prime / release (CS2: pin on press, throw on release; LMB far · RMB short · both medium) ----
function playerPrimeNade(type, t, button = 0) {
  if (!player.alive || isFreeze() || G.roundEnding || G.phase !== 'playing') return false;
  if ((player.nades[type] || 0) <= 0) { announce(`${NADE_DEFS[type].name} EMPTY — PRESS B`, 1100); AudioSys.dryfire(); return false; }
  if (keys['KeyE'] && (playerNearPlantedBomb() || playerInPlantSite())) return false; // hands busy
  if (player.cook && player.cook.type === type) {
    // second button joins in → medium throw
    if (button === 0) player.cook.lmb = true; else player.cook.rmb = true;
    return true;
  }
  player.cook = { type, lmb: button === 0, rmb: button === 2, heldT: 0, strength: 1 };
  try { AudioSys.pin(); } catch (e) {}
  return true; // throw happens on release, fuse starts then (CS2)
}
// called from mouseup: throw once ALL held buttons are released; strength is decided by what was held
function playerReleaseNade(button) {
  const c = player.cook;
  if (!c) return;
  const both = c.lmb && c.rmb;
  if (button === 0) c.lmb = false; else if (button === 2) c.rmb = false;
  if (both) c.strength = 0.5;            // LMB+RMB = medium
  if (c.lmb || c.rmb) return;            // still holding the other button
  if (c.strength === 1 && button === 2 && !both) c.strength = 0; // RMB only = underhand
  if (player.alive && G.phase === 'playing' && !isFreeze() && !G.roundEnding && !G.buyOpen) playerThrowNade(c.type, c.strength);
  player.cook = null;
}
function nadeThrowVelocity(strength) {
  // CS: pitch nudged 10° upward at the horizon, fading to 0 at straight up/down
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  let pitch = e.x * 180 / Math.PI; // + = looking up
  pitch = pitch > 0 ? 10 + pitch * (80 / 90) : 10 + pitch * (100 / 90);
  const pr = pitch * Math.PI / 180, yaw = e.y;
  const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pr), Math.sin(pr), -Math.cos(yaw) * Math.cos(pr)).normalize();
  const s = clamp(strength, 0, 1);
  const speed = NADE_DEFS.he.throwPower * (0.3 + 0.7 * s);
  const vel = dir.multiplyScalar(speed);
  vel.x += player.vel.x * 1.1; vel.z += player.vel.z * 1.1;
  vel.y += (player.vel.y || 0) * 1.0; // jump-throws carry
  return vel;
}
function playerThrowNade(type, strength = 1) {
  if (typeof strength === 'boolean') strength = strength ? 0 : 1; // legacy (underhand flag)
  if (!player.alive || isFreeze() || G.roundEnding) { player.cook = null; return; }
  if ((player.nades[type] || 0) <= 0) { player.cook = null; return; }
  const def = NADE_DEFS[type];
  const vel = nadeThrowVelocity(strength);
  const dir = vel.clone().normalize();
  // spawn in front of the eye but never inside a wall
  const eye = new THREE.Vector3(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0) - 0.1, player.pos.z);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const reach = Math.max(0.05, Math.min(0.45, rayWallDist(eye, fwd, 0.6) - 0.15));
  const origin = eye.addScaledVector(fwd, reach);
  player.cook = null;
  player.nades[type]--;
  vmRig.kickV -= 4.5 * (0.5 + strength * 0.5); vmRig.kickRotV -= 5 * (0.4 + strength * 0.6); vmRig.shake += 0.002;
  vmRig.primeK = 0;
  throwNade(type, origin, vel, { isPlayer: true, team: player.team || 'ct' }, def.fuse, false);
  void dir;
  if (player.nades[type] <= 0) {
    const fb = (player.last && !isNadeKey(player.last) && player.weapons[player.last] && player.weapons[player.last].owned) ? player.last : (primaryKey() || 'deagle');
    setTimeout(() => { if (player.alive && player.cur === type && (player.nades[type] || 0) <= 0) switchWeapon(fb); }, 260);
  } else {
    setTimeout(() => { if (player.alive && player.cur === type) buildViewmodel(type); }, 260);
  }
  updateHUD();
}
function updateNadeCook(dt, t) {
  const c = player.cook;
  const want = c ? 1 : 0;
  vmRig.primeK = (vmRig.primeK || 0) + (want - (vmRig.primeK || 0)) * Math.min(1, dt * 12);
  if (c) c.heldT += dt;
}
// ---- Physics: gravity + axis-separated bounce off Box3 colliders + floor ----
const _nClosest = new THREE.Vector3(), _nN = new THREE.Vector3();
// Resolve sphere vs every collider box + floor. Returns the strongest contact normal (or null).
function nadeResolve(p, r) {
  let hitN = null, best = 0;
  if (p.pos.y < r) {
    p.pos.y = r; _nN.set(0, 1, 0);
    const vn = p.vel.y; if (vn < 0) { hitN = new THREE.Vector3(0, 1, 0); best = -vn; }
  }
  for (const b of colliders) {
    if (p.pos.x < b.min.x - r || p.pos.x > b.max.x + r || p.pos.y < b.min.y - r || p.pos.y > b.max.y + r || p.pos.z < b.min.z - r || p.pos.z > b.max.z + r) continue;
    _nClosest.set(clamp(p.pos.x, b.min.x, b.max.x), clamp(p.pos.y, b.min.y, b.max.y), clamp(p.pos.z, b.min.z, b.max.z));
    _nN.subVectors(p.pos, _nClosest);
    let d = _nN.length();
    if (d >= r) continue;
    if (d < 1e-5) {
      // centre inside the box: push out along the shallowest face
      const ex = [p.pos.x - b.min.x, b.max.x - p.pos.x, p.pos.y - b.min.y, b.max.y - p.pos.y, p.pos.z - b.min.z, b.max.z - p.pos.z];
      let k = 0; for (let i = 1; i < 6; i++) if (ex[i] < ex[k]) k = i;
      _nN.set(k === 0 ? -1 : k === 1 ? 1 : 0, k === 2 ? -1 : k === 3 ? 1 : 0, k === 4 ? -1 : k === 5 ? 1 : 0);
      p.pos.addScaledVector(_nN, ex[k] + r);
    } else {
      _nN.multiplyScalar(1 / d);
      p.pos.addScaledVector(_nN, r - d);
    }
    const vn = p.vel.dot(_nN);
    if (vn < 0 && -vn >= best) { best = -vn; hitN = _nN.clone(); }
  }
  return hitN ? { n: hitN, speed: best } : null;
}
function updateNades(dt, t) {
  updateNadeCook(dt, t);
  const r = NADE_RADIUS;
  for (let i = nadeProjectiles.length - 1; i >= 0; i--) {
    const p = nadeProjectiles[i];
    p.fuse -= dt;
    try { if (p.mesh.userData.flame) p.mesh.userData.flame.material.opacity = 0.6 + Math.sin(t * 30 + i) * 0.3; } catch (e) {}
    // substep so fast throws never tunnel through thin walls
    const steps = clamp(Math.ceil(p.vel.length() * dt / 0.05), 1, 8);
    const h = dt / steps;
    let removed = false;
    p.onGround = false;
    for (let s = 0; s < steps && !removed; s++) {
      p.vel.y -= NADE_GRAV * h;
      p.pos.addScaledVector(p.vel, h);
      if (tacticalSmokes.length) {
        const sd = smokeDensityAt(p.pos, t);
        if (sd > 0.25) {
          p.vel.multiplyScalar(1 - Math.min(0.5, 1.6 * h * sd)); // thick air inside the cloud
          smokePushAt(p.pos, p.vel.x * h * 2, p.vel.z * h * 2, sd);
          if (t - (p._smokeWispT || 0) > 0.09) {
            p._smokeWispT = t;
            try { spawnSmoke(p.pos, 0.45, 0.7, 0xd8d4cb); } catch (e) {} // visible trail in the cloud
          }
        }
      }
      const c = nadeResolve(p, r);
      if (!c) continue;
      const { n, speed } = c;
      const ground = n.y > 0.7;
      if (p.type === 'molotov' && ground) {
        // CS2: bottles bounce off walls but shatter on anything floor-like
        const at = p.pos.clone(); at.y -= r;
        removeNadeProj(i); removed = true;
        igniteMolotov(at, p.owner, t);
        break;
      }
      // reflect normal component with restitution, scrape tangential
      const vn = p.vel.dot(n);
      const e = speed < 1.2 ? 0 : 0.45;
      p.vel.addScaledVector(n, -(1 + e) * vn);
      const tanK = ground ? (speed < 1.2 ? 1 : 0.8) : 0.7;
      const vnAfter = p.vel.dot(n);
      p.vel.addScaledVector(n, -vnAfter).multiplyScalar(tanK).addScaledVector(n, vnAfter);
      if (ground && speed < 1.2) p.onGround = true;
      if (speed > 1.5 && t - (p.lastBounceSfx || 0) > 0.08) { p.lastBounceSfx = t; p.bounces++; nadeBounceSfx(p, speed > 8); }
      // bounce randomises the tumble a bit
      if (speed > 1.5) p.spin.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(Math.min(14, speed * 1.4));
    }
    if (removed) continue;
    if (p.onGround) {
      // rolling friction: CS nades slide/roll a little then stop
      const hs = Math.hypot(p.vel.x, p.vel.z);
      const dec = Math.max(0, hs - 6.5 * dt);
      if (hs > 1e-4) { p.vel.x *= dec / hs; p.vel.z *= dec / hs; }
      p.spin.multiplyScalar(Math.max(0, 1 - dt * 6));
    }
    p.speed = p.vel.length();
    p.mesh.position.copy(p.pos);
    p.mesh.rotation.x += p.spin.x * dt; p.mesh.rotation.y += p.spin.y * dt; p.mesh.rotation.z += p.spin.z * dt;
    if (p.onGround && p.speed < 0.4 && p.type !== 'molotov') {
      // settle lying on its side instead of balancing on a point
      p.mesh.rotation.x += (Math.PI / 2 - p.mesh.rotation.x % Math.PI) * Math.min(1, dt * 8);
      p.mesh.position.y = p.pos.y - r * 0.35;
    }
    if (p.pos.y < -5) { removeNadeProj(i); continue; }
    // smoke: CS2 checks for "stopped" after a short arm time
    if (p.type === 'smoke') {
      if ((t - p.born) > 0.6 && p.speed < 0.25) p.stillT = (p.stillT || 0) + dt; else p.stillT = 0;
      if (p.stillT > 0.2 || p.fuse < -6) {
        const at = p.pos.clone(), owner = p.owner;
        removeNadeProj(i); deploySmoke(at, owner, t);
      }
      continue;
    }
    if (p.fuse <= 0) {
      const at = p.pos.clone();
      const owner = p.owner;
      const type = p.type;
      removeNadeProj(i);
      if (type === 'he') detonateHE(at, owner, t, false);
      else if (type === 'flash') detonateFlash(at, owner, t, false);
      else if (type === 'molotov') molotovAirburst(at);
    }
  }
  updateTacticalSmokes(dt, t);
  updateFires(dt, t);
  updateFlashOverlay(t);
}
function molotovAirburst(at) {
  // CS2: a bottle that never finds the floor bursts harmlessly mid-air
  try { AudioSys.molotovIgnite(at); } catch (e) {}
  try {
    spawnFireball(at, 1.3, 0.25);
    spawnBurst(at, 0xff9a2a, 16, 5, 0.6, 0.12);
    spawnSmoke(at, 0.6, 1.0, 0x333333);
  } catch (e) {}
}
function nadeBounceSfx(p, hard = false) {
  try { AudioSys.nadeBounce(p.pos, hard); } catch (e) {}
  try { spawnBurst(p.pos, 0xcfc4ae, 3, 1.6, 0.25, 0.05); } catch (e) {}
}
function removeNadeProj(i) {
  const p = nadeProjectiles[i];
  try {
    scene.remove(p.mesh);
    p.mesh.traverse((o) => {
      try { if (o.isMesh) o.geometry.dispose(); } catch {}
      try { if (o.isMesh || o.isSprite) o.material.dispose(); } catch {}
    });
  } catch (e) {}
  nadeProjectiles.splice(i, 1);
}
function clearNades() {
  for (const p of nadeProjectiles) { try { scene.remove(p.mesh); } catch (e) {} }
  nadeProjectiles.length = 0;
  for (const s of tacticalSmokes) {
    try { for (const pf of s.puffs) { scene.remove(pf.mesh); if (!pf.core) pf.mesh.material.dispose(); } if (s.mat) s.mat.dispose(); } catch (e) {}
  }
  tacticalSmokes.length = 0;
  for (const f of fireZones) {
    try { for (const fl of f.flames) scene.remove(fl); if (f.light) scene.remove(f.light); if (f.smokeAt !== undefined) {} } catch (e) {}
  }
  fireZones.length = 0;
  try { updateInteractHUD(null); } catch (e) {}
}
// ---- HE: radial frag with wall-occluded falloff ----
function explodeDamage(pos, radius, baseDmg, owner, weaponLabel) {
  const oTeam = nadeOwnerTeam(owner);
  const oName = nadeOwnerName(owner);
  // bots (solo): direct authoritative damage
  for (const b of bots) {
    if (!b.alive) continue;
    if (b.team === oTeam) {
      // No friendly fire — but the thrower still staggers? Skip teammates entirely.
      if (!(owner.isPlayer && b === undefined)) continue;
    }
    // owner bot never hits itself at throw; still allow self-splash for plays
    const target = botChest(b);
    const d = pos.distanceTo(target);
    if (d > radius + 0.6) continue;
    let dmg = baseDmg * (1 - clamp(d / radius, 0, 1) * 0.92) * rand(0.9, 1.1);
    if (!hasLOS(pos, target)) dmg *= 0.25; // walls soak most of the blast
    if (dmg < 4) continue;
    const shooter = owner.isPlayer
      ? { team: oTeam, isPlayer: true, weaponName: weaponLabel }
      : { team: oTeam, isPlayer: false, bot: owner.bot || null, weaponName: weaponLabel };
    try {
      const bdir = target.clone().sub(pos).normalize();
      damageBot(b, dmg, shooter, false, target, { dir: bdir, weapon: weaponLabel, explosive: true, power: 2.1 });
    } catch (e) { damageBot(b, dmg, shooter, false, target); }
  }
  // local player (victim-authoritative: applies for ANY owner's blast we simulate)
  if (player.alive && G.phase === 'playing') {
    const eye = new THREE.Vector3(player.pos.x, player.pos.y + 1.2, player.pos.z);
    const d = pos.distanceTo(eye);
    if (d <= radius + 0.6) {
      const sameTeam = (player.team || 'ct') === oTeam && !owner.isPlayer;
      // Friendly bots' HEs don't hurt us (no friendly fire); our own HE does (cook risk).
      const isOwn = !!owner.isPlayer;
      if (!sameTeam || isOwn) {
        let dmg = baseDmg * (1 - clamp(d / radius, 0, 1) * 0.92) * rand(0.9, 1.1);
        if (!hasLOS(pos, eye)) dmg *= 0.25;
        if (dmg >= 4) {
          const shooter = owner.isPlayer
            ? { team: oTeam, isPlayer: true, weaponName: weaponLabel }
            : { team: oTeam, isPlayer: false, bot: owner.bot || null, remoteName: owner.remoteName || null, remote: null, weaponName: weaponLabel };
          // resolve remote ref for direction arrow when killed by a real player
          try {
            if (owner.remoteId != null && remotes.has(owner.remoteId)) shooter.remote = remotes.get(owner.remoteId);
          } catch (e) {}
          damagePlayer(dmg, shooter, false);
          if (!player.alive) {
            try {
              if (isOnline() && owner.remoteId != null) {
                Net.sendKilled({ killerId: owner.remoteId, killerName: oName, killerTeam: oTeam, victimId: Net.id, victimName: player.name || 'YOU', victimTeam: player.team || 'ct', weapon: weaponLabel, head: false });
              }
            } catch (e) {}
          }
        }
      }
    }
    // attacker-side hitmarker prediction for real enemies in the blast (visual only;
    // victims apply their own damage, kills come back via 'killed')
    if (owner.isPlayer) {
      try {
        let any = false;
        for (const [, e] of remotes) {
          if (!e.data || !e.data.alive) continue;
          if ((e.data.team || 't') === (player.team || 'ct')) continue;
          const rp = new THREE.Vector3(e.pos.x, e.pos.y + 1.1, e.pos.z);
          if (pos.distanceTo(rp) < radius && (hasLOS(pos, rp) || pos.distanceTo(rp) < radius * 0.4)) { any = true; break; }
        }
        if (any) { playerHitmark(false, false); AudioSys.hit(false); }
      } catch (e) {}
    }
  }
}
function detonateHE(at, owner, t, inHand = false) {
  const label = 'HE GRENADE';
  try { AudioSys.heBoom(at); } catch (e) {}
  try {
    spawnFireball(at.clone().add(new THREE.Vector3(0, 0.3, 0)), 3.2, 0.35);
    spawnShockwave(at, 7.5, 0.45);
    spawnBurst(at, 0xffd27a, 26, 10, 0.7, 0.16);
    spawnBurst(at, 0xff6a2a, 18, 7, 0.9, 0.2);
    spawnBurst(at, 0x555555, 14, 5, 1.3, 0.25);
    spawnSmoke(at.clone().add(new THREE.Vector3(0, 0.6, 0)), 1.0, 1.6, 0x4a4a4a);
    spawnDebris(at, opts.quality ? 10 : 5, 8, 8);
    spawnDecal('scorch', new THREE.Vector3(at.x, 0.06, at.z), new THREE.Vector3(0, 1, 0), 3.2, 0.9);
  } catch (e) {}
  try {
    muzzleLight.position.copy(at).add(new THREE.Vector3(0, 1, 0));
    muzzleLight.intensity = 10; muzzleLight.distance = 30;
  } catch (e) {}
  try {
    if (camera) {
      const d = camera.position.distanceTo(at);
      const k = clamp(1 - d / 38, 0, 1);
      vmRig.shake += 0.05 * k + (inHand ? 0.06 : 0);
      vmRig.fovKick += 4 * k;
    }
  } catch (e) {}
  // dynamic smoke interaction: blasts shred nearby cover
  try { disperseSmokes(at, 6.5, 6.0); } catch (e) {}
  explodeDamage(at, NADE_DEFS.he.radius, NADE_DEFS.he.damage, owner, label);
  try { if (isOnline() && owner.isPlayer && inHand) Net.sendNade({ action: 'boom', nade: 'he', x: at.x, y: at.y, z: at.z }); } catch (e) {}
}
// ---- Flash: LOS + facing + distance blindness for player, bots, remotes(feedback) ----
function flashPowerAt(viewPos, viewFwd, at) {
  const toFlash = at.clone().sub(viewPos);
  const d = toFlash.length();
  if (d > NADE_DEFS.flash.radius) return 0;
  if (!hasLOS(viewPos, at)) return 0; // walls fully protect (smoke does NOT — flashes burn through smoke)
  toFlash.normalize();
  const facing = viewFwd ? clamp(toFlash.dot(viewFwd), -1, 1) : 0;
  // looking straight at it = full; turned fully away = ~25% (peripheral + bounce)
  const angK = 0.25 + 0.75 * clamp((facing + 0.4) / 1.4, 0, 1);
  const distK = 1 - clamp(d / NADE_DEFS.flash.radius, 0, 1);
  return clamp(distK * angK * 1.25, 0, 1);
}
function detonateFlash(at, owner, t, inHand = false) {
  try { AudioSys.flashPop(at); } catch (e) {}
  try {
    spawnWorldFlash(at.clone().add(new THREE.Vector3(0, 0.3, 0)), 0xffffff, 3.2);
    spawnFireball(at.clone().add(new THREE.Vector3(0, 0.3, 0)), 1.6, 0.12);
    muzzleLight.position.copy(at); muzzleLight.intensity = 8; muzzleLight.distance = 26;
  } catch (e) {}
  // local player blindness
  try {
    if (player.alive && G.phase === 'playing') {
      const eye = new THREE.Vector3(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0), player.pos.z);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
      let p = flashPowerAt(eye, fwd, at);
      if (inHand && owner.isPlayer) p = 1; // cooking it in your face = full white
      if (p > 0.03) {
        const dur = p * NADE_DEFS.flash.blindMax;
        // a stronger flash refreshes the blind; a weaker one never shortens it
        if (t + dur > (player.flashUntil || 0)) { player.flashUntil = t + dur; player.flashMax = dur; flashAfterPending = true; }
        if (p > 0.5) { try { AudioSys.click(5200, 0.4, 0.10); } catch (e2) {} }
      }
    }
  } catch (e) {}
  // bots: blinded = can't acquire/shoot, wander (handled in updateBot/nearestEnemy)
  try {
    for (const b of bots) {
      if (!b.alive) continue;
      const eye = botEye(b);
      const dyaw = b.yaw;
      const fwd = new THREE.Vector3(Math.sin(dyaw), 0.05, Math.cos(dyaw)).normalize();
      const p = flashPowerAt(eye, fwd, at);
      if (p > 0.08) {
        b.blindUntil = t + p * NADE_DEFS.flash.blindMax * rand(0.85, 1.15);
        b.target = null; b.state = 'objective';
      }
    }
  } catch (e) {}
  // attacker feedback: any remote enemy caught gets a hitmarker tick
  try {
    if (owner.isPlayer) {
      let any = false;
      for (const [, e] of remotes) {
        if (!e.data || !e.data.alive) continue;
        if ((e.data.team || 't') === (player.team || 'ct')) continue;
        const eye = remoteEye(e);
        if (hasLOS(eye, at) && eye.distanceTo(at) < 20) { any = true; break; }
      }
      if (any) { playerHitmark(false, false); AudioSys.hit(false); announce('FLASHED ✨', 700); }
    }
  } catch (e) {}
  try { if (isOnline() && owner.isPlayer && inHand) Net.sendNade({ action: 'boom', nade: 'flash', x: at.x, y: at.y, z: at.z }); } catch (e) {}
}
let flashAfterPending = false;
function updateFlashOverlay(t) {
  try {
    const el = $('flash-overlay'), after = $('flash-after');
    if (!el) return;
    if (G.phase !== 'playing' || !player.alive) { el.style.opacity = 0; if (after) after.style.opacity = 0; return; }
    const left = (player.flashUntil || 0) - t;
    if (left <= 0) { el.style.opacity = 0; if (after) after.style.opacity = 0; player.flashMax = 0; return; }
    const total = Math.max(0.001, player.flashMax || left);
    const k = clamp(left / total, 0, 1);            // 1 → 0 over the blind
    const strong = clamp(total / NADE_DEFS.flash.blindMax, 0, 1);
    // CS2 feel: solid white hold, then an eased fade; the burned-in frame outlasts the white
    const white = k > 0.55 ? 1 : Math.pow(k / 0.55, 1.6);
    el.style.opacity = (white * (0.55 + 0.45 * strong)).toFixed(3);
    if (after) after.style.opacity = (Math.pow(k, 0.7) * 0.55 * strong).toFixed(3);
  } catch (e) {}
}
// grab the frame being looked at the moment the flash pops (must run right after renderer.render)
function captureFlashAfterimage() {
  if (!flashAfterPending) return;
  flashAfterPending = false;
  try {
    const c = $('flash-after'); if (!c) return;
    const src = renderer.domElement;
    c.width = Math.max(1, src.width >> 2); c.height = Math.max(1, src.height >> 2);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  } catch (e) {}
}
// ---- Dynamic smoke: grows, drifts on wind, fades; blocks AI vision ----
function deploySmoke(at, owner, t) {
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
function disperseSmokes(at, radius, lifeCut) {
  for (const s of tacticalSmokes) {
    if (s.pos.distanceTo(at) < radius + s.radius) {
      s.until = Math.min(s.until, performance.now() / 1000 + Math.max(2, (s.until - performance.now() / 1000) - lifeCut));
      s.dispersed = true;
    }
  }
}
// ponytail: smoke stays vision-only (CS rule) — bullets/nades/bodies only stir
// it and wade through it, never blocked by it. HE shreds via disperseSmokes.
const _smokePt = new THREE.Vector3();
function smokePushAt(p, vx, vz, power = 1) {
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
function smokeSlowAt(p) {
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
function smokeVolumeRadius(s, t) {
  const left = s.until - t;
  const fade = clamp(left / 3.0, 0, 1);
  return s.radius * (0.35 + 0.65 * smokeBloom(s, t)) * (0.6 + 0.4 * fade);
}
// 0..1 how deep a point sits inside a smoke (ellipsoid: wide dome, ~2.7 m tall above its centre)
function smokeDensityAt(p, t) {
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
function updateTacticalSmokes(dt, t) {
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
function smokeBlocks(a, b) {
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
function hasLOSClear(a, b) {
  // walls first (cheap), then dynamic smoke
  if (!hasLOS(a, b)) return false;
  return !smokeBlocks(a, b);
}
// ---- Molotov: shatter -> persistent fire zone with DPS + visuals ----
function igniteMolotov(at, owner, t) {
  const def = NADE_DEFS.molotov;
  try { AudioSys.molotovIgnite(at); } catch (e) {}
  const center = at.clone(); center.y = Math.max(0, at.y);
  // landed in a smoke → fizzles
  try {
    const tt = performance.now() / 1000;
    if (tacticalSmokes.some((s) => Math.hypot(s.pos.x - at.x, s.pos.z - at.z) < smokeVolumeRadius(s, tt) && Math.abs(s.pos.y - 1.1 - at.y) < 2.5)) {
      try { spawnSmoke(at.clone().add(new THREE.Vector3(0, 0.5, 0)), 1.0, 1.0, 0x9a9a9a); } catch (e) {}
      return;
    }
  } catch (e) {}
  center.x = clamp(center.x, -MAP_HALF + 0.5, MAP_HALF - 0.5);
  center.z = clamp(center.z, -MAP_HALF + 0.5, MAP_HALF - 0.5);
  if (fireZones.length >= 6) {
    const old = fireZones.shift();
    try { for (const fl of old.flames) scene.remove(fl); if (old.light) scene.remove(old.light); } catch (e) {}
  }
  const zone = {
    pos: center, radius: def.radius, until: t + def.duration,
    owner: { isPlayer: !!owner.isPlayer, team: nadeOwnerTeam(owner), bot: owner.bot || null, remoteName: owner.remoteName || null, remoteId: owner.remoteId ?? null, weaponName: 'MOLOTOV' },
    flames: [], light: null, tickAt: 0, burnSfxAt: 0, born: t,
    cells: [], parts: [], embers: [], glow: null, emitAcc: 0,
  };
  try {
    // --- fire only spreads over real surface, never through walls or off crate edges into the air
    const probeFrom = new THREE.Vector3(center.x, center.y + 0.35, center.z);
    const want = opts.quality ? 20 : 12;
    zone.cells.push({ x: center.x, z: center.z, igniteAt: t });
    for (let tries = 0; tries < 90 && zone.cells.length < want; tries++) {
      const a = rand(0, Math.PI * 2), rr = Math.sqrt(Math.random()) * def.radius;
      const x = center.x + Math.cos(a) * rr, z = center.z + Math.sin(a) * rr;
      if (zone.cells.some((c) => Math.hypot(c.x - x, c.z - z) < 0.55)) continue;
      if (!fireSupportAt(x, center.y, z)) continue;
      if (!hasLOS(probeFrom, new THREE.Vector3(x, center.y + 0.35, z))) continue;
      zone.cells.push({ x, z, igniteAt: t + (rr / def.radius) * 0.5 }); // spreads outward like spilled fuel
    }
    // --- flame particles (pooled billboards, additive)
    const ftex = flameTexture(), T = decalTextures();
    const nFl = opts.quality ? 90 : 40;
    for (let i = 0; i < nFl; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: ftex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      sp.visible = false; scene.add(sp); zone.flames.push(sp);
      zone.parts.push({ sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0, w: 1, h: 1, ph: 0 });
    }
    const nEm = opts.quality ? 18 : 8;
    for (let i = 0; i < nEm; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xffa040, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      sp.visible = false; scene.add(sp); zone.flames.push(sp);
      zone.embers.push({ sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0, ph: 0 });
    }
    // --- warm light pooled on the ground under the flames
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: T.glow, color: 0xff5a14, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2; glow.position.set(center.x, center.y + 0.07, center.z);
    glow.scale.setScalar(def.radius * 2.8);
    scene.add(glow); zone.flames.push(glow); zone.glow = glow;

    zone.light = new THREE.PointLight(0xff7a1e, 5, 14, 1.6);
    zone.light.position.set(center.x, center.y + 1.0, center.z);
    scene.add(zone.light);
    spawnDecal('scorch', new THREE.Vector3(center.x, center.y + 0.055, center.z), new THREE.Vector3(0, 1, 0), 4.6, 0.85);
    // shatter: glass + fuel splash + whoosh fireball
    spawnFireball(center.clone().add(new THREE.Vector3(0, 0.5, 0)), 2.0, 0.3);
    spawnBurst(center.clone().add(new THREE.Vector3(0, 0.2, 0)), 0x8fb07a, 12, 4, 0.5, 0.05);
    spawnBurst(center.clone().add(new THREE.Vector3(0, 0.3, 0)), 0xffa040, 22, 6, 0.6, 0.1);
  } catch (e) {}
  fireZones.push(zone);
}
function fireSupportAt(x, y, z) {
  if (Math.abs(x) > MAP_HALF - 0.3 || Math.abs(z) > MAP_HALF - 0.3) return false;
  if (collidesAt(new THREE.Vector3(x, y + 0.08, z), 0.15, 0.6)) return false; // inside a wall/crate
  if (y < 0.06) return true; // map floor
  for (const b of colliders) {
    if (Math.abs(b.max.y - y) < 0.2 && x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) return true;
  }
  return false;
}
let _flameTex = null;
function flameTexture() {
  if (_flameTex) return _flameTex;
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 92, 2, 32, 84, 58);
  gr.addColorStop(0, 'rgba(255,255,235,1)');
  gr.addColorStop(0.22, 'rgba(255,225,130,0.95)');
  gr.addColorStop(0.5, 'rgba(255,140,40,0.6)');
  gr.addColorStop(1, 'rgba(200,50,10,0)');
  g.filter = 'blur(4px)';
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(32, 6);
  g.bezierCurveTo(44, 40, 60, 70, 56, 98);
  g.bezierCurveTo(52, 122, 12, 122, 8, 98);
  g.bezierCurveTo(4, 70, 20, 40, 32, 6);
  g.fill();
  _flameTex = new THREE.CanvasTexture(c);
  return _flameTex;
}
function fireZoneContains(z, pos, pad = 0.2) {
  if (pos.y < z.pos.y - 0.4 || pos.y > z.pos.y + 1.6) return false;
  const t = performance.now() / 1000;
  for (const c of z.cells) if (t >= c.igniteAt && Math.hypot(pos.x - c.x, pos.z - c.z) < 0.7 + pad) return true;
  return false;
}
function inFire(pos, pad = 0.4) {
  for (const z of fireZones) if (fireZoneContains(z, pos, pad)) return z;
  return null;
}
const _fireCol = new THREE.Color();
function updateFires(dt, t) {
  for (let i = fireZones.length - 1; i >= 0; i--) {
    const z = fireZones[i];
    const left = z.until - t;
    if (left <= 0) {
      try { for (const fl of z.flames) scene.remove(fl); if (z.light) scene.remove(z.light); } catch (e) {}
      fireZones.splice(i, 1);
      continue;
    }
    // animate: pooled flame tongues rising off lit cells, embers, ground glow, flicker light
    try {
      const age = t - z.born;
      const intensity = clamp(left / 1.6, 0, 1) * clamp(age / 0.25, 0.3, 1);
      const lit = z.cells.filter((c) => t >= c.igniteAt);
      // emission
      z.emitAcc += dt * lit.length * 10 * intensity;
      let spawnN = Math.floor(z.emitAcc); z.emitAcc -= spawnN;
      for (const p of z.parts) {
        if (spawnN <= 0 || !lit.length) break;
        if (p.life > 0) continue;
        const c = lit[(Math.random() * lit.length) | 0];
        p.max = rand(0.45, 0.85); p.life = p.max;
        p.sp.position.set(c.x + rand(-0.32, 0.32), z.pos.y + 0.05, c.z + rand(-0.32, 0.32));
        p.vx = rand(-0.15, 0.15); p.vz = rand(-0.15, 0.15); p.vy = rand(1.1, 1.9);
        p.w = rand(0.55, 0.95) * (0.6 + 0.4 * intensity); p.h = p.w * rand(1.6, 2.3); p.ph = rand(0, 6.28);
        p.sp.material.rotation = rand(-0.2, 0.2);
        p.sp.visible = true; spawnN--;
      }
      for (const p of z.parts) {
        if (p.life <= 0) continue;
        p.life -= dt;
        if (p.life <= 0) { p.sp.visible = false; p.sp.material.opacity = 0; continue; }
        const k = 1 - p.life / p.max; // 0 → 1 over the tongue's life
        p.sp.position.x += (p.vx + Math.sin(t * 9 + p.ph) * 0.25) * dt;
        p.sp.position.z += (p.vz + Math.cos(t * 8 + p.ph) * 0.25) * dt;
        p.sp.position.y += p.vy * dt;
        p.vy *= (1 - dt * 0.6);
        const grow = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) * 0.85;
        p.sp.scale.set(p.w * grow * (1 - k * 0.3), p.h * grow, 1);
        // white-yellow core → orange → deep red as it cools
        if (k < 0.35) _fireCol.setRGB(1, 0.95 - k * 1.2, 0.7 - k * 1.8);
        else _fireCol.setRGB(1 - (k - 0.35) * 0.6, 0.53 - (k - 0.35) * 0.65, 0.07);
        p.sp.material.color.copy(_fireCol);
        p.sp.material.opacity = Math.pow(1 - k, 0.8) * 0.95;
      }
      // embers
      for (const e of z.embers) {
        if (e.life <= 0) {
          if (lit.length && Math.random() < dt * 3 * intensity) {
            const c = lit[(Math.random() * lit.length) | 0];
            e.max = rand(0.8, 1.6); e.life = e.max;
            e.sp.position.set(c.x + rand(-0.3, 0.3), z.pos.y + 0.3, c.z + rand(-0.3, 0.3));
            e.vx = rand(-0.5, 0.5); e.vz = rand(-0.5, 0.5); e.vy = rand(1.8, 3.2); e.ph = rand(0, 6.28);
            e.sp.scale.setScalar(rand(0.04, 0.08)); e.sp.visible = true;
          }
          continue;
        }
        e.life -= dt;
        if (e.life <= 0) { e.sp.visible = false; continue; }
        e.sp.position.x += (e.vx + Math.sin(t * 5 + e.ph) * 0.4) * dt;
        e.sp.position.z += (e.vz + Math.cos(t * 4 + e.ph) * 0.4) * dt;
        e.sp.position.y += e.vy * dt; e.vy *= (1 - dt * 0.8);
        e.sp.material.opacity = (e.life / e.max) * (Math.sin(t * 40 + e.ph) > -0.3 ? 1 : 0.3);
      }
      if (z.glow) {
        const spread = clamp(age / 0.5, 0.3, 1);
        z.glow.scale.setScalar(z.radius * 2.8 * spread);
        z.glow.material.opacity = (0.35 + Math.sin(t * 19) * 0.06 + Math.random() * 0.05) * intensity;
      }
      if (z.light) z.light.intensity = (5 + Math.sin(t * 23) * 1.4 + Math.sin(t * 37) * 0.8 + Math.random() * 0.6) * intensity;
      if (Math.random() < dt * 5 * intensity) {
        const c = lit.length ? lit[(Math.random() * lit.length) | 0] : z.pos;
        spawnSmoke(new THREE.Vector3(c.x + rand(-0.3, 0.3), z.pos.y + 1.6, c.z + rand(-0.3, 0.3)), rand(0.7, 1.1), rand(1.2, 2.0), 0x262422);
      }
      if (t - z.burnSfxAt > 0.4) { z.burnSfxAt = t; AudioSys.fireLoopTick(new THREE.Vector3(z.pos.x, z.pos.y + 0.8, z.pos.z)); }
    } catch (e) {}
    // damage tick (4Hz): victim-authoritative for player + bots we own
    if (t >= z.tickAt) {
      z.tickAt = t + 0.25;
      const tickDmg = (NADE_DEFS.molotov.dps || 52) * 0.25;
      for (const b of bots) {
        if (!b.alive) continue;
        if (b.team === z.owner.team && !(z.owner.bot === b)) continue; // no friendly fire (owner still burns)
        const inside = fireZoneContains(z, b.pos, 0.1);
        if (!inside) continue;
        const shooter = z.owner.isPlayer
          ? { team: z.owner.team, isPlayer: true, weaponName: 'MOLOTOV' }
          : { team: z.owner.team, isPlayer: false, bot: z.owner.bot, weaponName: 'MOLOTOV' };
        damageBot(b, tickDmg * rand(0.9, 1.1), shooter, false, botChest(b));
      }
      if (player.alive && G.phase === 'playing') {
        const insideP = fireZoneContains(z, player.pos, 0.15);
        if (insideP) {
          const sameTeam = (player.team || 'ct') === z.owner.team && !z.owner.isPlayer;
          if (!sameTeam) {
            const shooter = z.owner.isPlayer
              ? { team: z.owner.team, isPlayer: true, weaponName: 'MOLOTOV' }
              : { team: z.owner.team, isPlayer: false, bot: z.owner.bot, remoteName: z.owner.remoteName, remote: null, weaponName: 'MOLOTOV' };
            try { if (z.owner.remoteId != null && remotes.has(z.owner.remoteId)) shooter.remote = remotes.get(z.owner.remoteId); } catch (e) {}
            player.burnT = t;
            damagePlayer(tickDmg * rand(0.9, 1.1), shooter, false);
            try {
              const el = $('burn-overlay');
              if (el) el.style.opacity = 0.85;
            } catch (e) {}
          }
        }
      }
      // attacker hitmarker prediction for remotes standing in our fire (visual only)
      try {
        if (z.owner.isPlayer) {
          for (const [, e] of remotes) {
            if (!e.data || !e.data.alive) continue;
            if ((e.data.team || 't') === (player.team || 'ct')) continue;
            if (fireZoneContains(z, e.pos, 0.2)) { playerHitmark(false, false); break; }
          }
        }
      } catch (e) {}
    }
  }
  // burn overlay decay for the local player
  try {
    const el = $('burn-overlay');
    if (el) {
      const sinceBurn = t - (player.burnT || -9);
      el.style.opacity = sinceBurn < 0.4 ? 0.85 : Math.max(0, 0.85 - (sinceBurn - 0.4) * 2.2).toFixed(3);
    }
  } catch (e) {}
}

// ---------------- Hitscan firing ----------------
const _dir = new THREE.Vector3();
function fireHitscan(shooter, origin, dir, wdef, t) {
  try { botsHearShot(shooter, origin, t); } catch (e) {}
  const maxD = wdef.range;
  const wallD = rayWallDist(origin, dir, maxD);
  let bestT = wallD, hitBot = null, hitPlayer = false, head = false;

  // Ray vs person approximation: head sphere + two body spheres.
  const checkPerson = (px, pz, feetY, crouchK = 0) => {
    // returns {d, head} or null — ray-sphere for head + body; crouchK (0..1) sinks the head and chest
    const o = origin, d = dir;
    const ck = clamp(crouchK || 0, 0, 1);
    // head sphere
    const hx = px, hy = feetY + 1.7 - CROUCH_EYE_DROP * ck, hz = pz;
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
    for (const [by, br] of [[feetY + 1.05 - 0.36 * ck, 0.62 - 0.06 * ck], [feetY + 0.45 - 0.08 * ck, 0.5]]) {
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
    const r = checkPerson(b.pos.x, b.pos.z, b.pos.y, b.crouching ? 1 : 0);
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
        const r = checkPerson(e.pos.x, e.pos.z, e.pos.y, e.crouchK || 0);
        if (r && r.d < bestT) { bestT = r.d; hitRemote = { id: rid, entry: e }; hitBot = null; head = r.head; hitPlayer = false; }
      }
    } catch {}
  }
  // can bots hit player? + can player hit self? no. Can teammates hit player? no friendly fire.
  if (!shooter.isPlayer && shooter.team !== (player.team || 'ct') && player.alive) {
    // Bots only damage the local player when on opposite teams (solo CT vs T).
    // Remote shooters never reach here — they send 'hit' msgs applied victim-side.
    const r = checkPerson(player.pos.x, player.pos.z, player.pos.y, player.crouch || 0);
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
  if (tacticalSmokes.length) {
    let dent = null, dentK = 0;
    for (let i = 1; i <= 6; i++) {
      _smokePt.lerpVectors(origin, end, i / 6);
      const k = smokePushAt(_smokePt, dir.x * 12, dir.z * 12, 0.7); // supersonic tunnel through the cloud
      if (k > dentK) { dentK = k; dent = _smokePt.clone(); }
    }
    if (dent && dentK > 0.2) {
      try { spawnSmoke(dent, 0.55, 0.8, 0xd8d4cb); } catch (e) {} // visible punch mark
    }
  }
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
    try {
      const wk = (wdef && wdef.name) || currentWeaponName(shooter);
      damageBot(hitBot, dmg, shooter, head, end, { dir: dir.clone(), weapon: wk });
    } catch (e) { damageBot(hitBot, dmg, shooter, head, end); }
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

function damageBot(bot, dmg, shooter, head, hitPos, gore = {}) {
  if (!bot.alive || G.phase !== 'playing') return;
  // armor-lite: bots have no armor
  bot.hp -= dmg;
  const _hp = hitPos || botChest(bot);
  // resolve shot direction for directional gore (bullet travel dir, horizontal-ish)
  let _sdir = gore.dir || null;
  try {
    if (!_sdir) {
      if (shooter && shooter.isPlayer && typeof camera !== 'undefined' && camera) {
        _sdir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
      } else if (shooter && shooter.bot) {
        _sdir = bot.pos.clone().sub(shooter.bot.pos).setY(0);
        if (_sdir.lengthSq() < 0.01) _sdir.set(rand(-1, 1), 0, rand(-1, 1));
        _sdir.normalize();
      } else if (shooter && (shooter.remotePos || (shooter.remote && shooter.remote.pos))) {
        const rp = shooter.remotePos || shooter.remote.pos;
        _sdir = new THREE.Vector3(bot.pos.x - rp.x, 0, bot.pos.z - rp.z);
        if (_sdir.lengthSq() < 0.01) _sdir.set(rand(-1, 1), 0, rand(-1, 1));
        _sdir.normalize();
      }
    }
  } catch (e) { _sdir = null; }
  spawnBurst(_hp, 0xb00000, head ? 12 : 8, 4, 0.5);
  spawnBurst(_hp, 0x7a0a0c, 6, 2.5, 0.7, 0.12); // dark arterial spray
  // directional mist + ground spatter so firefights stain the lane
  try {
    const d = _sdir ? _sdir.clone() : (shooter && shooter.isPlayer && camera
      ? new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
      : (shooter && shooter.bot ? shooter.bot.pos.clone().sub(bot.pos).setY(0).normalize() : new THREE.Vector3(1, 0, 0)));
    const mist = _hp.clone().addScaledVector(d, 0.5); mist.y = Math.max(0.3, mist.y - 0.2);
    spawnSmoke(mist, 0.3, 0.7, 0x8a1518);
    if (Math.random() < 0.5) spawnDecal('blood', new THREE.Vector3(bot.pos.x, 0.06, bot.pos.z), new THREE.Vector3(0, 1, 0), 0.9 + Math.random() * 0.7, 0.55);
    // exit spray: throw blood past the victim and stain whatever is behind them
    bloodSplatterRays(_hp, d, head ? 7 : 4, 0.75, 7);
    spawnBurst(_hp, 0xa00d10, goreN(5) + 2, 4.5, 0.5, 0.1);
  } catch (e) {}
  // visible hit-flinch (springs back in updateBot via flinchT decay)
  bot.flinchT = 0.22; bot.flinchHead = !!head;
  soldierFlinch(bot.mesh, head ? 1 : 0.65);
  try { noteDamage(bot, shooter); } catch {}
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
    if (!isOnline()) {
      try { spawnWorldWeapon({ wid: newWid(), key: 'ak', mag: 5 + ((Math.random() * 25) | 0), reserve: 30 + ((Math.random() * 60) | 0), x: bot.pos.x, y: bot.pos.y + 1.0, z: bot.pos.z, vx: rand(-1.5, 1.5), vy: 2, vz: rand(-1.5, 1.5) }); } catch (e) {}
    }
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
    // death: momentum ragdoll + persistent corpse with blood pool (cleared next round)
    bot.deathT = 0; bot._thudded = false;
    bot.headless = false; bot.gibbed = false;
    bot.mesh.rotation.set(0, bot.yaw || 0, 0);
    bot.mesh.position.copy(bot.pos);
    try {
      const wName = String((gore && gore.weapon) || (shooter && shooter.weaponName) || currentWeaponName(shooter) || '').toUpperCase();
      const isFire = wName.includes('MOLOTOV') || wName.includes('FIRE') || wName.includes('BURN');
      const explosive = !isFire && (!!(gore && gore.explosive) || wName.includes('HE') || wName.includes('C4'));
      const isAWP = wName.includes('AWP');
      const isDeagle = wName.includes('DESERT') || wName.includes('DEAGLE') || wName.includes('EAGLE');
      const sdir = _sdir ? _sdir.clone() : null;
      // knock power scales the fall + slide: AWP/HE hurl bodies, rifles shove
      let power = (gore && gore.power) || 1;
      if (power === 1) {
        if (explosive) power = 2.1;
        else if (isAWP) power = 2.0;
        else if (isDeagle) power = 1.4;
        else power = 1.0;
      }
      if (head) power += 0.15;
      bot.fall = pickFallParams(bot.pos, sdir, power);
      bot.deathPos = bot.pos.clone();
      const slideDist = explosive ? rand(0.9, 1.6) : (isAWP ? rand(0.7, 1.2) : isDeagle ? rand(0.45, 0.8) : rand(0.3, 0.65));
      const flat = sdir ? sdir.clone().setY(0) : new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1));
      if (flat.lengthSq() < 0.01) flat.set(rand(-1, 1), 0, rand(-1, 1));
      flat.normalize();
      bot.knock = flat.multiplyScalar(slideDist);
      // ---- hit-part gore: only the struck part comes off, body flings whole ----
      const part = woundPart(bot.pos.y, _hp.y, head);
      let pop = false, popPower = 1;
      const headPos = new THREE.Vector3(bot.pos.x, (bot.pos.y || 0) + 1.76, bot.pos.z);
      if (explosive) {
        pop = Math.random() < 0.75;
        popPower = 1.7;
        tearLimbGib(bot.mesh, bot.pos, sdir, bot.team, true, part === 'head' ? 'torso' : part);
        bot.gibbed = true;
      } else if (head) {
        if (isAWP || dmg >= 90) { pop = true; popPower = 1.7; }
        else if (isDeagle) { pop = Math.random() < 0.65; popPower = 1.3; }
        else { pop = dmg >= 60 ? Math.random() < 0.5 : Math.random() < 0.22; popPower = 1.0; }
      } else if (isAWP && Math.random() < 0.3) {
        // close-range AWP body shots can still tear the hit part off
        tearLimbGib(bot.mesh, bot.pos, sdir, bot.team, false, part);
        bot.gibbed = true;
      } else if ((isDeagle || dmg >= 55) && part === 'leg' && Math.random() < 0.25) {
        tearLimbGib(bot.mesh, bot.pos, sdir, bot.team, false, 'leg');
        bot.gibbed = true;
      }
      // ---- explosives only: whole body comes apart. Bullets keep the corpse. ----
      const gk = GK();
      if (gk > 0 && explosive && explodeBody(bot.mesh, bot.pos, sdir, power, bot.team)) {
        bot.gibbed = true; bot.headless = true; bot.exploded = true;
        try {
          const dp = camera ? camera.position.distanceTo(new THREE.Vector3(bot.pos.x, 1, bot.pos.z)) : 99;
          if (dp < 7) screenGore(clamp(1.2 - dp / 7, 0.25, 1));
        } catch (e) {}
      } else if (pop) {
        bot.headless = true;
        try { explodeHead(bot.mesh, headPos, sdir, popPower, bot.team); } catch (e) {}
        try {
          bloodSplatterRays(headPos, null, 12, 1.1, 7);
          const dp = camera ? camera.position.distanceTo(headPos) : 99;
          if (dp < 6) screenGore(clamp(1 - dp / 6, 0.2, 0.9));
        } catch (e) {}
      } else {
        // intact death: directional spray + pool, body stays whole and flings
        try { spawnBloodSpray(head ? headPos : botChest(bot), sdir, head ? 1.1 : power * 0.9); } catch (e) {}
        spawnBloodPool(bot.pos.x, bot.pos.z, true);
        for (let i = 0; i < goreN(1); i++) spawnBloodPool(bot.pos.x + rand(-0.9, 0.9), bot.pos.z + rand(-0.9, 0.9), Math.random() < 0.5);
        spawnBurst(botChest(bot), 0x8a0f12, goreN(8) + 4, 3.5, 0.8, 0.12);
        bloodSplatterRays(botChest(bot), sdir, 6, 1.0, 7);
        if (head) { try { AudioSys.headpop(headPos); } catch (e) {} }
      }
      try { poseCorpseLimbs(bot.mesh, bot.fall.sprawl, bot.fall.power); } catch (e) {}
    } catch (e) {
      try {
        spawnBloodPool(bot.pos.x, bot.pos.z, true);
        spawnBurst(botChest(bot), 0x8a0f12, 14, 3.5, 0.8, 0.12);
      } catch (e2) {}
    }
    const killerTeam = shooter.isPlayer ? (player.team || 'ct') : shooter.team;
    G.roundKills[killerTeam]++;
    const kn = killerIsPlayer ? (player.name || 'YOU') : (shooter.bot ? shooter.bot.short : '???');
    const kt = killerTeam;
    addKillfeed(kn, kt, bot.short, bot.team, currentWeaponName(shooter), head);
    bot.deaths = (bot.deaths | 0) + 1;
    try { awardAssist(bot, shooterId(shooter)); } catch {}
    if (killerIsPlayer) {
      G.kills++; player.kills++; addMoney(MONEY_KILL); playerHitmark(head, true);
      AudioSys.kill();
      if (head && !G.roundEnding) { G.headshots++; announce('HEADSHOT +$' + MONEY_KILL, 700); }
    } else { try { creditKill(shooter, bot); } catch {} }
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
  try { noteDamage(player, shooter); } catch {}
  try { screenGore(clamp(dmg / 55, 0.15, 1) * (head ? 1.3 : 1)); } catch (e) {}
  try {
    if (shooter && shooter.remotePos) flashDamageRemote(shooter.remotePos);
    else flashDamage(shooter);
  } catch { flashDamage(shooter); }
  updateHUD();
  if (player.hp <= 0) {
    player.hp = 0; player.alive = false; player.deaths++;
    try { awardAssist(player, shooterId(shooter)); } catch {}
    try { if (!shooter.isPlayer) creditKill(shooter, player); } catch {}
    try { dropAllOnDeath(); } catch (e) { console.warn('death drop', e); }
    player.aiming = false; player.cook = null;
    player.crouching = false; player.airTuck = false; player.wallRun = null; player.wallRoll = 0;
    // your own body ragdolls where you fell, same rules as everyone else
    try {
      let sdir = null;
      if (shooter && shooter.remotePos) sdir = new THREE.Vector3(player.pos.x - shooter.remotePos.x, 0, player.pos.z - shooter.remotePos.z);
      else if (shooter && shooter.bot) sdir = new THREE.Vector3(player.pos.x - shooter.bot.pos.x, 0, player.pos.z - shooter.bot.pos.z);
      if (sdir && sdir.lengthSq() < 0.01) sdir = null;
      if (sdir) sdir.normalize();
      player.deathT = 0;
      player.fall = pickFallParams(player.pos, sdir, head ? 1.4 : 1.0);
      const gk = GK();
      const wExpl = String((shooter && shooter.weaponName) || '').toUpperCase();
      const isExpl = /HE|C4|MOLOTOV/.test(wExpl) || dmg >= 400;
      player.exploded = gk > 0 && isExpl;
      if (player.exploded && playerMesh) {
        setPlayerBodyFirstPerson(false);
        explodeBody(playerMesh, player.pos, sdir, player.fall.power, player.team || 'ct');
        screenGore(1);
      } else if (playerMesh) {
        poseCorpseLimbs(playerMesh, player.fall.sprawl, player.fall.power);
      }
    } catch (e) {}
    try { updateInteractHUD(null); } catch (e) {}
    if (BOMB.defuser === 'player') BOMB.defuser = null;
    // PvP T death drops the bomb where we died so teammates can recover it.
    try {
      if (isOnline() && player.hasBomb && !BOMB.planted) {
        player.hasBomb = false;
        bombDropAt(player.pos, false);
      }
    } catch {}
    const kn = shooter.isPlayer ? (player.name || 'YOU') : (shooter.bot ? shooter.bot.short : (shooter.remoteName || shooter.remote?.data?.name || 'Enemy'));
    const suicide = !!shooter.isPlayer;
    $('respawn-killer').textContent = kn + (suicide ? ' (OWN GRENADE)' : (head ? ' (HEADSHOT)' : ''));
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
  if (shooter && shooter.weaponName) return shooter.weaponName;
  if (shooter.isPlayer) {
    if (isNadeKey(player.cur)) return NADE_DEFS[player.cur].name;
    return (WEAPONS[player.cur] || WEAPONS.deagle).name;
  }
  if (shooter && shooter.remote && shooter.remote.data && shooter.remote.data.weapon && WEAPONS[shooter.remote.data.weapon]) return WEAPONS[shooter.remote.data.weapon].name;
  return G.round <= 1 ? 'Desert Eagle' : 'AK-47'; // pistol round flavor
}

function playerNearPlantedBomb(range = 2.8) {
  if (!BOMB.planted || !BOMB.pos) return false;
  // Only CTs defuse — a T holding E on the planted bomb was losing his weapon.
  if ((player.team || 'ct') !== 'ct') return false;
  return Math.hypot(player.pos.x - BOMB.pos.x, player.pos.z - BOMB.pos.z) < range;
}
function playerInPlantSite() {
  if (!player.alive || BOMB.planted || (player.team || 'ct') !== 't' || !player.hasBomb) return null;
  for (const s of SITES) { if (isInSite(player.pos, s)) return s; }
  return null;
}

// ---------------- Player shooting (CS-style recoil + bloom) ----------------
function playerTryFire(t, hand = 'R') {
  // nades never reach the hitscan path — they prime/throw instead
  if (isNadeKey(player.cur)) return;
  const wkey = player.cur, w = player.weapons[wkey], def = WEAPONS[wkey];
  if (!w || !def) return;
  const dual = !!w.dual;
  if (hand === 'L' && !dual) return;
  const left = hand === 'L';
  const magKey = left ? 'mag2' : 'mag', nextKey = left ? 'nextShotL' : 'nextShot';
  const justDown = left ? rmbJustDown : mouseJustDown;
  if (!player.alive || player.reloading > 0 || t < (player[nextKey] || 0)) return;
  if (isFreeze() || G.roundEnding) return; // CS freeze: no shooting
  if (keys['KeyE'] && playerNearPlantedBomb()) return; // hands busy defusing
  if (keys['KeyE'] && playerInPlantSite()) return; // hands busy planting (PvP T)
  if (w[magKey] <= 0) {
    AudioSys.click(300, 0.06, 0.3); player[nextKey] = t + 0.3;
    if (!dual || (w.mag <= 0 && (w.mag2 | 0) <= 0)) startReload();
    return;
  }
  if (!def.auto && !justDown) return;
  // spray reset after pause (tap = accurate again)
  if (t - player.lastShotT > 0.5) { player.sprayIdx = 0; }
  player[nextKey] = t + def.fireInterval;
  player.lastShotT = t;
  w[magKey]--; G.shots++;
  // --- spread: base + heat bloom + movement + air ---
  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  const moveF = 1 + clamp(hSpeed / 5, 0, 1) * (wkey === 'awp' ? 2.2 : wkey === 'p90' ? 0.45 : 1.1) * (dual ? DUAL.moveMul : 1);
  const airF = player.onGround ? 1 : player.wallRun ? (wkey === 'awp' ? 3 : 1.5) : (wkey === 'awp' ? 5 : 2.2);
  const crouchF = player.onGround ? 1 - 0.3 * (player.crouch || 0) : 1; // crouched = steadier
  const aimK = vmRig.aimK || 0;
  const spreadBase = dual ? def.spreadHip * DUAL.spreadMul + DUAL.spreadAdd : def.spreadHip + (def.spreadAim - def.spreadHip) * aimK;
  const bloomNow = player.bloom;
  const spread = (spreadBase + bloomNow) * moveF * airF * crouchF;
  // punch + shake are applied to the camera, so shoot from the *punched* view
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  dir.x += rand(-spread, spread); dir.y += rand(-spread, spread); dir.z += rand(-spread, spread);
  dir.normalize();
  crossGap = clamp(6 + spread * 950 + bloomNow * 550, 6, 46);
  const origin = new THREE.Vector3(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0), player.pos.z).add(dir.clone().multiplyScalar(0.4));
  if (dual) origin.addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), left ? -0.16 : 0.16);
  const muzzleObj = left && vmL ? vmL.muzzle : vmMuzzle;
  const flashObj = left && vmL ? vmL.flash : vmFlashGroup;
  const muzzleWorld = new THREE.Vector3();
  if (muzzleObj) muzzleObj.getWorldPosition(muzzleWorld);
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
  player.bloom = Math.min(def.bloomMax * (dual ? DUAL.bloomMaxMul : 1), player.bloom + def.bloomAdd * (dual ? DUAL.bloomMul : 1) * (player.aiming ? 0.55 : 1) * moveF * (1 - 0.3 * (player.crouch || 0)));
  // --- true recoil (permanent climb — pull down to compensate) ---
  let patX = 0, patY = 1;
  if (wkey === 'ak') {
    const p = SPRAY_AK[Math.min(player.sprayIdx, SPRAY_AK.length - 1)];
    patX = p[0]; patY = p[1];
  } else if (wkey === 'deagle') { patX = rand(-0.5, 0.5); patY = 1; }
  else if (wkey === 'p90') { patX = Math.sin(player.sprayIdx * 0.9) * 0.6 + rand(-0.3, 0.3); patY = player.sprayIdx < 8 ? 1 : 0.55; }
  else { patX = rand(-0.4, 0.4); patY = 1; }
  const aimMul = (player.aiming ? (wkey === 'awp' ? 0.85 : 0.62) : 1) * (player.onGround ? 1 - 0.15 * (player.crouch || 0) : 1);
  // first bullet is the accurate one
  const firstMul = player.sprayIdx === 0 ? 0.85 : 1;
  if (dual) {
    // two guns bucking out of sync: big climb, and each gun whips the view toward its own side
    const heat = 1 + clamp(player.sprayIdx / 6, 0, 1.2);
    player.pitch += def.kickUp * DUAL.kickUpMul * rand(0.55, 1.45) * heat;
    player.yaw += rand(-def.kickSide, def.kickSide) * DUAL.kickSideMul * heat + (left ? 1 : -1) * DUAL.whip * rand(0.6, 1.3) * (def.kickUp / 0.0115 * 0.35 + 0.65);
    vmRig.roll += (left ? -1 : 1) * DUAL.roll * rand(0.6, 1.2);
  } else {
  player.pitch += def.kickUp * patY * aimMul * firstMul;
  player.yaw += (rand(-def.kickSide, def.kickSide) + patX * def.kickSide * 0.9) * aimMul;
  }
  player.pitch = clamp(player.pitch, -1.45, 1.45);
  player.sprayIdx++;
  // --- recoverable punch / shake / fov (game feel, springs back) ---
  vmRig.punchP += def.punch * (player.aiming ? 0.6 : 1);
  vmRig.punchY += rand(-def.punch, def.punch) * 0.4;
  vmRig.shake += def.shake;
  vmRig.fovKick += def.fovPunch * (player.aiming ? 0.4 : 1);
  // --- viewmodel spring kick + flash + shell + smoke ---
  soldierFireKick(playerMesh, 0.85);
  if (left) { vmRig.kickVL += def.vmKick * 19; vmRig.kickRotVL += def.punch * 12; vmRig.shake += def.shake; }
  else { vmRig.kickV += def.vmKick * (dual ? 19 : 15) * (player.aiming ? 0.65 : 1); vmRig.kickRotV += def.punch * (dual ? 12 : 9); if (dual) vmRig.shake += def.shake; }
  if (flashObj) {
    for (const f of flashObj.children) {
      f.material.opacity = 1;
      f.rotation.z = Math.random() * Math.PI * 2;
      const s = (wkey === 'awp' ? 1.9 : wkey === 'deagle' ? 1.35 : wkey === 'p90' ? 0.75 : 1.0) * rand(0.9, 1.15);
      f.scale.set(s, s, 1);
    }
  }
  if (muzzleObj) {
    const mp = new THREE.Vector3(); muzzleObj.getWorldPosition(mp);
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
  if (left) rmbJustDown = false; else mouseJustDown = false;
  if (w.mag === 0 && (!dual || (w.mag2 | 0) === 0)) setTimeout(() => startReload(), 260);
  updateHUD();
}
function startReload() {
  if (isNadeKey(player.cur)) return;
  const wkey = player.cur, w = player.weapons[wkey], def = WEAPONS[wkey];
  if (!w || !def) return;
  const needMag = (def.magSize - w.mag) + (w.dual ? def.magSize - (w.mag2 | 0) : 0);
  if (player.reloading > 0 || needMag <= 0 || w.reserve <= 0 || !player.alive) return;
  const rt = def.reloadTime * (w.dual ? DUAL.reloadMul : 1);
  player.reloading = rt; player.reloadDur = rt;
  player.sprayIdx = 0;
  AudioSys.reload();
  $('reload-tip').classList.remove('hidden');
}
function finishReload() {
  if (isNadeKey(player.cur)) { player.reloading = 0; return; }
  const wkey = player.cur, w = player.weapons[wkey], def = WEAPONS[wkey];
  if (!w || !def) { player.reloading = 0; return; }
  const need = def.magSize - w.mag, take = Math.min(need, w.reserve);
  w.mag += take; w.reserve -= take;
  if (w.dual) { const t2 = Math.min(def.magSize - (w.mag2 | 0), w.reserve); w.mag2 = (w.mag2 | 0) + t2; w.reserve -= t2; }
  player.reloading = 0;
  player.bloom = 0;
  $('reload-tip').classList.add('hidden');
  updateHUD();
}
function switchWeapon(key) {
  if (!player.alive) return;
  if (isNadeKey(key)) {
    if ((player.nades[key] || 0) <= 0) { announce(`${NADE_DEFS[key].name} EMPTY — PRESS B`, 1100); AudioSys.dryfire(); return; }
    if (player.cur === key) return;
    player.last = player.cur; player.cur = key;
    player.cook = null;
    player.reloading = 0; $('reload-tip').classList.add('hidden');
    player.bloom = 0; player.sprayIdx = 0; player.aiming = false;
    buildViewmodel(key);
    AudioSys.pin();
    updateHUD();
    return;
  }
  if (!player.weapons[key] || !player.weapons[key].owned || player.cur === key) return;
  player.last = player.cur; player.cur = key;
  player.cook = null;
  try { updateInteractHUD(null); } catch (e) {}
  player.reloading = 0; $('reload-tip').classList.add('hidden');
  player.bloom = 0; player.sprayIdx = 0;
  // You cannot carry a sight picture through a weapon swap — dropping ADS also
  // stops the new gun snapping straight to its aim pose with no raise animation.
  player.aiming = false;
  buildViewmodel(key);
  AudioSys.click(1200, 0.05, 0.3);
  setTimeout(() => AudioSys.click(900, 0.05, 0.25), 120);
  updateHUD();
}

// ---------------- Input ----------------
let mouseDown = false, mouseJustDown = false, crossGap = 8;
let rmbDown = false, rmbJustDown = false; // left-hand trigger when dual wielding
function initInput() {
  addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
    if (settingsOpen()) { if (e.code === 'Escape') { e.preventDefault(); closeSettings(); } return; }
    if (G.phase !== 'playing') return;
    if (e.code === 'Tab') { if (!e.repeat) setScoreboard(true); return; }
    if (e.code === 'KeyM') { AudioSys.muted = !AudioSys.muted; announce(AudioSys.muted ? 'SOUND OFF' : 'SOUND ON', 800); return; }
    if (!player.alive) {
      // Spectating: cycle targets / toggle camera. (Weapon/buy keys stay blocked.)
      if (e.code === 'KeyB' || e.code === 'Escape') { if (G.buyOpen) toggleBuy(false); return; }
      if (e.repeat) return;
      if (e.code === 'Space' || e.code === 'ArrowRight' || e.code === 'ArrowDown' || e.code === 'KeyN') spectateNext();
      if (e.code === 'KeyF' || e.code === 'KeyV' || e.code === 'ArrowUp') spectateToggleMode();
      return;
    }
    if (G.buyOpen) {
      if (e.code === 'KeyB' || e.code === 'Escape') { if (!e.repeat) toggleBuy(false); return; }
      const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
      if (m) { if (!e.repeat) buyByKey(m[1]); return; }
      if (e.code === 'KeyR') { if (!e.repeat) buyByKey('R'); return; }
    }
    if (e.code === 'Digit1') { const pk = primaryKey(); if (pk) switchWeapon(pk); else announce('NO PRIMARY — PRESS B', 1100); }
    if (e.code === 'Digit2') switchWeapon('deagle');
    if (e.code === 'Digit4') switchWeapon('he');
    if (e.code === 'Digit5') switchWeapon('flash');
    if (e.code === 'Digit6') switchWeapon('smoke');
    if (e.code === 'Digit7') switchWeapon('molotov');
    if (e.repeat) return;
    if (e.code === 'KeyQ') {
      const fb = player.last;
      if (fb && (isNadeKey(fb) ? (player.nades[fb] || 0) > 0 : (player.weapons[fb] && player.weapons[fb].owned))) switchWeapon(fb);
    }
    if (e.code === 'KeyG') {
      // quick-throw selected utility without fully switching: cycles to next owned nade
      const owned = NADE_ORDER.filter((k) => (player.nades[k] || 0) > 0);
      if (owned.length) {
        const cur = owned.includes(player.cur) ? player.cur : owned[0];
        const nxt = owned[(owned.indexOf(cur) + 1) % owned.length];
        switchWeapon(nxt);
      } else announce('NO GRENADES — PRESS B TO BUY', 1100);
    }
    if (e.code === 'KeyC' && SET.crouchToggle && !e.repeat) player.crouchWant = !player.crouchWant;
    if (e.code === 'KeyR') startReload();
    if (e.code === 'KeyX' && WEAPONS[player.cur]) dropWeapon(player.cur);
    if (e.code === 'KeyE') player.useQueued = true;
    if (e.code === 'KeyB') toggleBuy();
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; if (e.code === 'Tab') setScoreboard(false); });
  addEventListener('blur', () => { try { setScoreboard(false); } catch {} });
  document.addEventListener('mousedown', (e) => {
    if (G.phase !== 'playing' || !pointerLocked) return;
    if (!player.alive) {
      // Spectating: LMB next player, RMB toggle first/chase.
      if (e.button === 0) spectateNext();
      if (e.button === 2) spectateToggleMode();
      return;
    }
    if (G.buyOpen) { if (e.button === 0) buyCursorClick(); return; }
    // Nades (CS2): hold LMB = far, RMB = short lob, both = medium — throws on release.
    if (isNadeKey(player.cur)) {
      if (G.buyOpen || isFreeze() || G.roundEnding) return;
      if (e.button === 0 || e.button === 2) playerPrimeNade(player.cur, performance.now() / 1000, e.button);
      return;
    }
    if (e.button === 0) { mouseDown = true; mouseJustDown = true; }
    if (e.button === 2) { if (isDualCur()) { rmbDown = true; rmbJustDown = true; } else player.aiming = true; }
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      if (player.cook) playerReleaseNade(0);
      mouseDown = false;
    }
    if (e.button === 2 && player.cook) playerReleaseNade(2);
    if (e.button === 2) rmbDown = false;
    if (e.button === 2 && !isNadeKey(player.cur)) player.aiming = false;
    if (e.button === 2 && isNadeKey(player.cur)) { /* nades never ADS */ }
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('mousemove', (e) => {
    if (!pointerLocked || G.phase !== 'playing') return;
    if (!player.alive) {
      // Spectate look (orbit in chase cam, free look in first-person).
      const sens = lookSens();
      player.yaw -= e.movementX * sens;
      player.pitch -= e.movementY * sens * (SET.invertY ? -1 : 1);
      player.pitch = clamp(player.pitch, -1.45, 1.45);
      return;
    }
    if (G.buyOpen) { moveBuyCursor(e.movementX, e.movementY); return; }
    // ADS keeps its per-weapon zoom scale, then the user's own ADS % on top.
    const adsK = player.aiming ? (player.cur === 'awp' ? 0.35 : 0.7) * (SET.adsSens / 100) : 1;
    const sens = lookSens() * adsK;
    player.yaw -= e.movementX * sens;
    player.pitch -= e.movementY * sens * (SET.invertY ? -1 : 1);
    player.pitch = clamp(player.pitch, -1.45, 1.45);
    // weapon sway inertia from look velocity
    vmRig.swayX = clamp(vmRig.swayX - e.movementX * 0.00035 * swayK(), -0.05, 0.05);
    vmRig.swayY = clamp(vmRig.swayY + e.movementY * 0.00035 * swayK(), -0.05, 0.05);
  });
  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === renderer.domElement;
    if (!pointerLocked && G.buyOpen) {
      // ESC (browser-forced unlock) while shopping: close the menu and pause, like any other ESC.
      toggleBuy(false, false);
      if (G.phase === 'playing' && player.alive) pauseGame();
      return;
    }
    if (!pointerLocked && G.phase === 'playing' && player.alive) pauseGame();
    buyCursorSync();
  });
  // Native click only matters when the pointer is NOT locked (locked clicks target the canvas).
  document.querySelectorAll('.buy-item').forEach((b) => b.addEventListener('click', () => { if (!pointerLocked) buyItem(b.dataset.buy); }));
  refreshBuyMenu(true);
}

// ---------------- Buy menu ----------------
function buyTimeLeft() { return Math.max(0, G.buyLeft); }
function buyPrice(kind) {
  const w = player.weapons;
  if (isNadeKey(kind)) return NADE_DEFS[kind].price;
  // deagle: 1st $700, 2nd copy (dual) $700, then ammo $200
  return ({ ak: 2500, awp: 4750, p90: WEAPONS.p90.price, deagle: (w.deagle && w.deagle.owned && w.deagle.dual) ? 200 : 700, ammo: 200, armor: 1000, hp: 500 })[kind] || 0;
}
// ---- virtual cursor: menu works while pointer stays locked (no unlock/relock yank, no browser relock cooldown)
const buyCur = { x: 0, y: 0, hover: null };
function buyCursorSync() {
  const el = $('buy-cursor'); if (!el) return;
  el.classList.toggle('on', G.buyOpen && pointerLocked);
  if (!(G.buyOpen && pointerLocked) && buyCur.hover) { buyCur.hover.classList.remove('hover'); buyCur.hover = null; }
}
function moveBuyCursor(dx, dy) {
  const k = 1; // 1:1 with OS mouse movement, like a desktop cursor
  buyCur.x = clamp(buyCur.x + dx * k, 0, innerWidth - 2);
  buyCur.y = clamp(buyCur.y + dy * k, 0, innerHeight - 2);
  $('buy-cursor').style.transform = `translate(${buyCur.x}px,${buyCur.y}px)`;
  const hit = document.elementFromPoint(buyCur.x, buyCur.y);
  const item = hit && hit.closest ? hit.closest('.buy-item') : null;
  if (item !== buyCur.hover) {
    if (buyCur.hover) buyCur.hover.classList.remove('hover');
    if (item) { item.classList.add('hover'); AudioSys.click(2200, 0.015, 0.08); }
    buyCur.hover = item;
  }
}
function buyCursorClick() {
  const item = buyCur.hover;
  if (!item) return;
  item.classList.add('press'); setTimeout(() => item.classList.remove('press'), 90);
  buyItem(item.dataset.buy);
}
function buyByKey(d) {
  const item = document.querySelector(`.buy-item[data-key="${d}"]`);
  if (item) buyItem(item.dataset.buy);
}
function toggleBuy(force, relock = true) {
  const want = force !== undefined ? force : !G.buyOpen;
  if (want === G.buyOpen) return;
  if (want) {
    if (G.phase !== 'playing' || G.roundEnding) return;
    if (!player.alive) { announce('CAN\'T BUY WHILE DEAD', 1000); AudioSys.click(300, 0.1, 0.3); return; }
    if (!isBuyTime()) { announce('BUY TIME OVER', 900); AudioSys.click(300, 0.1, 0.3); return; }
    // drop any held input so opening the menu never leaves you firing/aiming/cooking
    mouseDown = false; mouseJustDown = false; player.aiming = false;
    if (player.cook) { player.cook = null; try { updateInteractHUD(null); } catch (err) {} }
    // cursor starts near the menu centre, like CS2
    buyCur.x = innerWidth / 2; buyCur.y = innerHeight / 2 + 40;
    $('buy-cursor').style.transform = `translate(${buyCur.x}px,${buyCur.y}px)`;
    AudioSys.click(900, 0.04, 0.2);
  }
  G.buyOpen = want;
  const menu = $('buy-menu');
  menu.classList.toggle('open', want);
  menu.setAttribute('aria-hidden', want ? 'false' : 'true');
  refreshBuyMenu(true);
  updateBuyTimer();
  buyCursorSync();
  if (!want) {
    const t = $('buy-toast'); if (t) t.classList.remove('show');
    // only needed if the lock was lost some other way (e.g. native-cursor fallback)
    if (relock && !pointerLocked && G.phase === 'playing' && player.alive) lockPointer();
  } else if (!pointerLocked) {
    lockPointer();
  }
}
let buyMenuKey = '';
function refreshBuyMenu(force) {
  if (!force && !G.buyOpen) return;
  const w = player.weapons, money = player.money;
  const key = [money, player.hp, player.armor, w.ak.owned, w.awp.owned, w.p90.owned, w.deagle.owned, !!w.ak.dual, !!w.awp.dual, !!w.p90.dual, !!w.deagle.dual, ...NADE_ORDER.map((k) => player.nades[k] || 0)].join('|');
  if (!force && key === buyMenuKey) return;
  const prevMoney = +(buyMenuKey.split('|')[0] || money);
  buyMenuKey = key;
  const mEl = $('buy-money');
  mEl.textContent = '$' + money;
  if (prevMoney !== money && G.buyOpen) { mEl.classList.remove('pulse'); void mEl.offsetWidth; mEl.classList.add('pulse'); setTimeout(() => mEl.classList.remove('pulse'), 130); }
  document.querySelectorAll('#buy-menu .buy-item').forEach((el) => {
    const k = el.dataset.buy, price = buyPrice(k);
    let owned = false, maxed = false, state = '';
    if (PRIMARIES.includes(k)) { owned = !!w[k].owned; maxed = owned && !!w[k].dual; if (maxed) state = 'DUAL'; else if (owned) state = '+2ND'; else if (primaryKey()) state = 'SWAP'; }
    else if (k === 'deagle') { owned = !!w.deagle.owned; if (owned) state = w.deagle.dual ? 'AMMO' : '+2ND'; }
    else if (k === 'armor') { maxed = player.armor >= 100; if (maxed) state = 'FULL'; }
    else if (k === 'hp') { maxed = player.hp >= 100; if (maxed) state = 'FULL'; }
    else if (isNadeKey(k)) { const n = player.nades[k] || 0, mx = NADE_DEFS[k].max; maxed = n >= mx; state = n ? `${n}/${mx}` : ''; }
    el.querySelector('.bi-price').textContent = '$' + price;
    el.querySelector('.bi-state').textContent = state;
    el.classList.toggle('owned', maxed && PRIMARIES.includes(k));
    el.classList.toggle('maxed', maxed && !PRIMARIES.includes(k));
    el.classList.toggle('poor', !maxed && money < price);
  });
}
function updateBuyTimer() {
  const el = $('buy-timer'); if (!el) return;
  const left = buyTimeLeft();
  el.textContent = isBuyTime() ? Math.ceil(left) + 's' : 'CLOSED';
  const fill = $('buy-timer-fill');
  if (fill) fill.style.transform = `scaleX(${clamp(left / BUY_TIME, 0, 1)})`;
  el.parentElement.classList.toggle('low', left < 5);
  refreshBuyMenu(false);
}
let buyToastTimer = null;
function buyFeedback(kind, good, msg) {
  const item = document.querySelector(`.buy-item[data-buy="${kind}"]`);
  if (item) { const c = good ? 'bought' : 'denied'; item.classList.remove('bought', 'denied'); void item.offsetWidth; item.classList.add(c); }
  if (G.buyOpen) {
    const t = $('buy-toast');
    t.textContent = msg; t.className = 'show ' + (good ? 'ok' : 'no');
    clearTimeout(buyToastTimer); buyToastTimer = setTimeout(() => t.classList.remove('show'), 1400);
  } else announce(msg, 900);
}
function buyItem(kind) {
  if (!isBuyTime()) { buyFeedback(kind, false, 'BUY TIME OVER'); AudioSys.click(250, 0.12, 0.35); return; }
  if (!player.alive) { buyFeedback(kind, false, 'CAN\'T BUY WHILE DEAD'); AudioSys.click(250, 0.12, 0.35); return; }
  if (G.roundEnding) return;
  const w = player.weapons;
  const ok = (msg) => { buyFeedback(kind, true, msg); refreshBuyMenu(true); updateHUD(); AudioSys.click(1500, 0.07, 0.35); };
  const no = (msg) => { buyFeedback(kind, false, msg); AudioSys.click(250, 0.12, 0.35); };
  // Buying a gun you already hold buys a second one: dual wield.
  const buySecond = (k) => {
    const def = WEAPONS[k];
    if (player.money < def.price) return no('NOT ENOUGH $');
    player.money -= def.price;
    w[k].dual = true; w[k].mag2 = def.magSize;
    w[k].reserve = reserveCap(k, true);
    player.aiming = false; player.reloading = 0; $('reload-tip').classList.add('hidden');
    if (player.cur === k) buildViewmodel(k); else switchWeapon(k);
    return ok(`2ND ${def.name.toUpperCase()} — DUAL WIELD (LMB RIGHT · RMB LEFT)`);
  };
  if (PRIMARIES.includes(kind)) {
    const def = WEAPONS[kind];
    if (w[kind].owned && w[kind].dual) return no(`ALREADY DUAL ${def.name.toUpperCase()}`);
    if (w[kind].owned) return buySecond(kind);
    if (player.money < def.price) return no('NOT ENOUGH $');
    const old = primaryKey();
    if (old) { dropWeapon(old, { both: true, fromDeath: true }); w[old].dual = false; if (player.last === old) player.last = 'deagle'; }
    player.money -= def.price;
    w[kind].owned = true; w[kind].mag = def.magSize; w[kind].reserve = def.startReserve;
    if (player.cur === old) player.cur = 'deagle'; // force a fresh draw of the new gun
    switchWeapon(kind);
    return ok(old ? `${def.name} PURCHASED — ${WEAPONS[old].name} DROPPED` : `${def.name} PURCHASED`);
  }
  if (kind === 'deagle') {
    if (w.deagle.owned && !w.deagle.dual) return buySecond('deagle');
    if (w.deagle.owned) { // dual already: refill
      if (player.money < 200) return no('NOT ENOUGH $');
      player.money -= 200; w.deagle.reserve = reserveCap('deagle', w.deagle.dual); return ok('DEAGLE AMMO REFILLED');
    }
    if (player.money < 700) return no('NOT ENOUGH $');
    player.money -= 700; w.deagle.owned = true; w.deagle.mag = 7; w.deagle.reserve = 35; return ok('DESERT EAGLE PURCHASED');
  }
  if (kind === 'ammo') {
    if (player.money < 200) return no('NOT ENOUGH $');
    player.money -= 200;
    for (const k of SLOT_ORDER) if (w[k].owned) w[k].reserve = reserveCap(k, w[k].dual);
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
  if (isNadeKey(kind)) {
    const def = NADE_DEFS[kind];
    if ((player.nades[kind] || 0) >= def.max) return no(`${def.name} FULL (MAX ${def.max})`);
    if (player.money < def.price) return no('NOT ENOUGH $');
    player.money -= def.price;
    player.nades[kind] = (player.nades[kind] || 0) + 1;
    return ok(`${def.name} PURCHASED [${player.nades[kind]}/${def.max}]`);
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
  a.textContent = '';
  const d = document.createElement('div');
  d.className = 'announce-title';
  d.textContent = String(msg ?? '');
  a.appendChild(d);
  a.classList.remove('hidden');
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => a.classList.add('hidden'), ms);
}
function announceRoundEnd(title, moneyText, track, ms = 3400) {
  const a = $('announce');
  a.textContent = '';
  const d = document.createElement('div');
  d.className = 'announce-title';
  d.textContent = `${String(title ?? '')} — ${String(moneyText ?? '')}`;
  a.appendChild(d);
  if (track && track.title) {
    const m = document.createElement('div');
    m.className = 'announce-music';
    m.textContent = `🎵 ${String(track.title)}`;
    a.appendChild(m);
  }
  a.classList.remove('hidden');
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => a.classList.add('hidden'), ms);
}
// ---------------- Scoreboard (hold TAB) ----------------
function scoreboardVisible() { const el = $('scoreboard'); return !!el && !el.classList.contains('hidden'); }
function setScoreboard(on) {
  const el = $('scoreboard');
  if (!el || G.phase !== 'playing') { if (el) el.classList.add('hidden'); return; }
  if (on) { el.classList.remove('hidden'); renderScoreboard(); }
  else el.classList.add('hidden');
}
function renderScoreboard() {
  try {
    const ctBody = $('sb-ct-rows'), tBody = $('sb-t-rows');
    if (!ctBody || !tBody) return;
    const selfPing = (() => { try { return Net.active ? Math.max(1, Math.round(Net.rtt)) : 0; } catch { return 0; } })();
    const rows = { ct: [], t: [] };
    const push = (team, name, k, a, d, ping, me, alive) => {
      (rows[team === 't' ? 't' : 'ct']).push({ name, k: k | 0, a: a | 0, d: d | 0, ping, me: !!me, alive: alive !== false });
    };
    const myTeam = player.team || 'ct';
    push(myTeam, (player.name || 'YOU'), player.kills, player.assists, player.deaths, selfPing, true, player.alive);
    if (!isMultiplayer()) {
      for (const b of bots) {
        if (b.short === undefined) continue;
        push(b.team, b.short, b.kills, b.assists, b.deaths, '—', false, b.alive);
      }
    }
    try {
      for (const r of Net.remoteList()) {
        const st = statsHolder('remote:' + r.id);
        st.name = r.name; st.team = r.team;
        const rp = (r.ping > 0) ? Math.min(9999, Math.round(r.ping)) : '—';
        push(r.team, r.name || ('Player' + r.id), st.kills, st.assists, st.deaths, rp, false, r.alive);
      }
    } catch {}
    for (const k of ['ct', 't']) {
      rows[k].sort((a, b) => (b.k - a.k) || (b.a - a.a) || (a.d - b.d));
      const body = k === 'ct' ? ctBody : tBody;
      body.innerHTML = rows[k].map((r) =>
        `<tr class="${r.me ? 'me' : ''}${r.alive ? '' : ' dead'}"><td>${esc(String(r.name).slice(0, 14))}</td><td>${r.k}</td><td>${r.a}</td><td>${r.d}</td><td>${r.ping}</td></tr>`
      ).join('') || `<tr><td>—</td><td>0</td><td>0</td><td>0</td><td>—</td></tr>`;
    }
    $('sb-ct').textContent = 'CT ' + G.score.ct;
    $('sb-t').textContent = G.score.t + ' T';
    const pingTxt = Net.active ? ` · PING ${selfPing}ms` : '';
    $('sb-foot').textContent = `ROUND ${G.round} · CT ${G.score.ct} — ${G.score.t} T${pingTxt}`;
  } catch {}
}
setInterval(() => { try { if (G.phase === 'playing' && scoreboardVisible()) renderScoreboard(); } catch {} }, 500);
function addKillfeed(killer, kTeam, victim, vTeam, wpn, head) {
  const kf = $('killfeed');
  const div = document.createElement('div');
  div.className = 'feed-item' + (head ? ' headshot' : '');
  div.innerHTML = `<span class="killer ${kTeam === 'ct' ? 'ct' : 't'}">${esc(killer)}</span><span class="wpn">[${esc(wpn)}${head ? ' 💀' : ''}]</span><span class="victim ${vTeam === 'ct' ? 'ct' : 't'}">${esc(victim)}</span>`;
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
  const moneyEl = $('money');
  if (updateHUD._money !== undefined && player.money > updateHUD._money) {
    moneyEl.classList.remove('bump'); void moneyEl.offsetWidth; moneyEl.classList.add('bump');
  }
  updateHUD._money = player.money;
  moneyEl.textContent = '$' + player.money;
  $('health-panel').classList.toggle('low', player.alive && player.hp <= 25);
  if (isNadeKey(player.cur)) {
    const def = NADE_DEFS[player.cur];
    const n = player.nades[player.cur] || 0;
    $('ammo-mag').textContent = '×' + n; $('ammo-reserve').textContent = def.max;
    $('weapon-name').textContent = def.name;
  } else {
    const w = player.weapons[player.cur] || player.weapons.deagle;
    const def = WEAPONS[player.cur] || WEAPONS.deagle;
    $('ammo-mag').textContent = w.dual ? `${w.mag2 | 0}|${w.mag}` : w.mag; $('ammo-reserve').textContent = w.reserve;
    $('weapon-name').textContent = (w.dual ? 'DUAL ' : '') + def.name.toUpperCase();
  }
  document.querySelectorAll('.wslot').forEach((el) => {
    const k = el.dataset.slot === 'primary' ? (primaryKey() || null) : 'deagle';
    if (el.dataset.slot === 'primary') { const sp = el.querySelector('span'); if (sp) sp.textContent = k ? WEAPONS[k].name : 'PRIMARY'; }
    el.classList.toggle('active', !!k && k === player.cur);
    el.classList.toggle('locked', !k || !player.weapons[k].owned);
  });
  // nade slots (4-7) with counts
  document.querySelectorAll('.nslot').forEach((el) => {
    const k = el.dataset.nade;
    const n = player.nades[k] || 0;
    el.classList.toggle('active', k === player.cur);
    el.classList.toggle('locked', n <= 0);
    const cnt = el.querySelector('i');
    if (cnt) cnt.textContent = '×' + n;
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
  // freeze countdown is already the big clock — don't repeat it here
  if (!isFreeze() && isBuyTime()) phase = ` · BUY ${G.buyLeft.toFixed(1)}s`;
  $('round-label').textContent = `R${G.round}/${ROUNDS_TO_WIN_MATCH * 2 - 1} · ${ctAlive} v ${tAlive}${phase}`;
  $('crosshair').style.setProperty('--gap', (crossGap * SET.chGap / 100).toFixed(1) + 'px');
  try { if (scoreboardVisible()) renderScoreboard(); } catch {}
}

// minimap
const mm = { last: 0 };
// LOS tracking: stores last time each entity was in LOS of the player (for enemy linger on minimap).
const mmSpotTime = new WeakMap(); // entity -> performance timestamp (seconds)
const MM_SPOT_LINGER = 2.0; // seconds enemies remain visible after last LOS
function mmCanSeeEnemy(entityPos, tNow) {
  if (!player.alive) return true; // dead = spectate, show all
  _tmpMMEye.set(player.pos.x, EYE, player.pos.z);
  _tmpMMTgt.set(entityPos.x, EYE, entityPos.z);
  return hasLOSClear(_tmpMMEye, _tmpMMTgt);
}
function mmEnemyVisible(entity, entityTeam, entityPos, tNow) {
  const myTeam = player.team || 'ct';
  const isEnemy = entityTeam !== myTeam;
  if (!isEnemy) return true; // always show friendlies
  if (!player.alive) return true; // spectating — show all
  // Check current LOS.
  if (mmCanSeeEnemy(entityPos, tNow)) {
    mmSpotTime.set(entity, tNow);
    return true;
  }
  // Linger: keep visible briefly after LOS broken.
  const lastSeen = mmSpotTime.get(entity);
  return lastSeen !== undefined && (tNow - lastSeen) < MM_SPOT_LINGER;
}
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
  // bots — friendlies always visible, enemies only when in LOS (or recently spotted)
  const tNowMm = performance.now() / 1000;
  for (const b of bots) {
    if (!b.alive) continue;
    if (!b.mesh.visible && isMultiplayer()) continue; // hidden PvP bots
    // LOS filter for enemies (use 'b' as stable WeakMap key).
    if (!mmEnemyVisible(b, b.team, b.pos, tNowMm)) continue;
    const isEnemy = b.team !== (player.team || 'ct');
    g.fillStyle = b.team === 'ct' ? '#5eb2ff' : '#ff7043';
    // Fade enemy dots slightly when lingering (not currently in LOS).
    if (isEnemy && !mmCanSeeEnemy(b.pos, tNowMm)) {
      const lastSeen = mmSpotTime.get(b);
      const age = lastSeen !== undefined ? (tNowMm - lastSeen) : MM_SPOT_LINGER;
      g.globalAlpha = Math.max(0.2, 1 - age / MM_SPOT_LINGER);
    }
    g.beginPath(); g.arc(px(b.pos.x), pz(b.pos.z), 3, 0, 7); g.fill();
    g.globalAlpha = 1;
    if (b.hasBomb) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(px(b.pos.x), pz(b.pos.z), 5, 0, 7); g.stroke(); }
    if (!player.alive && player.specTarget === b) { g.strokeStyle = '#3dff7a'; g.lineWidth = 2; g.beginPath(); g.arc(px(b.pos.x), pz(b.pos.z), 6, 0, 7); g.stroke(); }
  }
  // real remote players — same LOS rules
  try {
    if (isOnline()) {
      for (const [rid, e] of remotes) {
        const rd = e.data; if (!rd || !rd.alive) continue;
        const remTeam = rd.team || 't';
        if (!mmEnemyVisible(e, remTeam, e.pos, tNowMm)) continue;
        const isEnemy = remTeam !== (player.team || 'ct');
        g.fillStyle = remTeam === 'ct' ? '#5eb2ff' : '#ff7043';
        if (isEnemy && !mmCanSeeEnemy(e.pos, tNowMm)) {
          const lastSeen = mmSpotTime.get(e);
          const age = lastSeen !== undefined ? (tNowMm - lastSeen) : MM_SPOT_LINGER;
          g.globalAlpha = Math.max(0.2, 1 - age / MM_SPOT_LINGER);
        }
        g.beginPath(); g.arc(px(e.pos.x), pz(e.pos.z), 3.4, 0, 7); g.fill();
        g.globalAlpha = 1;
        g.strokeStyle = isEnemy ? '#ffffff' : 'rgba(255,255,255,0.4)';
        g.lineWidth = 1;
        g.beginPath(); g.arc(px(e.pos.x), pz(e.pos.z), 5, 0, 7); g.stroke();
        if (!player.alive && player.specTarget && player.specTarget.__remoteId === rid) {
          g.strokeStyle = '#3dff7a'; g.lineWidth = 2;
          g.beginPath(); g.arc(px(e.pos.x), pz(e.pos.z), 6.5, 0, 7); g.stroke();
        }
      }
    }
  } catch {}
  // tactical: molotov fires (orange) under smokes (grey) under projectiles (white ticks)
  try {
    for (const z of fireZones) {
      const rr = (z.radius / world) * S;
      g.fillStyle = 'rgba(255,110,20,0.35)';
      g.beginPath(); g.arc(px(z.pos.x), pz(z.pos.z), rr, 0, 7); g.fill();
      g.fillStyle = '#ff7a1e';
      g.beginPath(); g.arc(px(z.pos.x), pz(z.pos.z), 3, 0, 7); g.fill();
    }
    const tt = performance.now() / 1000;
    for (const s of tacticalSmokes) {
      const rr = (smokeVolumeRadius(s, tt) / world) * S;
      g.fillStyle = 'rgba(200,200,200,0.45)';
      g.beginPath(); g.arc(px(s.pos.x), pz(s.pos.z), Math.max(3, rr), 0, 7); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1;
      g.beginPath(); g.arc(px(s.pos.x), pz(s.pos.z), Math.max(3, rr), 0, 7); g.stroke();
    }
    g.fillStyle = '#ffffff';
    for (const p of nadeProjectiles) {
      g.fillRect(px(p.pos.x) - 1.5, pz(p.pos.z) - 1.5, 3, 3);
    }
  } catch (e) {}
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
// Exactly one T holds the C4 online: the T client with the lowest net id.
function isBombCarrierOnline() {
  try {
    if (!isOnline() || Net.id == null) return true;
    for (const r of Net.remoteList()) {
      if ((r.team || 't') !== 't') continue;
      if (r.id < Net.id) return false;
    }
    return true;
  } catch { return true; }
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
        get crouchK() { return e.crouchK || 0; },
        get wallRoll() { return e.wallRoll || 0; },
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
  camera.fov += (SET.fov - camera.fov) * Math.min(1, dt * 8);
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
    camera.position.set(target.pos.x, target.pos.y + EYE - CROUCH_EYE_DROP * (target.crouchK || (target.crouching ? 1 : 0)), target.pos.z);
    camera.rotation.y = player.yaw;
    camera.rotation.x = player.pitch;
    camera.rotation.z = target.wallRoll || 0;
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
  AudioSys.stopMusic(0.2);
  G.phase = 'playing'; G.round = 1; G.score = { ct: 0, t: 0 };
  G.kills = 0; G.deaths = 0; G.headshots = 0; G.shots = 0; G.hits = 0;
  G.startTime = performance.now();
  player.money = MONEY_START; player.kills = 0; player.deaths = 0; player.assists = 0;
  player._lastId = null; player._assistId = null;
  try { for (const b of bots) { b.kills = 0; b.deaths = 0; b.assists = 0; b._lastId = null; b._assistId = null; } } catch {}
  try { remoteStats.clear(); } catch {}
  player.armor = 0;
  player.weapons = newLoadout();
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
  $('buy-menu').classList.remove('open'); buyCursorSync();
  $('killfeed').innerHTML = '';
  // fresh battlefield: fade out tracers/smoke/debris, wipe decals (blood, holes, scorch)
  try { clearWorldWeapons(); setPickupHint(''); } catch (e) {}
  rmbDown = false;
  try {
    clearDecals();
    clearNades();
    try { clearGibs(); } catch (e2) {}
    for (const arr of [tracers, particles, smokes, shockwaves, worldFlashes, debrisChunks]) {
      for (const e of arr) { try { scene.remove(e.mesh); } catch (err) {} }
      arr.length = 0;
    }
    try { const fl = $('flash-overlay'); if (fl) fl.style.opacity = 0; } catch (e2) {}
    try { const bo = $('burn-overlay'); if (bo) bo.style.opacity = 0; } catch (e2) {}
  } catch (e) {}
  // CS loadout rules: survivors keep guns/ammo/armor, dead reset to pistol + no armor
  // Nades never carry over — rebuy every round (CS economy).
  player.nades = { he: 0, flash: 0, smoke: 0, molotov: 0 };
  player.cook = null; player.flashUntil = 0; player.flashMax = 0; player.burnT = 0;
  // CS loadout rules: survivors keep guns/ammo/armor, dead reset to pistol + no armor
  if (first || diedLastRound) {
    if (!first) {
      player.weapons = newLoadout();
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
  const spawnTaken = { ct: new Set(), t: new Set() };
  {
    const team = player.team || 'ct', slot = mySpawnSlot();
    spawnTaken[team].add(slot % spawnList(team).length);
    player.pos.copy(spawnPoint(team, slot));
    player.yaw = spawnYawPlayer(team, player.pos);
  }
  player.vel.set(0, 0, 0); player.pitch = 0;
  player.crouching = false; player.crouch = 0; player.exploded = false;
  player.airTuck = false; player.crouchWant = false; player.wallRun = null; player.wallCd = 0; player.lastWallBox = null; player.wallRoll = 0; player.wallLean = 0;
  player.onGround = true;
  try { resetPlayerBody(); } catch (e) { console.warn('player body reset', e); }
  if (!isNadeKey(player.cur) && (!player.weapons[player.cur] || !player.weapons[player.cur].owned)) player.cur = player.weapons.deagle.owned ? 'deagle' : SLOT_ORDER.find((k) => player.weapons[k].owned) || 'deagle';
  if (isNadeKey(player.cur) && (player.nades[player.cur] || 0) <= 0) player.cur = 'deagle';
  buildViewmodel(player.cur);
  if (viewmodel) viewmodel.visible = true;
  if (!isMultiplayer()) { for (const b of bots) { resetBot(b); b.mesh.visible = true; } }
  else { clearBotsForMP(); }
  // scatter bots to their spawns (face center) — skipped in pure PvP.
  if (!isMultiplayer()) {
    // Free slot per bot; CTs prefer the pocket on the side of the site they guard.
    const takeSlot = (team, parity) => {
      const n = spawnList(team).length, taken = spawnTaken[team];
      for (let pass = 0; pass < 2; pass++)
        for (let i = 0; i < n; i++) {
          if (taken.has(i) || (pass === 0 && parity != null && i % 2 !== parity)) continue;
          taken.add(i); return i;
        }
      return taken.size; // more actors than slots: wrap (jitter keeps them apart)
    };
    for (const b of bots) {
      if (!b.alive && !b.mesh.visible) continue;
      const slot = takeSlot(b.team, b.team === 'ct' ? (b.guardSite === 'B' ? 1 : 0) : null);
      b.pos.copy(spawnPoint(b.team, slot));
      b.yaw = spawnYawMesh(b.team, b.pos); b.mesh.rotation.y = b.yaw; b.mesh.position.copy(b.pos);
      if (b.blob) b.blob.position.set(b.pos.x, 0.02, b.pos.z);
    }
  }
  try { for (const [, e] of remotes) { if (e.data) { e.data.alive = true; e.data.hp = 100; } } } catch {}
  try { player._lastId = null; player._assistId = null; for (const b of bots) { b._lastId = null; b._assistId = null; } } catch {}
  try { const sb = $('scoreboard'); if (sb) sb.classList.add('hidden'); } catch {}
  bombResetRound();
  // Was: every T client set hasBomb = true, i.e. one C4 per T. Exactly one carrier now.
  try { if (isOnline() && (player.team || 'ct') === 't') player.hasBomb = isBombCarrierOnline(); } catch {}
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
      // No one left to defuse — fast-forward to detonation for pacing (once).
      if (!BOMB._fastFused) {
        BOMB._fastFused = true;
        BOMB.explodeAt = Math.min(BOMB.explodeAt, performance.now() / 1000 + 2.5);
        announce('ALL CT DOWN — BOMB WILL DETONATE', 1800);
      }
      return;
    }
    return; // Ts all dead but bomb ticking — play the defuse!
  }
  if (t <= 0 && ct <= 0) endRound('draw');
  else if (t <= 0) endRound('ct', BOMB.droppedPos ? 'T WIPED — SITE HELD' : 'T WIPED');
  else if (ct <= 0) endRound('t', 'CT WIPED');
}
function endRound(winner, reason, fromNet = false, serverScore = null) { // 'ct' | 't' | 'draw'
  if (G.phase !== 'playing' || G.roundEnding) return;
  G.roundEnding = true;
  if (G.buyOpen) toggleBuy(false);
  player.cook = null;
  updateInteractHUD(null);
  for (const b of bots) { b.planting = false; b.defusing = false; }
  try { if (isOnline() && !fromNet) Net.sendRound({ action: 'end', winner, reason: reason || '', round: G.round }); } catch {}

  const myTeam = player.team || 'ct';
  let track = null;
  if (serverScore && typeof serverScore.ct === 'number' && typeof serverScore.t === 'number') {
    G.score.ct = serverScore.ct; G.score.t = serverScore.t; // authority already counted it
  }
  else if (winner === 'ct') { G.score.ct++; }
  else if (winner === 't') { G.score.t++; }

  if (winner === 'draw') {
    addMoney(MONEY_DRAW);
    track = AudioSys.roundLose(reason);
    announceRoundEnd(reason || 'ROUND DRAW', '+$' + MONEY_DRAW, track, 3400);
  } else if (winner === myTeam) {
    addMoney(MONEY_WIN);
    track = AudioSys.roundWin(reason);
    announceRoundEnd(reason || 'ROUND WON', '+$' + MONEY_WIN, track, 3400);
  } else {
    addMoney(MONEY_LOSS);
    track = AudioSys.roundLose(reason);
    announceRoundEnd(reason || 'ROUND LOST', '+$' + MONEY_LOSS, track, 3400);
  }
  // bot economy irrelevant
  updateHUD();
  if (G.score.ct >= ROUNDS_TO_WIN_MATCH || G.score.t >= ROUNDS_TO_WIN_MATCH) { endMatch(); return; }
  G.round++;
  // Online: host drives the next round; guests wait for 'round/start' (plus fallback timer).
  try {
    if (isOnline() && !isRoundHost()) {
      setTimeout(() => { if (G.phase === 'playing' && G.roundEnding) startRound(false, true); }, 4000);
      return;
    }
  } catch {}
  setTimeout(() => { if (G.phase === 'playing') startRound(); }, 3800);
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
  const track = win ? AudioSys.roundWin('MATCH_WIN') : AudioSys.roundLose('MATCH_LOSS');
  const trackInfo = track ? `<br><span style="color:#ffd76d;font-size:14px;letter-spacing:1px;font-weight:700;">🎵 ${esc(track.title)}</span>` : '';
  $('end-stats').innerHTML = `Kills <b>${G.kills | 0}</b> · Deaths <b>${player.deaths | 0}</b> · Headshots <b>${G.headshots | 0}</b><br>Accuracy <b>${acc | 0}%</b> (${G.hits | 0}/${G.shots | 0}) · Cash <b>$${player.money | 0}</b>${trackInfo}`;
  $('end-screen').classList.remove('hidden');
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
function endWallRun() {
  if (!player.wallRun) return;
  player.wallRun = null;
  player.wallCd = WALLRUN.cooldown;
}
function updatePlayer(dt, t) {
  if (!player.alive) {
    // CS: dead until round ends — spectate a living teammate instead of a
    // static death cam. Auto-advances when the target dies (spectateCurrent).
    const before = player.specTarget;
    try { updateWorldWeapons(dt, t); } catch (e) {} // dropped guns keep falling while you spectate
    updateSpectate(dt);
    if (player.specTarget !== before) updateSpectateOverlay();
    try {
      if (isOnline()) Net.sendState({
        x: player.pos.x, y: player.pos.y, z: player.pos.z,
        yaw: player.yaw, pitch: player.pitch, hp: 0, alive: false,
        weapon: player.cur, aiming: false, moving: false, crouch: false, gnd: true, wr: 0, dual: false,
      });
    } catch {}
    return;
  }
  const frozen = isFreeze();
  const speedBase = player.cur === 'awp' && player.aiming ? 2.2 : 5.2;
  // Crouch: hold C (or toggle it, per settings). Blocks sprint, cuts speed, and
  // tightens the spread — the CS trade of mobility for accuracy.
  // The hull shrinks while crouched; you can't stand back up under an overhang.
  // Crouching in the air tucks the legs (feet rise) so crouch-jumps clear higher.
  const canAct = player.alive && G.phase === 'playing' && !frozen;
  let wantCrouch = SET.crouchToggle ? !!player.crouchWant : !!keys['KeyC'];
  if (!canAct) { wantCrouch = false; player.crouchWant = false; }
  if (player.wallRun && wantCrouch) { endWallRun(); } // C drops you off the wall
  if (wantCrouch && !player.crouching) {
    player.crouching = true;
    if (!player.onGround) {
      // tuck: lift feet unless something is right above the (now shorter) hull
      const ceil = ceilingAt(player.pos.x, player.pos.z, player.pos.y + CROUCH_HEIGHT, player.radius);
      if (player.pos.y + CROUCH_JUMP_LIFT + CROUCH_HEIGHT <= ceil) {
        player.pos.y += CROUCH_JUMP_LIFT; player.airTuck = true;
        player.crouch = Math.min(1, player.crouch + CROUCH_JUMP_LIFT / CROUCH_EYE_DROP); // keep the eye where it was
      }
    }
  } else if (!wantCrouch && player.crouching) {
    if (player.alive && !player.onGround && player.airTuck) {
      // untuck: legs drop back down if there's room below
      const floor = supportHeightAt(player.pos.x, player.pos.z, player.pos.y, player.radius);
      const drop = Math.min(CROUCH_JUMP_LIFT, Math.max(0, player.pos.y - floor));
      const test = new THREE.Vector3(player.pos.x, player.pos.y - drop, player.pos.z);
      if (!collidesAt(test, player.radius, STAND_HEIGHT)) {
        player.pos.y -= drop; player.crouching = false; player.airTuck = false;
        player.crouch = Math.max(0, player.crouch - drop / CROUCH_EYE_DROP);
      }
    } else if (!player.alive || !collidesAt(player.pos, player.radius, STAND_HEIGHT)) {
      player.crouching = false; player.airTuck = false;
    }
    // else: blocked by a ceiling — stay down until there's headroom
  }
  player.crouch = damp(player.crouch || 0, player.crouching ? 1 : 0, 11, dt);
  const wr = player.wallRun;
  const sprint = !frozen && keys['ShiftLeft'] && !player.aiming && !player.crouching && player.vel.lengthSq() > 0.1;
  const speed = frozen ? 0 : (player.aiming ? speedBase * 0.55 : speedBase) * (sprint ? 1.45 : 1) * (1 - 0.55 * player.crouch) * (isDualCur() ? DUAL.speedMul : 1) * smokeSlowAt(_smokePt.set(player.pos.x, player.pos.y + 1, player.pos.z));
  let ix = 0, iz = 0;
  if (canAct) {
    if (keys['KeyW']) iz -= 1; if (keys['KeyS']) iz += 1;
    if (keys['KeyA']) ix -= 1; if (keys['KeyD']) ix += 1;
  }
  const len = Math.hypot(ix, iz) || 1;
  ix /= len; iz /= len;
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
  const mx = (rx * ix + fx * -iz) * speed;
  const mz = (rz * ix + fz * -iz) * speed;

  const spaceDown = !!keys['Space'] && canAct;
  const spacePressed = spaceDown && !player.spaceWas;
  player.spaceWas = spaceDown;
  player.wallCd = Math.max(0, (player.wallCd || 0) - dt);
  const hull = playerHullHeight();

  if (player.wallRun) {
    const w = player.wallRun;
    w.t += dt;
    // still a wall there? (same face, same side)
    const still = findRunnableWall();
    const sameFace = still && still.nx === w.nx && still.nz === w.nz;
    if (sameFace) { w.box = still.box; w.side = still.side; w.tx = still.tx; w.tz = still.tz; }
    if (spacePressed) {
      // wall jump: kick off away from the wall and up, keep most of the run speed
      const along = player.vel.x * w.tx + player.vel.z * w.tz;
      player.vel.x = w.tx * Math.max(along, 0) * 0.85 + w.nx * WALLRUN.jumpOut;
      player.vel.z = w.tz * Math.max(along, 0) * 0.85 + w.nz * WALLRUN.jumpOut;
      player.vel.y = WALLRUN.jumpUp;
      endWallRun();
      AudioSys.step(null, true);
    } else if (!sameFace || w.t > WALLRUN.maxTime || !keys['KeyW'] || !canAct) {
      player.lastWallBox = w.box;
      endWallRun();
    } else {
      // glide along the tangent, hug the wall, sink slowly
      const k = Math.min(1, 8 * dt);
      const tgt = WALLRUN.speed * (sprint || keys['ShiftLeft'] ? 1.08 : 1);
      player.vel.x += (w.tx * tgt - w.nx * 0.6 - player.vel.x) * k;
      player.vel.z += (w.tz * tgt - w.nz * 0.6 - player.vel.z) * k;
      player.vel.y = Math.max(WALLRUN.maxSink, player.vel.y - WALLRUN.gravity * dt * (0.4 + w.t / WALLRUN.maxTime * 1.6));
      // wall steps
      if (t > stepAt) { stepAt = t + 0.24; AudioSys.step(null, true); }
    }
  } else {
    const accel = player.onGround ? 14 : 3;
    player.vel.x += (mx - player.vel.x) * Math.min(1, accel * dt);
    player.vel.z += (mz - player.vel.z) * Math.min(1, accel * dt);
    // gravity / jump (blocked while frozen — CS freeze time)
    if (player.onGround && spaceDown) { player.vel.y = 5.2; player.onGround = false; }
    // latch onto a wall: airborne, holding W, moving fast enough, not crouched
    if (!player.onGround && canAct && keys['KeyW'] && !player.crouching && player.wallCd <= 0) {
      const floorY = supportHeightAt(player.pos.x, player.pos.z, player.pos.y, player.radius);
      const hSp = Math.hypot(player.vel.x, player.vel.z);
      if (player.pos.y - floorY > WALLRUN.minAirY && hSp >= WALLRUN.minSpeed) {
        const w = findRunnableWall();
        if (w && w.along > -0.5 && w.box !== player.lastWallBox) {
          player.wallRun = { t: 0, nx: w.nx, nz: w.nz, tx: w.tx, tz: w.tz, side: w.side, box: w.box };
          player.vel.y = Math.max(player.vel.y * 0.5, 2.2); // small hop up as you plant a foot
          AudioSys.step(null, true);
        }
      }
    }
  }
  if (!player.wallRun) player.vel.y -= 13.5 * dt;
  const fallV = player.vel.y;
  const preX = player.pos.x, preZ = player.pos.z;
  moveWithCollision(player.pos, player.vel.x * dt, player.vel.z * dt, player.radius, hull);
  if (tacticalSmokes.length && (player.vel.x || player.vel.z)) smokePushAt(_smokePt.set(player.pos.x, player.pos.y + 1, player.pos.z), player.vel.x * dt * 8, player.vel.z * dt * 8, 1);
  if (player.wallRun && dt > 0) {
    // ran into something ahead (corner, pillar): stall counter, drop off after a beat
    const w = player.wallRun;
    const moved = ((player.pos.x - preX) * w.tx + (player.pos.z - preZ) * w.tz) / dt;
    w.stall = moved < 1.2 ? (w.stall || 0) + dt : 0;
    if (w.stall > 0.1) { player.lastWallBox = w.box; endWallRun(); }
  }
  // vertical: land on the ground or on top of boxes, bump heads on overhangs
  const prevY = player.pos.y;
  player.pos.y += player.vel.y * dt;
  if (player.vel.y > 0) {
    const ceil = ceilingAt(player.pos.x, player.pos.z, prevY + hull - 0.02, player.radius);
    if (player.pos.y + hull > ceil) { player.pos.y = Math.max(prevY, ceil - hull); player.vel.y = 0; }
  }
  const floorY = supportHeightAt(player.pos.x, player.pos.z, prevY, player.radius);
  if (player.pos.y <= floorY) {
    // landing thud scales with fall speed
    if (!player.onGround && fallV < -3.5 && player.alive) {
      AudioSys.land(fallV < -7);
      vmRig.landK = clamp(-fallV / 9, 0, 1);
    }
    if (player.airTuck) {
      // landed tucked: stay crouched (stand up next frame if C is released and there's room)
      player.airTuck = false;
    }
    player.pos.y = floorY; player.vel.y = Math.max(0, player.vel.y); player.onGround = true;
    player.lastWallBox = null; // touching down refreshes every wall
    if (player.wallRun) endWallRun();
  } else {
    player.onGround = false;
  }
  player.wallRoll = damp(player.wallRoll || 0, player.wallRun ? player.wallRun.side * WALLRUN.camRoll : 0, 10, dt);

  // footsteps (own boots, L/R alternating + sprint weight) — crouch-walking is silent
  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  if (player.onGround && hSpeed > 2 && t > stepAt && player.crouch < 0.5) { stepAt = t + (sprint ? 0.3 : 0.42); AudioSys.step(null, sprint); }
  void wr;

  const def = WEAPONS[player.cur] || { bloomDecay: 0.05, auto: false, zoomFov: 75 };
  const isNade = isNadeKey(player.cur);
  // --- bloom cool-down + punch / shake / sway recovery ---
  const coolMul = player.aiming ? 1.6 : 1;
  if (!isNade) player.bloom = Math.max(0, player.bloom - def.bloomDecay * coolMul * dt);
  if (t - player.lastShotT > 0.5) player.sprayIdx = Math.max(0, player.sprayIdx - dt * 6);
  const rec = Math.min(1, dt * 9);
  vmRig.punchP += (0 - vmRig.punchP) * Math.min(1, dt * 11);
  vmRig.punchY += (0 - vmRig.punchY) * rec;
  vmRig.shake += (0 - vmRig.shake) * Math.min(1, dt * 8);
  vmRig.fovKick += (0 - vmRig.fovKick) * Math.min(1, dt * 9);
  vmRig.swayX += (0 - vmRig.swayX) * Math.min(1, dt * 7);
  vmRig.swayY += (0 - vmRig.swayY) * Math.min(1, dt * 7);

  // --- camera with punch + shake + strafe lean + breathing ---
  const bob = hSpeed > 0.5 && (player.onGround || player.wallRun) ? Math.sin(t * (sprint ? 12 : 9)) * 0.035 * swayK() * (player.aiming ? 0.35 : 1) : 0;
  const breathe = player.aiming && player.onGround && hSpeed < 0.5 ? Math.sin(t * 1.9) * 0.0022 : 0;
  camera.position.set(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0) + bob, player.pos.z);
  camera.rotation.order = 'YXZ';
  const shk = vmRig.shake * shakeK();
  const shX = shk > 0.0005 ? (Math.random() - 0.5) * shk * 2 : 0;
  const shY = shk > 0.0005 ? (Math.random() - 0.5) * shk * 2 : 0;
  camera.rotation.y = player.yaw + vmRig.punchY + shY;
  camera.rotation.x = player.pitch + vmRig.punchP + shX + breathe;
  vmRig.roll += (0 - vmRig.roll) * Math.min(1, dt * 7);
  camera.rotation.z = clamp(-ix * 0.012, -0.02, 0.02) + (player.wallRoll || 0) + vmRig.roll + (shk > 0.0005 ? (Math.random() - 0.5) * shk : 0);

  // reload progress
  if (player.reloading > 0) {
    player.reloading -= dt;
    if (player.reloading <= 0) finishReload();
  }
  // firing (also catch fast semi-auto clicks that release within one frame; blocked in freeze)
  // nades throw via mousedown/mouseup prime-release — never via the hitscan path
  if (!isNade && (mouseDown || mouseJustDown) && player.alive && G.phase === 'playing' && !G.buyOpen && !isFreeze() && !G.roundEnding) {
    if (def.auto) playerTryFire(t);
    else if (mouseJustDown) { playerTryFire(t); }
  }
  const dualNow = !isNade && isDualCur();
  if (dualNow && (rmbDown || rmbJustDown) && player.alive && G.phase === 'playing' && !G.buyOpen && !isFreeze() && !G.roundEnding) {
    if (def.auto) playerTryFire(t, 'L');
    else if (rmbJustDown) playerTryFire(t, 'L');
  }
  if (!dualNow) rmbDown = false;
  rmbJustDown = false;
  if (isNade) mouseJustDown = false;
  else mouseJustDown = false;
  if (dualNow && player.alive && !isFreeze()) {
    // wandering aim: two heavy guns never sit still, worse on the move and when hot
    player.aiming = false;
    const unsteady = 1 + clamp(Math.hypot(player.vel.x, player.vel.z) / 4, 0, 1.2) + player.bloom * 20;
    player.yaw += (Math.sin(t * 1.7) + Math.sin(t * 2.9 + 1.3) * 0.6) * DUAL.driftYaw * unsteady * dt;
    player.pitch = clamp(player.pitch + (Math.sin(t * 2.3 + 0.5) + Math.sin(t * 3.7) * 0.5) * DUAL.driftPitch * unsteady * dt, -1.45, 1.45);
  }
  try { updateWorldWeapons(dt, t); } catch (e) { console.warn('world weapons', e); }

  // --- ADS blend + viewmodel motion (bob / sway / draw / reload) ---
  const wantAim = (player.aiming && player.alive && player.reloading <= 0) ? 1 : 0;
  vmRig.aimK += (wantAim - vmRig.aimK) * Math.min(1, dt * 13);
  const aimE = vmRig.aimK * vmRig.aimK * (3 - 2 * vmRig.aimK); // smoothstep
  // stock/butt sit under the cheek in ADS — hide them so they don't fill the bottom of the screen
  if (vmStockParts.length) { const vis = aimE < 0.55; if (vmStockParts[0].visible !== vis) for (const s of vmStockParts) s.visible = vis; }
  if (vmBase) {
    vmRig.bobT += dt * (2 + hSpeed * 1.55);
    vmRig.drawT = Math.min(1, vmRig.drawT + dt / 0.32);
    const solved = VM_AIM_SOLVED[player.cur];
    const hip = VM_HIP, aimP = (solved && solved.pos) || VM_AIM[player.cur] || VM_AIM.ak;
    const drawK = 1 - vmRig.drawT;
    const bobAmp = 0.009 * (1 - aimE * 0.94) * swayK();
    const bobX = Math.cos(vmRig.bobT * 0.5) * bobAmp * clamp(hSpeed / 5, 0, 1);
    const bobY = Math.abs(Math.sin(vmRig.bobT)) * bobAmp * 1.2 * clamp(hSpeed / 5, 0, 1) + Math.sin(t * 1.7) * 0.0018;
    let px = hip.x + (aimP.x - hip.x) * aimE + bobX + vmRig.swayX * (1 - aimE * 0.9);
    let py = hip.y + (aimP.y - hip.y) * aimE + bobY + vmRig.swayY * (1 - aimE * 0.9);
    let pz = hip.z + (aimP.z - hip.z) * aimE;
    // draw rise
    py -= drawK * 0.22;
    pz += drawK * 0.08;
    let rx = drawK * 0.55 + vmRig.swayY * 2.2 * (1 - aimE * 0.88);
    let ry = vmRig.swayX * 2.6 * (1 - aimE * 0.88);
    let rz = 0;
    // the solved tilt that levels the sight line, faded in with the ADS blend
    if (solved) { rx += solved.pitch * aimE; ry += solved.yaw * aimE; }
    // Reload, staged the way hands actually work it: cant the weapon inboard, drop
    // the empty, bring the fresh mag up and slap it home, run the charging handle,
    // settle. One sine dip (what this was) reads as a shrug.
    if (player.reloading > 0) {
      const rk = clamp(1 - player.reloading / player.reloadDur, 0, 1);
      const seg = (a, b) => clamp((rk - a) / (b - a), 0, 1);
      const bell = (a, b) => Math.sin(seg(a, b) * Math.PI);
      const tilt = seg(0, 0.18) - seg(0.86, 1);
      py -= tilt * 0.10;
      pz += tilt * 0.03;
      rx -= tilt * 0.62;
      rz += tilt * 0.34;
      ry += tilt * 0.22;
      rx += bell(0.44, 0.62) * 0.17 + bell(0.70, 0.86) * 0.10; // mag slap, then the bolt
      if (vmMag) {
        const drop = Math.max(0, seg(0.18, 0.44) - seg(0.52, 0.70));
        if (vmMag.userData.top) { vmMag.position.y = drop * 0.16; vmMag.position.z = drop * 0.12; vmMag.rotation.x = -drop * 0.35; }
        else { vmMag.position.y = -drop * 0.42; vmMag.position.z = drop * 0.10; vmMag.rotation.x = drop * 0.9; }
      }
      if (vmBolt && rk > 0.70 && rk < 0.90) vmBolt.position.z = 0.09 * bell(0.70, 0.90);
    } else if (vmMag && (vmMag.position.y !== 0 || vmMag.rotation.x !== 0)) {
      vmMag.position.set(0, 0, 0); vmMag.rotation.x = 0;
    }
    // landing absorb: the gun keeps travelling down for a beat after the boots stop
    vmRig.landK = Math.max(0, (vmRig.landK || 0) - dt * 3.4);
    py -= vmRig.landK * 0.085;
    rx += vmRig.landK * 0.22;
    // hands on the bomb: weapon swings down out of the way
    const busyHands = (keys['KeyE'] && (playerNearPlantedBomb() || playerInPlantSite())) ? 1 : 0;
    vmRig.busyK = damp(vmRig.busyK || 0, busyHands, 9, dt);
    py -= vmRig.busyK * 0.30;
    pz += vmRig.busyK * 0.05;
    rx -= vmRig.busyK * 1.05;
    rz += vmRig.busyK * 0.25;
    // sprint lowers gun
    if (sprint && hSpeed > 3) { py -= 0.03; rx -= 0.35; ry += 0.15; }
    // wall run: gun shifts away from the wall and cants level, steps up the bob
    if (player.wallRun) {
      const ws = player.wallRun.side;
      px -= ws * 0.045 * (1 - aimE * 0.5);
      py += 0.012;
      rz += ws * 0.16;
      ry += ws * 0.10;
    }
    if (vmL) {
      // two guns: spread them apart, each wobbling on its own
      const wob = Math.sin(t * 2.3) * 0.006, wob2 = Math.cos(t * 1.9) * 0.006;
      vmL.base.position.set(-px - 0.03 + wob2, py + wob, pz);
      vmL.base.rotation.set(rx + wob * 2, -ry + 0.06, -rz);
      px += 0.03; py += wob2; ry -= 0.06;
    }
    vmBase.position.set(px, py, pz);
    vmBase.rotation.set(rx, ry, rz);
  }

  // aim / FOV (with punch kick that springs back)
  const targetFov = (!isNade && player.aiming ? def.zoomFov : SET.fov) + vmRig.fovKick;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 14);
  camera.updateProjectionMatrix();
  const scoped = player.aiming && player.cur === 'awp' && !isNade;
  $('scope-overlay').classList.toggle('hidden', !scoped);
  // nades show a dot crosshair (no spread) + flash whites it out via overlay
  // A crosshair painted over the iron sights hides the very thing you are aiming
  // with, and the two disagree anyway. Fade it out with the ADS blend; grenades
  // have no sights, so they keep theirs.
  const adsHide = isNade ? 0 : aimE;
  $('crosshair').style.opacity = (scoped || !player.alive) ? 0 : (1 - adsHide).toFixed(3);
  if (viewmodel) viewmodel.visible = !scoped && player.alive;
  // crosshair reflects heat + motion (bloom-driven); nades stay tight
  const wantGap = isNade ? 8 : 6 + player.bloom * 620 + hSpeed * 1.3 + (player.onGround ? 0 : player.wallRun ? 4 : 9) + (player.aiming ? -2 : 0) - (player.crouch || 0) * 2 + (isDualCur() ? 16 : 0);
  crossGap += (clamp(wantGap, 5, 46) - crossGap) * Math.min(1, dt * 10);
  // hide spread UI glitch: hide crosshair lines while reloading draw? keep visible
  // --- multiplayer snapshot out (~20Hz) ---
  try {
    if (isOnline()) Net.sendState({
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      yaw: player.yaw, pitch: player.pitch, hp: Math.max(0, Math.round(player.hp)),
      alive: player.alive, weapon: player.cur, aiming: !!player.aiming, moving: hSpeed > 0.8,
      crouch: !!player.crouching, gnd: !!player.onGround, dual: isDualCur(),
      wr: player.wallRun ? player.wallRun.side : 0,
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
    // alive counts already live in the scoreboard; this line is just machine + link health
    const ping = isOnline() && Net.rtt ? ` · ${Math.round(Net.rtt)} MS` : '';
    $('fps-counter').textContent = `${fps} FPS${ping}`;
    if (isOnline()) updateMPStatus(); // player count can change between roster events
    fpsAcc = 0; fpsAt = now;
  }
}

// ---------------- Main loop ----------------
const clock = new THREE.Clock();
// Frame scheduler. VSync: requestAnimationFrame (display refresh). Otherwise a
// high-resolution pacer that can run up to 500 fps: coarse setTimeout sleep, then
// MessageChannel hops (no 4ms timer clamp) for the last couple of milliseconds.
const _frameMC = new MessageChannel();
let _frameNext = 0, _frameQueued = false, _hudAt = 0, _mmAt = 0;
_frameMC.port1.onmessage = () => { _frameQueued = false; pace(); };
function scheduleFrame() {
  if (SET.vsync || document.hidden) { requestAnimationFrame(pace); return; }
  const wait = _frameNext - performance.now();
  if (wait > 4) setTimeout(pace, wait - 3);
  else if (!_frameQueued) { _frameQueued = true; _frameMC.port2.postMessage(0); }
}
function pace() {
  if (SET.vsync || document.hidden) { loop(); requestAnimationFrame(pace); return; }
  const now = performance.now();
  if (now + 0.25 < _frameNext) { scheduleFrame(); return; }
  const interval = 1000 / Math.max(30, Math.min(500, SET.fpsCap || 240));
  // keep a steady cadence; if we fell a whole frame behind, don't try to catch up
  _frameNext = (now - _frameNext > interval) ? now + interval : _frameNext + interval;
  loop();
  scheduleFrame();
}
function loop() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = performance.now() / 1000;
  if (G.phase === 'playing') {
    // CS timers: freeze first (round clock paused), then live; buy window ticks throughout
    if (G.freezeLeft > 0) {
      G.freezeLeft = Math.max(0, G.freezeLeft - dt);
      if (G.freezeLeft <= 0 && !G.roundEnding) {
        announce('GO GO GO', 900);
        AudioSys.stopMusic(1.5);
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
    try { updatePlayerBody(dt, t); } catch (e) { console.warn('player body', e); }
    if (!isMultiplayer()) {
      for (const b of bots) updateBot(b, dt, t);
      for (const b of bots) animateBotMesh(b, dt, t);
    }
    try { if (isOnline()) updateRemoteMeshes(dt, t); } catch {}
    updateBomb(dt, t);
    try { updateNades(dt, t); } catch (e) { console.warn('nades', e); }
    updateEffects(dt, t);
    try { updateScreenFeel(dt, t); } catch (e) {}
    try { updateGoreScreen(dt); } catch (e) {}
    // HUD: ~4Hz normally, every frame during freeze/buy/bomb countdown for smooth display
    // HUD is DOM work: time-based so 500 fps doesn't mean 500 layouts/s
    const hudGap = (G.freezeLeft > 0 || BOMB.planted) ? 1 / 30 : G.buyLeft > 0 ? 1 / 15 : 0.25;
    if (t - _hudAt >= hudGap) { _hudAt = t; updateHUD(); updateBuyTimer(); }
    else if (G.buyOpen) updateBuyTimer(); // smooth timer bar while shopping
    if (t - _mmAt >= 1 / 60) { _mmAt = t; drawMinimap(t); }
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
        botDepenetrate(b);
        const nd = navSteer(b, b.wp, t, 2);
        if (!nd) b.wp = randPick(waypoints).clone();
        else { moveWithCollision(b.pos, nd.x * b.speed * 0.5 * dt, nd.z * b.speed * 0.5 * dt, BOT_R); b.yaw = Math.atan2(nd.x, nd.z); }
        b.mesh.position.copy(b.pos); b.mesh.rotation.y = b.yaw;
      }
      updateEffects(dt, t);
    }
  }
  fpsTick();
  renderer.render(scene, camera);
  captureFlashAfterimage();
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
  const name = (nameEl && nameEl.value ? nameEl.value : ('Player' + ((Math.random() * 900 + 100) | 0))).replace(/[<>&"']/g, '').trim().slice(0, 16) || 'Player';
  let url = (urlEl && urlEl.value ? urlEl.value.trim() : '') || defaultWsUrl();
  if (!/^wss?:\/\/[^/]+(\/.*)?$/.test(url)) url = defaultWsUrl();
  url = url.slice(0, 200);
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
  loadSettings();
  try { wireSettingsUI(); } catch (e) { console.warn('settings ui', e); }
  applySettings();
  try { wireMultiplayer(); updateMPStatus(); } catch {}
  // Restore last MP settings into the menu (if the new MP panel exists).
  try {
    const n = String(localStorage.getItem('h5cs_name') || '').replace(/[<>&"']/g, '').slice(0, 16);
    const u = String(localStorage.getItem('h5cs_url') || '').slice(0, 200);
    if (n && document.getElementById('mp-name')) document.getElementById('mp-name').value = n;
    if (u && /^wss?:\/\//.test(u) && document.getElementById('mp-url')) document.getElementById('mp-url').value = u;
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

  $('opt-sound').addEventListener('change', (e) => { SET.sound = e.target.checked; applySettings(); saveSettings(); });
  if ($('opt-music')) $('opt-music').addEventListener('change', (e) => { SET.music = e.target.checked; applySettings(); saveSettings(); });
  $('opt-diff').addEventListener('change', (e) => { SET.difficulty = parseFloat(e.target.value); applySettings(); saveSettings(); });
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
    // Respect the team dropdown: 't' → player attacks as T (has bomb); anything else → CT.
    const teamSel = $('mp-team') ? $('mp-team').value : 'ct';
    player.team = (teamSel === 't') ? 't' : 'ct';
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
  if (legacyPlay) legacyPlay.addEventListener('click', () => { AudioSys.init(); startMatch(); });
  $('resume-btn').addEventListener('click', resumeGame);
  $('restart-btn').addEventListener('click', () => { $('pause-menu').classList.add('hidden'); G.phase = 'playing'; AudioSys.stopMusic(0.2); startMatch(); });
  $('again-btn').addEventListener('click', () => { AudioSys.stopMusic(0.2); startMatch(); });

  $('loading-note').textContent = 'Ready. Click DEPLOY.';
  pace();
}

boot();
