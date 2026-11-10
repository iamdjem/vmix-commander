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

  // Merge this Commander's room list into the shared one without losing
  // anything. Rooms are matched by name. Shared room keys and IPs always
  // win; a local IP only fills a shared room that has none; rooms only one
  // side knows are kept. A fresh install (new keys, blank IPs) therefore
  // cannot wipe the IPs other Commanders configured.
  function mergeVmixRoomLists(remote, local) {
    const norm = (room) => ({
      key: room && room.key || '',
      name: room && room.name ? String(room.name).trim() : '',
      ip: room && room.ip || '',
    });
    const next = (Array.isArray(remote) ? remote : []).filter(Boolean).map(norm);
    (Array.isArray(local) ? local : []).filter(Boolean).map(norm).forEach((room) => {
      if (!room.name || !room.key) return;
      const hit = next.find((existing) => existing.name.toLowerCase() === room.name.toLowerCase());
      if (!hit) { next.push(room); return; }
      if (!hit.ip && room.ip) hit.ip = room.ip;
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

  // ── Shared room order (events/<id>/config/roomOrder: array of room names).
  // Both apps sort their room cards by it. Rooms missing from the list keep
  // their existing relative order after the ordered ones.
  function normRoomName(name) {
    return String(name == null ? '' : name).trim().toLowerCase();
  }

  function sortRoomsByOrder(rooms, order) {
    const list = Array.isArray(rooms) ? rooms.slice() : [];
    const idx = {};
    (Array.isArray(order) ? order : []).forEach((name, i) => {
      const key = normRoomName(name);
      if (key && !(key in idx)) idx[key] = i;
    });
    return list
      .map((room, i) => ({ room, i, at: idx[normRoomName(room && room.name)] }))
      .sort((a, b) => {
        const ao = a.at === undefined ? Infinity : a.at;
        const bo = b.at === undefined ? Infinity : b.at;
        return ao === bo ? a.i - b.i : ao - bo;
      })
      .map((x) => x.room);
  }

  // A crew member reorders only the rooms they can see. Put their new
  // sequence into the slots their rooms already occupy in the full order,
  // so everyone else's rooms stay exactly where they were.
  function reorderRoomSubset(currentOrder, allNames, newSubset) {
    const full = sortRoomsByOrder((allNames || []).map((name) => ({ name })), currentOrder).map((r) => r.name);
    (Array.isArray(currentOrder) ? currentOrder : []).forEach((name) => {
      if (!full.some((n) => normRoomName(n) === normRoomName(name))) full.push(name);
    });
    const subsetKeys = (newSubset || []).map(normRoomName);
    const slots = [];
    full.forEach((name, i) => { if (subsetKeys.includes(normRoomName(name))) slots.push(i); });
    const next = full.slice();
    const placed = (newSubset || []).filter((name) => full.some((n) => normRoomName(n) === normRoomName(name)));
    slots.forEach((slot, i) => { next[slot] = placed[i]; });
    return next;
  }

  // ── Which functions START ALL / STOP ALL control, per event
  // (events/<id>/config/allActionFns: subset of record, stream, multicorder).
  // Missing or empty means all three, which is the old behaviour.
  const ALL_ACTION_KEYS = ['record', 'stream', 'multicorder'];
  const ALL_ACTION_FN_KEY = {
    StartRecording: 'record', StopRecording: 'record',
    StartStreaming: 'stream', StopStreaming: 'stream',
    StartMultiCorder: 'multicorder', StopMultiCorder: 'multicorder',
  };
  const ALL_ACTION_SHORT = { record: 'REC', stream: 'STREAM', multicorder: 'MULTI' };

  function normalizeAllActionFns(enabled) {
    const list = Array.isArray(enabled) ? enabled.filter((k) => ALL_ACTION_KEYS.includes(k)) : [];
    return list.length ? ALL_ACTION_KEYS.filter((k) => list.includes(k)) : ALL_ACTION_KEYS.slice();
  }

  function filterActionSequence(sequence, enabled) {
    const keys = normalizeAllActionFns(enabled);
    return (sequence || []).filter((fn) => keys.includes(ALL_ACTION_FN_KEY[fn]));
  }

  // "ALL" when all three are on, otherwise e.g. "REC + STREAM".
  function allActionLabel(enabled) {
    const keys = normalizeAllActionFns(enabled);
    return keys.length === ALL_ACTION_KEYS.length ? 'ALL' : keys.map((k) => ALL_ACTION_SHORT[k]).join(' + ');
  }

  return {
    normalizeAllActionFns,
    filterActionSequence,
    allActionLabel,
    normRoomName,
    sortRoomsByOrder,
    reorderRoomSubset,
    buildReachableRoomScope,
    commanderScopesOverlap,
    mergeMissingRoomsByName,
    mergeVmixRoomLists,
    buildPublishableRoomStatus,
    roomClaimKey,
    claimBelongsToEvent,
    ROOM_PROXY_STALE_MS,
    selectRoomProxyRoute,
    normalizeRoomStatus,
    mergeCommanderStatus,
  };
});
