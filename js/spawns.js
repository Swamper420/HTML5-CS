// js/spawns.js — AGENTS: Spawn slot selection + facing for player/bots (solo and online-consistent).
// Ownership: spawnPoint, spawnYaw*, mySpawnSlot, botDefaultSlot.

import * as THREE from 'three';
import { Net } from '../net.js';
import { rand } from './utils.js';
import { spawns } from './map.js';
import { isOnline } from './multiplayer.js';
import { player } from './state.js';

function faceCenterYaw(pos) { return Math.atan2(-pos.x, -pos.z); } // mesh convention
function faceCenterYawPlayer(pos) { return Math.atan2(pos.x, pos.z); } // camera convention
// Spawn helpers: pick a slot, and face the way out of the pocket (toward mid on your side)
// instead of the map origin, which from most slots is a wall.
export function spawnList(team) { return team === 't' ? spawns.t : spawns.ct; }
export function spawnPoint(team, slot, jitter = 0.4) {
  const list = spawnList(team), n = list.length;
  return list[((slot % n) + n) % n].clone().add(new THREE.Vector3(rand(-jitter, jitter), 0, rand(-jitter, jitter)));
}
function spawnLookTarget(team, pos) { const sz = pos.z < 0 ? -1 : 1; return team === 't' ? [-18, 4 * sz] : [14, 4 * sz]; }
export function spawnYawPlayer(team, pos) { const [tx, tz] = spawnLookTarget(team, pos); return Math.atan2(pos.x - tx, pos.z - tz); } // camera convention
export function spawnYawMesh(team, pos) { const [tx, tz] = spawnLookTarget(team, pos); return Math.atan2(tx - pos.x, tz - pos.z); }     // mesh convention
// Online: rank among same-team humans by server id, so every client agrees and nobody stacks.
export function mySpawnSlot() {
  const team = player.team || 'ct';
  if (!isOnline() || Net.id == null) return 0;
  const ids = [Net.id];
  try { for (const r of Net.remoteList()) if ((r.team || 't') === team) ids.push(r.id); } catch (e) {}
  ids.sort((a, b) => a - b);
  return Math.max(0, ids.indexOf(Net.id));
}
// Solo default: the player holds slot 0 of their team, so their team's bots start one slot later.
export function botDefaultSlot(bot) { return bot.idx + (bot.team === (player.team || 'ct') ? 1 : 0); }

