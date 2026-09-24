import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    if (specifier.startsWith('@openbooks/engine/')) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice('@openbooks/engine/'.length)}`, import.meta.url).href,
        context,
      )
    }
    return nextResolve(specifier, context)
  },
})

const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { withSimClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { loadDashboardMetrics } = await import('./_metrics.ts')
type Authz = import('@/lib/authz.ts').Authz

const TODAY = '2026-07-15'

function authzFor(orgId: string, userId: string, allowedSubsidiaryIds: Set<string> | null): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: 'Scope Reader', orgId,
      roles: [{ key: 'staff', name: 'staff' }],
      envKind: 'sandbox', productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(['dashboard.read', 'gl.read', 'assistant.use']),
    allowedSubsidiaryIds,
  }
}

test('dashboard GL counts and balances honor subsidiary scope', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Scope Reader', 'admin'))
    const hiddenSubsidiary = randomUUID()
    const hiddenBank = randomUUID()
    const hiddenOffset = randomUUID()
    const visibleEntry = randomUUID()
    const hiddenEntry = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Hidden dashboard entity', 'CAD', 'CA')
      `)
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, subsidiary_id, is_summary, is_active)
        values (${hiddenBank}, ${scratch.orgId}, '1086', 'Hidden dashboard cash', 'asset_bank', ${hiddenSubsidiary}, false, true),
               (${hiddenOffset}, ${scratch.orgId}, '4086', 'Hidden dashboard offset', 'income', ${hiddenSubsidiary}, false, true)
      `)
      for (const item of [
        { id: visibleEntry, subsidiaryId: scratch.subsidiaryId, bank: scratch.accounts.bank, offset: scratch.accounts.adjustment, memo: 'Visible subsidiary journal' },
        { id: hiddenEntry, subsidiaryId: hiddenSubsidiary, bank: hiddenBank, offset: hiddenOffset, memo: 'CONFIDENTIAL other subsidiary journal' },
      ]) {
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, memo)
          values
            (${item.id}, ${scratch.orgId}, ${scratch.bookId}, ${item.subsidiaryId},
             ${`DASH-SCOPE-${item.id.slice(0, 8)}`}, ${TODAY}, ${scratch.periodId}, 'draft', 'manual', ${item.memo})
        `)
        await db.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values
            (${scratch.orgId}, ${item.id}, 1, ${item.bank}, ${item.subsidiaryId}, '125.0000', 'CAD', '125.0000', 1),
            (${scratch.orgId}, ${item.id}, 2, ${item.offset}, ${item.subsidiaryId}, '-125.0000', 'CAD', '-125.0000', 1)
        `)
        await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${item.id} and org_id = ${scratch.orgId}`)
      }
    })

    const widgets = [
      'kpi-journal-lines', 'kpi-accounts-active', 'kpi-entries-today',
      'kpi-ledger-balance',
    ]
    const all = await withSimClock(TODAY, () => withOrgContext(scratch.orgId, () =>
      loadDashboardMetrics(authzFor(scratch.orgId, actor, null), widgets),
    ))
    const scoped = await withSimClock(TODAY, () => withOrgContext(scratch.orgId, () =>
      loadDashboardMetrics(authzFor(scratch.orgId, actor, new Set([scratch.subsidiaryId])), widgets),
    ))

    assert.equal(all.journalLineCount - scoped.journalLineCount, 2)
    assert.equal(all.accountCount - scoped.accountCount, 2)
    assert.equal(all.entriesToday - scoped.entriesToday, 1)
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('recent journal and personal draft lists omit records from hidden subsidiaries', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'List Scope Reader', 'admin'))
    const hiddenSubsidiary = randomUUID()
    const hiddenBank = randomUUID()
    const hiddenOffset = randomUUID()
    const visibleEntry = randomUUID()
    const hiddenEntry = randomUUID()
    const visibleDraft = randomUUID()
    const hiddenDraft = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Hidden dashboard list entity', 'CAD', 'CA')
      `)
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, subsidiary_id, is_summary, is_active)
        values (${hiddenBank}, ${scratch.orgId}, '1085', 'Hidden list cash', 'asset_bank', ${hiddenSubsidiary}, false, true),
               (${hiddenOffset}, ${scratch.orgId}, '4085', 'Hidden list offset', 'income', ${hiddenSubsidiary}, false, true)
      `)
      for (const item of [
        { id: visibleEntry, subsidiaryId: scratch.subsidiaryId, bank: scratch.accounts.bank, offset: scratch.accounts.adjustment, memo: 'Visible list journal' },
        { id: hiddenEntry, subsidiaryId: hiddenSubsidiary, bank: hiddenBank, offset: hiddenOffset, memo: 'CONFIDENTIAL hidden list journal' },
      ]) {
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, memo)
          values
            (${item.id}, ${scratch.orgId}, ${scratch.bookId}, ${item.subsidiaryId},
             ${`DASH-LIST-${item.id.slice(0, 8)}`}, ${TODAY}, ${scratch.periodId}, 'draft', 'manual', ${item.memo})
        `)
        await db.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
          values
            (${scratch.orgId}, ${item.id}, 1, ${item.bank}, ${item.subsidiaryId}, '125.0000', 'CAD', '125.0000', 1),
            (${scratch.orgId}, ${item.id}, 2, ${item.offset}, ${item.subsidiaryId}, '-125.0000', 'CAD', '-125.0000', 1)
        `)
        await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${item.id} and org_id = ${scratch.orgId}`)
      }
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, subsidiary_id, document_date, currency, status, total, created_by)
        values (${visibleDraft}, ${scratch.orgId}, 'bill', 'DASH-LIST-VISIBLE', ${scratch.subsidiaryId}, ${TODAY}, 'CAD', 'draft', '25.0000', ${actor}),
               (${hiddenDraft}, ${scratch.orgId}, 'bill', 'DASH-LIST-HIDDEN', ${hiddenSubsidiary}, ${TODAY}, 'CAD', 'draft', '75.0000', ${actor})
      `)
    })

    const widgets = ['list-recent-entries', 'personal-in-progress']
    const all = await withOrgContext(scratch.orgId, () => loadDashboardMetrics(authzFor(scratch.orgId, actor, null), widgets))
    const scoped = await withOrgContext(scratch.orgId, () =>
      loadDashboardMetrics(authzFor(scratch.orgId, actor, new Set([scratch.subsidiaryId])), widgets),
    )

    const hiddenRecent = all.recentEntries.find((entry) => entry.id === hiddenEntry)
    assert.ok(hiddenRecent, 'the unrestricted reader sees the seeded record')
    assert.equal(hiddenRecent.memo, 'CONFIDENTIAL hidden list journal')
    assert.equal(hiddenRecent.lineCount, 2)
    assert.ok(!scoped.recentEntries.some((entry) => entry.id === hiddenEntry))
    assert.deepEqual(all.draftDocuments.map((document) => document.id).sort(), [hiddenDraft, visibleDraft].sort())
    assert.deepEqual(scoped.draftDocuments.map((document) => document.id), [visibleDraft])
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('dashboard continuous-close counts include only work items with visible account lineage', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const actor = await withBypass(() => createScratchUser(scratch.orgId, 'Agent Scope Reader', 'admin'))
    const hiddenSubsidiary = randomUUID()
    const hiddenAccount = randomUUID()
    const visibleId = randomUUID()
    const hiddenId = randomUUID()
    const unresolvedId = randomUUID()
    const unassignedId = randomUUID()
    const visibleRun = new Date(Date.now() - 60_000).toISOString()
    const hiddenRun = new Date().toISOString()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Hidden finding entity', 'CAD', 'CA')
      `)
      await db.execute(sql`
        update accounts set subsidiary_id = ${scratch.subsidiaryId}
         where id = ${scratch.accounts.bank} and org_id = ${scratch.orgId}
      `)
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, subsidiary_id, is_summary, is_active)
        values (${hiddenAccount}, ${scratch.orgId}, '1084', 'Hidden finding account', 'asset_bank', ${hiddenSubsidiary}, false, true)
      `)
      for (const finding of [
        { id: visibleId, subjectType: 'account', subjectId: scratch.accounts.bank, at: visibleRun, summary: {} },
        { id: hiddenId, subjectType: 'account', subjectId: hiddenAccount, at: hiddenRun, summary: { proposedCommand: { tool: 'test', input: {} } } },
        { id: unresolvedId, subjectType: 'account', subjectId: randomUUID(), at: hiddenRun, summary: {} },
        { id: unassignedId, subjectType: null, subjectId: null, at: hiddenRun, summary: {} },
      ]) {
        await db.execute(sql`
          insert into ai_work_items
            (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, status,
             confidence, materiality, subject_type, subject_id, summary, first_detected_at, last_detected_at)
          values
            (${finding.id}, ${scratch.orgId}, 'accounting', 'scope_test', 'test', ${`fp-${finding.id}`},
             'warning', 'open', 1, 100, ${finding.subjectType}, ${finding.subjectId},
             ${JSON.stringify(finding.summary)}::jsonb, ${finding.at}::timestamptz, ${finding.at}::timestamptz)
        `)
      }
    })

    const widgets = ['kpi-agent-findings']
    const unrestricted = await withOrgContext(scratch.orgId, () =>
      loadDashboardMetrics(authzFor(scratch.orgId, actor, null), widgets),
    )
    const restricted = await withOrgContext(scratch.orgId, () =>
      loadDashboardMetrics(authzFor(scratch.orgId, actor, new Set([scratch.subsidiaryId])), widgets),
    )
    assert.equal(unrestricted.agentFindingsOpen, 4)
    assert.equal(unrestricted.agentFindingsProposals, 1)
    assert.equal(restricted.agentFindingsOpen, 1)
    assert.equal(restricted.agentFindingsProposals, 0)
    assert.equal(restricted.agentFindingsLastRun, visibleRun)
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
