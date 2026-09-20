import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export async function getTranslations() { return (key) => key }',
      }
    }
    return nextResolve(specifier, context)
  },
})

const { sql } = await import('drizzle-orm')
const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadReportDrillData } = await import('./report-drill-data')
const { transactionDetail } = await import('./reports/transaction-detail')
const { encodeReportDrillTarget, parseReportDrillTarget } = await import('./report-drill')
import type { ReportDrillTarget } from './report-drill'

/**
 * A drill drawer must show the supporting lines of the exact cell the user
 * clicked. Statement cells aggregate the view's full entity set (a subtree
 * for consolidated views); the drill shares that set. Narrowing the drill
 * to the picker node alone drops every child entity's lines behind a
 * consolidated total.
 */
async function seedRevenue(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actorId: string,
  input: { number: string; subsidiaryId: string; total: string },
): Promise<string> {
  const entryId = randomUUID()
  await db.execute(sql`
    insert into journal_entries(
      id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
      status, origin, created_by, updated_by
    ) values (
      ${entryId}, ${org.orgId}, ${org.bookId}, ${input.subsidiaryId}, ${input.number},
      ${org.date}, ${org.periodId}, 'draft', 'manual', ${actorId}, ${actorId}
    )
  `)
  await db.execute(sql`
    insert into journal_lines(
      id, org_id, entry_id, line_number, account_id, subsidiary_id,
      is_open_item, amount, currency, txn_amount, fx_rate
    ) values
      (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.revenue}, ${input.subsidiaryId},
       false, ${`-${input.total}`}, 'CAD', ${`-${input.total}`}, '1'),
      (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${input.subsidiaryId},
       false, ${input.total}, 'CAD', ${input.total}, '1')
  `)
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`)
  return entryId
}

test('a consolidated drill ties to its cell across the whole subtree', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(scratch.orgId, 'Reporter', 'admin'))
  try {
    const branchId = randomUUID()
    let rootEntry = ''
    let branchEntry = ''
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${branchId}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Drill branch', 'CAD', 'CA')
      `)
      rootEntry = await seedRevenue(scratch, actorId, { number: 'DRILL-ROOT', subsidiaryId: scratch.subsidiaryId, total: '100' })
      branchEntry = await seedRevenue(scratch, actorId, { number: 'DRILL-BRANCH', subsidiaryId: branchId, total: '200' })
    })
    const root = scratch.subsidiaryId
    const subtree = [root, branchId]
    const authz = {
      user: {
        id: actorId, email: 'reporter@example.com', name: 'Reporter', roles: [],
        orgId: scratch.orgId, envKind: 'production', productionOrgId: scratch.orgId,
        homeUserId: actorId, homeOrgId: scratch.orgId, isSuperAdmin: true,
      },
      permissions: new Set<string>(['*']),
      allowedSubsidiaryIds: null,
    } as const

    // The cell the trial balance shows for an explicitly root-scoped
    // (consolidated) view: both entities' revenue.
    const cell = await withBypass(() => transactionDetail({
      accountTypes: ['income'],
      from: scratch.date,
      to: scratch.date,
      mode: 'flow',
      dims: { subsidiaryIds: subtree },
      orgId: scratch.orgId,
      bookId: scratch.bookId,
    }))
    assert.equal(cell.count, 2, 'the cell aggregates the whole subtree')
    assert.equal(Number(cell.net), 300, 'cell net covers both entities')

    // The drill target the trial-balance view builds for that same cell:
    // the view's dims (the subtree) plus the picker node.
    const target: ReportDrillTarget = {
      kind: 'ledger',
      label: 'Revenue',
      accountTypes: ['income'],
      from: scratch.date,
      to: scratch.date,
      mode: 'flow',
      dims: { subsidiaryIds: subtree },
      subsidiaryId: root,
      bookId: scratch.bookId,
    }
    // Drills travel to the API as URL state: round-trip through the real
    // codec so the tie-out holds across serialization, not just in memory.
    const parsed = parseReportDrillTarget(encodeReportDrillTarget(target))
    assert.ok(parsed, 'the drill target survives its URL codec')
    const drill = await withBypass(() => loadReportDrillData(parsed, { ...authz, allowedSubsidiaryIds: null }, 1))
    assert.equal(drill.total, 2, 'the drill supports the whole cell, not just the picker node')
    const drilled = new Set(drill.rows.map((row) => row.transaction?.entryId))
    assert.ok(drilled.has(rootEntry) && drilled.has(branchEntry), 'both entities land in the drawer')
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('a drill never widens a restricted caller past its allowlist', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  const actorId = await withBypass(() => createScratchUser(scratch.orgId, 'Reporter', 'admin'))
  try {
    const branchId = randomUUID()
    let branchEntry = ''
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${branchId}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Drill branch', 'CAD', 'CA')
      `)
      await seedRevenue(scratch, actorId, { number: 'DRILL-ROOT', subsidiaryId: scratch.subsidiaryId, total: '100' })
      branchEntry = await seedRevenue(scratch, actorId, { number: 'DRILL-BRANCH', subsidiaryId: branchId, total: '200' })
    })
    const root = scratch.subsidiaryId
    // A restricted caller who may see only the root, handed a target whose
    // embedded entity set (and picker node) point at the hidden branch.
    const forged: ReportDrillTarget = {
      kind: 'ledger',
      label: 'Revenue',
      accountTypes: ['income'],
      from: scratch.date,
      to: scratch.date,
      mode: 'flow',
      dims: { subsidiaryIds: [root, branchId] },
      subsidiaryId: branchId,
      bookId: scratch.bookId,
    }
    const parsed = parseReportDrillTarget(encodeReportDrillTarget(forged))
    assert.ok(parsed, 'the forged target survives its URL codec')
    const restricted = {
      user: {
        id: actorId, email: 'reporter@example.com', name: 'Reporter', roles: [],
        orgId: scratch.orgId, envKind: 'production', productionOrgId: scratch.orgId,
        homeUserId: actorId, homeOrgId: scratch.orgId, isSuperAdmin: false,
      },
      permissions: new Set<string>(['reports.read']),
      allowedSubsidiaryIds: new Set([root]),
    } as const
    const drill = await withBypass(() => loadReportDrillData(parsed, { ...restricted, allowedSubsidiaryIds: new Set([root]) }, 1))
    assert.equal(drill.total, 1, 'the drill stays inside the caller allowlist')
    assert.ok(
      !drill.rows.some((row) => row.transaction?.entryId === branchEntry),
      'the hidden branch never lands in the drawer',
    )
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
