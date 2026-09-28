// source-pin-contract: Published migration 0455 has immutable deployment bytes and an explicit no-preflight decision; database behavior cannot prove either artifact stays unchanged.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('published normalization migration retains its additive deployment contract', () => {
  const migration = readFileSync(new URL('./generated/0455_saas_metrics_normalization_evidence.sql', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(migration).digest('hex'), 'bba2df76821f47425373310e52432a0a77a0c2e4100a9558062a3a9b2ba50bd2', 'published migration bytes must not change; ship a forward migration');
  const body = migration.replace(/--[^\n]*/g, '');
  assert.ok(!/^\s*UPDATE\s+public\./m.test(body), '0455 performs zero UPDATE');
  assert.ok(!/^\s*DELETE\s+FROM\s+public\./m.test(body), '0455 performs zero DELETE');
  const decision = readFileSync(new URL('./preflight/0455_saas_metrics_normalization_evidence.none', import.meta.url), 'utf8');
  assert.ok(decision.replace(/\s/g, '').length >= 20, '0455 preflight .none must record why no preflight is needed');
});
