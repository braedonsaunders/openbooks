// source-pin-contract: Production Docker build limits and informational workflow triggers are deployment configuration contracts read from their authoritative files.
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

test('the production image uses isolated Webpack compilation within its heap budget', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^RUN cd web && NODE_OPTIONS=--max-old-space-size=6144 npx next build --webpack$/m);
});

test('production compilers bound module work without retaining a build cache', () => {
  for (const nextRuntime of ['nodejs', 'edge', undefined]) {
    const webpackConfig = {
      context: new URL('../web', import.meta.url).pathname,
      parallelism: 100,
      cache: { type: 'filesystem', maxMemoryGenerations: Infinity },
      resolve: { alias: { existing: 'preserved' } },
    };
    const result = config.webpack(webpackConfig, { dev: false, nextRuntime });
    assert.equal(result, webpackConfig);
    assert.equal(result.parallelism, 1);
    assert.equal(result.cache, false);
    assert.equal(result.resolve.alias.existing, 'preserved');
    assert.match(result.resolve.alias['next-intl/config'], /i18n\/request\.ts$/);
  }
});

test('development keeps its existing compiler concurrency and cache', () => {
  const cache = { type: 'filesystem', maxMemoryGenerations: 0 };
  const webpackConfig = {
    context: new URL('../web', import.meta.url).pathname,
    parallelism: 100,
    cache,
  };
  const result = config.webpack(webpackConfig, { dev: true });
  assert.equal(result.parallelism, 100);
  assert.equal(result.cache, cache);
});

test('the informational stats card does not start CI or mutate main on routine updates', () => {
  const workflow = readFileSync(new URL('../.github/workflows/codeflow-card.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\n\s+workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/m);
});
