# vMix Commander

A multi-venue vMix control panel built with Electron — designed for live event production.

## Features

- **Event Profiles**: Create multiple event profiles, each with its own set of rooms
- **Room Control**: Control Recording, Streaming, and MultiCorder for multiple vMix instances
- **Real-time Status**: Auto-refreshing status indicators (every 8 seconds)
- **Blinking Indicators**: Visual feedback when REC/STREAM/MULTI are active
- **Quick Actions**: START ALL / STOP ALL buttons per room
- **No CORS Issues**: Direct HTTP calls from Electron main process (no proxy needed)
- **Offline Storage**: All profiles stored locally in app userData

## Quick Start

```bash
# Install dependencies
npm install

# Run the app
npm start

# Build for distribution
npm run build        # Build for current platform
npm run build:mac    # Build for macOS (DMG)
npm run build:win    # Build for Windows (NSIS)
```

## Usage

### 1. Event Profiles

- Navigate to **Events** tab
- Create a new profile or switch between existing ones
- Each profile has its own set of rooms

### 2. Configure Rooms

- Go to **Settings** tab
- Edit room names and IP addresses
- Add or remove rooms (minimum 1 room per profile)

### 3. Control Rooms

- Navigate to **Rooms** tab
- Set IP addresses for each vMix instance (click ⚙ or + IP button)
- Use individual START/STOP buttons for REC, STREAM, or MULTI
- Use START ALL / STOP ALL for quick control
- Status indicators:
  - **● REC/STREAM/MULTI** (blinking) = Active
  - **IDLE** = Connected but inactive
  - **ERROR** = Connection failed

## vMix API Functions

The app uses standard vMix HTTP API calls:

- `http://{ip}:8088/api/?Function=StartRecording`
- `http://{ip}:8088/api/?Function=StopRecording`
- `http://{ip}:8088/api/?Function=StartStreaming`
- `http://{ip}:8088/api/?Function=StopStreaming`
- `http://{ip}:8088/api/?Function=StartMultiCorder`
- `http://{ip}:8088/api/?Function=StopMultiCorder`
- `http://{ip}:8088/api` (status check)

## Architecture

```
vmix-commander/
  main.js          ← Electron main process (IPC + vMix HTTP calls)
  preload.js       ← Bridge: exposes vmix API to renderer
  renderer/
    index.html     ← UI structure
    app.js         ← UI logic + IPC calls
    styles.css     ← Dark theme styles
```

### IPC Communication

**Renderer → Main:**
- `window.vmix.status(ip)` → Get vMix status
- `window.vmix.call(ip, functionName)` → Execute vMix function
- `window.profiles.get()` → Load profiles
- `window.profiles.save(data)` → Save profiles
- `window.windowControls.toggleAlwaysOnTop(value)` → Window setting

**Main → vMix:**
- Direct HTTP calls using Node.js `http` module (no CORS restrictions)

## Data Storage

Profiles are stored in:
- **macOS**: `~/Library/Application Support/vmix-commander/profiles.json`
- **Windows**: `%APPDATA%\vmix-commander\profiles.json`
- **Linux**: `~/.config/vmix-commander/profiles.json`

## Settings

- **Always on Top**: Keep the app window above other windows (useful during live events)
- **Profile Management**: Rename profiles, switch between events
- **Room Configuration**: Add/remove/rename rooms, set IP addresses

## Production Use

This app is designed for live event production:
- Compact cards fit 3 rooms on one screen
- Touch-friendly UI (good for touchscreen devices)
- Auto-refresh keeps status current
- No internet required at runtime
- Self-contained executable

## Development

Built with:
- Electron 28
- Vanilla JavaScript (no frameworks)
- CSS Grid for responsive layout
- IPC for secure renderer-main communication

## License

ISC
