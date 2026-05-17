const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReachableRoomScope,
  commanderScopesOverlap,
  mergeMissingRoomsByName,
  buildPublishableRoomStatus,
  roomClaimKey,
  claimBelongsToEvent,
  selectRoomProxyRoute,
  mergeCommanderStatus,
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

test('buildPublishableRoomStatus omits rooms this Commander has never reached', () => {
  const result = buildPublishableRoomStatus({
    rooms: [{ key: 'roomA' }, { key: 'roomB' }, { key: 'roomC' }],
    statusByRoom: {
      roomA: { ok: false, tier: 'unreachable' },
      roomB: { ok: true, tier: 'healthy' },
      roomC: { ok: false, tier: 'unreachable' },
    },
    ownedRoomKeys: [],
  });

  assert.deepEqual(Object.keys(result.rooms), ['roomB']);
  assert.deepEqual(result.ownedRoomKeys, ['roomB']);
});

test('buildPublishableRoomStatus keeps offline status for rooms this Commander owned before', () => {
  const result = buildPublishableRoomStatus({
    rooms: [{ key: 'roomA' }, { key: 'roomB' }],
    statusByRoom: {
      roomA: { ok: false, tier: 'unreachable' },
      roomB: { ok: false, tier: 'unreachable' },
    },
    ownedRoomKeys: ['roomA'],
  });

  assert.deepEqual(Object.keys(result.rooms), ['roomA']);
  assert.equal(result.rooms.roomA.ok, false);
  assert.deepEqual(result.ownedRoomKeys, ['roomA']);
});

test('roomClaimKey scopes claims by event, room, and commander', () => {
  assert.equal(roomClaimKey('ev1', 'roomA', 'cmd1'), 'ev1::roomA::cmd1');
});

test('claimBelongsToEvent identifies claims for cleanup', () => {
  assert.equal(claimBelongsToEvent('ev1::roomA::cmd1', 'ev1'), true);
  assert.equal(claimBelongsToEvent('ev2::roomA::cmd1', 'ev1'), false);
});

test('selectRoomProxyRoute chooses the freshest per-room claim', () => {
  const now = 1_000_000;
  const route = selectRoomProxyRoute({
    roomKey: 'roomA',
    now,
    claimMap: {
      old: { url: 'https://old.example', commanderId: 'old', updatedAt: now - 10_000 },
      fresh: { url: 'https://fresh.example', commanderId: 'fresh', updatedAt: now - 1_000 },
    },
    eventProxyUrl: 'https://event.example',
  });

  assert.equal(route.url, 'https://fresh.example');
  assert.equal(route.commanderId, 'fresh');
  assert.equal(route.source, 'claim');
});

test('selectRoomProxyRoute ignores stale claims before falling back', () => {
  const now = 1_000_000;
  const route = selectRoomProxyRoute({
    roomKey: 'roomA',
    now,
    claimMap: {
      stale: { url: 'https://stale.example', commanderId: 'stale', updatedAt: now - 60_000 },
    },
    eventProxyUrl: 'https://event.example',
  });

  assert.equal(route.url, 'https://event.example');
  assert.equal(route.source, 'event');
});

test('mergeCommanderStatus prefers reachable fresh room reports over unreachable reports', () => {
  const now = 1_000_000;
  const merged = mergeCommanderStatus({
    commanders: {
      one: {
        updatedAt: now - 1000,
        rooms: { roomA: { ok: false, tier: 'unreachable' } },
      },
      two: {
        updatedAt: now - 2000,
        rooms: { roomA: { ok: true, tier: 'healthy', streaming: true, latency: 12 } },
      },
    },
  }, { now, staleMs: 15_000 });

  assert.equal(merged.rooms.roomA.ok, true);
  assert.equal(merged.rooms.roomA.streaming, true);
  assert.equal(merged.rooms.roomA.latency, 12);
});
