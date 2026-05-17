const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReachableRoomScope,
  commanderScopesOverlap,
  mergeMissingRoomsByName,
  roomClaimKey,
  claimBelongsToEvent,
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

test('roomClaimKey scopes claims by event, room, and commander', () => {
  assert.equal(roomClaimKey('ev1', 'roomA', 'cmd1'), 'ev1::roomA::cmd1');
});

test('claimBelongsToEvent identifies claims for cleanup', () => {
  assert.equal(claimBelongsToEvent('ev1::roomA::cmd1', 'ev1'), true);
  assert.equal(claimBelongsToEvent('ev2::roomA::cmd1', 'ev1'), false);
});
