// js/input.js — AGENTS: Keyboard/mouse input + pointer lock. Exposes live mouse/rmb/crosshair flags (write via set* exports).
// Ownership: pointerLocked, mouseDown/JustDown, rmbDown/JustDown, crossGap, initInput.

import { AudioSys } from './audio.js';
import { NADE_ORDER, WEAPONS, isNadeKey } from './config.js';
import { SET, closeSettings, lookSens, settingsOpen, swayK } from './settings.js';
import { clamp } from './utils.js';
import {
  buyByKey, buyCursorClick, buyCursorSync, buyItem, moveBuyCursor, refreshBuyMenu, toggleBuy,
} from './buymenu.js';
import { disarmNuke, playerPrimeNade, playerReleaseNade } from './grenades.js';
import { announce } from './hud.js';
import { dropWeapon, isDualCur } from './pickups.js';
import { renderer } from './render.js';
import { pauseGame } from './rounds.js';
import { setScoreboard } from './scoreboard.js';
import { startReload, switchWeapon } from './shooting.js';
import { spectateNext, spectateToggleMode } from './spectate.js';
import { G, isFreeze, keys, player, primaryKey } from './state.js';
import { vmRig } from './viewmodel.js';

export let pointerLocked = false;

export let mouseDown = false, mouseJustDown = false, crossGap = 8;
export let rmbDown = false, rmbJustDown = false; // left-hand trigger when dual wielding
export function initInput() {
  addEventListener('keydown', (e) => {
    if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
    if (G.menuOpen && !settingsOpen()) { clearKeys(); return; } // online menu overlay: game runs on, you don't
    if (settingsOpen()) { if (e.code === 'Escape') { e.preventDefault(); closeSettings(); } return; }
    if (G.phase !== 'playing') { clearKeys(); return; }
    keys[e.code] = true;
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
      if (e.code === 'KeyH') { if (!e.repeat) buyItem('helix'); return; }
      if (e.code === 'KeyN') { if (!e.repeat) buyItem('nuke'); return; }
    }
    if (e.code === 'Digit1') { const pk = primaryKey(); if (pk) switchWeapon(pk); else announce('NO PRIMARY — PRESS B', 1100); }
    if (e.code === 'Digit2') switchWeapon('deagle');
    if (e.code === 'Digit3') {
      // MACHETE lives on 3 (free, always owned); HELIX shares the slot behind it.
      if (player.cur !== 'machete') switchWeapon('machete');
      else if (player.weapons.helix && player.weapons.helix.owned) switchWeapon('helix');
      else announce('MACHETE — FREE FOREVER', 1100);
    }
    if (e.code === 'Digit4') switchWeapon('he');
    if (e.code === 'Digit5') switchWeapon('flash');
    if (e.code === 'Digit6') switchWeapon('smoke');
    if (e.code === 'Digit7') switchWeapon('molotov');
    if (e.code === 'Digit8') switchWeapon('nuke');
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
    if (e.code === 'KeyX' && player.carryingNuke) { if (!e.repeat) disarmNuke(); return; }
    if (e.code === 'KeyX' && WEAPONS[player.cur]) dropWeapon(player.cur);
    if (e.code === 'KeyE') player.useQueued = performance.now() / 1000;
    if (e.code === 'KeyB') toggleBuy();
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; if (e.code === 'Tab') setScoreboard(false); });
  addEventListener('blur', () => { clearKeys(); try { setScoreboard(false); } catch {} });
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
    if (e.button === 2) { if (isDualCur()) { rmbDown = true; rmbJustDown = true; } else if (WEAPONS[player.cur] && !WEAPONS[player.cur].melee) player.aiming = true; }
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
    if (pointerLocked && G.menuOpen) { G.menuOpen = false; const pm = document.getElementById('pause-menu'); if (pm) pm.classList.add('hidden'); }
    if (!pointerLocked && G.buyOpen) {
      // ESC (browser-forced unlock) while shopping: close the menu and pause, like any other ESC.
      toggleBuy(false, false);
      clearKeys();
      if (G.phase === 'playing' && player.alive) pauseGame();
      return;
    }
    if (!pointerLocked && G.phase === 'playing' && player.alive) { clearKeys(); pauseGame(); }
    buyCursorSync();
  });
  // Native click only matters when the pointer is NOT locked (locked clicks target the canvas).
  document.querySelectorAll('.buy-item').forEach((b) => b.addEventListener('click', () => { if (!pointerLocked) buyItem(b.dataset.buy); }));
  refreshBuyMenu(true);
}


// Cross-module writers (ES imports are read-only bindings).
export function clearKeys() {
  for (const k of Object.keys(keys)) delete keys[k];
  setMouseDown(false); setRmbDown(false);
  setMouseJustDown(false); setRmbJustDown(false);
}
export function setCrossGap(v) { return (crossGap = v); }
export function setRmbJustDown(v) { return (rmbJustDown = v); }
export function setMouseJustDown(v) { return (mouseJustDown = v); }
export function setMouseDown(v) { return (mouseDown = v); }
export function setRmbDown(v) { return (rmbDown = v); }
