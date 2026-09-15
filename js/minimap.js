// js/minimap.js — AGENTS: Minimap canvas: map layout, teammates, LOS-spotted enemies with linger, bomb.
// Ownership: drawMinimap, mm state.

import { EYE, MAP_HALF, SITES } from './config.js';
import { $ } from './utils.js';
import { BOMB } from './bomb.js';
import { _tmpMMEye, _tmpMMTgt } from './collision.js';
import { fireZones, nadeProjectiles, tacticalSmokes } from './grenades.js';
import { colliders } from './map.js';
import { isMultiplayer, isOnline, remotes } from './multiplayer.js';
import { hasLOSClear, smokeVolumeRadius } from './smoke.js';
import { bots, player } from './state.js';

// minimap
const mm = { last: 0 };
// LOS tracking: stores last time each entity was in LOS of the player (for enemy linger on minimap).
const mmSpotTime = new WeakMap(); // entity -> performance timestamp (seconds)
const MM_SPOT_LINGER = 2.0; // seconds enemies remain visible after last LOS
function mmCanSeeEnemy(entityPos, tNow) {
  if (!player.alive) return true; // dead = spectate, show all
  _tmpMMEye.set(player.pos.x, EYE, player.pos.z);
  _tmpMMTgt.set(entityPos.x, EYE, entityPos.z);
  return hasLOSClear(_tmpMMEye, _tmpMMTgt);
}
function mmEnemyVisible(entity, entityTeam, entityPos, tNow) {
  const myTeam = player.team || 'ct';
  const isEnemy = entityTeam !== myTeam;
  if (!isEnemy) return true; // always show friendlies
  if (!player.alive) return true; // spectating — show all
  // Check current LOS.
  if (mmCanSeeEnemy(entityPos, tNow)) {
    mmSpotTime.set(entity, tNow);
    return true;
  }
  // Linger: keep visible briefly after LOS broken.
  const lastSeen = mmSpotTime.get(entity);
  return lastSeen !== undefined && (tNow - lastSeen) < MM_SPOT_LINGER;
}
export function drawMinimap(t) {
  if (t - mm.last < 0.12) return; mm.last = t;
  const c = $('minimap'), g = c.getContext('2d');
  const S = c.width, world = MAP_HALF * 2 + 8;
  const px = (x) => (x + world / 2) / world * S;
  const pz = (z) => (z + world / 2) / world * S;
  g.clearRect(0, 0, S, S);
  g.fillStyle = 'rgba(20,28,40,0.9)'; g.fillRect(0, 0, S, S);
  // walls (project colliders as rects, top-down using min/max x/z)
  g.fillStyle = 'rgba(200,180,130,0.85)';
  for (const b of colliders) {
    const w = (b.max.x - b.min.x) / world * S, h = (b.max.z - b.min.z) / world * S;
    if (w < 1 || h < 1 || b.max.y < 1.5) continue;
    g.fillRect(px(b.min.x), pz(b.min.z), Math.max(1.5, w), Math.max(1.5, h));
  }
  // sites (A north, B south) + target highlight
  for (const s of SITES) {
    const isTarget = !BOMB.planted && BOMB.targetSite === s.name;
    g.fillStyle = s.name === 'A' ? '#2e9bff' : '#ffb020';
    g.beginPath(); g.arc(px(s.x), pz(s.z), isTarget ? 5.5 : 4, 0, 7); g.fill();
    if (isTarget) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(px(s.x), pz(s.z), 6.5, 0, 7); g.stroke(); }
    g.fillStyle = '#0a0e14'; g.font = 'bold 7px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(s.name, px(s.x), pz(s.z));
  }
  // bomb: planted (blinking red) / dropped (orange) / carrier (ring the carrier)
  const tNow2 = performance.now() / 1000;
  if (BOMB.planted && BOMB.pos) {
    if (Math.floor(tNow2 * 3) % 2 === 0) g.fillStyle = '#ff2222'; else g.fillStyle = '#ff8888';
    g.beginPath(); g.arc(px(BOMB.pos.x), pz(BOMB.pos.z), 5, 0, 7); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.arc(px(BOMB.pos.x), pz(BOMB.pos.z), 7, 0, 7); g.stroke();
  } else if (BOMB.droppedPos) {
    g.fillStyle = '#ff9a2a';
    g.beginPath(); g.arc(px(BOMB.droppedPos.x), pz(BOMB.droppedPos.z), 4.5, 0, 7); g.fill();
  }
  // bots — friendlies always visible, enemies only when in LOS (or recently spotted)
  const tNowMm = performance.now() / 1000;
  for (const b of bots) {
    if (!b.alive) continue;
    if (!b.mesh.visible && isMultiplayer()) continue; // hidden PvP bots
    // LOS filter for enemies (use 'b' as stable WeakMap key).
    if (!mmEnemyVisible(b, b.team, b.pos, tNowMm)) continue;
    const isEnemy = b.team !== (player.team || 'ct');
    g.fillStyle = b.team === 'ct' ? '#5eb2ff' : '#ff7043';
    // Fade enemy dots slightly when lingering (not currently in LOS).
    if (isEnemy && !mmCanSeeEnemy(b.pos, tNowMm)) {
      const lastSeen = mmSpotTime.get(b);
      const age = lastSeen !== undefined ? (tNowMm - lastSeen) : MM_SPOT_LINGER;
      g.globalAlpha = Math.max(0.2, 1 - age / MM_SPOT_LINGER);
    }
    g.beginPath(); g.arc(px(b.pos.x), pz(b.pos.z), 3, 0, 7); g.fill();
    g.globalAlpha = 1;
    if (b.hasBomb) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(px(b.pos.x), pz(b.pos.z), 5, 0, 7); g.stroke(); }
    if (!player.alive && player.specTarget === b) { g.strokeStyle = '#3dff7a'; g.lineWidth = 2; g.beginPath(); g.arc(px(b.pos.x), pz(b.pos.z), 6, 0, 7); g.stroke(); }
  }
  // real remote players — same LOS rules
  try {
    if (isOnline()) {
      for (const [rid, e] of remotes) {
        const rd = e.data; if (!rd || !rd.alive) continue;
        const remTeam = rd.team || 't';
        if (!mmEnemyVisible(e, remTeam, e.pos, tNowMm)) continue;
        const isEnemy = remTeam !== (player.team || 'ct');
        g.fillStyle = remTeam === 'ct' ? '#5eb2ff' : '#ff7043';
        if (isEnemy && !mmCanSeeEnemy(e.pos, tNowMm)) {
          const lastSeen = mmSpotTime.get(e);
          const age = lastSeen !== undefined ? (tNowMm - lastSeen) : MM_SPOT_LINGER;
          g.globalAlpha = Math.max(0.2, 1 - age / MM_SPOT_LINGER);
        }
        g.beginPath(); g.arc(px(e.pos.x), pz(e.pos.z), 3.4, 0, 7); g.fill();
        g.globalAlpha = 1;
        g.strokeStyle = isEnemy ? '#ffffff' : 'rgba(255,255,255,0.4)';
        g.lineWidth = 1;
        g.beginPath(); g.arc(px(e.pos.x), pz(e.pos.z), 5, 0, 7); g.stroke();
        if (!player.alive && player.specTarget && player.specTarget.__remoteId === rid) {
          g.strokeStyle = '#3dff7a'; g.lineWidth = 2;
          g.beginPath(); g.arc(px(e.pos.x), pz(e.pos.z), 6.5, 0, 7); g.stroke();
        }
      }
    }
  } catch {}
  // tactical: molotov fires (orange) under smokes (grey) under projectiles (white ticks)
  try {
    for (const z of fireZones) {
      const rr = (z.radius / world) * S;
      g.fillStyle = 'rgba(255,110,20,0.35)';
      g.beginPath(); g.arc(px(z.pos.x), pz(z.pos.z), rr, 0, 7); g.fill();
      g.fillStyle = '#ff7a1e';
      g.beginPath(); g.arc(px(z.pos.x), pz(z.pos.z), 3, 0, 7); g.fill();
    }
    const tt = performance.now() / 1000;
    for (const s of tacticalSmokes) {
      const rr = (smokeVolumeRadius(s, tt) / world) * S;
      g.fillStyle = 'rgba(200,200,200,0.45)';
      g.beginPath(); g.arc(px(s.pos.x), pz(s.pos.z), Math.max(3, rr), 0, 7); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1;
      g.beginPath(); g.arc(px(s.pos.x), pz(s.pos.z), Math.max(3, rr), 0, 7); g.stroke();
    }
    g.fillStyle = '#ffffff';
    for (const p of nadeProjectiles) {
      g.fillRect(px(p.pos.x) - 1.5, pz(p.pos.z) - 1.5, 3, 3);
    }
  } catch (e) {}
  // player arrow (greyed out while spectating)
  const x = px(player.pos.x), y = pz(player.pos.z);
  g.save(); g.translate(x, y); g.rotate(-player.yaw + Math.PI);
  g.fillStyle = player.alive ? '#3dff7a' : 'rgba(140,140,140,0.65)';
  g.beginPath(); g.moveTo(0, -6); g.lineTo(4.5, 5); g.lineTo(-4.5, 5); g.closePath(); g.fill();
  g.restore();
}

