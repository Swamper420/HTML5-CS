// js/audio.js — AGENTS: all sound lives here. ADD weapons by adding layers in shoot().
// Procedural WebAudio + recorded samples, full 3D (distance/pan/occlusion/reverb).
// main.js must call bindAudioEnv({ getCamera, getPlayer, hasLOS }) at boot.
// Ownership: AudioSys only. Imports SET/opts from settings.js, never the reverse.

import * as THREE from 'three';
import { clamp, rand } from './utils.js';
import { SET, opts } from './settings.js';

// Runtime scene hooks (avoid main.js <-> audio import cycle).
const _env = { getCamera: null, getPlayer: null, hasLOS: null };
const _auA = new THREE.Vector3(), _auB = new THREE.Vector3();
export function bindAudioEnv(e) { Object.assign(_env, e || {}); }

// ---------------- Audio (procedural WebAudio, full 3D) ----------------
// Realistic + dynamic: inverse-distance volume, stereo pan from listener yaw,
// air-absorption lowpass, wall occlusion, speed-of-sound delay, shared
// generated-impulse reverb + slap echo, per-weapon randomized layers.
export const AudioSys = {
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
    cash: 'sounds/cash.mp3', whistle: 'sounds/whistle.mp3', glass: 'sounds/glass.mp3',
    thud: 'sounds/thud.mp3', punch: 'sounds/punch.mp3', tarzan: 'sounds/tarzan.mp3',
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
      this._ambientLife();
    } catch (e) {}
  },
  _ambientLife() {
    // ponytail: one timer, procedural only — gusts + distant crows so the map breathes
    const tick = () => {
      if (!this.ctx) return;
      try {
        if (opts.sound && !this.muted && !document.hidden) {
          if (Math.random() < 0.5) this._gust();
          else this._crow();
        }
      } catch (e) {}
      setTimeout(tick, rand(7000, 18000));
    };
    setTimeout(tick, 5000);
  },
  _gust() {
    this._noise({ dur: 2.2, type: 'lowpass', freq: 420, sweepTo: 180, peak: 0.055, decay: 2.0, rate: 0.5, verb: 0.25, brown: true });
  },
  _crow() {
    if (!this.ctx || !opts.sound || this.muted) return;
    const n = 2 + ((Math.random() * 2) | 0);
    for (let i = 0; i < n; i++) {
      this._tone({ type: 'triangle', f0: rand(1300, 1700), f1: rand(750, 950), dur: 0.16, peak: 0.045, decay: 0.15, verb: 0.3, at: i * rand(0.18, 0.26) });
    }
  },
  rustle(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    this._noise({ dur: 0.12, type: 'bandpass', freq: rand(1800, 3200), Q: 0.7, peak: 0.16, decay: 0.1, rate: rand(1.2, 1.7), pos, kind: 'sfx', verb: 0.06 });
  },
  cash() {
    if (!this.ctx || !opts.sound || this.muted) return;
    // real coin-win recording; synth cha-ching fallback until decoded
    if (this._sample({ name: 'cash', peak: 0.5, dur: 1.2, verb: 0.06 })) return;
    this._tone({ type: 'sine', f0: 1568, dur: 0.09, peak: 0.16, decay: 0.08, verb: 0.06 });
    this._tone({ type: 'sine', f0: 2093, dur: 0.18, peak: 0.1, decay: 0.16, verb: 0.06, at: 0.07 });
  },
  whistle() {
    if (!this.ctx || !opts.sound || this.muted) return;
    // round-start ref whistle; dry pea-trill fallback until decoded
    if (this._sample({ name: 'whistle', peak: 0.4, dur: 0.9, verb: 0.12 })) return;
    this._tone({ type: 'triangle', f0: 2300, dur: 0.14, peak: 0.2, decay: 0.13, verb: 0.1 });
    this._tone({ type: 'triangle', f0: 2300, dur: 0.2, peak: 0.2, decay: 0.19, verb: 0.1, at: 0.16 });
  },
  thud(pos = null) {
    if (!this.ctx || !opts.sound || this.muted) return;
    // body hitting dirt: real recording + dust wash, positional for corpses
    if (this._sample({ name: 'thud', peak: 0.55, dur: 0.9, pos, kind: 'impact', verb: 0.1 })) {
      this._noise({ dur: 0.12, type: 'lowpass', freq: 500, sweepTo: 150, peak: 0.14, decay: 0.1, rate: 0.8, pos, kind: 'impact' });
      return;
    }
    this._tone({ type: 'sine', f0: 95, f1: 40, dur: 0.12, peak: 0.3, decay: 0.11, pos, kind: 'impact' });
    this._noise({ dur: 0.1, type: 'lowpass', freq: 500, peak: 0.2, decay: 0.09, rate: 0.8, pos, kind: 'impact' });
  },
  jump() {
    if (!this.ctx || !opts.sound || this.muted) return;
    this._noise({ dur: 0.14, type: 'bandpass', freq: 900, Q: 1, peak: 0.09, decay: 0.12, rate: 1 });
    this._tone({ type: 'sine', f0: 180, f1: 120, dur: 0.1, peak: 0.07, decay: 0.09 });
  },
  peeLoop(on) {
    // Own stream: one persistent trickle voice, call every frame, on=false frees it.
    if (!this.ctx) return;
    on = !!on && !!opts.sound && !this.muted;
    const t = this.now();
    let h = this._peeLp;
    if (!h) {
      if (!on) return;
      try {
        const src = this.ctx.createBufferSource();
        src.buffer = this._white; src.loop = true; src.playbackRate.value = 1.4;
        const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 4200; f.Q.value = 0.7;
        const g = this.ctx.createGain(); g.gain.value = 0;
        src.connect(f); f.connect(g); g.connect(this.master);
        src.start();
        h = this._peeLp = { src, f, g };
      } catch (e) { return; }
    }
    try {
      // splatter wobble so it never sounds like a steady hose
      h.f.frequency.setTargetAtTime(3800 + 900 * Math.sin(t * 13) + 400 * Math.sin(t * 31), t, 0.03);
      h.g.gain.setTargetAtTime(on ? 0.09 : 0, t, on ? 0.08 : 0.06);
    } catch (e) {}
    if (!on) {
      const { src, f, g } = h;
      this._peeLp = null;
      try {
        src.stop(t + 0.3);
        setTimeout(() => { try { src.disconnect(); f.disconnect(); g.disconnect(); } catch (e) {} }, 500);
      } catch (e) {}
    }
  },
  peeAt(pos) {
    // Someone else's stream: short positional trickle burst (fired per relay update).
    if (!this.ctx || !opts.sound || this.muted || !pos) return;
    this._noise({ dur: 0.4, type: 'bandpass', freq: 4200, Q: 0.7, peak: 0.22, decay: 0.38, rate: 1.4, pos, kind: 'sfx', verb: 0.08 });
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
      const cam = _env.getCamera ? _env.getCamera() : null;
      if (cam && cam.position) {
        return { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      }
    } catch (e) {}
    try {
      const pl = _env.getPlayer ? _env.getPlayer() : null;
      if (pl && pl.pos) {
        return { x: pl.pos.x, y: pl.pos.y + 1.6, z: pl.pos.z };
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
    else if (kind === 'helix') vol = 1 / (1 + dist * 0.042); // coilgun carries map-wide like a blast
    else if (kind === 'yell') vol = 1 / (1 + dist * 0.055); // war cry carries across the map
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
      let yaw = 0;
      try { const pl = _env.getPlayer ? _env.getPlayer() : null; if (pl) yaw = pl.yaw || 0; } catch (e) {}
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
      const hasLOS = _env.hasLOS || null;
      if (dist > 3 && dist <= 30 && hasLOS) {
        _auA.set(lp0.x, lp0.y, lp0.z);
        _auB.set(pos.x, (pos.y ?? 1.4), pos.z);
        if (!hasLOS(_auA, _auB)) occluded = true;
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
    if (kind === 'machete') {
      // massive blade swing: air whoosh + faint edge ring. Flesh impact comes from gib()/headpop() on hit.
      this._noise({ dur: 0.22, type: 'bandpass', freq: 2600, sweepTo: 500, Q: 1.1, peak: 0.5 * lv, decay: 0.18, rate: 1.0, pos, kind: 'sfx', verb: dry });
      this._noise({ dur: 0.1, type: 'highpass', freq: 4800, peak: 0.16 * lv, decay: 0.07, rate: 1.3, pos, kind: 'sfx', verb: dry });
      return;
    }
    if (kind === 'helix') {
      // HELIX ARC: pure synth — coil whine snap, plasma crack, sub slam, shimmer tail. No samples.
      // kind 'helix' carries map-wide so the release reads at long distance.
      this._tone({ type: 'sine', f0: 1400, f1: 2200, dur: 0.09, peak: 0.30 * lv, decay: 0.08, pos, kind: 'helix', verb: dry });
      this._noise({ dur: 0.05, type: 'highpass', freq: 4200, peak: 0.5 * lv, decay: 0.04, rate: 1.6, pos, kind: 'helix', verb: dry });
      this._noise({ dur: 0.3, type: 'bandpass', freq: 2400, Q: 0.8, peak: 0.55 * lv, decay: 0.22, rate: 1.1, pos, kind: 'helix', verb: dry, echo: firstPerson ? 0.05 : 0.12 });
      this._tone({ type: 'sine', f0: 220, f1: 28, dur: 0.7, peak: 0.65 * lv, decay: 0.6, pos, kind: 'helix', verb: dry });
      this._tone({ type: 'sine', f0: 1750, dur: 0.5, peak: 0.14 * lv, decay: 0.45, pos, kind: 'helix', verb: 0.2 });
      this._tone({ type: 'sine', f0: 2620, dur: 0.7, peak: 0.10 * lv, decay: 0.6, pos, kind: 'helix', verb: 0.25, at: 0.05 });
      this._noise({ dur: 0.9, type: 'lowpass', freq: 600, sweepTo: 70, peak: 0.4 * lv, decay: 0.8, rate: 0.7, pos, kind: 'helix', verb: 0.3, echo: 0.3, at: 0.08, brown: true });
      return;
    }
    if (kind === 'portal') {
      // Portal gun: quick zap in, warble out. Pure synth, no samples.
      this._tone({ type: 'sine', f0: 300, f1: 950, dur: 0.16, peak: 0.4 * lv, decay: 0.14, pos, kind: 'sfx', verb: dry });
      this._tone({ type: 'sine', f0: 950, f1: 280, dur: 0.22, peak: 0.25 * lv, decay: 0.2, pos, kind: 'sfx', verb: dry, at: 0.05 });
      return;
    }
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
  mech(pos = null) {    if (!this.ctx || !opts.sound || this.muted) return;
    // bolt clack: two dry metal snaps, no pitched ring — staged on the ctx clock
    this._noise({ dur: 0.03, type: 'bandpass', freq: 3200, Q: 2.2, peak: 0.16, decay: 0.028, rate: 1.5, pos, kind: 'sfx' });
    this._noise({ dur: 0.025, type: 'highpass', freq: 5200, peak: 0.08, decay: 0.02, rate: 1.7, pos, kind: 'sfx' });
    this._noise({ dur: 0.04, type: 'bandpass', freq: 2000, Q: 1.8, peak: 0.15, decay: 0.035, rate: 1.2, pos, kind: 'sfx', at: 0.055 });
    this._noise({ dur: 0.025, type: 'highpass', freq: 4600, peak: 0.07, decay: 0.02, rate: 1.6, pos, kind: 'sfx', at: 0.055 });
  },
  helixWhine(k) {
    // HELIX rotor loop: one persistent voice whose pitch/gain follow rotor energy 0..1.
    // Call every frame while the gun is up; k=0 coasts it silent and frees the nodes.
    if (!this.ctx) return;
    k = (!opts.sound || this.muted) ? 0 : clamp(k || 0, 0, 1);
    const t = this.now();
    let h = this._helixWh;
    if (!h) {
      if (k <= 0.001) return;
      try {
        const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 80;
        const o2 = this.ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 160;
        const g2 = this.ctx.createGain(); g2.gain.value = 0.3;
        const g = this.ctx.createGain(); g.gain.value = 0;
        o.connect(g); o2.connect(g2); g2.connect(g); g.connect(this.master);
        o.start(); o2.start();
        h = this._helixWh = { o, o2, g };
      } catch (e) { return; }
    }
    try {
      h.o.frequency.setTargetAtTime(80 + k * 1320, t, 0.03);
      h.o2.frequency.setTargetAtTime(160 + k * 2640, t, 0.03);
      h.g.gain.setTargetAtTime(k * 0.14, t, 0.06);
    } catch (e) {}
    if (k <= 0.001 && h) {
      // coasted out: stop + disconnect shortly after the ramp lands
      const { o, o2, g } = h;
      this._helixWh = null;
      try {
        o.stop(t + 0.5); o2.stop(t + 0.5);
        setTimeout(() => { try { o.disconnect(); o2.disconnect(); g.disconnect(); } catch (e) {} }, 700);
      } catch (e) {}
    }
  },
  helixRemote(id, k, pos) {
    // Per-remote coil loop driven by snapshot sound state (helix 0..1).
    // Call every frame; k<=0 frees the voice. Positioned, map-wide loud.
    if (!this.ctx) return;
    if (!opts.sound || this.muted) k = 0;
    k = clamp(k || 0, 0, 1);
    if (!this._helixRem) this._helixRem = {};
    let h = this._helixRem[id];
    if (!h) {
      if (k <= 0.01 || !pos) return;
      try {
        const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 80;
        const o2 = this.ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 160;
        const g2 = this.ctx.createGain(); g2.gain.value = 0.3;
        const g = this.ctx.createGain(); g.gain.value = 0;
        const pan = this._pan(0);
        o.connect(g); o2.connect(g2); g2.connect(g); g.connect(pan);
        o.start(); o2.start();
        h = this._helixRem[id] = { o, o2, g, pan };
      } catch (e) { return; }
    }
    const t = this.now();
    try {
      if (pos && k > 0.01) {
        const s = this._spatial(pos, 'helix');
        h.o.frequency.setTargetAtTime(80 + k * 1320, t, 0.05);
        h.o2.frequency.setTargetAtTime(160 + k * 2640, t, 0.05);
        h.g.gain.setTargetAtTime(k * 0.5 * s.vol, t, 0.08);
        try { if (h.pan && h.pan.pan) h.pan.pan.setTargetAtTime(clamp(s.pan, -1, 1), t, 0.08); } catch (e) {}
      } else {
        h.g.gain.setTargetAtTime(0, t, 0.08);
      }
    } catch (e) {}
    if ((k <= 0.01 || !pos) && h) {
      const { o, o2, g, pan } = h;
      delete this._helixRem[id];
      try {
        o.stop(t + 0.4); o2.stop(t + 0.4);
        setTimeout(() => { try { o.disconnect(); o2.disconnect(); g.disconnect(); if (pan !== this.master) pan.disconnect(); } catch (e) {} }, 600);
      } catch (e) {}
    }
  },
  helixReady() {
    // cell recharged: bright double-chime + soft thunk.
    if (!this.ctx || !opts.sound || this.muted) return;
    this._tone({ type: 'sine', f0: 880, dur: 0.12, peak: 0.22, decay: 0.11, verb: 0.08 });
    this._tone({ type: 'sine', f0: 1320, dur: 0.18, peak: 0.20, decay: 0.16, verb: 0.08, at: 0.09 });
    this._noise({ dur: 0.05, type: 'lowpass', freq: 700, peak: 0.18, decay: 0.045, rate: 0.9 });
  },
  helixWindupAt(pos) {
    // Remote coil wind-up: one-shot rising whine (~1s spool), map-wide loud.
    // ponytail: one-shot, resend per trigger hold — no per-frame net spam.
    if (!this.ctx || !opts.sound || this.muted || !pos) return;
    this._tone({ type: 'sine', f0: 80, f1: 1400, dur: 1.1, peak: 0.5, decay: 1.0, pos, kind: 'helix' });
    this._tone({ type: 'triangle', f0: 160, f1: 2800, dur: 1.1, peak: 0.16, decay: 1.0, pos, kind: 'helix' });
  },
  helixReloadAt(pos) {
    // Remote cell recharge: handling clack + rising recharge hum, map-wide loud.
    if (!this.ctx || !opts.sound || this.muted || !pos) return;
    this._noise({ dur: 0.055, type: 'bandpass', freq: 950, Q: 1.8, peak: 0.35, decay: 0.05, rate: 1.1, pos, kind: 'helix' });
    this._tone({ type: 'sine', f0: 100, f1: 800, dur: 1.6, peak: 0.3, decay: 1.5, pos, kind: 'helix', at: 0.1 });
  },
  helixReadyAt(pos) {
    // Remote cell charged: bright double-chime, map-wide loud.
    if (!this.ctx || !opts.sound || this.muted || !pos) return;
    this._tone({ type: 'sine', f0: 880, dur: 0.12, peak: 0.3, decay: 0.11, pos, kind: 'helix', verb: 0.15 });
    this._tone({ type: 'sine', f0: 1320, dur: 0.18, peak: 0.28, decay: 0.16, pos, kind: 'helix', verb: 0.15, at: 0.09 });
  },
  yarisEngine(k) {
    // Beater engine loop: one persistent voice, pitch/gain follow speed 0..1.
    // Call every frame while driving; k=0 coasts it silent and frees the nodes.
    if (!this.ctx) return;
    k = (!opts.sound || this.muted) ? 0 : clamp(k || 0, 0, 1);
    const t = this.now();
    let h = this._yarisEng;
    if (!h) {
      if (k <= 0.001) return;
      try {
        const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 48;
        const o2 = this.ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 24;
        const g2 = this.ctx.createGain(); g2.gain.value = 0.5;
        const g = this.ctx.createGain(); g.gain.value = 0;
        o.connect(g); o2.connect(g2); g2.connect(g); g.connect(this.master);
        o.start(); o2.start();
        h = this._yarisEng = { o, o2, g };
      } catch (e) { return; }
    }
    try {
      // misfiring idle: uneven wobble so it never sounds healthy
      const wob = 1 + 0.13 * Math.sin(t * 23) + 0.07 * Math.sin(t * 41);
      h.o.frequency.setTargetAtTime((48 + k * 110) * wob, t, 0.03);
      h.o2.frequency.setTargetAtTime((24 + k * 55) * wob, t, 0.03);
      h.g.gain.setTargetAtTime(0.05 + k * 0.11, t, 0.06);
    } catch (e) {}
    if (k <= 0.001 && h) {
      const { o, o2, g } = h;
      this._yarisEng = null;
      try {
        o.stop(t + 0.5); o2.stop(t + 0.5);
        setTimeout(() => { try { o.disconnect(); o2.disconnect(); g.disconnect(); } catch (e) {} }, 700);
      } catch (e) {}
    }
  },
  yarisRemote(id, k, pos) {
    // Per-remote beater loop driven by snapshot yaris state. Call every frame;
    // k<=0 frees the voice. Positioned, loud enough to hear coming.
    if (!this.ctx) return;
    if (!opts.sound || this.muted) k = 0;
    k = clamp(k || 0, 0, 1);
    if (!this._yarisRem) this._yarisRem = {};
    let h = this._yarisRem[id];
    if (!h) {
      if (k <= 0.01 || !pos) return;
      try {
        const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 48;
        const o2 = this.ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 24;
        const g2 = this.ctx.createGain(); g2.gain.value = 0.5;
        const g = this.ctx.createGain(); g.gain.value = 0;
        const pan = this._pan(0);
        o.connect(g); o2.connect(g2); g2.connect(g); g.connect(pan);
        o.start(); o2.start();
        h = this._yarisRem[id] = { o, o2, g, pan };
      } catch (e) { return; }
    }
    const t = this.now();
    try {
      if (pos && k > 0.01) {
        const s = this._spatial(pos, 'helix');
        const wob = 1 + 0.13 * Math.sin(t * 23 + id) + 0.07 * Math.sin(t * 41);
        h.o.frequency.setTargetAtTime((48 + k * 110) * wob, t, 0.05);
        h.o2.frequency.setTargetAtTime((24 + k * 55) * wob, t, 0.05);
        h.g.gain.setTargetAtTime((0.05 + k * 0.11) * 2.2 * s.vol, t, 0.08);
        try { if (h.pan && h.pan.pan) h.pan.pan.setTargetAtTime(clamp(s.pan, -1, 1), t, 0.08); } catch (e) {}
      } else {
        h.g.gain.setTargetAtTime(0, t, 0.08);
      }
    } catch (e) {}
    if ((k <= 0.01 || !pos) && h) {
      const { o, o2, g, pan } = h;
      delete this._yarisRem[id];
      try {
        o.stop(t + 0.4); o2.stop(t + 0.4);
        setTimeout(() => { try { o.disconnect(); o2.disconnect(); g.disconnect(); if (pan !== this.master) pan.disconnect(); } catch (e) {} }, 600);
      } catch (e) {}
    }
  },
  yarisHonkAt(pos) {
    // dual-tone beater horn, positional so you hear whose it is
    if (!this.ctx || !opts.sound || this.muted) return;
    this._tone({ type: 'triangle', f0: 620, dur: 0.28, peak: 0.30, decay: 0.26, pos, kind: 'beep', verb: 0.1 });
    this._tone({ type: 'triangle', f0: 780, dur: 0.28, peak: 0.30, decay: 0.26, pos, kind: 'beep', verb: 0.1 });
  },
  yarisBackfireAt(pos) {
    // rich-running backfire: sharp crack + low thump, positional
    if (!this.ctx || !opts.sound || this.muted) return;
    this._noise({ dur: 0.06, type: 'highpass', freq: 2000, peak: 0.5, decay: 0.05, rate: 1.3, pos, kind: 'gun' });
    this._tone({ type: 'sine', f0: 120, f1: 40, dur: 0.22, peak: 0.4, decay: 0.2, pos, kind: 'gun' });
  },
  yarisDoorAt(pos) {
    // door slam: dull clunk + rattle
    if (!this.ctx || !opts.sound || this.muted) return;
    this._noise({ dur: 0.07, type: 'lowpass', freq: 500, peak: 0.35, decay: 0.06, rate: 0.8, pos, kind: 'sfx' });
    this._noise({ dur: 0.09, type: 'bandpass', freq: 1800, Q: 2, peak: 0.12, decay: 0.08, rate: 1.2, pos, kind: 'sfx', at: 0.03 });
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
    // real body-punch layer under the synth grunt — felt, not melodic
    this._sample({ name: 'punch', peak: 0.4, dur: 0.4, verb: 0.04 });
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
      // ~1 in 4 steps: faint gear jingle so own movement isn't metronomic
      if (Math.random() < 0.25) this._noise({ dur: 0.05, type: 'highpass', freq: rand(4000, 6000), peak: 0.03, decay: 0.04, rate: rand(1.4, 1.8), verb: 0.02 });
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
  tarzan(pos = null) {
    // sprinting-machete war cry: recorded yell looped every ~5s by movement.js.
    if (!this.ctx || !opts.sound || this.muted) return;
    if (this._sample({ name: 'tarzan', peak: 0.6, dur: 3.35, pos, kind: 'yell' })) return;
    const K = 'yell';
    // rising opening wail
    this._tone({ type: 'triangle', f0: 300, f1: 640, dur: 0.5, peak: 0.34, decay: 0.45, pos, kind: K, at: 0 });
    // yodel syllables: fast high-low alternation = the Tarzan ululation
    const n = 6;
    for (let i = 0; i < n; i++) {
      const at = 0.42 + i * 0.16;
      const hi = i % 2 === 0;
      this._tone({ type: 'triangle', f0: hi ? 660 : 470, f1: hi ? 590 : 520, dur: 0.14, peak: 0.42, decay: 0.13, pos, kind: K, at });
      this._noise({ dur: 0.12, type: 'bandpass', freq: hi ? 1400 : 1000, Q: 2.5, peak: 0.10, decay: 0.11, rate: 1.1, pos, kind: K, at }); // breath
    }
    // closing chest-beat cry, held long
    this._tone({ type: 'triangle', f0: 520, f1: 380, dur: 0.55, peak: 0.4, decay: 0.5, pos, kind: K, at: 0.42 + n * 0.16 });
    this._tone({ type: 'sine', f0: 260, f1: 190, dur: 0.55, peak: 0.22, decay: 0.5, pos, kind: K, at: 0.42 + n * 0.16 });
  },
  tarzanLoop(on) {
    // Machete-sprint loop: one persistent looped voice, seamless yell.
    // Call every frame; on=false fades out and frees the nodes.
    if (!this.ctx) return;
    on = !!on && !!opts.sound && !this.muted;
    const t = this.now();
    let h = this._tarzanLp;
    if (!h) {
      if (!on) return;
      const buf = this._buf && this._buf.tarzan;
      if (!buf) return; // not decoded yet — caller retries next frame
      try {
        const src = this.ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        const g = this.ctx.createGain(); g.gain.value = 0;
        src.connect(g); g.connect(this.master);
        src.start();
        h = this._tarzanLp = { src, g };
      } catch (e) { return; }
    }
    try { h.g.gain.setTargetAtTime(on ? 0.55 : 0, t, on ? 0.1 : 0.08); } catch (e) {}
    if (!on) {
      const { src, g } = h;
      this._tarzanLp = null;
      try {
        src.stop(t + 0.4);
        setTimeout(() => { try { src.disconnect(); g.disconnect(); } catch (e) {} }, 600);
      } catch (e) {}
    }
  },
  tarzanRemote(id, on, pos) {
    // Per-remote yell loop driven by snapshot state (machete + sprint speed).
    // Call every frame; on=false frees the voice. Positioned, carries map-wide.
    if (!this.ctx) return;
    if (!opts.sound || this.muted) on = false;
    if (!this._tarzanRem) this._tarzanRem = {};
    let h = this._tarzanRem[id];
    if (!h) {
      if (!on || !pos) return;
      const buf = this._buf && this._buf.tarzan;
      if (!buf) return;
      try {
        const src = this.ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        src.playbackRate.value = rand(0.96, 1.04);
        const g = this.ctx.createGain(); g.gain.value = 0;
        const pan = this._pan(0);
        src.connect(g); g.connect(pan);
        src.start();
        h = this._tarzanRem[id] = { src, g, pan };
      } catch (e) { return; }
    }
    const t = this.now();
    try {
      if (on && pos) {
        const s = this._spatial(pos, 'yell');
        h.g.gain.setTargetAtTime(0.6 * s.vol, t, 0.1);
        try { if (h.pan && h.pan.pan) h.pan.pan.setTargetAtTime(clamp(s.pan, -1, 1), t, 0.1); } catch (e) {}
      } else {
        h.g.gain.setTargetAtTime(0, t, 0.08);
      }
    } catch (e) {}
    if ((!on || !pos) && h) {
      const { src, g, pan } = h;
      delete this._tarzanRem[id];
      try {
        src.stop(t + 0.4);
        setTimeout(() => { try { src.disconnect(); g.disconnect(); if (pan !== this.master) pan.disconnect(); } catch (e) {} }, 600);
      } catch (e) {}
    }
  },
  land(hard = false) {
    if (!this.ctx || !opts.sound || this.muted) return;
    // hard landings get the real body-fall layer under the synth thump
    if (hard) this._sample({ name: 'thud', peak: 0.4, dur: 0.7, verb: 0.06 });
    this._tone({ type: 'sine', f0: hard ? 105 : 88, f1: 42, dur: 0.11, peak: hard ? 0.34 : 0.19, decay: 0.1 });
    this._noise({ dur: 0.09, type: 'lowpass', freq: hard ? 600 : 430, peak: hard ? 0.28 : 0.15, decay: 0.08, rate: 0.8 });
  },
  impact(pos, big = false) {
    if (!this.ctx || !opts.sound || this.muted || !pos) return;
    const s = this._spatial(pos, 'impact');
    if (s.vol < 0.012) return;
    // ~1 in 5 hits: faint metallic ricochet whine after the thwack
    if (Math.random() < 0.2) this._tone({ type: 'sine', f0: rand(2200, 3400), f1: rand(900, 1400), dur: 0.12, peak: 0.06, decay: 0.11, pos, kind: 'impact', verb: 0.2, at: rand(0.03, 0.09) });
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
  nukeBoom(pos = null) {
    // ☢ over the top: flash crack, planet-cracking sub drop, rolling rumble,
    // air-raid scream under the fireball, Geiger crackle as fallout settles.
    if (!this.ctx || !opts.sound || this.muted) return;
    try {
      this._noise({ dur: 0.12, type: 'highpass', freq: 900, peak: 0.7, decay: 0.1, rate: 1.0, pos, kind: 'explosion', echo: 0.05 });
      this._tone({ type: 'sine', f0: 95, f1: 22, dur: 2.2, peak: 0.8, decay: 2.0, pos, kind: 'explosion', verb: 0.3 });
      this._tone({ type: 'sine', f0: 60, f1: 18, dur: 3.0, peak: 0.5, decay: 2.8, pos, kind: 'explosion', verb: 0.35, at: 0.15 });
      this._noise({ dur: 3.2, type: 'lowpass', freq: 900, sweepTo: 45, peak: 0.75, decay: 3.0, rate: 0.8, pos, kind: 'explosion', verb: 0.4, echo: 0.45, brown: true });
      for (let i = 0; i < 5; i++) {
        this._noise({ dur: 0.3, type: 'lowpass', freq: 500, sweepTo: 80, peak: 0.4, decay: 0.28, rate: 0.7, pos, kind: 'explosion', verb: 0.3, echo: 0.4, at: 0.5 + i * 0.55, brown: true });
      }
      this._tone({ type: 'sawtooth', f0: 700, f1: 140, dur: 2.4, peak: 0.10, decay: 2.2, pos, kind: 'explosion', verb: 0.4, echo: 0.3 });
      for (let i = 0; i < 12; i++) {
        this._noise({ dur: 0.02, type: 'highpass', freq: rand(3000, 6000), peak: 0.10, decay: 0.018, rate: 1.5, pos, kind: 'sfx', at: 1.2 + Math.random() * 2.2 });
      }
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
    // real glass smash first, then the whoomph (noise only, no pitched element)
    this._sample({ name: 'glass', peak: 0.5, dur: 1.2, pos, kind: 'explosion' });
    this._noise({ dur: 0.09, type: 'highpass', freq: 2800, peak: 0.25, decay: 0.07, rate: 1.4, pos, kind: 'explosion' });
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
