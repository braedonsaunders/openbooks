import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Boundary proof for the silent export cap: exactly 50,000 parties export
// completely; 50,001 refuses by name instead of streaming a truncated file.
// Synthetic scratch orgs only; probe rows are bulk-deleted before teardown so
// the drop stays fast, then the fixture removes the org.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

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
  'exactly 50,000 parties export completely (no false positive at the cap)',
  // Bulk boundary by definition: a 50k-row insert plus full export shaping
  // measured ~50s under load against the 60s runner default, so this case
  // carries its own justified budget instead of flaking near the ceiling.
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
  '50,001 parties refuse by name instead of exporting a truncated file',
  // Same bulk-boundary budget as the exact-cap case above.
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
