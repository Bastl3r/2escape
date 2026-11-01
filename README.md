# 2Escape // Codebreak

Asymmetrical co-op escape room for two: one field operative, one hacker, one mission seed.

Two players share a procedurally generated 20-room facility. The **operative** walks the rooms and physically works the locks. The **hacker** never sees the rooms — only blueprints, a device manual and a terminal. Talking to each other is the game.

Built as a dependency-free static PWA: vanilla JavaScript, a hand-written canvas game loop and a service worker. Multiplayer runs peer-to-peer over WebRTC via [PeerJS](https://peerjs.com/); there is no backend.

## Gameplay

0. Generate a **mission seed** (enables retake of room setup).
2. One player **hosts**, the other **joins** with the shared room code.
3. Pick a role: `FIELD OPERATIVE` or `HACKER OPS`. Roles are enforced on connect, so the host's choice wins.
4. Clear all 20 rooms before the per-room timer runs out.

The seed drives everything: room layouts, puzzle positions, device names, pump flows, PINs, wire order, frequencies, mirror angles. Same seed, same run.

### Operative

- Top-down canvas: move with WASD or arrow keys or the on-screen joystick, interact with `E`.
- Six puzzle slots per room plus the exit keypad. Rooms get harder: 
  - 3 puzzles for rooms 1–4
  - 4 for 5–9, 5 for 10–14
  - 6 from room 15.
- Puzzles are solved inside a modal; wrong answers cost time.
- Every room is unique: no puzzle type repeats inside a room.

### Hacker

Four tabs, no room view:

- **Blueprint radar** — the operative's position and the room's puzzle layout.
- **Manual directory** — per-puzzle documentation, filtered to the current run.
- **Ops terminal** — remote overrides and status commands.
- **Telemetry** — coordinates, current room, barrier states.

### Puzzle types

| Type | Mechanic |
| --- | --- |
| Keypad bypass | Enter a PIN found in the manual |
| Frequency tuner | Tune frequency and phase angle |
| Wire cutter | Cut the correct wire from the manual's description |
| Power matrix | Activate the required grid cells |
| Pressure cycle | Balance two pumps to hit a target level |
| Levitation field | Hold a ball at the target height with fan force |
| Optical relay | Rotate mirrors to route a laser into the receiver |

## Running it

### Running locally
No build step is required for the app itself. 

```sh
# any static server works; service worker needs localhost or https
npx serve .
# or
python -m http.server 8080
```

Then open `http://localhost:8080`. Do **not** open `index.html` via `file://` — the service worker and the manifest will not work.

### Running from hosted page
Visit static github page https://bastl3r.github.io/2escape/ (deployed from `main` branch)

Two-player notes:

- The PeerJS library and Google Fonts load from CDNs, so the first online visit needs internet.
- The service worker caches the shell and those third-party requests, so an installed copy starts offline.
- Solo testing: use **SOLO TEST** in the lobby to run the operative side without a peer.

## Project layout

```
index.html        all game code, markup, styles and translations
puzzles.js        puzzle framework: generation, puzzle UI, handbook, terminal hooks
manifest.json     PWA metadata and icons
sw.js             service worker (shell cache + runtime cache)
offline.html      fallback shown when a navigation fails offline
icons/            app icons (192, 512, maskable, apple-touch)
mockups/          standalone design mockups for individual puzzles
```

`index.html` is intentionally self-contained: business logic, screens, networking, audio and i18n all live there. The one exception is `puzzles.js`, which owns everything puzzle-related. The two talk through `window.PuzzleEngine`.

## Development notes

### Puzzle framework

`puzzles.js` exposes `window.PuzzleEngine`:

```js
PuzzleEngine.TOTAL_ROOMS
PuzzleEngine.ROOM_VIEW
PuzzleEngine.PUZZLE_SPRITE_RADIUS
PuzzleEngine.generateRun(seed)              // pure, seeded
PuzzleEngine.open(puzzle, ui, host)         // operative-side UI
PuzzleEngine.openPreview(puzzle, ui, host)  // hacker-side preview
PuzzleEngine.renderManual(container, rooms, host)
PuzzleEngine.parseTerminalCommand(cmd, ctx)
```

`host` is provided by `index.html`: translations, sounds, `solve`, `penalty`, `isOpen`, `laserSync`.

To add a puzzle type:

1. Add an entry to `PUZZLE_TYPES` (`labelKey`, `render`, `manualEntry`).
2. Append its draws to `drawPuzzleParameters()`.
3. Add the key to `PUZZLE_TYPE_KEYS` — this reshuffles every existing seed once.
4. Extend the handbook and terminal only if the puzzle needs a new mechanic.

### Seed stability

Generation must stay seed-stable. Every puzzle consumes the same draw schedule regardless of type. **Append new draws at the end of the schedule — never in the middle**, or every later puzzle in every existing seed rerolls.

### Styling

Tailwind CSS v4 is compiled into a static `<style>` block in `index.html`. After changing utility classes, regenerate it:

```sh
npx @tailwindcss/cli@4 -i input.css -o out.css --minify
```

with `input.css` containing:

```css
@import "tailwindcss";
@source "index.html";
@source "puzzles.js";
```

### Service worker

Bump `CACHE_VERSION` in `sw.js` whenever `index.html`, `puzzles.js` or the icons change, otherwise installed clients keep serving the stale shell.

## Tech

- Vanilla JavaScript, no framework, no bundler
- Canvas 2D for the operative view and the optical relay
- WebRTC data channels through PeerJS for state sync
- Web Audio API for generated sound effects (no audio assets)
- German and English UI
- PWA: installable, standalone display, offline shell

Works in current Chrome, Edge, Firefox and Safari. Mobile play is supported via touch controls and safe-area handling.
