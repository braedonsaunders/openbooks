import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createDocument } = await import('@openbooks/engine/src/ledger/document-write.ts')
const { loadDocument } = await import('@openbooks/engine/src/ledger/document-service.ts')
const { generateInvoiceFromBillingRequest } = await import('./billing')
const { createBillingRequest } = await import('./billing-requests')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

test('generated invoices stamp each line work period and the latest work date as work completed', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId
      const project = randomUUID()
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts,projectRevenue}',to_jsonb(${org.accounts.recognized}::text)) where id=${org.orgId}`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
        values(${project},${org.orgId},${org.subsidiaryId},'WORK','Work dates',${org.customerId},'active',true,'{}'::jsonb)`)
      const item = randomUUID()
      await db.execute(sql`insert into items(id,org_id,kind,name,income_account_id,is_active)
        values(${item},${org.orgId},'service','Field service',${org.accounts.revenue},true)`)
      for (const [date, amount] of [['2026-07-03', '100'], ['2026-07-14', '40']] as const) {
        const doc = randomUUID()
        await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,posting_date,currency,fx_rate,status,subtotal,tax_total,total)
          values(${doc},${org.orgId},'vendor_bill',${'COST-' + doc},${org.vendorId},${org.subsidiaryId},${project},${date},${date},'CAD',1,'draft',${amount},0,${amount})`)
        await db.execute(sql`insert into document_lines(org_id,document_id,line_number,item_id,account_id,description,quantity,unit_price,amount,is_billable)
          values(${org.orgId},${doc},1,${item},${org.accounts.cogs},'Field service',1,${amount},${amount},true)`)
        await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${doc}`)
      }
      const req = await createBillingRequest(org.orgId, actor, { projectId: project, basis: 'date_range', cutoffDate: org.date, backupRequired: false })
      const invoice = await generateInvoiceFromBillingRequest(org.orgId, actor, req.id)
      const loaded = await loadDocument(invoice.id, org.orgId)
      assert.equal(loaded?.doc.work_completed_on, '2026-07-14')
      assert.deepEqual(
        loaded?.lines.map((line) => [line.amount, line.work_from, line.work_to]),
        [['100.0000', '2026-07-03', '2026-07-03'], ['40.0000', '2026-07-14', '2026-07-14']],
      )
    } finally { await dropScratchOrg(org.orgId) }
  })
})

test('entered work dates save on customer invoices and refuse disordered periods and non-billing kinds', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId
      const create = (kind: string, body: Record<string, unknown>) => createDocument({
        orgId: org.orgId, userId: actor, kind, key: randomUUID(), subsidiaryId: org.subsidiaryId, requestBody: { kind, ...body }, body,
      })
      const created = await create('customer_invoice', {
        partyId: org.customerId, documentDate: '2026-07-31', workCompletedOn: '2026-07-28',
        lines: [{ accountId: org.accounts.revenue, amount: '250.0000', description: 'Inspection', workFrom: '2026-07-01', workTo: '2026-07-28' }],
      })
      const saved = await loadDocument(created.id, org.orgId)
      assert.equal(saved?.doc.work_completed_on, '2026-07-28')
      assert.deepEqual(saved?.lines.map((line) => [line.work_from, line.work_to]), [['2026-07-01', '2026-07-28']])

      await assert.rejects(
        create('customer_invoice', {
          partyId: org.customerId, documentDate: '2026-07-31',
          lines: [{ accountId: org.accounts.revenue, amount: '10.0000', workFrom: '2026-07-20', workTo: '2026-07-10' }],
        }),
        (error: unknown) => (error as { status?: number }).status === 422 && /Line 1: work to must be on or after work from/.test((error as Error).message),
      )
      await assert.rejects(
        create('vendor_bill', {
          partyId: org.vendorId, documentDate: '2026-07-31', workCompletedOn: '2026-07-28',
          lines: [{ accountId: org.accounts.cogs, amount: '10.0000' }],
        }),
        (error: unknown) => (error as { status?: number }).status === 422 && /work dates apply only to customer invoices/.test((error as Error).message),
      )
    } finally { await dropScratchOrg(org.orgId) }
  })
})
