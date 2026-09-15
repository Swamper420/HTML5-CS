// js/utils.js — AGENTS: pure helpers, no game state. Import, don't duplicate.
// Ownership: DOM lookup + math helpers. No THREE, no player, no Audio.

export const $ = (id) => document.getElementById(id);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const rand = (a, b) => a + Math.random() * (b - a);
export const randPick = (arr) => arr[(Math.random() * arr.length) | 0];
