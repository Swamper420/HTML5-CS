// js/hud.js — AGENTS: HUD + screen feedback: hitmarkers, damage flash, screen shake/feel, announcements, killfeed, updateHUD.
// Ownership: updateHUD, announce, addKillfeed, flashDamage, updateScreenFeel.

import * as THREE from 'three';
import { Net } from '../net.js';
import { NADE_DEFS, ROUNDS_TO_WIN_MATCH, WEAPONS, isNadeKey } from './config.js';
import { SET } from './settings.js';
import { $, clamp } from './utils.js';
import { BOMB } from './bomb.js';
import { crossGap } from './input.js';
import { isOnline } from './multiplayer.js';
import { camera } from './render.js';
import { renderScoreboard, scoreboardVisible } from './scoreboard.js';
import { G, bots, isBuyTime, isFreeze, player, primaryKey } from './state.js';
import { esc } from './stats.js';

export function playerHitmark(head, kill) {
  const h = $('hitmarker');
  h.classList.remove('show', 'kill'); void h.offsetWidth;
  h.classList.add('show'); if (kill) h.classList.add('kill');
}
export function flashDamage(shooter) {
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
export function flashExplosionOverlay() {
  _boomFlashV = 1;
  try { const el = $('boomflash'); if (el) el.style.opacity = 1; } catch (e) {}
}
// per-frame screen feel: sun glare when facing the sun, low-hp heartbeat, boom decay
const _sunDirV = new THREE.Vector3(34, 42, 20).normalize();
export function updateScreenFeel(dt, t) {
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
export function announce(msg, ms = 1200) {
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
export function announceRoundEnd(title, moneyText, track, ms = 3400) {
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
export function addKillfeed(killer, kTeam, victim, vTeam, wpn, head) {
  const kf = $('killfeed');
  const div = document.createElement('div');
  div.className = 'feed-item' + (head ? ' headshot' : '');
  div.innerHTML = `<span class="killer ${kTeam === 'ct' ? 'ct' : 't'}">${esc(killer)}</span><span class="wpn">[${esc(wpn)}${head ? ' 💀' : ''}]</span><span class="victim ${vTeam === 'ct' ? 'ct' : 't'}">${esc(victim)}</span>`;
  kf.prepend(div);
  while (kf.children.length > 5) kf.lastChild.remove();
  setTimeout(() => div.remove(), 6000);
}
function fmtTime(s) { s = Math.max(0, Math.ceil(s)); return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`; }
export function updateHUD() {
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

