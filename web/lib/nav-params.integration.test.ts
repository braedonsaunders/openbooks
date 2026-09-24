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
Object.assign(globalThis, { __navParamsState: state, React })
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
          `export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__navParamsState.user;}`,
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
// The loaders, not rendered trees: the toggle hrefs, the Back href and the
// drawer-opener href are loader-resolved strings, so the loader output is
// the thing under test (same rationale as banking-source-evidence-pages).
const { loadPartners } = await import(root + 'web/app/(app)/reports/partners/view.ts')
const { loadStatement } = await import(root + 'web/app/(app)/reports/statements/[partyId]/view.ts')
const { loadBankingAccount } = await import(root + 'web/app/(app)/banking/[accountId]/view.ts')

function hrefParams(href: string): URLSearchParams {
  const query = href.slice(href.indexOf('?') + 1)
  assert.ok(href.includes('?'), `expected a query string in ${JSON.stringify(href)}`)
  return new URLSearchParams(query)
}

async function seedNavParamsOrg(): Promise<{ org: ScratchOrg; actor: string; statementId: string }> {
  const org: ScratchOrg = await withBypassContext(() => createScratchOrg() as Promise<ScratchOrg>)
  const seeded = await withBypassContext(async () => {
    const actor = await createScratchUser(org.orgId, 'Nav operator', 'admin')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`)
    await db.execute(sql`update accounts set currency_restriction='USD',reconcilable=true where org_id=${org.orgId} and id=${org.accounts.bank}`)
    // One imported statement so the drawer-opener row exists. The source is
    // deliberately fictitious: the loader must treat it as opaque tenant
    // data, so the test proves the wiring without naming a real vendor.
    const statementId = randomUUID()
    await db.execute(sql`insert into bank_statements(id,org_id,account_id,source,statement_date,opening_balance,closing_balance,raw_file_ref,created_by)
      values(${statementId},${org.orgId},${org.accounts.bank},'test-source',${org.date},'0.0000','100.0000','test-seed',${actor})`)
    return { actor, statementId }
  })
  state.user = { id: seeded.actor, orgId: org.orgId, isSuperAdmin: false, name: 'Nav operator', email: 'nav@scratch.test',
    roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: seeded.actor }
  return { org, ...seeded }
}

// F1T-5: the payables/receivables toggle rebuilt its href from kind+book
// only, so switching sides dropped the search term and reset the pager.
test('partners kind toggle keeps the search term and page', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedNavParamsOrg()
  try {
    const data = (await withOrgContext(org.orgId, () =>
      loadPartners({ kind: 'payable', book: org.bookId, q: 'acme', page: '3' }))) as {
      payableHref: string
      receivableHref: string
    }
    assert.equal(data.payableHref.slice(0, data.payableHref.indexOf('?')), '/reports/partners')
    const toggled = hrefParams(data.receivableHref)
    assert.equal(toggled.get('kind'), 'receivable')
    assert.equal(toggled.get('book'), org.bookId)
    assert.equal(toggled.get('q'), 'acme')
    assert.equal(toggled.get('page'), '3')
    const stayed = hrefParams(data.payableHref)
    assert.equal(stayed.get('kind'), 'payable')
    assert.equal(stayed.get('q'), 'acme')
    assert.equal(stayed.get('page'), '3')
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})

// F1T-6: the party statement Back link pointed at bare /reports/registers,
// so returning from an A/P statement landed on the A/R register.
test('party statement Back carries its side', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await seedNavParamsOrg()
  try {
    const ap = (await withOrgContext(org.orgId, () =>
      loadStatement(org.customerId, { side: 'ap', book: org.bookId }))) as {
      backHref: string
      backLabel: string
    }
    assert.equal(ap.backHref, '/reports/registers?side=ap')
    assert.equal(ap.backLabel, 'registers.apTitle')
    const ar = (await withOrgContext(org.orgId, () =>
      loadStatement(org.customerId, { book: org.bookId }))) as {
      backHref: string
      backLabel: string
    }
    assert.equal(ar.backHref, '/reports/registers?side=ar')
    assert.equal(ar.backLabel, 'registers.arTitle')
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})

// F1T-12: the statement drawer OPENER rebuilt its href from the statement
// id only (closeHref keeps everything via mergeHref), so closing the drawer
// landed on an unfiltered page 1.
test('statement drawer opener keeps list search, sort and page', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, statementId } = await seedNavParamsOrg()
  try {
    const data = (await withOrgContext(org.orgId, () =>
      loadBankingAccount(org.accounts.bank, {
        stmtQ: 'test-source',
        stmtSort: 'source',
        stmtDir: 'asc',
        stmtPage: '1',
        reconPage: '2',
      }))) as {
      statementRows: Array<{ id: string; dateHref: string }>
    }
    const row = data.statementRows.find((r) => r.id === statementId)
    assert.ok(row, 'seeded statement row is listed')
    const params = hrefParams(row.dateHref)
    assert.equal(row.dateHref.slice(0, row.dateHref.indexOf('?')), `/banking/${org.accounts.bank}`)
    assert.equal(params.get('statement'), statementId)
    assert.equal(params.get('stmtQ'), 'test-source')
    assert.equal(params.get('stmtSort'), 'source')
    assert.equal(params.get('stmtPage'), '1')
    assert.equal(params.get('reconPage'), '2')
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})
