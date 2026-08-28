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
