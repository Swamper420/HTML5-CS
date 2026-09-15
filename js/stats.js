// js/stats.js — AGENTS: Scoreboard K/A/D bookkeeping per match (damage ledger, assists, kill credit).
// Ownership: remoteStats, noteDamage/awardAssist/creditKill. Rendering is in scoreboard.js.

import { bots, player } from './state.js';

// ponytail: assists = previous damager within 5s of kill, no per-hit ledger.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const remoteStats = new Map(); // netId -> {kills,deaths,assists,name,team}
export function shooterId(s) {
  if (!s) return 'unknown';
  if (s.isPlayer) return 'you';
  if (s.bot) return 'bot:' + s.bot.team + ':' + s.bot.idx;
  const rid = (s.remote && s.remote.data && s.remote.data.id) ?? s.remoteId ?? null;
  if (rid !== null && rid !== undefined) return 'remote:' + rid;
  return 'unknown';
}
export function statsHolder(id) {
  if (id === 'you') return player;
  if (id && id.startsWith('bot:')) {
    const [, team, idx] = id.split(':');
    return bots.find((b) => b.team === team && String(b.idx) === String(idx)) || null;
  }
  if (id && id.startsWith('remote:')) {
    const rid = +id.slice(7);
    if (!remoteStats.has(rid)) remoteStats.set(rid, { kills: 0, deaths: 0, assists: 0, name: '', team: '' });
    return remoteStats.get(rid);
  }
  return null;
}
export function noteDamage(victim, shooter) {
  try {
    const id = shooterId(shooter);
    if (id === 'unknown') return;
    const now = performance.now() / 1000;
    if (victim._lastId && victim._lastId !== id && (now - (victim._lastT || 0)) < 5) {
      victim._assistId = victim._lastId; victim._assistT = victim._lastT;
    }
    victim._lastId = id; victim._lastT = now;
  } catch {}
}
export function awardAssist(victim, killerId) {
  try {
    const now = performance.now() / 1000;
    const aid = victim._assistId;
    if (!aid || aid === killerId || (now - (victim._assistT || 0)) > 5) return;
    const h = statsHolder(aid);
    if (h) h.assists = (h.assists | 0) + 1;
  } catch {}
}
// ponytail: shared get-or-create lives in statsHolder, no local copies.
export function creditKill(shooter) {
  // kills++ for killer bot/remote, deaths++ handled by caller victim.
  try {
    if (!shooter || shooter.isPlayer || shooter.suicide) return;
    if (shooter.bot) { shooter.bot.kills = (shooter.bot.kills | 0) + 1; return; }
    const h = statsHolder(shooterId(shooter));
    if (h) h.kills = (h.kills | 0) + 1;
  } catch {}
}

