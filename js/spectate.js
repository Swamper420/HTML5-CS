// js/spectate.js — AGENTS: Spectating after death: target cycling (bots + remotes), first-person/chase camera, overlay.
// Ownership: spectateTargets, spectateNext, spectateToggleMode, updateSpectate.

import * as THREE from 'three';
import { AudioSys } from './audio.js';
import { CROUCH_EYE_DROP, EYE, WEAPONS, isNadeKey } from './config.js';
import { SET } from './settings.js';
import { $, clamp } from './utils.js';
import { damp } from './anim.js';
import { rayWallDist } from './collision.js';
import { setMouseJustDown } from './input.js';
import { remotes } from './multiplayer.js';
import { camera } from './render.js';
import { bots, player } from './state.js';
import {
  VM_AIM, VM_AIM_SOLVED, VM_HIP, buildViewmodel, viewmodel, vmBase, vmFlashGroup, vmL, vmRig,
} from './viewmodel.js';

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
        get pitch() { return e.pitch !== undefined ? e.pitch : (e.data && e.data.pitch) || 0; },
        get vx() { return e.vx || 0; },
        get vz() { return e.vz || 0; },
        get weapon() { return (e.data && e.data.weapon) || 'ak'; },
        get dual() { return !!(e.data && e.data.dual); },
        get aiming() { return !!(e.data && e.data.aiming); },
        get flashAt() { return e.flashAt || 0; },
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
// What the spectated target actually sees: their yaw/pitch, weapon and ADS state.
// Bots use mesh yaw (a half turn off the camera convention); remotes send player yaw.
function targetView(target) {
  if (target.__isRemote) {
    return {
      yaw: target.yaw, pitch: target.pitch, vx: target.vx, vz: target.vz,
      weapon: target.weapon, dual: target.dual, aiming: target.aiming, flashAt: target.flashAt,
    };
  }
  const my = target.mesh ? target.mesh.rotation.y : target.yaw;
  return {
    yaw: my + Math.PI, pitch: target.aimPitch || 0, vx: target._vx || 0, vz: target._vz || 0,
    weapon: 'ak', dual: false, aiming: false, flashAt: target.flashAt || 0,
  };
}
const SPEC = { key: null, flashAt: 0, aimK: 0, bobT: 0 };
function specViewmodel(view, dt, t) {
  const key = WEAPONS[view.weapon] || isNadeKey(view.weapon) ? view.weapon : 'ak';
  const tag = key + (view.dual ? ':dual' : '');
  if (!viewmodel || viewmodel.userData.spec !== tag) {
    buildViewmodel(key, { dual: view.dual && !!WEAPONS[key] });
    viewmodel.userData.spec = tag;
    SPEC.flashAt = view.flashAt; SPEC.aimK = 0;
  }
  const def = WEAPONS[key];
  const aimable = !!def;
  SPEC.aimK = damp(SPEC.aimK, view.aiming && aimable ? 1 : 0, 12, dt);
  const scoped = key === 'awp' && SPEC.aimK > 0.5;
  viewmodel.visible = !scoped;
  $('scope-overlay').classList.toggle('hidden', !scoped);
  $('crosshair').style.opacity = scoped ? 0 : (1 - SPEC.aimK).toFixed(3);
  const wantFov = def && view.aiming ? def.zoomFov : SET.fov;
  camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 14);
  camera.updateProjectionMatrix();
  // Pose: hip -> solved iron sights, with a stride bob from their real speed.
  const spd = Math.hypot(view.vx, view.vz);
  SPEC.bobT += dt * (spd > 0.5 ? 9 : 0);
  const solved = VM_AIM_SOLVED[key];
  const aimP = (solved && solved.pos) || VM_AIM[key] || VM_AIM.ak;
  const a = SPEC.aimK, bobAmp = 0.009 * (1 - a * 0.94) * clamp(spd / 5, 0, 1);
  if (vmBase) {
    vmBase.position.set(
      VM_HIP.x + (aimP.x - VM_HIP.x) * a + Math.cos(SPEC.bobT * 0.5) * bobAmp,
      VM_HIP.y + (aimP.y - VM_HIP.y) * a + Math.abs(Math.sin(SPEC.bobT)) * bobAmp * 1.2 + Math.sin(t * 1.7) * 0.0018,
      VM_HIP.z + (aimP.z - VM_HIP.z) * a,
    );
    vmBase.rotation.set(solved ? solved.pitch * a : 0, solved ? solved.yaw * a : 0, 0);
  }
  if (vmL) { vmL.base.position.set(-VM_HIP.x - 0.03, VM_HIP.y, VM_HIP.z); vmL.base.rotation.set(0, 0.06, 0); }
  // Their shots kick the gun and light the muzzle (springs run in updateEffects).
  if (view.flashAt && view.flashAt !== SPEC.flashAt) {
    SPEC.flashAt = view.flashAt;
    if (def) {
      vmRig.kickV += def.vmKick * 19; vmRig.kickRotV += def.punch * 12;
      if (vmFlashGroup) for (const f of vmFlashGroup.children) f.material.opacity = 1;
    }
  }
}
function hideSpecViewmodel() {
  if (viewmodel) viewmodel.visible = false;
  $('scope-overlay').classList.add('hidden');
  $('crosshair').style.opacity = 0;
}
export function updateSpectate(dt) {
  const t = performance.now() / 1000;
  setMouseJustDown(false); // clicks while dead cycle targets, never fire
  const target = spectateCurrent();
  const firstPerson = !!target && player.specMode === 'first';
  if (!firstPerson) {
    hideSpecViewmodel();
    // ease FOV back (e.g. after dying scoped with the AWP)
    camera.fov += (SET.fov - camera.fov) * Math.min(1, dt * 8);
    camera.updateProjectionMatrix();
  }
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
    // Through their eyes: their real look direction, weapon, ADS and shots.
    const view = targetView(target);
    camera.position.set(target.pos.x, target.pos.y + EYE - CROUCH_EYE_DROP * (target.crouchK || (target.crouching ? 1 : 0)), target.pos.z);
    camera.rotation.y = view.yaw;
    camera.rotation.x = clamp(view.pitch, -1.45, 1.45);
    camera.rotation.z = target.wallRoll || 0;
    // Keep our own look in sync so switching to chase cam starts behind them.
    player.yaw = view.yaw; player.pitch = clamp(view.pitch, -1.2, 1.2);
    specViewmodel(view, dt, t);
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

