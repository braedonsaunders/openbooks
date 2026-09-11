import { registerHooks } from 'node:module'
import { resolveAppModule } from './test-module-hooks'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import * as React from 'react'
import ExcelJS from 'exceljs'

/**
 * Legal-entity scope on the report SCREENS and their supporting routes.
 *
 * RP1 — six report pages (aging, general ledger, journal, registers, direct and
 *       indirect cash flow) rendered from the URL dims only, so a reader whose
 *       role restricts them to one subsidiary saw every entity on screen while
 *       the PDF export of the same report was scoped.
 * RP2 — the aging drill-through passed the URL dims straight to agingDetail.
 * RP5 — scheduled deliveries rendered the definition frozen into the schedule's
 *       authorization snapshot; edits to the saved report never reached
 *       recipients, and the internal render seam did not validate its inputs.
 * RP7 — malformed dimension params reached uuid predicates and 500ed.
 *
 * Same in-process harness as report-security.integration.test.ts: `server-only`
 * and next-intl are shimmed, the session comes from a test-owned principal, and
 * pages are invoked directly (cash-scope.integration.test.ts pattern) with the
 * returned element tree serialized to prove what a reader would see.
 */
const repo = process.cwd()
const root = pathToFileURL(repo + '/').href
const state: { user: import('./auth').SessionUser | null } = { user: null }
Object.assign(globalThis, { __reportPagesState: state, React })
registerHooks({
  resolve(s, c, next) {
    if (s === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (s === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          'export async function getTranslations(){const t=(s)=>s;t.has=()=>false;t.rich=(s)=>s;return t;};export async function getLocale(){return "en"}',
        ),
      }
    }
    if ((s === './auth' || s.endsWith('/lib/auth')) && c.parentURL?.includes('/web/') && !c.parentURL.includes('/web/lib/auth.ts')) {
      // Session identity comes from the test principal; every other auth
      // export (cookie names, token helpers used by locale/report-pdf) is the
      // real module's.
      return {
        shortCircuit: true,
        url: 'data:text/javascript,' + encodeURIComponent(
          `export * from ${JSON.stringify(root + 'web/lib/auth.ts')};export async function currentUser(){return globalThis.__reportPagesState.user;}`,
        ),
      }
    }
    const app = resolveAppModule(s, c, next, root)
    if (app) return app
    return next(s, c)
  },
})
const { db, withBypassContext, withOrgContext } = await import(root + 'engine/src/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(root + 'engine/src/test-fixtures.ts')
const { postDocument } = await import(root + 'engine/src/posting.ts')
const { materializeDueReportRuns } = await import(root + 'engine/src/report-delivery.ts')
const { REPORT_ENTITY_MAP } = await import(root + 'packages/reports/src/index.ts')
const { GET: drill } = await import(root + 'web/app/api/reports/drill/route.ts')
const { GET: exportStatement } = await import(root + 'web/app/api/reports/statement/[kind]/export/route.ts')
const { GET: render } = await import(root + 'web/app/api/internal/reports/render/route.ts')
const { POST: schedule } = await import(root + 'web/app/api/reports/schedules/route.ts')
const pages = {
  aging: (await import(root + 'web/app/(app)/reports/aging/page.tsx')).default,
  'general-ledger': (await import(root + 'web/app/(app)/reports/general-ledger/page.tsx')).default,
  journal: (await import(root + 'web/app/(app)/reports/journal/page.tsx')).default,
  registers: (await import(root + 'web/app/(app)/reports/registers/page.tsx')).default,
  'cash-flow': (await import(root + 'web/app/(app)/reports/cash-flow/page.tsx')).default,
  'cash-flow-indirect': (await import(root + 'web/app/(app)/reports/cash-flow-indirect/page.tsx')).default,
} as const

const HIDDEN = 'SECRET-ENTITY-B'
const VISIBLE = 'VISIBLE-ENTITY-A'

type Fixture = Awaited<ReturnType<typeof createScratchOrg>>

/** One posted bank/revenue journal plus one posted, open customer invoice per entity. */
async function seedEntity(org: Fixture, subsidiaryId: string, tag: string, amount: string) {
  const party = randomUUID()
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${party},${org.orgId},'organization',${tag + '-PARTY'},${subsidiaryId})`)
  const entry = randomUUID()
  await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
    values (${entry},${org.orgId},${org.bookId},${subsidiaryId},${tag + '-JE'},${org.date},${org.periodId},${tag + '-MEMO'},'draft','manual')`)
  await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,memo)
    values (${org.orgId},${entry},1,${org.accounts.bank},${subsidiaryId},${amount},'CAD',${amount},1,${tag + '-MEMO'}),
           (${org.orgId},${entry},2,${org.accounts.revenue},${subsidiaryId},${'-' + amount},'CAD',${'-' + amount},1,${tag + '-MEMO'})`)
  await db.execute(sql`update journal_entries set status='posted',posted_at=now() where id=${entry}`)
  const invoice = randomUUID()
  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate)
    values (${invoice},${org.orgId},'customer_invoice','draft',${tag + '-INV'},${subsidiaryId},${party},${org.date},'CAD',1)`)
  await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount)
    values (${org.orgId},${invoice},1,${org.accounts.revenue},1,${amount},${amount},0,0)`)
  await db.execute(sql`update documents set status='approved' where id=${invoice}`)
  await postDocument(invoice, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })
  return { party, entry, invoice }
}

function principal(org: Fixture, uid: string): import('./auth').SessionUser {
  return {
    id: uid, orgId: org.orgId, isSuperAdmin: false, name: 'Restricted reader', email: 'reader@example.test',
    roles: [], envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: uid,
  }
}

/** Every string a rendered page would show: element props and children, walked
 *  without the component `type` / owner links (which are cyclic). */
function renderedText(node: unknown, seen = new WeakSet<object>()): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'bigint') return String(node)
  if (!node || typeof node !== 'object' || seen.has(node)) return ''
  seen.add(node)
  if (Array.isArray(node)) return node.map((item) => renderedText(item, seen)).join('\n')
  if (React.isValidElement(node)) return renderedText(node.props, seen)
  return Object.entries(node as Record<string, unknown>)
    .filter(([key]) => !['type', '_owner', '_store', '_self', '_source', 'ref'].includes(key))
    .map(([, value]) => renderedText(value, seen))
    .join('\n')
}

const request = (url: string, init?: RequestInit) => new Request('http://test.local' + url, init)
const json = (body: unknown) => request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

for (const mode of ['restricted', 'empty'] as const) {
  test(`report pages and aging drill honor the caller's subsidiary restriction (${mode})`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await withBypassContext(() => createScratchOrg())
    try {
      const uid = await withBypassContext(() => createScratchUser(org.orgId, 'Restricted report reader', 'review_reader'))
      const hidden = randomUUID()
      await withBypassContext(async () => {
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`)
        const restriction = { mode: 'list', subsidiaryIds: mode === 'empty' ? [] : [org.subsidiaryId] }
        await db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb, subsidiary_restriction=${JSON.stringify(restriction)}::jsonb
          where org_id=${org.orgId} and key='review_reader'`)
        await seedEntity(org, org.subsidiaryId, VISIBLE, '123')
        await seedEntity(org, hidden, HIDDEN, '777')
      })
      state.user = principal(org, uid)
      await withOrgContext(org.orgId, async () => {
        const params = { period: 'custom', from: org.date.slice(0, 8) + '01', to: org.date.slice(0, 8) + '31' }
        for (const [name, page] of Object.entries(pages)) {
          const sp = name === 'aging' ? { ...params, view: 'detail' } : params
          const tree = renderedText(await page({ searchParams: Promise.resolve(sp) }))
          assert.equal(tree.includes(HIDDEN), false, `${name}: hidden entity evidence rendered`)
          // Cash-flow statements carry amounts, not names: the hidden entity's
          // 777 must neither appear nor fold into a total (123 + 777 = 900).
          assert.equal(tree.includes('777.00') || tree.includes('900.00'), false, `${name}: hidden amount folded into a total`)
          const cashFlowPage = name === 'cash-flow' || name === 'cash-flow-indirect'
          assert.equal(tree.includes(cashFlowPage ? '123.00' : VISIBLE), mode === 'restricted', `${name}: visible entity presence`)
        }
        // RP2 — the drill route behind every aging cell.
        const target = encodeURIComponent(JSON.stringify({ kind: 'aging', label: 'Receivables', side: 'ar', asOf: org.date }))
        const drilled = await drill(request(`/api/reports/drill?target=${target}`))
        assert.equal(drilled.status, 200, await drilled.clone().text())
        const body = JSON.stringify(await drilled.json())
        assert.equal(body.includes(HIDDEN), false, 'aging drill leaked the hidden entity')
        assert.equal(body.includes(VISIBLE), mode === 'restricted')
        // RP7 — malformed dimension ids are re-clamped, never bound into SQL.
        for (const [kind, query] of [['trial-balance', 'dept=abc'], ['general-ledger', 'account=abc&project=%27+or+1%3D1'], ['aging', 'class=nope']]) {
          const exported = await exportStatement(request(`/api/reports/statement/${kind}/export?format=csv&${query}`), { params: Promise.resolve({ kind }) })
          assert.equal(exported.status, 200, `${kind}: ${await exported.clone().text()}`)
        }
      })
    } finally {
      state.user = null
      await withBypassContext(() => dropScratchOrg(org.orgId))
    }
  })
}

test('scheduled deliveries render the definition as saved now under the pinned authorization', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const token = 'internal-' + randomUUID()
  const previousToken = process.env.OPENBOOKS_INTERNAL_TOKEN
  process.env.OPENBOOKS_INTERNAL_TOKEN = token
  try {
    const uid = await withBypassContext(() => createScratchUser(org.orgId, 'Scheduling reader', 'review_scheduler'))
    const def = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions='["reports.read","reports.create","reports.schedule"]'::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
        where org_id=${org.orgId} and key='review_scheduler'`)
      await db.execute(sql`insert into report_definitions (id,org_id,kind,report_type,slug,name,query,created_by)
        values(${def},${org.orgId},'custom','query','review-documents','Documents',${JSON.stringify({ entity: 'documents', columns: ['document_number'] })}::jsonb,${uid})`)
      await seedEntity(org, org.subsidiaryId, VISIBLE, '123')
    })
    state.user = principal(org, uid)
    const created = await withOrgContext(org.orgId, () => schedule(json({
      definitionId: def, cadence: 'daily', hour: 9, minute: 0, timezone: 'UTC', recipientEmails: ['recipient@example.test'], active: true,
    })))
    assert.equal(created.status, 201, await created.clone().text())
    const runIds = await withBypassContext(() => materializeDueReportRuns(new Date(Date.now() + 3 * 86_400_000)))
    const runId = runIds.find(Boolean)
    assert.ok(runId, 'the schedule materialized a durable run')
    // The report is edited AFTER scheduling: a second column is added.
    await withBypassContext(() => db.execute(sql`update report_definitions set query=${JSON.stringify({ entity: 'documents', columns: ['document_number', 'status'] })}::jsonb where id=${def}`))
    // Header cells carry the catalog label, or its i18n key under the
    // harness's pass-through translator.
    const header = (key: string) => {
      const label = REPORT_ENTITY_MAP.documents!.columns.find((c: { key: string }) => c.key === key)!.label
      return (cell: string) => cell === label || cell === `catalog.columns.documents.${key}`
    }

    const renderUrl = `/api/internal/reports/render?orgId=${org.orgId}&definitionId=${def}&runId=${runId}&format=xlsx`
    const headers = { 'x-internal-token': token }
    const rendered = await render(request(renderUrl, { headers }))
    assert.equal(rendered.status, 200, await rendered.clone().text())
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(await rendered.arrayBuffer()) as unknown as Parameters<typeof workbook.xlsx.load>[0])
    const cells: string[] = []
    workbook.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.text ?? cell.value ?? '')))))
    assert.ok(cells.some(header('document_number')), `original column present: ${cells.join(' | ')}`)
    assert.ok(cells.some(header('status')), `the run must carry the definition's CURRENT columns: ${cells.join(' | ')}`)
    assert.ok(cells.includes(VISIBLE + '-INV'))

    // Widening the definition past the pinned principal's grants fails the run
    // instead of delivering: the current definition is re-validated against
    // the schedule's authorization, not the snapshot's frozen copy.
    await withBypassContext(() => db.execute(sql`update report_definitions set query=${JSON.stringify({ entity: 'pay_stubs', columns: ['gross_pay'] })}::jsonb where id=${def}`))
    const widened = await render(request(renderUrl, { headers }))
    assert.equal(widened.status, 422)
    assert.match(await widened.text(), /Report access denied/)

    // The internal seam validates its own inputs.
    assert.equal((await render(request(renderUrl, { headers: { 'x-internal-token': token + 'x' } }))).status, 401)
    assert.equal((await render(request(renderUrl))).status, 401)
    const badOrg = await render(request(`/api/internal/reports/render?orgId=not-a-uuid&definitionId=${def}&runId=${runId}`, { headers }))
    assert.equal(badOrg.status, 400, await badOrg.clone().text())
  } finally {
    state.user = null
    if (previousToken === undefined) delete process.env.OPENBOOKS_INTERNAL_TOKEN
    else process.env.OPENBOOKS_INTERNAL_TOKEN = previousToken
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
