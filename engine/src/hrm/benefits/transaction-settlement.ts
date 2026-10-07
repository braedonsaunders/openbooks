import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { apportion, fromUnits, toUnits } from "../../money/money.ts";
import { fromQuantityUnits, toQuantityUnits } from "../../money/quantity.ts";
import { BenefitsError } from "./errors.ts";
import { db, requireCivilDate } from "./shared.ts";
import { partitionMembers, requirePeriodShape, type IncentiveComputation, type IncentiveMeasured, type IncentivePeriodBasis } from "./incentive-math.ts";
import { computeTransactionIncentive, type TransactionIncentiveResult } from "./transaction-incentive-math.ts";
import { measureTransactionIncentiveSources, type TransactionIncentiveSourceSnapshot } from "./transaction-incentive-sources.ts";
import { readTransactionPolicy, validateTransactionPolicy, type BenefitTransactionPolicy } from "./transaction-policy.ts";
import type { BenefitProgram, BenefitProgramMember } from "./program-types.ts";

export interface TransactionSettlementSnapshot {
  readonly metric: "transactions";
  readonly scope: "company";
  readonly value: string;
  readonly currency: string;
  readonly entryCount: number;
  readonly lineCount: number;
  readonly digest: string;
  readonly policy: BenefitTransactionPolicy;
  readonly source: TransactionIncentiveSourceSnapshot;
  readonly result: TransactionIncentiveResult;
  readonly priorAwards: readonly { readonly id: string; readonly value: string; readonly status: string; readonly employmentId: string; readonly groups: readonly { readonly groupId: string; readonly value: string }[] }[];
}
interface PriorAward extends Record<string, unknown> { id:string; employment_id:string; value:string; status:string; adjusts_award_id:string|null; source_snapshot:Record<string,unknown>; period_from:string; period_to:string|null }

/** Actual obligations consume a ceiling; negative recoveries release room only after approval. */
async function consumption(orgId: string, programId: string, from: string): Promise<{ totals:Map<string,bigint>; evidence:TransactionSettlementSnapshot["priorAwards"]; usedSources:Set<string> }> {
  const rows=(await db.execute<PriorAward>(sql`select id,employment_id,value::text,status,adjusts_award_id,source_snapshot,period_from::text,period_to::text from hrm_benefit_awards where org_id=${orgId} and program_id=${programId} order by id for share`)).rows;
  const byId=new Map(rows.map(r=>[r.id,r]));
  if (!rows.some(r=>r.period_from===from && !["voided","rejected"].includes(r.status)) && rows.some(r=>r.period_from>from && !["voided","rejected"].includes(r.status))) throw new BenefitsError("REFUSED","Later transaction awards already consume these group ceilings — settle new periods chronologically; preserve existing awards and use their native adjusting-award action for corrections.");
  const totals=new Map<string,bigint>(),usedSources=new Set<string>();
  const evidence:TransactionSettlementSnapshot["priorAwards"][number][]=[];
  for (const row of rows) {
    if (row.period_from>=from || ["voided","rejected"].includes(row.status)) continue;
    if ((row.period_to??row.period_from)>=from) throw new BenefitsError("REFUSED","An earlier award overlaps this source period — review the existing award's period before settling a new span.");
    const signed=toUnits(row.value);
    if (signed<0n && !["approved","queued","delivered"].includes(row.status)) continue;
    let root=row; const seen=new Set<string>();
    while (root.adjusts_award_id!==null) {
      if (seen.has(root.id)) throw new BenefitsError("REFUSED","The adjusting-award chain contains a cycle — retain the award records and have the administrator repair the invalid correction relationship before settlement.");
      seen.add(root.id);const parent=byId.get(root.adjusts_award_id);
      if (!parent || parent.employment_id!==row.employment_id) throw new BenefitsError("REFUSED","An adjusting award has no matching recipient's original source evidence — review its native award history before settlement.");
      root=parent;
    }
    const frozen=(root.source_snapshot?.measurement as { settlement?:Record<string,unknown> } | undefined)?.settlement;
    const snapshot=frozen?.transaction as TransactionSettlementSnapshot | undefined;
    if (!snapshot || snapshot.metric!=="transactions") throw new BenefitsError("REFUSED","A previous award in this transaction program has no transaction allocation evidence — retain it and review its native award history before settling further periods.");
    for (const line of snapshot.source.lines) usedSources.add(line.sourceId);
    const weights=snapshot.result.groups.map(g=>({groupId:g.groupId,value:toUnits(g.recipients.find(r=>r.employmentId===row.employment_id)?.value??"0")})).filter(g=>g.value>0n).sort((a,b)=>a.groupId.localeCompare(b.groupId));
    if (!weights.length) throw new BenefitsError("REFUSED","A previous recipient award has no group allocation — review its original transaction award evidence before consuming a ceiling.");
    // Corrections retain their original recipient's group proportions. The
    // existing currency quantum makes this split payable and deterministic.
    const precision=frozen?.minorUnits;
    if (typeof precision!=="number" || !Number.isInteger(precision) || precision<0 || precision>4) throw new BenefitsError("REFUSED","A stored transaction award has no valid currency quantum — review its original source evidence before consuming a ceiling.");
    const quantum=10n**BigInt(4-precision);
    if (signed%quantum!==0n) throw new BenefitsError("REFUSED","A stored transaction award is finer than its recorded currency quantum — reconcile the original award evidence before settlement.");
    const split=apportion((signed<0n ? -signed : signed)/quantum,weights.map(g=>g.value));
    const groups=weights.map((g,i)=>{const value=split[i]!*quantum*(signed<0n ? -1n:1n);totals.set(g.groupId,(totals.get(g.groupId)??0n)+value);return {groupId:g.groupId,value:fromUnits(value)};});
    evidence.push({id:row.id,employmentId:row.employment_id,value:row.value,status:row.status,groups});
  }
  return {totals,evidence,usedSources};
}

/** Same measurement and allocation feeds native preview and settlement. */
export async function measureTransactionSettlement(input: {
  readonly orgId:string;readonly actorId:string;readonly program:BenefitProgram;readonly members:readonly BenefitProgramMember[];
  readonly minorUnits:number;readonly basis:IncentivePeriodBasis;readonly periodFrom:string;readonly periodTo:string;
}): Promise<{ measured:IncentiveMeasured;computation:IncentiveComputation;excluded:string[];transactionSnapshot:TransactionSettlementSnapshot }> {
  const {orgId,actorId,program,periodFrom,periodTo,minorUnits}=input;
  requireCivilDate(periodFrom,"periodFrom");requireCivilDate(periodTo,"periodTo");requirePeriodShape(program.frequency,periodFrom,periodTo,input.basis);
  if (periodFrom<program.effectiveFrom || (program.effectiveTo!==null && periodTo>program.effectiveTo)) throw new BenefitsError("REFUSED","The source period is outside this program's effective dates — choose a covered span or its effective replacement program.");
  if (program.legalEntityId===null || program.allocation!=="responsibility" || !["percent","per_unit"].includes(program.valuation)) throw new BenefitsError("REFUSED","Transaction settlement needs the responsible employer, dated responsibility allocation and a percent or per-unit rate — correct the draft program before activation.");
  const policy=await readTransactionPolicy(db,orgId,program.id);
  if (!policy) throw new BenefitsError("REFUSED","Configure this program's Transaction rules before measuring an incentive.");
  await validateTransactionPolicy(db,orgId,program.legalEntityId,policy,program.currency);
  const rate=program.valuation==="percent" ? program.percentRate : program.fixedAmount;
  if (rate===null) throw new BenefitsError("REFUSED","The program has no configured valuation rate — record its percent or amount per unit before activation.");
  const status=policy.documentKind==="customer_invoice" ? "posted" : "approved";
  const selected=(await db.execute<{id:string}>(sql`select l.id from documents d join document_lines l on l.org_id=d.org_id and l.document_id=d.id where d.org_id=${orgId} and d.subsidiary_id=${program.legalEntityId} and d.kind=${policy.documentKind} and d.status=${status} and d.document_date between ${periodFrom}::date and ${periodTo}::date and l.item_id=any(${`{${policy.itemIds.join(",")}}`}::uuid[]) order by d.id,l.id for share of d,l`)).rows;
  if (!selected.length) throw new BenefitsError("REFUSED","No approved transactions match this program's items and document-date period — review the native source selection before settlement; no empty award is recorded.");
  const source=await measureTransactionIncentiveSources({orgId,actorId,legalEntityId:program.legalEntityId,currency:program.currency,documentKind:policy.documentKind,itemIds:policy.itemIds,lineIds:selected.map(r=>r.id),groupingSegmentId:policy.groupingSegmentId});
  const prior=await consumption(orgId,program.id,periodFrom);
  const covered=new Set(partitionMembers(input.members,periodFrom,periodTo).covered.map(r=>r.employmentId));
  const facts=source.lines.map(line=>{
    if (prior.usedSources.has(line.sourceId)) throw new BenefitsError("REFUSED",`Source line ${line.sourceId} already belongs to an earlier award — preserve that obligation and use its native adjusting-award action instead of paying the line again.`);
    const recipients=policy.positions.map(position=>{
      const binding=policy.responsibilities.filter(r=>r.groupId===line.groupId && r.positionKey===position.key && r.effectiveFrom<=line.documentDate && (r.effectiveTo===null || r.effectiveTo>=line.documentDate));
      if (binding.length!==1 || !covered.has(binding[0]!.employmentId)) throw new BenefitsError("REFUSED",`Source ${line.documentNumber} group ${line.groupId} needs one dated ${position.name} assignment and full-period program membership — record the assignment and enroll the employment, or select its covered manual span; missing shares are never redistributed.`);
      return {shareKey:position.key,employmentId:binding[0]!.employmentId};
    });
    return {sourceId:line.sourceId,groupId:line.groupId,occurredOn:line.documentDate,currency:line.currency,amount:line.amount,quantity:line.quantity,recipients};
  });
  const groups=[...new Set(facts.map(r=>r.groupId))].sort().map(groupId=>{
    const limit=policy.limits.find(r=>r.groupId===groupId);
    if (!limit) throw new BenefitsError("REFUSED",`Group ${groupId} has no ceiling decision — record an amount or explicitly select no limit in Transaction rules before settlement.`);
    return {groupId,limit:limit.kind==="none" ? {kind:"none" as const} : {kind:"amount" as const,amount:limit.amount!,previouslyAwarded:fromUnits(prior.totals.get(groupId)??0n)}};
  });
  const result=computeTransactionIncentive({currency:program.currency,minorUnits,periodFrom,periodTo,valuation:program.valuation==="percent" ? "percent_of_amount" : "amount_per_unit",rate,recipientShares:policy.positions.map(r=>({key:r.key,weight:r.weight}))},facts,groups);
  const uncapped=computeTransactionIncentive({currency:program.currency,minorUnits,periodFrom,periodTo,valuation:program.valuation==="percent" ? "percent_of_amount" : "amount_per_unit",rate,recipientShares:policy.positions.map(r=>({key:r.key,weight:r.weight}))},facts,groups.map(g=>({groupId:g.groupId,limit:{kind:"none" as const}})));
  const measuredValue=program.valuation==="percent" ? fromUnits(facts.reduce((s,r)=>s+toUnits(r.amount),0n)) : fromQuantityUnits(facts.reduce((s,r)=>s+toQuantityUnits(r.quantity),0n));
  const potential=fromUnits(result.groups.reduce((s,g)=>s+toUnits(g.potentialAward),0n));
  const computation:IncentiveComputation={measuredValue,poolValue:potential,thresholdMet:true,currency:program.currency,totalAwarded:result.totalAwarded,undistributed:fromUnits(toUnits(potential)-toUnits(result.totalAwarded)),excludedZero:[],summaryLines:[`${program.code}: ${rate} ${program.valuation==="percent" ? "% of approved source amount" : `${program.currency} per approved source unit`}; ${source.lines.length} source lines grouped by ${source.grouping?.key??"employer"}.`,`Dates use recorded document date; payment is available ${program.paymentDelayDays} days after the earning period closes.`,`Each group rounds once to ${minorUnits} currency places, then apportions recipient shares; existing obligations consume recorded group ceilings.`],recipients:result.recipients.map(r=>({employmentId:r.employmentId,share:"dated responsibility",grossValue:uncapped.recipients.find(g=>g.employmentId===r.employmentId)?.value??"0.0000",value:r.value,capped:result.groups.some(g=>g.availableLimit!==null && toUnits(g.awarded)<toUnits(g.potentialAward) && g.recipients.some(x=>x.employmentId===r.employmentId)),explanation:`${r.value} ${program.currency} from dated responsibility shares across ${result.groups.filter(g=>g.recipients.some(x=>x.employmentId===r.employmentId)).length} transaction groups.`}))};
  const evidence={metric:"transactions" as const,scope:"company" as const,value:measuredValue,currency:program.currency,entryCount:new Set(source.lines.map(r=>r.documentId)).size,lineCount:source.lines.length,policy,source,result,priorAwards:prior.evidence};
  const transactionSnapshot={...evidence,digest:createHash("sha256").update(JSON.stringify(evidence)).digest("hex")};
  return {measured:{metric:"transactions",scope:"company",sourceAccountIds:[],periodFrom,periodTo,value:measuredValue,currency:program.valuation==="percent" ? program.currency:null},computation,excluded:result.excluded.map(r=>`${r.sourceId}: ${r.reason}`),transactionSnapshot};
}
