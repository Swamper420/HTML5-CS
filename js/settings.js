// js/settings.js — AGENTS: all tunables + persistence + settings UI live here.
// ADD a setting: extend SETTINGS_DEFAULTS + SETTINGS_SPEC (no other file needed).
// Runtime push (renderer/audio/DOM) goes through bindSettingsHooks — main.js wires it at boot.
// Ownership: opts, SET, load/save/apply, settings menu UI, lookSens/swayK/shakeK.

import { $ } from './utils.js';
import { keys } from './state.js';

// Live runtime hooks (main.js provides real objects; safe no-ops until bound).
const _hooks = { getRenderer: null, getSunLight: null, getAudio: null, getGame: null, pauseGame: null };
export function bindSettingsHooks(h) { Object.assign(_hooks, h || {}); }
const _audio = () => { try { return _hooks.getAudio ? _hooks.getAudio() : _hooks.audio || null; } catch { return null; } };

export const opts = { quality: true, sound: true, music: true, difficulty: 1 };

// ---------------- Settings (mouse / video / audio / crosshair+HUD) ----------------
// Persisted to localStorage on this machine only: no account, no server, no telemetry.
export const SETTINGS_KEY = 'h5cs_settings_v1';
export const SETTINGS_DEFAULTS = {
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
export const SET = Object.assign({}, SETTINGS_DEFAULTS);
export const SETTINGS_SPEC = {
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

const _specFor = (k) => {
  for (const t of Object.values(SETTINGS_SPEC)) for (const r of t) if (r.k === k) return r;
  return null;
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) || {};
    for (const k of Object.keys(SETTINGS_DEFAULTS)) {
      if (saved[k] === undefined) continue;
      const d = SETTINGS_DEFAULTS[k];
      if (typeof d === 'boolean') {
        SET[k] = typeof saved[k] === 'string' ? /^(true|1|yes|on)$/i.test(saved[k].trim()) : !!saved[k];
      } else if (typeof d === 'number') {
        const s = saved[k];
        const n = typeof s === 'number' ? s
          : typeof s === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(s) ? parseFloat(s) : NaN;
        if (!Number.isFinite(n)) continue;
        const sp = _specFor(k);
        if (sp && sp.type === 'select' && !sp.choices.some((c) => c[0] === n)) continue;
        SET[k] = sp && sp.type === 'range' ? Math.min(sp.max, Math.max(sp.min, n)) : n;
      } else if (typeof d === 'string') {
        if (typeof saved[k] === 'string') SET[k] = saved[k];
      }
    }
  } catch (e) { /* private window / storage disabled — defaults are fine */ }
}
export function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SET)); } catch (e) {} }

// Push SET into everything the game actually reads at runtime.
export function applySettings() {
  opts.quality = true; // always high — no low-quality mode.
  opts.sound = SET.sound; opts.music = SET.music; opts.difficulty = SET.difficulty;
  try { const r = _hooks.getRenderer ? _hooks.getRenderer() : null; if (r) r.shadowMap.enabled = true; } catch (e) {}
  try { const s = _hooks.getSunLight ? _hooks.getSunLight() : null; if (s) s.castShadow = true; } catch (e) {}
  try { const a = _audio(); if (a) a.applyVolumes(); } catch (e) {}
  if (!SET.music) { try { const a = _audio(); if (a) a.stopMusic(0.2); } catch (e) {} }
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
export function syncCrosshairPreview() {
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
export function buildSettingsUI() {
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
export function settingsOpen() { const el = $('settings-menu'); return !!el && !el.classList.contains('hidden'); }
export function openSettings() {
  // Opening mid-match pauses first, so the pause menu is what you fall back to.
  for (const k of Object.keys(keys)) delete keys[k]; // no stuck movement keys under the menu
  try { const g = _hooks.getGame ? _hooks.getGame() : null; if (g && g.phase === 'playing' && _hooks.pauseGame) _hooks.pauseGame(); } catch (e) {}
  $('settings-menu').classList.remove('hidden');
  buildSettingsUI();
}
export function closeSettings() { $('settings-menu').classList.add('hidden'); }
export function resetSettings() {
  Object.assign(SET, SETTINGS_DEFAULTS);
  applySettings(); saveSettings(); buildSettingsUI();
}
export function wireSettingsUI() {
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
export const lookSens = () => SET.sens * 0.001;
export const swayK = () => SET.sway / 100;
export const shakeK = () => SET.shake / 100;

