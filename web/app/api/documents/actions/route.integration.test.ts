import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

/**
 * /api/documents/actions accepts exactly two verbs. Anything else must be
 * refused at the boundary: the route once treated every non-'submit' action
 * as a post while checking only the CREATE permission, so a caller holding
 * ar.create (no ar.post) could post an approved invoice by sending any
 * unknown action string.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __documentActionsUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__documentActionsUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route')

const request = (body: unknown) => new Request('http://audit.local/api/documents/actions', { method: 'POST', body: JSON.stringify(body) })

async function documentState(orgId: string, id: string) {
  return withBypassContext(async () =>
    (await db.execute<{ status: string; postedEntryId: string | null }>(sql`
      select status, posted_entry_id as "postedEntryId" from documents where id = ${id} and org_id = ${orgId}`)).rows[0]!,
  )
}

test('documents/actions refuses unknown actions instead of posting them under the create permission', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Sales rep', 'sales_rep'))
    const invoiceId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions='["ar.read","ar.create"]'::jsonb where org_id=${org.orgId} and key='sales_rep'`)
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`ACT-${invoiceId.slice(0, 8)}`},
                ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
                'CAD', '1', '100', '0', '100', ${actor})`)
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`)
      await db.execute(sql`update documents set status = 'approved' where id = ${invoiceId} and org_id = ${org.orgId}`)
    })
    state.user = { id: actor, orgId: org.orgId, name: 'Sales rep', email: 'rep@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }

    await withOrgContext(org.orgId, async () => {
      // The explicit post verb is correctly permissioned already.
      assert.equal((await POST(request({ action: 'post', documentId: invoiceId }))).status, 403)
      // Every other spelling must be a validation failure, never a post.
      for (const action of ['x', 'POST', '', undefined, null, 1]) {
        const response = await POST(request({ action, documentId: invoiceId }))
        assert.equal(response.status, 400, `action ${JSON.stringify(action)} → ${JSON.stringify(await response.clone().json())}`)
      }
      // submit on an approved document is a lifecycle refusal, not a post.
      assert.equal((await POST(request({ action: 'submit', documentId: invoiceId }))).status, 422)
    })
    assert.deepEqual(await documentState(org.orgId, invoiceId), { status: 'approved', postedEntryId: null })

    // With the post grant the same document posts through the same route.
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["ar.read","ar.create","ar.post"]'::jsonb where org_id=${org.orgId} and key='sales_rep'`))
    await withOrgContext(org.orgId, async () => {
      const posted = await POST(request({ action: 'post', documentId: invoiceId }))
      assert.equal(posted.status, 200, JSON.stringify(await posted.clone().json()))
    })
    const after = await documentState(org.orgId, invoiceId)
    assert.equal(after.status, 'posted')
    assert.ok(after.postedEntryId)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('documents/actions double submit: one winner, one 422, never a 500', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // Two users at once on the same draft: both submitters read `draft` before
  // either commits, so the engine serializes them on the document row lock
  // and the loser must meet a lifecycle refusal — never a raw 500 from the
  // unlocked pre-read racing the approval release.
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Sales rep', 'sales_rep'))
    const invoiceId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions='["ar.read","ar.create"]'::jsonb where org_id=${org.orgId} and key='sales_rep'`)
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`ACT-${invoiceId.slice(0, 8)}`},
                ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
                'CAD', '1', '100', '0', '100', ${actor})`)
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`)
    })
    state.user = { id: actor, orgId: org.orgId, name: 'Sales rep', email: 'rep@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }

    const outcomes = await withOrgContext(org.orgId, () =>
      Promise.allSettled([
        POST(request({ action: 'submit', documentId: invoiceId })),
        POST(request({ action: 'submit', documentId: invoiceId })),
      ]),
    )
    const statuses = outcomes.map((outcome) => {
      assert.equal(outcome.status, 'fulfilled')
      return outcome.status === 'fulfilled' ? outcome.value.status : -1
    })
    assert.deepEqual([...statuses].sort(), [200, 422])
    assert.deepEqual(await documentState(org.orgId, invoiceId), { status: 'approved', postedEntryId: null })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

/**
 * F-t02-005: the audit trail showed only Created+Updated for a document the
 * server had submitted and auto-approved, because neither the auto-release
 * nor a gated submission wrote a documents row to audit_log. The route now
 * records the lifecycle transition itself, so the trail evidences submit
 * (always) plus the auto-release approval it performed.
 */
test('documents/actions submit evidences the transition in the audit trail', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Sales rep', 'sales_rep'))
    const invoiceId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions='["ar.read","ar.create"]'::jsonb where org_id=${org.orgId} and key='sales_rep'`)
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`AUD-${invoiceId.slice(0, 8)}`},
                ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
                'CAD', '1', '100', '0', '100', ${actor})`)
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`)
    })
    state.user = { id: actor, orgId: org.orgId, name: 'Sales rep', email: 'rep@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }

    await withOrgContext(org.orgId, async () => {
      const submitted = await POST(request({ action: 'submit', documentId: invoiceId }))
      assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()))
    })
    const trail = (await withBypassContext(() => db.execute<{ action: string }>(sql`
      select action from audit_log where org_id = ${org.orgId} and table_name = 'documents' and row_id = ${invoiceId} order by action`))).rows.map((r) => r.action)
    assert.ok(trail.includes('submit'), `audit trail evidences submit, got [${trail}]`)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

/**
 * A submit whose approval routing is refused must leave no script effects
 * committed. The submission writes its before_submit mutations and runs its
 * on_submit dispatch before the router refuses; answering 422 from inside
 * the submission transaction used to commit all of it alongside the refusal.
 * The route now throws inside the transaction so the whole submission rolls
 * back, then answers the same 422 after the rollback: the document stays a
 * draft, the scripted memo is gone, and no failed run or script run rows
 * survive as a trail of the refused attempt.
 */
test('documents/actions submit with refused routing commits no script effects', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Sales rep', 'sales_rep'))
    const invoiceId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions='["ar.read","ar.create"]'::jsonb where org_id=${org.orgId} and key='sales_rep'`)
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`RTE-${invoiceId.slice(0, 8)}`},
                ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${org.date},
                'CAD', '1', '100', '0', '100', ${actor})`)
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`)
      // A before_submit script whose mutation the submission writes before
      // the router refuses.
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,scripts}', 'true') where id = ${org.orgId}`)
      await db.execute(sql`
        insert into user_scripts
          (org_id, name, trigger_point, document_kind, source, timeout_ms, sort_order, is_active)
        values (${org.orgId}, 'stamp memo', 'before_submit', 'customer_invoice',
          ${'function main(ctx) { return { set: { memo: "scripted-memo" } }; }'},
          2000, 100, true)`)
      // An unparseable on_submit flow: the dispatch fails, so the submission
      // is refused with a flowError after the script effects are written.
      await db.execute(sql`
        insert into flows (id, org_id, name, subject_kind, enabled, graph)
        values (${randomUUID()}, ${org.orgId}, 'Broken flow', 'customer_invoice', true,
          ${JSON.stringify({ nodes: 'not-an-array' })}::jsonb)`)
    })
    state.user = { id: actor, orgId: org.orgId, name: 'Sales rep', email: 'rep@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }

    await withOrgContext(org.orgId, async () => {
      const refused = await POST(request({ action: 'submit', documentId: invoiceId }))
      assert.equal(refused.status, 422, JSON.stringify(await refused.clone().json()))
      const body = await refused.json() as { error?: string }
      assert.match(body.error ?? '', /approval could not be routed:/)
      assert.match(body.error ?? '', /Broken flow/)
    })
    const after = (await withBypassContext(() => db.execute<{ status: string; memo: string | null }>(sql`
      select status, memo from documents where id = ${invoiceId} and org_id = ${org.orgId}`))).rows[0]!
    assert.equal(after.status, 'draft')
    assert.equal(after.memo, null, 'the refused submission must not commit its script mutation')
    const runs = (await withBypassContext(() => db.execute(sql`
      select id from flow_runs where subject_id = ${invoiceId}`))).rows
    assert.equal(runs.length, 0, 'the refused dispatch must not commit its failed run')
    const scriptRuns = (await withBypassContext(() => db.execute(sql`
      select id from script_runs where org_id = ${org.orgId}`))).rows
    assert.equal(scriptRuns.length, 0, 'the refused submission must not commit its script run rows')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
