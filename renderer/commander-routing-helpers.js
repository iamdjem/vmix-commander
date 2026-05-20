(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CommanderRoutingHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function buildReachableRoomScope(rooms = {}) {
    return Object.keys(rooms).filter((key) => rooms[key] && rooms[key].ok);
  }

  function commanderScopesOverlap(a = [], b = []) {
    const set = new Set(a || []);
    return (b || []).some((key) => set.has(key));
  }

  function mergeMissingRoomsByName(current = [], incoming = [], makeKey) {
    const next = (current || []).map((room) => ({ ...room }));
    (incoming || []).forEach((room) => {
      const name = room && room.name ? String(room.name).trim() : '';
      if (!name) return;
      const exists = next.some((existing) =>
        String(existing.name || '').trim().toLowerCase() === name.toLowerCase()
      );
      if (!exists) next.push({ key: makeKey(), name, ip: '' });
    });
    return next;
  }

  function buildPublishableRoomStatus({
    rooms = [],
    statusByRoom = {},
    ownedRoomKeys = [],
  } = {}) {
    const owned = new Set(ownedRoomKeys || []);
    const nextOwned = new Set(owned);
    const publishable = {};

    (rooms || []).forEach((room) => {
      const key = room && room.key ? String(room.key) : '';
      if (!key) return;
      const status = statusByRoom[key] || {};
      if (status.ok) nextOwned.add(key);
      if (status.ok || owned.has(key)) {
        publishable[key] = status;
      }
    });

    return {
      rooms: publishable,
      ownedRoomKeys: Array.from(nextOwned),
    };
  }

  function roomClaimKey(eventId, roomKey, commanderId) {
    return `${eventId}::${roomKey}::${commanderId}`;
  }

  function claimBelongsToEvent(claimKey, eventId) {
    return String(claimKey || '').startsWith(`${eventId}::`);
  }


  const ROOM_PROXY_STALE_MS = 30_000;

  function freshRoute(route, now) {
    return !!(route && route.url && route.updatedAt && (now - route.updatedAt) < ROOM_PROXY_STALE_MS);
  }

  function selectRoomProxyRoute({
    roomKey,
    now = Date.now(),
    claimMap = {},
    legacyRoute = null,
    eventProxyUrl = '',
    globalProxyUrl = '',
    stickyRoute = null,
    stickyMs = 10_000,
  } = {}) {
    const claims = Object.values(claimMap || {})
      .filter((claim) => freshRoute(claim, now))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (stickyRoute && stickyRoute.url && stickyRoute.selectedAt && (now - stickyRoute.selectedAt) < stickyMs) {
      const stickyClaim = claims.find((claim) => (
        claim.url === stickyRoute.url &&
        (!stickyRoute.commanderId || claim.commanderId === stickyRoute.commanderId)
      ));
      if (stickyClaim) return { ...stickyClaim, source: 'claim', roomKey, sticky: true };
      if (legacyRoute && stickyRoute.source === 'legacy-room' && freshRoute(legacyRoute, now) && legacyRoute.url === stickyRoute.url) {
        return { ...legacyRoute, source: 'legacy-room', roomKey, sticky: true };
      }
      if (stickyRoute.source === 'event' && eventProxyUrl && eventProxyUrl === stickyRoute.url) {
        return { url: eventProxyUrl, source: 'event', roomKey, sticky: true };
      }
      if (stickyRoute.source === 'global' && globalProxyUrl && globalProxyUrl === stickyRoute.url) {
        return { url: globalProxyUrl, source: 'global', roomKey, sticky: true };
      }
    }

    if (claims[0]) return { ...claims[0], source: 'claim', roomKey };
    if (freshRoute(legacyRoute, now)) return { ...legacyRoute, source: 'legacy-room', roomKey };
    if (eventProxyUrl) return { url: eventProxyUrl, source: 'event', roomKey };
    if (globalProxyUrl) return { url: globalProxyUrl, source: 'global', roomKey };
    return { url: '', source: 'none', roomKey };
  }

  function normalizeRoomStatus(room, freshSource) {
    const fresh = !!freshSource;
    const ok = !!(room && room.ok) && fresh;
    return {
      ok,
      recording: fresh && !!(room && room.recording),
      streaming: fresh && !!(room && room.streaming),
      multicorder: fresh && !!(room && room.multicorder),
      latency: room && room.latency || 0,
      tier: !fresh ? 'offline' : (room && room.tier || (ok ? 'healthy' : 'unreachable')),
      recordingStartTime: fresh && room && room.recordingStartTime || null,
    };
  }

  function mergeCommanderStatus(raw, { now = Date.now(), staleMs = 15_000 } = {}) {
    if (!raw || typeof raw !== 'object') return raw || null;
    const sources = [];
    if (raw.commanders && typeof raw.commanders === 'object') {
      Object.keys(raw.commanders).forEach((id) => {
        const commander = raw.commanders[id];
        if (commander && typeof commander === 'object') sources.push(commander);
      });
    }
    if (raw.rooms && typeof raw.rooms === 'object') {
      sources.push({
        updatedAt: raw.updatedAt || 0,
        operator: raw.operator || null,
        safetyLocked: !!raw.safetyLocked,
        rooms: raw.rooms,
        roomLocks: raw.roomLocks || {},
      });
    }
    if (!sources.length) return raw;

    const merged = { updatedAt: 0, operator: null, safetyLocked: false, rooms: {}, roomLocks: {} };
    let freshestOpAt = -1;
    sources.forEach((source) => {
      const at = source.updatedAt || 0;
      const fresh = (now - at) < staleMs;
      if (at > merged.updatedAt) merged.updatedAt = at;
      if (source.safetyLocked) merged.safetyLocked = true;
      if (source.operator && at > freshestOpAt) {
        merged.operator = source.operator;
        freshestOpAt = at;
      }
      if (source.roomLocks) {
        Object.keys(source.roomLocks).forEach((key) => {
          if (source.roomLocks[key]) merged.roomLocks[key] = true;
        });
      }
      if (!source.rooms) return;
      Object.keys(source.rooms).forEach((key) => {
        const candidate = normalizeRoomStatus(source.rooms[key], fresh);
        candidate._at = at;
        if (at) candidate.updatedAt = at;
        const current = merged.rooms[key];
        if (!current || (candidate.ok && !current.ok) || (candidate.ok === current.ok && candidate._at > (current._at || 0))) {
          merged.rooms[key] = candidate;
        }
      });
    });
    Object.keys(merged.rooms).forEach((key) => { delete merged.rooms[key]._at; });
    return merged;
  }

  return {
    buildReachableRoomScope,
    commanderScopesOverlap,
    mergeMissingRoomsByName,
    buildPublishableRoomStatus,
    roomClaimKey,
    claimBelongsToEvent,
    ROOM_PROXY_STALE_MS,
    selectRoomProxyRoute,
    normalizeRoomStatus,
    mergeCommanderStatus,
  };
});
