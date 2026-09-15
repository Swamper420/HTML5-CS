// js/scoreboard.js — AGENTS: TAB scoreboard rendering (stats from stats.js).
// Ownership: scoreboardVisible, setScoreboard, renderScoreboard.

import { Net } from '../net.js';
import { $ } from './utils.js';
import { isMultiplayer } from './multiplayer.js';
import { G, bots, player } from './state.js';
import { esc, statsHolder } from './stats.js';

export function scoreboardVisible() { const el = $('scoreboard'); return !!el && !el.classList.contains('hidden'); }
export function setScoreboard(on) {
  const el = $('scoreboard');
  if (!el || G.phase !== 'playing') { if (el) el.classList.add('hidden'); return; }
  if (on) { el.classList.remove('hidden'); renderScoreboard(); }
  else el.classList.add('hidden');
}
export function renderScoreboard() {
  try {
    const ctBody = $('sb-ct-rows'), tBody = $('sb-t-rows');
    if (!ctBody || !tBody) return;
    const selfPing = (() => { try { return Net.active ? Math.max(1, Math.round(Net.rtt)) : 0; } catch { return 0; } })();
    const rows = { ct: [], t: [] };
    const push = (team, name, k, a, d, ping, me, alive) => {
      (rows[team === 't' ? 't' : 'ct']).push({ name, k: k | 0, a: a | 0, d: d | 0, ping, me: !!me, alive: alive !== false });
    };
    const myTeam = player.team || 'ct';
    push(myTeam, (player.name || 'YOU'), player.kills, player.assists, player.deaths, selfPing, true, player.alive);
    if (!isMultiplayer()) {
      for (const b of bots) {
        if (b.short === undefined) continue;
        push(b.team, b.short, b.kills, b.assists, b.deaths, '—', false, b.alive);
      }
    }
    try {
      for (const r of Net.remoteList()) {
        const st = statsHolder('remote:' + r.id);
        st.name = r.name; st.team = r.team;
        const rp = (r.ping > 0) ? Math.min(9999, Math.round(r.ping)) : '—';
        push(r.team, r.name || ('Player' + r.id), st.kills, st.assists, st.deaths, rp, false, r.alive);
      }
    } catch {}
    for (const k of ['ct', 't']) {
      rows[k].sort((a, b) => (b.k - a.k) || (b.a - a.a) || (a.d - b.d));
      const body = k === 'ct' ? ctBody : tBody;
      body.innerHTML = rows[k].map((r) =>
        `<tr class="${r.me ? 'me' : ''}${r.alive ? '' : ' dead'}"><td>${esc(String(r.name).slice(0, 14))}</td><td>${r.k}</td><td>${r.a}</td><td>${r.d}</td><td>${r.ping}</td></tr>`
      ).join('') || `<tr><td>—</td><td>0</td><td>0</td><td>0</td><td>—</td></tr>`;
    }
    $('sb-ct').textContent = 'CT ' + G.score.ct;
    $('sb-t').textContent = G.score.t + ' T';
    const pingTxt = Net.active ? ` · PING ${selfPing}ms` : '';
    $('sb-foot').textContent = `ROUND ${G.round} · CT ${G.score.ct} — ${G.score.t} T${pingTxt}`;
  } catch {}
}
setInterval(() => { try { if (G.phase === 'playing' && scoreboardVisible()) renderScoreboard(); } catch {} }, 500);

