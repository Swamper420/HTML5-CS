// js/buymenu.js — AGENTS: Buy menu (B): prices, cursor/keyboard navigation, purchases, buy timer + toast.
// Ownership: toggleBuy, buyItem, refreshBuyMenu, updateBuyTimer.

import { AudioSys } from './audio.js';
import { BUY_TIME, NADE_DEFS, NADE_ORDER, PRIMARIES, SLOT_ORDER, WEAPONS, isNadeKey } from './config.js';
import { $, clamp } from './utils.js';
import { updateInteractHUD } from './bomb.js';
import { announce, updateHUD } from './hud.js';
import { pointerLocked, setMouseDown, setMouseJustDown } from './input.js';
import { dropWeapon, reserveCap } from './pickups.js';
import { lockPointer } from './rounds.js';
import { switchWeapon } from './shooting.js';
import { G, isBuyTime, player, primaryKey } from './state.js';
import { buildViewmodel } from './viewmodel.js';

function buyTimeLeft() { return Math.max(0, G.buyLeft); }
function buyPrice(kind) {
  const w = player.weapons;
  if (isNadeKey(kind)) return NADE_DEFS[kind].price;
  // deagle: 1st $700, 2nd copy (dual) $700, then ammo $200
  return ({ ak: 2500, awp: 4750, p90: WEAPONS.p90.price, deagle: (w.deagle && w.deagle.owned && w.deagle.dual) ? 200 : 700, ammo: 200, armor: 1000, hp: 500 })[kind] || 0;
}
// ---- virtual cursor: menu works while pointer stays locked (no unlock/relock yank, no browser relock cooldown)
const buyCur = { x: 0, y: 0, hover: null };
export function buyCursorSync() {
  const el = $('buy-cursor'); if (!el) return;
  el.classList.toggle('on', G.buyOpen && pointerLocked);
  if (!(G.buyOpen && pointerLocked) && buyCur.hover) { buyCur.hover.classList.remove('hover'); buyCur.hover = null; }
}
export function moveBuyCursor(dx, dy) {
  const k = 1; // 1:1 with OS mouse movement, like a desktop cursor
  buyCur.x = clamp(buyCur.x + dx * k, 0, innerWidth - 2);
  buyCur.y = clamp(buyCur.y + dy * k, 0, innerHeight - 2);
  $('buy-cursor').style.transform = `translate(${buyCur.x}px,${buyCur.y}px)`;
  const hit = document.elementFromPoint(buyCur.x, buyCur.y);
  const item = hit && hit.closest ? hit.closest('.buy-item') : null;
  if (item !== buyCur.hover) {
    if (buyCur.hover) buyCur.hover.classList.remove('hover');
    if (item) { item.classList.add('hover'); AudioSys.click(2200, 0.015, 0.08); }
    buyCur.hover = item;
  }
}
export function buyCursorClick() {
  const item = buyCur.hover;
  if (!item) return;
  item.classList.add('press'); setTimeout(() => item.classList.remove('press'), 90);
  buyItem(item.dataset.buy);
}
export function buyByKey(d) {
  const item = document.querySelector(`.buy-item[data-key="${d}"]`);
  if (item) buyItem(item.dataset.buy);
}
export function toggleBuy(force, relock = true) {
  const want = force !== undefined ? force : !G.buyOpen;
  if (want === G.buyOpen) return;
  if (want) {
    if (G.phase !== 'playing' || G.roundEnding) return;
    if (!player.alive) { announce('CAN\'T BUY WHILE DEAD', 1000); AudioSys.click(300, 0.1, 0.3); return; }
    if (!isBuyTime()) { announce('BUY TIME OVER', 900); AudioSys.click(300, 0.1, 0.3); return; }
    // drop any held input so opening the menu never leaves you firing/aiming/cooking
    setMouseDown(false); setMouseJustDown(false); player.aiming = false;
    if (player.cook) { player.cook = null; try { updateInteractHUD(null); } catch (err) {} }
    // cursor starts near the menu centre, like CS2
    buyCur.x = innerWidth / 2; buyCur.y = innerHeight / 2 + 40;
    $('buy-cursor').style.transform = `translate(${buyCur.x}px,${buyCur.y}px)`;
    AudioSys.click(900, 0.04, 0.2);
  }
  G.buyOpen = want;
  const menu = $('buy-menu');
  menu.classList.toggle('open', want);
  menu.setAttribute('aria-hidden', want ? 'false' : 'true');
  refreshBuyMenu(true);
  updateBuyTimer();
  buyCursorSync();
  if (!want) {
    const t = $('buy-toast'); if (t) t.classList.remove('show');
    // only needed if the lock was lost some other way (e.g. native-cursor fallback)
    if (relock && !pointerLocked && G.phase === 'playing' && player.alive) lockPointer();
  } else if (!pointerLocked) {
    lockPointer();
  }
}
let buyMenuKey = '';
export function refreshBuyMenu(force) {
  if (!force && !G.buyOpen) return;
  const w = player.weapons, money = player.money;
  const key = [money, player.hp, player.armor, w.ak.owned, w.awp.owned, w.p90.owned, w.deagle.owned, !!w.ak.dual, !!w.awp.dual, !!w.p90.dual, !!w.deagle.dual, ...NADE_ORDER.map((k) => player.nades[k] || 0)].join('|');
  if (!force && key === buyMenuKey) return;
  const prevMoney = +(buyMenuKey.split('|')[0] || money);
  buyMenuKey = key;
  const mEl = $('buy-money');
  mEl.textContent = '$' + money;
  if (prevMoney !== money && G.buyOpen) { mEl.classList.remove('pulse'); void mEl.offsetWidth; mEl.classList.add('pulse'); setTimeout(() => mEl.classList.remove('pulse'), 130); }
  document.querySelectorAll('#buy-menu .buy-item').forEach((el) => {
    const k = el.dataset.buy, price = buyPrice(k);
    let owned = false, maxed = false, state = '';
    if (PRIMARIES.includes(k)) { owned = !!w[k].owned; maxed = owned && !!w[k].dual; if (maxed) state = 'DUAL'; else if (owned) state = '+2ND'; else if (primaryKey()) state = 'SWAP'; }
    else if (k === 'deagle') { owned = !!w.deagle.owned; if (owned) state = w.deagle.dual ? 'AMMO' : '+2ND'; }
    else if (k === 'armor') { maxed = player.armor >= 100; if (maxed) state = 'FULL'; }
    else if (k === 'hp') { maxed = player.hp >= 100; if (maxed) state = 'FULL'; }
    else if (isNadeKey(k)) { const n = player.nades[k] || 0, mx = NADE_DEFS[k].max; maxed = n >= mx; state = n ? `${n}/${mx}` : ''; }
    el.querySelector('.bi-price').textContent = '$' + price;
    el.querySelector('.bi-state').textContent = state;
    el.classList.toggle('owned', maxed && PRIMARIES.includes(k));
    el.classList.toggle('maxed', maxed && !PRIMARIES.includes(k));
    el.classList.toggle('poor', !maxed && money < price);
  });
}
export function updateBuyTimer() {
  const el = $('buy-timer'); if (!el) return;
  const left = buyTimeLeft();
  el.textContent = isBuyTime() ? Math.ceil(left) + 's' : 'CLOSED';
  const fill = $('buy-timer-fill');
  if (fill) fill.style.transform = `scaleX(${clamp(left / BUY_TIME, 0, 1)})`;
  el.parentElement.classList.toggle('low', left < 5);
  refreshBuyMenu(false);
}
let buyToastTimer = null;
function buyFeedback(kind, good, msg) {
  const item = document.querySelector(`.buy-item[data-buy="${kind}"]`);
  if (item) { const c = good ? 'bought' : 'denied'; item.classList.remove('bought', 'denied'); void item.offsetWidth; item.classList.add(c); }
  if (G.buyOpen) {
    const t = $('buy-toast');
    t.textContent = msg; t.className = 'show ' + (good ? 'ok' : 'no');
    clearTimeout(buyToastTimer); buyToastTimer = setTimeout(() => t.classList.remove('show'), 1400);
  } else announce(msg, 900);
}
export function buyItem(kind) {
  if (!isBuyTime()) { buyFeedback(kind, false, 'BUY TIME OVER'); AudioSys.click(250, 0.12, 0.35); return; }
  if (!player.alive) { buyFeedback(kind, false, 'CAN\'T BUY WHILE DEAD'); AudioSys.click(250, 0.12, 0.35); return; }
  if (G.roundEnding) return;
  const w = player.weapons;
  const ok = (msg) => { buyFeedback(kind, true, msg); refreshBuyMenu(true); updateHUD(); AudioSys.click(1500, 0.07, 0.35); };
  const no = (msg) => { buyFeedback(kind, false, msg); AudioSys.click(250, 0.12, 0.35); };
  // Buying a gun you already hold buys a second one: dual wield.
  const buySecond = (k) => {
    const def = WEAPONS[k];
    if (player.money < def.price) return no('NOT ENOUGH $');
    player.money -= def.price;
    w[k].dual = true; w[k].mag2 = def.magSize;
    w[k].reserve = reserveCap(k, true);
    player.aiming = false; player.reloading = 0; $('reload-tip').classList.add('hidden');
    if (player.cur === k) buildViewmodel(k); else switchWeapon(k);
    return ok(`2ND ${def.name.toUpperCase()} — DUAL WIELD (LMB RIGHT · RMB LEFT)`);
  };
  if (PRIMARIES.includes(kind)) {
    const def = WEAPONS[kind];
    if (w[kind].owned && w[kind].dual) return no(`ALREADY DUAL ${def.name.toUpperCase()}`);
    if (w[kind].owned) return buySecond(kind);
    if (player.money < def.price) return no('NOT ENOUGH $');
    const old = primaryKey();
    if (old) { dropWeapon(old, { both: true, fromDeath: true }); w[old].dual = false; if (player.last === old) player.last = 'deagle'; }
    player.money -= def.price;
    w[kind].owned = true; w[kind].mag = def.magSize; w[kind].reserve = def.startReserve;
    if (player.cur === old) player.cur = 'deagle'; // force a fresh draw of the new gun
    switchWeapon(kind);
    return ok(old ? `${def.name} PURCHASED — ${WEAPONS[old].name} DROPPED` : `${def.name} PURCHASED`);
  }
  if (kind === 'deagle') {
    if (w.deagle.owned && !w.deagle.dual) return buySecond('deagle');
    if (w.deagle.owned) { // dual already: refill
      if (player.money < 200) return no('NOT ENOUGH $');
      player.money -= 200; w.deagle.reserve = reserveCap('deagle', w.deagle.dual); return ok('DEAGLE AMMO REFILLED');
    }
    if (player.money < 700) return no('NOT ENOUGH $');
    player.money -= 700; w.deagle.owned = true; w.deagle.mag = 7; w.deagle.reserve = 35; return ok('DESERT EAGLE PURCHASED');
  }
  if (kind === 'ammo') {
    if (player.money < 200) return no('NOT ENOUGH $');
    player.money -= 200;
    for (const k of SLOT_ORDER) if (w[k].owned) w[k].reserve = reserveCap(k, w[k].dual);
    return ok('AMMO REFILLED');
  }
  if (kind === 'armor') {
    if (player.money < 1000) return no('NOT ENOUGH $');
    player.money -= 1000; player.armor = 100; return ok('ARMOR EQUIPPED');
  }
  if (kind === 'hp') {
    if (player.money < 500) return no('NOT ENOUGH $');
    if (player.hp >= 100) return no('HP ALREADY FULL');
    player.money -= 500; player.hp = Math.min(100, player.hp + 50);
    $('heal-flash').style.opacity = 1; setTimeout(() => $('heal-flash').style.opacity = 0, 400);
    return ok('+50 HP');
  }
  if (isNadeKey(kind)) {
    const def = NADE_DEFS[kind];
    if ((player.nades[kind] || 0) >= def.max) return no(`${def.name} FULL (MAX ${def.max})`);
    if (player.money < def.price) return no('NOT ENOUGH $');
    player.money -= def.price;
    player.nades[kind] = (player.nades[kind] || 0) + 1;
    return ok(`${def.name} PURCHASED [${player.nades[kind]}/${def.max}]`);
  }
}

