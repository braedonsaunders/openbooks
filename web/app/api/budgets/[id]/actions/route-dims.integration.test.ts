import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// A supplied dimension that is not a valid id used to coerce to null, and
// null means "no filter": copy_prior_actuals with a typo'd departmentId
// silently broadened a narrow request into a whole-budget delete-and-replace.
// Malformed supplied dimensions now refuse by name before any write.

const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; allowed: Set<string> | null } = {
  orgId: '', actorId: '', allowed: null,
}
Object.assign(globalThis, { __budgetDimsState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__budgetDimsState;
        return { user: { orgId: s.orgId, id: s.actorId }, allowedSubsidiaryIds: s.allowed };
      }
    `)
    if (specifier === '../../../../../lib/authz') return virtual(`
      export function can() { return true }
      export function subsidiariesInScope(gate, ids) {
        const scope = gate.allowedSubsidiaryIds;
        if (scope === null) return true;
        return ids.every((id) => id !== null && id !== undefined && id !== '' && scope.has(id));
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

test('copy_prior_actuals refuses a malformed dimension id instead of broadening to the whole budget', { skip: !DB }, async () => {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  state.allowed = null
  try {
    const scenarioId = randomUUID()
    await db.execute(sql`
      insert into budget_scenarios (id, org_id, book_id, fiscal_year, name, kind, status)
      values (${scenarioId}, ${org.orgId}, ${org.bookId}, 2026, 'Dims Target', 'budget', 'draft')`)
    await db.execute(sql`
      insert into budget_lines
        (org_id, scenario_id, account_id, period_id, subsidiary_id, amount, created_by, updated_by)
      values (${org.orgId}, ${scenarioId}, ${org.accounts.cogs}, ${org.periodId}, ${org.subsidiaryId},
              '100.0000', ${state.actorId}, ${state.actorId})`)

    const response = await withOrgContext(state.orgId, () => POST(
      new Request(`http://budget.test/api/budgets/${scenarioId}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action: 'copy_prior_actuals', departmentId: 'not-a-uuid', expectedRevision: 1 }),
      }),
      { params: Promise.resolve({ id: scenarioId }) },
    ))
    const body = (await response.json()) as { error?: string }
    assert.match(body.error ?? '', /invalid_department/, `malformed dimension must refuse by name: ${JSON.stringify(body)}`)

    const after = (await db.execute<{ revision: number; n: number }>(sql`
      select revision, (select count(*)::int from budget_lines where scenario_id = ${scenarioId} and org_id = ${org.orgId}) as n
        from budget_scenarios where id = ${scenarioId} and org_id = ${org.orgId}`)).rows[0]!
    assert.equal(after.revision, 1, 'the refused copy changes no revision')
    assert.equal(after.n, 1, 'the refused copy deletes no lines')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
