// js/dmgreport.js — AGENTS: Online CS2-style damage report: victims ack real damage to attackers; attackers show hits/dmg per player during next buy time.
// Ownership: noteDamageTaken (victim side), onDamageAck (attacker side), beginRoundReport, updateDamageReport.

import { Net } from '../net.js';
import { $ } from './utils.js';
import { isOnline } from './multiplayer.js';
import { esc } from './stats.js';
import { G } from './state.js';

// ---- victim side: the victim applies damage (armor, remaining HP), so it is the
// only one that knows the real number. Batch per attacker so molotov ticks don't spam.
const pending = new Map(); // attackerId -> { dmg, hits, killed }
const lastBurnHit = new Map(); // attackerId -> t (molotov ticks count as one hit per burn)
let flushAt = 0;

// shooter: combat shooter object; amount: HP actually removed; killed: that damage killed us
export function noteDamageTaken(shooter, amount, killed) {
  try {
    if (!isOnline() || !shooter || shooter.isPlayer) return;
    const id = (shooter.remote && shooter.remote.data && shooter.remote.data.id) ?? shooter.remoteId ?? null;
    if (id === null || id === undefined || id === Net.id) return;
    if (!(amount > 0) && !killed) return;
    const now = performance.now() / 1000;
    let hit = 1;
    if (/MOLOTOV/i.test(String(shooter.weaponName || ''))) {
      if (now - (lastBurnHit.get(id) || -9) < 1.5) hit = 0;
      lastBurnHit.set(id, now);
    }
    const p = pending.get(id) || { dmg: 0, hits: 0, killed: false };
    p.dmg += Math.max(0, amount); p.hits += hit; p.killed = p.killed || !!killed;
    pending.set(id, p);
    if (killed) flushDamageAcks(); // don't let a kill wait for the batch window
  } catch {}
}
function flushDamageAcks() {
  if (!pending.size) return;
  try {
    for (const [toId, p] of pending) {
      Net._send({ type: 'dmg', toId, dmg: Math.round(p.dmg * 10) / 10, hits: p.hits, killed: p.killed, rid: Net.roundId || 0 });
    }
  } catch {}
  pending.clear();
}

// ---- attacker side ----
const tallies = new Map(); // rid -> Map(victimId -> { name, team, dmg, hits, killed })
let shownRid = null;       // round whose report is on screen
let visible = false;

export function onDamageAck(m) {
  try {
    if (!m || m.toId !== Net.id || m.fromId == null) return;
    const rid = m.rid | 0;
    let t = tallies.get(rid);
    if (!t) { t = new Map(); tallies.set(rid, t); }
    const r = Net.remotes.get(m.fromId);
    const row = t.get(m.fromId) || { name: '', team: 't', dmg: 0, hits: 0, killed: false };
    row.name = String(m.fromName || (r && r.name) || ('Player' + m.fromId)).slice(0, 16);
    row.team = m.fromTeam === 'ct' ? 'ct' : m.fromTeam === 't' ? 't' : (r && r.team) || 't';
    row.dmg = Math.min(100, row.dmg + Math.max(0, +m.dmg || 0));
    row.hits += Math.max(0, Math.min(30, m.hits | 0));
    row.killed = row.killed || !!m.killed;
    t.set(m.fromId, row);
    if (rid === shownRid && visible) render(); // late ack for the round on screen
  } catch {}
}

// Called at every round start: last round's damage goes on screen for the buy time.
export function beginRoundReport() {
  const cur = Net.roundId || 0;
  // report the most recent round before this one that has any damage
  let best = null;
  for (const rid of tallies.keys()) if (rid < cur && (best === null || rid > best)) best = rid;
  for (const rid of [...tallies.keys()]) if (rid !== best && rid !== cur) tallies.delete(rid);
  shownRid = best;
  if (!isOnline() || best === null || !tallies.get(best).size) { shownRid = null; hide(); return; }
  render();
}

function render() {
  const el = $('dmg-report');
  const t = shownRid !== null ? tallies.get(shownRid) : null;
  if (!el || !t || !t.size) { hide(); return; }
  const rows = [...t.values()].sort((a, b) => b.dmg - a.dmg);
  const total = rows.reduce((s, r) => s + r.dmg, 0);
  el.innerHTML =
    `<div class="dr-head"><span>DAMAGE GIVEN</span><b>${Math.round(total)}</b></div>` +
    rows.map((r) =>
      `<div class="dr-row ${r.team}${r.killed ? ' killed' : ''}">` +
        `<span class="dr-name">${esc(r.name)}</span>` +
        `<span class="dr-hits">${r.hits} ${r.hits === 1 ? 'hit' : 'hits'}</span>` +
        `<span class="dr-dmg">${Math.round(r.dmg)}</span>` +
        `<span class="dr-kill">${r.killed ? '✖' : ''}</span>` +
      `</div>`).join('');
  el.classList.remove('hidden');
  visible = true;
}
function hide() {
  if (!visible) return;
  const el = $('dmg-report');
  if (el) el.classList.add('hidden');
  visible = false;
}

// Every frame from loop(): flush victim acks, hide the report when buy time ends.
export function updateDamageReport(t) {
  if (pending.size && t >= flushAt) { flushAt = t + 0.25; flushDamageAcks(); }
  if (visible && (!isOnline() || G.phase !== 'playing' || !(G.buyLeft > 0))) hide();
}
