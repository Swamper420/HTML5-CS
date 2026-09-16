// js/state.js — AGENTS: Core mutable game state shared by everything: G (phase/round/score/timers), player, bots[], keys{}.
// Ownership: G, player, bots, keys, newLoadout/primaryKey/addMoney. Import these; never re-declare.

import * as THREE from 'three';
import { MONEY_MAX, MONEY_START, PRIMARIES, ROUND_TIME } from './config.js';
import { clamp } from './utils.js';

// player-dependent helpers stay here (need live player object)
export const newLoadout = () => ({ ak: { owned: false, mag: 0, reserve: 0 }, deagle: { owned: true, mag: 7, reserve: 35 }, awp: { owned: false, mag: 0, reserve: 0 }, p90: { owned: false, mag: 0, reserve: 0 }, helix: { owned: false, mag: 0, reserve: 0 }, machete: { owned: true, mag: 0, reserve: 0 } });
export const primaryKey = () => PRIMARIES.find((k) => player.weapons[k] && player.weapons[k].owned) || null;
export const addMoney = (n) => { player.money = clamp(player.money + n, 0, MONEY_MAX); };

export const G = {
  phase: 'menu', // menu | playing | paused | over
  round: 1, score: { ct: 0, t: 0 }, roundKills: { ct: 0, t: 0 },
  timeLeft: ROUND_TIME, buyOpen: false, roundEnding: false,
  freezeLeft: 0, buyLeft: 0,
  kills: 0, deaths: 0, headshots: 0, shots: 0, hits: 0,
  startTime: 0,
  // online (server match): local deadlines for freeze/buy/round clocks + which server match/round we're showing
  srvT: { freeze: 0, buy: 0, round: 0 }, srvMatchId: 0, srvRoundId: 0,
  menuOpen: false, // online ESC menu: an overlay, the match keeps running
};
export const isFreeze = () => G.freezeLeft > 0;
export const isBuyTime = () => G.buyLeft > 0 && !G.roundEnding;

export const player = {
  team: 'ct', name: 'YOU',
  pos: new THREE.Vector3(-29, 0, 0), vel: new THREE.Vector3(),
  yaw: -Math.PI / 2, pitch: 0, onGround: true,
  hp: 100, armor: 0, money: MONEY_START, alive: true,
  weapons: { ak: { owned: false, mag: 0, reserve: 0 }, deagle: { owned: true, mag: 7, reserve: 35 }, awp: { owned: false, mag: 5, reserve: 0 }, p90: { owned: false, mag: 0, reserve: 0 }, helix: { owned: false, mag: 0, reserve: 0 }, machete: { owned: true, mag: 0, reserve: 0 } },
  cur: 'deagle', last: 'ak', reloading: 0, reloadDur: 1, nextShot: 0,
  aiming: false, respawnAt: 0, radius: 0.45, lastDmgDir: 0,
  crouching: false, crouch: 0, // held (or toggled) with C; crouch is the 0..1 blend
  useQueued: 0, nextShotL: 0, // E press time (pickup, s) · left-gun cooldown (dual wield)
  airTuck: false,               // crouched mid-air (feet lifted by CROUCH_JUMP_LIFT)
  wallRun: null,                // { t, nx, nz, side, box } while running on a wall
  wallCd: 0, lastWallBox: null, wallRoll: 0, spaceWas: false,
  kills: 0, deaths: 0, assists: 0,
  // gunplay state: bloom heat + spray index + recoverable punch + shake
  bloom: 0, sprayIdx: 0, lastShotT: -9,
  // spectate-after-death state (bot ref + camera mode)
  specTarget: null, specMode: 'chase', // 'first' | 'chase'
  // tactical grenades: counts per round (CS: rebuy each round, no carry-over for dead)
  nades: { he: 0, flash: 0, smoke: 0, molotov: 0, nuke: 0 },
  cook: null, // {type, lmb, rmb, heldT} pin pulled — throw on release (LMB far, RMB short, both medium)
  carryingNuke: false, nukeArmedAt: 0, // two-hand live-bomb carry: touch a wall/person = boom
  _moveBlocked: false, // set per-frame by movement.js: full intent, ~no travel (ran face-first into a wall)
  flashUntil: 0, flashMax: 0, // white-out blindness (performance-time seconds)
  burnT: 0, // last molotov burn tick overlay
};

export const bots = [];
export const keys = {};

