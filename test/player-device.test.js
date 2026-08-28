import test from 'node:test';
import assert from 'node:assert/strict';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('refreshes a stale device id before transferring and playing', async () => {
  const storage = new Map([
    ['likedle.tokens', JSON.stringify({
      access_token: 'test-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60_000,
    })],
  ]);
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };

  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url: String(url), method, body: options.body });
    if (String(url).endsWith('/me/player/devices')) {
      return jsonResponse({
        devices: [{
          id: 'fresh-id',
          name: 'My Mac',
          type: 'Computer',
          is_active: false,
          is_restricted: false,
        }],
      });
    }
    if (String(url).includes('/me/player/play?device_id=fresh-id')) {
      return new Response(null, { status: 204 });
    }
    if (String(url).includes('/me/player/pause?device_id=fresh-id')) {
      return new Response(null, { status: 204 });
    }
    if (String(url).endsWith('/me/player') && method === 'PUT') {
      return new Response(null, { status: 204 });
    }
    if (String(url).endsWith('/me/player') && method === 'GET') {
      return jsonResponse({
        device: { id: 'fresh-id' },
        item: { id: 'track-1', uri: 'spotify:track:track-1' },
        is_playing: true,
        progress_ms: 120,
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  const { playSnippet, stop } = await import(`../js/player.js?device-test=${Date.now()}`);
  const result = await playSnippet(
    { id: 'track-1', uri: 'spotify:track:track-1' },
    0,
    1000,
    {
      mode: 'device',
      deviceId: 'stale-id',
      deviceName: 'My Mac',
      deviceType: 'Computer',
    },
  );
  await stop();

  assert.equal(result.device.id, 'fresh-id');
  assert.equal(calls.some((call) => call.url.includes('device_id=stale-id')), false);
  assert.equal(calls.some((call) => call.url.includes('/me/player/play?device_id=fresh-id')), true);
  assert.deepEqual(JSON.parse(calls.find(
    (call) => call.url.endsWith('/me/player') && call.method === 'PUT',
  ).body), {
    device_ids: ['fresh-id'],
    play: false,
  });
});
