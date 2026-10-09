import { sql } from "drizzle-orm";
import { fromUnits, mulRatio, sum, toUnits } from "../money/money.ts";
import { canonicalDecimal, divideDecimal } from "../money/exact-decimal.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { assertValidControlAccountMappings } from "../records/control-accounts.ts";
import { ContractorWithholdingError } from "./scheme.ts";

/** Source membership is frozen; functional amounts are resolved from the current native entries in the posting book. */
export interface WithholdingCarryingSource {
  deductionIds: string[];
  previousDocumentIds: string[];
  liabilityAccountIds: string[];
}
interface Deduction extends Record<string, unknown> {
  id: string; paymentId: string; entryId: string; accountId: string; transactionAmount: string; statutoryAmount: string;
  currency: string; statutoryCurrency: string; subsidiaryId: string; enrollmentId: string; status: string;
}
interface CarryingAmount { accountId: string; amount: string; currency:string; txnAmount:string; fxRate:string }
const refuse = (message: string): never => { throw new ContractorWithholdingError(message, "Delete or void the authority document and prepare it again from the current withholding sources."); };
const idsSql = (ids: readonly string[]) => sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);
function validIds(value: unknown): value is string[] { return Array.isArray(value) && value.every(isUuid) && new Set(value).size === value.length; }

/** Allocate an aggregated native liability credit without losing a ledger quantum across deductions. */
export function allocateWithholdingCarrying(amount: string, deductions: readonly { id: string; transactionAmount: string }[]): Map<string, string> {
  const denominator = toUnits(sum(deductions.map(row => row.transactionAmount)));
  if (denominator <= 0n || toUnits(amount) < 0n) return refuse("The payment liability cannot be allocated to its withholding deductions.");
  let accumulated = 0n, allocated = 0n;
  const result = new Map<string, string>();
  for (const row of [...deductions].sort((a,b) => a.id.localeCompare(b.id))) {
    const weight = toUnits(row.transactionAmount);
    if (weight < 0n) return refuse("The payment withholding transaction amount is invalid.");
    accumulated += weight;
    const cumulative = toUnits(mulRatio(amount, accumulated, denominator));
    result.set(row.id, fromUnits(cumulative - allocated));
    allocated = cumulative;
  }
  return result;
}

export function withholdingCarryingChanged(rows: readonly CarryingAmount[]): boolean {
  const balances=new Map<string,{functional:bigint;transaction:bigint}>();
  for(const row of rows) {
    const key=`${row.accountId}:${row.currency}`,prior=balances.get(key);
    balances.set(key,{functional:(prior?.functional ?? 0n)+toUnits(row.amount),transaction:(prior?.transaction ?? 0n)+toUnits(row.txnAmount)});
  }
  return [...balances.values()].some(row=>row.functional!==0n || row.transaction!==0n);
}

/** A tax payable is denominated in the statutory currency even when its vendor payment uses another currency. */
export function stampPaymentWithholdingCurrency<T extends FunctionalLine>(doc: { kind:string;custom:unknown }, lines:T[]):T[] {
  if(doc.kind!=='vendor_payment') return lines;
  const custom=doc.custom as {withholdings?:{liabilityAccountId:string;reporting?:{currency:string;deducted:string}}[]} | null;
  if(!Array.isArray(custom?.withholdings)) return lines;
  return lines.map(line=>{
    if(line.memo!=='Contractor withholding') return line;
    const sources=custom.withholdings!.filter(row=>row.liabilityAccountId===line.accountId);
    if(!sources.every(row=>row.reporting)) return line;
    const currency=sources[0]!.reporting!.currency;
    if(sources.some(row=>row.reporting!.currency!==currency)) return refuse("The payment's withholding liability mixes statutory currencies.");
    const txnAmount=fromUnits(-toUnits(sum(sources.map(row=>row.reporting!.deducted))));
    if(toUnits(txnAmount)===0n || (toUnits(txnAmount)<0n)!==(toUnits(line.amount)<0n)) return refuse("The payment's statutory currency liability is invalid.");
    return {...line,currency,txnAmount,fxRate:divideDecimal(line.amount,txnAmount,10)};
  });
}

async function deductionRows(executor: SqlExecutor, orgId: string, deductionIds: string[]): Promise<Deduction[]> {
  if (!deductionIds.length) return [];
  // The posted payment's immutable account evidence, rather than today's enrollment account, identifies the credit.
  const selected = (await executor.execute<{ paymentId: string }>(sql`
    select distinct payment_document_id as "paymentId" from withholding_deductions
     where org_id=${orgId} and id in (${idsSql(deductionIds)})`)).rows;
  if (!selected.length) return refuse("The withholding carrying source deductions are missing.");
  const rows = (await executor.execute<Deduction>(sql`
    select w.id,w.payment_document_id as "paymentId",p.posted_entry_id as "entryId",
           evidence.value->>'liabilityAccountId' as "accountId",
           coalesce(w.transaction_deducted_amount,w.deducted_amount)::text as "transactionAmount",
           w.deducted_amount::text as "statutoryAmount",w.currency as "statutoryCurrency",coalesce(w.transaction_currency,w.currency) as currency,
           w.subsidiary_id as "subsidiaryId",w.enrollment_id as "enrollmentId",w.status
      from withholding_deductions w join documents p on p.org_id=w.org_id and p.id=w.payment_document_id and p.kind='vendor_payment' and p.status='posted'
      join lateral jsonb_array_elements(p.custom->'withholdings') evidence(value)
        on evidence.value->>'openLineId'=w.bill_open_line_id::text and evidence.value->>'enrollmentId'=w.enrollment_id::text
     where w.org_id=${orgId} and w.payment_document_id in (${idsSql(selected.map(row=>row.paymentId))})
     order by w.payment_document_id,w.id`)).rows;
  if (new Set(rows.map(row=>row.id)).size !== rows.length || deductionIds.some(id=>!rows.some(row=>row.id===id))) return refuse("The payment's immutable withholding account evidence is missing or ambiguous.");
  return rows;
}

export async function captureWithholdingCarryingSource(executor: SqlExecutor, orgId: string, deductionIds: string[], previousDocumentIds: string[]): Promise<WithholdingCarryingSource> {
  if (!validIds(deductionIds) || !validIds(previousDocumentIds)) return refuse("The withholding carrying source identities are invalid.");
  const rows = await deductionRows(executor, orgId, deductionIds);
  const accounts = rows.filter(row=>deductionIds.includes(row.id)).map(row=>row.accountId);
  if (previousDocumentIds.length) {
    const previous = (await executor.execute<{ id: string; accounts: unknown }>(sql`
      select d.id,coalesce(d.custom->'withholdingRemittance'->'carrying'->'liabilityAccountIds',d.custom->'withholdingDeposit'->'carrying'->'liabilityAccountIds',
        (select jsonb_agg(distinct l.account_id) from document_lines l where l.org_id=d.org_id and l.document_id=d.id)) as accounts
       from documents d where d.org_id=${orgId} and d.id in (${idsSql(previousDocumentIds)}) and d.status='posted'`)).rows;
    if (previous.length!==previousDocumentIds.length) return refuse("A previous authority carrying source is no longer posted.");
    for (const row of previous) {
      if (!validIds(row.accounts)) return refuse("A previous authority source has no governed liability account evidence.");
      accounts.push(...row.accounts);
    }
  }
  if (!accounts.every(isUuid)) return refuse("The withholding carrying liability account evidence is invalid.");
  return { deductionIds: [...deductionIds].sort(), previousDocumentIds: [...previousDocumentIds].sort(), liabilityAccountIds: [...new Set(accounts)].sort() };
}

export async function resolveWithholdingCarrying(executor: SqlExecutor, input: {
  orgId: string; subsidiaryId: string; enrollmentId: string; source: WithholdingCarryingSource; documentId?: string; bookId?: string | null;
}): Promise<CarryingAmount[]> {
  const { orgId, subsidiaryId, enrollmentId, source } = input;
  if (!source || !validIds(source.deductionIds) || !validIds(source.previousDocumentIds) || !validIds(source.liabilityAccountIds)
      || source.previousDocumentIds.includes(input.documentId ?? "")) return refuse("The withholding carrying source identities are invalid.");
  const books = (await executor.execute<{ id: string }>(sql`select id from accounting_books where org_id=${orgId} and ${input.bookId ? sql`id=${input.bookId}` : sql`is_primary`} and is_active and posts_gl for share`)).rows;
  if (books.length!==1) return refuse("Withholding carrying values require an active authoritative posting book.");
  const bookId = books[0]!.id;
  const rows = await deductionRows(executor, orgId, source.deductionIds);
  const selected = rows.filter(row=>source.deductionIds.includes(row.id));
  if (selected.some(row=>row.status!=='posted' || row.enrollmentId!==enrollmentId || row.subsidiaryId!==subsidiaryId || !source.liabilityAccountIds.includes(row.accountId))) return refuse("The withholding carrying deductions no longer belong to the posted enrolled legal entity.");
  const movements: {accountId:string;currency:string;amount:bigint;transactionAmount:bigint}[]=[];
  const addMovement=(accountId:string,currency:string,amount:bigint,transactionAmount:bigint)=>{
    movements.push({accountId,currency,amount,transactionAmount});
  };
  const groups = new Map<string, Deduction[]>();
  for (const row of rows) {
    if (!isUuid(row.accountId) || canonicalDecimal(row.transactionAmount,4)===null) return refuse("The payment liability carrying evidence is invalid.");
    const key = `${row.paymentId}:${row.accountId}`;
    groups.set(key,[...(groups.get(key) ?? []),row]);
  }
  for (const group of groups.values()) {
    if (!group.some(row=>source.deductionIds.includes(row.id))) continue;
    const first = group[0]!;
    const legs = (await executor.execute<{ amount: string; transactionAmount: string;currency:string }>(sql`
      select l.currency,sum(l.amount)::text as amount,sum(l.txn_amount)::text as "transactionAmount"
       from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id
       where l.org_id=${orgId} and ${input.bookId ? sql`true` : sql`e.id=${first.entryId}`} and e.book_id=${bookId} and e.status='posted' and e.source_document_id=${first.paymentId}
         and l.subsidiary_id=${subsidiaryId} and l.account_id=${first.accountId}
         and l.memo='Contractor withholding' and l.contributor_kind is null group by l.currency`)).rows;
    const leg=legs[0];
    const statutory=leg?.currency===first.statutoryCurrency;
    const transactionTotal=sum(group.map(row=>statutory ? row.statutoryAmount : row.transactionAmount));
    if (!leg || canonicalDecimal(leg.amount,4)===null || canonicalDecimal(leg.transactionAmount,4)===null
        || legs.length!==1 || (leg.currency!==first.currency && !statutory) || toUnits(leg.amount)>0n || toUnits(leg.transactionAmount)!==-toUnits(transactionTotal)) return refuse("The actual posted payment liability disagrees with its immutable deduction evidence.");
    const allocated = allocateWithholdingCarrying(fromUnits(-toUnits(leg.amount)),group.map(row=>({...row,transactionAmount:statutory ? row.statutoryAmount : row.transactionAmount})));
    for (const row of group.filter(row=>source.deductionIds.includes(row.id))) addMovement(row.accountId,leg.currency,toUnits(allocated.get(row.id)!),toUnits(statutory ? row.statutoryAmount : row.transactionAmount));
  }
  for (const documentId of source.previousDocumentIds) {
    const previous = (await executor.execute<{ entryId: string; source: { enrollmentId?: string; carrying?: WithholdingCarryingSource } }>(sql`
      select posted_entry_id as "entryId",coalesce(custom->'withholdingRemittance',custom->'withholdingDeposit') as source from documents
       where org_id=${orgId} and id=${documentId} and subsidiary_id=${subsidiaryId} and status='posted' for share`)).rows[0];
    if (!previous || previous.source?.enrollmentId!==enrollmentId) return refuse("The earlier posted authority source no longer belongs to this withholding enrollment.");
    const accounts = previous.source.carrying?.liabilityAccountIds ?? (await executor.execute<{ accountId: string }>(sql`select distinct account_id as "accountId" from document_lines where org_id=${orgId} and document_id=${documentId}`)).rows.map(row=>row.accountId);
    if (!validIds(accounts) || accounts.some(account=>!source.liabilityAccountIds.includes(account))) return refuse("The previous authority's actual liability accounts no longer match the carrying source.");
    const legs = (await executor.execute<{ accountId: string; amount: string;currency:string;transactionAmount:string }>(sql`
      select l.account_id as "accountId",l.currency,l.amount::text as amount,l.txn_amount::text as "transactionAmount" from journal_lines l
       join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id
       where l.org_id=${orgId} and ${input.bookId ? sql`true` : sql`e.id=${previous.entryId}`} and e.source_document_id=${documentId} and e.book_id=${bookId} and e.status='posted'
         and l.subsidiary_id=${subsidiaryId} and l.account_id in (${idsSql(accounts)}) order by l.line_number,l.id`)).rows;
    if (!legs.length) return refuse("The previous authority's posted liability movement is missing.");
    for (const leg of legs) addMovement(leg.accountId,leg.currency,-toUnits(leg.amount),-toUnits(leg.transactionAmount));
  }
  const remaining:typeof movements=[];
  for(const row of movements) {
    const opposite=remaining.findIndex(other=>other.accountId===row.accountId && other.currency===row.currency && other.amount===-row.amount && other.transactionAmount===-row.transactionAmount);
    if(opposite<0) remaining.push(row);else remaining.splice(opposite,1);
  }
  return remaining.sort((a,b)=>`${a.accountId}:${a.currency}`.localeCompare(`${b.accountId}:${b.currency}`)).filter(row=>row.amount!==0n || row.transactionAmount!==0n).map(row=>{
    if(row.amount===0n || row.transactionAmount===0n || (row.amount<0n)!==(row.transactionAmount<0n)) return refuse("The source currency carrying movement cannot be represented by a positive native exchange rate.");
    return {accountId:row.accountId,amount:fromUnits(row.amount),currency:row.currency,txnAmount:fromUnits(row.transactionAmount),fxRate:divideDecimal(fromUnits(row.amount),fromUnits(row.transactionAmount),10)};
  });
}

export async function withholdingRealizedFxAccount(executor: SqlExecutor, orgId: string): Promise<string> {
  const accountId = (await executor.execute<{ id: string | null }>(sql`select settings->'controlAccounts'->>'fxRealizedGainLoss' as id from orgs where id=${orgId}`)).rows[0]?.id;
  if (!accountId || !isUuid(accountId)) throw new ContractorWithholdingError("The realized FX gain/loss account is not configured.", "Configure Realized FX gain/loss in Setup → Control Accounts, then post the authority document again.");
  const records = (await executor.execute<{ id: string; type: string; isActive: boolean; isSummary: boolean }>(sql`select id,type,is_active as "isActive",is_summary as "isSummary" from accounts where org_id=${orgId} and id=${accountId} for share`)).rows;
  try { assertValidControlAccountMappings({fxRealizedGainLoss:accountId},records); }
  catch { throw new ContractorWithholdingError("The realized FX gain/loss account must be active, postable and an income or expense account.", "Review Realized FX gain/loss in Setup → Control Accounts, then post the authority document again."); }
  return accountId;
}

export async function assertWithholdingCarryingRelease(executor:SqlExecutor,orgId:string,documentId:string):Promise<void> {
  const dependent=(await executor.execute<{number:string}>(sql`select document_number as number from documents where org_id=${orgId} and id<>${documentId} and status<>'voided' and (custom->'withholdingDeposit'->'carrying'->'previousDocumentIds' ? ${documentId} or custom->'withholdingRemittance'->'carrying'->'previousDocumentIds' ? ${documentId}) order by created_at desc limit 1`)).rows[0];
  if(dependent) throw new ContractorWithholdingError(`Authority document ${dependent.number} carries this document's posted liability movement.`,"Discard or void the later correction first, then void the earlier authority document.");
}

export async function insertWithholdingCarryingJournalLines(executor: SqlExecutor, orgId: string, documentId: string, carrying: CarryingAmount[], memo: string, actorId: string): Promise<void> {
  const rows: { accountId: string; amount: string }[] = carrying.filter(row=>toUnits(row.amount)!==0n);
  const net = toUnits(sum(rows.map(row=>row.amount)));
  if (net !== 0n) rows.push({ accountId: await withholdingRealizedFxAccount(executor,orgId), amount: fromUnits(-net) });
  if(rows.length<2) return refuse("The functional carrying correction produced no balanced journal.");
  for(const [index,row] of rows.entries()) {
    const write=await executor.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,description,quantity,unit_price,amount,withholding_treatment,created_by,updated_by) values(${orgId},${documentId},${index+1},${row.accountId},${memo},1,${row.amount},${row.amount},'excluded',${actorId},${actorId})`);
    if(write.rowCount!==1) throw new ContractorWithholdingError("The functional withholding correction line was not created.");
  }
}

interface FunctionalLine { accountId: string; amount: string; subsidiaryId: string; currency: string; txnAmount: string; fxRate: string; memo?: string | null; isOpenItem?: boolean }
/** Balanced carrying reclassification rides in the document's own journal and its native reversal. */
export async function applyWithholdingCarrying<T extends FunctionalLine>(executor: SqlExecutor, doc: {
  id: string; orgId: string; kind: string; custom: unknown; status?:string;
}, lines: T[], subsidiaryId: string, functionalCurrency: string, bookId: string | null): Promise<T[]> {
  const custom = doc.custom as { withholdingDeposit?: { enrollmentId: string; carrying?: WithholdingCarryingSource }; withholdingRemittance?: { enrollmentId: string; carrying?: WithholdingCarryingSource } } | null;
  const source = custom?.withholdingDeposit ?? custom?.withholdingRemittance;
  if (!source) return lines;
  if (!source.carrying) {
    if(doc.status==='posted') return lines;
    return refuse("The authority document has no governed functional carrying source evidence.");
  }
  const carrying = await resolveWithholdingCarrying(executor,{orgId:doc.orgId,subsidiaryId,enrollmentId:source.enrollmentId,source:source.carrying,documentId:doc.id,bookId});
  const native = lines.filter(line=>source.carrying!.liabilityAccountIds.includes(line.accountId));
  if (!native.length) return refuse("The authority document has no native withholding liability projection.");
  if (native.some(line=>!line || line.subsidiaryId!==subsidiaryId || line.isOpenItem)) return refuse("The native withholding liability projection is invalid.");
  const movementKey=(row:{accountId:string;currency:string;amount:string;txnAmount:string})=>`${row.accountId}:${row.currency}:${toUnits(row.amount)}:${toUnits(row.txnAmount)}`;
  const available=[...carrying];
  const unmatchedNative=native.filter(line=>{
    const index=available.findIndex(row=>movementKey(row)===movementKey(line));
    if(index<0) return true;
    available.splice(index,1);return false;
  });
  const adjustments=[...unmatchedNative.map(line=>({accountId:line.accountId,amount:fromUnits(-toUnits(line.amount)),currency:line.currency,txnAmount:fromUnits(-toUnits(line.txnAmount)),fxRate:line.fxRate})),...available];
  const difference = toUnits(sum(adjustments.map(row=>row.amount)));
  if (difference!==0n) {
    const account = await withholdingRealizedFxAccount(executor,doc.orgId);
    adjustments.push({accountId:account,amount:fromUnits(-difference),currency:functionalCurrency,txnAmount:fromUnits(-difference),fxRate:'1'});
  }
  // Functional-currency reclassification legs retain the bill/credit's statutory face amount on its native legs.
  return [...lines,...adjustments.filter(row=>toUnits(row.amount)!==0n).map(row=>({
    ...row,subsidiaryId,memo:'Withholding liability carrying value',
  } as T))];
}
