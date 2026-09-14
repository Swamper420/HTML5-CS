import * as THREE from 'three';

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
const ROUND_TIME = 120;
const BUY_TIME = 15;
const KILLS_TO_WIN_ROUND = 15;
const ROUNDS_TO_WIN_MATCH = 7;
const RESPAWN_DELAY = 3;

const opts = { quality: true, sound: true, difficulty: 1 };

// ---------------- Audio (procedural WebAudio) ----------------
const AudioSys = {
  ctx: null, master: null, muted: false,
  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    } catch (e) { /* no audio */ }
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  now() { return this.ctx ? this.ctx.currentTime : 0; },
  env(gainNode, t, peak, decay) {
    gainNode.gain.setValueAtTime(peak, t);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  },
  noiseBuffer(dur) {
    const sr = this.ctx.sampleRate, buf = this.ctx.createBuffer(1, sr * dur, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  },
  shoot(kind, dist = 0) {
    if (!this.ctx || !opts.sound || this.muted) return;
    const t = this.now();
    const vol = clamp(1 - dist / 70, 0.08, 1);
    // Layer 1: supersonic crack (short bright noise)
    const crack = this.ctx.createBufferSource();
    crack.buffer = this.noiseBuffer(0.12);
    const hf = this.ctx.createBiquadFilter(); hf.type = 'highpass';
    hf.frequency.value = kind === 'sniper' ? 900 : 1800;
    const hg = this.ctx.createGain();
    this.env(hg, t, (kind === 'sniper' ? 0.7 : 0.55) * vol, 0.06);
    crack.connect(hf); hf.connect(hg); hg.connect(this.master);
    crack.start(t); crack.stop(t + 0.12);
    // Layer 2: body boom
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(kind === 'sniper' ? 0.6 : 0.3);
    const f = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    if (kind === 'rifle') { f.type = 'lowpass'; f.frequency.value = 1700; this.env(g, t, 0.95 * vol, 0.16); }
    else if (kind === 'pistol') { f.type = 'bandpass'; f.frequency.value = 1200; f.Q.value = 0.8; this.env(g, t, 0.9 * vol, 0.15); }
    else { f.type = 'lowpass'; f.frequency.value = 750; this.env(g, t, 1.0 * vol, 0.5); }
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + 0.6);
    // Layer 3: low thump
    const o = this.ctx.createOscillator(); const g2 = this.ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(kind === 'sniper' ? 120 : 175, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.14);
    this.env(g2, t, 0.65 * vol, kind === 'sniper' ? 0.3 : 0.13);
    o.connect(g2); g2.connect(this.master); o.start(t); o.stop(t + 0.35);
    // Layer 4: mechanical clack (close only) + distant echo tail for sniper
    if (dist < 12) this.click(kind === 'sniper' ? 3200 : 4200, 0.03, 0.16 * vol);
    if (kind === 'sniper') {
      const dly = this.ctx.createDelay(); dly.delayTime.value = 0.22;
      const dg = this.ctx.createGain(); dg.gain.value = 0.22 * vol;
      const f2 = this.ctx.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.value = 600;
      g.connect(f2); f2.connect(dly); dly.connect(dg); dg.connect(this.master);
    }
  },
  mech() { this.click(4300, 0.025, 0.14); setTimeout(() => this.click(2600, 0.03, 0.12), 55); },
  click(freq = 2000, dur = 0.05, vol = 0.25) {
    if (!this.ctx || !opts.sound || this.muted) return;
    const t = this.now();
    const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.type = 'square'; o.frequency.value = freq; this.env(g, t, vol, dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  },
  reload() { this.click(900, 0.07); setTimeout(() => this.click(1400, 0.07), 180); setTimeout(() => this.click(700, 0.09), 700); },
  hit(headshot) { this.click(headshot ? 2600 : 1900, 0.06, 0.35); },
  kill() { this.click(520, 0.1, 0.4); setTimeout(() => this.click(780, 0.12, 0.4), 110); },
  hurt() {
    if (!this.ctx || !opts.sound || this.muted) return;
    const t = this.now(); const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.2);
    this.env(g, t, 0.4, 0.22); o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.25);
  },
  step() {
    if (!this.ctx || !opts.sound || this.muted) return;
    const t = this.now();
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer(0.08);
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
    const g = this.ctx.createGain(); this.env(g, t, 0.12, 0.08);
    src.connect(f); f.connect(g); g.connect(this.master); src.start(t); src.stop(t + 0.1);
  },
  roundWin() { [523, 659, 784, 1046].forEach((fr, i) => setTimeout(() => this.click(fr, 0.18, 0.35), i * 130)); },
  roundLose() { [400, 340, 280, 200].forEach((fr, i) => setTimeout(() => this.click(fr, 0.2, 0.35), i * 150)); },
};

// ---------------- Three.js setup ----------------
let renderer, scene, camera, sunLight, muzzleLight;
const colliders = [];   // THREE.Box3[]
const waypoints = [];
const spawns = { ct: [], t: [] };

function makeCanvasTexture(draw, size = 256, repeat = 1) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  $('game-container').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87a5c8);
  scene.fog = new THREE.Fog(0x9db4cf, 30, 130);

  camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 400);

  const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x8a7a5a, 0.9);
  scene.add(hemi);
  sunLight = new THREE.DirectionalLight(0xfff2d9, 1.6);
  sunLight.position.set(30, 48, 18);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -45; sunLight.shadow.camera.right = 45;
  sunLight.shadow.camera.top = 45; sunLight.shadow.camera.bottom = -45;
  sunLight.shadow.camera.far = 140;
  scene.add(sunLight);

  muzzleLight = new THREE.PointLight(0xffc36b, 0, 14, 2);
  scene.add(muzzleLight);

  // gradient sky dome
  const skyGeo = new THREE.SphereGeometry(300, 16, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x3d6cb5) }, bottom: { value: new THREE.Color(0xd9c49a) } },
    vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h=normalize(vP).y*0.5+0.5; gl_FragColor=vec4(mix(bottom,top,pow(h,0.8)),1.0); }',
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));

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

function buildMap() {
  const groundTex = makeCanvasTexture((g, s) => {
    g.fillStyle = '#b39b6d'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(${90 + Math.random() * 60 | 0},${75 + Math.random() * 45 | 0},${50 + Math.random() * 30 | 0},0.5)`; g.fillRect(Math.random() * s, Math.random() * s, 3, 3); }
    g.strokeStyle = 'rgba(60,45,25,0.35)'; g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * s / 4, 0); g.lineTo(i * s / 4, s); g.stroke(); g.beginPath(); g.moveTo(0, i * s / 4); g.lineTo(s, i * s / 4); g.stroke(); }
  }, 512, 10);
  const wallTex = makeCanvasTexture((g, s) => {
    g.fillStyle = '#cbb98f'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#b3a179';
    for (let y = 0; y < s; y += 32) for (let x = 0; x < s; x += 64) g.fillRect(x + ((y / 32) % 2) * 32, y, 62, 30);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, 0, s, 10);
  }, 256, 3);
  const crateTex = makeCanvasTexture((g, s) => {
    g.fillStyle = '#8a6a3e'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#5d441f'; g.lineWidth = 10; g.strokeRect(5, 5, s - 10, s - 10);
    g.beginPath(); g.moveTo(0, 0); g.lineTo(s, s); g.moveTo(s, 0); g.lineTo(0, s); g.stroke();
    g.fillStyle = 'rgba(0,0,0,0.15)';
    for (let i = 0; i < 20; i++) g.fillRect(Math.random() * s, 0, 2, s);
  }, 256, 1);
  const darkTex = makeCanvasTexture((g, s) => {
    g.fillStyle = '#6e6250'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(Math.random() * s, Math.random() * s, 4, 4); }
  }, 256, 4);

  const groundMat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 });
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95 });
  const crateMat = new THREE.MeshStandardMaterial({ map: crateTex, roughness: 0.9 });
  const darkMat = new THREE.MeshStandardMaterial({ map: darkTex, roughness: 1 });
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

  // Mid wall with double doors (two gaps)
  addSolid(-22, 2, 0, 8, 4, 2.4, wallMat);
  addSolid(22, 2, 0, 8, 4, 2.4, wallMat);
  addSolid(0, 3.4, 0, 36, 1.2, 2.4, darkMat);
  addSolid(-11.5, 2, 0, 3, 4, 0.6, crateMat);
  addSolid(11.5, 2, 0, 3, 4, 0.6, crateMat);

  // Long corridor walls (A long top, B tunnels bottom)
  addSolid(-8, 1.75, -14, 30, 3.5, 1.2, wallMat);
  addSolid(-8, 1.75, 14, 30, 3.5, 1.2, wallMat);
  addSolid(8, 1.5, -22, 1.2, 3, 16, wallMat);
  addSolid(8, 1.5, 22, 1.2, 3, 16, wallMat);

  // Catwalk / platform mid
  addSolid(0, 0.35, -8, 10, 0.7, 4, darkMat);
  addSolid(0, 0.35, 8, 10, 0.7, 4, darkMat);

  // Bombsite A (top-right, T side is +x? CT spawn -x, T spawn +x)
  const siteA = new THREE.Mesh(new THREE.CircleGeometry(4, 24), new THREE.MeshBasicMaterial({ color: 0x2e9bff, transparent: true, opacity: 0.35 }));
  siteA.rotation.x = -Math.PI / 2; siteA.position.set(24, 0.02, -20); scene.add(siteA);
  addSolid(24, 3.6, -20, 0.4, 0.4, 8, accentA, false);
  // Bombsite B
  const siteB = new THREE.Mesh(new THREE.CircleGeometry(4, 24), new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.35 }));
  siteB.rotation.x = -Math.PI / 2; siteB.position.set(24, 0.02, 20); scene.add(siteB);
  addSolid(24, 3.6, 20, 0.4, 0.4, 8, accentB, false);

  // Crates scattered (classic dust boxes)
  const crates = [
    [-20, -20, 2.4], [-17.5, -20, 1.6], [-20, 20, 2.4], [-17.5, 20, 1.6],
    [0, -20, 2], [2.2, -20, 1.4], [0, 20, 2], [2.2, 20, 1.4],
    [14, 0, 2.2], [14, 2.6, 1.5], [-14, 0, 2.2],
    [24, -14, 2], [24, -11.4, 1.5], [24, 14, 2], [24, 11.4, 1.5],
    [-26, 0, 2.6], [5, -5, 1.8], [5, 5, 1.8], [-5, -5, 1.4], [-5, 5, 1.4],
  ];
  for (const [x, z, s] of crates) addSolid(x, s / 2, z, s, s, s, crateMat);

  // Tunnel arches (B tunnels feel)
  for (const z of [-26, 26]) {
    addSolid(-2, 2.5, z, 8, 1, 6, darkMat);
    addSolid(-6, 1.25, z - 2.7, 1, 2.5, 0.8, wallMat);
    addSolid(-6, 1.25, z + 2.7, 1, 2.5, 0.8, wallMat);
    addSolid(2, 1.25, z - 2.7, 1, 2.5, 0.8, wallMat);
    addSolid(2, 1.25, z + 2.7, 1, 2.5, 0.8, wallMat);
  }

  // Palm-ish decoration: simple poles + tops (no collision cost)
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f8f3f, roughness: 1 });
  for (const [x, z] of [[-28, -28], [-28, 28], [28, -28], [28, 28], [0, -28], [0, 28]]) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 5, 8), trunkMat);
    trunk.position.set(x, 2.5, z); trunk.castShadow = true; scene.add(trunk);
    const top = new THREE.Mesh(new THREE.SphereGeometry(1.4, 8, 6), leafMat);
    top.position.set(x, 5.4, z); top.castShadow = true; scene.add(top);
  }

  // Spawns: CT west, T east
  spawns.ct = [new THREE.Vector3(-29, 0, -6), new THREE.Vector3(-29, 0, -2), new THREE.Vector3(-29, 0, 2), new THREE.Vector3(-29, 0, 6)];
  spawns.t = [new THREE.Vector3(29, 0, -6), new THREE.Vector3(29, 0, -2), new THREE.Vector3(29, 0, 2), new THREE.Vector3(29, 0, 6)];

  // Waypoint grid for bots
  for (let x = -28; x <= 28; x += 7)
    for (let z = -24; z <= 24; z += 6)
      waypoints.push(new THREE.Vector3(x + rand(-1, 1), 0, z + rand(-1, 1)));
}

// ---------------- Soldier meshes ----------------
function makeSoldier(team) {
  const g = new THREE.Group();
  const cBody = team === 'ct' ? 0x2b5fb8 : 0xb87a2b;
  const cPants = team === 'ct' ? 0x1c2f4a : 0x4a3a1c;
  const skin = 0xd9a877;
  const matBody = new THREE.MeshStandardMaterial({ color: cBody, roughness: 0.8 });
  const matPants = new THREE.MeshStandardMaterial({ color: cPants, roughness: 0.9 });
  const matSkin = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7 });
  const matGun = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5, metalness: 0.4 });
  const matHelmet = new THREE.MeshStandardMaterial({ color: team === 'ct' ? 0x12315e : 0x5e3a12, roughness: 0.6 });

  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.8, 0.22), matPants);
  legL.position.set(-0.15, 0.4, 0); legL.castShadow = true; g.add(legL);
  const legR = legL.clone(); legR.position.x = 0.15; g.add(legR);
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.75, 0.36), matBody);
  torso.position.y = 1.17; torso.castShadow = true; g.add(torso);
  // team stripe
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.12, 0.38), new THREE.MeshStandardMaterial({ color: team === 'ct' ? 0x66b3ff : 0xffc14d }));
  stripe.position.y = 1.38; g.add(stripe);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), matSkin);
  head.position.y = 1.75; head.castShadow = true; g.add(head);
  const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.4), matHelmet);
  helmet.position.y = 1.95; g.add(helmet);
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.6, 0.16), matBody);
  armL.position.set(-0.4, 1.2, 0.15); armL.rotation.x = -1.1; g.add(armL);
  const armR = armL.clone(); armR.position.x = 0.4; g.add(armR);
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
  kills: 0, deaths: 0, headshots: 0, shots: 0, hits: 0,
  startTime: 0,
};

const player = {
  pos: new THREE.Vector3(-29, 0, 0), vel: new THREE.Vector3(),
  yaw: -Math.PI / 2, pitch: 0, onGround: true,
  hp: 100, armor: 100, money: 800, alive: true,
  weapons: { ak: { owned: true, mag: 30, reserve: 90 }, deagle: { owned: true, mag: 7, reserve: 35 }, awp: { owned: false, mag: 5, reserve: 0 } },
  cur: 'ak', last: 'deagle', reloading: 0, reloadDur: 1, nextShot: 0,
  aiming: false, respawnAt: 0, radius: 0.45, lastDmgDir: 0,
  kills: 0, deaths: 0,
  // gunplay state: bloom heat + spray index + recoverable punch + shake
  bloom: 0, sprayIdx: 0, lastShotT: -9,
};

const bots = [];
const keys = {};
let pointerLocked = false;

// effects pools
const tracers = [], particles = [], corpses = [], shells = [], smokes = [];

function spawnTracer(a, b, color) {
  if (!opts.quality && tracers.length > 6) return;
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  scene.add(line);
  tracers.push({ mesh: line, life: 0.08, max: 0.08 });
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
    tr.mesh.material.opacity = Math.max(0, tr.life / tr.max);
    if (tr.life <= 0) { scene.remove(tr.mesh); tr.mesh.geometry.dispose(); tr.mesh.material.dispose(); tracers.splice(i, 1); }
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
    if (s.mesh.position.y < 0.02) { s.mesh.position.y = 0.02; s.vel.y *= -0.4; s.vel.x *= 0.6; s.vel.z *= 0.6; s.angVel.multiplyScalar(0.5); }
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

// ---------------- Bots ----------------
function makeBot(team, idx) {
  const mesh = makeSoldier(team);
  scene.add(mesh);
  const spawn = (team === 'ct' ? spawns.ct : spawns.t)[idx % 4].clone();
  const bot = {
    team, idx, mesh, pos: spawn.clone(), vel: new THREE.Vector3(),
    yaw: team === 'ct' ? -Math.PI / 2 : Math.PI / 2, hp: 100, alive: true,
    respawnAt: 0, speed: rand(3.4, 4.6), state: 'roam',
    wp: randPick(waypoints).clone(), target: null,
    nextThink: Math.random() * 0.5, nextShot: 0, burstLeft: 0, burstAt: 0,
    strafeDir: 1, strafeAt: 0, flashAt: 0, walkPhase: Math.random() * 6,
    name: (team === 'ct' ? ['Blaze', 'Falcon', 'Havoc', 'Ghost'][idx] : ['Viper', 'Rattler', 'Jackal', 'Scorpion'][idx]) + (team === 'ct' ? ' [CT]' : ' [T]'),
    short: team === 'ct' ? ['Blaze', 'Falcon', 'Havoc', 'Ghost'][idx] : ['Viper', 'Rattler', 'Jackal', 'Scorpion'][idx],
  };
  mesh.position.copy(spawn);
  bots.push(bot);
  return bot;
}
function resetBot(bot) {
  const spawn = (bot.team === 'ct' ? spawns.ct : spawns.t)[bot.idx % 4];
  bot.pos.copy(spawn).add(new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1)));
  bot.hp = 100; bot.alive = true; bot.wp = randPick(waypoints).clone();
  bot.target = null; bot.state = 'roam'; bot.mesh.visible = true;
  bot.mesh.rotation.set(0, bot.yaw, 0);
  bot.mesh.position.copy(bot.pos);
}
function botEye(b) { return new THREE.Vector3(b.pos.x, b.pos.y + 1.55, b.pos.z); }
function botChest(b) { return new THREE.Vector3(b.pos.x, b.pos.y + 1.1, b.pos.z); }

function nearestEnemy(bot) {
  let best = null, bestD = 1e9;
  const eye = botEye(bot);
  // player?
  if (player.alive && bot.team === 't') {
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
  // CT bots hunt T bots only
  if (bot.team === 'ct' && best && best.type === 'player') best = null;
  return best;
}

function botThink(bot, t) {
  bot.nextThink = t + rand(0.25, 0.5);
  bot.target = nearestEnemy(bot);
  if (bot.target) { bot.state = 'combat'; bot.strafeAt = t + rand(0.5, 1.4); if (Math.random() < 0.5) bot.strafeDir *= -1; }
  else {
    bot.state = 'roam';
    if (bot.pos.distanceTo(bot.wp) < 2.5 || Math.random() < 0.12) bot.wp = randPick(waypoints).clone();
  }
  if (bot.target && Math.random() < 0.3) { bot.burstLeft = 2 + (Math.random() * 3 | 0); bot.burstAt = t; }
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

// bot per-frame update
function updateBot(bot, dt, t) {
  const m = bot.mesh;
  if (!bot.alive) {
    if (t >= bot.respawnAt && G.phase === 'playing') resetBot(bot);
    return;
  }
  if (t >= bot.nextThink) botThink(bot, t);
  let moveDir = null, speed = bot.speed;

  if (bot.state === 'combat' && bot.target) {
    let tp = null;
    if (bot.target.type === 'player') tp = new THREE.Vector3(player.pos.x, player.pos.y + 1.2, player.pos.z);
    else if (bot.target.bot.alive) tp = botChest(bot.target.bot);
    else { bot.target = null; bot.state = 'roam'; }
    if (tp) {
      // face target
      const dx = tp.x - bot.pos.x, dz = tp.z - bot.pos.z;
      bot.yaw = Math.atan2(-dx, -dz) + Math.PI; // mesh faces -z? adjust: our gun at +z so yaw = atan2(dx,dz)
      bot.yaw = Math.atan2(dx, dz);
      const dist = Math.hypot(dx, dz);
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
          // lead / error: worse vs moving player
          botShoot(bot, t, aimAt);
        }
      }
    }
  } else {
    const dx = bot.wp.x - bot.pos.x, dz = bot.wp.z - bot.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1.5) {
      moveDir = new THREE.Vector3(dx / dist, 0, dz / dist);
      bot.yaw = Math.atan2(dx, dz);
    }
  }
  if (moveDir) {
    const step = moveDir.multiplyScalar(speed * dt);
    const ox = bot.pos.x, oz = bot.pos.z;
    moveWithCollision(bot.pos, step.x, step.z, 0.42);
    if (Math.abs(bot.pos.x - ox) + Math.abs(bot.pos.z - oz) < 0.001) bot.wp = randPick(waypoints).clone(); // stuck
    bot.walkPhase += dt * 9;
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
  for (const b of bots) {
    if (!b.alive) continue;
    if (b.team === shooter.team) continue;
    if (shooter.bot === b) continue;
    if (shooter.isPlayer && b.team !== 't') continue; // player only fights T
    const r = checkPerson(b.pos.x, b.pos.z, b.pos.y);
    if (r && r.d < bestT) { bestT = r.d; hitBot = b; head = r.head; hitPlayer = false; }
  }
  // can bots hit player? + can player hit self? no. Can teammates hit player? no friendly fire.
  if (!shooter.isPlayer && shooter.team === 't' && player.alive) {
    const r = checkPerson(player.pos.x, player.pos.z, player.pos.y);
    if (r && r.d < bestT) { bestT = r.d; hitPlayer = true; hitBot = null; head = r.head; }
  }
  // teammates (CT bots) can be hit by... nobody (no friendly fire) — skip.

  const end = origin.clone().add(dir.clone().multiplyScalar(bestT));
  // effects
  spawnTracer(origin.clone(), end.clone(), wdef.tracer);
  if (shooter.isPlayer) {
    muzzleLight.position.copy(origin).add(dir.clone().multiplyScalar(0.6));
    muzzleLight.intensity = wdef.sound === 'sniper' ? 5 : 3.2;
    muzzleLight.distance = wdef.sound === 'sniper' ? 20 : 14;
  } else if (bestT < 60) {
    muzzleLight.position.copy(origin); muzzleLight.intensity = Math.max(muzzleLight.intensity, 1.5);
  }
  const distSnd = shooter.isPlayer ? 0 : origin.distanceTo(new THREE.Vector3(player.pos.x, player.pos.y + EYE, player.pos.z));
  AudioSys.shoot(wdef.sound, distSnd);

  // damage falloff with distance (keeps AWP lethal far, rifles fade)
  const fall = wdef.falloff !== undefined ? wdef.falloff : 0.35;
  const fallK = 1 - fall * clamp(bestT / wdef.range, 0, 1);
  if (hitBot) {
    let dmg = wdef.damage * fallK * (head ? wdef.headMult : 1) * rand(0.9, 1.1);
    damageBot(hitBot, dmg, shooter, head, end);
    return { hit: true, d: bestT };
  } else if (hitPlayer) {
    let dmg = wdef.damage * fallK * (head ? 2.0 : 1) * rand(0.85, 1.1);
    damagePlayer(dmg, shooter, head);
    spawnBurst(end, 0xaa0000, 6, 3, 0.4);
    return { hit: true, d: bestT };
  } else if (bestT < maxD - 0.01) {
    // wall impact: spark + dust + chip + smoke wisp
    spawnBurst(end, 0xffd27a, 8, 5, 0.3, 0.07);
    spawnBurst(end, 0x9a8f7a, 5, 2.2, 0.55, 0.08);
    spawnSmoke(end, 0.22, 0.6);
    return { hit: false, d: bestT };
  }
  return { hit: false, d: bestT };
}

function damageBot(bot, dmg, shooter, head, hitPos) {
  if (!bot.alive || G.phase !== 'playing') return;
  // armor-lite: bots have no armor
  bot.hp -= dmg;
  spawnBurst(hitPos || botChest(bot), 0xb00000, head ? 12 : 8, 4, 0.5);
  const killerIsPlayer = shooter.isPlayer;
  if (killerIsPlayer) {
    G.hits++; playerHitmark(head, false);
    AudioSys.hit(head);
  }
  if (bot.hp <= 0) {
    bot.alive = false; bot.hp = 0;
    bot.respawnAt = performance.now() / 1000 + RESPAWN_DELAY;
    // death anim: fall over + fade later
    bot.mesh.rotation.x = -Math.PI / 2;
    bot.mesh.position.y = 0.2;
    setTimeout(() => { if (!bot.alive) bot.mesh.visible = false; }, 2500);
    setTimeout(() => { if (bot.mesh) { bot.mesh.rotation.x = 0; } }, 2900);
    const killerTeam = shooter.isPlayer ? 'ct' : shooter.team;
    G.roundKills[killerTeam]++;
    const kn = killerIsPlayer ? 'YOU' : (shooter.bot ? shooter.bot.short : '???');
    const kt = killerTeam;
    addKillfeed(kn, kt, bot.short, bot.team, currentWeaponName(shooter), head);
    if (killerIsPlayer) {
      G.kills++; player.kills++; player.money += 300; playerHitmark(head, true);
      AudioSys.kill();
      if (head) { G.headshots++; announce('HEADSHOT', 700); }
    }
    if (shooter.bot && shooter.team === 't') { /* enemy got a kill */ }
    updateHUD(); checkRoundEnd();
  }
}

function damagePlayer(dmg, shooter, head) {
  if (!player.alive || G.phase !== 'playing') return;
  // armor absorbs 50%
  if (player.armor > 0) {
    const absorbed = dmg * 0.5;
    const useArmor = Math.min(player.armor, absorbed);
    player.armor -= useArmor;
    dmg -= useArmor * 0.8;
  }
  player.hp -= dmg;
  AudioSys.hurt();
  flashDamage(shooter);
  updateHUD();
  if (player.hp <= 0) {
    player.hp = 0; player.alive = false; player.deaths++;
    player.respawnAt = performance.now() / 1000 + RESPAWN_DELAY;
    const kn = shooter.bot ? shooter.bot.short : 'Enemy';
    $('respawn-killer').textContent = kn + (head ? ' (HEADSHOT)' : '');
    $('respawn-overlay').classList.remove('hidden');
    document.exitPointerLock && document.exitPointerLock();
    const killerTeam = shooter.team || 't';
    G.roundKills[killerTeam]++;
    addKillfeed(kn, killerTeam, 'YOU', 'ct', currentWeaponName(shooter), head);
    updateHUD(); checkRoundEnd();
  }
}
function currentWeaponName(shooter) {
  if (shooter.isPlayer) return WEAPONS[player.cur].name;
  return 'AK-47';
}

// ---------------- Player shooting (CS-style recoil + bloom) ----------------
function playerTryFire(t) {
  const wkey = player.cur, w = player.weapons[wkey], def = WEAPONS[wkey];
  if (!player.alive || player.reloading > 0 || t < player.nextShot) return;
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
  fireHitscan({ team: 'ct', isPlayer: true }, origin, dir, def, t);
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
    if (e.code === 'Digit1') switchWeapon('ak');
    if (e.code === 'Digit2') switchWeapon('deagle');
    if (e.code === 'Digit3') { if (player.weapons.awp.owned) switchWeapon('awp'); else announce('AWP NOT OWNED — PRESS B', 1200); }
    if (e.repeat) return;
    if (e.code === 'KeyQ') switchWeapon(player.last && player.weapons[player.last].owned ? player.last : player.cur);
    if (e.code === 'KeyR') startReload();
    if (e.code === 'KeyB') toggleBuy();
    if (e.code === 'KeyM') { AudioSys.muted = !AudioSys.muted; announce(AudioSys.muted ? 'SOUND OFF' : 'SOUND ON', 800); }
    if (e.code === 'Escape' && G.buyOpen) toggleBuy(false);
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  document.addEventListener('mousedown', (e) => {
    if (G.phase !== 'playing' || !pointerLocked) return;
    if (e.button === 0) { mouseDown = true; mouseJustDown = true; }
    if (e.button === 2) player.aiming = true;
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouseDown = false;
    if (e.button === 2) player.aiming = false;
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('mousemove', (e) => {
    if (!pointerLocked || G.phase !== 'playing' || !player.alive) return;
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
function toggleBuy(force) {
  const want = force !== undefined ? force : !G.buyOpen;
  if (want && G.timeLeft < ROUND_TIME - BUY_TIME) { announce('BUY TIME OVER', 1000); AudioSys.click(300, 0.1, 0.3); return; }
  G.buyOpen = want;
  $('buy-menu').classList.toggle('hidden', !want);
  $('buy-money').textContent = '$' + player.money;
  if (want) { document.exitPointerLock && document.exitPointerLock(); }
  else if (G.phase === 'playing' && player.alive) lockPointer();
}
function buyItem(kind) {
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
  $('timer').textContent = fmtTime(G.timeLeft);
  $('timer').classList.toggle('low', G.timeLeft < 20);
  $('round-label').textContent = `ROUND ${G.round} / ${ROUNDS_TO_WIN_MATCH * 2 - 1} · CT ${G.roundKills.ct} — ${G.roundKills.t} T`;
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
  // sites
  g.fillStyle = '#2e9bff'; g.beginPath(); g.arc(px(24), pz(-20), 4, 0, 7); g.fill();
  g.fillStyle = '#ffb020'; g.beginPath(); g.arc(px(24), pz(20), 4, 0, 7); g.fill();
  // bots
  for (const b of bots) {
    if (!b.alive) continue;
    g.fillStyle = b.team === 'ct' ? '#5eb2ff' : '#ff7043';
    g.beginPath(); g.arc(px(b.pos.x), pz(b.pos.z), 3, 0, 7); g.fill();
  }
  // player arrow
  const x = px(player.pos.x), y = pz(player.pos.z);
  g.save(); g.translate(x, y); g.rotate(-player.yaw + Math.PI);
  g.fillStyle = '#3dff7a';
  g.beginPath(); g.moveTo(0, -6); g.lineTo(4.5, 5); g.lineTo(-4.5, 5); g.closePath(); g.fill();
  g.restore();
}

// ---------------- Round flow ----------------
function startMatch() {
  G.phase = 'playing'; G.round = 1; G.score = { ct: 0, t: 0 };
  G.kills = 0; G.deaths = 0; G.headshots = 0; G.shots = 0; G.hits = 0;
  G.startTime = performance.now();
  player.money = 800; player.kills = 0; player.deaths = 0;
  player.weapons = { ak: { owned: true, mag: 30, reserve: 90 }, deagle: { owned: true, mag: 7, reserve: 35 }, awp: { owned: false, mag: 5, reserve: 0 } };
  player.cur = 'ak';
  startRound(true);
  $('main-menu').classList.add('hidden');
  $('end-screen').classList.add('hidden');
  $('hud').classList.remove('hidden');
  lockPointer();
}
function startRound(first = false) {
  G.roundKills = { ct: 0, t: 0 };
  G.timeLeft = ROUND_TIME; G.buyOpen = false; G.roundEnding = false;
  $('buy-menu').classList.add('hidden');
  $('killfeed').innerHTML = '';
  // reset actors
  player.hp = 100; if (first) player.armor = 100;
  player.alive = true; player.reloading = 0;
  player.bloom = 0; player.sprayIdx = 0; player.lastShotT = -9; player.aiming = false;
  vmRig.punchP = 0; vmRig.punchY = 0; vmRig.shake = 0; vmRig.fovKick = 0; vmRig.aimK = 0;
  player.pos.copy(spawns.ct[0]).add(new THREE.Vector3(rand(-1, 1), 0, rand(-2, 2)));
  player.vel.set(0, 0, 0); player.yaw = -Math.PI / 2; player.pitch = 0;
  for (const k of SLOT_ORDER) { const w = player.weapons[k], d = WEAPONS[k]; if (w.owned) { w.mag = d.magSize; if (first) w.reserve = d.startReserve; else w.reserve = Math.max(w.reserve, (d.magSize * 2) | 0); } }
  buildViewmodel(player.cur);
  if (viewmodel) viewmodel.visible = true;
  for (const b of bots) { resetBot(b); b.mesh.visible = true; }
  // scatter bots to their spawns
  bots.filter((b) => b.team === 'ct').forEach((b, i) => { b.pos.copy(spawns.ct[(i + 1) % 4]); });
  bots.filter((b) => b.team === 't').forEach((b, i) => { b.pos.copy(spawns.t[i % 4]); });
  $('respawn-overlay').classList.add('hidden');
  announce(first ? 'ROUND 1 — ELIMINATE THE ENEMY' : `ROUND ${G.round}`, 1600);
  if (first) setTimeout(() => { if (G.phase === 'playing') { toggleBuy(true); setTimeout(() => { if (G.buyOpen) toggleBuy(false); }, 9000); } }, 600);
  else if (G.timeLeft > 0) { toggleBuy(true); setTimeout(() => { if (G.buyOpen) toggleBuy(false); }, 6000); }
  updateHUD();
}
function checkRoundEnd() {
  if (G.phase !== 'playing' || G.roundEnding) return;
  if (G.roundKills.ct >= KILLS_TO_WIN_ROUND || G.roundKills.t >= KILLS_TO_WIN_ROUND) endRound(G.roundKills.ct > G.roundKills.t ? 'ct' : 't');
}
function endRound(winner) { // 'ct' | 't' | 'draw'
  if (G.phase !== 'playing' || G.roundEnding) return;
  G.roundEnding = true;
  if (winner === 'ct') { G.score.ct++; player.money += 1400; AudioSys.roundWin(); announce('ROUND WON — +$1400', 2200); }
  else if (winner === 't') { G.score.t++; player.money += 800; AudioSys.roundLose(); announce('ROUND LOST', 2200); }
  else { player.money += 800; announce('DRAW', 1800); }
  // bot economy irrelevant
  updateHUD();
  if (G.score.ct >= ROUNDS_TO_WIN_MATCH || G.score.t >= ROUNDS_TO_WIN_MATCH) { endMatch(); return; }
  G.round++;
  setTimeout(() => { if (G.phase === 'playing') startRound(); }, 2400);
}
function endMatch() {
  G.phase = 'over';
  document.exitPointerLock && document.exitPointerLock();
  const win = G.score.ct > G.score.t;
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
    const remain = player.respawnAt - t;
    if (remain <= 0) {
      player.alive = true; player.hp = 100;
      player.pos.copy(spawns.ct[0]).add(new THREE.Vector3(rand(-2, 2), 0, rand(-2, 2)));
      player.vel.set(0, 0, 0);
      for (const k of SLOT_ORDER) { const w = player.weapons[k]; if (w.owned) w.mag = WEAPONS[k].magSize; }
      $('respawn-overlay').classList.add('hidden');
      if (G.phase === 'playing') lockPointer();
      updateHUD();
    } else {
      $('respawn-timer').textContent = `Respawning in ${Math.ceil(remain)}…`;
      // death cam: slow orbit
      player.yaw += dt * 0.6;
    }
  }
  const speedBase = player.cur === 'awp' && player.aiming ? 2.2 : 5.2;
  const sprint = keys['ShiftLeft'] && !player.aiming && player.vel.lengthSq() > 0.1;
  const speed = (player.aiming ? speedBase * 0.55 : speedBase) * (sprint ? 1.45 : 1);
  let ix = 0, iz = 0;
  if (player.alive && G.phase === 'playing') {
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
  // gravity / jump
  if (player.onGround && keys['Space'] && player.alive) { player.vel.y = 5.2; player.onGround = false; }
  player.vel.y -= 13.5 * dt;
  moveWithCollision(player.pos, player.vel.x * dt, player.vel.z * dt, player.radius);
  player.pos.y += player.vel.y * dt;
  if (player.pos.y <= 0) { player.pos.y = 0; player.vel.y = 0; player.onGround = true; }

  // footsteps
  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  if (player.onGround && hSpeed > 2 && t > stepAt) { stepAt = t + (sprint ? 0.3 : 0.42); AudioSys.step(); }

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
  // firing (also catch fast semi-auto clicks that release within one frame)
  if ((mouseDown || mouseJustDown) && player.alive && G.phase === 'playing' && !G.buyOpen) {
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
}

// ---------------- FPS meter ----------------
let fpsAcc = 0, fpsN = 0, fpsAt = performance.now();
function fpsTick() {
  fpsAcc += 1; fpsN += 1;
  const now = performance.now();
  if (now - fpsAt > 500) {
    $('fps-counter').textContent = `${Math.round(fpsAcc * 1000 / (now - fpsAt))} FPS · ${bots.filter((b) => b.alive).length} hostiles up`;
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
    G.timeLeft -= dt;
    if (G.timeLeft <= 0) {
      G.timeLeft = 0;
      const w = G.roundKills.ct === G.roundKills.t ? 'draw' : (G.roundKills.ct > G.roundKills.t ? 'ct' : 't');
      endRound(w);
    }
    updatePlayer(dt, t);
    for (const b of bots) updateBot(b, dt, t);
    updateEffects(dt, t);
    // HUD timer text ~4Hz
    if ((loop.n = (loop.n || 0) + 1) % 15 === 0) updateHUD();
    drawMinimap(t);
    if (!player.alive) { /* respawn handled in updatePlayer */ }
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
function boot() {
  $('loading-note').textContent = 'Building map…';
  initThree();
  buildMap();
  buildViewmodel('ak');
  if (viewmodel) viewmodel.visible = false; // hidden until match starts
  for (let i = 0; i < 4; i++) makeBot('ct', i);
  for (let i = 0; i < 4; i++) makeBot('t', i);
  initInput();
  updateHUD();
  // click canvas to (re)lock pointer — needed after death/respawn since
  // browsers only allow pointer lock from a user gesture
  renderer.domElement.addEventListener('click', () => {
    if (G.phase === 'playing' && player.alive && !G.buyOpen && !pointerLocked) lockPointer();
  });

  $('opt-quality').addEventListener('change', (e) => {
    opts.quality = e.target.checked;
    renderer.shadowMap.enabled = opts.quality;
    sunLight.castShadow = opts.quality;
  });
  $('opt-sound').addEventListener('change', (e) => { opts.sound = e.target.checked; });
  $('opt-diff').addEventListener('change', (e) => { opts.difficulty = parseFloat(e.target.value); });
  $('play-btn').addEventListener('click', () => { AudioSys.init(); startMatch(); });
  $('resume-btn').addEventListener('click', resumeGame);
  $('restart-btn').addEventListener('click', () => { $('pause-menu').classList.add('hidden'); G.phase = 'playing'; startMatch(); });
  $('again-btn').addEventListener('click', () => startMatch());

  $('loading-note').textContent = 'Ready. Click DEPLOY.';
  loop();
}

boot();
