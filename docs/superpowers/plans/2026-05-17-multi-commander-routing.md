# Multi-Commander Routing Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one Tracker event reliably control multiple rooms through multiple Commander instances on separate networks.

**Architecture:** Commander will publish event-scoped per-room route claims under `roomProxyClaims/<roomKey>/<commanderId>` while preserving the legacy single-route mirror during rollout. Tracker will resolve routes per room from freshest claims first, then legacy fallbacks, and use that route consistently for controls, commands, and fallback polling. Commander conflict detection and room reconciliation will be hardened so multi-Commander deployments are valid and room sync avoids destructive whole-array overwrites.

**Tech Stack:** Electron main/renderer JavaScript, vanilla browser JavaScript, Firebase Realtime Database, Node.js test runner.

---

## File Structure

### `/Users/alex/vmix-commander`

- `renderer/app.js` — Commander coordination logic, room-route claim lifecycle, overlap detection, room reconciliation
- `docs/firebase-schema.md` — shared Commander/Tracker contract documentation
- `test/commander-routing.test.js` — extracted pure helpers for route-claim cleanup / overlap decisions / room upserts

### `/Users/alex/kubecon-tracker`

- `index.html` — Tracker route selection, UI enablement, fallback polling, diagnostics
- `sw.js` — cache/version bump for deploy visibility
- `test/tracker-routing.test.js` — extracted pure helpers for route selection and UI gating

---

### Task 1: Extract testable Commander helpers

**Files:**
- Create: `/Users/alex/vmix-commander/test/commander-routing.test.js`
- Modify: `/Users/alex/vmix-commander/renderer/app.js`

- [ ] **Step 1: Write the failing Commander helper tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildReachableRoomScope,
  commanderScopesOverlap,
  mergeMissingRoomsByName,
} = require('../renderer/commander-routing-helpers');

test('buildReachableRoomScope keeps only reachable room keys', () => {
  assert.deepEqual(buildReachableRoomScope({
    roomA: { ok: true },
    roomB: { ok: false },
    roomC: { ok: true },
  }), ['roomA', 'roomC']);
});

test('commanderScopesOverlap only flags shared reachable rooms', () => {
  assert.equal(commanderScopesOverlap(['roomA'], ['roomB']), false);
  assert.equal(commanderScopesOverlap(['roomA', 'roomB'], ['roomB', 'roomC']), true);
});

test('mergeMissingRoomsByName appends only absent rooms without touching existing ones', () => {
  const current = [{ key: 'roomA', name: 'Alpha', ip: '10.0.0.1' }];
  const incoming = [{ name: 'Alpha' }, { name: 'Beta' }];
  const next = mergeMissingRoomsByName(current, incoming, () => 'roomB');
  assert.deepEqual(next, [
    { key: 'roomA', name: 'Alpha', ip: '10.0.0.1' },
    { key: 'roomB', name: 'Beta', ip: '' },
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
node --test /Users/alex/vmix-commander/test/commander-routing.test.js
```

Expected: fail because `renderer/commander-routing-helpers.js` does not exist yet.

- [ ] **Step 3: Add minimal helper implementation**

```js
function buildReachableRoomScope(rooms = {}) {
  return Object.keys(rooms).filter((key) => rooms[key] && rooms[key].ok);
}

function commanderScopesOverlap(a = [], b = []) {
  const set = new Set(a);
  return b.some((key) => set.has(key));
}

function mergeMissingRoomsByName(current = [], incoming = [], makeKey) {
  const next = current.map((room) => ({ ...room }));
  incoming.forEach((room) => {
    const name = room && room.name ? String(room.name).trim() : '';
    if (!name) return;
    const exists = next.some((existing) => String(existing.name || '').trim().toLowerCase() === name.toLowerCase());
    if (!exists) next.push({ key: makeKey(), name, ip: '' });
  });
  return next;
}

module.exports = {
  buildReachableRoomScope,
  commanderScopesOverlap,
  mergeMissingRoomsByName,
};
```

- [ ] **Step 4: Run the Commander helper tests again**

Run:

```bash
node --test /Users/alex/vmix-commander/test/commander-routing.test.js
```

Expected: all tests pass.

---

### Task 2: Harden Commander route claims and overlap detection

**Files:**
- Modify: `/Users/alex/vmix-commander/renderer/app.js`
- Test: `/Users/alex/vmix-commander/test/commander-routing.test.js`

- [ ] **Step 1: Add failing tests for claim cleanup bookkeeping**

Extend `/Users/alex/vmix-commander/test/commander-routing.test.js` with:

```js
const {
  roomClaimKey,
  claimBelongsToEvent,
} = require('../renderer/commander-routing-helpers');

test('roomClaimKey scopes claims by event, room, and commander', () => {
  assert.equal(roomClaimKey('ev1', 'roomA', 'cmd1'), 'ev1::roomA::cmd1');
});

test('claimBelongsToEvent identifies claims for cleanup', () => {
  assert.equal(claimBelongsToEvent('ev1::roomA::cmd1', 'ev1'), true);
  assert.equal(claimBelongsToEvent('ev2::roomA::cmd1', 'ev1'), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
node --test /Users/alex/vmix-commander/test/commander-routing.test.js
```

Expected: fail because the new helper exports are missing.

- [ ] **Step 3: Implement the helper additions**

Add:

```js
function roomClaimKey(eventId, roomKey, commanderId) {
  return `${eventId}::${roomKey}::${commanderId}`;
}

function claimBelongsToEvent(claimKey, eventId) {
  return String(claimKey || '').startsWith(`${eventId}::`);
}
```

and export them.

- [ ] **Step 4: Update Commander production logic**

Implement in `renderer/app.js`:

- publish claim cells to `roomProxyClaims/<roomKey>/<COMMANDER_ID>`
- keep legacy mirror writes under `roomProxies/<roomKey>`
- store local claim refs by event+room+commander key
- add explicit cleanup on event switch, unlink, and disconnect
- log claim publish/remove events
- change concurrent-operator checks to compare live room scopes from presence entries, warning only on overlap
- use surgical room upserts for Operator reconciliation instead of whole-array rewrites

- [ ] **Step 5: Run Commander tests**

Run:

```bash
node --test /Users/alex/vmix-commander/test/commander-routing.test.js
```

Expected: all tests pass.

---

### Task 3: Extract testable Tracker routing helpers

**Files:**
- Create: `/Users/alex/kubecon-tracker/test/tracker-routing.test.js`
- Modify: `/Users/alex/kubecon-tracker/index.html`

- [ ] **Step 1: Write failing Tracker tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  selectRoomProxyRoute,
  roomHasUsableProxy,
} = require('../tracker-routing-helpers');

test('selectRoomProxyRoute prefers freshest per-commander claim', () => {
  const now = 100_000;
  const route = selectRoomProxyRoute({
    roomKey: 'roomA',
    now,
    claimMap: {
      cmdOld: { url: 'https://old.example', updatedAt: now - 5_000, commanderId: 'cmdOld' },
      cmdNew: { url: 'https://new.example', updatedAt: now - 1_000, commanderId: 'cmdNew' },
    },
    legacyRoute: { url: 'https://legacy.example', updatedAt: now - 500 },
    eventProxyUrl: 'https://event.example',
    globalProxyUrl: 'https://global.example',
  });
  assert.equal(route.url, 'https://new.example');
  assert.equal(route.source, 'claim');
});

test('selectRoomProxyRoute rejects stale claims and falls back to legacy', () => {
  const now = 100_000;
  const route = selectRoomProxyRoute({
    roomKey: 'roomA',
    now,
    claimMap: {
      cmdOld: { url: 'https://old.example', updatedAt: now - 31_000, commanderId: 'cmdOld' },
    },
    legacyRoute: { url: 'https://legacy.example', updatedAt: now - 1_000 },
    eventProxyUrl: 'https://event.example',
    globalProxyUrl: 'https://global.example',
  });
  assert.equal(route.url, 'https://legacy.example');
  assert.equal(route.source, 'legacy-room');
});

test('roomHasUsableProxy accepts a per-room claim even without a global proxy', () => {
  assert.equal(roomHasUsableProxy({
    roomKey: 'roomA',
    now: 100_000,
    claimMap: { cmd1: { url: 'https://room.example', updatedAt: 99_000 } },
  }), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test /Users/alex/kubecon-tracker/test/tracker-routing.test.js
```

Expected: fail because `tracker-routing-helpers.js` does not exist yet.

- [ ] **Step 3: Add minimal helper implementation**

```js
const ROOM_PROXY_STALE_MS = 30_000;

function fresh(route, now) {
  return route && route.url && route.updatedAt && (now - route.updatedAt) < ROOM_PROXY_STALE_MS;
}

function selectRoomProxyRoute({
  roomKey,
  now = Date.now(),
  claimMap = {},
  legacyRoute = null,
  eventProxyUrl = '',
  globalProxyUrl = '',
}) {
  const claims = Object.values(claimMap || {})
    .filter((claim) => fresh(claim, now))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (claims[0]) return { ...claims[0], source: 'claim', roomKey };
  if (fresh(legacyRoute, now)) return { ...legacyRoute, source: 'legacy-room', roomKey };
  if (eventProxyUrl) return { url: eventProxyUrl, source: 'event', roomKey };
  if (globalProxyUrl) return { url: globalProxyUrl, source: 'global', roomKey };
  return { url: '', source: 'none', roomKey };
}

function roomHasUsableProxy(input) {
  return !!selectRoomProxyRoute(input).url;
}

module.exports = {
  ROOM_PROXY_STALE_MS,
  selectRoomProxyRoute,
  roomHasUsableProxy,
};
```

- [ ] **Step 4: Run the Tracker routing tests again**

Run:

```bash
node --test /Users/alex/kubecon-tracker/test/tracker-routing.test.js
```

Expected: all tests pass.

---

### Task 4: Make Tracker use per-room routes consistently

**Files:**
- Modify: `/Users/alex/kubecon-tracker/index.html`
- Modify: `/Users/alex/kubecon-tracker/sw.js`
- Test: `/Users/alex/kubecon-tracker/test/tracker-routing.test.js`

- [ ] **Step 1: Extend Tracker tests for event/global fallback**

Add:

```js
test('selectRoomProxyRoute falls back from stale room routes to event then global proxy', () => {
  const eventRoute = selectRoomProxyRoute({
    roomKey: 'roomA',
    now: 100_000,
    claimMap: {},
    legacyRoute: null,
    eventProxyUrl: 'https://event.example',
    globalProxyUrl: 'https://global.example',
  });
  assert.equal(eventRoute.source, 'event');

  const globalRoute = selectRoomProxyRoute({
    roomKey: 'roomA',
    now: 100_000,
    claimMap: {},
    legacyRoute: null,
    eventProxyUrl: '',
    globalProxyUrl: 'https://global.example',
  });
  assert.equal(globalRoute.source, 'global');
});
```

- [ ] **Step 2: Run the Tracker tests to verify the new behavior is covered**

Run:

```bash
node --test /Users/alex/kubecon-tracker/test/tracker-routing.test.js
```

Expected: all tests pass once helper behavior is already present.

- [ ] **Step 3: Update Tracker production logic**

Implement in `index.html`:

- subscribe to `roomProxyClaims`
- keep legacy `roomProxies` subscription as fallback
- resolve routes through `selectRoomProxyRoute(...)`
- use the selected per-room route for:
  - card enablement
  - `vmixCall(...)`
  - `vmixGetStatus(...)`
  - warning copy
- add route-selection logging for commands and fallback polling
- update UI banner so it reports whether no rooms have routes, some rooms are missing routes, or all visible rooms are routable
- bump `APP_VERSION` and matching `sw.js` cache key

- [ ] **Step 4: Re-run Tracker tests**

Run:

```bash
node --test /Users/alex/kubecon-tracker/test/tracker-routing.test.js
```

Expected: all tests pass.

---

### Task 5: Update docs and verify both repos

**Files:**
- Modify: `/Users/alex/vmix-commander/docs/firebase-schema.md`

- [ ] **Step 1: Document the new shared schema**

Update `docs/firebase-schema.md` to include:

- `events/<eventId>/presence/<commanderId>`
- `events/<eventId>/roomProxyClaims/<roomKey>/<commanderId>`
- legacy `roomProxies/<roomKey>` fallback behavior
- nested `vmixStatus/<eventId>/commanders/<commanderId>`
- route-selection priority and staleness behavior

- [ ] **Step 2: Run verification in Commander**

Run:

```bash
node --test /Users/alex/vmix-commander/test/commander-routing.test.js
```

Expected: pass.

- [ ] **Step 3: Run verification in Tracker**

Run:

```bash
node --test /Users/alex/kubecon-tracker/test/tracker-routing.test.js
```

Expected: pass.

- [ ] **Step 4: Manually inspect changed flows**

Verify in code review that:

- all claim cleanup paths run on event switch/unlink/disconnect
- Tracker commands and fallback polling call the same per-room route resolver
- no remaining Operator reconciliation path does a whole-array overwrite for mere room additions

