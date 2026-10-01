import assert from 'node:assert/strict';
import test from 'node:test';
import { collectVerificationReceipt, validateVerificationReceipt, verificationPartitions } from './verification-receipt.mjs';
const sha = 'a'.repeat(40);
const receipt = () => ({ schemaVersion: 1, gitSha: sha, runId: '123', runAttempt: 1,
  partitions: verificationPartitions.map((name, index) => ({ name, jobId: index + 1, conclusion: 'success',
    startedAt: '2026-09-30T00:00:00Z', completedAt: '2026-09-30T00:01:00Z' })) });
test('a complete execution receipt identifies every required partition', () => {
  assert.equal(validateVerificationReceipt(receipt(), sha).partitions.length, 33);
});
test('a skipped, failed, absent, duplicated or unexecuted partition refuses', () => {
  for (const conclusion of ['skipped', 'failure', null]) {
    const r = receipt(); r.partitions[0].conclusion = conclusion;
    assert.throws(() => validateVerificationReceipt(r, sha), /did not execute successfully: typecheck/);
  }
  const missing = receipt(); missing.partitions.pop();
  assert.throws(() => validateVerificationReceipt(missing, sha), /missing required/);
  const duplicate = receipt(); duplicate.partitions[1] = duplicate.partitions[0];
  assert.throws(() => validateVerificationReceipt(duplicate, sha), /duplicated/);
  const empty = receipt(); empty.partitions[0].startedAt = null;
  assert.throws(() => validateVerificationReceipt(empty, sha), /did not execute/);
});
test('short or borrowed source labels cannot identify verification', () => {
  assert.throws(() => validateVerificationReceipt(receipt(), sha.slice(0, 7)), /exact full source/);
  assert.throws(() => validateVerificationReceipt(receipt(), 'b'.repeat(40)), /exact full source/);
});
test('an unsuccessful API response is refused before JSON parsing', async () => {
  await assert.rejects(() => collectVerificationReceipt({ repository: 'owner/repo', runId: 123,
    runAttempt: 1, sha, token: 'fixture', fetchImpl: async () => ({ ok: false, status: 403,
      json: () => { throw new Error('must not parse'); } }) }), /could not be read \(403\)/);
});
