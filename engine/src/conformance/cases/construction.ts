/**
 * Construction contracts — progress billing, change orders, and expected losses.
 *
 * Progress toward completion is measured by the GAIA G702/G703 application
 * engine (`computeApplication`, `revisedScheduleValue`) and by the
 * cost-to-cost input method (`costToCostPercent`): all three are product code,
 * driven here with exact-amount fixtures. A contract that is expected to lose
 * money is assessed through the governed provision approval and posting path.
 *
 * No text from any accounting standard appears in this file; each
 * `requirement` line is our own restatement of the cited paragraph.
 */

import {
  computeApplication,
  revisedScheduleValue,
} from "../../projects/construction-billing.ts";
import { costToCostPercent } from "../../projects/revenue.ts";
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db,withOrgContext } from '../../platform/db.ts'
import { postEntry } from '../../journal/post-entry.ts'
import { seedFlowActors,seedApprovalFlow } from '../../testing/fixtures.ts'
import { submitFinancialChange } from '../../flows/financial-changes-adapter.ts'
import { decideGate } from '../../flows/gates.ts'
import { proposeProvisionAssessment,applyProvisionAssessment } from '../../provisions/assessments.ts'
import { capture } from '../ledger-helpers.ts'
import type { ConformanceCase } from "../types.ts";

export const CONSTRUCTION_CASES: readonly ConformanceCase[] = [
  {
    id: "con-application-measures-progress",
    title: "A progress application measures work done, withholds retainage, and states the amount due",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-25-27",
        kind: "requirement",
        requirement:
          "Revenue is recognised over time as the entity performs, measured by progress toward complete satisfaction of the obligation.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.35",
        kind: "requirement",
        requirement:
          "Revenue is recognised over time where performance creates an asset the customer controls as it is created.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Each schedule line reports what was completed this period, the retainage held back on it, and the net now due — and the application's totals are exactly the sum of its lines, so nothing is lost between the detail and the invoice.",
    facts: [
      "Line one: scheduled 100,000.00, previously completed 20,000.00, this period 30,000.00 plus 5,000.00 of materials stored, retainage 10%.",
      "Line two: scheduled 50,000.00, this period 10,000.00, retainage 5%.",
      "Line one grosses 35,000.00 with 3,500.00 held (55% complete); line two grosses 10,000.00 with 500.00 held (20% complete).",
      "The application grosses 45,000.00, holds 4,000.00, and 41,000.00 is currently due.",
    ],
    expected: {
      values: {
        line1Gross: "35000.0000",
        line1Retainage: "3500.0000",
        line1Net: "31500.0000",
        line1PercentComplete: "55.00",
        line2Gross: "10000.0000",
        line2Retainage: "500.0000",
        line2Net: "9500.0000",
        line2PercentComplete: "20.00",
        grossThisPeriod: "45000.0000",
        retainageThisPeriod: "4000.0000",
        currentDue: "41000.0000",
      },
    },
    run: () => {
      const app = computeApplication([
        {
          sovLineId: "s1",
          scheduledValue: "100000",
          previousCompleted: "20000",
          previousMaterialsStored: "0",
          thisPeriodCompleted: "30000",
          materialsStored: "5000",
          retainagePercent: "10",
        },
        {
          sovLineId: "s2",
          scheduledValue: "50000",
          previousCompleted: "0",
          previousMaterialsStored: "0",
          thisPeriodCompleted: "10000",
          materialsStored: "0",
          retainagePercent: "5",
        },
      ]);
      const line1 = app.lines[0]!;
      const line2 = app.lines[1]!;
      return {
        values: {
          line1Gross: line1.grossThisPeriod,
          line1Retainage: line1.retainageThisPeriod,
          line1Net: line1.netThisPeriod,
          line1PercentComplete: line1.percentComplete,
          line2Gross: line2.grossThisPeriod,
          line2Retainage: line2.retainageThisPeriod,
          line2Net: line2.netThisPeriod,
          line2PercentComplete: line2.percentComplete,
          grossThisPeriod: app.grossThisPeriod,
          retainageThisPeriod: app.retainageThisPeriod,
          currentDue: app.currentDue,
        },
      };
    },
  },

  {
    id: "con-change-order-revises-capacity",
    title: "An approved change order revises the contract value but never below work already billed",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-25-10",
        kind: "requirement",
        requirement:
          "A change to the scope or price of a contract revises the remaining consideration the entity expects for the remaining promises.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.18",
        kind: "requirement",
        requirement:
          "A contract modification changes the scope or price (or both) approved by the parties and revises what remains to be performed.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Additions and deductions move the schedule line's capacity by exactly the change amount — but a deduction that would erase already-billed work is refused, so billed revenue can never be stranded without a contract value behind it.",
    facts: [
      "A schedule line of 1,000.00 with 400.00 already billed.",
      "An additive change of 250.00 revises capacity to 1,250.00.",
      "A deductive change of 500.00 revises capacity to 500.00.",
      "A deductive change of 700.00 would leave 300.00 of capacity against 400.00 billed, and is refused.",
    ],
    expected: {
      values: {
        revisedUp: "1250.0000",
        revisedDown: "500.0000",
        excessiveDeductionRefused: "true",
      },
    },
    run: () => {
      const revisedUp = revisedScheduleValue("1000", "250", "400");
      const revisedDown = revisedScheduleValue("1000", "-500", "400");
      let refused = false;
      try {
        revisedScheduleValue("1000", "-700", "400");
      } catch {
        refused = true;
      }
      return {
        values: {
          revisedUp,
          revisedDown,
          excessiveDeductionRefused: String(refused),
        },
      };
    },
  },

  {
    id: "con-cost-to-cost-progress",
    title: "Cost-to-cost measures progress by the share of budget consumed",
    citations: [
      {
        standard: "ASC 606",
        reference: "606-10-25-31",
        kind: "requirement",
        requirement:
          "Progress toward complete satisfaction of an over-time obligation is measured by a single input or output method applied consistently.",
      },
      {
        standard: "IFRS 15",
        reference: "IFRS 15.39",
        kind: "requirement",
        requirement:
          "A single method of measuring progress is applied to each over-time obligation, including input methods based on costs incurred.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Progress is the exact share of budget consumed — a quarter of the budget spent is 25% complete — capped at 100% when costs overrun, and zero when no cost has been incurred yet. With no budget, progress is unmeasurable and is refused rather than read as zero, so an unbudgeted project can neither report phantom progress nor have revenue already recognized re-planned to nothing.",
    facts: [
      "Budget 500,000.00 with 125,000.00 of cost incurred: 25% complete.",
      "Cost of 600,000.00 against the same budget: complete, capped at 100%, not 120%.",
      "No cost incurred against the budget: 0% complete.",
      "No budget: progress is unmeasurable, not 0%.",
    ],
    expected: {
      values: {
        quarterSpent: "25.0000",
        overrunCapped: "100.0000",
        noBudget: "unmeasurable",
        noCost: "0.0000",
      },
    },
    run: () => ({
      values: {
        quarterSpent: costToCostPercent("500000", "125000") ?? "unmeasurable",
        overrunCapped: costToCostPercent("500000", "600000") ?? "unmeasurable",
        noBudget: costToCostPercent("0", "100") ?? "unmeasurable",
        noCost: costToCostPercent("500000", "0") ?? "unmeasurable",
      },
    }),
  },

  {
    id: "con-expected-loss-provided",
    title: "A contract expected to lose money provides for the full loss immediately",
    citations: [
      {
        standard: "IAS 37",
        reference: "IAS 37.66",
        kind: "requirement",
        requirement:
          "When a contract's unavoidable costs exceed its economic benefits it is onerous, and the present obligation under it is recognised as a provision in full.",
      },
      {
        standard: "ASC 450",
        reference: "450-20-25-2",
        kind: "requirement",
        requirement:
          "An estimated loss from a loss contingency is accrued when it is probable and reasonably estimable, which a priced construction contract that cannot cover its costs satisfies.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "The moment a contract is forecast to lose money, the entire expected loss is charged to profit or loss at once — it is never spread over the remaining term to flatter early periods.",
    facts: [
      "A fixed-price contract for 1,000,000.00 with 200,000.00 of revenue recognised and 200,000.00 of cost incurred to date.",
      "Costs to complete are re-estimated at 950,000.00, so total cost will be 1,150,000.00 against 1,000,000.00 of revenue: a 150,000.00 loss.",
      "A provision of 150,000.00 is recognised immediately, in addition to the costs already incurred.",
    ],
    expected: {
      entries:[{step:"loss-provision",lines:[{role:"provisionExpense",amount:"150000.0000"},{role:"provisionLiability",amount:"-150000.0000"}]}],
      values: {
        totalForecastCost: "1150000.0000",
        expectedLoss: "150000.0000",
        lossProvision: "150000.0000",
      },
    },
    run:async ctx=> {
      const ledger=ctx.ledger!, projectId=randomUUID()
      const actors=await withOrgContext(ledger.orgId, async()=> {
        const actors=await seedFlowActors(ledger.orgId)
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{reportingFramework}','"ifrs"') where id=${ledger.orgId}`)
        await db.execute(sql`insert into projects(id,org_id,code,name,subsidiary_id,contract_value) values (${projectId},${ledger.orgId},'CONF-LOSS','Fixed-price construction',${ledger.subsidiaryId},1000000)`)
        await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values
          (${ledger.orgId},${actors.submitterId},'gl.manage','grant'),(${ledger.orgId},${actors.submitterId},'gl.post','grant'),(${ledger.orgId},${actors.submitterId},'projects.read','grant')`)
        await seedApprovalFlow(ledger.orgId,{subjectKind:'financial_change',assignees:[{type:'user',userId:actors.approver1Id}],mode:'any',preventSelfApproval:true})
        return actors
      })
      return withOrgContext(ledger.orgId,async()=> {
        await postEntry(db,{orgId:ledger.orgId,bookId:ledger.bookId,subsidiaryId:ledger.subsidiaryId,entryNumber:'CONF-RESULTS',postingDate:ledger.date,periodId:ledger.periodId,origin:'manual',currency:'CAD',actorId:actors.submitterId,
          lines:[{accountId:ctx.roles.provisionExpense,amount:'200000',projectId},{accountId:ctx.roles.revenue,amount:'-200000',projectId}]})
        const id=await proposeProvisionAssessment(ledger.orgId,actors.submitterId,{
          obligation:{id:randomUUID(),subsidiaryId:ledger.subsidiaryId,bookId:ledger.bookId,currency:'CAD',name:'Construction expected loss',expenseAccountId:ctx.roles.provisionExpense,liabilityAccountId:ctx.roles.provisionLiability,projectId},
          effectiveOn:ledger.date,idempotencyKey:randomUUID(),reason:'Recognize the current supported contract loss in full',
          assessment:{presentObligation:true,outflow:'probable',reliablyEstimable:true,evidence:'Approved contract and supported remaining direct and allocated cost forecast.',discounting:'immaterial',discountEvidence:'Work completes shortly and time value is immaterial.',estimate:null},
          construction:{remainingCost:'950000',terminationAvailable:false,terminationCost:null,relatedAssetsReviewed:true,impairmentEvidence:'Related contract assets have been reviewed and no further impairment is required.'},
        })
        await submitFinancialChange(ledger.orgId,id,actors.submitterId)
        const gate=(await db.execute<{id:string}>(sql`select id from flow_gates where org_id=${ledger.orgId} and subject_id=${id} and status='pending'`)).rows[0]!
        await decideGate({gateId:gate.id,userId:actors.approver1Id,decision:'approved'})
        let result:Record<string,unknown>={}
        const entry=await capture(ctx,'loss-provision',async()=>{result=await applyProvisionAssessment(ledger.orgId,id,actors.submitterId)})
        const forecast=result.construction as {totalForecastCost:string;expectedLoss:string}
        return {entries:[entry],values:{totalForecastCost:forecast.totalForecastCost,expectedLoss:forecast.expectedLoss,lossProvision:String(result.liability)}}
      })
    },
  },
];
