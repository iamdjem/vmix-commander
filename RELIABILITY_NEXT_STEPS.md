# Reliability next steps for Tracker and vMix Commander

Last updated: 2026-05-20

This note captures the reliability architecture discussion so future implementation work does not restart from memory. The goal is to make remote room control faster, more stable, and safer for live production.

## Current production issue

The Tracker web app and Commander desktop app can show different room states at the same time, even when they are opened at the same URL. A room may briefly appear reachable in one browser and unreachable in another. Record, Stream, and MultiCorder states can flicker between LIVE, OFF, and ERR.

The main causes are likely:

1. Status is currently derived from repeated browser or Commander polling through room tunnel routes.
2. A single transient vMix, tunnel, mobile browser, or Firebase timing issue can be rendered as a real room failure.
3. Multiple clients can observe different local timing, service worker cache state, mobile browser throttling, and Firebase connection state.
4. The UI does not always make status age clear, so an old but stable status and a fresh failed poll can look equally authoritative.
5. Quick Cloudflare tunnels are useful for testing, but they are not the best production-grade transport for critical control and status.

## Important principle

The UI should not be the source of truth for room status. The owning Commander should be the source of truth for the rooms it can actually reach.

Trackers and remote Commanders should mostly subscribe to confirmed room state and submit commands. They should not normally probe every room directly through tunnels to decide whether the room is alive.

## Recommended target architecture

```text
Tracker mobile / browser UI
Desktop Commander UI
        |
        | command request
        v
Firebase command queue or dedicated realtime backend
        |
        | assigned room owner
        v
Owning Commander on the room network
        |
        | local control
        v
vMix HTTP API or vMix TCP API
        |
        | confirmed result and status
        v
Owning Commander publishes canonical room status
        |
        | realtime subscription
        v
Tracker and all Commander UIs render the same status
```

## Why this is better

- One process owns each room status.
- Every UI sees the same canonical state.
- Commands can have acknowledgements, results, errors, and timeouts.
- The app can distinguish stale status from failed status.
- Mobile browsers do less background polling, which improves reliability.
- Remote control does not depend on every browser choosing the correct tunnel at the correct instant.

## Implementation phases

### Phase 1: Make current status display trustworthy

Add these without changing the whole architecture:

- Add `updatedAt`, `serverUpdatedAt`, and a monotonic `seq` to every room status write.
- Display status age on room cards, for example `updated 0.8s ago` or `stale 12s`.
- Preserve the last known good LIVE/OFF state through short transient failures.
- Only show ERR after repeated failures or when status age exceeds the grace window.
- Make stale state visually different from unreachable state.
- Add debug fields in the UI or logs: owner commander, tunnel URL host, last error, consecutive failures.

Current partial fix already added transient smoothing, but future work should make status age and ownership visible.

### Phase 2: Create one canonical status path per room

Move from merged per-Commander status to a clear room-owned status model.

Suggested Firebase paths:

```text
events/<eventId>/roomOwners/<roomKey>
  commanderId
  ownerLabel
  leaseUntil
  updatedAt

events/<eventId>/roomStatus/<roomKey>
  roomKey
  commanderId
  seq
  updatedAt
  serverUpdatedAt
  reachable
  stale
  record
  stream
  multiCorder
  recordingStartTime
  latencyMs
  consecutiveFailures
  lastError
```

Rules:

- Only the active owner Commander writes `roomStatus/<roomKey>`.
- Owner lease must be refreshed frequently.
- Another Commander may take over only if the lease expires or explicit takeover is requested.
- Tracker and remote Commander UIs subscribe to `roomStatus` for their visible rooms.

### Phase 3: Move control actions to a command queue

Instead of the UI calling a tunnel directly for Start/Stop, write a command request. The owning Commander executes it locally and writes the result.

Suggested Firebase paths:

```text
events/<eventId>/commands/<roomKey>/<commandId>
  commandId
  roomKey
  fn
  requestedBy
  requestedAt
  status: pending | accepted | running | succeeded | failed | expired
  clientRequestId

events/<eventId>/commandResults/<commandId>
  commandId
  roomKey
  commanderId
  status
  startedAt
  finishedAt
  durationMs
  vmixResponse
  error
```

Commander behavior:

1. Listen only to commands for rooms it owns.
2. Mark command `accepted` quickly.
3. Execute against local vMix.
4. Write `succeeded` or `failed` with the actual vMix result.
5. Immediately publish a fresh canonical room status.

UI behavior:

1. Optimistically show `Starting...` or `Stopping...` only for that command.
2. Disable duplicate clicks while a command is pending.
3. Show success only after Commander confirms it.
4. Show clear failure text if the owning Commander rejects, times out, or cannot reach vMix.

### Phase 4: Improve vMix status collection

Investigate replacing or supplementing repeated HTTP `/api` polling with the vMix TCP API.

Potential benefits:

- Lower overhead than repeated HTTP calls.
- More continuous status updates.
- Better suited for a local Commander that is always next to vMix.

Keep HTTP API support as fallback because it is simple and already working.

### Phase 5: Replace quick tunnels for production control

Cloudflare Quick Tunnels are convenient for temporary testing, but production workflows should consider:

- Named Cloudflare Tunnels with stable routing.
- Cloudflare Access or another auth layer.
- A dedicated WebSocket backend near the venue or near the users.
- MQTT, NATS, or another realtime command/status bus if the system grows.

The current quick tunnel can remain for setup, demos, and emergency fallback.

## Reliability rules for critical production workflows

- Never clear LIVE status just because one poll failed.
- Never show a room as unreachable without showing status age and failure count.
- Never let two Commanders actively own the same room unless failover is explicit.
- Every command needs an acknowledgement and a final result.
- Every state update needs a sequence number and timestamp.
- The UI must distinguish these states:
  - fresh and healthy
  - fresh but failed
  - stale but last known good
  - owner offline
  - no owner assigned
- Start All and Stop All should be sequenced, not blasted at vMix all at once.
- Status rendering should be based on canonical room status, not local browser polling races.

## Practical next implementation task

The next strong implementation step should be:

1. Add canonical `roomStatus/<roomKey>` writes from Commander.
2. Add status age and owner label to Tracker and Commander cards.
3. Read from `roomStatus` first, with existing merged status as fallback.
4. Add a command queue for Start/Stop in Tracker.
5. Then move Commander desktop controls to the same command queue.

This gives immediate stability without throwing away the current working tunnel logic.

## Testing checklist

Use at least two browsers and one phone at the same time:

- Open the same event and same crew filter on all clients.
- Confirm all clients show the same owner per room.
- Confirm all clients show similar status age.
- Stop one Commander and verify rooms become stale first, then owner offline.
- Restart Commander and verify room ownership recovers cleanly.
- Start and stop Record, Stream, and MultiCorder from Tracker.
- Start and stop the same functions from a remote Commander UI.
- Confirm commands show pending, success, or failure consistently on every client.
- Confirm a single dropped status poll does not remove LIVE or OFF state.
