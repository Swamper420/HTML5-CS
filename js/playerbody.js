// js/playerbody.js — AGENTS: Local player's own full body (visible when looking down, casts shadow; becomes the corpse on death).
// Ownership: playerMesh, ensurePlayerMesh, setPlayerBodyFirstPerson, updatePlayerBody.

import * as THREE from 'three';
import { PLAYER_BODY_CULL_Y, WALLRUN } from './config.js';
import { clamp, rand } from './utils.js';
import { animateSoldier, damp } from './anim.js';
import { playerInPlantSite, playerNearPlantedBomb } from './combat.js';
import { spawnBloodPool } from './effects.js';
import { restoreSoldierMesh } from './gibs.js';
import { bloodFountain, corpseK, slideCorpseOut, updateRagdoll } from './gore.js';
import { scene } from './render.js';
import { makeSoldier, updateBlob } from './soldier.js';
import { G, keys, player } from './state.js';

// The camera sits inside this rig's skull, so the head, arms and world rifle are
// made shadow-only: colorWrite off means they paint nothing for the camera, but
// three.js still runs them through the shadow pass, so your shadow keeps its head
// and gun. (Setting visible = false would drop them from the shadow map too, and
// layers don't help either — the shadow pass tests object layers against the VIEW
// camera, not the light.)
export let playerMesh = null, _playerBodyTeam = null, _playerFirstPerson = null;
function playerBodyHiddenParts(mesh) {
  const ud = mesh.userData, r = ud.rig;
  const seen = new Set();
  const add = (o) => { if (o && o.isMesh) seen.add(o); };
  for (const p of (ud.headParts || [])) add(p);
  // the world rifle would fight the viewmodel, and the arms would fight its hands
  for (const g of [r.shoulderL, r.shoulderR, r.gun]) { if (g) g.traverse(add); }
  // Everything from the waist up is culled for your own camera. The torso tops out
  // just below eye level (a run would put you inside your own shoulders), and a
  // half-body hanging under the view reads worse than clean legs. Measured off the
  // rest pose, so it keeps working if the model changes.
  try {
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3();
    mesh.traverse((o) => {
      if (!o.isMesh || seen.has(o)) return;
      box.setFromObject(o);
      if (box.max.y > PLAYER_BODY_CULL_Y) add(o);
    });
  } catch (e) {}
  return [...seen];
}
// firstPerson=true -> head/arms/gun invisible to the camera but still casting.
// firstPerson=false -> whole body drawn normally (your corpse, once you are dead).
export function setPlayerBodyFirstPerson(on) {
  if (!playerMesh || _playerFirstPerson === on) return;
  _playerFirstPerson = on;
  for (const o of playerBodyHiddenParts(playerMesh)) {
    if (!o.material) continue;
    if (!o.userData._fpMat) {
      o.userData._srcMat = o.material;
      const m = o.material.clone();
      m.colorWrite = false; m.depthWrite = false;
      o.userData._fpMat = m;
    }
    o.material = on ? o.userData._fpMat : o.userData._srcMat;
    o.castShadow = true;
  }
}
function ensurePlayerMesh() {
  const team = player.team || 'ct';
  if (playerMesh && _playerBodyTeam === team) return playerMesh;
  if (playerMesh) { try { scene.remove(playerMesh); } catch (e) {} }
  playerMesh = makeSoldier(team);
  _playerBodyTeam = team;
  _playerFirstPerson = null;
  scene.add(playerMesh);
  setPlayerBodyFirstPerson(true);
  return playerMesh;
}
export function resetPlayerBody() {
  ensurePlayerMesh();
  try { restoreSoldierMesh(playerMesh); } catch (e) {}
  _playerFirstPerson = null;
  setPlayerBodyFirstPerson(true);
  playerMesh.rotation.set(0, (player.yaw || 0) + Math.PI, 0);
  playerMesh.position.copy(player.pos);
  playerMesh.visible = true;
  player._bodyPrev = null; player._bvx = 0; player._bvz = 0;
  player.deathT = 0; player.fall = null;
}
export function updatePlayerBody(dt, t) {
  if (!playerMesh) return;
  const m = playerMesh;
  if (G.phase === 'menu') { m.visible = false; if (player.blob) player.blob.visible = false; return; }
  if (!player.alive) {
    if (player.exploded) {
      player.deathT = Math.min(6.0, (player.deathT || 0) + dt);
      m.visible = false;
      if (player.blob) player.blob.visible = false;
      if (player.deathT < 5.0) {
        try {
          bloodFountain(new THREE.Vector3(player.pos.x, 0.18, player.pos.z), dt, 1.6);
          if (Math.random() < dt * 2.2) spawnBloodPool(player.pos.x + rand(-1.1, 1.1), player.pos.z + rand(-1.1, 1.1), false);
        } catch (e) {}
      }
      return;
    }
    // Your own corpse: full body back on, ragdoll settles, tips over like anyone else.
    setPlayerBodyFirstPerson(false);
    player.deathT = Math.min(1.6, (player.deathT || 0) + dt);
    updateRagdoll(m, dt);
    const { k: pk, e: pease } = corpseK(player.deathT);
    const f = player.fall || { dirX: 0, dirZ: 1, spin: 0, roll: 0, power: 1 };
    const fwdX = -Math.sin(player.yaw), fwdZ = -Math.cos(player.yaw);
    const fDot = f.dirX * fwdX + f.dirZ * fwdZ;
    const sDot = f.dirX * fwdZ - f.dirZ * fwdX;
    const tip = Math.PI / 2 * 0.95;
    m.position.set(player.pos.x, 0.05 + Math.sin(Math.min(1, pk * 1.3) * Math.PI) * 0.08 * (f.power || 1) * (1 - pk), player.pos.z);
    try { slideCorpseOut(m, 0.5); player.pos.set(m.position.x, 0, m.position.z); } catch (e) {}
    m.rotation.x = (fDot >= 0 ? tip : -tip) * (0.75 + Math.abs(fDot) * 0.45) * pease;
    m.rotation.z = clamp(-sDot * tip * 0.9 + (f.roll || 0), -1.2, 1.2) * pease;
    m.rotation.y = player.yaw + Math.PI + (f.spin || 0) * pease;
    m.visible = true;
    try { updateBlob(player, player.pos.x, player.pos.z, false, false); } catch (e) {}
    return;
  }
  setPlayerBodyFirstPerson(true);
  m.visible = true;
  m.position.copy(player.pos);
  player.wallLean = damp(player.wallLean || 0, player.wallRun ? player.wallRun.side * WALLRUN.bodyLean : 0, 10, dt);
  m.rotation.set(0, player.yaw + Math.PI, player.wallLean);
  // Body-space gait needs the same forward convention the bots use, and the
  // player's yaw is a half turn off it.
  animateSoldier(m, {
    vx: player.vel.x, vz: player.vel.z,
    yaw: player.yaw + Math.PI,
    pitch: player.pitch,
    grounded: player.onGround || !!player.wallRun,
    crouch: !!player.crouching,
    kneel: !!(keys['KeyE'] && (playerNearPlantedBomb() || playerInPlantSite())),
    reloading: player.reloading > 0,
    wall: player.wallRun ? player.wallRun.side : 0,
  }, dt, t);
  try { updateBlob(player, player.pos.x, player.pos.z, true, Math.hypot(player.vel.x, player.vel.z) > 1.5); } catch (e) {}
}

