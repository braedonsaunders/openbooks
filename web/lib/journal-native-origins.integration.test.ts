import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * The Journal list shows journal-kind documents plus GL-native engine
 * journals with no subledger document (closing, allocation, revaluation,
 * FX revaluation, elimination, disposal, …). Every GL-native origin the
 * engines actually post must be visible: a posted journal the list hides
 * breaks the ledger's audit trail (reports tie, the journal does not show
 * the entry).
 */
const root = pathToFileURL(process.cwd() + '/').href
const { db, withBypassContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
const { JOURNAL_ENTRY_TABLE } = (await import(root + 'web/lib/customization/entity-list-query/journal-entries.ts')) as typeof import('./customization/entity-list-query/journal-entries.ts')
const { journalScopeWhere } = (await import(root + 'web/lib/customization/entity-list-query/journal-entries.ts')) as typeof import('./customization/entity-list-query/journal-entries.ts')

/** GL-native standalone origins posted by the engines (no source document). */
const NATIVE_ORIGINS = [
  'manual',
  'revaluation',
  'fx_revaluation',
  'intercompany',
  'disposal',
  'inventory',
  'lease',
  'tax_provision',
  'overhead_applied',
  'payroll_variance',
  'labor_burden',
  'depreciation',
  'revenue_recognition',
  'fx_settlement',
  'translation',
  // Migration true-ups (TRUEUP-*) are standalone engine journals:
  // posted but invisible in /journal while Origin=All.
  'migration',
]

test('journal list shows every GL-native engine origin', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(async () => {
      const actorId = (await seedFlowActors(org.orgId)).adminId
      for (const origin of NATIVE_ORIGINS) {
        const entryId = randomUUID()
        const tag = `NATIVE-${origin.replace(/_/g, '-').toUpperCase()}`
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
          values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${tag}, ${org.date}, ${org.periodId},
                  ${tag}, 'draft', ${origin}, ${actorId}, ${actorId})`)
        await db.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
          values
            (${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, 10.00, 'CAD', 10.00, 1, false),
            (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, -10.00, 'CAD', -10.00, 1, false)`)
        await db.execute(sql`update journal_entries set status='posted', posted_at=now(), posted_by=${actorId} where id=${entryId}`)
      }
    })
    const visible = await withBypassContext(async () => db.execute<{ entry_number: string; origin: string }>(sql`
      select e.entry_number, e.origin from ${sql.raw(JOURNAL_ENTRY_TABLE)} as e
       where e.org_id = ${org.orgId} and e.entry_number like 'NATIVE-%'`))
    const seen = new Map(visible.rows.map((row) => [row.entry_number, row.origin]))
    const missing: string[] = []
    for (const origin of NATIVE_ORIGINS) {
      const tag = `NATIVE-${origin.replace(/_/g, '-').toUpperCase()}`
      if (seen.get(tag) !== origin) missing.push(origin)
    }
    assert.deepEqual(missing, [], `journal list hides GL-native origins: ${missing.join(', ')}`)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('the journal list exposes a pay-run entry only inside the caller subsidiary lens', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const entryId = randomUUID()
    const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
    const entryNumber = `PAY-RUN-JOURNAL-${entryId.slice(0, 8)}`
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entryNumber}, ${org.date}, ${org.periodId},
                ${entryNumber}, 'draft', 'payroll', ${actorId}, ${actorId})`)
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
        values
          (${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, 10.00, 'CAD', 10.00, 1, false),
          (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, -10.00, 'CAD', -10.00, 1, false)`)
      await db.execute(sql`update journal_entries set status='posted', posted_at=now(), posted_by=${actorId} where id=${entryId}`)
      await db.execute(sql`
        insert into documents
          (org_id, kind, document_number, document_date, currency, subsidiary_id, status, posted_entry_id, posting_period_id)
        values (${org.orgId}, 'pay_run', ${entryNumber}, ${org.date}, 'CAD', ${org.subsidiaryId}, 'posted', ${entryId}, ${org.periodId})`)
    })

    const visibleToEntity = await withBypassContext(() => db.execute<{ entry_number: string }>(sql`
      select e.entry_number from ${sql.raw(JOURNAL_ENTRY_TABLE)} e
       where e.org_id = ${org.orgId} and ${journalScopeWhere(org.orgId, new Set([org.subsidiaryId]))}`))
    assert.ok(visibleToEntity.rows.some((row) => row.entry_number === entryNumber))

    const visibleToNoSubsidiaries = await withBypassContext(() => db.execute<{ entry_number: string }>(sql`
      select e.entry_number from ${sql.raw(JOURNAL_ENTRY_TABLE)} e
       where e.org_id = ${org.orgId} and ${journalScopeWhere(org.orgId, new Set<string>())}`))
    assert.equal(visibleToNoSubsidiaries.rows.some((row) => row.entry_number === entryNumber), false)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})


const consolidatedRows = [
  { label: "journal warnings", register: async () => {
        /**
         * A manual journal that posts AR/AP-control legs with no party
         * (JE-00005: CA$100 to 1100 with the party left empty) must not go through
         * silently. The posting stays legitimate — party-less control legs are real
         * GL activity — but the post response must carry the warning so the drawer
         * can pin it on the record, instead of widening the aging gap unannounced.
         */
        const root = pathToFileURL(process.cwd() + '/').href
        const { db, withBypassContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
        const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
        const { partylessControlLines } = (await import(root + 'web/lib/journal-warnings.ts')) as typeof import('./journal-warnings')
        
        type ScratchOrg = Awaited<ReturnType<typeof createScratchOrg>>
        
        async function postManualEntry(org: ScratchOrg, tag: string, arParty: string | null): Promise<string> {
          const entry = randomUUID()
          await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
            values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${tag}, '2026-07-14', ${org.periodId}, ${tag}, 'draft', 'manual')`)
          await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, party_id, amount, currency, txn_amount, fx_rate, is_open_item)
            values (${org.orgId}, ${entry}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, ${arParty}, '100.0000', 'CAD', '100.0000', '1', ${arParty !== null}),
                   (${org.orgId}, ${entry}, 2, ${org.accounts.revenue}, ${org.subsidiaryId}, null, '-100.0000', 'CAD', '-100.0000', '1', false)`)
          await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`)
          return entry
        }
        
        test('a partyless AR leg is reported with its account', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const entry = await withBypassContext(() => postManualEntry(org, 'JE-NOPARTY', null))
            const warnings = await withBypassContext(() => partylessControlLines(org.orgId, entry))
            assert.equal(warnings.length, 1)
            assert.equal(warnings[0]?.accountNumber, '1100')
            assert.equal(warnings[0]?.accountName, 'Accounts Receivable')
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
        
        test('a partied control leg stays silent', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const entry = await withBypassContext(() => postManualEntry(org, 'JE-PARTY', org.customerId))
            const warnings = await withBypassContext(() => partylessControlLines(org.orgId, entry))
            assert.deepEqual(warnings, [])
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();
