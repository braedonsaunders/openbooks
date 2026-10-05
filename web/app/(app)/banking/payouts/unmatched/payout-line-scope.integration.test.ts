import { registerHooks } from 'node:module'
import { resolveAppModule } from '../../../../../lib/test-module-hooks'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import type { ScratchOrg } from '../../../../../../engine/src/testing/fixtures.ts'

const repo = process.cwd()
const root = pathToFileURL(repo + '/').href
const state: { user: import('../../../../../lib/auth').SessionUser | null } = { user: null }
Object.assign(globalThis, { __payoutScopeState: state, React })
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          'export async function getTranslations(){const t=(k,p)=>p===undefined?k:`${k} ${JSON.stringify(p)}`;t.has=()=>false;t.rich=(k)=>k;return t;};export async function getLocale(){return "en"}',
        ),
      }
    }
    if (s === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          'export function notFound(){throw Object.assign(new Error("not found"),{status:404})}' +
          'export function redirect(url){throw Object.assign(new Error("redirect:"+url),{status:307})}',
        ),
      }
    }
    if ((s === './auth' || s.endsWith('/lib/auth')) && c.parentURL?.includes('/web/') && !c.parentURL.includes('/web/lib/auth.ts')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          `export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__payoutScopeState.user;}`,
        ),
      }
    }
    const app = resolveAppModule(s, c, next, root)
    if (app) return app
    return next(s, c)
  },
})

const { db, withBypassContext, withOrgContext } = await import(root + 'engine/src/platform/db.ts') as typeof import('../../../../../../engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js') as typeof import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(root + 'engine/src/testing/fixtures.ts')
const { readEntityListPage } = await import(root + 'web/lib/list/entity-reader.ts') as typeof import('../../../../../lib/list/entity-reader.ts')
const { allowedSubsidiaryIds } = await import(root + 'web/lib/subsidiaries.ts') as typeof import('../../../../../lib/subsidiaries.ts')
const { loadPspUnmatched } = await import(root + 'web/app/(app)/banking/payouts/unmatched/view.ts') as typeof import('./view.ts')
const { GET: suggestionGet } = await import(root + 'web/app/api/psp/settlement-lines/[id]/suggestion/route.ts') as typeof import('../../../../../../web/app/api/psp/settlement-lines/[id]/suggestion/route.ts')
const { POST: approvePost } = await import(root + 'web/app/api/psp/settlement-lines/[id]/approve/route.ts') as typeof import('../../../../../../web/app/api/psp/settlement-lines/[id]/approve/route.ts')
const { importSettlementBatch } = await import(root + 'engine/src/payments/psp-settlement.ts') as typeof import('../../../../../../engine/src/payments/psp-settlement.ts')

/**
 * The unmatched payout queue through the web layers: the list, the row
 * drawer and the suggestion/approval endpoints all read the payout's legal
 * entity before any amount, reference or proposal. A caller restricted to
 * the home entity meets the other entity's rows as missing everywhere, and
 * every amount renders in the record's own currency — never a fallback.
 */
async function seed(): Promise<{ org: ScratchOrg; restricted: string; lines: Record<string, string> }> {
  const org: ScratchOrg = await withBypassContext(() => createScratchOrg() as Promise<ScratchOrg>)
  const admin: string = await withBypassContext(() => createScratchUser(org.orgId, 'Payout owner', 'admin'))
  const restricted: string = await withBypassContext(() => createScratchUser(org.orgId, 'Payout viewer', 'payout-viewer'))
  await withBypassContext(async () => {
    assert.equal((await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"banking":true}'::jsonb, true) where id = ${org.orgId} returning id`)).rows.length, 1)
    assert.equal((await db.execute(sql`update app_roles set permissions = '["banking.read","banking.reconcile"]'::jsonb, subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb where org_id = ${org.orgId} and key = 'payout-viewer' returning key`)).rows.length, 1)
    assert.equal((await db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin' returning key`)).rows.length, 1)
  })
  const subB = (await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (gen_random_uuid(), ${org.orgId}, ${org.subsidiaryId}, 'Western Entity', 'CAD', 'CA')
    returning id`)).rows[0]!.id))
  const accounts = { bankAccountId: org.accounts.bank, feeAccountId: org.accounts.adjustment, clearingAccountId: org.accounts.clearing }
  const batchA = (await withBypassContext(() => importSettlementBatch(org.orgId, admin, {
    provider: "stripe", externalRef: "po_web_A", settlementDate: "2026-07-10", currency: "CAD",
    lines: [
      { kind: "charge", amount: "10.00", externalRef: "web-null-1", meta: {} },
      { kind: "charge", amount: "20.00", externalRef: "web-cad-1", currency: "CAD", meta: {} },
    ],
  }, { ...accounts, subsidiaryId: org.subsidiaryId }, null))).batchId
  const batchE = (await withBypassContext(() => importSettlementBatch(org.orgId, admin, {
    provider: "stripe", externalRef: "po_web_E", settlementDate: "2026-07-10", currency: "EUR",
    lines: [{ kind: "charge", amount: "30.00", externalRef: "web-eur-1", meta: {} }],
  }, { ...accounts, subsidiaryId: org.subsidiaryId }, null))).batchId
  const batchB = (await withBypassContext(() => importSettlementBatch(org.orgId, admin, {
    provider: "stripe", externalRef: "po_web_B", settlementDate: "2026-07-10", currency: "CAD",
    lines: [{ kind: "charge", amount: "40.00", externalRef: "web-hidden-1", currency: "CAD", meta: {} }],
  }, { ...accounts, subsidiaryId: subB }, null))).batchId
  const lineOf = async (batchId: string, ref: string): Promise<string> => (await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
    select id from psp_settlement_lines where batch_id = ${batchId} and org_id = ${org.orgId} and external_ref = ${ref}`)).rows[0]!.id))
  const lines = {
    nullCurrency: await lineOf(batchA, "web-null-1"),
    cad: await lineOf(batchA, "web-cad-1"),
    eur: await lineOf(batchE, "web-eur-1"),
    hidden: await lineOf(batchB, "web-hidden-1"),
  }
  state.user = { id: restricted, orgId: org.orgId, isSuperAdmin: false, name: 'Payout viewer', email: 'viewer@scratch.test',
    roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: restricted }
  return { org, restricted, lines }
}

async function scopedSet(orgId: string, actor: string): Promise<Set<string>> {
  const scope = await allowedSubsidiaryIds(actor, orgId)
  assert.ok(scope instanceof Set, "the restricted viewer resolves to a finite scope")
  return scope
}

test('the unmatched list shows only the caller entity', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, restricted } = await seed()
  try {
    const page = await readEntityListPage({
      recordType: "psp_settlement_line_unmatched", orgId: org.orgId, actorId: restricted,
      allowedSubsidiaryIds: await scopedSet(org.orgId, restricted),
      sort: "settled", dir: "desc", page: 1, perPage: 25,
    })
    assert.ok(page.ok, `the queue loads for a restricted reader: ${JSON.stringify(page).slice(0, 300)}`)
    if (!page.ok) return
    const refs = page.rows.map((row) => String((row as Record<string, unknown>).reference ?? ""))
    assert.ok(refs.includes("web-null-1") && refs.includes("web-cad-1") && refs.includes("web-eur-1"), `home lines list: ${refs.join(",")}`)
    assert.ok(!refs.includes("web-hidden-1"), "the other entity's reference never lists")
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})

test('the row drawer hides the other entity and prices in record currency', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, lines } = await seed()
  try {
    await assert.rejects(
      withOrgContext(org.orgId, () => loadPspUnmatched({ line: lines.hidden })),
      (error: unknown) => error instanceof Error && (error as { status?: number }).status === 404,
      "another entity's line reads as missing, never as a foreign refusal",
    )
    const cad = await withOrgContext(org.orgId, () => loadPspUnmatched({ line: lines.nullCurrency }))
    assert.ok(cad.drawer, "the home line opens")
    assert.match(cad.drawer!.props.line.amount, /CA/, `a currency-less line prices in its payout currency, not dollars: ${cad.drawer!.props.line.amount}`)
    const eur = await withOrgContext(org.orgId, () => loadPspUnmatched({ line: lines.eur }))
    assert.match(eur.drawer!.props.line.amount, /€/, `a euro payout never renders as dollars: ${eur.drawer!.props.line.amount}`)
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})

test('suggestion and approval meet the other entity as missing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, lines } = await seed()
  try {
    const get = (id: string) => suggestionGet(
      new Request(`http://openbooks.test/api/psp/settlement-lines/${id}/suggestion`),
      { params: Promise.resolve({ id }) },
    )
    const hidden = await get(lines.hidden!)
    assert.equal(hidden.status, 404, "the other entity's proposal is missing")
    const hiddenBody = await hidden.json() as Record<string, unknown>
    assert.deepEqual(hiddenBody, { error: "not_found" })
    const visible = await get(lines.nullCurrency!)
    assert.ok(visible.ok, `the home line still proposes: ${visible.status}`)
    if (!visible.ok) return
    const body = await visible.json() as { suggestion: { lineId: string; code: string; explanation: string } }
    assert.equal(body.suggestion.lineId, lines.nullCurrency)
    assert.ok(!JSON.stringify(body.suggestion).includes("web-hidden-1"), "the proposal carries no hidden reference")
    const denied = await approvePost(
      new Request(`http://openbooks.test/api/psp/settlement-lines/${lines.hidden}/approve`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rank: 0, applyToSimilar: false }),
      }),
      { params: Promise.resolve({ id: lines.hidden }) },
    )
    assert.equal(denied.status, 404, "approving another entity's line is missing")
  } finally {
    state.user = null
    await dropScratchOrgReporting(org.orgId)
  }
})
