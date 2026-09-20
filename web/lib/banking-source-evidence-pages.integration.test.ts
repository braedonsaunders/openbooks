import { registerHooks } from 'node:module'
import { resolveAppModule } from './test-module-hooks'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import * as React from 'react'
import type { ScratchOrg } from '../../engine/src/testing/fixtures.ts'
const repo = process.cwd()
const root = pathToFileURL(repo + '/').href
const state: { user: import('./auth').SessionUser | null } = { user: null }
Object.assign(globalThis, { __bankingPagesState: state, React })
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          // The key plus its params as JSON, so the test can assert which
          // message was chosen AND which values were interpolated into it.
          'export async function getTranslations(){const t=(k,p)=>p===undefined?k:`${k} ${JSON.stringify(p)}`;t.has=()=>false;t.rich=(k)=>k;return t;};export async function getLocale(){return "en"}',
        ),
      }
    }
    if ((s === './auth' || s.endsWith('/lib/auth')) && c.parentURL?.includes('/web/') && !c.parentURL.includes('/web/lib/auth.ts')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          `export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__bankingPagesState.user;}`,
        ),
      }
    }
    const app = resolveAppModule(s, c, next, root)
    if (app) return app
    return next(s, c)
  },
})

const { db, withBypassContext, withOrgContext } = await import(root + 'engine/src/platform/db.ts') as typeof import('../../engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js') as typeof import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(root + 'engine/src/testing/fixtures.ts')
// The pages' LOADERS, not their rendered trees: the evidence badge and the
// workspace header are loader-resolved strings, so the loader output is the
// thing under test (same rationale as banking-book-pages).
const { loadBankingAccount } = await import(root + 'web/app/(app)/banking/[accountId]/view.ts')
const { loadReconciliation } = await import(
  root + 'web/app/(app)/banking/[accountId]/reconcile/[reconciliationId]/view.ts'
)

function splitKey(rendered: string): { key: string; params: Record<string, unknown> } {
  const at = rendered.indexOf(' ')
  assert.ok(at > 0, `expected a key+params rendering, got ${JSON.stringify(rendered)}`)
  return { key: rendered.slice(0, at), params: JSON.parse(rendered.slice(at + 1)) as Record<string, unknown> }
}

// The connector code and display name are deliberately fictitious: the
// loaders must treat the evidence connector as opaque tenant data, so the
// test proves the wiring without naming any real vendor (the neutrality
// gate forbids vendor names outside connector scope).
const CONNECTOR_SOURCE = 'test-source'
const CONNECTOR_NAME = 'Test Source'

async function seedSourceEvidenceOrg() {
  const org: ScratchOrg = await withBypassContext(() => createScratchOrg() as Promise<ScratchOrg>)
  const seeded = await withBypassContext(async () => {
    const actor = await createScratchUser(org.orgId, 'Bank operator', 'admin')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`)
    await db.execute(sql`update accounts set currency_restriction='USD',reconcilable=true where org_id=${org.orgId} and id=${org.accounts.bank}`)
    await db.execute(sql`insert into connections(org_id,source,display_name,mirror_enabled)
      values(${org.orgId},${CONNECTOR_SOURCE},${CONNECTOR_NAME},true)`)
    // One cleared line (mirrored source stamp) and one open line, both posted
    // in the primary book on or before the sign-off cutoff.
    const clearedEntry = randomUUID(), openEntry = randomUUID()
    for (const [entry, number] of [[clearedEntry, 'cleared-1'], [openEntry, 'open-1']] as const) {
      await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
        values(${entry},${org.orgId},${org.bookId},${org.subsidiaryId},${number},${org.date},${org.periodId},'draft','manual')`)
    }
    await db.execute(sql`insert into journal_lines(id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,source_cleared_date,source_cleared_connector)
      values(${randomUUID()},${org.orgId},${clearedEntry},1,${org.accounts.bank},${org.subsidiaryId},100,'USD',100,1,${org.date},${CONNECTOR_SOURCE}),
        (${randomUUID()},${org.orgId},${clearedEntry},2,${org.accounts.adjustment},${org.subsidiaryId},-100,'USD',-100,1,null,null),
        (${randomUUID()},${org.orgId},${openEntry},1,${org.accounts.bank},${org.subsidiaryId},50,'USD',50,1,null,null),
        (${randomUUID()},${org.orgId},${openEntry},2,${org.accounts.adjustment},${org.subsidiaryId},-50,'USD',-50,1,null,null)`)
    await db.execute(sql`update journal_entries set status='posted',posted_by=${actor} where org_id=${org.orgId} and id in (${clearedEntry},${openEntry})`)
    const sourceRecon = randomUUID(), statementRecon = randomUUID(), orphanRecon = randomUUID()
    await db.execute(sql`insert into reconciliations(id,org_id,account_id,through_date,currency,statement_balance,status,created_by,evidence_kind,evidence_connector,signed_off_by,signed_off_at)
      values(${sourceRecon},${org.orgId},${org.accounts.bank},${org.date},'USD',150,'signed_off',${actor},'source',${CONNECTOR_SOURCE},${actor},now()),
        (${statementRecon},${org.orgId},${org.accounts.bank},${org.date},'USD',150,'signed_off',${actor},'statement',null,${actor},now()),
        (${orphanRecon},${org.orgId},${org.accounts.bank},${org.date},'USD',150,'signed_off',${actor},'source','lone-source',${actor},now())`)
    return { actor, sourceRecon, statementRecon, orphanRecon }
  })
  state.user = { id: seeded.actor, orgId: org.orgId, isSuperAdmin: false, name: 'Bank operator', email: 'bank@scratch.test',
    roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: seeded.actor }
  return { org, ...seeded }
}

test('source-evidenced sign-off renders reconciled-from-connector with counts', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, sourceRecon } = await seedSourceEvidenceOrg()
  try {
    const loaded = await withOrgContext(org.orgId, async () =>
      loadReconciliation(org.accounts.bank, sourceRecon, {}))
    const { key, params } = splitKey(loaded.headerDescription)
    assert.equal(key, 'reconcile.sourceSignedOffByDescription')
    assert.equal(params.connector, CONNECTOR_NAME)
    assert.equal(params.date, org.date)
    assert.equal(params.name, 'Bank operator')
    assert.equal(params.cleared, 1)
    assert.equal(params.uncleared, 1)
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})

test('source evidence without a matching connection falls back to source system', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, orphanRecon } = await seedSourceEvidenceOrg()
  try {
    const loaded = await withOrgContext(org.orgId, async () =>
      loadReconciliation(org.accounts.bank, orphanRecon, {}))
    const { key, params } = splitKey(loaded.headerDescription)
    assert.equal(key, 'reconcile.sourceSignedOffByDescription')
    assert.equal(params.connector, 'sourceSystem.other')
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})

test('statement sign-off keeps the statement header', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, statementRecon } = await seedSourceEvidenceOrg()
  try {
    const loaded = await withOrgContext(org.orgId, async () =>
      loadReconciliation(org.accounts.bank, statementRecon, {}))
    const { key } = splitKey(loaded.headerDescription)
    assert.equal(key, 'reconcile.signedOffByDescription')
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})

test('account reconciliation rows badge statement vs source evidence', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, sourceRecon, statementRecon, orphanRecon } = await seedSourceEvidenceOrg()
  try {
    const data = (await withOrgContext(org.orgId, async () => loadBankingAccount(org.accounts.bank, {}))) as {
      columnEvidence: string
      reconRows: Array<{ id: string; evidenceLabel: string; evidenceVariant: string }>
    }
    assert.equal(data.columnEvidence, 'account.columns.evidence')
    const byId = new Map(data.reconRows.map((row) => [row.id, row]))
    const source = byId.get(sourceRecon)
    assert.ok(source, 'source-evidenced reconciliation row is listed')
    const { key: sourceKey, params: sourceParams } = splitKey(source.evidenceLabel)
    assert.equal(sourceKey, 'evidenceKind.sourceFrom')
    assert.equal(sourceParams.connector, CONNECTOR_NAME)
    assert.equal(source.evidenceVariant, 'secondary')
    const statement = byId.get(statementRecon)
    assert.ok(statement, 'statement reconciliation row is listed')
    assert.equal(statement.evidenceLabel, 'evidenceKind.statement')
    assert.equal(statement.evidenceVariant, 'outline')
    const orphan = byId.get(orphanRecon)
    assert.ok(orphan, 'unmatched-connector reconciliation row is listed')
    const { key: orphanKey, params: orphanParams } = splitKey(orphan.evidenceLabel)
    assert.equal(orphanKey, 'evidenceKind.sourceFrom')
    assert.equal(orphanParams.connector, 'sourceSystem.other')
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})
