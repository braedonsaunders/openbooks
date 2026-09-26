/** Shared posting-row projection breaking the preview/run cycle. Split from revenue/recognition.ts (pure moves only). */
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { measureCreditExposure, type CreditExposure } from "./deferred-credit-pool.ts";
import { neg, sum } from "../money/money.ts";
import type { RecognitionMethod } from "./recognition-schedule.ts";
import type { RevenueChangeBasis } from "./recognition-schedule-build.ts";
import { RevenueRecognitionError } from "./recognition-transaction-price.ts";

/**
 * What remains genuinely unearned for one obligation on one book (F-w5-001).
 *
 *   remaining = allocated − recognized(net of reversals) − credited-to-deferred
 *
 * `credited-to-deferred` counts only posted, non-voided customer-credit lines
 * that debit the obligation's own deferred account, on a credit with a live
 * application to the source invoice. That conjunction is the whole rule:
 *
 * - deferred-account scoping is what separates unearned relief (retires the
 *   plan) from an income-account concession (reduces earned, plan untouched);
 * - the application is the only structural edge a credit memo has to an
 *   invoice, so an unapplied credit cannot be attributed to any obligation;
 * - voided credits are excluded by document status, and their reversal
 *   entries never match because only the document's own posted entry counts.
 *
 * Obligations with no source invoice (project percent-complete) correlate to
 * nothing and always report zero credits. Recognized amounts and amendment
 * allocations stay book-specific; the invoice's settled credits are shared.
 */
export async function recognitionUnearnedRemaining(
 tx:SqlExecutor,input:{orgId:string;obligationId:string;bookId:string;deferredAccountId:string},
):Promise<{remaining:string;credited:string;exposure:CreditExposure}> {
 const row=(await tx.execute<{allocated:string;recognized:string;change_basis:RevenueChangeBasis|null;invoice_id:string|null;currency:string|null;tx_fx_rate:string|null}>(sql`
 select coalesce(s.total_amount,o.allocated_price)::text as allocated,s.change_basis,inv.id as invoice_id,inv.currency,s.transaction_fx_rate::text as tx_fx_rate,
   coalesce((select sum(case when l.journal_entry_id is not null and l.reversal_journal_entry_id is null then coalesce(l.recognized_amount,0) else 0 end)
     from recognition_schedule_lines l where l.org_id=o.org_id and l.schedule_id=s.id),0)::text as recognized
 from performance_obligations o left join recognition_schedules s on s.obligation_id=o.id and s.org_id=o.org_id and s.book_id=${input.bookId}
 left join document_lines dl on dl.id=o.document_line_id and dl.org_id=o.org_id
 left join documents inv on inv.id=dl.document_id and inv.org_id=dl.org_id
 where o.org_id=${input.orgId} and o.id=${input.obligationId}`)).rows[0];
 if(!row)throw new RevenueRecognitionError('recognition obligation disappeared during posting');
 let exposure:CreditExposure=row.change_basis?.creditExposure??{kind:'none'};
 if(!row.change_basis?.creditExposure && row.invoice_id && row.currency) {
   const peers=(await tx.execute<{id:string;weight:string}>(sql`select o.id,coalesce(o.booked_amount,o.allocated_price)::text as weight
    from performance_obligations o join document_lines dl on dl.id=o.document_line_id and dl.org_id=o.org_id
    left join items i on i.id=o.item_id and i.org_id=o.org_id join recognition_rules r on r.id=o.recognition_rule_id and r.org_id=o.org_id
    where o.org_id=${input.orgId} and dl.document_id=${row.invoice_id} and coalesce(o.deferred_account_id,i.deferred_account_id,r.deferred_account_id)=${input.deferredAccountId} order by o.id`)).rows;
   const index=peers.findIndex(p=>p.id===input.obligationId);
   if(index<0)throw new RevenueRecognitionError('the invoice credit allocation omitted this promise');
   // The credit pool measures in transaction units, but the evidence names
   // the historical deferral rate (0256), not a defaulted 1.
   exposure={kind:'invoice',source:{invoiceId:row.invoice_id,deferredAccountId:input.deferredAccountId,baseline:'0',currency:row.currency,fxRate:row.tx_fx_rate ?? '1'},weights:peers.map(p=>p.weight),index};
 }
 const credited=await measureCreditExposure(tx,input.orgId,input.bookId,exposure);
 return {remaining:sum([row.allocated,neg(row.recognized),neg(credited)]),credited,exposure};
}
/**
 * Cumulative net earned for one obligation on one book: posted recognition
 * less historical reversals. Uses the same canonical predicate as the
 * unearned-remaining helper and the schedule rebuild — a line counts only
 * once its journal is posted, and a line carrying a reversal journal never
 * counts (the compensating reversal journal unwinds the ledger; counting the
 * original too would double-count earned). Unposted plan lines never count.
 */
export async function recognitionNetRecognized(
 tx:SqlExecutor,input:{orgId:string;obligationId:string;bookId:string},
):Promise<string> {
 const row=(await tx.execute<{net:string}>(sql`
  select coalesce((select sum(case when l.journal_entry_id is not null and l.reversal_journal_entry_id is null then coalesce(l.recognized_amount,0) else 0 end)
    from recognition_schedule_lines l
    join recognition_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
   where l.org_id=${input.orgId} and s.obligation_id=${input.obligationId} and s.book_id=${input.bookId}),0)::text as net`)).rows[0];
 return row?.net ?? "0";
}

export function recognitionObligationScope(orgId: string, allowedSubsidiaryIds: readonly string[] | undefined, fallbackSubsidiaryId: string) {
  if (allowedSubsidiaryIds === undefined) return sql`true`;
  // Unattributed obligations fall back to the shared unscoped-posting
  // default (the hierarchy root), resolved once by the caller — never the
  // oldest subsidiary.
  return sql`exists (
    select 1 from revenue_contracts scoped_contract
      left join document_lines scoped_line on scoped_line.id = o.document_line_id and scoped_line.org_id = o.org_id
      left join documents scoped_document on scoped_document.id = scoped_line.document_id and scoped_document.org_id = o.org_id
      left join projects scoped_project on scoped_project.id = scoped_contract.project_id and scoped_project.org_id = o.org_id
     where scoped_contract.id = o.contract_id and scoped_contract.org_id = o.org_id
       and coalesce(scoped_contract.subsidiary_id, scoped_line.subsidiary_id, scoped_document.subsidiary_id, scoped_project.subsidiary_id,
         ${fallbackSubsidiaryId})
         = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])
  )`;
}

export type RecognitionPostingRow = {
  recognition_on: string | null; recognition_currency: string | null; functional_currency:string|null; recognition_fx_rate: string;
  line_id: string; planned: string; period_id: string; sequence: number;
  book_id: string; period_name: string; period_ends_on: string;
  method: RecognitionMethod;
  obligation_id: string; obligation_desc: string; contract_number: string;
  obl_deferred: string | null; obl_recognized: string | null;
  item_deferred: string | null; item_income: string | null;
  rule_deferred: string | null; rule_recognized: string | null;
  subsidiary_id: string | null; base_currency: string | null;
  department_id: string | null; project_id: string | null;
  location_id: string | null; class_id: string | null;
  equipment_unit_id: string | null; extra_dims: Record<string, unknown>;
};

/** Discovery is advisory. The posting transaction reloads this same projection
 * after owning the obligation, while locking the line and its native policy.
 */
export async function recognitionPostingRows(
  runner: SqlExecutor,
  orgId: string,
  asOfDate: string,
  fallbackSubsidiaryId: string,
  obligationId?: string,
  allowedSubsidiaryIds?: string[],
  lineId?: string,
  claim = false,
): Promise<RecognitionPostingRow[]> {
  const obligationScope = recognitionObligationScope(orgId, allowedSubsidiaryIds, fallbackSubsidiaryId);
  return (await runner.execute<RecognitionPostingRow>(sql`
    select l.id             as line_id,
           l.recognition_on::text as recognition_on,
           coalesce(s.change_basis->>'currency',s.transaction_currency) as recognition_currency,
           s.change_basis->>'functionalCurrency' as functional_currency,
           coalesce(s.change_basis->>'fxRate',s.transaction_fx_rate::text,'1') as recognition_fx_rate,
           l.planned_amount as planned,
           l.period_id      as period_id,
           l.sequence       as sequence,
           s.book_id        as book_id,
           p.name           as period_name,
           p.ends_on        as period_ends_on,
           coalesce(s.change_basis->>'method',r.method) as method,
           o.id             as obligation_id,
           o.description    as obligation_desc,
           coalesce((s.change_basis->>'deferredAccountId')::uuid,o.deferred_account_id) as obl_deferred,
           coalesce((s.change_basis->>'recognizedAccountId')::uuid,o.recognized_account_id) as obl_recognized,
           it.deferred_account_id   as item_deferred,
           it.income_account_id     as item_income,
           r.deferred_account_id    as rule_deferred,
           r.recognized_account_id  as rule_recognized,
           c.contract_number as contract_number,
           coalesce(c.subsidiary_id, dl.subsidiary_id, doc.subsidiary_id, prj.subsidiary_id, fsub.id) as subsidiary_id,
           coalesce(sub.base_currency, psub.base_currency, fsub.base_currency) as base_currency,
           coalesce(dl.department_id, doc.department_id) as department_id,
           coalesce(dl.project_id, doc.project_id, c.project_id) as project_id,
           coalesce(dl.location_id, doc.location_id) as location_id,
           coalesce(dl.class_id, doc.class_id) as class_id,
           dl.equipment_unit_id as equipment_unit_id,
           coalesce(doc.extra_dims, '{}'::jsonb)
             || coalesce(dl.extra_dims, '{}'::jsonb) as extra_dims
      from recognition_schedule_lines l
      join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
      join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.posts_gl and bk.is_active
      join performance_obligations o on o.id = s.obligation_id and o.org_id = s.org_id
      join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
      join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
      left join document_lines dl on dl.id = o.document_line_id and dl.org_id = o.org_id
      left join documents doc on doc.id = dl.document_id and doc.org_id = dl.org_id
      left join projects prj on prj.id = c.project_id and prj.org_id = c.org_id
      left join items it on it.id = o.item_id and it.org_id = o.org_id
      left join subsidiaries sub on sub.id = coalesce(c.subsidiary_id, dl.subsidiary_id, doc.subsidiary_id) and sub.org_id = o.org_id
      left join subsidiaries psub on psub.id = prj.subsidiary_id and psub.org_id = prj.org_id
      left join lateral (
        select id, base_currency from subsidiaries where org_id = ${orgId} and id = ${fallbackSubsidiaryId}
      ) fsub on true
     where l.org_id = ${orgId}
       and l.journal_entry_id is null and l.superseded_by_change_id is null
       and o.status <> 'cancelled'
       and (s.change_basis is not null or not r.is_forecast)
       -- Scheduled methods recognize a period once it has ENDED; percent_complete
       -- is a measurement AS OF the date, so its catch-up in the current period
       -- is due as soon as the period has started.
       and (case when l.recognition_on is not null then l.recognition_on <= ${asOfDate}::date else (p.ends_on <= ${asOfDate}
            or (coalesce(s.change_basis->>'method',r.method) = 'percent_complete' and p.starts_on <= ${asOfDate})) end)
       ${obligationId ? sql`and o.id = ${obligationId}` : sql``}
       and ${obligationScope}
       ${lineId ? sql`and l.id = ${lineId}` : sql``}
     order by c.contract_number, o.description, l.sequence
     ${claim ? sql`for update of l for share of s, bk, c, r, p` : sql``}`)).rows;
}
/** Exactly the fields the confirm fingerprint covers per line. */
export interface FingerprintedRecognitionLine {
  lineId: string;
  /** What would post — the planned amount after the unearned cap. */
  amount: string;
  periodId: string;
  bookId: string;
  debitAccountId: string | null;
  creditAccountId: string | null;
  subsidiaryId: string | null;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
}
