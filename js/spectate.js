// js/spectate.js — AGENTS: Spectating after death: target cycling (bots + remotes), first-person/chase camera, overlay.
// Ownership: spectateTargets, spectateNext, spectateToggleMode, updateSpectate.

import * as THREE from 'three';
import { AudioSys } from './audio.js';
import { CROUCH_EYE_DROP, EYE } from './config.js';
import { SET } from './settings.js';
import { $, clamp } from './utils.js';
import { rayWallDist } from './collision.js';
import { setMouseJustDown } from './input.js';
import { remotes } from './multiplayer.js';
import { camera } from './render.js';
import { bots, player } from './state.js';
import { viewmodel } from './viewmodel.js';

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
export function spectateCurrent() {
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
export function updateSpectateOverlay() {
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
export function spectateNext() {
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
export function spectateToggleMode() {
  if (player.alive) return;
  player.specMode = player.specMode === 'first' ? 'chase' : 'first';
  AudioSys.click(900, 0.05, 0.25);
  updateSpectateOverlay();
}
export function updateSpectate(dt) {
  setMouseJustDown(false); // clicks while dead cycle targets, never fire
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

