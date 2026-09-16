// js/config.js — AGENTS: all tunable game data lives here.
// ADD weapons/nades here (or via registerWeapon/registerNade) — don't touch combat code.
// Ownership: WEAPONS, NADE_DEFS, map/economy/bomb timings, movement constants.
// Pure data only: no player, no THREE, no DOM. Mutable round state (BOMB object) lives in bomb.js.

export const WEAPONS = {
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

// Extension point: agents add weapons without editing combat/shooting code.
// Required fields: name, damage, magSize, fireInterval, reloadTime, price, sound.
export function registerWeapon(key, def) {
  if (!key || !def || WEAPONS[key]) throw new Error('registerWeapon: bad key or already exists: ' + key);
  WEAPONS[key] = def;
  if (!SLOT_ORDER.includes(key)) SLOT_ORDER.push(key);
}

// Classic-style AK spray pattern (x,y multipliers per consecutive shot, resets after pause)
export const SPRAY_AK = [
  [0.1, 1.0], [-0.2, 1.0], [0.35, 1.0], [-0.5, 0.95], [0.6, 0.9], [-0.7, 0.85],
  [0.8, 0.8], [-0.6, 0.85], [0.4, 0.9], [-0.9, 0.9], [1.0, 0.85], [-0.8, 0.9],
  [0.9, 0.9], [-1.0, 0.85], [0.7, 0.9], [-0.6, 0.9], [0.5, 0.9], [-0.5, 0.9],
];

export const SLOT_ORDER = ['ak', 'deagle', 'awp', 'p90'];
export const PRIMARIES = ['ak', 'p90', 'awp']; // CS: one primary at a time — buying another replaces it

// ---------------- Tactical grenades ----------------
// fuse = seconds after release (CS2: no cooking).
export const NADE_DEFS = {
  he:      { name: 'HE GRENADE', short: 'HE',    slot: 3, price: 300, max: 2, fuse: 1.5, radius: 7.5, damage: 98,  throwPower: 17, underPower: 7,  color: 0x4d7c3a, desc: 'Frag — radial damage' },
  flash:   { name: 'FLASHBANG',  short: 'FLASH', slot: 4, price: 200, max: 2, fuse: 1.5, radius: 26,  blindMax: 3.2, throwPower: 17, underPower: 7,  color: 0x8fc3ec, desc: 'Blinds on LOS' },
  smoke:   { name: 'SMOKE',      short: 'SMOKE', slot: 5, price: 300, max: 2, fuse: 1.7, radius: 3.8, duration: 18, throwPower: 17, underPower: 7, color: 0x9aa0ab, desc: 'Dynamic vision block' },
  molotov: { name: 'MOLOTOV',    short: 'MOLY',  slot: 6, price: 400, max: 1, fuse: 2.0, radius: 2.8, duration: 7.0, dps: 52, throwPower: 17, underPower: 7, color: 0xc76a1e, desc: 'Area denial fire' },
};
export const NADE_ORDER = ['he', 'flash', 'smoke', 'molotov'];
export const isNadeKey = (k) => !!NADE_DEFS[k];

// Extension point: agents add grenades without editing throw/detonate code.
export function registerNade(key, def) {
  if (!key || !def || NADE_DEFS[key]) throw new Error('registerNade: bad key or already exists: ' + key);
  NADE_DEFS[key] = def;
  if (!NADE_ORDER.includes(key)) NADE_ORDER.push(key);
}

export const MAP_HALF = 34;            // playable half-extent
export const EYE = 1.62;
export const CROUCH_EYE_DROP = 0.44;
export const STAND_HEIGHT = 1.8;
export const CROUCH_HEIGHT = 1.25;
export const CROUCH_JUMP_LIFT = 0.34; // crouching mid-air tucks legs: feet rise, eye stays (CS crouch-jump)
export const STEP_EPS = 0.04;         // hull starts above feet so standing on box top isn't collision

// Wall running: jump at a wall alongside you while holding W.
export const WALLRUN = {
  minSpeed: 3.0, minAirY: 0.25, maxTime: 1.4, gravity: 3.2, maxSink: -2.2,
  speed: 7.4, jumpUp: 5.8, jumpOut: 5.6, probe: 0.18, minWallAbove: 1.1,
  cooldown: 0.25, camRoll: 0.13, bodyLean: 0.32,
};

export const PLAYER_BODY_CULL_Y = 0.88;
export const ROUND_TIME = 120;
export const BUY_TIME = 20;
export const FREEZE_TIME = 3;
export const ROUNDS_TO_WIN_MATCH = 7;

// CS economy
export const MONEY_START = 800;
export const MONEY_KILL = 300;
export const MONEY_WIN = 3250;
export const MONEY_LOSS = 1900;
export const MONEY_DRAW = 2000;
export const MONEY_MAX = 16000;

// Defusal layout: T spawn WEST, CT east-central between sites.
export const SITES = [
  { name: 'A', pos: null, x: 24, z: -20, r: 4.2, color: 0x2e9bff }, // pos filled with Vector3 in buildMap
  { name: 'B', pos: null, x: 24, z: 20, r: 4.2, color: 0xffb020 },
];
export const BOMB_PLANT_TIME = 2.0;
export const BOMB_DEFUSE_TIME = 3.5;
export const BOMB_TIMER = 35;
