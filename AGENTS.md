# vMix Commander

Electron desktop app for multi-venue vMix control at live events. Controls recording, streaming, and MultiCorder across multiple rooms via vMix's HTTP API.

## Architecture

- `main.js` — Electron main process: HTTP proxy server (port 8097), Cloudflare tunnel, IPC handlers, vMix API with latency measurement
- `renderer/index.html` — Single-page app with 6 tabs: Rooms, Events, Show, Log, Tunnel, Settings
- `renderer/app.js` — All UI logic, state management, rendering (vanilla JS, no framework)
- `renderer/styles.css` — Design system with CSS variables (tokens for fonts, spacing, radii, colors)
- `bin/` — Bundled cloudflared binaries (mac + win), unpacked from asar at runtime

## Design System

CSS tokens are defined in `:root` in `styles.css`. Use `var(--token)` everywhere — avoid hardcoded px/color values.

- Fonts: `--fs-xs` (11px) through `--fs-2xl` (24px)
- Spacing: `--sp-1` (4px) through `--sp-10` (40px), 4px base
- Radii: `--r-sm` (6px), `--r-md` (8px), `--r-lg` (10px), `--r-xl` (12px)
- Colors: `--s1`/`--s2` surfaces, `--t1`/`--t2`/`--t3` text, `--accent`, `--green`, `--red`

## Building & Releasing

After implementation changes are finished, do **not** stop at commit/push.
Always leave installable app artifacts ready for the user.

Required release flow:
1. Run syntax/tests.
2. Bump version in `package.json` and all visible `renderer/index.html` version strings.
3. Commit and push.
4. Build or fetch both installable artifacts:
   - macOS ARM64 DMG
   - Windows x64 installer EXE
5. Confirm the artifact paths or download links in the final response.

Use `/build` to bump version, commit, push, and build the DMG. Accepts `patch` (default), `minor`, or `major`.

The `/build` skill:
1. Bumps the version in `package.json` and all occurrences in `renderer/index.html`
2. Commits all changes with a detailed message listing features/changes
3. Pushes to remote
4. Runs `npm run build` (electron-builder → DMG in `dist/`)
5. Opens the dist folder

The version appears in THREE places (all must be updated together):
1. `package.json` — `"version"` field
2. `renderer/index.html` — `<span class="header-version">vX.Y.Z</span>`
3. `renderer/index.html` — Settings page "About" section text

Manual local build:

```bash
npm run build:mac
npx electron-builder --win --x64
```

If local `npm` / `npx` are unavailable, use the GitHub tag/release build and download/copy the finished `.dmg` and `.exe` into `dist/` so the user has ready-to-install files.

Manual build output goes to `dist/`.

## Key Conventions

- Proxy port is defined as `PROXY_PORT` constant in `main.js` (currently 8097)
- Conference profiles are switched via dropdown in the header bar — scopes Rooms, Show, and Log pages
- Room editing happens on the Settings page, not inline on room cards
- All buttons use the unified `.btn` class system (`.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-success`)
- Nav bar uses Apple glass design with backdrop-filter blur
- Room function toggles are single-button state-aware (not dual start/stop)
- Room card headers show: name, recording timer (REC HH:MM:SS), health (Ping Xms), settings gear
- Connection health tracks latency, consecutive failures, and tiers (healthy/degraded/unreachable)
- Recording timer runs on 1-second interval, tracks start time per room in `recordingStartTimes` object
- Never stage `dist/`, `node_modules/`, or `.env` files in commits
