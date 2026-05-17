# Firebase Schema — Shared Contract

This document defines the Firebase Realtime Database contract shared between
**vMix Commander** (Electron desktop app) and **Crew Tracker**
([iamdjem.github.io/kubecon-tracker](https://iamdjem.github.io/kubecon-tracker/)).

## Overview

Commander and Tracker coordinate live-event control through a single Firebase
Realtime Database (project `kubecon-tracker`, root node `e3-kc26-x7k9m/`).
Commander is the primary writer: it owns vMix configuration, controller
presence, room status, run-of-show, and per-room locks. Tracker is primarily a
reader, surfacing the current state to on-floor crew on its Recording page.
Both apps append audit entries for user-initiated actions, and Tracker owns
event metadata (names, activities, archived flags) plus event deletion
tombstones. Keeping the data contract explicit here prevents silent drift as
either app evolves.

## Auth model

Both apps sign in as a single shared Firebase user (`user@e3tracker.local`)
with a well-known password baked into the clients. Roles
(`Director` / `Operator` / `Observer`) are chosen by the user at runtime and
enforced **client-side only** — this is an honor system, not a security
boundary. The shared login exists to prevent public (unauthenticated) reads of
the database; it is not a defence against a malicious crew member. If tighter
enforcement becomes necessary, migrate to per-user accounts with Firebase
custom claims and rewrite the RTDB security rules.

## Root and conventions

- All paths live under `e3-kc26-x7k9m/`. Treat this prefix as the application
  root; do not read or write anything above it.
- Event IDs are opaque string keys (Firebase push IDs, created by Tracker).
- All timestamps are integer epoch milliseconds (`Date.now()`).
- Writes prefer `update()` over `set()` at the node level so that siblings
  written by the other app are not clobbered.
- Listeners in Commander are careful to scope to specific sub-paths
  (e.g. `events/<id>/controller`) rather than the entire event, to avoid
  re-firing on every status push from the other app.

---

## Path reference

### `events/<eventId>/` — event metadata (Tracker-owned)

Fields owned by Tracker and out of scope for this document:
`name`, `location`, `dateLabel`, `archived`, `updatedAt`, `activities`, and
other Tracker-specific config.

Commander reads these to populate its profile dropdown and show labels but
does not write them.

### `events/<eventId>/config/vmixRooms`

| | |
| --- | --- |
| **Path** | `events/<eventId>/config/vmixRooms` |
| **Writer** | Commander (pushed on profile save) |
| **Reader** | Tracker |

**Shape:**

```ts
type VmixRoom = {
  key: string;   // stable identifier, e.g. 'bohemia2'
  name: string;  // display label
  ip: string;    // vMix host, LAN IP or hostname
};
type VmixRooms = VmixRoom[];
```

**Notes:** Replaces the legacy `vmix_ips/*` node (still written by Tracker for
backwards compatibility — see below). The `key` field is the canonical room
identifier used elsewhere in this schema (`vmixStatus.rooms`, `roomLocks`,
`audit.room`).

### `events/<eventId>/config/vmixProxyUrl`

| | |
| --- | --- |
| **Path** | `events/<eventId>/config/vmixProxyUrl` |
| **Writer** | Commander (on tunnel URL change, when sync is enabled and an event is linked) |
| **Reader** | Tracker (preferred over the legacy global `vmix_proxy_url`) |

**Shape:** `string | null` — full HTTPS URL of the Cloudflare tunnel.

**Notes:** Tracker falls back to the top-level `vmix_proxy_url` when this
per-event value is absent.

### `events/<eventId>/controller` (legacy compatibility mirror)

| | |
| --- | --- |
| **Path** | `events/<eventId>/controller` |
| **Writer** | Commander (heartbeat every ~5s) |
| **Reader** | Older Commander / Tracker clients; current clients prefer `presence/` |

**Shape:**

```ts
type Controller = {
  commanderId: string;   // uuid per Commander install, from localStorage
  operator: {
    name: string;
    role: 'Director' | 'Operator' | 'Observer';
    crewId?: string;          // matches events/<id>/config/crew[].id when user
                              // signed in as a specific crew member
    assignedRooms?: string[]; // Commander: room KEYS; Tracker mirrors room NAMES
                              // (match cross-app by name — see Crew alignment note)
  };
  lastHeartbeat: number;  // epoch ms, refreshed every ~5s
  safetyLocked: boolean;
};
```

**Notes:** Retained for backwards compatibility. Current multi-Commander
clients publish their authoritative liveness under `presence/<commanderId>`
and only use this node as a compatibility mirror for older clients.

### `events/<eventId>/presence/<commanderId>`

| | |
| --- | --- |
| **Path** | `events/<eventId>/presence/<commanderId>` |
| **Writer** | Commander (heartbeat every ~5s, own cell removed on disconnect) |
| **Reader** | Commander (peer detection), Tracker (online banner / presence) |

**Shape:**

```ts
type Presence = Controller & {
  reachableRooms?: string[]; // room keys currently reachable from this Commander
};
```

**Stale detection:** if `Date.now() - lastHeartbeat > 10_000`, treat that
Commander as offline. Multiple live presence cells are valid; Commander only
warns when another live Commander overlaps the same reachable room scope.

**Crew alignment:** Both apps' identity modals offer a "Sign in as crew member"
dropdown populated from `events/<id>/config/crew` (Tracker-owned, written from
the Tracker's Setup page). Picking a crew member sets `operator.crewId` and
derives `operator.assignedRooms` by matching each crew room's `name` against
the app's own room list:
- Commander stores room **keys** in `assignedRooms` (its internal identifier).
- Tracker stores room **names** in `assignedRooms` (its rooms are addressed by
  name).
- Cross-app matching is by `name` (case-sensitive exact match). Keep vMix room
  names in Commander's profile aligned with crew room names on the Tracker
  Setup page; a mismatch silently drops that room from the operator's scope.

### `events/<eventId>/audit/<pushId>`

| | |
| --- | --- |
| **Path** | `events/<eventId>/audit/<pushId>` |
| **Writer** | Both apps (every user-initiated action) |
| **Reader** | Commander Log page |

**Shape:**

```ts
type AuditEntry = {
  timestamp: number;                         // epoch ms
  source: 'commander' | 'tracker';
  identity: { name: string; role: string };
  action: string;                            // e.g. 'START REC', 'STOP ALL', 'TOGGLE LOCK'
  room: string;                              // room.key, or '__all__' for cross-room actions
  result: 'ok' | 'fail' | 'denied';
};
```

**Notes:**

- Entries are append-only — never updated or deleted.
- Keep payloads small; do not embed stack traces or large blobs here (use
  `errors/` for those).
- Use `'__all__'` for cross-room actions such as STOP ALL or TOGGLE LOCK.

### `events/<eventId>/errors/<pushId>`

| | |
| --- | --- |
| **Path** | `events/<eventId>/errors/<pushId>` |
| **Writer** | Commander only (`window.onerror`, `onunhandledrejection`, Firebase write catch blocks) |
| **Reader** | Commander Log page (collapsible "Errors" section) |

**Shape:**

```ts
type ErrorEntry = {
  timestamp: number;
  source: 'commander';
  commanderId: string;
  identity: { name: string; role: string } | null;
  message: string;
  stack: string;
  context: string;  // free-form breadcrumb, e.g. 'refreshStatus(Bohemia2)'
};
```

**Notes:**

- Cap individual entries at ~8 KB; truncate `stack` and `message` as needed.
- Consider client-side pruning (keep last N or last 24h) to bound storage.

### `events/<eventId>/runOfShow`

| | |
| --- | --- |
| **Path** | `events/<eventId>/runOfShow` |
| **Writer** | Commander (pushed on profile save when sync is enabled) |
| **Reader** | Tracker (read-only schedule view on Recording page) |

**Shape:**

```ts
type RunOfShowItem = {
  id: string;
  time: string;     // display string, e.g. '09:30'
  title: string;
  room: string;     // room.key
  action: string;   // e.g. 'START REC'
  status: string;   // e.g. 'pending' | 'done'
  autoRun: boolean;
};
type RunOfShow = RunOfShowItem[];
```

### `events/<eventId>/roomLocks`

| | |
| --- | --- |
| **Path** | `events/<eventId>/roomLocks` |
| **Writer** | Commander (per-room lock toggle on room card) |
| **Reader** | Both apps |

**Shape:**

```ts
type RoomLocks = { [roomKey: string]: boolean };
```

**Semantics:** `true` means that specific room's start/stop buttons are
disabled in both apps. The global `controller.safetyLocked` always wins —
if the global lock is on, per-room values are irrelevant.

A mirror of this object is embedded in `vmixStatus/<eventId>/roomLocks` for
convenience; treat `events/<eventId>/roomLocks` as the source of truth.

### `events/<eventId>/roomProxyClaims/<roomKey>/<commanderId>`

| | |
| --- | --- |
| **Path** | `events/<eventId>/roomProxyClaims/<roomKey>/<commanderId>` |
| **Writer** | Commander (when that Commander can reach the room) |
| **Reader** | Tracker |

**Shape:**

```ts
type RoomProxyClaim = {
  url: string;         // this Commander's HTTPS Cloudflare tunnel
  commanderId: string;
  updatedAt: number;   // epoch ms
};
```

**Routing semantics:** Tracker chooses the freshest non-stale claim for the
room first. If no fresh claim exists, it falls back to the legacy
`roomProxies/<roomKey>` mirror, then `config.vmixProxyUrl`, then top-level
`vmix_proxy_url`.

### `events/<eventId>/roomProxies/<roomKey>` (legacy fallback)

Single-slot mirror retained for rollout compatibility with older Tracker
clients. New multi-Commander clients should read `roomProxyClaims` first.

---

### `vmixStatus/<eventId>/commanders/<commanderId>` (top-level, outside `events/`)

| | |
| --- | --- |
| **Path** | `vmixStatus/<eventId>/commanders/<commanderId>` |
| **Writer** | Commander (debounced ~400ms after state changes; immediate on lock / identity / profile switch) |
| **Reader** | Tracker (merged source of truth for Recording page) |

**Shape:**

```ts
type RoomStatus = {
  ok: boolean;
  recording: boolean;
  streaming: boolean;
  multicorder: boolean;
  latency: number;  // ms
  tier: 'healthy' | 'degraded' | 'unreachable' | 'offline';
  recordingStartTime: number | null;  // epoch ms, null when not recording
};

type VmixStatus = {
  commanderId: string;
  updatedAt: number;
  operator: { name: string; role: string } | null;
  safetyLocked: boolean;
  rooms: { [roomKey: string]: RoomStatus };
  roomLocks: { [roomKey: string]: boolean };  // mirror of events/<id>/roomLocks
};
```

**Merge semantics:** Tracker merges every Commander child. A room is live when
any fresh Commander reports it reachable; stale sources cannot keep a room
green. During rollout, Tracker also folds in the old flat
`vmixStatus/<eventId>` shape when present.

**Staleness:** Tracker treats one Commander status child as stale when
`Date.now() - updatedAt > 15_000`.

**Why it lives outside `events/`:** so Commander's own `events/<id>` snapshot
listener does not re-fire every time Commander pushes a status update.

---

### `vmix_proxy_url` (top-level, legacy)

| | |
| --- | --- |
| **Path** | `vmix_proxy_url` |
| **Writer** | Commander (written alongside the per-event `config.vmixProxyUrl`) |
| **Reader** | Tracker (fallback when per-event URL is absent) |

**Shape:** `string | null`

**Notes:** Global, not scoped to an event. Retained for backwards
compatibility; new code should prefer `events/<id>/config/vmixProxyUrl`.

### `vmix_ips/<key>` (top-level, legacy)

| | |
| --- | --- |
| **Path** | `vmix_ips/<roomKey>` |
| **Writer** | Tracker (when a user edits an IP locally) |
| **Reader** | Tracker |

**Shape:** `string` (vMix host IP).

**Notes:** Predates `events/<id>/config/vmixRooms`. Still written by Tracker
so older clients keep working. New development should read/write through the
per-event config instead.

### `deletedEvents/<eventId>`

| | |
| --- | --- |
| **Path** | `deletedEvents/<eventId>` |
| **Writer** | Tracker (on event delete) |
| **Reader** | Both apps |

**Shape:** `true` (tombstone marker).

**Notes:** Both apps should purge local caches for any event present here.
The tombstone is permanent — do not recycle event IDs.

---

## Change log

- **2026-04-17** — Added `controller`, `audit`, `errors`, `runOfShow`,
  `roomLocks`, and per-event `config.vmixProxyUrl`.
- **2026-04-17 (phase 2)** — Added optional `crewId` + `assignedRooms` to the
  `operator` payload in both `controller` and `vmixStatus`. Populated when a
  user signs in as a specific crew member from `config.crew`. Tracker's
  Recording page gains Director-only filter tabs per crew member.
- **2026-05-17** — Added per-Commander `presence`, per-Commander nested
  `vmixStatus`, and per-room `roomProxyClaims` so multiple Commanders on
  separate private networks can serve one event safely.

## Known gaps

- **Role gating is honor-system.** Director / Operator / Observer are chosen
  by the user and enforced only in client JavaScript. Proper enforcement
  requires per-user Firebase accounts with custom claims and RTDB security
  rules that read those claims — not currently implemented.
- **QR codes with `?proxy=` can go stale.** When the Cloudflare tunnel
  rotates, any printed or pre-shared QR pointing at the old URL stops
  working. Tracker self-heals by reading the current proxy URL from Firebase;
  QR codes that embed the URL do not.
- **`commanderId` is per-install, not per-user.** Two humans sharing one
  laptop look like the same controller. Reinstalling Commander (or clearing
  localStorage) generates a fresh `commanderId` and appears as a new
  controller.
