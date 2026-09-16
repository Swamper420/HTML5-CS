# HTML5-CS: Strike Zone. Agent guide

This is a Counter-Strike-style browser FPS. It uses three.js from an importmap in `index.html` and plain ES modules, with **no build step**.
Run it with `npm start` (runs `server.js`: static files plus the WebSocket relay on :8080), then open http://localhost:8080.

Every `js/*.js` file begins with a 2-line `AGENTS:` header that says what the file does and what it owns.
To see them all at once, run `head -2 js/*.js`.

## Find things fast
```sh
head -2 js/*.js                                  # module map from the file headers
grep -n "export .*\bupdateBot\b" js/*.js         # where a symbol is defined
grep -ln "\bupdateBot\b" js/*.js main.js         # who uses it
```

## File map
| File | Lines | What's in it |
|---|---|---|
| `index.html` / `style.css` | | DOM for the HUD and menus, plus styles |
| `main.js` | 263 | Entry point: `boot()`, the frame loop (`pace`/`loop`), FPS meter, menu buttons |
| `net.js` | 297 | WebSocket client protocol (`Net`). Has no three.js |
| `server.js` | 463 | Node static server (allow-list, CSP) and WebSocket relay with rate limits. See DEPLOY.md |
| `server-match.js` | 266 | Server-authoritative online match: round phases/clocks, score, K/D/A, alive, bomb carrier/plant/defuse/explode, team balance |
| `vendor/three.module.js` | | Vendored three.js 0.160.0 (no CDN) |
| **Data / infra** | | |
| `js/config.js` | 98 | Tunable data: WEAPONS, NADE_DEFS, economy, timings, movement constants |
| `js/settings.js` | 196 | `SET`/`opts`, persistence, settings menu |
| `js/audio.js` | 949 | `AudioSys`: procedural and sample 3D audio |
| `js/utils.js` | 7 | `$`, `clamp`, `rand`, `randPick` |
| `js/state.js` | 51 | `G`, `player`, `bots[]`, `keys{}` (shared mutable state) |
| `js/stats.js` | 60 | K/A/D ledger |
| **World / rendering** | | |
| `js/render.js` | 199 | renderer, scene, camera, lights, sky, canvas-texture helpers |
| `js/map.js` | 713 | Level geometry, `colliders`, `waypoints`, `spawns` |
| `js/collision.js` | 96 | AABB collision, step/ceiling, wall-run walls, `hasLOS` |
| `js/effects.js` | 550 | Tracers, particles, decals, flashes, shells, `updateEffects` |
| **Characters** | | |
| `js/soldier.js` | 251 | Third-person soldier rig and blob shadow |
| `js/anim.js` | 213 | Procedural animation (`animateSoldier`) |
| `js/playerbody.js` | 139 | Local player's visible body and shadow |
| `js/gibs.js` | 391 | Detached limbs/heads, blood spray |
| `js/gore.js` | 416 | Gore scaling, dismemberment, ragdoll deaths, screen blood |
| **Weapons** | | |
| `js/gunmodels.js` | 230 | Gun geometry (shared by viewmodel and world models) |
| `js/viewmodel.js` | 233 | First-person gun, hands, ADS/iron sights |
| `js/shooting.js` | 190 | Player fire/recoil/reload/switch |
| `js/combat.js` | 499 | Hitscan, `damageBot`, `damagePlayer` |
| `js/pickups.js` | 266 | Drop/pick up weapons, dual wield |
| `js/grenades.js` | 649 | Projectiles, HE, flashbang |
| `js/smoke.js` | 237 | Smoke volumes and LOS blocking |
| `js/molotov.js` | 260 | Fire zones |
| **AI / game flow** | | |
| `js/bots.js` | 634 | Bot AI (`makeBot`, `botThink`, `updateBot`, `botShoot`) |
| `js/botnav.js` | 282 | A* nav grid and steering |
| `js/spawns.js` | 34 | Spawn slots and facing |
| `js/bomb.js` | 480 | `BOMB` state, plant/defuse, explode, bomb HUD, `updateBomb` |
| `js/rounds.js` | 384 | Match/round start/end, round timers, applies server `match` state online, pause (menu overlay online) |
| `js/spectate.js` | 158 | Spectating after death |
| `js/dmgreport.js` | 109 | Online damage report: victim acks real damage (`dmg` msg, server sends it only to the attacker); attacker sees hits/damage per player during the next buy time |
| `js/multiplayer.js` | 465 | Remote players, Net event wiring, PvP bot toggling |
| **Player / UI** | | |
| `js/input.js` | 148 | Keyboard/mouse, pointer lock, mouse flags |
| `js/movement.js` | 369 | `updatePlayer`: physics, wall-run, camera bob |
| `js/buymenu.js` | 194 | Buy menu |
| `js/hud.js` | 179 | `updateHUD`, announcements, killfeed, screen feel |
| `js/scoreboard.js` | 56 | TAB scoreboard |
| `js/minimap.js` | 148 | Minimap |
| `js/weed.js` | | Mid-map weed farm: hold-E harvest ($100/s), trip hallucination |

## Frame order (`loop()` in main.js, while playing)
timers → `updatePlayer` → `updatePlayerBody` → bots (`updateBot`, `animateBotMesh`; skipped in PvP) → `updateRemoteMeshes` → `updateBomb` → `updateWeed` → `updateNades` → `updateEffects` → `updateScreenFeel` → `updateGoreScreen` → `updateHUD`/`updateBuyTimer` → `drawMinimap` → render.

Boot order: `initThree` → `buildMap` → `buildViewmodel` → `makeBot` ×8 → `initInput` → settings → `wireMultiplayer`.

## Rules for editing modules
1. **Imports are read-only bindings.** A module can reassign only its own top-level `let`s. Other modules must call the owner's `setX()` export (for example `setMouseJustDown(false)` from `input.js`). If a new cross-module write is needed, add a setter next to the variable. Mutating object fields is fine anywhere (`player.hp = 0`, `G.phase = ...`).
2. **Circular imports are normal here and they work, but only at call time.** Top-level code in a `js/` module may use only `three`, `config.js`, `utils.js` and its own declarations (for example `new THREE.Vector3()`). It must never read another game module's values while the module is being evaluated. Put that kind of setup inside an init function that `boot()` calls.
3. **Nothing imports `main.js`.** Put new systems in a `js/` module, export an `updateX`/`initX`, and call it from `loop()`/`boot()`.
4. Put a new system in a new `js/` file with the 2-line `AGENTS:` header, and add a row to the table above.
5. `audio.js` and `settings.js` get runtime objects through `bindAudioEnv` / `bindSettingsHooks` (wired in main.js) instead of importing game modules. Keep it that way.

## Common tasks
- **New weapon or grenade stats:** `js/config.js` (`registerWeapon` / `registerNade`). The gun's look goes in `js/gunmodels.js` and its sound in `AudioSys.shoot()` in `js/audio.js`.
- **New setting:** `SETTINGS_DEFAULTS` + `SETTINGS_SPEC` in `js/settings.js`.
- **Map change:** `buildMap()` in `js/map.js`. The nav grid rebuilds from `colliders`.
- **Network message:** `net.js` (client), `server.js` (relay), handlers in `wireMultiplayer()` in `js/multiplayer.js`.
- **Online rules (2+ players):** the server decides rounds, clocks, score, K/D and the bomb (`server-match.js`). Clients only send requests/death reports and render `match`/`bomb` broadcasts; guard local round logic with `isServerMatch()`. Pausing is disabled online (ESC opens an overlay menu, `G.menuOpen`).
