import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

/**
 * F-t08-007: a manual journal that posts AR/AP-control legs with no party
 * (JE-00005: CA$100 to 1100 with the party left empty) must not go through
 * silently. The posting stays legitimate — party-less control legs are real
 * GL activity — but the post response must carry the warning so the drawer
 * can pin it on the record, instead of widening the aging gap unannounced.
 */
const root = pathToFileURL(process.cwd() + '/').href
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s.startsWith('@/')) return next(root + 'web/' + s.slice(2) + '.ts', c)
    return next(s, c)
  },
})
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
