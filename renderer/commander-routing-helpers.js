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

  return {
    buildReachableRoomScope,
    commanderScopesOverlap,
    mergeMissingRoomsByName,
    buildPublishableRoomStatus,
    roomClaimKey,
    claimBelongsToEvent,
  };
});
