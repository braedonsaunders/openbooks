import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '../platform/db.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors, seedApprovalFlow } from '../testing/fixtures.ts'
import { submitFinancialChange } from '../flows/financial-changes-adapter.ts'
import { decideGate } from '../flows/gates.ts'
import { proposeProvisionAssessment, applyProvisionAssessment, type ProvisionProposal } from './assessments.ts'
import { postEntry } from '../journal/post-entry.ts'

test('governed construction forecasts recognize remaining loss once, refuse stale evidence and honor the Projects gate', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId))
    const expense = randomUUID(), liability = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{reportingFramework}','"ifrs"') where id=${org.orgId}`)
      await db.execute(sql`insert into accounts(id,org_id,number,name,type) values
        (${expense},${org.orgId},'PROV-EXP','Provision expense','expense'),
        (${liability},${org.orgId},'PROV-LIAB','Provision liability','liability_current_other')`)
      await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values
        (${org.orgId},${actors.submitterId},'gl.manage','grant'),
        (${org.orgId},${actors.submitterId},'gl.post','grant')`)
      await seedApprovalFlow(org.orgId, { subjectKind: 'financial_change', assignees: [{ type: 'user', userId: actors.approver1Id }], mode: 'any', preventSelfApproval: true })
    })
    await withOrgContext(org.orgId, async () => {
      const projectId = randomUUID()
      await withBypassContext(async () => {
        await db.execute(sql`insert into projects(id,org_id,code,name,subsidiary_id,contract_value) values (${projectId},${org.orgId},'LOSS-CONTRACT','Fixed-price construction',${org.subsidiaryId},'1000000')`)
        await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values (${org.orgId},${actors.submitterId},'projects.read','grant')`)
      })
      const input: ProvisionProposal = {
        obligation: { id: randomUUID(), subsidiaryId: org.subsidiaryId, bookId: org.bookId, name: 'Construction expected loss', currency: 'CAD', expenseAccountId: expense, liabilityAccountId: liability,projectId },
        effectiveOn: org.date, reason: 'Provide the forecast contract loss in full immediately', idempotencyKey: randomUUID(),
        assessment: {presentObligation:true,outflow:'probable',reliablyEstimable:true,evidence:'Approved fixed-price contract with a supported forecast of direct and allocated costs.',discounting:'immaterial',discountEvidence:'Work will complete shortly and time value is immaterial.',estimate:null},
        construction:{remainingCost:'950000',terminationAvailable:false,terminationCost:null,relatedAssetsReviewed:true,impairmentEvidence:'The controller reviewed related contract assets and no additional impairment is required.'},
      }
      const entry = async (number:string,lines:Parameters<typeof postEntry>[1]['lines']) => postEntry(db,{orgId:org.orgId,bookId:org.bookId,subsidiaryId:org.subsidiaryId,entryNumber:number,postingDate:org.date,periodId:org.periodId,origin:'manual',currency:'CAD',actorId:actors.submitterId,lines})
      await entry('CONTRACT-RESULTS',[
        {accountId:expense,amount:'200000',projectId},{accountId:org.accounts.revenue,amount:'-200000',projectId},
      ])
      const approve = async (id: string) => {
        await submitFinancialChange(org.orgId, id, actors.submitterId)
        const gate = (await db.execute<{ id: string }>(sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${id} and status='pending'`)).rows[0]!
        await decideGate({ gateId: gate.id, userId: actors.approver1Id, decision: 'approved' })
      }
      await assert.rejects(proposeProvisionAssessment(org.orgId,actors.submitterId,{...input,construction:{...input.construction!,relatedAssetsReviewed:false}}),/post required impairments/)
      const change = await proposeProvisionAssessment(org.orgId,actors.submitterId,input)
      assert.equal(await proposeProvisionAssessment(org.orgId,actors.submitterId,input),change)
      await approve(change)
      const result = await applyProvisionAssessment(org.orgId,change,actors.submitterId)
      assert.equal(result.liability,'150000.0000'); assert.equal(result.currentPeriodCharge,'150000.0000')
      assert.deepEqual(await applyProvisionAssessment(org.orgId,change,actors.submitterId),result)
      const review = {...input,idempotencyKey:randomUUID(),construction:{...input.construction!,remainingCost:'850000'}}
      const stale = await proposeProvisionAssessment(org.orgId,actors.submitterId,review)
      await approve(stale)
      await entry('FURTHER-CONTRACT-COST',[{accountId:expense,amount:'100000',projectId},{accountId:org.accounts.clearing,amount:'-100000'}])
      await assert.rejects(applyProvisionAssessment(org.orgId,stale,actors.submitterId),/changed after this proposal/)
      const updated = await proposeProvisionAssessment(org.orgId,actors.submitterId,{...review,idempotencyKey:randomUUID()})
      await approve(updated)
      const reduced = await applyProvisionAssessment(org.orgId,updated,actors.submitterId)
      assert.equal(reduced.liability,'50000.0000'); assert.equal(reduced.currentPeriodCharge,'-100000.0000')
      const exit = await proposeProvisionAssessment(org.orgId,actors.submitterId,{...review,idempotencyKey:randomUUID(),construction:{...review.construction!,terminationAvailable:true,terminationCost:'25000'}})
      await approve(exit)
      assert.equal((await applyProvisionAssessment(org.orgId,exit,actors.submitterId)).liability,'25000.0000')
      await withBypassContext(() => db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,projects}','false') where id=${org.orgId}`))
      await assert.rejects(submitFinancialChange(org.orgId,stale,actors.submitterId),/Company Settings → Features/)
      await assert.rejects(applyProvisionAssessment(org.orgId,change,actors.submitterId),/Company Settings → Features/)
      await assert.rejects(proposeProvisionAssessment(org.orgId,actors.submitterId,{...review,idempotencyKey:randomUUID()}),/Company Settings → Features/)
    })
  } finally { await dropScratchOrg(org.orgId) }
})
