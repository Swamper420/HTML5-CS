// main.js — AGENTS: entry point only. Frame loop (pace/loop), FPS meter, boot + menu wiring.
// All game systems live in js/*.js — see AGENTS.md for the module map. Don't add systems here;
// add a js/ module and call its update from loop() / init from boot().

import * as THREE from 'three';
import { Net } from './net.js';
import { AudioSys, bindAudioEnv } from './js/audio.js';
import { NADE_DEFS, WEAPONS } from './js/config.js';
import {
  SET, applySettings, bindSettingsHooks, loadSettings, saveSettings, wireSettingsUI,
} from './js/settings.js';
import { $, randPick } from './js/utils.js';
import { BOMB, updateBomb } from './js/bomb.js';
import { BOT_R, botDepenetrate, navSteer } from './js/botnav.js';
import { animateBotMesh, botThink, makeBot, updateBot } from './js/bots.js';
import { toggleBuy, updateBuyTimer } from './js/buymenu.js';
import { hasLOS, moveWithCollision } from './js/collision.js';
import { updateEffects } from './js/effects.js';
import { updateGoreScreen } from './js/gore.js';
import { captureFlashAfterimage, updateNades } from './js/grenades.js';
import { announce, updateHUD, updateScreenFeel } from './js/hud.js';
import { initInput, pointerLocked } from './js/input.js';
import { buildMap, waypoints } from './js/map.js';
import { drawMinimap } from './js/minimap.js';
import { updateDamageReport } from './js/dmgreport.js';
import { updatePlayer } from './js/movement.js';
import {
  isMultiplayer, isOnline, remotes, removeRemoteMesh, updateMPStatus, updateRemoteMeshes,
  wireMultiplayer,
} from './js/multiplayer.js';
import { updatePlayerBody } from './js/playerbody.js';
import { camera, initThree, renderer, scene, sunLight } from './js/render.js';
import { lockPointer, pauseGame, resumeGame, startMatch, updateRoundTimers } from './js/rounds.js';
import { G, bots, player } from './js/state.js';
import { buildViewmodel, viewmodel } from './js/viewmodel.js';
export { WEAPONS, NADE_DEFS }; // re-export for agents importing main.js directly

// Wire module hooks lazily (closures evaluate after main.js lets/functions init).
bindSettingsHooks({
  getRenderer: () => { try { return renderer; } catch { return null; } },
  getSunLight: () => { try { return sunLight; } catch { return null; } },
  getAudio: () => AudioSys,
  getGame: () => { try { return G; } catch { return null; } },
  pauseGame: (...a) => { try { return pauseGame(...a); } catch (e) {} },
});
bindAudioEnv({
  getCamera: () => { try { return camera; } catch { return null; } },
  getPlayer: () => { try { return player; } catch { return null; } },
  hasLOS: (...a) => { try { return hasLOS(...a); } catch { return true; } },
});

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
    updateRoundTimers(dt, t); // solo: local clocks · online: server deadlines
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
    try { updateDamageReport(t); } catch (e) {}
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
  $('restart-btn').addEventListener('click', () => {
    if (isOnline()) return; // the server owns the online match
    $('pause-menu').classList.add('hidden'); G.phase = 'playing'; AudioSys.stopMusic(0.2); startMatch();
  });
  $('again-btn').addEventListener('click', () => { if (isOnline()) return; AudioSys.stopMusic(0.2); startMatch(); });

  $('loading-note').textContent = 'Ready. Click DEPLOY.';
  pace();
}

boot();

