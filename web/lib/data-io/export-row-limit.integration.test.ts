import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Boundary proof for the export cap at a small test-only limit: rows export
// completely at the cap, and the next row refuses by name instead of truncating.
// Synthetic scratch orgs only; probe rows are bulk-deleted before teardown so
// the drop stays fast, then the fixture removes the org.
process.env.OPENBOOKS_TEST_EXPORT_ROW_LIMIT = '500'
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { MASTER_BY_KEY, masterResource } = await import('./master-data-resources.ts')
const { ExportRowLimitError, MAX_EXPORT_ROWS } = await import('./resource-core.ts')

async function partyCount(orgId: string): Promise<number> {
  const r = (await withBypass(() =>
    db.execute(sql`select count(*)::int as n from parties where org_id = ${orgId}`),
  )) as { rows: { n: number }[] }
  return r.rows[0]!.n
}

async function topUpParties(orgId: string, target: number, tag: string): Promise<void> {
  const have = await partyCount(orgId)
  assert.ok(have <= target, `fixture seeded ${have} parties, above target ${target}`)
  const need = target - have
  if (need === 0) return
  await withBypass(() =>
    db.execute(sql`
      insert into parties (id, org_id, short_code, display_name, kind)
      select gen_random_uuid(), ${orgId}, ${`${tag}-`} || g, ${`${tag} `} || g, 'company'
        from generate_series(1, ${need}) g`),
  )
  assert.equal(await partyCount(orgId), target)
}

async function deleteProbeParties(orgId: string, tag: string): Promise<void> {
  await withBypass(() =>
    db.execute(sql`delete from parties where org_id = ${orgId} and short_code like ${`${tag}-%`}`),
  )
}

test(
  `exactly ${MAX_EXPORT_ROWS.toLocaleString('en-US')} parties export completely (no false positive at the cap)`,
  { skip: !env.OPENBOOKS_DB_URL, timeout: 180_000 },
  async () => {
    const org = await withBypass(() => createScratchOrg())
    try {
      await topUpParties(org.orgId, MAX_EXPORT_ROWS, 'CAPEXACT')
      const resource = masterResource(MASTER_BY_KEY.get('parties')!, org.orgId)
      const result = await withOrgContext(org.orgId, () => resource.read())
      assert.equal(result.rows.length, MAX_EXPORT_ROWS)
    } finally {
      // Bulk-delete first so the drop stays fast. Nested finally: the org
      // drop still runs if the delete fails, and neither cleanup error is
      // swallowed into a passing run.
      try {
        await deleteProbeParties(org.orgId, 'CAPEXACT')
      } finally {
        await withBypass(() => dropScratchOrg(org.orgId))
      }
    }
  },
)

test(
  `${(MAX_EXPORT_ROWS + 1).toLocaleString('en-US')} parties refuse by name instead of exporting a truncated file`,
  { skip: !env.OPENBOOKS_DB_URL, timeout: 180_000 },
  async () => {
    const org = await withBypass(() => createScratchOrg())
    try {
      await topUpParties(org.orgId, MAX_EXPORT_ROWS + 1, 'CAPOVER')
      const resource = masterResource(MASTER_BY_KEY.get('parties')!, org.orgId)
      await assert.rejects(
        withOrgContext(org.orgId, () => resource.read()),
        (error: unknown) => {
          assert.ok(error instanceof ExportRowLimitError, `wrong refusal: ${String(error)}`)
          assert.equal(
            (error as InstanceType<typeof ExportRowLimitError>).code,
            'EXPORT_ROW_LIMIT_EXCEEDED',
          )
          assert.match((error as Error).message, /cannot be narrowed/)
          assert.match((error as Error).message, /500 rows/)
          assert.equal((error as InstanceType<typeof ExportRowLimitError>).limit, MAX_EXPORT_ROWS)
          return true
        },
      )
    } finally {
      // Same guarantee as above: drop runs even if the delete fails, and
      // neither cleanup error is swallowed into a passing run.
      try {
        await deleteProbeParties(org.orgId, 'CAPOVER')
      } finally {
        await withBypass(() => dropScratchOrg(org.orgId))
      }
    }
  },
)
