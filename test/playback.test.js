import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDevice } from '../js/spotify.js';

const device = (overrides = {}) => ({
  id: 'mac-current-id',
  name: 'Darahaas MacBook Pro',
  type: 'Computer',
  is_active: false,
  is_restricted: false,
  ...overrides,
});

test('resolves a selected device after Spotify changes its id', () => {
  const current = device();
  const resolved = resolveDevice([current], {
    deviceId: 'mac-stale-id',
    deviceName: current.name,
    deviceType: current.type,
  });

  assert.equal(resolved, current);
});

test('does not silently switch playback to a different device', () => {
  const resolved = resolveDevice([
    device({ id: 'phone-id', name: 'iPhone', type: 'Smartphone' }),
    device({ id: 'speaker-id', name: 'Kitchen', type: 'Speaker' }),
  ], {
    deviceId: 'missing-id',
    deviceName: 'Darahaas MacBook Pro',
    deviceType: 'Computer',
  });

  assert.equal(resolved, null);
});

test('rejects devices that Spotify marks as restricted', () => {
  const resolved = resolveDevice([
    device({ is_restricted: true }),
  ], {
    deviceId: 'mac-current-id',
    deviceName: 'Darahaas MacBook Pro',
    deviceType: 'Computer',
  });

  assert.equal(resolved, null);
});
