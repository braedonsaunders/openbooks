import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db,withBypassContext,withOrgContext } from '../platform/db.ts'
import { createConformanceOrg } from '../conformance/roles.ts'
import { FX_SETTLEMENT_CASES } from '../conformance/cases/fx-settlement.ts'
import { submitFinancialChange } from '../flows/financial-changes-adapter.ts'
import { decideGate } from '../flows/gates.ts'
import { proposeLossOfControl,applyLossOfControl,type LossOfControlInput } from './loss-of-control.ts'
import { consolidationHistory } from './consolidation-history.ts'
import { applyNetInvestmentAssessment,proposeNetInvestmentAssessment,proposeNetInvestmentReversal,applyNetInvestmentReversal,type NetInvestmentAssessment } from './net-investment.ts'

test('net-investment OCI preserves standalone FX, attributes each native source once and corrects only through independent approval',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await withBypassContext(()=>createConformanceOrg()),ledger=org.ledger
  try{
    const actual=await FX_SETTLEMENT_CASES.find(c=>c.id==='fx-net-investment-oci')!.run!({roles:org.roles,ledger})
    assert.deepEqual(actual.values,{ociMovement:'500.0000',profitOrLossMovement:'0.0000'})
    await withOrgContext(ledger.orgId,async()=>{
      const change=(await db.execute<{id:string;subject_id:string;submitted_by:string;approved_by:string;payload:NetInvestmentAssessment}>(sql`select id,subject_id,submitted_by,approved_by,payload from financial_changes where org_id=${ledger.orgId} and operation='net_investment_oci' and status='applied'`)).rows[0]!
      const result=await applyNetInvestmentAssessment(ledger.orgId,change.id,change.submitted_by)
      assert.equal(result.ociMovement,'500.0000')
      assert.equal((await db.execute(sql`select 1 from net_investment_sources where org_id=${ledger.orgId}`)).rows.length,1)
      const standalone=(await db.execute<{amount:string}>(sql`select sum(line.amount)::text as amount from journal_lines line join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
        where line.org_id=${ledger.orgId} and line.account_id=${org.roles.fxUnrealizedGainLoss} and entry.subsidiary_id=${ledger.subsidiaryId} and entry.posting_date<='2026-07-31' and entry.status in ('posted','reversed')`)).rows[0]!.amount
      assert.equal(standalone,'-500.0000')
      const lineage=(await db.execute<{amount:string}>(sql`${consolidationHistory(ledger.orgId)} select sum(line.amount)::text as amount from history h join journal_lines line on line.org_id=${ledger.orgId} and line.entry_id=h.id
        where h.interest_id=${change.subject_id} and h.subject_id=(select subsidiary_id from subsidiary_ownership_interests where org_id=${ledger.orgId} and id=${change.subject_id}) and line.account_id=${org.roles.netInvestmentOci}`)).rows[0]!.amount
      assert.equal(lineage,'-500.0000')
      await assert.rejects(proposeNetInvestmentAssessment(ledger.orgId,change.subject_id,change.submitted_by,{...change.payload,idempotencyKey:randomUUID()}),/already has an approved OCI attribution/)
      await assert.rejects(proposeNetInvestmentAssessment(ledger.orgId,change.subject_id,change.submitted_by,{...change.payload,nonTrade:false,idempotencyKey:randomUUID()}),/non-trade monetary loan/)
      const reverseId=await proposeNetInvestmentReversal(ledger.orgId,change.id,change.submitted_by,{effectiveOn:'2026-07-31',reason:'Correct the qualification after a revised treasury settlement decision',idempotencyKey:randomUUID()})
      await assert.rejects(applyNetInvestmentReversal(ledger.orgId,reverseId,change.submitted_by),/independent approval/)
      await submitFinancialChange(ledger.orgId,reverseId,change.submitted_by)
      const gate=(await db.execute<{id:string}>(sql`select id from flow_gates where org_id=${ledger.orgId} and subject_id=${reverseId} and status='pending'`)).rows[0]!
      await decideGate({gateId:gate.id,userId:change.approved_by,decision:'approved'})
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,multiCurrency}','false'::jsonb) where id=${ledger.orgId}`)
      await applyNetInvestmentReversal(ledger.orgId,reverseId,change.submitted_by)
      assert.deepEqual(await applyNetInvestmentReversal(ledger.orgId,reverseId,change.submitted_by),(await db.execute<{result:Record<string,unknown>}>(sql`select result from financial_changes where org_id=${ledger.orgId} and id=${reverseId}`)).rows[0]!.result)
      assert.equal((await db.execute(sql`select 1 from net_investment_sources where org_id=${ledger.orgId} and reversed_by_change_id is null`)).rows.length,0)
      const reversed=(await db.execute<{amount:string}>(sql`${consolidationHistory(ledger.orgId)} select sum(line.amount)::text as amount from history h join journal_lines line on line.org_id=${ledger.orgId} and line.entry_id=h.id where h.interest_id=${change.subject_id} and line.account_id=${org.roles.netInvestmentOci}`)).rows[0]!.amount
      assert.equal(reversed,'0.0000')
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,multiCurrency}','true'::jsonb) where id=${ledger.orgId}`)
      const replacementId=await proposeNetInvestmentAssessment(ledger.orgId,change.subject_id,change.submitted_by,{...change.payload,idempotencyKey:randomUUID()})
      async function approve(id:string) {
        await submitFinancialChange(ledger.orgId,id,change.submitted_by)
        const gate=(await db.execute<{id:string}>(sql`select id from flow_gates where org_id=${ledger.orgId} and subject_id=${id} and status='pending'`)).rows[0]!
        await decideGate({gateId:gate.id,userId:change.approved_by,decision:'approved'})
      }
      await approve(replacementId);await applyNetInvestmentAssessment(ledger.orgId,replacementId,change.submitted_by)
      const interest=(await db.execute<{subsidiary_id:string}>(sql`select subsidiary_id from subsidiary_ownership_interests where org_id=${ledger.orgId} and id=${change.subject_id}`)).rows[0]!
      const periodId=(await db.execute<{id:string}>(sql`select id from accounting_periods where org_id=${ledger.orgId} and name='2026-07'`)).rows[0]!.id
      await db.execute(sql`insert into consolidated_fx_rates(org_id,period_id,from_currency,to_currency,current_rate,average_rate,historical_rate,source)
        values(${ledger.orgId},${periodId},'USD','CAD','1.4','1.375','1.35','manual')`)
      const disposal:LossOfControlInput={effectiveOn:'2026-07-31',reason:'Liquidate the foreign operation after releasing its qualified translation reserve',idempotencyKey:randomUUID(),
        assessment:'The signed liquidation decision terminates all voting and controlling rights in the foreign operation at the reporting date.',
        ociAssessment:'The wholly owned operation has an attributable net-investment translation reserve of negative five hundred CAD, which is recycled to profit or loss on disposal.',
        eliminationSubsidiaryId:change.payload.eliminationSubsidiaryId,proceeds:'0',proceedsAccountId:org.roles.bank,parentInvestmentCarrying:'0',parentRetainedCarrying:'0',parentToGroupRate:'1',
        investmentTranslationAccountId:org.roles.netInvestmentOci,retainedFairValue:'0',retainedPercent:'0',retainedMethod:'none',retainedAccountId:org.roles.investmentInSub,
        gainLossAccountId:org.roles.disposalGainLoss,parentGainLossAccountId:org.roles.disposalGainLoss,equityIncomeAccountId:org.roles.equityMethodIncome,
        distributionAccountId:null,distributionIncomeAccountId:null,rates:[{subsidiaryId:interest.subsidiary_id,rate:'1.4'}],additionalConsolidationLines:[],
        oci:[{accountId:org.roles.netInvestmentOci,balance:'-500',treatment:'profit_loss',destinationAccountId:org.roles.fxUnrealizedGainLoss,description:'Release qualified net-investment FX on foreign-operation disposal'}]}
      const disposalId=await proposeLossOfControl(ledger.orgId,change.subject_id,change.submitted_by,disposal)
      await approve(disposalId);await applyLossOfControl(ledger.orgId,disposalId,change.submitted_by)
      const released=(await db.execute<{amount:string}>(sql`select sum(line.amount)::text as amount from journal_lines line join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
        where line.org_id=${ledger.orgId} and line.account_id=${org.roles.netInvestmentOci} and entry.posting_date<='2026-07-31' and entry.status in ('posted','reversed')`)).rows[0]!.amount
      assert.equal(released,'0.0000')
      await assert.rejects(proposeNetInvestmentReversal(ledger.orgId,replacementId,change.submitted_by,{effectiveOn:'2026-07-31',reason:'Correct a reserve already released by disposal',idempotencyKey:randomUUID()}),/correct that loss-of-control event/)
      await db.execute(sql`update user_permission_overrides set effect='deny' where org_id=${ledger.orgId} and user_id=${change.submitted_by} and permission='close.run'`)
      await assert.rejects(applyNetInvestmentReversal(ledger.orgId,reverseId,change.submitted_by),/not found/i)
    })
  }finally{await org.drop()}
})
