import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import * as React from 'react'
import type { SessionUser } from './auth'

// Live-Postgres regression for the tax / compliance SERVER PAGES, which used to
// drop the subsidiary scope their REST twins pass:
//   - /tax/provisions/[id] called getProvisionRun without the caller's scope,
//     so an entity-restricted reader saw the consolidated org-wide provision;
//   - /compliance/information-returns and /compliance loaded filings and the
//     1099 readiness queue org-wide;
//   - /tax rendered the whole filing history although every tax REST path
//     refuses an entity-restricted caller (the return has no entity dimension).
// The pages now pass authz.allowedSubsidiaryIds (notFound when the projected
// record is empty) and /tax applies the API's fence.

const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __taxPageScope: state, React })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          'export async function getTranslations(){const t=(k)=>k;t.has=()=>false;t.raw=(k)=>k;return t};export async function getLocale(){return "en"}',
        ),
      }
    }
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__taxPageScope.user}' }
    }
    if (specifier === '@/lib/money-server') {
      return { shortCircuit: true, url: 'data:text/javascript,export async function getMoneyFormatter(){return {money:String,moneyCompact:String}}' }
    }
    if (specifier.startsWith('@/')) {
      const path = root + 'web/' + specifier.slice(2)
      for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (existsSync(new URL(path + suffix))) return next(path + suffix, context)
      return next(path, context)
    }
    return next(specifier, context)
  },
})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { computeProvisionRun, getProvisionRun } = await import('@openbooks/engine/src/income-tax-provision.ts')
const { ensureFiling } = await import('@openbooks/engine/src/information-returns.ts')
const { default: TaxPage } = await import('../app/(app)/tax/page')
const { default: ProvisionPage } = await import('../app/(app)/tax/provisions/[id]/page')
const { default: InformationReturnsPage } = await import('../app/(app)/compliance/information-returns/page')
const { default: ComplianceHomePage } = await import('../app/(app)/compliance/page')

const DB = !!process.env.OPENBOOKS_DB_URL
const HIDDEN_ENTITY = 'PRIVATE-TAX-PAGE-ENTITY'
const HIDDEN_VENDOR = 'PRIVATE-TAX-PAGE-VENDOR'

/**
 * Walk a rendered server tree: every string/number reachable through element
 * props (children, header slots, action slots …) and every function-typed
 * element (client components stay as elements). Cycle-safe — React 19
 * elements carry debug back-references.
 */
function collect(
  node: unknown,
  seen = new WeakSet<object>(),
  out = { text: [] as string[], types: new Set<string>() },
): { text: string[]; types: Set<string> } {
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node))
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (seen.has(node)) return out
  seen.add(node)
  if (React.isValidElement(node)) {
    const type: unknown = node.type
    if (typeof type === 'function') {
      out.types.add((type as { displayName?: string }).displayName ?? type.name ?? '')
    }
    collect(node.props, seen, out)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, seen, out)
    return out
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith('_')) continue
    collect(value, seen, out)
  }
  return out
}
const renderedText = (node: unknown) => collect(node).text.join('\n')
const elementTypeNames = (node: unknown) => collect(node).types

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Scoped tax reader', 'scoped_tax_reader'))
  const hidden = randomUUID()
  const empty = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,subcontractorCompliance}', 'true'::jsonb, true)
       where id = ${org.orgId}`)
    await db.execute(sql`
      update app_roles set permissions='["reports.read","reports.create","gl.post","compliance.read","compliance.manage"]'::jsonb
       where org_id=${org.orgId} and key='scoped_tax_reader'`)
    await db.execute(sql`
      insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values
        (${hidden},${org.orgId},${org.subsidiaryId},${HIDDEN_ENTITY},'CAD','CA'),
        (${empty},${org.orgId},${org.subsidiaryId},'Entity with no activity','CAD','CA')`)
  })
  state.user = {
    id: actor,
    orgId: org.orgId,
    name: 'Scoped tax reader',
    email: 'scoped@scratch.test',
    roles: [],
    isSuperAdmin: false,
    envKind: 'production',
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: actor,
  }
  const restrict = async (ids: string[] | null) => {
    const value = ids === null ? { mode: 'all' } : { mode: 'list', subsidiaryIds: ids }
    await withBypassContext(() =>
      db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify(value)}::jsonb where org_id=${org.orgId} and key='scoped_tax_reader'`),
    )
  }
  return { org, actor, hidden, empty, restrict }
}

async function teardown(orgId: string) {
  state.user = null
  await withBypassContext(() => dropScratchOrg(orgId))
}

const isNotFound = (error: unknown) => /NOT_FOUND|;404/.test(String((error as { digest?: string }).digest ?? (error as Error).message))

test('/tax applies the API fence: an entity-restricted caller gets not-found, not the filing history', { skip: !DB }, async () => {
  const { org, restrict } = await fixture()
  try {
    await withBypassContext(() =>
      db.execute(sql`insert into tax_filings(org_id,form_code,form_name,period_from,period_to,version,submission_channel,boxes,snapshot_hash)
        values (${org.orgId},'AUDIT','Audit form',${org.date},${org.date},1,'portal_manual','[]'::jsonb,${'a'.repeat(64)})`),
    )
    await withOrgContext(org.orgId, async () => {
      await restrict([org.subsidiaryId])
      await assert.rejects(TaxPage({ searchParams: Promise.resolve({ tab: 'history' }) }), isNotFound)
      await restrict(null)
      const output = await TaxPage({ searchParams: Promise.resolve({ tab: 'history' }) })
      assert.ok(renderedText(output).includes('Audit form'))
    })
  } finally {
    await teardown(org.orgId)
  }
})

test('/tax/provisions/[id] projects the run to the caller\'s entities and gates Post on gl.post', { skip: !DB }, async () => {
  const { org, actor, hidden, empty, restrict } = await fixture()
  try {
    await withBypassContext(() =>
      db.execute(sql`insert into income_tax_rates(org_id,jurisdiction,rate_percent,effective_from) values (${org.orgId},'Audit rate','20','2000-01-01')`),
    )
    const runId = await withBypassContext(() =>
      computeProvisionRun(
        org.orgId,
        Number(org.date.slice(0, 4)),
        { permanentDifferences: [{ description: 'Root', amount: '100' }, { description: 'Hidden', amount: '200', subsidiaryId: hidden }] },
        actor,
      ),
    )
    await withOrgContext(org.orgId, async () => {
      const whole = (await getProvisionRun(org.orgId, runId))!
      const own = (await getProvisionRun(org.orgId, runId, new Set([org.subsidiaryId])))!
      assert.notEqual(whole.totalExpense, own.totalExpense, 'the fixture must make the projection observable')

      await restrict(null)
      const all = await ProvisionPage({ params: Promise.resolve({ id: runId }) })
      assert.ok(renderedText(all).includes(whole.totalExpense))
      assert.ok(elementTypeNames(all).has('ProvisionPostButton'), 'an unrestricted gl.post holder may post')

      await restrict([org.subsidiaryId])
      const scoped = await ProvisionPage({ params: Promise.resolve({ id: runId }) })
      const text = renderedText(scoped)
      assert.ok(text.includes(own.totalExpense), 'the page shows the projected total')
      assert.ok(!text.includes(whole.totalExpense), 'the consolidated org-wide total must not leak')
      assert.ok(!elementTypeNames(scoped).has('ProvisionPostButton'), 'posting is refused to restricted callers by the route; the page must not offer it')

      // No visible entity: indistinguishable from a missing run.
      await restrict([empty])
      await assert.rejects(ProvisionPage({ params: Promise.resolve({ id: runId }) }), isNotFound)
    })
  } finally {
    await teardown(org.orgId)
  }
})

test('/compliance/information-returns and /compliance hide other entities\' filings and vendors', { skip: !DB }, async () => {
  const { org, actor, hidden, restrict } = await fixture()
  try {
    const taxYear = Number(org.date.slice(0, 4)) - 1
    const hiddenFiling = await withBypassContext(() =>
      ensureFiling({ orgId: org.orgId, taxYear, formType: '1099-NEC', subsidiaryId: hidden, currency: 'USD', actorId: actor }),
    )
    const visibleFiling = await withBypassContext(() =>
      ensureFiling({ orgId: org.orgId, taxYear, formType: '1099-NEC', subsidiaryId: org.subsidiaryId, currency: 'USD', actorId: actor }),
    )
    // A reportable vendor with no TIN in the hidden entity: on the readiness queue.
    await withBypassContext(async () => {
      const party = randomUUID()
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${party}, ${org.orgId}, 'vendor', ${HIDDEN_VENDOR}, ${hidden}, true, '{}'::jsonb)`)
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_t4a, information_return_form, created_by, updated_by)
        values (${org.orgId}, ${party}, true, '1099-NEC', ${actor}, ${actor})`)
    })
    await withOrgContext(org.orgId, async () => {
      await restrict(null)
      const allReturns = renderedText(await InformationReturnsPage())
      assert.ok(allReturns.includes(hiddenFiling.id) && allReturns.includes(visibleFiling.id) && allReturns.includes(HIDDEN_ENTITY))
      assert.ok(allReturns.includes(HIDDEN_VENDOR))
      const allHome = renderedText(await ComplianceHomePage({ searchParams: Promise.resolve({ year: String(taxYear) }) }))
      assert.ok(allHome.includes(HIDDEN_VENDOR))

      await restrict([org.subsidiaryId])
      const scopedReturns = renderedText(await InformationReturnsPage())
      assert.ok(scopedReturns.includes(visibleFiling.id), 'the caller\'s own filing is listed')
      assert.ok(!scopedReturns.includes(hiddenFiling.id) && !scopedReturns.includes(HIDDEN_ENTITY), 'another entity\'s filing must not render')
      assert.ok(!scopedReturns.includes(HIDDEN_VENDOR), 'another entity\'s readiness queue must not render')
      const scopedHome = renderedText(await ComplianceHomePage({ searchParams: Promise.resolve({ year: String(taxYear) }) }))
      assert.ok(!scopedHome.includes(HIDDEN_VENDOR), 'the cockpit must not render another entity\'s vendors')
    })
  } finally {
    await teardown(org.orgId)
  }
})
