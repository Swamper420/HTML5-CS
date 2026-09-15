// js/anim.js — AGENTS: Procedural character animation: locomotion gait, aim layer, recoil/flinch impulses, wall-run pose.
// Ownership: newAnimState, animateSoldier, soldierFireKick, soldierFlinch.

import { clamp } from './utils.js';

// Layered, the way a real animation graph is: a locomotion base (a two-segment
// gait driven by one phase clock), an aim layer that bends spine/neck/weapon
// toward where the soldier is looking, and additive impulses (recoil, flinch,
// landing, breathing) stacked on top. Everything is written in radians about
// real joints, so the poses stay anatomical instead of shearing boxes around.
export const TAU = Math.PI * 2;
// frame-rate-independent smoothing: k = how much of the way to `to` per second
export const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));

function newAnimState() {
  return {
    phase: Math.random() * TAU,   // gait clock
    spd: 0, fwd: 0, side: 0,      // smoothed body-space motion
    pitch: 0, crouch: 0, kneel: 0,
    fire: 0, flinch: 0, reload: 0,
    land: 0, air: 0, wall: 0,
    breathe: Math.random() * TAU,
    yawPrev: null, turn: 0,
    step: -1,                     // which foot last struck, for footstep hooks
  };
}
// One-shot impulses the game fires at the rig.
export function soldierFireKick(mesh, amt = 1) {
  const a = mesh && mesh.userData && mesh.userData.anim; if (a) a.fire = Math.min(1.4, a.fire + amt);
}
export function soldierFlinch(mesh, amt = 1) {
  const a = mesh && mesh.userData && mesh.userData.anim; if (a) a.flinch = Math.min(1, a.flinch + amt);
}

// inp: { vx, vz, yaw, pitch, grounded, crouch, kneel, reloading, moving, wall }
// wall: -1 (wall on left) .. +1 (wall on right). Staggered wall-run pose:
// wall-side foot plants high on the wall, trail leg extends, wall-side arm
// flares for balance, torso stays over the feet while the head levels out.
export function animateSoldier(mesh, inp, dt, t) {
  const ud = mesh && mesh.userData;
  if (!ud || !ud.rig) return;
  const r = ud.rig;
  const A = ud.anim || (ud.anim = newAnimState());
  dt = clamp(dt, 0, 0.1);
  const yaw = inp.yaw || 0;

  // ---- inputs into body space (forward = +Z rotated by yaw, matching bot.yaw) ----
  const vx = inp.vx || 0, vz = inp.vz || 0;
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const fwdRaw = vx * sy + vz * cy;
  const sideRaw = vx * cy - vz * sy;
  const spdRaw = Math.hypot(vx, vz);
  A.spd = damp(A.spd, spdRaw, 11, dt);
  A.fwd = damp(A.fwd, fwdRaw, 11, dt);
  A.side = damp(A.side, sideRaw, 11, dt);
  A.pitch = damp(A.pitch, clamp(inp.pitch || 0, -1.2, 1.2), 12, dt);
  A.crouch = damp(A.crouch, inp.crouch ? 1 : 0, 9, dt);
  A.kneel = damp(A.kneel, inp.kneel ? 1 : 0, 7, dt);
  A.reload = damp(A.reload, inp.reloading ? 1 : 0, 10, dt);

  // turn-in-place: yaw rate with no translation makes the torso lead the hips
  if (A.yawPrev === null) A.yawPrev = yaw;
  let dYaw = yaw - A.yawPrev;
  while (dYaw > Math.PI) dYaw -= TAU; while (dYaw < -Math.PI) dYaw += TAU;
  A.yawPrev = yaw;
  A.turn = damp(A.turn, clamp(dYaw / Math.max(dt, 1e-4) * 0.12, -1, 1), 8, dt);

  // airborne / landing
  const grounded = inp.grounded !== false;
  if (!grounded) { A.air = Math.min(1, A.air + dt * 6); }
  else {
    if (A.air > 0.3) A.land = Math.min(1, A.land + A.air * 0.9); // dip proportional to hang time
    A.air = Math.max(0, A.air - dt * 8);
  }
  A.land = Math.max(0, A.land - dt * 3.2);
  A.fire = Math.max(0, A.fire - dt * 7);
  A.flinch = Math.max(0, A.flinch - dt * 4.5);
  A.breathe += dt * 1.5;

  // ---- gait clock ----
  // Cadence rises with speed the way a real stride does: longer AND faster steps.
  // Wall runs step quicker and shorter than a ground sprint.
  A.wall = damp(A.wall || 0, clamp(inp.wall || 0, -1, 1), 8, dt);
  const wAbs = Math.min(1, Math.abs(A.wall));
  const spd = A.spd;
  const amp = clamp(spd / 4.6, 0, 1);                 // stride amplitude
  const runK = clamp((spd - 2.2) / 3.4, 0, 1);        // walk -> run blend
  const cadence = spd > 0.15 ? (1.05 + spd * 0.30) * (1 + wAbs * 0.28) : 0;
  const backward = A.fwd < -0.35 ? -1 : 1;            // backpedal reverses the cycle
  A.phase += cadence * TAU * dt * backward;
  if (A.phase > TAU) A.phase -= TAU; if (A.phase < 0) A.phase += TAU;
  const p = A.phase;
  const kneelK = A.kneel, crouchK = A.crouch * (1 - kneelK);
  const gaitK = amp * (1 - kneelK) * (1 - A.air * 0.85);

  // ---- LEGS: hip swing, knee flexion (swing phase + loading response), ankle roll ----
  // A leg's knee only ever folds backwards, so knee flex is clamped >= 0.
  const mix = (a, b, k) => a + (b - a) * k;
  const legPose = (ph, hip, knee, ankle, kH, kK, kA) => {
    const sw = Math.sin(ph), cw = Math.cos(ph);
    // hip: thigh forward on swing, extended behind on toe-off (+x = backward)
    const hipA = -sw * (0.40 + 0.34 * runK) * gaitK;
    // knee: big flex through swing, small dip as weight loads at heel strike
    const swingFlex = Math.pow(Math.max(0, -Math.sin(ph - 0.55)), 1.5) * (0.95 + 0.85 * runK);
    const loadFlex = Math.max(0, Math.sin(ph * 2 + 0.4)) * 0.16;
    const kneeA = (swingFlex + loadFlex) * gaitK;
    // ankle: plantarflex at toe-off, dorsiflex to clear the ground mid-swing
    const ankleA = (Math.max(0, cw) * 0.30 - Math.max(0, -cw) * 0.22) * gaitK;
    // Joint limits are anatomical, not decorative: stacking a full stride onto a
    // crouch and a landing used to drive the knee to 203 deg, folding the shin
    // up through the thigh. A real knee tops out near 150.
    hip.rotation.x = clamp(mix(hipA - 1.45 * crouchK, kH, kneelK), -1.75, 1.05);
    hip.rotation.z = 0;
    knee.rotation.x = clamp(mix(kneeA + 2.20 * crouchK + A.land * 0.55, kK, kneelK), 0, 2.50);
    // sole stays flat when hip+knee+ankle sums to zero
    ankle.rotation.x = clamp(mix(ankleA - 0.75 * crouchK - A.land * 0.2, kA, kneelK), -1.40, 0.90);
  };
  // kneel = the bomb-plant/defuse crouch: rear knee on the deck, front foot planted
  // rear shin lies along the ground (hip+knee ~= 90deg from vertical), foot trailing
  legPose(p, r.hipL, r.kneeL, r.ankleL, 0.50, 1.07, -1.00);
  legPose(p + Math.PI, r.hipR, r.kneeR, r.ankleR, -1.57, 1.57, 0.0);

  // footstep hook: fires the instant a heel plants (used for sound/dust)
  const foot = Math.sin(p) > 0 ? 0 : 1;
  const struck = foot !== A.step && gaitK > 0.12;
  A.step = foot;

  // ---- PELVIS: height comes from the legs themselves (foot-planting IK) ----
  // Pin whichever sole is lowest to the floor and hang the body off it. The
  // vertical bounce of the walk then falls out of real leg geometry, and no foot
  // can ever sink through the ground — which a hand-tuned sine bob always does
  // eventually, because it has no idea where the feet actually are.
  const BOOT_DROP = 0.14, BOOT_FWD = 0.05;
  const soleDrop = (hip, knee, ankle) => {
    const h = hip.rotation.x, k = h + knee.rotation.x, a = k + ankle.rotation.x;
    return r.thigh * Math.cos(h) + r.shin * Math.cos(k) + BOOT_DROP * Math.cos(a) + BOOT_FWD * Math.sin(a);
  };
  let support = Math.max(soleDrop(r.hipL, r.kneeL, r.ankleL), soleDrop(r.hipR, r.kneeR, r.ankleR));
  // While kneeling the rear KNEE is the contact point, not that foot. Fading it in
  // from far below keeps it out of the calculation entirely when standing.
  const kneeContact = r.thigh * Math.cos(r.hipL.rotation.x) + 0.11;
  support = Math.max(support, kneeContact - (1 - kneelK) * 3);
  r.pelvis.position.y = Math.max(0.20, support - A.land * 0.10 + A.air * 0.03);
  r.pelvis.rotation.z = Math.sin(p) * 0.075 * gaitK;
  r.pelvis.rotation.y = -Math.sin(p) * 0.13 * gaitK;
  r.pelvis.rotation.x = 0;

  // ---- SPINE / CHEST: counter-rotate against the hips, lean into the run ----
  const runLean = clamp(A.fwd / 5, -1, 1) * (0.06 + 0.13 * runK);
  r.spine.rotation.y = Math.sin(p) * 0.15 * gaitK - A.turn * 0.22;
  r.spine.rotation.z = -clamp(A.side / 4.5, -1, 1) * 0.10 - Math.sin(p) * 0.03 * gaitK;
  r.spine.rotation.x = runLean + 0.30 * kneelK + 0.10 * crouchK - A.flinch * 0.26;

  const breatheK = (1 - amp) * (1 - kneelK);
  r.chest.rotation.x = -A.pitch * 0.26
    + Math.sin(A.breathe) * 0.016 * breatheK
    - A.fire * 0.10
    - Math.cos(p * 2) * 0.02 * gaitK;
  r.chest.rotation.y = -Math.sin(p) * 0.06 * gaitK + A.turn * 0.1;
  r.chest.rotation.z = Math.sin(p) * 0.02 * gaitK;

  // ---- NECK: eyes stay on target while the body works underneath ----
  r.neck.rotation.x = -A.pitch * 0.34 + 0.22 * kneelK - A.flinch * 0.34 - A.fire * 0.05;
  r.neck.rotation.y = -r.spine.rotation.y * 0.55 - r.chest.rotation.y * 0.4;
  r.neck.rotation.z = -r.pelvis.rotation.z * 0.5;

  // ---- ARMS: a carried rifle keeps both hands on the weapon, so the arms ride
  //      the torso instead of swinging freely. Recoil and reload move them. ----
  const rl = A.reload;
  const gunBob = Math.sin(p * 2 + 0.6) * 0.035 * gaitK;
  r.shoulderL.rotation.x = -0.55 + gunBob + A.fire * 0.10 + 0.42 * rl - 0.35 * kneelK;
  r.shoulderL.rotation.z = 0.12 * gaitK * Math.sin(p) + 0.38 * rl;
  r.elbowL.rotation.x = -0.85 - A.fire * 0.12 - 0.60 * rl;
  r.shoulderR.rotation.x = -0.55 + gunBob * 0.6 + A.fire * 0.16 - 0.18 * kneelK;
  r.shoulderR.rotation.z = -0.10 * gaitK * Math.sin(p);
  r.elbowR.rotation.x = -0.85 - A.fire * 0.10;

  // ---- WEAPON: barrel tracks the aim line, kicks on fire, dips on reload/kneel ----
  if (r.gun) {
    r.gun.rotation.x = -A.pitch * 0.55 - A.fire * 0.22 + 0.25 * rl + 0.30 * kneelK;
    r.gun.rotation.z = 0.55 * rl + 0.35 * kneelK;
    r.gun.rotation.y = -A.turn * 0.12;
    r.gun.position.y = (r.gun.userData.baseY !== undefined ? r.gun.userData.baseY : (r.gun.userData.baseY = r.gun.position.y))
      - 0.05 * rl - A.fire * 0.015;
    r.gun.position.z = (r.gun.userData.baseZ !== undefined ? r.gun.userData.baseZ : (r.gun.userData.baseZ = r.gun.position.z))
      - A.fire * 0.05;
  }
  // ---- WALL RUN: stagger the gait — wall foot plants high, trail leg drops,
  //      body tips away from the wall (feet toward it), head and gun stay level. ----
  if (wAbs > 0.01) {
    const wk = A.wall, wR = Math.max(0, wk), wL = Math.max(0, -wk); // wall-side weight per leg
    r.pelvis.rotation.z -= wk * 0.16;
    r.pelvis.position.y += 0.05 * wAbs;
    r.spine.rotation.z += wk * 0.12;
    r.chest.rotation.z += wk * 0.10;
    r.neck.rotation.z += wk * 0.14; // head counter-levels so the eyes stay flat
    // wall-side hip flexes up + out (foot meets the wall), trail leg extends down/back
    r.hipR.rotation.x += (-0.70 * wR + 0.38 * wL) * 1;
    r.hipL.rotation.x += (-0.70 * wL + 0.38 * wR) * 1;
    r.hipR.rotation.z -= 0.50 * wR; r.hipL.rotation.z += 0.50 * wL;
    r.kneeR.rotation.x = clamp(r.kneeR.rotation.x + 0.85 * wR, 0, 2.50);
    r.kneeL.rotation.x = clamp(r.kneeL.rotation.x + 0.85 * wL, 0, 2.50);
    r.ankleR.rotation.x = clamp(r.ankleR.rotation.x - 0.30 * wR, -1.40, 0.90);
    r.ankleL.rotation.x = clamp(r.ankleL.rotation.x - 0.30 * wL, -1.40, 0.90);
    // wall-side arm flares out for balance, gun-side arm pins the weapon steady
    r.shoulderL.rotation.z += 0.75 * wL; r.shoulderR.rotation.z -= 0.75 * wR;
    r.shoulderL.rotation.x -= 0.30 * wL; r.shoulderR.rotation.x -= 0.30 * wR;
    r.elbowL.rotation.x -= 0.25 * wL; r.elbowR.rotation.x -= 0.25 * wR;
    if (r.gun) { r.gun.rotation.z += wk * 0.12; r.gun.rotation.y -= wk * 0.08; }
  }
  return struck;
}

