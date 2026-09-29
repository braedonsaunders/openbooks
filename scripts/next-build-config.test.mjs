import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import config from '../web/next.config.mjs';

test('production page collection and generation stay within a single-worker budget', () => {
  assert.equal(config.experimental.cpus, 1);
  assert.equal(config.experimental.staticGenerationMaxConcurrency, 1);
  assert.equal(config.experimental.webpackBuildWorker, true);
  assert.equal(config.experimental.webpackMemoryOptimizations, true);
  assert.equal(config.output, 'standalone');
});

test('the production image uses the bounded-heap Webpack build', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /RUN cd web && NODE_OPTIONS=--max-old-space-size=3072 npx next build --webpack/);
});

test('the informational stats card does not start CI or mutate main on routine updates', () => {
  const workflow = readFileSync(new URL('../.github/workflows/codeflow-card.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\n\s+workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/m);
});
