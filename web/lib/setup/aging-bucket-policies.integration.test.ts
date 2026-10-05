import assert from 'node:assert/strict'
import test from 'node:test'
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createSetupRecord, updateSetupRecord, deleteSetupRecord } = await import('./write.ts')

/** Driver error text lives on the cause chain, not the wrapper message. */
function pgRefusalText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  while (current instanceof Error && parts.length < 4) {
    parts.push(current.message)
    current = (current as { cause?: unknown }).cause
  }
  return parts.join('\n')
}
const { agingBucketPolicyFor, agingBucketIndex } = await import('@openbooks/engine/organization/aging-buckets')

async function adminOrg() {
  const org = await withBypass(() => createScratchOrg())
  const actor = await withBypass(() => createScratchUser(org.orgId, 'Setup Admin', 'admin'))
  await withBypass(() => db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`))
  return { org, asAdmin: { orgId: org.orgId, id: actor as unknown as string, permissions: ['*'] as Iterable<string> } }
}

// With no policy configured the declared default governs: the historical
// 30/60/90 buckets, with ninety days past due already in the final bucket.
test('no policy resolves the declared 30/60/90 default', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await adminOrg()
  try {
    const policy = await agingBucketPolicyFor(org.orgId, '2026-07-01')
    assert.equal(policy.source, 'default')
    assert.deepEqual([...policy.boundaries], [30, 60, 90])
    assert.equal(agingBucketIndex(90, policy.boundaries), 4)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// A configured ladder governs its window; an overlapping window 409s with
// the remedy instead of echoing Postgres, while the adjacent window saves.
test('configured ladders govern by window; overlaps conflict typed', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    const first = await withBypass(() => createSetupRecord(asAdmin, 'aging-bucket-policies', {
      boundaries: [7, 14], effectiveFrom: '2026-01-01', isActive: true,
    }))
    assert.equal(first.status, 200)

    const january = await agingBucketPolicyFor(org.orgId, '2026-01-15')
    assert.equal(january.source, 'policy')
    assert.deepEqual([...january.boundaries], [7, 14])
    assert.equal(agingBucketIndex(14, january.boundaries), 3)

    const retry = await withBypass(() => createSetupRecord(asAdmin, 'aging-bucket-policies', {
      boundaries: [30, 60, 90], effectiveFrom: '2026-06-01', isActive: true,
    }))
    assert.equal(retry.status, 409)
    assert.equal((retry.body as { code?: string }).code, 'overlap')
    assert.match(String((retry.body as { error?: string }).error ?? ''), /effective-to/)
    assert.doesNotMatch(String((retry.body as { error?: string }).error ?? ''), /exclusion|conflicting key|SQLSTATE|gist/i)

    // Closing the first window first makes the adjacent ladder save and take
    // over in July: the refusal above is about the overlap, never a ban.
    const firstId = String((first.body as { id: string }).id)
    const closed = await withBypass(() => updateSetupRecord(asAdmin, 'aging-bucket-policies', { id: firstId, effectiveTo: '2026-06-30' }))
    assert.equal(closed.status, 200)

    // Rewriting a ladder in place and deleting a version stay refused:
    // versions deactivate, never rewrite or cascade away.
    const rewritten = await withBypass(() => updateSetupRecord(asAdmin, 'aging-bucket-policies', { id: firstId, boundaries: [30, 60] }))
    assert.equal(rewritten.status, 400)
    assert.match(String((rewritten.body as { error?: string }).error ?? ''), /immutable/)
    const deleted = await withBypass(() => deleteSetupRecord(asAdmin, 'aging-bucket-policies', firstId))
    assert.equal(deleted.status, 405)

    // The database guard backstops the API.
    await assert.rejects(
      withBypass(() => db.execute(sql`update aging_bucket_policies set boundaries = '{30}' where id = ${firstId}`)),
      (error: unknown) => {
        assert.match(pgRefusalText(error), /immutable/)
        return true
      },
    )
    await assert.rejects(
      withBypass(() => db.execute(sql`delete from aging_bucket_policies where id = ${firstId}`)),
      (error: unknown) => {
        assert.match(pgRefusalText(error), /history is preserved/)
        return true
      },
    )
    const adjacent = await withBypass(() => createSetupRecord(asAdmin, 'aging-bucket-policies', {
      boundaries: [30, 60, 90], effectiveFrom: '2026-07-01', isActive: true,
    }))
    assert.equal(adjacent.status, 200)

    const july = await agingBucketPolicyFor(org.orgId, '2026-07-01')
    assert.equal(july.source, 'policy')
    assert.deepEqual([...july.boundaries], [30, 60, 90])
    assert.equal(agingBucketIndex(90, july.boundaries), 4)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// The drawer sends the whole form on every save: an unchanged ladder in any
// normalization still closes the window, while a changed ladder refuses with
// the new-version remedy.
test('a full-form save that changes nothing closes the window', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    const created = await withBypass(() => createSetupRecord(asAdmin, 'aging-bucket-policies', {
      boundaries: [7, 14], effectiveFrom: '2026-01-01', isActive: true,
    }))
    assert.equal(created.status, 200)
    const id = String((created.body as { id: string }).id)
    const closed = await withBypass(() => updateSetupRecord(asAdmin, 'aging-bucket-policies', {
      id, boundaries: '[7, 14]', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', isActive: true,
    }))
    assert.equal(closed.status, 200)

    const moved = await withBypass(() => updateSetupRecord(asAdmin, 'aging-bucket-policies', {
      id, boundaries: [7, 14, 21], effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', isActive: true,
    }))
    assert.equal(moved.status, 400)
    assert.match(String((moved.body as { error?: string }).error ?? ''), /immutable/)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})

// Ladders that are empty, unordered or out of range refuse with the remedy
// before the storage guard ever sees them.
test('malformed ladders refuse with the remedy', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const { org, asAdmin } = await adminOrg()
  try {
    for (const boundaries of [[], [14, 7], [0, 30], [30, 30]]) {
      const attempt = await withBypass(() => createSetupRecord(asAdmin, 'aging-bucket-policies', {
        boundaries, effectiveFrom: '2026-01-01', isActive: true,
      }))
      assert.equal(attempt.status, 400, `boundaries ${JSON.stringify(boundaries)}`)
      assert.match(String((attempt.body as { error?: string }).error ?? ''), /Boundaries are/)
    }
    // Non-JSON text never reaches the ladder check: the generic JSON grammar
    // refuses it first, still as a named 400.
    const text = await withBypass(() => createSetupRecord(asAdmin, 'aging-bucket-policies', {
      boundaries: 'thirty', effectiveFrom: '2026-01-01', isActive: true,
    }))
    assert.equal(text.status, 400)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})
