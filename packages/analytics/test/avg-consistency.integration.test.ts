import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { REPORT_ENTITY_MAP, runCustomQuery } from '@openbooks/reports'
import { pool } from '@openbooks/engine/src/platform/db.ts'
import { postProjectGlEntry } from '@openbooks/engine/src/projects/recognition.ts'
import { createScratchOrg, createScratchUser, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import { runInsightQuery } from '../src/execute.ts'

test('report and insight averages preserve the same monetary precision', async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Average consistency tester', 'admin')
    const tag = `AVG-CONSISTENCY-${randomUUID()}`
    for (const [entryNumber, amount] of [[`${tag}-A`, '1.0100'], [`${tag}-B`, '1.0200']] as const) {
      await postProjectGlEntry({
        orgId: org.orgId,
        actorId: actor,
        origin: 'manual',
        entryNumber,
        postingDate: org.date,
        memo: 'Average precision probe',
        subsidiaryId: org.subsidiaryId,
        currency: 'CAD',
        bookId: org.bookId,
        lines: [
          { accountId: org.accounts.adjustment, amount },
          { accountId: org.accounts.bank, amount: `-${amount}` },
        ],
      })
    }

    const report = await runCustomQuery(pool, {
      entity: 'ledger_lines',
      mode: 'summarize',
      columns: [],
      measures: [{ fn: 'avg', column: 'debit' }],
      filters: {
        combinator: 'and',
        rules: [
          { field: 'account_id', op: 'eq', value: org.accounts.adjustment },
          { field: 'entry_number', op: 'contains', value: tag },
        ],
      },
    }, {
      orgId: org.orgId,
      entityMap: REPORT_ENTITY_MAP,
      allowedSubsidiaryIds: [org.subsidiaryId],
      allowedBookIds: [org.bookId],
    })
    const reportAverage = report.groups.flatMap((group) => group.rows)[0]?.[0]

    const insight = await runInsightQuery(pool, {
      source: 'ledger_lines',
      measures: [{ agg: 'avg', field: 'debit' }],
      filters: [
        { field: 'account_id', op: 'eq', value: org.accounts.adjustment },
        { field: 'entry_number', op: 'contains', value: tag },
      ],
    }, org.orgId, [org.subsidiaryId], undefined, org.date, [org.bookId])
    const insightAverage = insight.rows[0]?.avg_debit

    assert.equal(String(reportAverage), String(insightAverage))
    assert.match(String(reportAverage), /^1\.015/)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
