import test from 'node:test';
import assert from 'node:assert/strict';

test('concurrent preview lookups merge their cache entries', async () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.window = {};
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    head: {
      appendChild: (script) => {
        const request = new URL(script.src);
        const callback = request.searchParams.get('callback');
        const isAlpha = request.searchParams.get('term').includes('Alpha');
        const result = isAlpha
          ? { trackName: 'Alpha', artistName: 'Artist A', previewUrl: 'https://audio.test/alpha.m4a' }
          : { trackName: 'Beta', artistName: 'Artist B', previewUrl: 'https://audio.test/beta.m4a' };
        setTimeout(() => window[callback]({ results: [result] }), isAlpha ? 20 : 0);
      },
    },
  };

  const { findPreviewUrl } = await import(`../js/player.js?preview-test=${Date.now()}`);
  const [alpha, beta] = await Promise.all([
    findPreviewUrl({ id: 'alpha', name: 'Alpha', artists: [{ name: 'Artist A' }] }, 'US'),
    findPreviewUrl({ id: 'beta', name: 'Beta', artists: [{ name: 'Artist B' }] }, 'US'),
  ]);

  assert.equal(alpha, 'https://audio.test/alpha.m4a');
  assert.equal(beta, 'https://audio.test/beta.m4a');
  assert.deepEqual(JSON.parse(storage.get('likedle.previewCache.v2')), {
    alpha: 'https://audio.test/alpha.m4a',
    beta: 'https://audio.test/beta.m4a',
  });
});

test('does not start preview audio after playback was canceled', async () => {
  const storage = new Map();
  let answerLookup = null;
  let playCalls = 0;
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.window = {};
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    head: {
      appendChild: (script) => {
        const request = new URL(script.src);
        const callback = request.searchParams.get('callback');
        answerLookup = () => window[callback]({
          results: [{
            trackName: 'Canceled',
            artistName: 'Artist',
            previewUrl: 'https://audio.test/canceled.m4a',
          }],
        });
      },
    },
  };
  globalThis.Audio = class {
    constructor() {
      this.src = '';
      this.paused = true;
    }

    addEventListener() {}
    removeEventListener() {}
    load() {}
    pause() { this.paused = true; }
    play() {
      playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    }
  };

  const { playSnippet, stop } = await import(`../js/player.js?cancel-preview=${Date.now()}`);
  const playback = playSnippet(
    { id: 'canceled', name: 'Canceled', artists: [{ name: 'Artist' }] },
    0,
    1000,
    { mode: 'preview', country: 'US' },
  );
  while (!answerLookup) await new Promise((resolve) => setImmediate(resolve));
  await stop();
  answerLookup();

  await assert.rejects(playback, (error) => error.code === 'canceled');
  assert.equal(playCalls, 0);
});

test('pauses preview audio immediately while play is still pending', async () => {
  const storage = new Map();
  let rejectPlay;
  let signalPlayStarted;
  const playStarted = new Promise((resolve) => { signalPlayStarted = resolve; });
  let pauseCalls = 0;
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.window = {};
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    head: {
      appendChild: (script) => {
        const callback = new URL(script.src).searchParams.get('callback');
        queueMicrotask(() => window[callback]({
          results: [{
            trackName: 'Pending',
            artistName: 'Artist',
            previewUrl: 'https://audio.test/pending.m4a',
          }],
        }));
      },
    },
  };
  globalThis.Audio = class {
    constructor() {
      this.src = '';
      this.listeners = new Map();
    }

    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name) { this.listeners.delete(name); }
    load() { queueMicrotask(() => this.listeners.get('canplaythrough')?.()); }
    pause() {
      pauseCalls += 1;
      if (rejectPlay) rejectPlay(new DOMException('Playback was interrupted', 'AbortError'));
    }
    play() {
      signalPlayStarted();
      return new Promise((resolve, reject) => { rejectPlay = reject; });
    }
  };

  const { playSnippet, stop } = await import(`../js/player.js?pending-preview=${Date.now()}`);
  const playback = playSnippet(
    { id: 'pending', name: 'Pending', artists: [{ name: 'Artist' }] },
    0,
    1000,
    { mode: 'preview', country: 'US' },
  );
  await playStarted;
  await stop();

  assert.equal(pauseCalls, 1);
  await assert.rejects(playback, (error) => error.code === 'canceled');
});
