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

test('selectRoomProxyRoute keeps a recently working sticky claim while it is still fresh', () => {
  const now = 1_000_000;
  const route = selectRoomProxyRoute({
    roomKey: 'roomA',
    now,
    claimMap: {
      stable: { url: 'https://stable.example', commanderId: 'stable', updatedAt: now - 4_000 },
      fresh: { url: 'https://fresh.example', commanderId: 'fresh', updatedAt: now - 500 },
    },
    stickyRoute: {
      url: 'https://stable.example',
      commanderId: 'stable',
      selectedAt: now - 2_000,
    },
    stickyMs: 10_000,
  });

  assert.equal(route.url, 'https://stable.example');
  assert.equal(route.commanderId, 'stable');
  assert.equal(route.sticky, true);
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
  assert.equal(merged.rooms.roomA.updatedAt, now - 2000);
});

const { mergeVmixRoomLists } = require('../renderer/commander-routing-helpers');

test('mergeVmixRoomLists: a fresh install cannot wipe shared keys or IPs', () => {
  const shared = [
    { key: 'room_a', name: 'Small Hall', ip: '192.168.0.100' },
    { key: 'room_b', name: 'Panorama Hall', ip: '192.168.0.102' },
    { key: 'room_c', name: 'Club H', ip: '' },
  ];
  const freshInstall = [
    { key: 'room_new1', name: 'Small Hall', ip: '' },
    { key: 'room_new2', name: 'Panorama Hall', ip: '' },
    { key: 'room_new3', name: 'Forum Hall', ip: '192.168.0.101' },
  ];
  assert.deepEqual(mergeVmixRoomLists(shared, freshInstall), [
    { key: 'room_a', name: 'Small Hall', ip: '192.168.0.100' },
    { key: 'room_b', name: 'Panorama Hall', ip: '192.168.0.102' },
    { key: 'room_c', name: 'Club H', ip: '' },
    { key: 'room_new3', name: 'Forum Hall', ip: '192.168.0.101' },
  ]);
});

test('mergeVmixRoomLists: a local IP fills a blank shared IP but never replaces a set one', () => {
  const shared = [{ key: 'room_a', name: 'Club H', ip: '' }, { key: 'room_b', name: 'Club E', ip: '10.0.0.5' }];
  const local = [{ key: 'x', name: 'club h', ip: '10.0.0.4' }, { key: 'y', name: 'Club E', ip: '10.0.0.9' }];
  assert.deepEqual(mergeVmixRoomLists(shared, local), [
    { key: 'room_a', name: 'Club H', ip: '10.0.0.4' },
    { key: 'room_b', name: 'Club E', ip: '10.0.0.5' },
  ]);
});

test('mergeVmixRoomLists: empty or missing shared list takes the local rooms', () => {
  const local = [{ key: 'k1', name: 'Small Hall', ip: '1.2.3.4' }];
  assert.deepEqual(mergeVmixRoomLists(null, local), local);
  assert.deepEqual(mergeVmixRoomLists([], local), local);
});

const RO = require('../renderer/commander-routing-helpers');

test('sortRoomsByOrder follows the shared order and keeps unknown rooms after, in place', () => {
  const rooms = [{ name: 'Small Hall' }, { name: 'Club H' }, { name: 'Panorama Hall' }, { name: 'Forum Hall' }];
  assert.deepEqual(RO.sortRoomsByOrder(rooms, ['panorama hall', 'Small Hall']).map((r) => r.name),
    ['Panorama Hall', 'Small Hall', 'Club H', 'Forum Hall']);
  assert.deepEqual(RO.sortRoomsByOrder(rooms, null).map((r) => r.name), rooms.map((r) => r.name));
});

test('reorderRoomSubset moves only the crew member\'s rooms, others stay put', () => {
  const all = ['Small Hall', 'Club H', 'Panorama Hall', 'Club E', 'Forum Hall'];
  // Aleksei sees Small Hall, Panorama Hall, Forum Hall and drags Forum Hall to the top.
  assert.deepEqual(RO.reorderRoomSubset(null, all, ['Forum Hall', 'Small Hall', 'Panorama Hall']),
    ['Forum Hall', 'Club H', 'Small Hall', 'Club E', 'Panorama Hall']);
});

test('reorderRoomSubset respects an existing order and keeps rooms it does not know', () => {
  const all = ['A', 'B', 'C'];
  assert.deepEqual(RO.reorderRoomSubset(['C', 'A', 'B', 'Gone'], all, ['B', 'C']), ['B', 'A', 'C', 'Gone']);
});

test('START ALL / STOP ALL follow the event setting', () => {
  const start = ['StartRecording', 'StartMultiCorder', 'StartStreaming'];
  const stop = ['StopStreaming', 'StopMultiCorder', 'StopRecording'];
  assert.deepEqual(RO.filterActionSequence(start, null), start);
  assert.deepEqual(RO.filterActionSequence(start, ['record', 'multicorder']), ['StartRecording', 'StartMultiCorder']);
  // All-day MultiCorder event: sessions only start and stop REC + STREAM.
  assert.deepEqual(RO.filterActionSequence(stop, ['stream', 'record']), ['StopStreaming', 'StopRecording']);
  assert.deepEqual(RO.filterActionSequence(stop, ['bogus']), stop);
  assert.equal(RO.allActionLabel(null), 'ALL');
  assert.equal(RO.allActionLabel(['stream', 'record']), 'REC + STREAM');
  assert.equal(RO.allActionLabel(['multicorder', 'record', 'stream']), 'ALL');
});
