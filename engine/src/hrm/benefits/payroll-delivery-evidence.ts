import { sql } from "drizzle-orm";

/** A queued award is processed only when its exact native adjustment appears on a committed stub. */
export const awardPayrollProcessedSql = sql`exists (
  select 1 from pay_stubs s join pay_stub_lines l on l.org_id = s.org_id and l.stub_id = s.id
  join pay_runs r on r.org_id = s.org_id and r.document_id = s.pay_run_document_id
  join documents d on d.org_id = r.org_id and d.id = r.document_id
  join pay_run_adjustments adjustment on adjustment.org_id = a.org_id and adjustment.id = a.pay_run_adjustment_id
  where s.org_id = a.org_id and s.pay_run_document_id = a.pay_run_document_id
    and s.employment_id = a.employment_id and s.currency_code = a.currency
    and s.employee_party_id = adjustment.employee_party_id
    and adjustment.pay_run_document_id = a.pay_run_document_id
    and adjustment.component_id = p.pay_component_id and adjustment.amount = a.value
    and d.subsidiary_id = p.legal_entity_id and d.currency = a.currency
    and l.component_id = adjustment.component_id and l.amount = a.value and l.description = adjustment.note
    and l.kind = 'earning' and l.payment_kind = case when p.delivery_method = 'external' then 'non_cash' else 'cash' end
    and (l.payment_kind = 'cash' or l.non_cash_account_id is not null)
    and r.run_status = 'committed' and d.status <> 'voided'
)`;
