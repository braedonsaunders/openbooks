import assert from 'node:assert/strict';
import test from 'node:test';
import config from '../web/next.config.mjs';

test('production page collection and generation stay within a single-worker budget', () => {
  assert.equal(config.experimental.cpus, 1);
  assert.equal(config.experimental.staticGenerationMaxConcurrency, 1);
  assert.equal(config.output, 'standalone');
});
