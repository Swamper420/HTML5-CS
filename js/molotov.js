// js/molotov.js — AGENTS: Molotov/incendiary fire zones: ignite, spread/support, burn damage, flame visuals.
// Ownership: igniteMolotov, fireZoneContains, inFire, updateFires.

import * as THREE from 'three';
import { AudioSys } from './audio.js';
import { MAP_HALF, NADE_DEFS } from './config.js';
import { opts } from './settings.js';
import { $, clamp, rand } from './utils.js';
import { botChest } from './bots.js';
import { collidesAt, hasLOS } from './collision.js';
import { damageBot, damagePlayer } from './combat.js';
import { decalTextures, spawnBurst, spawnDecal, spawnFireball, spawnSmoke } from './effects.js';
import { fireZones, nadeOwnerTeam, tacticalSmokes } from './grenades.js';
import { playerHitmark } from './hud.js';
import { colliders } from './map.js';
import { remotes } from './multiplayer.js';
import { scene } from './render.js';
import { smokeVolumeRadius } from './smoke.js';
import { G, bots, player } from './state.js';

// ---- Molotov: shatter -> persistent fire zone with DPS + visuals ----
export function igniteMolotov(at, owner, t) {
  const def = NADE_DEFS.molotov;
  try { AudioSys.molotovIgnite(at); } catch (e) {}
  const center = at.clone(); center.y = Math.max(0, at.y);
  // landed in a smoke → fizzles
  try {
    const tt = performance.now() / 1000;
    if (tacticalSmokes.some((s) => Math.hypot(s.pos.x - at.x, s.pos.z - at.z) < smokeVolumeRadius(s, tt) && Math.abs(s.pos.y - 1.1 - at.y) < 2.5)) {
      try { spawnSmoke(at.clone().add(new THREE.Vector3(0, 0.5, 0)), 1.0, 1.0, 0x9a9a9a); } catch (e) {}
      return;
    }
  } catch (e) {}
  center.x = clamp(center.x, -MAP_HALF + 0.5, MAP_HALF - 0.5);
  center.z = clamp(center.z, -MAP_HALF + 0.5, MAP_HALF - 0.5);
  if (fireZones.length >= 6) {
    const old = fireZones.shift();
    try { for (const fl of old.flames) scene.remove(fl); if (old.light) scene.remove(old.light); } catch (e) {}
  }
  const zone = {
    pos: center, radius: def.radius, until: t + def.duration,
    owner: { isPlayer: !!owner.isPlayer, team: nadeOwnerTeam(owner), bot: owner.bot || null, remoteName: owner.remoteName || null, remoteId: owner.remoteId ?? null, weaponName: 'MOLOTOV' },
    flames: [], light: null, tickAt: 0, burnSfxAt: 0, born: t,
    cells: [], parts: [], embers: [], glow: null, emitAcc: 0,
  };
  try {
    // --- fire only spreads over real surface, never through walls or off crate edges into the air
    const probeFrom = new THREE.Vector3(center.x, center.y + 0.35, center.z);
    const want = opts.quality ? 20 : 12;
    zone.cells.push({ x: center.x, z: center.z, igniteAt: t });
    for (let tries = 0; tries < 90 && zone.cells.length < want; tries++) {
      const a = rand(0, Math.PI * 2), rr = Math.sqrt(Math.random()) * def.radius;
      const x = center.x + Math.cos(a) * rr, z = center.z + Math.sin(a) * rr;
      if (zone.cells.some((c) => Math.hypot(c.x - x, c.z - z) < 0.55)) continue;
      if (!fireSupportAt(x, center.y, z)) continue;
      if (!hasLOS(probeFrom, new THREE.Vector3(x, center.y + 0.35, z))) continue;
      zone.cells.push({ x, z, igniteAt: t + (rr / def.radius) * 0.5 }); // spreads outward like spilled fuel
    }
    // --- flame particles (pooled billboards, additive)
    const ftex = flameTexture(), T = decalTextures();
    const nFl = opts.quality ? 90 : 40;
    for (let i = 0; i < nFl; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: ftex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      sp.visible = false; scene.add(sp); zone.flames.push(sp);
      zone.parts.push({ sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0, w: 1, h: 1, ph: 0 });
    }
    const nEm = opts.quality ? 18 : 8;
    for (let i = 0; i < nEm; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glow, color: 0xffa040, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      sp.visible = false; scene.add(sp); zone.flames.push(sp);
      zone.embers.push({ sp, life: 0, max: 1, vx: 0, vy: 0, vz: 0, ph: 0 });
    }
    // --- warm light pooled on the ground under the flames
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: T.glow, color: 0xff5a14, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2; glow.position.set(center.x, center.y + 0.07, center.z);
    glow.scale.setScalar(def.radius * 2.8);
    scene.add(glow); zone.flames.push(glow); zone.glow = glow;

    zone.light = new THREE.PointLight(0xff7a1e, 5, 14, 1.6);
    zone.light.position.set(center.x, center.y + 1.0, center.z);
    scene.add(zone.light);
    spawnDecal('scorch', new THREE.Vector3(center.x, center.y + 0.055, center.z), new THREE.Vector3(0, 1, 0), 4.6, 0.85);
    // shatter: glass + fuel splash + whoosh fireball
    spawnFireball(center.clone().add(new THREE.Vector3(0, 0.5, 0)), 2.0, 0.3);
    spawnBurst(center.clone().add(new THREE.Vector3(0, 0.2, 0)), 0x8fb07a, 12, 4, 0.5, 0.05);
    spawnBurst(center.clone().add(new THREE.Vector3(0, 0.3, 0)), 0xffa040, 22, 6, 0.6, 0.1);
  } catch (e) {}
  fireZones.push(zone);
}
function fireSupportAt(x, y, z) {
  if (Math.abs(x) > MAP_HALF - 0.3 || Math.abs(z) > MAP_HALF - 0.3) return false;
  if (collidesAt(new THREE.Vector3(x, y + 0.08, z), 0.15, 0.6)) return false; // inside a wall/crate
  if (y < 0.06) return true; // map floor
  for (const b of colliders) {
    if (Math.abs(b.max.y - y) < 0.2 && x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) return true;
  }
  return false;
}
let _flameTex = null;
function flameTexture() {
  if (_flameTex) return _flameTex;
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 92, 2, 32, 84, 58);
  gr.addColorStop(0, 'rgba(255,255,235,1)');
  gr.addColorStop(0.22, 'rgba(255,225,130,0.95)');
  gr.addColorStop(0.5, 'rgba(255,140,40,0.6)');
  gr.addColorStop(1, 'rgba(200,50,10,0)');
  g.filter = 'blur(4px)';
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(32, 6);
  g.bezierCurveTo(44, 40, 60, 70, 56, 98);
  g.bezierCurveTo(52, 122, 12, 122, 8, 98);
  g.bezierCurveTo(4, 70, 20, 40, 32, 6);
  g.fill();
  _flameTex = new THREE.CanvasTexture(c);
  return _flameTex;
}
function fireZoneContains(z, pos, pad = 0.2) {
  if (pos.y < z.pos.y - 0.4 || pos.y > z.pos.y + 1.6) return false;
  const t = performance.now() / 1000;
  for (const c of z.cells) if (t >= c.igniteAt && Math.hypot(pos.x - c.x, pos.z - c.z) < 0.7 + pad) return true;
  return false;
}
export function inFire(pos, pad = 0.4) {
  for (const z of fireZones) if (fireZoneContains(z, pos, pad)) return z;
  return null;
}
const _fireCol = new THREE.Color();
export function updateFires(dt, t) {
  for (let i = fireZones.length - 1; i >= 0; i--) {
    const z = fireZones[i];
    const left = z.until - t;
    if (left <= 0) {
      try { for (const fl of z.flames) scene.remove(fl); if (z.light) scene.remove(z.light); } catch (e) {}
      fireZones.splice(i, 1);
      continue;
    }
    // animate: pooled flame tongues rising off lit cells, embers, ground glow, flicker light
    try {
      const age = t - z.born;
      const intensity = clamp(left / 1.6, 0, 1) * clamp(age / 0.25, 0.3, 1);
      const lit = z.cells.filter((c) => t >= c.igniteAt);
      // emission
      z.emitAcc += dt * lit.length * 10 * intensity;
      let spawnN = Math.floor(z.emitAcc); z.emitAcc -= spawnN;
      for (const p of z.parts) {
        if (spawnN <= 0 || !lit.length) break;
        if (p.life > 0) continue;
        const c = lit[(Math.random() * lit.length) | 0];
        p.max = rand(0.45, 0.85); p.life = p.max;
        p.sp.position.set(c.x + rand(-0.32, 0.32), z.pos.y + 0.05, c.z + rand(-0.32, 0.32));
        p.vx = rand(-0.15, 0.15); p.vz = rand(-0.15, 0.15); p.vy = rand(1.1, 1.9);
        p.w = rand(0.55, 0.95) * (0.6 + 0.4 * intensity); p.h = p.w * rand(1.6, 2.3); p.ph = rand(0, 6.28);
        p.sp.material.rotation = rand(-0.2, 0.2);
        p.sp.visible = true; spawnN--;
      }
      for (const p of z.parts) {
        if (p.life <= 0) continue;
        p.life -= dt;
        if (p.life <= 0) { p.sp.visible = false; p.sp.material.opacity = 0; continue; }
        const k = 1 - p.life / p.max; // 0 → 1 over the tongue's life
        p.sp.position.x += (p.vx + Math.sin(t * 9 + p.ph) * 0.25) * dt;
        p.sp.position.z += (p.vz + Math.cos(t * 8 + p.ph) * 0.25) * dt;
        p.sp.position.y += p.vy * dt;
        p.vy *= (1 - dt * 0.6);
        const grow = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) * 0.85;
        p.sp.scale.set(p.w * grow * (1 - k * 0.3), p.h * grow, 1);
        // white-yellow core → orange → deep red as it cools
        if (k < 0.35) _fireCol.setRGB(1, 0.95 - k * 1.2, 0.7 - k * 1.8);
        else _fireCol.setRGB(1 - (k - 0.35) * 0.6, 0.53 - (k - 0.35) * 0.65, 0.07);
        p.sp.material.color.copy(_fireCol);
        p.sp.material.opacity = Math.pow(1 - k, 0.8) * 0.95;
      }
      // embers
      for (const e of z.embers) {
        if (e.life <= 0) {
          if (lit.length && Math.random() < dt * 3 * intensity) {
            const c = lit[(Math.random() * lit.length) | 0];
            e.max = rand(0.8, 1.6); e.life = e.max;
            e.sp.position.set(c.x + rand(-0.3, 0.3), z.pos.y + 0.3, c.z + rand(-0.3, 0.3));
            e.vx = rand(-0.5, 0.5); e.vz = rand(-0.5, 0.5); e.vy = rand(1.8, 3.2); e.ph = rand(0, 6.28);
            e.sp.scale.setScalar(rand(0.04, 0.08)); e.sp.visible = true;
          }
          continue;
        }
        e.life -= dt;
        if (e.life <= 0) { e.sp.visible = false; continue; }
        e.sp.position.x += (e.vx + Math.sin(t * 5 + e.ph) * 0.4) * dt;
        e.sp.position.z += (e.vz + Math.cos(t * 4 + e.ph) * 0.4) * dt;
        e.sp.position.y += e.vy * dt; e.vy *= (1 - dt * 0.8);
        e.sp.material.opacity = (e.life / e.max) * (Math.sin(t * 40 + e.ph) > -0.3 ? 1 : 0.3);
      }
      if (z.glow) {
        const spread = clamp(age / 0.5, 0.3, 1);
        z.glow.scale.setScalar(z.radius * 2.8 * spread);
        z.glow.material.opacity = (0.35 + Math.sin(t * 19) * 0.06 + Math.random() * 0.05) * intensity;
      }
      if (z.light) z.light.intensity = (5 + Math.sin(t * 23) * 1.4 + Math.sin(t * 37) * 0.8 + Math.random() * 0.6) * intensity;
      if (Math.random() < dt * 5 * intensity) {
        const c = lit.length ? lit[(Math.random() * lit.length) | 0] : z.pos;
        spawnSmoke(new THREE.Vector3(c.x + rand(-0.3, 0.3), z.pos.y + 1.6, c.z + rand(-0.3, 0.3)), rand(0.7, 1.1), rand(1.2, 2.0), 0x262422);
      }
      if (t - z.burnSfxAt > 0.4) { z.burnSfxAt = t; AudioSys.fireLoopTick(new THREE.Vector3(z.pos.x, z.pos.y + 0.8, z.pos.z)); }
    } catch (e) {}
    // damage tick (4Hz): victim-authoritative for player + bots we own
    if (t >= z.tickAt) {
      z.tickAt = t + 0.25;
      const tickDmg = (NADE_DEFS.molotov.dps || 52) * 0.25;
      for (const b of bots) {
        if (!b.alive) continue;
        if (b.team === z.owner.team && !(z.owner.bot === b)) continue; // no friendly fire (owner still burns)
        const inside = fireZoneContains(z, b.pos, 0.1);
        if (!inside) continue;
        const shooter = z.owner.isPlayer
          ? { team: z.owner.team, isPlayer: true, weaponName: 'MOLOTOV' }
          : { team: z.owner.team, isPlayer: false, bot: z.owner.bot, weaponName: 'MOLOTOV' };
        damageBot(b, tickDmg * rand(0.9, 1.1), shooter, false, botChest(b));
      }
      if (player.alive && G.phase === 'playing') {
        const insideP = fireZoneContains(z, player.pos, 0.15);
        if (insideP) {
          const sameTeam = (player.team || 'ct') === z.owner.team && !z.owner.isPlayer;
          if (!sameTeam) {
            const shooter = z.owner.isPlayer
              ? { team: z.owner.team, isPlayer: true, weaponName: 'MOLOTOV' }
              : { team: z.owner.team, isPlayer: false, bot: z.owner.bot, remoteName: z.owner.remoteName, remote: null, weaponName: 'MOLOTOV' };
            try { if (z.owner.remoteId != null && remotes.has(z.owner.remoteId)) shooter.remote = remotes.get(z.owner.remoteId); } catch (e) {}
            player.burnT = t;
            damagePlayer(tickDmg * rand(0.9, 1.1), shooter, false);
            try {
              const el = $('burn-overlay');
              if (el) el.style.opacity = 0.85;
            } catch (e) {}
          }
        }
      }
      // attacker hitmarker prediction for remotes standing in our fire (visual only)
      try {
        if (z.owner.isPlayer) {
          for (const [, e] of remotes) {
            if (!e.data || !e.data.alive) continue;
            if ((e.data.team || 't') === (player.team || 'ct')) continue;
            if (fireZoneContains(z, e.pos, 0.2)) { playerHitmark(false, false); break; }
          }
        }
      } catch (e) {}
    }
  }
  // burn overlay decay for the local player
  try {
    const el = $('burn-overlay');
    if (el) {
      const sinceBurn = t - (player.burnT || -9);
      el.style.opacity = sinceBurn < 0.4 ? 0.85 : Math.max(0, 0.85 - (sinceBurn - 0.4) * 2.2).toFixed(3);
    }
  } catch (e) {}
}

