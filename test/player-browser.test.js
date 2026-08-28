import test from 'node:test';
import assert from 'node:assert/strict';

test('tracks browser receiver lifecycle and activates from a click gesture', async () => {
  let instance = null;
  let isPlaying = false;
  let deviceFetches = 0;
  const events = [];
  class FakeSpotifyPlayer {
    constructor() {
      this.listeners = new Map();
      this.activated = 0;
      instance = this;
    }

    addListener(name, listener) {
      this.listeners.set(name, listener);
    }

    connect() {
      queueMicrotask(() => this.listeners.get('ready')({ device_id: 'browser-id' }));
      return Promise.resolve(true);
    }

    activateElement() {
      this.activated += 1;
      events.push('activate');
      return Promise.resolve();
    }

    getCurrentState() {
      return Promise.resolve({
        paused: !isPlaying,
        loading: false,
        position: isPlaying ? 120 : 0,
        track_window: {
          current_track: { uri: 'spotify:track:track-1' },
        },
      });
    }

    pause() {
      isPlaying = false;
      return Promise.resolve();
    }

    disconnect() {}
  }

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
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (String(url).endsWith('/me/player/devices')) {
      events.push('fetch-devices');
      deviceFetches += 1;
      return new Response(JSON.stringify({
        devices: [{
          id: deviceFetches === 1 ? 'other-tab-id' : 'browser-id',
          name: 'Likedle browser',
          type: 'Computer',
          is_active: true,
          is_restricted: false,
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/me/player') && method === 'PUT') {
      return new Response(null, { status: 204 });
    }
    if (String(url).includes('/me/player/play?device_id=browser-id')) {
      isPlaying = true;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  globalThis.window = { Spotify: { Player: FakeSpotifyPlayer } };
  const {
    prepareBrowserReceiver,
    activateBrowserElement,
    getBrowserReceiverStatus,
    playSnippet,
    stop,
  } = await import(`../js/player.js?browser-test=${Date.now()}`);

  await prepareBrowserReceiver();

  assert.equal(getBrowserReceiverStatus().state, 'ready');
  assert.equal(activateBrowserElement(), true);
  assert.equal(instance.activated, 1);
  assert.deepEqual(
    [...instance.listeners.keys()].sort(),
    [
      'account_error',
      'authentication_error',
      'autoplay_failed',
      'initialization_error',
      'not_ready',
      'playback_error',
      'ready',
    ],
  );

  instance.listeners.get('autoplay_failed')();
  assert.deepEqual(getBrowserReceiverStatus(), {
    state: 'error',
    message: 'Your browser blocked Spotify audio. Press Play again.',
  });

  activateBrowserElement();
  await playSnippet(
    { id: 'track-1', uri: 'spotify:track:track-1' },
    0,
    1000,
    { mode: 'browser' },
  );

  assert.equal(getBrowserReceiverStatus().state, 'playing');
  assert.ok(events.indexOf('activate') < events.indexOf('fetch-devices'));
  assert.equal(deviceFetches, 2);
  await stop();
  assert.equal(getBrowserReceiverStatus().state, 'ready');

  instance.listeners.get('not_ready')();
  activateBrowserElement();
  await assert.rejects(
    playSnippet(
      { id: 'track-1', uri: 'spotify:track:track-1' },
      0,
      1000,
      { mode: 'browser' },
    ),
    (error) => error.code === 'gesture-required',
  );
  assert.equal(getBrowserReceiverStatus().message, 'Ready - press Play again');

  activateBrowserElement();
  await playSnippet(
    { id: 'track-1', uri: 'spotify:track:track-1' },
    0,
    1000,
    { mode: 'browser' },
  );
  await stop();

  let rejectSupersededActivation;
  let activationCalls = 0;
  instance.activateElement = () => {
    activationCalls += 1;
    if (activationCalls === 1) {
      return new Promise((resolve, reject) => {
        rejectSupersededActivation = reject;
      });
    }
    return Promise.resolve();
  };
  activateBrowserElement();
  activateBrowserElement();
  rejectSupersededActivation(new Error('Earlier activation failed late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getBrowserReceiverStatus().state, 'ready');
  await playSnippet(
    { id: 'track-1', uri: 'spotify:track:track-1' },
    0,
    1000,
    { mode: 'browser' },
  );
  await stop();

  let rejectStaleActivation;
  instance.activateElement = () => new Promise((resolve, reject) => {
    rejectStaleActivation = reject;
  });
  activateBrowserElement();
  instance.listeners.get('not_ready')();
  await assert.rejects(
    playSnippet(
      { id: 'track-1', uri: 'spotify:track:track-1' },
      0,
      1000,
      { mode: 'browser' },
    ),
    (error) => error.code === 'gesture-required',
  );
  rejectStaleActivation(new Error('Old player failed late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getBrowserReceiverStatus().message, 'Ready - press Play again');

  instance.activateElement = () => {
    throw new Error('Protected audio activation failed');
  };
  assert.equal(activateBrowserElement(), false);
  await assert.rejects(
    playSnippet(
      { id: 'track-1', uri: 'spotify:track:track-1' },
      0,
      1000,
      { mode: 'browser' },
    ),
    (error) => error.code === 'gesture-required',
  );
});
