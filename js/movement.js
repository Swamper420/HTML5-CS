// js/movement.js — AGENTS: Local player physics: walk/run/crouch/jump, step-up, wall-run, camera + viewmodel bob/sway, footsteps, per-frame updatePlayer.
// Ownership: updatePlayer, endWallRun, stepAt.

import * as THREE from 'three';
import { Net } from '../net.js';
import { AudioSys } from './audio.js';
import {
  CROUCH_EYE_DROP, CROUCH_HEIGHT, CROUCH_JUMP_LIFT, EYE, STAND_HEIGHT, WALLRUN, WEAPONS, isNadeKey,
} from './config.js';
import { SET, shakeK, swayK } from './settings.js';
import { $, clamp } from './utils.js';
import { damp } from './anim.js';
import {
  ceilingAt, collidesAt, findRunnableWall, moveWithCollision, playerHullHeight, supportHeightAt,
} from './collision.js';
import { playerInPlantSite, playerNearPlantedBomb } from './combat.js';
import { tacticalSmokes } from './grenades.js';
import {
  crossGap, mouseDown, mouseJustDown, rmbDown, rmbJustDown, setCrossGap, setMouseJustDown,
  setRmbDown, setRmbJustDown,
} from './input.js';
import { isOnline } from './multiplayer.js';
import { DUAL, isDualCur, updateWorldWeapons } from './pickups.js';
import { WEED } from './weed.js';
import { camera, coilLight } from './render.js';
import { finishReload, playerTryFire } from './shooting.js';
import { _smokePt, smokePushAt, smokeSlowAt } from './smoke.js';
import { updateSpectate, updateSpectateOverlay } from './spectate.js';
import { G, isFreeze, keys, player } from './state.js';
import {
  VM_AIM, VM_AIM_SOLVED, VM_HIP, buildViewmodel, viewmodel, vmBase, vmBolt, vmCoils, vmL, vmMag, vmRig, vmSpinner, vmStockParts,
} from './viewmodel.js';

let stepAt = 0;
let _helixWindSent = false;
function endWallRun() {
  if (!player.wallRun) return;
  player.wallRun = null;
  player.wallCd = WALLRUN.cooldown;
}
export function updatePlayer(dt, t) {
  if (!player.alive) {
    try { AudioSys.helixWhine(0); } catch {} // never drone while dead
    try { AudioSys.tarzanLoop(false); } catch {}
    try { if (coilLight) coilLight.intensity = 0; } catch {}
    _helixWindSent = false;
    // CS: dead until round ends — spectate a living teammate instead of a
    // static death cam. Auto-advances when the target dies (spectateCurrent).
    const before = player.specTarget;
    try { updateWorldWeapons(dt, t); } catch (e) {} // dropped guns keep falling while you spectate
    updateSpectate(dt);
    if (player.specTarget !== before) updateSpectateOverlay();
    try {
      if (isOnline()) Net.sendState({
        x: player.pos.x, y: player.pos.y, z: player.pos.z,
        yaw: player.yaw, pitch: player.pitch, hp: 0, alive: false,
        weapon: player.cur, aiming: false, moving: false, crouch: false, gnd: true, wr: 0, dual: false,
        reloading: false, helix: 0, nuke: false,
      });
    } catch {}
    return;
  }
  if (viewmodel && viewmodel.userData.spec) buildViewmodel(player.cur); // back from spectating
  const frozen = isFreeze();
  const speedBase = player.cur === 'helix' ? 4.0 : player.cur === 'machete' ? 6.0 : player.cur === 'awp' && player.aiming ? 2.2 : 5.2;
  // Crouch: hold C (or toggle it, per settings). Blocks sprint, cuts speed, and
  // tightens the spread — the CS trade of mobility for accuracy.
  // The hull shrinks while crouched; you can't stand back up under an overhang.
  // Crouching in the air tucks the legs (feet rise) so crouch-jumps clear higher.
  const canAct = player.alive && G.phase === 'playing' && !frozen;
  let wantCrouch = SET.crouchToggle ? !!player.crouchWant : !!keys['KeyC'];
  if (!canAct) { wantCrouch = false; player.crouchWant = false; }
  if (player.wallRun && wantCrouch) { endWallRun(); } // C drops you off the wall
  if (wantCrouch && !player.crouching) {
    player.crouching = true;
    if (!player.onGround) {
      // tuck: lift feet unless something is right above the (now shorter) hull
      const ceil = ceilingAt(player.pos.x, player.pos.z, player.pos.y + CROUCH_HEIGHT, player.radius);
      if (player.pos.y + CROUCH_JUMP_LIFT + CROUCH_HEIGHT <= ceil) {
        player.pos.y += CROUCH_JUMP_LIFT; player.airTuck = true;
        player.crouch = Math.min(1, player.crouch + CROUCH_JUMP_LIFT / CROUCH_EYE_DROP); // keep the eye where it was
      }
    }
  } else if (!wantCrouch && player.crouching) {
    if (player.alive && !player.onGround && player.airTuck) {
      // untuck: legs drop back down if there's room below
      const floor = supportHeightAt(player.pos.x, player.pos.z, player.pos.y, player.radius);
      const drop = Math.min(CROUCH_JUMP_LIFT, Math.max(0, player.pos.y - floor));
      const test = new THREE.Vector3(player.pos.x, player.pos.y - drop, player.pos.z);
      if (!collidesAt(test, player.radius, STAND_HEIGHT)) {
        player.pos.y -= drop; player.crouching = false; player.airTuck = false;
        player.crouch = Math.max(0, player.crouch - drop / CROUCH_EYE_DROP);
      }
    } else if (!player.alive || !collidesAt(player.pos, player.radius, STAND_HEIGHT)) {
      player.crouching = false; player.airTuck = false;
    }
    // else: blocked by a ceiling — stay down until there's headroom
  }
  player.crouch = damp(player.crouch || 0, player.crouching ? 1 : 0, 11, dt);
  const wr = player.wallRun;
  const sprint = !frozen && keys['ShiftLeft'] && !player.aiming && !player.crouching && player.vel.lengthSq() > 0.1;
  const speed = frozen ? 0 : (player.aiming ? speedBase * 0.55 : speedBase) * (sprint ? 1.45 : 1) * (1 - 0.55 * player.crouch) * (isDualCur() ? DUAL.speedMul : 1) * smokeSlowAt(_smokePt.set(player.pos.x, player.pos.y + 1, player.pos.z));
  let ix = 0, iz = 0;
  if (canAct) {
    if (keys['KeyW']) iz -= 1; if (keys['KeyS']) iz += 1;
    if (keys['KeyA']) ix -= 1; if (keys['KeyD']) ix += 1;
  }
  const len = Math.hypot(ix, iz) || 1;
  ix /= len; iz /= len;
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
  const mx = (rx * ix + fx * -iz) * speed;
  const mz = (rz * ix + fz * -iz) * speed;

  const spaceDown = !!keys['Space'] && canAct;
  const spacePressed = spaceDown && !player.spaceWas;
  player.spaceWas = spaceDown;
  player.wallCd = Math.max(0, (player.wallCd || 0) - dt);
  const hull = playerHullHeight();

  if (player.wallRun) {
    const w = player.wallRun;
    w.t += dt;
    // still a wall there? (same face, same side)
    const still = findRunnableWall();
    const sameFace = still && still.nx === w.nx && still.nz === w.nz;
    if (sameFace) { w.box = still.box; w.side = still.side; w.tx = still.tx; w.tz = still.tz; }
    if (spacePressed) {
      // wall jump: kick off away from the wall and up, keep most of the run speed
      const along = player.vel.x * w.tx + player.vel.z * w.tz;
      player.vel.x = w.tx * Math.max(along, 0) * 0.85 + w.nx * WALLRUN.jumpOut;
      player.vel.z = w.tz * Math.max(along, 0) * 0.85 + w.nz * WALLRUN.jumpOut;
      player.vel.y = WALLRUN.jumpUp;
      endWallRun();
      AudioSys.step(null, true);
    } else if (!sameFace || w.t > WALLRUN.maxTime || !keys['KeyW'] || !canAct) {
      player.lastWallBox = w.box;
      endWallRun();
    } else {
      // glide along the tangent, hug the wall, sink slowly
      const k = Math.min(1, 8 * dt);
      const tgt = WALLRUN.speed * (sprint || keys['ShiftLeft'] ? 1.08 : 1);
      player.vel.x += (w.tx * tgt - w.nx * 0.6 - player.vel.x) * k;
      player.vel.z += (w.tz * tgt - w.nz * 0.6 - player.vel.z) * k;
      player.vel.y = Math.max(WALLRUN.maxSink, player.vel.y - WALLRUN.gravity * dt * (0.4 + w.t / WALLRUN.maxTime * 1.6));
      // wall steps
      if (t > stepAt) { stepAt = t + 0.24; AudioSys.step(null, true); }
    }
  } else {
    const accel = player.onGround ? 14 : 3;
    player.vel.x += (mx - player.vel.x) * Math.min(1, accel * dt);
    player.vel.z += (mz - player.vel.z) * Math.min(1, accel * dt);
    // gravity / jump (blocked while frozen — CS freeze time)
    if (player.onGround && spaceDown) { player.vel.y = 5.2; player.onGround = false; try { AudioSys.jump(); } catch (e) {} }
    // latch onto a wall: airborne, holding W, moving fast enough, not crouched
    if (!player.onGround && canAct && keys['KeyW'] && !player.crouching && player.wallCd <= 0) {
      const floorY = supportHeightAt(player.pos.x, player.pos.z, player.pos.y, player.radius);
      const hSp = Math.hypot(player.vel.x, player.vel.z);
      if (player.pos.y - floorY > WALLRUN.minAirY && hSp >= WALLRUN.minSpeed) {
        const w = findRunnableWall();
        if (w && w.along > -0.5 && w.box !== player.lastWallBox) {
          player.wallRun = { t: 0, nx: w.nx, nz: w.nz, tx: w.tx, tz: w.tz, side: w.side, box: w.box };
          player.vel.y = Math.max(player.vel.y * 0.5, 2.2); // small hop up as you plant a foot
          AudioSys.step(null, true);
        }
      }
    }
  }
  if (!player.wallRun) player.vel.y -= 13.5 * dt;
  const fallV = player.vel.y;
  const preX = player.pos.x, preZ = player.pos.z;
  moveWithCollision(player.pos, player.vel.x * dt, player.vel.z * dt, player.radius, hull);
  // wall-smack detector for the live-nuke carry: full intent, ~no travel = ran face-first into a wall
  try {
    const hSp0 = Math.hypot(player.vel.x, player.vel.z), wantD0 = hSp0 * dt;
    player._moveBlocked = wantD0 > 0.04 && hSp0 > 2.5 && Math.hypot(player.pos.x - preX, player.pos.z - preZ) < wantD0 * 0.2;
  } catch (e) { player._moveBlocked = false; }
  if (tacticalSmokes.length && (player.vel.x || player.vel.z)) smokePushAt(_smokePt.set(player.pos.x, player.pos.y + 1, player.pos.z), player.vel.x * dt * 8, player.vel.z * dt * 8, 1);
  if (player.wallRun && dt > 0) {
    // ran into something ahead (corner, pillar): stall counter, drop off after a beat
    const w = player.wallRun;
    const moved = ((player.pos.x - preX) * w.tx + (player.pos.z - preZ) * w.tz) / dt;
    w.stall = moved < 1.2 ? (w.stall || 0) + dt : 0;
    if (w.stall > 0.1) { player.lastWallBox = w.box; endWallRun(); }
  }
  // vertical: land on the ground or on top of boxes, bump heads on overhangs
  const prevY = player.pos.y;
  player.pos.y += player.vel.y * dt;
  if (player.vel.y > 0) {
    const ceil = ceilingAt(player.pos.x, player.pos.z, prevY + hull - 0.02, player.radius);
    if (player.pos.y + hull > ceil) { player.pos.y = Math.max(prevY, ceil - hull); player.vel.y = 0; }
  }
  const floorY = supportHeightAt(player.pos.x, player.pos.z, prevY, player.radius);
  if (player.pos.y <= floorY) {
    // landing thud scales with fall speed
    if (!player.onGround && fallV < -3.5 && player.alive) {
      AudioSys.land(fallV < -7);
      vmRig.landK = clamp(-fallV / 9, 0, 1);
    }
    if (player.airTuck) {
      // landed tucked: stay crouched (stand up next frame if C is released and there's room)
      player.airTuck = false;
    }
    player.pos.y = floorY; player.vel.y = Math.max(0, player.vel.y); player.onGround = true;
    player.lastWallBox = null; // touching down refreshes every wall
    if (player.wallRun) endWallRun();
  } else {
    player.onGround = false;
  }
  player.wallRoll = damp(player.wallRoll || 0, player.wallRun ? player.wallRun.side * WALLRUN.camRoll : 0, 10, dt);

  // footsteps (own boots, L/R alternating + sprint weight) — crouch-walking is silent
  const hSpeed = Math.hypot(player.vel.x, player.vel.z);
  if (player.onGround && hSpeed > 2 && t > stepAt && player.crouch < 0.5) { stepAt = t + (sprint ? 0.3 : 0.42); AudioSys.step(null, sprint); }
  // machete sprint: seamless Tarzan yell loop; relayed via snapshot `yell` so remotes match exactly
  player._yelling = player.cur === 'machete' && sprint && hSpeed > 3 && player.alive && G.phase === 'playing' && !isFreeze();
  try { AudioSys.tarzanLoop(player._yelling); } catch {}
  void wr;

  const def = WEAPONS[player.cur] || { bloomDecay: 0.05, auto: false, zoomFov: 75 };
  const isNade = isNadeKey(player.cur);
  // --- bloom cool-down + punch / shake / sway recovery ---
  const coolMul = player.aiming ? 1.6 : 1;
  if (!isNade) player.bloom = Math.max(0, player.bloom - def.bloomDecay * coolMul * dt);
  if (t - player.lastShotT > 0.5) player.sprayIdx = Math.max(0, player.sprayIdx - dt * 6);
  const rec = Math.min(1, dt * 9);
  vmRig.punchP += (0 - vmRig.punchP) * Math.min(1, dt * 11);
  vmRig.punchY += (0 - vmRig.punchY) * rec;
  vmRig.shake += (0 - vmRig.shake) * Math.min(1, dt * 8);
  vmRig.fovKick += (0 - vmRig.fovKick) * Math.min(1, dt * 9);
  vmRig.swayX += (0 - vmRig.swayX) * Math.min(1, dt * 7);
  vmRig.swayY += (0 - vmRig.swayY) * Math.min(1, dt * 7);

  // --- camera with punch + shake + strafe lean + breathing ---
  const bob = hSpeed > 0.5 && (player.onGround || player.wallRun) ? Math.sin(t * (sprint ? 12 : 9)) * 0.035 * swayK() * (player.aiming ? 0.35 : 1) : 0;
  const breathe = player.aiming && player.onGround && hSpeed < 0.5 ? Math.sin(t * 1.9) * 0.0022 : 0;
  camera.position.set(player.pos.x, player.pos.y + EYE - CROUCH_EYE_DROP * (player.crouch || 0) + bob, player.pos.z);
  camera.rotation.order = 'YXZ';
  const shk = vmRig.shake * shakeK();
  const shX = shk > 0.0005 ? (Math.random() - 0.5) * shk * 2 : 0;
  const shY = shk > 0.0005 ? (Math.random() - 0.5) * shk * 2 : 0;
  camera.rotation.y = player.yaw + vmRig.punchY + shY;
  camera.rotation.x = player.pitch + vmRig.punchP + shX + breathe;
  vmRig.roll += (0 - vmRig.roll) * Math.min(1, dt * 7);
  camera.rotation.z = clamp(-ix * 0.012, -0.02, 0.02) + (player.wallRoll || 0) + vmRig.roll + (shk > 0.0005 ? (Math.random() - 0.5) * shk : 0);

  // reload progress
  if (player.reloading > 0) {
    player.reloading -= dt;
    if (player.reloading <= 0) finishReload();
  }
  // firing (also catch fast semi-auto clicks that release within one frame; blocked in freeze)
  // nades throw via mousedown/mouseup prime-release — never via the hitscan path
  // HELIX spin-up needs a fresh trigger hold: releasing resets the wind.
  if (player.cur === 'helix' && !mouseDown) { player._helixSpin = 0; }
  if (!isNade && (mouseDown || mouseJustDown) && player.alive && G.phase === 'playing' && !G.buyOpen && !isFreeze()) {
    if (def.auto) playerTryFire(t);
    else if (mouseJustDown) { playerTryFire(t); }
  }
  const dualNow = !isNade && isDualCur();
  if (dualNow && (rmbDown || rmbJustDown) && player.alive && G.phase === 'playing' && !G.buyOpen && !isFreeze()) {
    if (def.auto) playerTryFire(t, 'L');
    else if (rmbJustDown) playerTryFire(t, 'L');
  }
  if (!dualNow) setRmbDown(false);
  setRmbJustDown(false);
  if (isNade) setMouseJustDown(false);
  else setMouseJustDown(false);
  if (dualNow && player.alive && !isFreeze()) {
    // wandering aim: two heavy guns never sit still, worse on the move and when hot
    player.aiming = false;
    const unsteady = 1 + clamp(Math.hypot(player.vel.x, player.vel.z) / 4, 0, 1.2) + player.bloom * 20;
    player.yaw += (Math.sin(t * 1.7) + Math.sin(t * 2.9 + 1.3) * 0.6) * DUAL.driftYaw * unsteady * dt;
    player.pitch = clamp(player.pitch + (Math.sin(t * 2.3 + 0.5) + Math.sin(t * 3.7) * 0.5) * DUAL.driftPitch * unsteady * dt, -1.45, 1.45);
  }
  try { updateWorldWeapons(dt, t); } catch (e) { console.warn('world weapons', e); }

  // --- ADS blend + viewmodel motion (bob / sway / draw / reload) ---
  const isBlade = player.cur === 'machete';
  const wantAim = (!isBlade && player.aiming && player.alive && player.reloading <= 0) ? 1 : 0;
  // slash clock: one diagonal sweep per trigger pull, alternating sides
  if (isBlade && vmRig.swingT < 1) vmRig.swingT = Math.min(1, vmRig.swingT + dt / 0.45);
  vmRig.aimK += (wantAim - vmRig.aimK) * Math.min(1, dt * 13);
  const aimE = vmRig.aimK * vmRig.aimK * (3 - 2 * vmRig.aimK); // smoothstep
  // stock/butt sit under the cheek in ADS — hide them so they don't fill the bottom of the screen
  if (vmStockParts.length) { const vis = aimE < 0.55; if (vmStockParts[0].visible !== vis) for (const s of vmStockParts) s.visible = vis; }
  if (vmBase) {
    vmRig.bobT += dt * (2 + hSpeed * 1.55);
    vmRig.drawT = Math.min(1, vmRig.drawT + dt / 0.32);
    const solved = VM_AIM_SOLVED[player.cur];
    const hip = VM_HIP, aimP = (solved && solved.pos) || VM_AIM[player.cur] || VM_AIM.ak;
    const drawK = 1 - vmRig.drawT;
    const bobAmp = 0.009 * (1 - aimE * 0.94) * swayK();
    const bobX = Math.cos(vmRig.bobT * 0.5) * bobAmp * clamp(hSpeed / 5, 0, 1);
    const bobY = Math.abs(Math.sin(vmRig.bobT)) * bobAmp * 1.2 * clamp(hSpeed / 5, 0, 1) + Math.sin(t * 1.7) * 0.0018;
    let px = hip.x + (aimP.x - hip.x) * aimE + bobX + vmRig.swayX * (1 - aimE * 0.9);
    let py = hip.y + (aimP.y - hip.y) * aimE + bobY + vmRig.swayY * (1 - aimE * 0.9);
    let pz = hip.z + (aimP.z - hip.z) * aimE;
    // draw rise
    py -= drawK * 0.22;
    pz += drawK * 0.08;
    let rx = drawK * 0.55 + vmRig.swayY * 2.2 * (1 - aimE * 0.88);
    let ry = vmRig.swayX * 2.6 * (1 - aimE * 0.88);
    let rz = 0;
    // the solved tilt that levels the sight line, faded in with the ADS blend
    if (solved) { rx += solved.pitch * aimE; ry += solved.yaw * aimE; }
    if (isBlade) {
      // held like a blade, not a gun: low-right grip, tip UP and angled across
      // the screen so the full length reads (a forward-pointing blade foreshortens
      // to a nub and every swing looks like a stab).
      px += 0.05; py -= 0.05; pz += 0.06;
      rx += 0.32; ry -= 0.35; rz -= 0.45;
      if (vmRig.swingT < 1) {
        // lateral slash across the screen, alternating sides — never a downward stab
        const sk = vmRig.swingT, f = vmRig.swingFlip || 1;
        const sw = Math.sin(sk * Math.PI); // 0 → 1 → 0 across one swing
        px += f * 0.28 * sw;
        py += -0.06 * sw;
        ry += f * 1.05 * sw;
        rz += f * -0.85 * sw;
        rx += 0.12 * sw;
      }
    }
    // Reload, staged the way hands actually work it: cant the weapon inboard, drop
    // the empty, bring the fresh mag up and slap it home, run the charging handle,
    // settle. One sine dip (what this was) reads as a shrug.
    if (player.reloading > 0) {
      const rk = clamp(1 - player.reloading / player.reloadDur, 0, 1);
      const seg = (a, b) => clamp((rk - a) / (b - a), 0, 1);
      const bell = (a, b) => Math.sin(seg(a, b) * Math.PI);
      const tilt = seg(0, 0.18) - seg(0.86, 1);
      py -= tilt * 0.10;
      pz += tilt * 0.03;
      rx -= tilt * 0.62;
      rz += tilt * 0.34;
      ry += tilt * 0.22;
      rx += bell(0.44, 0.62) * 0.17 + bell(0.70, 0.86) * 0.10; // mag slap, then the bolt
      if (vmMag) {
        const drop = Math.max(0, seg(0.18, 0.44) - seg(0.52, 0.70));
        if (vmMag.userData.top) { vmMag.position.y = drop * 0.16; vmMag.position.z = drop * 0.12; vmMag.rotation.x = -drop * 0.35; }
        else { vmMag.position.y = -drop * 0.42; vmMag.position.z = drop * 0.10; vmMag.rotation.x = drop * 0.9; }
      }
      if (vmBolt && rk > 0.70 && rk < 0.90) vmBolt.position.z = 0.09 * bell(0.70, 0.90);
    } else if (vmMag && (vmMag.position.y !== 0 || vmMag.rotation.x !== 0)) {
      vmMag.position.set(0, 0, 0); vmMag.rotation.x = 0;
    }
    // landing absorb: the gun keeps travelling down for a beat after the boots stop
    vmRig.landK = Math.max(0, (vmRig.landK || 0) - dt * 3.4);
    py -= vmRig.landK * 0.085;
    rx += vmRig.landK * 0.22;
    // hands on the bomb: weapon swings down out of the way
    const busyHands = (keys['KeyE'] && (playerNearPlantedBomb() || playerInPlantSite())) ? 1 : 0;
    vmRig.busyK = damp(vmRig.busyK || 0, busyHands, 9, dt);
    py -= vmRig.busyK * 0.30;
    pz += vmRig.busyK * 0.05;
    rx -= vmRig.busyK * 1.05;
    rz += vmRig.busyK * 0.25;
    // sprint lowers gun
    if (sprint && hSpeed > 3) { py -= 0.03; rx -= 0.35; ry += 0.15; }
    // wall run: gun shifts away from the wall and cants level, steps up the bob
    if (player.wallRun) {
      const ws = player.wallRun.side;
      px -= ws * 0.045 * (1 - aimE * 0.5);
      py += 0.012;
      rz -= ws * WALLRUN.camRoll * 0.85;
      ry += ws * 0.10;
    }
    if (vmL) {
      // two guns: spread them apart, each wobbling on its own
      const wob = Math.sin(t * 2.3) * 0.006, wob2 = Math.cos(t * 1.9) * 0.006;
      vmL.base.position.set(-px - 0.03 + wob2, py + wob, pz);
      vmL.base.rotation.set(rx + wob * 2, -ry + 0.06, -rz);
      px += 0.03; py += wob2; ry -= 0.06;
    }
    vmBase.position.set(px, py, pz);
    vmBase.rotation.set(rx, ry, rz);
    // HELIX rotor: real spool inertia — winds up toward full scream while held,
    // coasts back down on release, churns slow while the cell recharges.
    // Coils pulse with rotor energy (idle breathing -> strobing chase at full spin).
    try {
      const isH = player.cur === 'helix';
      const hw = isH && player.weapons.helix;
      const holding = isH && mouseDown && player._helixSpin && player.reloading <= 0 && hw && hw.mag > 0 && player.alive;
      // Broadcast wind-up once per trigger hold so remotes hear the spool-up.
      try {
        const winding = isH && mouseDown && player.reloading <= 0 && hw && hw.mag > 0 && player.alive && G.phase === 'playing';
        if (winding && !_helixWindSent) {
          _helixWindSent = true;
          if (isOnline()) Net.sendHelix({ action: 'windup', x: player.pos.x, y: player.pos.y + 1.4, z: player.pos.z });
        } else if (!winding) _helixWindSent = false;
      } catch {}
      const tgt = !isH ? 0 : player.reloading > 0 ? 6 : holding ? 48 : 2;
      const kk = tgt > vmRig.helixRate ? 2.6 : 1.4; // spool up quick, coast down slow
      vmRig.helixRate += (tgt - vmRig.helixRate) * Math.min(1, dt * kk);
      if (Math.abs(vmRig.helixRate) < 0.01) vmRig.helixRate = 0;
      if (vmSpinner && isH) vmSpinner.rotation.z += vmRig.helixRate * dt;
      const e = clamp(vmRig.helixRate / 48, 0, 1);
      try { AudioSys.helixWhine(isH ? e : 0); } catch {}
      if (vmCoils && isH) {
        // HAM: idle breathing -> screaming white-hot strobing chase at full spin.
        // MeshBasicMaterial colors above 1 blow through tone mapping into pure glare.
        for (const c of vmCoils) {
          const breathe = 0.7 + 0.3 * Math.sin(t * 3.1 + c.ph);
          const strobe = 0.5 + 0.5 * Math.sin(t * (14 + e * 60) + c.ph * 2);
          const heat = breathe * (1 - e) + (1.2 + 7.5 * strobe) * e;
          c.m.color.copy(c.base).multiplyScalar(heat);
        }
      }
      // Dynamic light wash all around the charging player, flickering with the strobe.
      try {
        if (coilLight) {
          if (isH && e > 0.01) {
            coilLight.position.set(player.pos.x, player.pos.y + 1.4, player.pos.z);
            coilLight.intensity = e * 30 * (0.88 + 0.12 * Math.sin(t * 43));
          } else coilLight.intensity = 0;
        }
      } catch {}
    } catch {}
  }

  // aim / FOV (with punch kick that springs back)
  const targetFov = (!isNade && player.aiming ? def.zoomFov : SET.fov) + vmRig.fovKick;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 14);
  camera.updateProjectionMatrix();
  const scoped = player.aiming && player.cur === 'awp' && !isNade;
  $('scope-overlay').classList.toggle('hidden', !scoped);
  // nades show a dot crosshair (no spread) + flash whites it out via overlay
  // A crosshair painted over the iron sights hides the very thing you are aiming
  // with, and the two disagree anyway. Fade it out with the ADS blend; grenades
  // have no sights, so they keep theirs.
  const adsHide = isNade ? 0 : aimE;
  $('crosshair').style.opacity = (scoped || !player.alive) ? 0 : (1 - adsHide).toFixed(3);
  if (viewmodel) viewmodel.visible = !scoped && player.alive;
  // crosshair reflects heat + motion (bloom-driven); nades stay tight
  const wantGap = isNade ? 8 : 6 + player.bloom * 620 + hSpeed * 1.3 + (player.onGround ? 0 : player.wallRun ? 4 : 9) + (player.aiming ? -2 : 0) - (player.crouch || 0) * 2 + (isDualCur() ? 16 : 0);
  setCrossGap(crossGap + ((clamp(wantGap, 5, 46) - crossGap) * Math.min(1, dt * 10)));
  // hide spread UI glitch: hide crosshair lines while reloading draw? keep visible
  // --- multiplayer snapshot out (~20Hz) ---
  try {
    if (isOnline()) Net.sendState({
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      yaw: player.yaw, pitch: player.pitch, hp: Math.max(0, Math.round(player.hp)),
      alive: player.alive, weapon: player.cur, aiming: !!player.aiming, moving: hSpeed > 0.8,
      crouch: !!player.crouching, gnd: !!player.onGround, dual: isDualCur(),
      wr: player.wallRun ? player.wallRun.side : 0,
      planting: !!(player.alive && keys['KeyE'] && playerInPlantSite()),
      defusing: !!(player.alive && keys['KeyE'] && playerNearPlantedBomb()),
      harvesting: !!WEED.harvesting,
      // sound state: reload + coil energy so remotes hear wind-up/recharge in time
      reloading: player.reloading > 0,
      helix: player.cur === 'helix' ? Math.round(clamp(vmRig.helixRate / 48, 0, 1) * 100) / 100 : 0,
      nuke: !!player.carryingNuke, // live-bomb carry prop for remotes
      yell: !!player._yelling, // machete-sprint Tarzan loop for remotes
    });
  } catch {}
}

