import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, seedFlowActors, seedApprovalFlow, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { decideGate } = await import('@openbooks/engine/src/flows/gates.ts')
const { consumePortalLink, issuePortalReviewInvite, portalBillingReview } = await import('@openbooks/engine/portal')
const { registerFlowApprovalReleaseHandlers } = await import('./flow-approval-releases')
const wip = await import('./wip-billing')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

type Org = Awaited<ReturnType<typeof createScratchOrg>>

/** A T&M project with one approved billable time entry, pre-billing and the portal on. */
async function billableProject(org: Org, invoicing: Record<string, unknown> = {}) {
  await db.execute(sql`update orgs set settings = jsonb_set(jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true), '{features,customerPortal}', 'true'::jsonb, true) where id = ${org.orgId}`)
  const tm = BUILTIN_PROJECT_TYPES.find((type) => type.key === 'time_and_materials')!
  const typeId = randomUUID(), project = randomUUID(), employee = randomUUID()
  await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values (${typeId},${org.orgId},${`tm_${typeId.slice(0, 8)}`},'Time & Materials','time_and_materials',${JSON.stringify({ ...tm.invoicingProfile, ...invoicing })}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
  await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
    values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'pre-billing fixture')`)
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
    values (${project},${org.orgId},${org.subsidiaryId},${`PB-${project.slice(0, 6)}`},'Pre-billing job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Crew member',${org.subsidiaryId})`)
  for (const hours of ['2.0000', '3.0000']) {
    await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
      values (${randomUUID()},${org.orgId},${employee},${org.date},${hours},${project},${org.items.service},true,'approved','100.0000','CAD')`)
  }
  return project
}

async function status(orgId: string, id: string) {
  return (await db.execute<{ status: string; customer_decision: string | null }>(sql`
    select status, customer_decision from wip_prebills where org_id = ${orgId} and id = ${id}`)).rows[0]!
}

/**
 * The whole customer-review exchange: a worksheet with no approval flow
 * approves on submit, goes to the customer, comes back disputed with line
 * notes, is fixed and resubmitted, and is accepted with a purchase order that
 * the invoice then references. An acceptance against a stale fingerprint, a
 * conversion while the customer is reviewing, and another customer's attempt
 * all refuse without writing.
 */
test('pre-billing customer review: dispute, rework, accept and invoice with the customer PO', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actors = await seedFlowActors(org.orgId)
      const project = await billableProject(org)
      const created = await wip.createPrebill(org.orgId, actors.adminId, { projectId: project, periodEnd: org.date })
      assert.equal(created.sourceCount, 2)

      await wip.transitionPrebill(org.orgId, actors.adminId, created.id, 'submit')
      assert.equal((await status(org.orgId, created.id)).status, 'approved', 'no approval flow means no approval step')

      const sent = await wip.sendPrebillToCustomer(org.orgId, actors.adminId, created.id, { to: 'ap@customer.test' })
      assert.equal(sent.status, 'customer_review')
      assert.equal(sent.emailed, false, 'without an email transport the review waits in the portal and says so')
      await assert.rejects(wip.convertPrebill(org.orgId, actors.adminId, created.id), /with the customer for review/)

      const review = await portalBillingReview(org.orgId, org.customerId, created.id)
      assert.ok(review)
      assert.equal(review.lines.length, 2)
      assert.equal(await portalBillingReview(org.orgId, randomUUID(), created.id), null, 'another party cannot see the package')

      // The customer signs in through a review invitation; decisions carry that session.
      const invite = await issuePortalReviewInvite(org.orgId, org.customerId, 'ap@customer.test')
      const session = await consumePortalLink(invite.token)
      assert.equal(session.partyId, org.customerId)
      const base = { orgId: org.orgId, partyId: org.customerId, linkId: session.linkId, prebillId: created.id }
      await assert.rejects(
        wip.acceptPrebillReview({ ...base, digest: '0'.repeat(64), signerName: 'Pat Buyer' }),
        (error: unknown) => error instanceof wip.WipBillingError && error.status === 409,
      )
      await assert.rejects(
        wip.acceptPrebillReview({ ...base, partyId: randomUUID(), digest: review.digest, signerName: 'Intruder' }),
        (error: unknown) => error instanceof wip.WipBillingError && error.status === 404,
      )
      assert.equal((await status(org.orgId, created.id)).status, 'customer_review', 'refused decisions write nothing')

      const disputedLine = review.lines.find((entry) => entry.amount === '200.0000')!.id
      await wip.disputePrebillReview({ ...base, digest: review.digest, lines: [{ lineId: disputedLine, note: 'Crew left at noon' }] })
      assert.deepEqual(await status(org.orgId, created.id), { status: 'draft', customer_decision: 'disputed' })
      const reworked = (await wip.loadPrebill(org.orgId, created.id))!
      assert.equal(reworked.lines.find((line) => line.id === disputedLine)?.customerDisputeNote, 'Crew left at noon')
      assert.equal(reworked.disputedLineCount, 1)

      const line = reworked.lines.find((entry) => entry.id === disputedLine)!
      await wip.updatePrebillLine(org.orgId, actors.adminId, created.id, line.id,
        { proposedBillAmount: '100.0000', adjustmentReason: 'Half day on site', adjustmentEvidence: ['customer note'] },
        null, { expectedRevision: line.updatedAt })
      await wip.transitionPrebill(org.orgId, actors.adminId, created.id, 'submit')
      await wip.sendPrebillToCustomer(org.orgId, actors.adminId, created.id, { to: 'ap@customer.test' })
      const revised = (await portalBillingReview(org.orgId, org.customerId, created.id))!
      assert.notEqual(revised.digest, review.digest, 'the fingerprint follows the content')
      assert.ok(revised.lines.every((entry) => entry.disputeNote === null), 'a new review starts clean')

      await wip.acceptPrebillReview({ ...base, digest: revised.digest, signerName: 'Pat Buyer', purchaseOrderNumber: 'PO-7781' })
      assert.deepEqual(await status(org.orgId, created.id), { status: 'approved', customer_decision: 'accepted' })

      const invoice = await wip.convertPrebill(org.orgId, actors.adminId, created.id)
      const document = (await db.execute<{ reference_number: string | null; total: string }>(sql`
        select reference_number, total::text as total from documents where org_id = ${org.orgId} and id = ${invoice.id}`)).rows[0]!
      assert.equal(document.reference_number, 'PO-7781', 'the invoice carries the PO the customer supplied')
      assert.equal(document.total, '400.0000', 'the invoice bills the accepted amounts')
      const listed = (await wip.listPrebills(org.orgId)).find((row) => row.id === created.id)!
      assert.equal(listed.stage, 'invoiced')

      const events = (await db.execute<{ event_type: string }>(sql`
        select event_type from wip_prebill_events where org_id = ${org.orgId} and prebill_id = ${created.id} order by occurred_at, id`)).rows.map((row) => row.event_type)
      for (const expected of ['customer_review_sent', 'customer_disputed', 'customer_accepted', 'converted']) {
        assert.ok(events.includes(expected), `trail records ${expected}`)
      }
    } finally { await dropScratchOrg(org.orgId) }
  })
})

/**
 * A project type that requires customer acceptance refuses to invoice an
 * approved worksheet the customer has not accepted.
 */
test('a required customer review blocks invoicing until the customer accepts', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actors = await seedFlowActors(org.orgId)
      const project = await billableProject(org, { customerReview: 'required' })
      const created = await wip.createPrebill(org.orgId, actors.adminId, { projectId: project, periodEnd: org.date })
      await wip.transitionPrebill(org.orgId, actors.adminId, created.id, 'submit')
      await assert.rejects(wip.convertPrebill(org.orgId, actors.adminId, created.id), /requires customer acceptance/)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where org_id = ${org.orgId} and kind = 'customer_invoice'`)).rows[0]!.n, 0)
    } finally { await dropScratchOrg(org.orgId) }
  })
})

/**
 * With an approval flow authored, submitting parks the worksheet in review
 * behind a gate. The preparer cannot decide it, a rejection returns it to
 * draft with the approver's reason, and an approval releases it.
 */
test('pre-billing approval runs through Flows with separation of duties', enabled, async () => {
  await registerFlowApprovalReleaseHandlers()
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actors = await seedFlowActors(org.orgId)
      const project = await billableProject(org)
      // The preparer is an administrator, who may act on any gate — so only
      // separation of duties stands between them and their own worksheet.
      await seedApprovalFlow(org.orgId, { subjectKind: 'wip_prebill', assignees: [{ type: 'role', role: 'approver' }], mode: 'any' })
      const created = await wip.createPrebill(org.orgId, actors.adminId, { projectId: project, periodEnd: org.date })
      const gateFor = async () => (await db.execute<{ id: string }>(sql`
        select id from flow_gates where org_id = ${org.orgId} and subject_kind = 'wip_prebill'
           and subject_id = ${created.id} and status in ('pending', 'escalated') order by created_at desc limit 1`)).rows[0]?.id

      await wip.transitionPrebill(org.orgId, actors.adminId, created.id, 'submit')
      assert.equal((await status(org.orgId, created.id)).status, 'review')
      await assert.rejects(wip.transitionPrebill(org.orgId, actors.adminId, created.id, 'void', 'Not needed'), /awaiting approval in Inbox/)

      const first = await gateFor()
      assert.ok(first, 'submitting raised an approval gate')
      await assert.rejects(decideGate({ gateId: first, decision: 'approved', userId: actors.adminId }), 'the preparer cannot approve their own worksheet')
      await decideGate({ gateId: first, decision: 'rejected', userId: actors.approver1Id, comment: 'Split the travel time' })
      assert.equal((await status(org.orgId, created.id)).status, 'draft')
      const returned = (await db.execute<{ details: { reason?: string } }>(sql`
        select details from wip_prebill_events where org_id = ${org.orgId} and prebill_id = ${created.id} and event_type = 'returned'`)).rows[0]
      assert.equal(returned?.details.reason, 'Split the travel time')

      await wip.transitionPrebill(org.orgId, actors.adminId, created.id, 'submit')
      const second = await gateFor()
      assert.ok(second)
      await decideGate({ gateId: second, decision: 'approved', userId: actors.approver1Id })
      assert.equal((await status(org.orgId, created.id)).status, 'approved')
    } finally { await dropScratchOrg(org.orgId) }
  })
})
